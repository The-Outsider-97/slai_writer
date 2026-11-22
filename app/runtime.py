"""SLAI Writer's application object, settings, preferences and start-up. The shared mechanics (server, token handshake, config, database,
preferences file, SLAI lookup) come from ``applications.tools``; only what is specific to a writing application is here."""
from __future__ import annotations

import argparse
import logging
import secrets
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...tools import slai
from ...tools.config import Field, load_section
from ...tools.errors import AppError
from ...tools.server import Identity, LocalServer, Request, ServerOptions, add_server_arguments, refuse_remote_host, serve
from ...tools.storage import Prefs, default_data_dir
from ...tools.validation import utc_now
from .. import __version__, picker
from ..preferences import BUILTIN_CURSORS, CURSOR_KINDS, CURSOR_PATTERN, PREF_DEFAULTS, PREF_SCHEMA  # noqa: F401 - part of this module's public names
from .. import export as exporter
from ..academic import Academic
from ..accounts import AccountService
from ..assist import Assist
from ..cursors import Cursors
from ..docmaster import DocumasterLink
from ..embeds import Embeds
from ..export import Exchange
from ..library import Library
from ..mailer import make_mailer
from ..plans import NoBilling, Plans
from ..protect import MasterKey
from ..routes import router
from ..session import SessionManager
from ..signing import SigningService
from ..store import WriterStore
from ..workspace import WorkspaceService

SLUG, TITLE, DEFAULT_PORT = "writer", "Writer", 8770
LOG = logging.getLogger("slai.writer.housekeeping")
HERE = Path(__file__).resolve().parent.parent       # the Writer directory (this file is in its app/ package)
DEFAULT_CONFIG = HERE / "configs" / "config.yaml"
DEFAULT_PLANS = HERE / "configs" / "plans.yaml"

APP_FIELDS = {
    "port": Field(DEFAULT_PORT, 1, 65535),
    "max_request_bytes": Field(8 * 1024 * 1024, 16_384, 8 * 1024 * 1024),
    "max_upload_bytes": Field(32 * 1024 * 1024, 1024, 48 * 1024 * 1024),
    "backup_every_days": Field(7, 0, 365),
    "backup_keep": Field(8, 1, 100),
    "recovery_seconds": Field(3, 1, 600),
    "autosave_default_seconds": Field(60, 10, 3600),
    "library_root": Field("", kind=str),
}
ACCOUNT_FIELDS = {
    "session_hours": Field(12, 1, 24 * 14), "remember_days": Field(30, 1, 365), "device_trust_days": Field(30, 1, 365),
    "email_code_minutes": Field(5, 1, 60), "resend_seconds": Field(30, 1, 3600), "max_attempts": Field(5, 3, 20),
    "lockout_minutes": Field(15, 1, 24 * 60), "recovery_delay_hours": Field(24, 0, 24 * 14), "min_password_chars": Field(10, 8, 128),
}
MAIL_FIELDS = {"host": Field("", kind=str), "port": Field(587, 1, 65535), "username": Field("", kind=str), "sender": Field("", kind=str),
               "starttls": Field(True, kind=bool)}
SIGNATURE_FIELDS = {"max_distinct": Field(2, 1, 10), "max_samples": Field(20, 1, 200)}

@dataclass
class Settings:
    port: int
    max_request_bytes: int
    max_upload_bytes: int
    backup_every_days: int
    backup_keep: int
    recovery_seconds: int
    autosave_default_seconds: int
    library_root: str
    accounts: dict[str, Any]
    mail: dict[str, Any]
    signatures: dict[str, Any]
    data_dir: Path
    config_path: Path
    plans_path: Path
    note: str | None = None


def load_settings(config: str | None = None, data_dir: str | None = None, port: int | None = None, plans: str | None = None) -> Settings:
    path = Path(config) if config else DEFAULT_CONFIG
    app_values, note = load_section(path, "app", APP_FIELDS, label="Writer configuration", overrides={"port": port})
    accounts, _ = load_section(path, "accounts", ACCOUNT_FIELDS, label="Writer account settings")
    mail, _ = load_section(path, "mail", MAIL_FIELDS, label="Writer mail settings")
    signatures, _ = load_section(path, "signatures", SIGNATURE_FIELDS, label="Writer signature settings")
    return Settings(accounts=accounts, mail=mail, signatures=signatures, data_dir=Path(data_dir) if data_dir else default_data_dir(SLUG, TITLE),
                    config_path=path, plans_path=Path(plans) if plans else DEFAULT_PLANS, note=note, **app_values)


def default_library_root(settings: Settings) -> Path:
    if settings.library_root:
        return Path(settings.library_root).expanduser()
    docs = Path.home() / "Documents"
    return (docs if docs.exists() else Path.home()) / "SLAI Writer"


class Health:
    """What the background housekeeping (recovery files, autosave, account clean-up) has done, so that a persistent fault is visible
    in the log, in ``capabilities()`` and as a notice, and is never swallowed. The loop stays alive whatever a task raises."""

    DEGRADED_AFTER = 3          # consecutive failures of one task (per document) before it is reported as degraded
    MAX_ENTRIES = 64

    def __init__(self, clock=time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str], dict[str, Any]] = {}

    def ok(self, task: str, subject: str = "") -> None:
        with self._lock:
            entry = self._entries.get((task, subject))
            if entry is not None:
                entry["consecutive"] = 0
                entry["last_ok"] = self._clock()
                if subject:                       # a per-document entry is only kept while it is failing
                    del self._entries[(task, subject)]

    def failed(self, task: str, exc: BaseException, subject: str = "") -> int:
        """Record a failure (and log it with its traceback the first time and whenever the count reaches a multiple of 10); return the
        number of consecutive failures of this task."""
        with self._lock:
            entry = self._entries.setdefault((task, subject), {"task": task, "subject": subject, "failures": 0, "consecutive": 0, "last_ok": None})
            entry["failures"] += 1
            entry["consecutive"] += 1
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
            entry["last_error_at"] = self._clock()
            count = entry["consecutive"]
            if len(self._entries) > self.MAX_ENTRIES:
                for key in [k for k, v in self._entries.items() if k[1] and v["consecutive"] < self.DEGRADED_AFTER][: len(self._entries) - self.MAX_ENTRIES]:
                    del self._entries[key]
        if count == 1 or count % 10 == 0:
            LOG.warning("Writer housekeeping task %r%s failed (%d in a row): %s", task, f" for {subject}" if subject else "", count, exc, exc_info=exc)
        return count

    def consecutive(self, task: str, subject: str = "") -> int:
        with self._lock:
            entry = self._entries.get((task, subject))
            return entry["consecutive"] if entry else 0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            failing = [dict(e) for e in self._entries.values() if e["consecutive"]]
        degraded = [e for e in failing if e["consecutive"] >= self.DEGRADED_AFTER]
        return {"status": "degraded" if degraded else ("warning" if failing else "ok"), "failing": failing}

    def degraded(self) -> list[dict[str, Any]]:
        return [e for e in self.snapshot()["failing"] if e["consecutive"] >= self.DEGRADED_AFTER]


class WriterApp:
    """Everything a request handler needs, passed explicitly instead of through module globals."""

    def __init__(self, settings: Settings, store: WriterStore, prefs: Prefs, root: Path | None, *, mailer: Any = None,
                 plans: Plans | None = None) -> None:
        self.settings = settings
        self.store = store
        self.prefs = prefs
        self.root = root
        self.started = time.time()
        self.sessions = SessionManager(store)
        self.key = MasterKey(settings.data_dir / "master.key")
        self.plans = plans or Plans(settings.plans_path)
        self.billing = NoBilling()
        self.mailer = mailer or make_mailer(settings.mail)
        self.accounts = AccountService(store.db, self.key, self.mailer, settings.accounts)
        self.docmaster = DocumasterLink(root, settings.data_dir).load()
        self.assist = Assist(self)
        self.signing = SigningService(self)
        self.workspace = WorkspaceService(settings.data_dir)
        self.exchange = Exchange(self)
        self.embeds = Embeds(self)
        self.academic = Academic(self)
        self.cursors = Cursors(settings.data_dir / "cursors")
        self.library_view = Library(self)
        self.library = default_library_root(settings)
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.health = Health()

    # -------------------------------------------------------------------------------------------------------- state
    def preferences(self) -> dict[str, Any]:
        return {**PREF_DEFAULTS, **self.prefs.snapshot()}

    # ---- the person's own words, kept across documents (a document's own dictionary lives in the document)
    def user_dictionary(self) -> list[str]:
        path = self.settings.data_dir / "user_dictionary.txt"
        try:
            stamp = path.stat().st_mtime_ns
        except OSError:
            return []
        cached = getattr(self, "_user_words", None)
        if cached is None or cached[0] != stamp:
            try:
                words = [w for w in (line.strip() for line in path.read_text(encoding="utf-8").splitlines()) if w and not w.startswith("#")][:5000]
            except OSError:
                words = []
            self._user_words = cached = (stamp, words)
        return list(cached[1])

    def add_user_word(self, word: str) -> list[str]:
        words = sorted({*self.user_dictionary(), word})[:5000]
        path = self.settings.data_dir / "user_dictionary.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(words) + "\n", encoding="utf-8")
        tmp.replace(path)
        self._user_words = None
        return words

    def profile_of(self, req: Request) -> tuple[str, dict[str, Any] | None]:
        """``(profile id, account)``: the signed-in account, or the guest profile."""
        account = self.accounts.account_for(req.headers.get("cookie", ""))
        return (account["id"], account) if account else ("guest", None)

    def plan_of(self, account: dict[str, Any] | None) -> str:
        if not account:
            return "guest"
        return self.accounts.effective_plan(account)

    def notices(self) -> list[dict[str, str]]:
        found: list[dict[str, str]] = []
        if self.settings.note:
            found.append({"kind": "info", "text": self.settings.note})
        if self.prefs.recovered:
            found.append({"kind": "warn", "text": self.prefs.recovered})
        if self.plans.note:
            found.append({"kind": "info", "text": self.plans.note})
        if not slai.sldc_info()["available"]:
            found.append({"kind": "error", "text": "SLAI's SLDC module was not found, so documents can't be opened or saved. Start SLAI Writer inside "
                                                    "the SLAI folder or pass --slai-root."})
        if not self.docmaster.available:
            found.append({"kind": "warn", "text": f"Documaster is unavailable ({self.docmaster.reason}); importing and exporting Word, OpenDocument, "
                                                    "PDF, HTML and Markdown files is off. SLDC documents are unaffected."})
        if self.store.db.upgraded:
            backup = self.store.db.migration_backup
            found.append({"kind": "info", "text": "Your SLAI Writer data was upgraded to the new format." +
                          (f" A copy from before the upgrade is in {backup.parent}." if backup else "")})
        for entry in self.health.degraded():
            what = {"autosave": "Autosave", "recovery": "Crash-recovery copies", "tick": "Background maintenance", "cleanup": "Account clean-up"}.get(entry["task"], entry["task"])
            found.append({"kind": "error" if entry["task"] in ("autosave", "recovery") else "warn",
                          "text": f"{what} keeps failing ({entry['error']}). Your document may not be backed up automatically: save it yourself and check the disk and folder permissions."})
        return found

    def capabilities(self) -> dict[str, Any]:
        return {
            "sldc": bool(slai.sldc_info()["available"]),
            "documaster": self.docmaster.status(),
            "email": self.mailer.status(),
            "billing": self.billing.status(),
            "ai": self.assist.status(),
            "workspace": self.workspace.status(),
            "qr": self.accounts.qr_available(),
            "nativePicker": picker.available(),
            "exportFormats": exporter.available_formats(self.docmaster),
            "crypto": self.signing.available(),
            "housekeeping": self.health.snapshot(),
        }

    def bootstrap(self, req: Request) -> dict[str, Any]:
        profile, account = self.profile_of(req)
        plan = self.plan_of(account)
        return {
            "app": {"name": TITLE, "version": __version__, "slai": slai.status(self.root)},
            "prefs": self.preferences(), "notices": self.notices(), "capabilities": self.capabilities(),
            "account": self.accounts.public(account) if account else None, "profile": profile, "plan": plan,
            "plans": self.plans.catalogue(plan), "storage": {"dataDir": str(self.settings.data_dir), "library": str(self.library)},
            "open": self.sessions.listing(), "now": utc_now(),
        }

    # ------------------------------------------------------------------------------------------------- housekeeping
    def start_housekeeping(self) -> None:
        if self.thread is not None:
            return
        self.thread = threading.Thread(target=self._loop, name="writer-housekeeping", daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        last_clean = 0.0
        delay = 1.0
        while not self.stop.wait(delay):
            delay = 1.0
            try:
                self.tick()
                self.health.ok("tick")
            except Exception as exc:  # noqa: BLE001 - housekeeping must not take the application down; it is recorded, logged and retried with a back-off
                delay = min(60.0, 2.0 ** min(self.health.failed("tick", exc), 6))
            if time.time() - last_clean > 300:
                last_clean = time.time()
                try:
                    self.accounts.cleanup()
                    self.health.ok("cleanup")
                except Exception as exc:  # noqa: BLE001
                    self.health.failed("cleanup", exc)

    def tick(self, now: float | None = None) -> None:
        now = now or time.time()
        prefs = self.preferences()
        for session in self.sessions.all():
            if not session.dirty or session.last_edit is None:
                continue
            idle = now - session.last_edit
            subject = str(getattr(session, "doc_id", "") or id(session))
            if idle >= self.settings.recovery_seconds and session.recovery_dirty:
                try:
                    session.write_recovery()
                    self.health.ok("recovery", subject)
                except Exception as exc:  # noqa: BLE001 - one document's fault must not stop the others
                    self.health.failed("recovery", exc, subject)
            on = prefs["autosave"] if session.autosave is None else session.autosave
            interval = prefs["autosave_seconds"]
            if on and session.path is not None and not session.readonly_reason and idle >= min(interval, 600):
                if session.saved_at is None or now - session.saved_at >= interval:
                    if now < getattr(session, "_autosave_retry_at", 0.0):
                        continue
                    try:
                        session.save()
                        self.health.ok("autosave", subject)
                    except AppError as exc:
                        if exc.code == "conflict":
                            note = "Autosave paused: the file was changed by another program. Choose how to combine the two versions."
                            if note not in session.notices:
                                session.notices.append(note)
                            session.autosave = False
                        else:
                            self._autosave_failed(session, exc, subject, now)
                    except Exception as exc:  # noqa: BLE001
                        self._autosave_failed(session, exc, subject, now)

    def _autosave_failed(self, session: Any, exc: BaseException, subject: str, now: float) -> None:
        """Retry an autosave that failed with a growing delay; after a few failures in a row stop trying and tell the person."""
        count = self.health.failed("autosave", exc, subject)
        session._autosave_retry_at = now + min(300.0, 5.0 * 2 ** (count - 1))
        if count >= Health.DEGRADED_AFTER:
            note = f"Autosave paused after {count} failed attempts ({type(exc).__name__}: {exc}). Save the document yourself and check the folder."
            if not any(n.startswith("Autosave paused after") for n in session.notices):
                session.notices.append(note)
            session.autosave = False

    def close(self) -> None:
        self.stop.set()
        for session in self.sessions.all():
            try:
                if session.dirty:
                    session.write_recovery()
            except Exception as exc:  # noqa: BLE001 - closing must finish, but a lost recovery copy is reported
                self.health.failed("recovery", exc, str(getattr(session, "doc_id", "") or id(session)))
        self.assist.close()
        self.docmaster.close()
        self.store.close()


def automatic_backup(store: WriterStore, settings: Settings) -> Path | None:
    if settings.backup_every_days <= 0:
        return None
    folder = store.backups_dir
    existing = sorted(folder.glob("auto-*.sqlite3"), key=lambda p: p.stat().st_mtime) if folder.is_dir() else []
    made: Path | None = None
    if sum(store.counts().values()) and (not existing or time.time() - existing[-1].stat().st_mtime >= settings.backup_every_days * 86400):
        made = store.backup("auto")
        existing.append(made)
    for old in existing[: max(0, len(existing) - settings.backup_keep)]:
        try:
            old.unlink()
        except OSError as exc:
            LOG.warning("Could not remove the old backup %s: %s", old, exc)
    return made


def build_server(settings: Settings, token: str, *, root: Path | None, client_dir: Path | None = None, host: str = "127.0.0.1",
                 mailer: Any = None, plans: Plans | None = None) -> tuple[LocalServer, WriterApp]:
    store = WriterStore(settings.data_dir)
    try:
        prefs = Prefs(settings.data_dir / "prefs.json", PREF_SCHEMA)
        app = WriterApp(settings, store, prefs, root, mailer=mailer, plans=plans)
        options = ServerOptions(token=token, client_dir=client_dir or HERE / "dist", host=host, port=settings.port,
                                tools_web_dir=slai.applications_dir() / "tools" / "web",
                                asset_dirs=(HERE / "assets", slai.shared_assets_dir()), max_body_bytes=settings.max_request_bytes)
        return LocalServer(app, Identity(SLUG, TITLE), router, options), app
    except BaseException:
        store.close()
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m applications.slai_writer", description=f"{TITLE}: a local document-authoring application.")
    add_server_arguments(parser, title=TITLE, default_port=DEFAULT_PORT)
    parser.add_argument("--plans", help="path to a plans.yaml (default: configs/plans.yaml)")
    args = parser.parse_args(argv)
    if refuse_remote_host(args.host, TITLE, "your documents"):
        return 2
    root = slai.activate(slai.find_slai_root(args.slai_root))
    try:
        settings = load_settings(args.config, args.data_dir, args.port, args.plans)
        client_dir = Path(args.client_dir) if args.client_dir else HERE / "dist"
        if not (client_dir / "index.html").is_file():
            print(f"The web client is not built ({client_dir / 'index.html'} is missing). Run `npm install` and `npm run build` in {HERE}.",
                  file=sys.stderr)
            return 2
        token = args.token or secrets.token_urlsafe(32)
        server, app = build_server(settings, token, root=root, client_dir=client_dir, host=args.host)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    except AppError as exc:
        print(f"{exc.message} {exc.hint or ''}".strip(), file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"{TITLE} could not start: {exc.strerror or exc}. Is another copy already running? Try --port.", file=sys.stderr)
        return 1
    try:
        made = automatic_backup(app.store, settings)
    except (AppError, OSError) as exc:
        print(f"notice: the automatic backup was skipped ({getattr(exc, 'message', exc)})", file=sys.stderr)
        made = None
    app.start_housekeeping()
    notes = [n["text"] for n in app.notices()] + ([f"Database backed up to {made}"] if made else [])
    details = [("Data", str(settings.data_dir)), ("Library", str(app.library)), ("SLAI", str(root) if root else "not found"),
               ("Config", str(settings.config_path))]
    return serve(server, title=TITLE, version=__version__, url=f"http://127.0.0.1:{server.port}/?token={token}", details=details,
                 notes=notes, open_browser=not args.no_browser, on_close=app.close)
