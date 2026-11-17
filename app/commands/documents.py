"""Document history navigation coordinated through the authoritative session transaction lock."""
from __future__ import annotations

from typing import Any, Literal

from ....tools.errors import Conflict
from ...session import DocumentSession


def travel_history(session: DocumentSession, *, direction: Literal["undo", "redo"],
                   count: int, base: int | None) -> dict[str, Any]:
    """Apply bounded history travel with a single initial version check.

    Locking prevents another request from editing between successive steps.
    The session retains responsibility for the undo log and version updates.
    """
    if direction not in ("undo", "redo"):
        raise ValueError("Unknown history direction")
    if not 1 <= count <= 200:
        raise ValueError("History count must be between 1 and 200")
    travel = session.undo if direction == "undo" else session.redo
    with session.lock:
        if count == 1:
            return {"patch": travel(base)}
        session._require_editable()  # noqa: SLF001 - permission enforcement before a batch
        session._check_base(base)  # noqa: SLF001 - reject stale requests before any mutation
        source = session.undo_stack if direction == "undo" else session.redo_stack
        for _ in range(min(count, len(source))):
            travel(None)
        return {"state": session.state()}


def close_document(app: Any, session: DocumentSession, *, discard: bool) -> dict[str, bool]:
    """Enforce the unsaved-work decision before removing an open document session."""
    with session.lock:
        if session.dirty and not discard:
            raise Conflict("This document has changes that are not saved.",
                           details={"kind": "unsaved", "title": session.title},
                           hint="Save it, or close it and discard the changes.")
        if discard:
            session.discard_recovery()
        app.sessions.close(session.sid)
    return {"closed": True}
