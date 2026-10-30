"""Writer's database: library (recent files, folders, favourites), version snapshots, private notes, signature graphics, signing keys,
trusted keys and the local account tables. One SQLite file next to the preferences; migrations and backups come from the shared
``applications.tools.database`` wrapper."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Iterable

from ..tools.database import Database, Migration
from ..tools.errors import BadRequest, Conflict, NotFound
from ..tools.storage import atomic_write
from ..tools.validation import new_id, utc_now

SCHEMA_V1 = (
    """CREATE TABLE recents (
        path TEXT PRIMARY KEY, doc_id TEXT, title TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, opened_at TEXT NOT NULL,
        size INTEGER, revision TEXT, state TEXT NOT NULL DEFAULT 'saved', profile TEXT NOT NULL DEFAULT 'guest')""",
    "CREATE INDEX recents_opened ON recents(opened_at DESC)",
    """CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created TEXT NOT NULL)""",
    "CREATE TABLE doc_owner (doc_id TEXT PRIMARY KEY, profile TEXT NOT NULL, created TEXT NOT NULL)",
    """CREATE TABLE snapshots (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        revision_id TEXT, revision_no INTEGER, file TEXT NOT NULL, bytes INTEGER NOT NULL, words INTEGER NOT NULL DEFAULT 0,
        signed INTEGER NOT NULL DEFAULT 0, encrypted INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL)""",
    "CREATE INDEX snapshots_doc ON snapshots(doc_id, created DESC)",
    """CREATE TABLE notes (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, block_id TEXT, start INTEGER, end INTEGER, anchor_text TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)""",
    "CREATE INDEX notes_doc ON notes(doc_id)",
    """CREATE TABLE sig_marks (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, label TEXT NOT NULL, grp INTEGER NOT NULL, kind TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, created TEXT NOT NULL, blob BLOB NOT NULL, sha256 TEXT NOT NULL)""",
    """CREATE TABLE sign_keys (
        profile TEXT PRIMARY KEY, key_id TEXT NOT NULL, public_key BLOB NOT NULL, wrapped BLOB NOT NULL, label TEXT NOT NULL,
        created TEXT NOT NULL)""",
    """CREATE TABLE trusted_keys (
        key_id TEXT PRIMARY KEY, label TEXT NOT NULL, public_key BLOB, added TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE accounts (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pw_hash BLOB NOT NULL, pw_salt BLOB NOT NULL, created TEXT NOT NULL, verified_at TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'guest', plan_source TEXT NOT NULL DEFAULT 'none', plan_until TEXT,
        totp_secret BLOB, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last INTEGER NOT NULL DEFAULT 0, totp_pending BLOB,
        mfa_reset_at TEXT, password_changed TEXT NOT NULL)""",
    """CREATE TABLE pending_signups (
        email TEXT PRIMARY KEY COLLATE NOCASE, username TEXT NOT NULL COLLATE NOCASE, pw_hash BLOB NOT NULL, pw_salt BLOB NOT NULL,
        code_mac TEXT NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_sent REAL NOT NULL, sent INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created REAL NOT NULL, last_seen REAL NOT NULL,
        expires REAL NOT NULL, device_id TEXT, remember INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '')""",
    """CREATE TABLE devices (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, label TEXT NOT NULL, created REAL NOT NULL,
        expires REAL NOT NULL, last_used REAL NOT NULL)""",
    """CREATE TABLE recovery_codes (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, code_mac TEXT NOT NULL, used_at REAL, PRIMARY KEY (account_id, code_mac))""",
    """CREATE TABLE challenges (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires REAL NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, code_mac TEXT, remember INTEGER NOT NULL DEFAULT 0, device_label TEXT NOT NULL DEFAULT '')""",
    """CREATE TABLE throttle (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start REAL NOT NULL, locked_until REAL NOT NULL DEFAULT 0)""",
    """CREATE TABLE audit (ts TEXT NOT NULL, account_id TEXT, event TEXT NOT NULL)""",
)
MIGRATIONS = (Migration(1, "library, versions, notes, signatures, accounts", SCHEMA_V1),)

SNAPSHOT_KEEP_AUTO = 40
_FS_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_file_stem(name: str) -> str:
    name = _FS_NAME.sub("_", name).strip().strip(".")
    return name[:120]


class WriterStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir = self.data_dir / "backups"
        self.snapshot_dir = self.data_dir / "snapshots"
        self.recovery_dir = self.data_dir / "recovery"
        self.db = Database(self.data_dir / "writer.sqlite3", MIGRATIONS, backups_dir=self.backups_dir)

    def close(self) -> None:
        self.db.close()

    def backup(self, label: str = "manual") -> Path:
        return self.db.backup(label)

    # ------------------------------------------------------------------------------------------------------ recents
    def touch_recent(self, path: Path, *, doc_id: str | None, title: str, size: int | None, revision: str | None, profile: str,
                     state: str = "saved") -> None:
        now = utc_now()
        with self.db.transaction():
            self.db.execute(
                """INSERT INTO recents(path, doc_id, title, opened_at, size, revision, state, profile) VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(path) DO UPDATE SET doc_id=excluded.doc_id, title=excluded.title, opened_at=excluded.opened_at,
                   size=excluded.size, revision=excluded.revision, state=excluded.state""",
                (str(path), doc_id, title, now, size, revision, state, profile))

    def set_recent_state(self, path: Path, state: str) -> None:
        self.db.execute("UPDATE recents SET state=? WHERE path=?", (state, str(path)))

    def recents(self, profile: str, limit: int = 100, query: str = "") -> list[dict[str, Any]]:
        rows = self.db.rows("SELECT * FROM recents WHERE profile=? ORDER BY opened_at DESC LIMIT 500", (profile,))
        needle = query.strip().lower()
        out = []
        for row in rows:
            if needle and needle not in row["title"].lower() and needle not in row["path"].lower():
                continue
            out.append(row)
            if len(out) >= limit:
                break
        return out

    def forget_recent(self, path: str) -> None:
        self.db.execute("DELETE FROM recents WHERE path=?", (path,))

    def recent(self, path: str) -> dict[str, Any] | None:
        return self.db.row("SELECT * FROM recents WHERE path=?", (path,))

    def set_favorite(self, path: str, value: bool) -> None:
        if self.db.execute("UPDATE recents SET favorite=? WHERE path=?", (1 if value else 0, path)).rowcount == 0:
            raise NotFound("That document is not in your library yet. Open it first.")

    def retarget_recent(self, old: str, new: Path) -> None:
        with self.db.transaction():
            self.db.execute("DELETE FROM recents WHERE path=?", (str(new),))
            self.db.execute("UPDATE recents SET path=?, state='saved' WHERE path=?", (str(new), old))

    # ------------------------------------------------------------------------------------------------------ folders
    def folders(self) -> list[dict[str, Any]]:
        return self.db.rows("SELECT * FROM folders ORDER BY name COLLATE NOCASE")

    def add_folder(self, path: Path, name: str | None = None) -> dict[str, Any]:
        path = path.resolve()
        if not path.is_dir():
            raise BadRequest("That folder does not exist.", hint="Check the path, or create the folder first.")
        existing = self.db.row("SELECT * FROM folders WHERE path=?", (str(path),))
        if existing:
            return existing
        fid, label = new_id(), (name or path.name or str(path))[:60]
        self.db.execute("INSERT INTO folders(id, name, path, created) VALUES(?,?,?,?)", (fid, label, str(path), utc_now()))
        return {"id": fid, "name": label, "path": str(path)}

    def remove_folder(self, folder_id: str) -> None:
        self.db.execute("DELETE FROM folders WHERE id=?", (folder_id,))

    def folder_for(self, path: Path) -> dict[str, Any] | None:
        best: dict[str, Any] | None = None
        for folder in self.folders():
            try:
                path.resolve().relative_to(Path(folder["path"]))
            except ValueError:
                continue
            if best is None or len(folder["path"]) > len(best["path"]):
                best = folder
        return best

    # ------------------------------------------------------------------------------------------------------ owners
    def claim(self, doc_id: str, profile: str) -> None:
        self.db.execute("INSERT OR IGNORE INTO doc_owner(doc_id, profile, created) VALUES(?,?,?)", (doc_id, profile, utc_now()))

    def owner_of(self, doc_id: str) -> str | None:
        return self.db.scalar("SELECT profile FROM doc_owner WHERE doc_id=?", (doc_id,))

    # --------------------------------------------------------------------------------------------------- snapshots
    def add_snapshot(self, doc_id: str, data: bytes, *, kind: str, label: str, revision_id: str | None, revision_no: int | None,
                     words: int, signed: bool, encrypted: bool) -> dict[str, Any]:
        sha = hashlib.sha256(data).hexdigest()
        if kind == "auto":                                           # an unchanged state is not worth a second copy
            last = self.db.row("SELECT sha256 FROM snapshots WHERE doc_id=? ORDER BY created DESC LIMIT 1", (doc_id,))
            if last and last["sha256"] == sha:
                return self.db.row("SELECT * FROM snapshots WHERE doc_id=? ORDER BY created DESC LIMIT 1", (doc_id,)) or {}
        sid = new_id()
        folder = self.snapshot_dir / safe_file_stem(doc_id)
        file = folder / f"{sid}.sldc"
        atomic_write(file, data)
        row = {"id": sid, "doc_id": doc_id, "created": utc_now(), "kind": kind, "label": label[:200], "revision_id": revision_id,
               "revision_no": revision_no, "file": str(file), "bytes": len(data), "words": words, "signed": int(signed),
               "encrypted": int(encrypted), "sha256": sha}
        self.db.execute("INSERT INTO snapshots VALUES(:id,:doc_id,:created,:kind,:label,:revision_id,:revision_no,:file,:bytes,:words,"
                        ":signed,:encrypted,:sha256)", row)
        self._prune_snapshots(doc_id)
        return row

    def _prune_snapshots(self, doc_id: str) -> None:
        autos = self.db.rows("SELECT id, file FROM snapshots WHERE doc_id=? AND kind='auto' ORDER BY created DESC", (doc_id,))
        for old in autos[SNAPSHOT_KEEP_AUTO:]:
            self.db.execute("DELETE FROM snapshots WHERE id=?", (old["id"],))
            try:
                Path(old["file"]).unlink()
            except OSError:
                pass

    def snapshots(self, doc_id: str) -> list[dict[str, Any]]:
        return self.db.rows("SELECT * FROM snapshots WHERE doc_id=? ORDER BY created DESC", (doc_id,))

    def snapshot(self, snapshot_id: str) -> dict[str, Any]:
        row = self.db.row("SELECT * FROM snapshots WHERE id=?", (snapshot_id,))
        if row is None:
            raise NotFound("That version no longer exists.")
        return row

    def snapshot_bytes(self, snapshot_id: str) -> bytes:
        row = self.snapshot(snapshot_id)
        try:
            data = Path(row["file"]).read_bytes()
        except OSError as exc:
            raise NotFound("The saved copy of that version is missing from this computer.") from exc
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise Conflict("The saved copy of that version was changed outside Writer and cannot be trusted.")
        return data

    def has_snapshot(self, doc_id: str, revision_id: str, kind: str) -> bool:
        return bool(self.db.scalar("SELECT 1 FROM snapshots WHERE doc_id=? AND revision_id=? AND kind=?", (doc_id, revision_id, kind)))

    # ------------------------------------------------------------------------------------------------------- notes
    def notes(self, doc_id: str) -> list[dict[str, Any]]:
        return self.db.rows("SELECT * FROM notes WHERE doc_id=? ORDER BY created", (doc_id,))

    def put_note(self, doc_id: str, *, note_id: str | None, block_id: str | None, start: int | None, end: int | None, anchor_text: str,
                 body: str) -> dict[str, Any]:
        now = utc_now()
        if note_id:
            if self.db.execute("UPDATE notes SET body=?, updated=? WHERE id=? AND doc_id=?", (body, now, note_id, doc_id)).rowcount == 0:
                raise NotFound("That note no longer exists.")
            return self.db.row("SELECT * FROM notes WHERE id=?", (note_id,)) or {}
        nid = new_id()
        self.db.execute("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?)", (nid, doc_id, block_id, start, end, anchor_text[:300], body, now, now))
        return self.db.row("SELECT * FROM notes WHERE id=?", (nid,)) or {}

    def delete_note(self, doc_id: str, note_id: str) -> None:
        self.db.execute("DELETE FROM notes WHERE id=? AND doc_id=?", (note_id, doc_id))

    # -------------------------------------------------------------------------------------------------- signing keys
    def key_for(self, profile: str) -> dict[str, Any] | None:
        return self.db.row("SELECT * FROM sign_keys WHERE profile=?", (profile,))

    def put_key(self, profile: str, key_id: str, public_key: bytes, wrapped: bytes, label: str) -> None:
        with self.db.transaction():
            self.db.execute("INSERT OR REPLACE INTO sign_keys VALUES(?,?,?,?,?,?)", (profile, key_id, public_key, wrapped, label, utc_now()))
            self.db.execute("INSERT OR REPLACE INTO trusted_keys(key_id, label, public_key, added, revoked) VALUES(?,?,?,?,0)",
                            (key_id, f"{label} (this computer)", public_key, utc_now()))

    def trusted(self) -> tuple[dict[str, dict[str, Any]], set[str]]:
        rows = self.db.rows("SELECT * FROM trusted_keys")
        return ({r["key_id"]: r for r in rows if not r["revoked"]}, {r["key_id"] for r in rows if r["revoked"]})

    def trust_key(self, key_id: str, label: str, public_key: bytes | None) -> None:
        self.db.execute("INSERT OR REPLACE INTO trusted_keys(key_id, label, public_key, added, revoked) VALUES(?,?,?,?,0)",
                        (key_id, label[:80], public_key, utc_now()))

    def revoke_key(self, key_id: str) -> None:
        self.db.execute("UPDATE trusted_keys SET revoked=1 WHERE key_id=?", (key_id,))
        # an unknown key can also be revoked in advance
        self.db.execute("INSERT OR IGNORE INTO trusted_keys(key_id, label, public_key, added, revoked) VALUES(?,?,?,?,1)",
                        (key_id, "revoked key", None, utc_now()))

    def counts(self) -> dict[str, int]:
        return {"recents": self.db.scalar("SELECT COUNT(*) FROM recents") or 0, "snapshots": self.db.scalar("SELECT COUNT(*) FROM snapshots") or 0,
                "notes": self.db.scalar("SELECT COUNT(*) FROM notes") or 0, "accounts": self.db.scalar("SELECT COUNT(*) FROM accounts") or 0}
