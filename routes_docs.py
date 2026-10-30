"""Document routes: create, open, edit (operations), undo/redo, save, rename, versions, comments, notes, pictures, search.

Editing is server-authoritative: the page sends operations tagged with the document version it last saw, and a stale version is a
409 Conflict (``details.kind == "stale_version"``) rather than a silent overwrite. See ``session.py`` and ``ops.py``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, Conflict, Forbidden, NotFound
from ..tools.server import Request, Response, created, ok
from . import session as S
from . import templates
from .routing import base_version, clean_path, flag, need_account, router, session_of, text, whole, who

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def author_of(app: Any, req: Request) -> str:
    _, account = app.profile_of(req)
    return account["username"] if account else "Guest"


# ---------------------------------------------------------------------------------------------------- creating
@router.route("POST", "/api/docs/new")
def doc_new(app, req: Request):
    body = req.json()
    profile, account, plan = who(app, req)
    prefs = app.preferences()
    stem = templates.document_stem(text(body, "name", max_len=200))
    template_id = text(body, "template", required=False, max_len=40, default="blank") or "blank"
    chosen = templates.template(template_id)
    if not templates.allowed_for(chosen, plan, app.plans.enforcing):
        raise Forbidden(f"The {chosen.name} template is part of the {app.plans.get(chosen.min_plan).get('name', chosen.min_plan)} plan.",
                        details={"requires": chosen.min_plan}, hint="Blank, Letter and Meeting notes are always available.")
    directory = clean_path(body["directory"], what="folder") if body.get("directory") else app.library_view.ensure_library()
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BadRequest(f"That folder cannot be used: {exc.strerror or exc}", hint="Choose another folder.") from exc
    target = directory / f"{stem}.sldc"
    if flag(body, "suggestedName", False) and target.exists():
        # The person did not choose this name (it is the suggestion Writer offered), so a free variant is used rather than an error.
        target = app.library_view.unique(target)
        stem = target.stem
    if target.exists():
        raise Conflict(f"A document named {target.name} already exists in that folder.", hint="Choose another name or folder. Nothing was overwritten.")
    package = templates.build(S.sldc(), template_id, title=stem, page_size=text(body, "pageSize", required=False, max_len=10) or prefs["page_size"],
                              orientation=text(body, "orientation", required=False, max_len=10) or prefs["orientation"],
                              language=text(body, "language", required=False, max_len=12) or prefs["language"],
                              accessible_headings=flag(body, "accessibleHeadings", True), author=account["username"] if account else None)
    session = S.DocumentSession(app.store, package, path=None, profile=profile)
    app.sessions.add(session)
    try:
        session.save_as(target)
    except Exception:
        app.sessions.close(session.sid)
        raise
    app.prefs.update({"last_folder": str(directory)})
    return created(session.state())


# ----------------------------------------------------------------------------------------------------- opening
@router.route("POST", "/api/docs/open")
def doc_open(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    session, already = app.library_view.open_path(clean_path(body.get("path"), what="document"), profile,
                                                  text(body, "password", required=False, max_len=500) or None)
    return created({**session.state(), "alreadyOpen": already}) if not already else ok({**session.state(), "alreadyOpen": True})


@router.route("GET", "/api/docs")
def doc_list(app, req: Request):
    return {"open": app.sessions.listing()}


@router.route("GET", "/api/docs/{sid}")
def doc_state(app, req: Request):
    return session_of(app, req).state()


@router.route("POST", "/api/docs/{sid}/close")
def doc_close(app, req: Request):
    session = session_of(app, req)
    discard = flag(req.json(), "discard")
    if session.dirty and not discard:
        raise Conflict("This document has changes that are not saved.", details={"kind": "unsaved", "title": session.title},
                       hint="Save it, or close it and discard the changes.")
    if discard:
        session.discard_recovery()
    app.sessions.close(session.sid)
    return {"closed": True}


@router.route("POST", "/api/docs/{sid}/identity")
def doc_identity(app, req: Request):
    """Re-evaluate who is looking at this document after signing in (this is what 'Verify identity' on a locked EMBED does)."""
    session = session_of(app, req)
    profile, _, _ = who(app, req)
    session.profile = profile
    return {"role": session.role(), "state": session.state()}


# ------------------------------------------------------------------------------------------------------ editing
@router.route("POST", "/api/docs/{sid}/ops")
def doc_ops(app, req: Request):
    body = req.json()
    op = body.get("op")
    if not isinstance(op, dict) or not isinstance(op.get("op"), str):
        raise BadRequest("Send one operation as {op: {op: name, ...}, base: version}.")
    return session_of(app, req).apply(op, base_version(body))


@router.route("POST", "/api/docs/{sid}/undo")
def doc_undo(app, req: Request):
    body = req.json()
    session = session_of(app, req)
    count = whole(body, "count", low=1, high=200, default=1)
    base = base_version(body)
    if count == 1:
        return {"patch": session.undo(base)}
    for _ in range(count):
        if not session.undo_stack:
            break
        session.undo(None)
    return {"state": session.state()}


@router.route("POST", "/api/docs/{sid}/redo")
def doc_redo(app, req: Request):
    body = req.json()
    session = session_of(app, req)
    count = whole(body, "count", low=1, high=200, default=1)
    base = base_version(body)
    if count == 1:
        return {"patch": session.redo(base)}
    for _ in range(count):
        if not session.redo_stack:
            break
        session.redo(None)
    return {"state": session.state()}


@router.route("GET", "/api/docs/{sid}/history-stack")
def doc_stack(app, req: Request):
    """Labels for the undo and redo drop-downs, nearest first."""
    session = session_of(app, req)
    with session.lock:
        return {"undo": [e.undo.label for e in reversed(session.undo_stack)][:60], "redo": [e.undo.label for e in reversed(session.redo_stack)][:60]}


# -------------------------------------------------------------------------------------------------------- saving
@router.route("POST", "/api/docs/{sid}/save")
def doc_save(app, req: Request):
    session = session_of(app, req)
    result = session.save(force=flag(req.json(), "force"))
    return {**result, "summary": session.summary()}


@router.route("POST", "/api/docs/{sid}/save-as")
def doc_save_as(app, req: Request):
    body = req.json()
    session = session_of(app, req)
    stem = templates.document_stem(text(body, "name", max_len=200))
    directory = clean_path(body["directory"], what="folder") if body.get("directory") else (session.path.parent if session.path else app.library_view.ensure_library())
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise BadRequest(f"That folder cannot be used: {exc.strerror or exc}") from exc
    result = session.save_as(directory / f"{stem}.sldc", new_identity=flag(body, "newCopy"), overwrite=flag(body, "overwrite"))
    app.prefs.update({"last_folder": str(directory)})
    return {**result, "summary": session.summary()}


@router.route("POST", "/api/docs/{sid}/rename")
def doc_rename(app, req: Request):
    session = session_of(app, req)
    return session.rename(templates.document_stem(text(req.json(), "name", max_len=200)))


@router.route("POST", "/api/docs/{sid}/autosave")
def doc_autosave(app, req: Request):
    """Right-click on Save: autosave on or off for this document, and how often (a preference for all documents)."""
    body = req.json()
    session = session_of(app, req)
    if "enabled" in body:
        session.autosave = flag(body, "enabled")
    seconds = whole(body, "seconds", low=10, high=3600)
    if seconds is not None:
        app.prefs.update({"autosave_seconds": seconds})
    prefs = app.preferences()
    return {"enabled": prefs["autosave"] if session.autosave is None else session.autosave, "seconds": prefs["autosave_seconds"]}


@router.route("POST", "/api/docs/{sid}/external")
def doc_external(app, req: Request):
    """The file changed on disk while there were unsaved edits: merge, keep both, overwrite, or reload."""
    body = req.json()
    session = session_of(app, req)
    return session.resolve_external(text(body, "action", max_len=20), author=author_of(app, req), accept_conflicts=flag(body, "acceptConflicts"))


@router.route("GET", "/api/docs/{sid}/external")
def doc_external_status(app, req: Request):
    session = session_of(app, req)
    return {"changed": session.external_change(), "path": str(session.path) if session.path else None}


# ------------------------------------------------------------------------------------------------------ versions
def _version(row: dict[str, Any]) -> dict[str, Any]:
    return {"id": row["id"], "created": row["created"], "kind": row["kind"], "label": row["label"], "revision": row["revision_no"],
            "bytes": row["bytes"], "words": row["words"], "signed": bool(row["signed"]), "encrypted": bool(row["encrypted"])}


@router.route("GET", "/api/docs/{sid}/versions")
def versions(app, req: Request):
    session = session_of(app, req)
    return {"versions": [_version(r) for r in app.store.snapshots(session.doc_id)], "current": session.revision_info()}


@router.route("POST", "/api/docs/{sid}/versions")
def version_create(app, req: Request):
    session = session_of(app, req)
    body = req.json()
    result = session.create_version(text(body, "label", required=False, max_len=120), author_of(app, req))
    return created({"snapshot": _version(result["snapshot"]) if result["snapshot"] else None, "revision": result["revision"],
                    "version": result["version"]})


@router.route("POST", "/api/docs/{sid}/versions/{vid}/restore")
def version_restore(app, req: Request):
    return session_of(app, req).restore_snapshot(req.params["vid"], author_of(app, req))


@router.route("POST", "/api/docs/{sid}/versions/{vid}/open")
def version_open(app, req: Request):
    """Open an old version as a separate, read-only document (to look at it or copy from it). Nothing is restored."""
    session = session_of(app, req)
    row = app.store.snapshot(req.params["vid"])
    if row["doc_id"] != session.doc_id:
        raise BadRequest("That version belongs to a different document.")
    package = S.load_bytes(app.store.snapshot_bytes(req.params["vid"]), session.password)
    view = S.DocumentSession(app.store, package, path=None, profile=session.profile, password=session.password,
                             readonly_reason="This is a saved version, shown read-only. Use Restore to bring it back as a new revision.",
                             origin={"kind": "snapshot", "id": req.params["vid"]})
    app.sessions.add(view)
    return created(view.state())


# ----------------------------------------------------------------------------------------------------- comments
@router.route("POST", "/api/docs/{sid}/comments")
def comment_add(app, req: Request):
    body = req.json()
    return session_of(app, req).add_comment(text(body, "block", max_len=100), text(body, "text", max_len=4000), author_of(app, req),
                                            whole(body, "start", low=0, high=10**7), whole(body, "end", low=0, high=10**7))


@router.route("POST", "/api/docs/{sid}/comments/{tid}/reply")
def comment_reply(app, req: Request):
    return session_of(app, req).reply_comment(req.params["tid"], text(req.json(), "text", max_len=4000), author_of(app, req))


@router.route("POST", "/api/docs/{sid}/comments/{tid}/status")
def comment_status(app, req: Request):
    return session_of(app, req).set_comment_status(req.params["tid"], text(req.json(), "status", max_len=20), author_of(app, req))


# --------------------------------------------------------------------------------------------------------- notes
@router.route("GET", "/api/docs/{sid}/notes")
def notes(app, req: Request):
    return {"notes": app.store.notes(session_of(app, req).doc_id),
            "scope": "Notes stay on this computer. They are not part of the document file and are not shared when you send it."}


@router.route("POST", "/api/docs/{sid}/notes")
def note_put(app, req: Request):
    body = req.json()
    session = session_of(app, req)
    block = text(body, "block", required=False, max_len=100) or None
    if block and not any(b["id"] == block for b in session.doc["blocks"]):
        raise NotFound("That paragraph no longer exists.")
    return created(app.store.put_note(session.doc_id, note_id=text(body, "id", required=False, max_len=64) or None, block_id=block,
                                      start=whole(body, "start", low=0, high=10**7), end=whole(body, "end", low=0, high=10**7),
                                      anchor_text=text(body, "anchorText", required=False, max_len=300), body=text(body, "body", required=False, max_len=8000)))


@router.route("DELETE", "/api/docs/{sid}/notes/{nid}")
def note_delete(app, req: Request):
    app.store.delete_note(session_of(app, req).doc_id, req.params["nid"])
    return {"deleted": True}


# --------------------------------------------------------------------------------------------------- pictures
@router.route("POST", "/api/docs/{sid}/images")
def image_add(app, req: Request):
    """Insert a picture as a figure. The picture is the raw request body; its description (alt text) is required unless it is decorative."""
    session = session_of(app, req)
    session._require_editable()                                               # noqa: SLF001
    alt, decorative = req.str_query("alt", max_len=500).strip(), req.str_query("decorative") == "1"
    if not alt and not decorative:
        raise BadRequest("Describe the picture for people who cannot see it, or mark it as decorative.",
                         hint="Alt text is part of an accessible document.")
    kind = req.headers.get("content-type", "").split(";")[0].strip().lower()
    if kind not in IMAGE_TYPES:
        raise BadRequest("Use a PNG, JPEG, GIF or WebP picture.")
    asset = session.add_image(req.bytes(app.settings.max_upload_bytes))
    figure: dict[str, Any] = {"asset": asset.id, "alt": "" if decorative else alt, "width_mm": float(req.int_query("width", 120, 10, 400))}
    if decorative:
        figure["decorative"] = True
    after = req.str_query("after", max_len=100) or None
    patch = session.apply({"op": "block_insert", "after": after, "block": {"type": "figure", "text": req.str_query("caption", max_len=500), "figure": figure}},
                          None)
    return created({"patch": patch, "asset": asset.id, "assets": [{"id": a.id, "mediaType": a.media_type, "bytes": len(a.data)} for a in session.pkg.assets.values()]})


@router.route("GET", "/api/docs/{sid}/assets/{aid}")
def asset_get(app, req: Request):
    session = session_of(app, req)
    asset = session.pkg.assets.get(req.params["aid"])
    if asset is None:
        raise NotFound("That picture is not in this document.")
    return Response(200, bytes(asset.data), asset.media_type, {"Cache-Control": "private, max-age=3600"})


# --------------------------------------------------------------------------------------------------- search
@router.route("GET", "/api/docs/{sid}/search")
def doc_search(app, req: Request):
    session = session_of(app, req)
    found = session.search(req.str_query("q", max_len=200), case=req.str_query("case") == "1", whole=req.str_query("whole") == "1")
    return {"matches": found, "count": len(found), "truncated": len(found) >= 2000}


@router.route("POST", "/api/docs/{sid}/replace")
def doc_replace(app, req: Request):
    """Replace one found match (the page sends the match it was shown, so a stale search cannot change other text)."""
    body = req.json()
    session = session_of(app, req)
    where = text(body, "where", max_len=30, default="text") or "text"
    expect = text(body, "expect", max_len=200)
    start, end = whole(body, "start", low=0, high=10**7, required=True), whole(body, "end", low=0, high=10**7, required=True)
    if where != "text":
        raise BadRequest("Replacing inside table cells is done in the table.")
    op = {"op": "text", "block": text(body, "block", max_len=100), "start": start, "end": end, "insert": text(body, "with", required=False, max_len=2000),
          "expect": expect}
    return session.apply(op, base_version(body))


@router.route("GET", "/api/docs/{sid}/outline")
def doc_outline(app, req: Request):
    return {"outline": session_of(app, req).outline()}
