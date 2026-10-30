"""The document library behind Home: recent documents, folders, favourites, recovery copies, missing files, legacy ``.sdoc`` files and
a small server-side folder browser (used when the operating system's file dialog is not available).

Nothing here parses or writes SLDC itself - that is :mod:`src.utils.sldc`, reached through :mod:`.session`.
"""
from __future__ import annotations

import os
import string
import time
from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, Conflict, DependencyMissing, NotFound
from . import session as S
from .store import safe_file_stem

SLDC_SUFFIX = ".sldc"
LEGACY_SUFFIX = ".sdoc"
MAX_LISTED = 500


def stat_or_none(path: Path) -> os.stat_result | None:
    try:
        return path.stat()
    except OSError:
        return None


class Library:
    def __init__(self, app: Any) -> None:
        self.app = app
        self.store = app.store

    # ------------------------------------------------------------------------------------------------- home
    def home(self, profile: str, query: str = "") -> dict[str, Any]:
        """Everything the Home table shows: documents with a plain status, the folders, and recovery copies."""
        open_paths = {str(s.path): s for s in self.app.sessions.all() if s.path is not None}
        rows: list[dict[str, Any]] = []
        for row in self.store.recents(profile, 200, query):
            info = stat_or_none(Path(row["path"]))
            folder = self.store.folder_for(Path(row["path"]))
            if info is None:
                state = "missing"
            elif row["path"] in open_paths and open_paths[row["path"]].dirty:
                state = "unsaved"
            else:
                state = row["state"] if row["state"] in ("saved", "missing", "recovered") else "saved"
            rows.append({"path": row["path"], "name": Path(row["path"]).stem, "title": row["title"], "opened": row["opened_at"],
                         "size": info.st_size if info else row["size"], "revision": row["revision"], "favorite": bool(row["favorite"]),
                         "state": state, "folder": folder["name"] if folder else None, "location": str(Path(row["path"]).parent),
                         "open": row["path"] in open_paths, "sid": open_paths[row["path"]].sid if row["path"] in open_paths else None,
                         "legacy": row["path"].lower().endswith(LEGACY_SUFFIX)})
        return {"documents": rows, "folders": self.store.folders(), "recovery": self.recoveries(profile), "library": str(self.app.library)}

    # ---------------------------------------------------------------------------------------------- recovery
    def recoveries(self, profile: str | None = None) -> list[dict[str, Any]]:
        """Crash-recovery copies left by a session that ended with unsaved work, newest first."""
        folder = self.store.recovery_dir
        found: list[dict[str, Any]] = []
        if not folder.is_dir():
            return found
        open_ids = {s.doc_id for s in self.app.sessions.all()}
        for meta in folder.glob("*.txt"):
            data = meta.with_suffix(".sldc")
            if not data.is_file():
                continue
            lines = meta.read_text(encoding="utf-8", errors="replace").splitlines()
            while len(lines) < 3:
                lines.append("")
            try:
                stamp = float(lines[1])
            except ValueError:
                stamp = data.stat().st_mtime
            doc_id = meta.stem
            if any(safe_file_stem(i) == doc_id for i in open_ids):
                continue
            found.append({"id": doc_id, "path": lines[0] or None, "name": Path(lines[0]).stem if lines[0] else "Unsaved document",
                          "saved": stamp, "encrypted": lines[2] == "encrypted", "bytes": data.stat().st_size})
        return sorted(found, key=lambda r: -r["saved"])

    def _recovery_files(self, rid: str) -> tuple[Path, Path]:
        stem = safe_file_stem(rid)
        data = self.store.recovery_dir / f"{stem}.sldc"
        if stem != rid or not data.is_file():
            raise NotFound("That recovery copy no longer exists.")
        return data, data.with_suffix(".txt")

    def open_recovery(self, rid: str, profile: str, password: str | None) -> S.DocumentSession:
        data, meta = self._recovery_files(rid)
        package = S.load_bytes(data.read_bytes(), password)
        lines = meta.read_text(encoding="utf-8", errors="replace").splitlines() if meta.is_file() else []
        original = Path(lines[0]) if lines and lines[0] else None
        session = S.DocumentSession(self.store, package, path=None, profile=profile, password=password,
                                    notices=["Recovered from a copy made automatically before the last session ended. Save it to keep it."],
                                    origin={"kind": "recovery", "path": str(original) if original else None})
        session.dirty = True
        session.recovery_dirty = True
        if original and not session.pkg.document.get("title"):
            session.pkg.document["title"] = original.stem
        return self.app.sessions.add(session)

    def discard_recovery(self, rid: str) -> None:
        data, meta = self._recovery_files(rid)
        for p in (data, meta):
            try:
                p.unlink()
            except OSError:
                pass

    # ------------------------------------------------------------------------------------------------ opening
    def open_path(self, path: Path, profile: str, password: str | None) -> tuple[S.DocumentSession, bool]:
        """``(session, already_open)``. A path that is open already returns the same session rather than a second copy of it."""
        path = path.expanduser()
        existing = self.app.sessions.find_by_path(path)
        if existing is not None:
            return existing, True
        suffix = path.suffix.lower()
        if suffix == LEGACY_SUFFIX:
            return self.open_legacy(path, profile, password), False
        if suffix != SLDC_SUFFIX:
            raise BadRequest("Writer opens .sldc documents here. Use Import for Word, PDF, Markdown and other formats.",
                             details={"importable": True})
        session = S.open_file(self.store, path, profile=profile, password=password)
        self.store.claim(session.doc_id, profile)
        return self.app.sessions.add(session), False

    def open_legacy(self, path: Path, profile: str, password: str | None) -> S.DocumentSession:
        """A ``.sdoc`` file (named in an early README). The canonical format is ``.sldc``: a file is opened only when its content is
        really SLDC, the original is never renamed or rewritten, and the first save asks for a ``.sldc`` name."""
        if not path.is_file():
            raise NotFound("That file does not exist any more.")
        try:
            package = S.load_bytes(path.read_bytes(), password)
        except BadRequest as exc:
            raise BadRequest("This .sdoc file is not an SLDC document, so Writer cannot read it as one.",
                             details={"legacy": True, "importable": True},
                             hint="You can import it as plain text instead; your file is not changed.") from exc
        session = S.DocumentSession(self.store, package, path=None, profile=profile, password=password,
                                    notices=[f"{path.name} is an SLDC document with an older file name (.sdoc). SLDC documents use the .sldc "
                                             "extension. Your original file is untouched; use Save as to keep a .sldc copy."],
                                    origin={"kind": "legacy", "path": str(path)})
        self.store.claim(session.doc_id, profile)
        return self.app.sessions.add(session)

    def locate(self, old: str, new: Path, profile: str) -> dict[str, Any]:
        """Point a missing library entry at the file's new location (the file's identity must match)."""
        row = self.store.recent(old)
        if row is None:
            raise NotFound("That document is not in your library.")
        if not new.is_file():
            raise NotFound("That file does not exist.")
        info = S.inspect(new)
        if row["doc_id"] and info.get("document_id") not in (None, row["doc_id"]):
            raise Conflict("That file is a different document.", hint="Choose the file with the same document, or open it as a new document.")
        self.store.retarget_recent(old, new)
        return {"path": str(new)}

    # ------------------------------------------------------------------------------------------------ folders
    def scan(self, folder_id: str) -> list[dict[str, Any]]:
        """.sldc documents in a library folder (two levels deep), read from their manifests only: nothing is decrypted or executed."""
        folder = next((f for f in self.store.folders() if f["id"] == folder_id), None)
        if folder is None:
            raise NotFound("That folder is not in your library.")
        root = Path(folder["path"])
        if not root.is_dir():
            raise NotFound("That folder is not available right now.", hint="It may be on a drive that is not connected.")
        out: list[dict[str, Any]] = []
        for path in self._walk(root, 2):
            info = stat_or_none(path)
            if info is None:
                continue
            entry: dict[str, Any] = {"path": str(path), "name": path.stem, "size": info.st_size, "modified": info.st_mtime,
                                     "location": str(path.parent), "legacy": path.suffix.lower() == LEGACY_SUFFIX}
            try:
                meta = S.inspect(path)
                entry.update({"title": path.stem, "encrypted": meta.get("container") == "encrypted", "damaged": False,
                              "supported": bool(meta.get("supported", True))})
            except Exception:  # noqa: BLE001 - one unreadable file must not hide the rest of the folder
                entry.update({"title": path.stem, "damaged": True})
            out.append(entry)
            if len(out) >= MAX_LISTED:
                break
        return sorted(out, key=lambda r: -r["modified"])

    def _walk(self, root: Path, depth: int):
        try:
            names = sorted(os.scandir(root), key=lambda e: e.name.lower())
        except OSError:
            return
        for entry in names:
            try:
                if entry.is_file(follow_symlinks=False) and entry.name.lower().endswith((SLDC_SUFFIX, LEGACY_SUFFIX)):
                    yield Path(entry.path)
                elif depth > 1 and entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                    yield from self._walk(Path(entry.path), depth - 1)
            except OSError:
                continue

    # ------------------------------------------------------------------------------------------- folder browser
    def browse(self, where: str | None, *, files: bool) -> dict[str, Any]:
        """A directory listing for the in-page chooser. Names only: no file is opened. Hidden entries are not listed."""
        if not where:
            start = self.app.library if self.app.library.is_dir() else Path.home()
            path = start
        else:
            path = Path(where).expanduser()
        try:
            path = path.resolve()
            entries = sorted(os.scandir(path), key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
        except OSError as exc:
            raise NotFound(f"That folder cannot be opened: {exc.strerror or exc}") from exc
        listing: list[dict[str, Any]] = []
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
                if not is_dir and not files:
                    continue
                size = None if is_dir else entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
            listing.append({"name": entry.name, "dir": is_dir, "size": size, "path": str(path / entry.name)})
            if len(listing) >= 1000:
                break
        roots = self._roots()
        return {"path": str(path), "parent": str(path.parent) if path.parent != path else None, "entries": listing, "roots": roots}

    def _roots(self) -> list[dict[str, str]]:
        roots = [{"name": "Home", "path": str(Path.home())}]
        if self.app.library.is_dir():
            roots.insert(0, {"name": "Writer library", "path": str(self.app.library)})
        if os.name == "nt":
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if os.path.exists(drive):
                    roots.append({"name": drive, "path": drive})
        else:
            roots.append({"name": "Computer", "path": "/"})
        return roots

    def ensure_library(self) -> Path:
        try:
            self.app.library.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise DependencyMissing(f"The library folder {self.app.library} cannot be created: {exc.strerror or exc}",
                                    hint="Choose another folder in the New document dialog.") from exc
        return self.app.library

    @staticmethod
    def unique(path: Path) -> Path:
        if not path.exists():
            return path
        for n in range(2, 1000):
            candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
            if not candidate.exists():
                return candidate
        raise Conflict("Too many documents with that name already exist there.")

    def age_hint(self, stamp: float) -> str:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(stamp))
