"""SLAI Writer's application object, settings, preferences and start-up. The shared mechanics (server, token handshake, config, database,
preferences file, SLAI lookup) come from ``applications.tools``; only what is specific to a writing application is here."""
from __future__ import annotations

import argparse
import os
import secrets
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..tools import slai
from ..tools.config import Field, load_section
from ..tools.errors import AppError
from ..tools.server import Identity, LocalServer, Request, ServerOptions, add_server_arguments, refuse_remote_host, serve
from ..tools.storage import Pref, Prefs, default_data_dir
from ..tools.validation import utc_now
from . import __version__, picker
from .docmaster import DocumasterLink
from .plans import NoBilling, Plans
from .protect import MasterKey
from .session import SessionManager
from .store import WriterStore

SLUG, TITLE, DEFAULT_PORT = "writer", "Writer", 8770
HERE = Path(__file__).resolve().parent
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

CURSOR_KINDS = ("default", "drag", "draw", "text")
BUILTIN_CURSORS = ("auto", "default", "pointer", "crosshair", "grab", "move", "text", "cell", "copy", "alias")
CURSOR_PATTERN = r"(?:auto|default|pointer|crosshair|grab|move|text|cell|copy|alias|custom:[A-Za-z0-9_-]{6,64})"

PREF_SCHEMA = {
    "theme": Pref(str, allowed=("system", "light", "dark", "contrast")),
    "scale": Pref(float, low=0.85, high=1.4),
    "motion": Pref(str, allowed=("system", "reduce")),
    "autosave": Pref(bool),
    "autosave_seconds": Pref(int, low=10, high=3600),
    "language": Pref(str, max_len=12, pattern=r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?"),
    "page_size": Pref(str, allowed=("A4", "A5", "A3", "B5", "Letter", "Legal")),
    "orientation": Pref(str, allowed=("portrait", "landscape")),
    "units": Pref(str, allowed=("mm", "in")),
    "zoom": Pref(int, low=10, high=400),
    "zoom_mode": Pref(str, allowed=("custom", "height", "width")),
    "show_rulers": Pref(bool),
    "show_guides": Pref(bool),
    "spell": Pref(bool),
    "grammar": Pref(bool),
    "ai_enabled": Pref(bool),
    "ai_cloud": Pref(bool),
    "ai_notes": Pref(bool),
    "ai_budget": Pref(int, low=0, high=100_000),
    "side_panel": Pref(bool),
    "cursor_default": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_drag": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_draw": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "cursor_text": Pref(str, max_len=80, pattern=CURSOR_PATTERN),
    "last_folder": Pref(str, max_len=1024, pattern=r"[^\x00-\x1f]*"),
    "wizard_done": Pref(bool),
    "lookup_online": Pref(bool),
}
PREF_DEFAULTS: dict[str, Any] = {
    "theme": "system", "scale": 1.0, "motion": "system", "autosave": True, "autosave_seconds": 60, "language": "en", "page_size": "A4",
    "orientation": "portrait", "units": "mm", "zoom": 100, "zoom_mode": "height", "show_rulers": True, "show_guides": True, "spell": True,
    "grammar": True, "ai_enabled": False, "ai_cloud": False, "ai_notes": False, "ai_budget": 0, "side_panel": False,
    "cursor_default": "default", "cursor_drag": "grab", "cursor_draw": "crosshair", "cursor_text": "text", "last_folder": "", "wizard_done": False, "lookup_online": False,
}


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


class WriterApp:
    """Everything a request handler needs, passed explicitly instead of through module globals."""

    def __init__(self, settings: Settings, store: WriterStore, prefs: Prefs, root: Path | None, *, mailer: Any = None,
                 plans: Plans | None = None) -> None:
        from .accounts import AccountService
        from .assist import Assist
        from .mailer import make_mailer
        from .academic import Academic
        from .cursors import Cursors
        from .embeds import Embeds
        from .export import Exchange
        from .library import Library
        from .signing import SigningService
        from .workspace import WorkspaceService

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

    # -------------------------------------------------------------------------------------------------------- state
    def preferences(self) -> dict[str, Any]:
        return {**PREF_DEFAULTS, **self.prefs.snapshot()}

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
        return found

    def capabilities(self) -> dict[str, Any]:
        from . import export as exporter

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
        while not self.stop.wait(1.0):
            try:
                self.tick()
                if time.time() - last_clean > 300:
                    last_clean = time.time()
                    self.accounts.cleanup()
            except Exception:  # noqa: BLE001 - housekeeping must never take the application down
                pass

    def tick(self, now: float | None = None) -> None:
        now = now or time.time()
        prefs = self.preferences()
        for session in self.sessions.all():
            if not session.dirty or session.last_edit is None:
                continue
            idle = now - session.last_edit
            if idle >= self.settings.recovery_seconds and session.recovery_dirty:
                session.write_recovery()
            on = prefs["autosave"] if session.autosave is None else session.autosave
            interval = prefs["autosave_seconds"]
            if on and session.path is not None and not session.readonly_reason and idle >= min(interval, 600):
                if session.saved_at is None or now - session.saved_at >= interval:
                    try:
                        session.save()
                    except AppError as exc:
                        if exc.code == "conflict":
                            note = "Autosave paused: the file was changed by another program. Choose how to combine the two versions."
                            if note not in session.notices:
                                session.notices.append(note)
                            session.autosave = False
                    except Exception:  # noqa: BLE001
                        pass

    def close(self) -> None:
        self.stop.set()
        for session in self.sessions.all():
            try:
                if session.dirty:
                    session.write_recovery()
            except Exception:  # noqa: BLE001
                pass
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
        except OSError:
            pass
    return made


def build_server(settings: Settings, token: str, *, root: Path | None, client_dir: Path | None = None, host: str = "127.0.0.1",
                 mailer: Any = None, plans: Plans | None = None) -> tuple[LocalServer, WriterApp]:
    from .routes import router

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
