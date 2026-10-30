"""An open document: the working SLDC package, its edit history, and how it reaches the disk.

The server owns the document. The browser sends operations (:mod:`.ops`) tagged with the version it last saw; the session applies
them under a lock, keeps undo/redo, tracks what is saved, writes crash-recovery copies, snapshots versions and saves atomically
through the shared storage layer. Files are SLDC only: reading, writing, validation, revision lineage, merging, signing and
encryption all call ``src.utils.sldc``.
"""
from __future__ import annotations

import copy
import hashlib
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..tools import slai
from ..tools.errors import BadRequest, Conflict, DependencyMissing, Forbidden, LimitExceeded, NotFound
from ..tools.storage import atomic_write
from ..tools.validation import utc_now
from . import ops as O
from . import textmodel as tm
from .store import WriterStore, safe_file_stem

MAX_UNDO = 400
COALESCE_SECONDS = 1.5
MAX_OPEN = 24
WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)


def sldc():
    return slai.sldc()


def words_and_chars(text: str) -> tuple[int, int]:
    return len(WORD.findall(text)), len(text)


def block_plain(block: dict[str, Any]) -> str:
    """Readable text of a block for counting and searching (tables: caption and cells; equations: source)."""
    return sldc().block_text(block).replace(tm.OBJ, "")


@dataclass
class Entry:
    undo: O.Undo
    at: float
    seq: int


class Stats:
    """Word and character totals kept up to date by recounting only the blocks an operation touched."""

    def __init__(self) -> None:
        self.per: dict[str, tuple[int, int]] = {}
        self.words = 0
        self.chars = 0

    def rebuild(self, blocks: list[dict[str, Any]]) -> None:
        self.per = {b["id"]: words_and_chars(block_plain(b)) for b in blocks}
        self.words = sum(w for w, _ in self.per.values())
        self.chars = sum(c for _, c in self.per.values())

    def update(self, doc: dict[str, Any], touched: set[str], full: bool) -> None:
        if full:
            self.rebuild(doc["blocks"])
            return
        present = {b["id"]: b for b in doc["blocks"] if b["id"] in touched}
        for block_id in touched:
            old = self.per.pop(block_id, (0, 0))
            self.words -= old[0]
            self.chars -= old[1]
            block = present.get(block_id)
            if block is not None:
                new = words_and_chars(block_plain(block))
                self.per[block_id] = new
                self.words += new[0]
                self.chars += new[1]


class DocumentSession:
    def __init__(self, store: WriterStore, package: Any, *, path: Path | None, profile: str, password: str | None = None,
                 readonly_reason: str | None = None, notices: list[str] | None = None, origin: dict[str, Any] | None = None) -> None:
        self.sid = secrets.token_urlsafe(12)
        self.store = store
        self.pkg = package
        self.path = path
        self.profile = profile
        self.password = password
        self.readonly_reason = readonly_reason
        self.notices = notices or []
        self.origin = origin or {}                      # e.g. {"kind": "recovery", "path": ...} or {"kind": "snapshot", "id": ...}
        self.lock = threading.RLock()
        self.version = 0
        self.undo_stack: list[Entry] = []
        self.redo_stack: list[Entry] = []
        self.seq = 0
        self.opened = time.time()
        self.last_edit: float | None = None
        self.dirty = False
        self.recovery_dirty = False
        self.recovery_written_at = 0.0
        self.saved_at: float | None = None
        self.disk: tuple[int, int, str] | None = None   # (mtime_ns, size, sha256) of the file as we last read or wrote it
        self.base = package.copy()                      # the package as last opened/saved: the common ancestor for merging
        self.stats = Stats()
        self.stats.rebuild(package.document["blocks"])
        self.last_snapshot_at = 0.0
        self.version_label = ""
        self.autosave: bool | None = None               # None = application preference

    # ------------------------------------------------------------------------------------------------------- reading
    @property
    def doc(self) -> dict[str, Any]:
        return self.pkg.document

    @property
    def doc_id(self) -> str:
        return self.doc["id"]

    @property
    def title(self) -> str:
        return self.doc["title"]

    @property
    def revision_no(self) -> int:
        return (self.doc.get("revision") or {}).get("number", 1)

    @property
    def signed(self) -> bool:
        return bool(self.pkg.signatures)

    @property
    def encrypted(self) -> bool:
        return self.password is not None

    def role(self) -> str:
        owner = self.store.owner_of(self.doc_id)
        return "owner" if owner in (None, self.profile) else "reviewer"

    def access(self) -> dict[str, Any]:
        reason = self.readonly_reason
        return {"role": self.role(), "canEdit": reason is None, "readOnlyReason": reason}

    def summary(self) -> dict[str, Any]:
        return {"sid": self.sid, "title": self.title, "path": str(self.path) if self.path else None, "dirty": self.dirty,
                "name": self.path.stem if self.path else self.title, "readOnly": self.readonly_reason is not None,
                "signed": self.signed, "origin": self.origin.get("kind")}

    def state(self) -> dict[str, Any]:
        with self.lock:
            doc = copy.deepcopy(self.doc)
            blocks = doc.pop("blocks")
            self.redact_embeds(doc)
            statuses = sldc().comment_anchor_status(self.pkg)
            return {
                **self.summary(), "version": self.version, "document": doc, "blocks": blocks,
                "assets": [{"id": a.id, "mediaType": a.media_type, "bytes": len(a.data)} for a in self.pkg.assets.values()],
                "comments": [{**t, "anchorStatus": statuses.get(t["id"], "ok")} for t in self.pkg.comments],
                "revision": self.revision_info(), "stats": self.stats_payload(), "access": self.access(),
                "undo": self.undo_stack[-1].undo.label if self.undo_stack else None,
                "redo": self.redo_stack[-1].undo.label if self.redo_stack else None,
                "notices": self.notices, "encrypted": self.encrypted, "signatures": len(self.pkg.signatures),
                "savedAt": self.saved_at, "lastEdit": self.last_edit, "opened": self.opened,
            }

    def redact_embeds(self, doc: dict[str, Any]) -> None:
        """A locked EMBED's parameters and inputs are not sent to a role that cannot open it (the output text stays: it is the public summary)."""
        locks = ((self.doc.get("extensions") or {}).get(O.WRITER_EXT) or {}).get("locks") or {}
        if not locks or self.role() == "owner":
            return
        for decl in doc.get("embeds", []) or []:
            if decl["id"] in locks:
                decl["params"], decl["inputs"] = {}, []
                decl["redacted"] = True

    def revision_info(self) -> dict[str, Any]:
        rev = self.doc.get("revision")
        return {"number": rev["number"] if rev else 1, "created": rev.get("created") if rev else None,
                "id": self._revision_id(), "history": len(self.doc.get("history", []))}

    def _revision_id(self) -> str:
        """The content hash of the open document. A document that gained equations, inline pictures, embeds or similar content needs SLDC 1.1;
        the package is upgraded here, once, and the person is told, rather than failing the edit that added the content.
        A picture that no block uses any more (its block was deleted, or the upload came before the block) is not part of the document: the hash
        is taken without it, but the picture stays in the session so that undoing the deletion brings it back."""
        try:
            return self._rid()
        except sldc().SLDCUnsupportedError as exc:
            if "1.1" not in str(exc) or self.pkg.version != "1.0.0":
                raise
            self.pkg.version = "1.1.0"
            note = "This document now uses SLDC 1.1 because it contains equations, inline pictures or similar content. Older programs that only read SLDC 1.0 may not open it."
            if note not in self.notices:
                self.notices.append(note)
            return self._rid()

    def _rid(self, package: Any | None = None) -> str:
        package = package or self.pkg
        try:
            return sldc().revision_id(package)
        except sldc().SLDCValidationError as exc:
            if "no figure or cover uses" not in str(exc):
                raise
            return sldc().revision_id(sldc().prune_assets(package))

    def stats_payload(self) -> dict[str, Any]:
        return {"words": self.stats.words, "characters": self.stats.chars, "blocks": len(self.doc["blocks"])}

    # ---------------------------------------------------------------------------------------------------- editing
    def _require_editable(self) -> None:
        if self.readonly_reason:
            raise Forbidden(self.readonly_reason)

    def _leave_signed_revision(self) -> None:
        """Editing a signed document starts a new revision; the signed one stays as an immutable snapshot."""
        if not self.pkg.signatures:
            return
        self.snapshot("signed", f"Signed revision {self.revision_no}", force=False)
        self.pkg = sldc().next_revision(self.pkg, author=None, note="Edited after signing")
        self.notices = [n for n in self.notices if "signed" not in n]
        self.notices.append(f"This document was signed. Your edit started revision {self.revision_no}; the signed revision is kept in version history.")

    def apply(self, op: dict[str, Any], base: int | None) -> dict[str, Any]:
        with self.lock:
            self._require_editable()
            self._check_base(base)
            self._check_locks(op)
            self._leave_signed_revision()
            before_keys = set()
            undo, result, tracker = O.apply_operation(self.doc, op)
            if undo.empty:
                return self._patch(undo, result, tracker, changed=False)
            if tracker.structural or op["op"] in ("page_setup", "meta", "style_define", "reference_put", "reference_delete", "embed_put",
                                                  "embed_delete", "section_break", "inline_object", "span", "figure_set", "equation_set",
                                                  "batch", "table_edit", "ext_set", "block_set"):
                try:
                    sldc().validate_sldc(self.doc)
                except sldc().SLDCError as exc:
                    O.apply_undo(self.doc, undo)
                    raise BadRequest(f"That change is not allowed in an SLDC document: {exc}") from exc
            now = time.time()
            self.seq += 1
            self._push(Entry(undo, now, self.seq), op, now)
            self.redo_stack.clear()
            self.version += 1
            self.last_edit = now
            self.dirty = True
            self.recovery_dirty = True
            self.stats.update(self.doc, tracker.touched | set(undo.blocks), full=tracker.structural and len(tracker.touched) > 200)
            return self._patch(undo, result, tracker, changed=True)

    def _push(self, entry: Entry, op: dict[str, Any], now: float) -> None:
        if self.undo_stack and entry.undo.typing and op["op"] == "text":
            last = self.undo_stack[-1]
            if last.undo.typing == entry.undo.typing and now - last.at < COALESCE_SECONDS and not entry.undo.order and not last.undo.order:
                last.undo.absorb(entry.undo)
                last.at = now
                return
        self.undo_stack.append(entry)
        del self.undo_stack[:-MAX_UNDO]

    def _check_base(self, base: int | None) -> None:
        if base is not None and base != self.version:
            raise Conflict("This document changed since your screen last updated. Reload it to continue.",
                           details={"expected": base, "current": self.version, "kind": "stale_version"})

    def _check_locks(self, op: dict[str, Any]) -> None:
        locks = ((self.doc.get("extensions") or {}).get(O.WRITER_EXT) or {}).get("locks") or {}
        if not locks or self.role() == "owner":
            return                                    # the owner may edit what they locked; a lock restrains other roles
        for inner in (op.get("ops") if op.get("op") == "batch" else [op]):
            for key in ("block",):
                block_id = inner.get(key)
                block = next((b for b in self.doc["blocks"] if b["id"] == block_id), None) if block_id else None
                if block and block.get("embed") in locks and inner.get("op") not in ("embed_unlock",):
                    raise Forbidden("This EMBED component is locked. Unlock it with the right access first.")
            if inner.get("op") in ("embed_put", "embed_delete"):
                eid = (inner.get("embed") or {}).get("id") or inner.get("id")
                if eid in locks:
                    raise Forbidden("This EMBED component is locked. Unlock it with the right access first.")

    def _patch(self, undo: O.Undo, result: dict[str, Any], tracker: O.Tracker | None, *, changed: bool) -> dict[str, Any]:
        index = {b["id"]: b for b in self.doc["blocks"]}
        blocks = {i: copy.deepcopy(index.get(i)) for i in undo.blocks}
        patch: dict[str, Any] = {
            "version": self.version, "result": result, "blocks": blocks, "dirty": self.dirty, "stats": self.stats_payload(),
            "undo": self.undo_stack[-1].undo.label if self.undo_stack else None,
            "redo": self.redo_stack[-1].undo.label if self.redo_stack else None,
            "revision": self.revision_info(), "signatures": len(self.pkg.signatures), "notices": self.notices,
        }
        if undo.order is not None:
            patch["order"] = [b["id"] for b in self.doc["blocks"]]
        if undo.keys:
            patch["document"] = {k: copy.deepcopy(self.doc.get(k)) for k in undo.keys}
            self.redact_embeds(patch["document"])
        return patch

    def undo(self, base: int | None) -> dict[str, Any]:
        return self._travel(self.undo_stack, self.redo_stack, base, "There is nothing to undo.")

    def redo(self, base: int | None) -> dict[str, Any]:
        return self._travel(self.redo_stack, self.undo_stack, base, "There is nothing to redo.")

    def _travel(self, source: list[Entry], target: list[Entry], base: int | None, empty: str) -> dict[str, Any]:
        with self.lock:
            self._require_editable()
            self._check_base(base)
            if not source:
                raise BadRequest(empty)
            entry = source.pop()
            inverse = O.apply_undo(self.doc, entry.undo)
            self.seq += 1
            target.append(Entry(inverse, time.time(), self.seq))
            self.version += 1
            self.last_edit = time.time()
            self.dirty = True
            self.recovery_dirty = True
            self.stats.update(self.doc, set(entry.undo.blocks), full=entry.undo.order is not None)
            return self._patch(entry.undo, {}, None, changed=True)

    # ---------------------------------------------------------------------------------------------------- comments
    def add_comment(self, block_id: str, text: str, author: str, start: int | None, end: int | None) -> dict[str, Any]:
        with self.lock:
            if self.readonly_reason:
                raise Forbidden(self.readonly_reason)
            try:
                pkg, thread_id = sldc().add_comment(self.pkg, block_id, text, author=author, start=start, end=end)
            except sldc().SLDCError as exc:
                raise BadRequest(str(exc)) from exc
            self.pkg = pkg
            return self._comments_changed()

    def reply_comment(self, thread_id: str, text: str, author: str) -> dict[str, Any]:
        with self.lock:
            try:
                self.pkg = sldc().reply_to_thread(self.pkg, thread_id, text, author=author)
            except sldc().SLDCError as exc:
                raise BadRequest(str(exc)) from exc
            return self._comments_changed()

    def set_comment_status(self, thread_id: str, status: str, by: str) -> dict[str, Any]:
        with self.lock:
            try:
                self.pkg = sldc().set_thread_status(self.pkg, thread_id, status, by=by)
            except sldc().SLDCError as exc:
                raise BadRequest(str(exc)) from exc
            return self._comments_changed()

    def _comments_changed(self) -> dict[str, Any]:
        self.dirty = True
        self.recovery_dirty = True
        self.last_edit = time.time()
        self.version += 1
        statuses = sldc().comment_anchor_status(self.pkg)
        return {"version": self.version, "dirty": True,
                "comments": [{**t, "anchorStatus": statuses.get(t["id"], "ok")} for t in self.pkg.comments]}

    # ---------------------------------------------------------------------------------------------------- assets
    def add_image(self, data: bytes) -> Any:
        with self.lock:
            try:
                asset = sldc().make_asset(data)
            except sldc().SLDCError as exc:
                raise BadRequest(f"That image cannot be used: {exc}", hint="Use a PNG, JPEG, GIF or WebP picture.") from exc
            self.pkg = sldc().add_asset(self.pkg, asset)
            return asset

    # ------------------------------------------------------------------------------------------------ serialisation
    def _settled(self, package: Any) -> Any:
        package = sldc().prune_assets(package)
        try:
            sldc().validate_package(package)
        except sldc().SLDCUnsupportedError as exc:
            if "1.1" in str(exc) and package.version == "1.0.0":
                package.version = "1.1.0"
                sldc().validate_package(package)
            else:
                raise
        return package

    def to_bytes(self, package: Any | None = None) -> bytes:
        package = self._settled((package or self.pkg).copy())
        recipients = None
        if self.password:
            recipients = [sldc().password_recipient(self.password)]
        try:
            return sldc().dumps_package(package, recipients=recipients)
        except sldc().SLDCError as exc:
            raise BadRequest(f"The document could not be written as SLDC: {exc}", hint="Nothing was saved; your document is unchanged.") from exc

    # ---------------------------------------------------------------------------------------------------- snapshots
    def snapshot(self, kind: str, label: str = "", force: bool = True) -> dict[str, Any] | None:
        with self.lock:
            try:
                data = self.to_bytes()
            except (BadRequest, sldc().SLDCError):
                return None
            rid = self._rid()
            if kind == "signed" and not force and self.store.has_snapshot(self.doc_id, rid, "signed"):
                return None
            row = self.store.add_snapshot(self.doc_id, data, kind=kind, label=label or kind, revision_id=rid, revision_no=self.revision_no,
                                          words=self.stats.words, signed=bool(self.pkg.signatures), encrypted=self.encrypted)
            self.last_snapshot_at = time.time()
            return row

    def create_version(self, label: str, author: str | None = None) -> dict[str, Any]:
        """A named version: snapshot what exists, then start the next revision so later edits are new work."""
        with self.lock:
            self._require_editable()
            row = self.snapshot("manual", label or f"Version {self.revision_no}")
            self.pkg = sldc().next_revision(self.pkg, author=author, note=label or None)
            self.version += 1
            self.dirty = True
            self.recovery_dirty = True
            return {"snapshot": row, "revision": self.revision_info(), "version": self.version}

    def restore_snapshot(self, snapshot_id: str, author: str | None = None) -> dict[str, Any]:
        """Restore an old version as a NEW revision: nothing is overwritten and the old revision remains in history."""
        with self.lock:
            self._require_editable()
            data = self.store.snapshot_bytes(snapshot_id)
            row = self.store.snapshot(snapshot_id)
            if row["doc_id"] != self.doc_id:
                raise BadRequest("That version belongs to a different document.")
            old = load_bytes(data, self.password)
            self.snapshot("auto", f"Before restoring revision {row['revision_no']}")
            moved = sldc().next_revision(self.pkg, author=author, note=f"Restored revision {row['revision_no']} ({row['created'][:16]})")
            restored = old.copy()
            restored.document["revision"] = moved.document["revision"]
            restored.document["history"] = moved.document.get("history", [])
            restored.document["id"] = self.doc_id
            restored.comments = copy.deepcopy(self.pkg.comments)
            restored.signatures = []
            restored.version = max(restored.version, moved.version)
            sldc().validate_package(restored) if restored.version != "1.0.0" else sldc().validate_package(restored)
            self.pkg = restored
            self.undo_stack.clear()
            self.redo_stack.clear()
            self.version += 1
            self.dirty = True
            self.recovery_dirty = True
            self.stats.rebuild(self.doc["blocks"])
            self.notices = [f"Restored version {row['revision_no']} from {row['created'][:16]} as revision {self.revision_no}. "
                            f"The previous state is in version history."]
            return self.state()

    def apply_signature(self, signer: Any, *, purpose: str, statement: str | None) -> dict[str, Any]:
        """Add a cryptographic SLDC signature over exactly the bytes that would be saved now, then freeze that revision.

        The signature covers the settled package (orphan assets pruned) so the file written afterwards is byte-identical to what was
        signed. Later edits start a new revision; the signed one stays in version history (see ``_leave_signed_revision``).
        """
        with self.lock:
            self._require_editable()
            settled = self._settled(self.pkg.copy())
            try:
                signed = sldc().sign_package(settled, signer, purpose=purpose, statement=statement)
            except sldc().SLDCError as exc:
                raise BadRequest(f"The revision could not be signed: {exc}", hint="Nothing was changed.") from exc
            self.pkg = signed
            self.undo_stack.clear()
            self.redo_stack.clear()
            self.version += 1
            self.dirty = True
            self.recovery_dirty = True
            row = self.snapshot("signed", f"Signed revision {self.revision_no}", force=True)
            return {"snapshot": row, "signature": signed.signatures[-1]["id"]}

    # -------------------------------------------------------------------------------------------------------- saving
    def _disk_state(self, path: Path) -> tuple[int, int, str] | None:
        try:
            info = path.stat()
            return (info.st_mtime_ns, info.st_size, hashlib.sha256(path.read_bytes()).hexdigest())
        except OSError:
            return None

    def external_change(self) -> bool:
        if self.path is None or self.disk is None:
            return False
        try:
            info = self.path.stat()
        except OSError:
            return True
        if (info.st_mtime_ns, info.st_size) == self.disk[:2]:
            return False
        state = self._disk_state(self.path)
        return state is None or state[2] != self.disk[2]

    def save(self, *, force: bool = False) -> dict[str, Any]:
        with self.lock:
            self._require_editable()
            if self.path is None:
                raise BadRequest("This document has no file yet. Use Save as.", hint="Choose a name and a folder.")
            if not force and self.external_change():
                raise Conflict("This file was changed by another program since you opened it.",
                               details={"kind": "external_change", "path": str(self.path)},
                               hint="Choose whether to merge the two versions, keep both, or overwrite the other changes.")
            data = self.to_bytes()
            atomic_write(self.path, data)
            self._after_save(data)
            return self.save_result()

    # ------------------------------------------------------------------------------------------ external changes
    def _disk_package(self) -> Any:
        if self.path is None:
            raise BadRequest("This document has no file yet.")
        try:
            return load_bytes(self.path.read_bytes(), self.password)
        except OSError as exc:
            raise NotFound(f"The file cannot be read any more: {exc.strerror or exc}") from exc

    def _merge_report(self, conflicts: list[dict[str, Any]], ours: Any, theirs: Any) -> list[dict[str, Any]]:
        mine = {b["id"]: b for b in ours.document["blocks"]}
        other = {b["id"]: b for b in theirs.document["blocks"]}
        text = sldc().block_text
        report = []
        for c in conflicts:
            bid = c.get("block")
            report.append({**c, "ours": text(mine[bid]) if bid in mine else None, "theirs": text(other[bid]) if bid in other else None})
        return report

    def merge_with(self, theirs: Any, base: Any, *, author: str | None, accept_conflicts: bool, label: str) -> dict[str, Any]:
        """Three-way merge of ``theirs`` into this document. Conflicts are shown, never resolved silently: without ``accept_conflicts``
        nothing changes; with it, our text is kept where both sides differ and their version is saved to version history."""
        with self.lock:
            self._require_editable()
            if self.pkg.signatures:
                self._leave_signed_revision()
            try:
                merged, conflicts = sldc().merge_packages(base, self.pkg, theirs, author=author, note=label)
            except sldc().SLDCError as exc:
                raise BadRequest(f"These two copies cannot be merged: {exc}", hint="They may not come from the same document.") from exc
            report = self._merge_report(conflicts, self.pkg, theirs)
            if conflicts and not accept_conflicts:
                return {"applied": False, "conflicts": report, "message": f"{len(conflicts)} place(s) were changed in both copies. Nothing was merged yet."}
            self.snapshot("auto", f"Before merging: {label}")
            if conflicts:
                try:
                    self.store.add_snapshot(self.doc_id, sldc().dumps_package(theirs), kind="merge", label=f"Other version: {label}",
                                            revision_id=sldc().revision_id(theirs), revision_no=(theirs.document.get("revision") or {}).get("number"),
                                            words=0, signed=bool(theirs.signatures), encrypted=False)
                except sldc().SLDCError:
                    pass
            self.pkg = merged
            self.undo_stack.clear()
            self.redo_stack.clear()
            self.version += 1
            self.dirty = True
            self.recovery_dirty = True
            self.stats.rebuild(self.doc["blocks"])
            self.notices = [f"Merged: {label}." + (f" {len(conflicts)} conflicting place(s) kept your text; the other version is in version history." if conflicts else "")]
            return {"applied": True, "conflicts": report, "state": self.state()}

    def resolve_external(self, action: str, *, author: str | None = None, accept_conflicts: bool = False) -> dict[str, Any]:
        """The file changed on disk while this document had unsaved edits. ``merge``, ``keep_both``, ``overwrite`` or ``reload``."""
        with self.lock:
            if self.path is None:
                raise BadRequest("This document has no file yet.")
            if action == "overwrite":
                self.snapshot("auto", "Before overwriting the other program's changes")
                return self.save(force=True)
            if action == "keep_both":
                target = self.path.with_name(f"{self.path.stem} (my changes){self.path.suffix}")
                for n in range(2, 1000):
                    if not target.exists():
                        break
                    target = self.path.with_name(f"{self.path.stem} (my changes {n}){self.path.suffix}")
                data = self.to_bytes()
                atomic_write(target, data, exclusive=True)
                self.path = target
                self._after_save(data)
                return {**self.save_result(), "keptBoth": True, "name": target.name}
            theirs = self._disk_package()
            if action == "reload":
                self.snapshot("auto", "Before reloading from disk")
                self.pkg = theirs
                self.base = theirs.copy()
                self.undo_stack.clear()
                self.redo_stack.clear()
                self.version += 1
                self.disk = self._disk_state(self.path)
                self.dirty = False
                self.stats.rebuild(self.doc["blocks"])
                return self.state()
            if action == "merge":
                out = self.merge_with(theirs, self.base, author=author, accept_conflicts=accept_conflicts, label="changes made by another program")
                if out["applied"]:
                    self.disk = self._disk_state(self.path)            # now our file knows about theirs, so saving is allowed
                return out
            raise BadRequest("Choose merge, keep both, overwrite or reload.")

    def _after_save(self, data: bytes) -> None:
        self.disk = self._disk_state(self.path) if self.path else None
        self.dirty = False
        self.recovery_dirty = False
        self.saved_at = time.time()
        self.base = self.pkg.copy()
        self.discard_recovery()
        if self.path:
            self.store.touch_recent(self.path, doc_id=self.doc_id, title=self.title, size=len(data), revision=self._rid(),
                                    profile=self.profile)
        if time.time() - self.last_snapshot_at > 600:
            self.snapshot("auto", "Autosnapshot")

    def save_result(self) -> dict[str, Any]:
        return {"saved": True, "path": str(self.path), "savedAt": self.saved_at, "dirty": self.dirty, "bytes": self.disk[1] if self.disk else None,
                "version": self.version, "revision": self.revision_info()}

    def save_as(self, path: Path, *, new_identity: bool = False, overwrite: bool = False) -> dict[str, Any]:
        with self.lock:
            if self.path is None and self.readonly_reason:
                pass                                           # saving an inspected copy somewhere is allowed (it becomes editable)
            if path.exists() and not overwrite:
                raise Conflict(f"A file named {path.name} already exists there.", hint="Choose another name, or confirm overwriting it.")
            if new_identity:
                self.pkg = self.pkg.copy()
                self.pkg.document["id"] = f"doc-{secrets.token_hex(16)}"
                self.pkg.document.pop("revision", None)
                self.pkg.document.pop("history", None)
                self.pkg.signatures = []
            data = self.to_bytes()
            atomic_write(path, data)
            self.path = path
            self.readonly_reason = None
            self.origin = {}
            self.store.claim(self.doc_id, self.profile)
            self._after_save(data)
            return self.save_result()

    def rename(self, stem: str) -> dict[str, Any]:
        with self.lock:
            if self.path is None:
                raise BadRequest("Save the document first, then rename it.")
            target = self.path.with_name(f"{stem}.sldc")
            if target == self.path:
                return self.summary()
            if target.exists():
                raise Conflict(f"A file named {target.name} already exists in that folder.", hint="Choose a different name.")
            if self.external_change():
                raise Conflict("The file was changed by another program; save or reload before renaming it.")
            old = self.path
            try:
                os.replace(old, target)
            except OSError as exc:
                from ..tools.errors import classify_oserror
                raise classify_oserror(exc, "rename the file") from exc
            self.store.retarget_recent(str(old), target)
            self.path = target
            self.disk = self._disk_state(target)
            return self.summary()

    # --------------------------------------------------------------------------------------------------- recovery
    def recovery_path(self) -> Path:
        return self.store.recovery_dir / f"{safe_file_stem(self.doc_id)}.sldc"

    def write_recovery(self) -> bool:
        """A crash-recovery copy of unsaved work (kept apart from the document; removed when the document is saved)."""
        with self.lock:
            if not self.dirty or not self.recovery_dirty or self.readonly_reason and self.origin.get("kind") == "snapshot":
                return False
            try:
                data = self.to_bytes()
                atomic_write(self.recovery_path(), data)
                meta = (self.path.as_posix() if self.path else "") + "\n" + str(time.time()) + "\n" + ("encrypted" if self.encrypted else "plain")
                atomic_write(self.recovery_path().with_suffix(".txt"), meta.encode("utf-8"))
            except Exception:                                  # noqa: BLE001 - recovery is best effort and must never break editing
                return False
            self.recovery_dirty = False
            self.recovery_written_at = time.time()
            return True

    def discard_recovery(self) -> None:
        for p in (self.recovery_path(), self.recovery_path().with_suffix(".txt")):
            try:
                p.unlink()
            except OSError:
                pass

    # ----------------------------------------------------------------------------------------------------- search
    def search(self, query: str, *, case: bool = False, whole: bool = False, limit: int = 2000) -> list[dict[str, Any]]:
        if not query:
            return []
        flags = 0 if case else re.IGNORECASE
        pattern = re.escape(query)
        if whole:
            pattern = rf"(?<!\w){pattern}(?!\w)"
        rx = re.compile(pattern, flags)
        found: list[dict[str, Any]] = []
        with self.lock:
            for block in self.doc["blocks"]:
                if block["type"] in ("table", "figure", "embed", "equation"):
                    texts = [("text", block["text"])] if block["text"] else []
                    if block["type"] == "table":
                        for r, row in enumerate(block["table"]["rows"]):
                            for c, cell in enumerate(row):
                                texts.append((f"cell:{r}:{c}", cell["text"]))
                else:
                    texts = [("text", block["text"])]
                for where, text in texts:
                    for m in rx.finditer(text):
                        lo, hi = max(0, m.start() - 30), min(len(text), m.end() + 30)
                        found.append({"block": block["id"], "where": where, "start": m.start(), "end": m.end(),
                                      "snippet": text[lo:hi].replace(tm.OBJ, " ")})
                        if len(found) >= limit:
                            return found
        return found

    def outline(self) -> list[dict[str, Any]]:
        with self.lock:
            return [{"block": b["id"], "level": (b.get("attributes") or {}).get("level", 1), "text": tm.plain(b)}
                    for b in self.doc["blocks"] if b["type"] == "heading"]

    def plain_text(self) -> str:
        with self.lock:
            return "\n\n".join(block_plain(b) for b in self.doc["blocks"])


# ------------------------------------------------------------------------------------------------------- loading files
def load_bytes(data: bytes, password: str | None) -> Any:
    S = sldc()
    try:
        return S.loads_package(data, password=password)
    except S.SLDCDecryptionError as exc:
        raise Forbidden("This document is protected. Enter its password to open it." if not password else "That password does not open this document.",
                        details={"needsPassword": True}) from exc
    except S.SLDCDependencyError as exc:
        raise DependencyMissing(str(exc)) from exc
    except S.SLDCError as exc:
        raise BadRequest(f"This is not a valid SLDC document: {exc}", details={"damaged": True}) from exc


def inspect(path: Path) -> dict[str, Any]:
    """What a file claims to be, read from its manifest only (nothing is decrypted or executed)."""
    try:
        return sldc().inspect_package(path)
    except sldc().SLDCError as exc:
        raise BadRequest(f"This is not a valid SLDC document: {exc}", details={"damaged": True}) from exc


class SessionManager:
    def __init__(self, store: WriterStore) -> None:
        self.store = store
        self.sessions: dict[str, DocumentSession] = {}
        self.order: list[str] = []
        self.lock = threading.RLock()

    def add(self, session: DocumentSession) -> DocumentSession:
        with self.lock:
            if len(self.sessions) >= MAX_OPEN:
                raise LimitExceeded(f"{MAX_OPEN} documents are open. Close one to open another.")
            self.sessions[session.sid] = session
            self.order.append(session.sid)
            return session

    def get(self, sid: str) -> DocumentSession:
        with self.lock:
            session = self.sessions.get(sid)
        if session is None:
            raise NotFound("That document is no longer open. Open it again from Home.")
        return session

    def find_by_path(self, path: Path) -> DocumentSession | None:
        with self.lock:
            for session in self.sessions.values():
                if session.path is not None and session.path == path:
                    return session
        return None

    def close(self, sid: str) -> None:
        with self.lock:
            session = self.sessions.pop(sid, None)
            if sid in self.order:
                self.order.remove(sid)
        if session is not None:
            session.discard_recovery() if not session.dirty else None

    def listing(self) -> list[dict[str, Any]]:
        with self.lock:
            return [self.sessions[s].summary() for s in self.order if s in self.sessions]

    def all(self) -> list[DocumentSession]:
        with self.lock:
            return list(self.sessions.values())


def open_file(store: WriterStore, path: Path, *, profile: str, password: str | None = None) -> DocumentSession:
    """Open an SLDC file as an editable session. ``.sdoc`` files are opened only when their content really is SLDC, and are never
    renamed: the first save asks for a ``.sldc`` name (see ``routes.open_legacy``)."""
    S = sldc()
    if not path.is_file():
        raise NotFound("That file does not exist any more.", hint="Use Locate to find it, or Remove from recent.")
    data = path.read_bytes() if path.stat().st_size <= S.MAX_PACKAGE_BYTES else b""
    if not data:
        raise LimitExceeded("That file is larger than the SLDC format allows.")
    package = load_bytes(data, password)
    notices: list[str] = []
    origin: dict[str, Any] = {}
    if package.version == S.LEGACY_VERSION:
        package, report = S.migrate_package(package)
        notices.append("This file uses the older SLDC 0.1 format. Writer opened it as SLDC 1.0 (nothing was lost); your original file is "
                       "unchanged until you save.")
        origin["migrated"] = True
    elif package.version.startswith("1.") and package.version != S.FORMAT_VERSION and package.version != "1.1.0":
        notices.append(f"This file is SLDC {package.version}. Writer saves SLDC 1.x documents without changing their version unless a feature needs it.")
    session = DocumentSession(store, package, path=path, profile=profile, password=password, notices=notices, origin=origin)
    session.disk = session._disk_state(path)
    store.touch_recent(path, doc_id=session.doc_id, title=session.title, size=path.stat().st_size, revision=S.revision_id(package), profile=profile)
    if package.signatures:
        notices.append("This document is signed. Editing it starts a new revision; the signed revision stays in version history.")
        session.snapshot("signed", f"Signed revision {session.revision_no} (as opened)", force=False)
    return session
