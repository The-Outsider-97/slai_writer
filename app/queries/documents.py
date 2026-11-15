"""Lock-consistent document history views used by the HTTP API."""
from __future__ import annotations

from typing import Any

from ...session import DocumentSession


def history_stack(session: DocumentSession, *, limit: int = 60) -> dict[str, list[str]]:
    """Read the two undo menus from one document version under its session lock."""
    with session.lock:
        return {"undo": [entry.undo.label for entry in reversed(session.undo_stack)][:limit],
                "redo": [entry.undo.label for entry in reversed(session.redo_stack)][:limit]}
