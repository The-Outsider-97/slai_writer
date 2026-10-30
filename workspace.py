"""Sharing and collaboration, as far as this installation can honestly go.

Writer does not simulate live co-editing, presence or shared workspaces. Those need a workspace server (accounts, permissions enforced
on the server, a real-time channel); none ships with Writer or is configured, so ``status()`` says so and every route that would need it
refuses. What does work, because it is real and local:

* **Share a copy**: an SLDC export (optionally password-encrypted by SLDC) that someone else opens in their own Writer.
* **Merge a copy back**: three-way merge (SLDC's ``merge_packages``) of an edited copy against the nearest revision both sides share.
  Anything changed on both sides is reported as a conflict and never resolved silently.
* **Comments**: SLDC review threads travel inside the file.
"""
from __future__ import annotations

from typing import Any

from ..tools.errors import BadRequest, DependencyMissing
from .session import DocumentSession, load_bytes, sldc

WORKSPACE_REASON = ("Shared workspaces and live co-editing need a Writer workspace server, which this installation does not include or "
                    "connect to. Nothing is simulated.")


class WorkspaceService:
    def __init__(self, data_dir: Any) -> None:
        self.data_dir = data_dir

    def status(self) -> dict[str, Any]:
        return {"available": False, "reason": WORKSPACE_REASON,
                "offline": {"shareCopy": True, "mergeCopy": True, "comments": True},
                "needs": "A workspace server with accounts and server-enforced permissions (see docs/OPERATIONS.md, optional services)."}

    def require(self) -> None:
        raise DependencyMissing(WORKSPACE_REASON, hint="You can still share a copy of the document and merge an edited copy back.")

    def common_base(self, session: DocumentSession, theirs: Any) -> Any:
        """The nearest revision both copies descend from, taken from this document's saved versions."""
        theirs_ids = {r["id"] for r in theirs.document.get("history", [])} | {sldc().revision_id(theirs)}
        ours_ids = {r["id"] for r in session.pkg.document.get("history", [])}
        candidates = []
        for row in session.store.snapshots(session.doc_id):
            rid = row.get("revision_id")
            if rid and rid in theirs_ids and (rid in ours_ids or rid == sldc().revision_id(session.pkg)):
                candidates.append(row)
        candidates.sort(key=lambda r: r.get("revision_no") or 0, reverse=True)
        for row in candidates:
            try:
                return load_bytes(session.store.snapshot_bytes(row["id"]), session.password)
            except Exception:  # noqa: BLE001
                continue
        base = getattr(session, "base", None)
        if base is not None and sldc().revision_id(base) in theirs_ids:
            return base
        return None

    def merge_copy(self, session: DocumentSession, data: bytes, *, password: str | None, author: str | None, accept_conflicts: bool) -> dict[str, Any]:
        theirs = load_bytes(data, password)
        if theirs.document.get("id") != session.doc_id:
            raise BadRequest("That copy is a different document, so it cannot be merged into this one.",
                             hint="Open it on its own, or copy the parts you need.")
        base = self.common_base(session, theirs)
        if base is None:
            raise BadRequest("Writer cannot find a revision that both copies share, so it cannot tell who changed what.",
                             hint="Copies merge only if they come from versions saved on this computer. Open the copy separately and copy the parts you want.")
        return session.merge_with(theirs, base, author=author, accept_conflicts=accept_conflicts, label="a shared copy")
