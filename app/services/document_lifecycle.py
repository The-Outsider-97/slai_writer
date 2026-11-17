"""Document creation and Save As use cases, composing the existing SLDC, session and library services.

HTTP validation belongs to ``api.routing``; this module owns the cross-service
workflow and its cleanup on failure. It never reimplements SLDC serialization.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ....tools.errors import BadRequest, Conflict, Forbidden
from ... import session as S, templates


def _ensure_folder(directory: Path) -> None:
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BadRequest(f"That folder cannot be used: {exc.strerror or exc}", hint="Choose another folder.") from exc


def create_document(app: Any, *, name: str, template_id: str, directory: Path | None,
                    suggested_name: bool, page_size: str | None, orientation: str | None,
                    language: str | None, accessible_headings: bool,
                    profile: str, account: dict[str, Any] | None, plan: str) -> dict[str, Any]:
    """Create and persist a document, releasing its session if the first save fails."""
    prefs = app.preferences()
    stem = templates.document_stem(name)
    chosen = templates.template(template_id)
    if not templates.allowed_for(chosen, plan, app.plans.enforcing):
        raise Forbidden(
            f"The {chosen.name} template is part of the {app.plans.get(chosen.min_plan).get('name', chosen.min_plan)} plan.",
            details={"requires": chosen.min_plan},
            hint="Blank, Letter and Meeting notes are always available.",
        )
    folder = directory if directory is not None else app.library_view.ensure_library()
    _ensure_folder(folder)
    target = folder / f"{stem}.sldc"
    if suggested_name and target.exists():
        target = app.library_view.unique(target)
        stem = target.stem
    if target.exists():
        raise Conflict(f"A document named {target.name} already exists in that folder.",
                       hint="Choose another name or folder. Nothing was overwritten.")
    package = templates.build(S.sldc(), template_id, title=stem,
                              page_size=page_size or prefs["page_size"],
                              orientation=orientation or prefs["orientation"],
                              language=language or prefs["language"],
                              accessible_headings=accessible_headings,
                              author=account["username"] if account else None)
    session = S.DocumentSession(app.store, package, path=None, profile=profile)
    app.sessions.add(session)
    try:
        session.save_as(target)
    except Exception:
        app.sessions.close(session.sid)
        raise
    app.prefs.update({"last_folder": str(folder)})
    return session.state()


def save_document_as(app: Any, session: S.DocumentSession, *, name: str,
                     directory: Path | None, new_identity: bool, overwrite: bool) -> dict[str, Any]:
    """Save a document as a named SLDC file and remember the selected folder."""
    stem = templates.document_stem(name)
    folder = directory if directory is not None else (session.path.parent if session.path else app.library_view.ensure_library())
    _ensure_folder(folder)
    result = session.save_as(folder / f"{stem}.sldc", new_identity=new_identity, overwrite=overwrite)
    app.prefs.update({"last_folder": str(folder)})
    return {**result, "summary": session.summary()}


def open_saved_version(app: Any, session: S.DocumentSession, version_id: str) -> dict[str, Any]:
    """Open an immutable snapshot as another, read-only session without restoring it."""
    row = app.store.snapshot(version_id)
    if row["doc_id"] != session.doc_id:
        raise BadRequest("That version belongs to a different document.")
    package = S.load_bytes(app.store.snapshot_bytes(version_id), session.password)
    view = S.DocumentSession(
        app.store, package, path=None, profile=session.profile, password=session.password,
        readonly_reason="This is a saved version, shown read-only. Use Restore to bring it back as a new revision.",
        origin={"kind": "snapshot", "id": version_id},
    )
    app.sessions.add(view)
    return view.state()
