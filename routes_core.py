"""Application-level routes: start-up data, preferences, Home (library, folders, favourites, recovery), the file chooser, templates, cursors."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest
from ..tools.server import Request, Response, created, ok
from . import picker, templates
from .app import BUILTIN_CURSORS, CURSOR_KINDS, PREF_DEFAULTS
from .routing import clean_path, flag, router, text, who


@router.route("GET", "/api/bootstrap")
def bootstrap(app, req: Request):
    return app.bootstrap(req)


@router.route("GET", "/api/prefs")
def prefs_get(app, req: Request):
    return app.preferences()


@router.route("PUT", "/api/prefs")
def prefs_put(app, req: Request):
    app.prefs.update(req.json())
    return app.preferences()


# --------------------------------------------------------------------------------------------------------- home
@router.route("GET", "/api/home")
def home(app, req: Request):
    profile, _, _ = who(app, req)
    return app.library_view.home(profile, req.str_query("q", max_len=200))


@router.route("POST", "/api/library/folders")
def folder_add(app, req: Request):
    body = req.json()
    folder = app.store.add_folder(clean_path(body.get("path"), what="folder"), text(body, "name", required=False, max_len=60) or None)
    return created(folder)


@router.route("DELETE", "/api/library/folders/{id}")
def folder_remove(app, req: Request):
    app.store.remove_folder(req.params["id"])
    return {"removed": True}


@router.route("GET", "/api/library/folders/{id}/documents")
def folder_documents(app, req: Request):
    return {"documents": app.library_view.scan(req.params["id"])}


@router.route("POST", "/api/library/favorite")
def favorite(app, req: Request):
    body = req.json()
    app.store.set_favorite(str(clean_path(body.get("path"), what="document")), flag(body, "value", True))
    return {"favorite": flag(body, "value", True)}


@router.route("POST", "/api/library/forget")
def forget(app, req: Request):
    """Remove a document from Recent. The file itself is never touched."""
    app.store.forget_recent(str(clean_path(req.json().get("path"), what="document")))
    return {"forgotten": True}


@router.route("POST", "/api/library/locate")
def locate(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    return app.library_view.locate(str(clean_path(body.get("path"), what="document")), clean_path(body.get("newPath"), what="new location"), profile)


# ----------------------------------------------------------------------------------------------------- recovery
@router.route("GET", "/api/recovery")
def recovery_list(app, req: Request):
    return {"recovery": app.library_view.recoveries()}


@router.route("POST", "/api/recovery/{id}/open")
def recovery_open(app, req: Request):
    profile, _, _ = who(app, req)
    body = req.json()
    session = app.library_view.open_recovery(req.params["id"], profile, text(body, "password", required=False, max_len=500) or None)
    return created(session.state())


@router.route("DELETE", "/api/recovery/{id}")
def recovery_discard(app, req: Request):
    app.library_view.discard_recovery(req.params["id"])
    return {"discarded": True}


# ------------------------------------------------------------------------------------------- files and folders
@router.route("GET", "/api/fs/browse")
def browse(app, req: Request):
    return app.library_view.browse(req.str_query("path", max_len=1024) or None, files=req.str_query("files") == "1")


@router.route("POST", "/api/fs/pick")
def pick(app, req: Request):
    """Show the operating system's file dialog. Where none can be shown the answer says so and the page uses its own chooser."""
    body = req.json()
    kind = text(body, "kind", max_len=10)
    if kind not in picker.KINDS:
        raise BadRequest("Choose open, folder or save.")
    types = [(str(a)[:40], str(b)[:40]) for a, b in (body.get("types") or [])[:10]]
    start = text(body, "start", required=False, max_len=1024) or app.preferences().get("last_folder") or str(app.library)
    path = picker.pick(kind, start=start, name=text(body, "name", required=False, max_len=200), types=types)
    if path is not None:
        app.prefs.update({"last_folder": str(path if kind == "folder" else path.parent)})
    return {"path": str(path) if path else None}


# ------------------------------------------------------------------------------------------------- templates
@router.route("GET", "/api/templates")
def template_list(app, req: Request):
    _, _, plan = who(app, req)
    return {"templates": templates.catalog(plan, app.plans.enforcing), "pageSizes": list(templates.PAGE_SIZES),
            "orientations": list(templates.ORIENTATIONS), "plan": plan, "library": str(app.library),
            "folders": app.store.folders(), "defaults": {k: app.preferences()[k] for k in ("page_size", "orientation", "language")}}


# --------------------------------------------------------------------------------------------------- cursors
@router.route("GET", "/api/cursors")
def cursor_list(app, req: Request):
    return {"custom": app.cursors.listing(), "builtin": list(BUILTIN_CURSORS),
            "kinds": list(CURSOR_KINDS)}


@router.route("POST", "/api/cursors")
def cursor_add(app, req: Request):
    """Import a pointer picture. The PNG is sent as the raw request body; ``label``, ``x`` and ``y`` (hot spot) are in the query."""
    data = req.bytes(300 * 1024)
    hotspot = (req.int_query("x", 0, 0, 127), req.int_query("y", 0, 0, 127))
    return created(app.cursors.add(data, req.str_query("label", "Cursor", 40), hotspot))


@router.route("GET", "/api/cursors/{id}.png")
def cursor_image(app, req: Request):
    return Response(200, app.cursors.png(req.params["id"]), "image/png", {"Cache-Control": "private, max-age=3600"})


@router.route("DELETE", "/api/cursors/{id}")
def cursor_delete(app, req: Request):
    cid = req.params["id"]
    app.cursors.delete(cid)
    reset = {key: PREF_DEFAULTS[key] for key, value in app.preferences().items() if key.startswith("cursor_") and value == f"custom:{cid}"}
    if reset:
        app.prefs.update(reset)
    return {"deleted": True, "preferences": app.preferences()}
