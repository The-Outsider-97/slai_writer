"""Tool routes: signing and signature pictures, verification, EMBED components, spelling/grammar/AI assistance, sources and citations,
export / import / print, and the (honestly unavailable) shared workspace.

Each handler checks its input and calls the service that owns the behaviour; nothing here decides whether a signature is valid, a
source is real or an AI edit is applied - those rules are in ``signing.py``, ``academic.py`` and ``assist.py``.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, Conflict, NotFound
from ..tools.server import Request, created, file_response
from . import session as S
from .routes_docs import author_of
from .routing import base_version, clean_path, flag, need_account, router, session_of, text, whole, who

DOWNLOAD_TYPES = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  "odt": "application/vnd.oasis.opendocument.text", "rtf": "application/rtf", "html": "text/html; charset=utf-8",
                  "md": "text/markdown; charset=utf-8", "txt": "text/plain; charset=utf-8", "sldc": "application/octet-stream"}


# ======================================================================================================== signing
@router.route("GET", "/api/signing/key")
def sign_key(app, req: Request):
    profile, _, _ = who(app, req)
    return {**app.signing.key_info(profile), "available": app.signing.available()}


@router.route("POST", "/api/signing/key")
def sign_key_create(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    return created(app.signing.create_key(profile, text(body, "label", max_len=80, required=False, default="My signing key"),
                                          text(body, "passphrase", max_len=500)))


@router.route("POST", "/api/signing/key/delete")
def sign_key_delete(app, req: Request):
    profile, _, _ = who(app, req)
    app.signing.delete_key(profile, text(req.json(), "passphrase", max_len=500))
    return {"deleted": True}


@router.route("GET", "/api/docs/{sid}/sign")
def sign_preview(app, req: Request):
    return app.signing.preview(session_of(app, req))


@router.route("POST", "/api/docs/{sid}/sign")
def sign_do(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    return app.signing.sign(session_of(app, req), profile, text(body, "passphrase", max_len=500), text(body, "purpose", max_len=40),
                            text(body, "statement", required=False, max_len=500) or None, text(body, "expectedRevision", required=False, max_len=100) or None)


@router.route("GET", "/api/docs/{sid}/verify")
def verify(app, req: Request):
    return app.signing.verify(session_of(app, req))


@router.route("GET", "/api/docs/{sid}/compare/{snapshot}")
def compare(app, req: Request):
    return app.signing.compare(session_of(app, req), req.params["snapshot"])


@router.route("POST", "/api/docs/{sid}/trust")
def trust(app, req: Request):
    body = req.json()
    return app.signing.trust_from_document(session_of(app, req), text(body, "signature", max_len=100), text(body, "label", required=False, max_len=80))


@router.route("POST", "/api/signing/revoke")
def revoke(app, req: Request):
    app.signing.revoke(text(req.json(), "keyId", max_len=100))
    return {"revoked": True}


@router.route("GET", "/api/signing/marks")
def marks(app, req: Request):
    profile, _, _ = who(app, req)
    return app.signing.marks(profile)


@router.route("POST", "/api/signing/marks")
def mark_add(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    return created(app.signing.add_mark(profile, text(body, "image", max_len=4_000_000), kind=text(body, "kind", max_len=10),
                                        label=text(body, "label", required=False, max_len=60), group=whole(body, "group", low=1, high=10)))


@router.route("DELETE", "/api/signing/marks/{id}")
def mark_delete(app, req: Request):
    profile, _, _ = who(app, req)
    app.signing.delete_mark(profile, req.params["id"])
    return {"deleted": True}


@router.route("POST", "/api/docs/{sid}/signature-graphic")
def mark_place(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    return app.signing.place(session_of(app, req), profile, text(body, "mark", max_len=64), text(body, "after", required=False, max_len=100) or None,
                             float(body.get("widthMm", 45.0)) if isinstance(body.get("widthMm", 45.0), (int, float)) else 45.0)


# ========================================================================================================= EMBED
@router.route("GET", "/api/embeds/catalogue")
def embed_catalogue(app, req: Request):
    _, _, plan = who(app, req)
    return app.embeds.catalogue(plan)


@router.route("GET", "/api/docs/{sid}/embeds")
def embeds_list(app, req: Request):
    session = session_of(app, req)
    return {"locks": {k: {"label": v.get("label"), "summary": v.get("summary")} for k, v in app.embeds.locks(session).items()},
            "stale": app.embeds.stale(session), "role": session.role()}


@router.route("GET", "/api/docs/{sid}/embeds/{eid}")
def embed_view(app, req: Request):
    return app.embeds.view(session_of(app, req), req.params["eid"])


@router.route("POST", "/api/docs/{sid}/embeds/validate")
def embed_validate(app, req: Request):
    return app.embeds.validate(session_of(app, req), _declaration(req.json()))


@router.route("POST", "/api/docs/{sid}/embeds/preview")
def embed_preview(app, req: Request):
    body = req.json()
    return app.embeds.preview(session_of(app, req), _declaration(body), text(body, "embed", required=False, max_len=64) or None)


@router.route("POST", "/api/docs/{sid}/embeds/apply")
def embed_apply(app, req: Request):
    body = req.json()
    _, _, plan = who(app, req)
    return app.embeds.apply(session_of(app, req), _declaration(body), after=text(body, "after", required=False, max_len=100) or None,
                            embed_id=text(body, "embed", required=False, max_len=64) or None, base=base_version(body), plan=plan)


@router.route("POST", "/api/docs/{sid}/embeds/{eid}/lock")
def embed_lock(app, req: Request):
    body = req.json()
    return app.embeds.lock(session_of(app, req), req.params["eid"], text(body, "label", required=False, max_len=80), text(body, "summary", required=False, max_len=500))


@router.route("DELETE", "/api/docs/{sid}/embeds/{eid}/lock")
def embed_unlock(app, req: Request):
    return app.embeds.unlock(session_of(app, req), req.params["eid"])


@router.route("POST", "/api/docs/{sid}/embeds/{eid}/request-access")
def embed_request(app, req: Request):
    app.embeds.request_access(session_of(app, req))
    return {}


def _declaration(body: dict[str, Any]) -> dict[str, Any]:
    decl = body.get("declaration")
    if not isinstance(decl, dict):
        raise BadRequest("Send the component as {declaration: {...}}.")
    return decl


# ========================================================================================== spelling and grammar
@router.route("GET", "/api/assist/status")
def assist_status(app, req: Request):
    return app.assist.status()


@router.route("POST", "/api/docs/{sid}/spell")
def spell(app, req: Request):
    blocks = req.json().get("blocks")
    return app.assist.spelling(session_of(app, req), [str(b) for b in blocks][:500] if isinstance(blocks, list) else None)


@router.route("POST", "/api/docs/{sid}/dictionary")
def dictionary(app, req: Request):
    return app.assist.add_to_dictionary(session_of(app, req), text(req.json(), "word", max_len=60))


@router.route("POST", "/api/docs/{sid}/grammar")
def grammar(app, req: Request):
    blocks = req.json().get("blocks")
    return app.assist.grammar(session_of(app, req), [str(b) for b in blocks][:500] if isinstance(blocks, list) else None)


@router.route("POST", "/api/docs/{sid}/assist")
def assist_propose(app, req: Request):
    """Start an AI request. It only ever reads the scope the person chose, returns suggestions, and changes nothing by itself."""
    body = req.json()
    scope = body.get("scope")
    if not isinstance(scope, dict):
        raise BadRequest("Choose what the assistant may read.")
    return created(app.assist.propose(session_of(app, req), scope, text(body, "task", max_len=30), text(body, "instruction", required=False, max_len=600) or None,
                                      text(body, "provider", required=False, max_len=20, default="local") or "local"))


@router.route("GET", "/api/assist/jobs/{id}")
def assist_job(app, req: Request):
    return app.assist.job(req.params["id"])


@router.route("POST", "/api/assist/jobs/{id}/cancel")
def assist_cancel(app, req: Request):
    return app.assist.cancel(req.params["id"])


@router.route("POST", "/api/docs/{sid}/assist/apply")
def assist_apply(app, req: Request):
    body = req.json()
    accept, confirm = body.get("accept"), body.get("confirmAdditions")
    if not isinstance(accept, list):
        raise BadRequest("Choose the changes to accept.")
    return app.assist.apply(session_of(app, req), text(body, "proposal", max_len=64), [str(a) for a in accept][:500],
                            [str(c) for c in confirm][:500] if isinstance(confirm, list) else None)


@router.route("POST", "/api/assist/proposals/{id}/reject")
def assist_reject(app, req: Request):
    hunks = req.json().get("hunks")
    return app.assist.reject(req.params["id"], [str(h) for h in hunks][:500] if isinstance(hunks, list) else [])


# ============================================================================================== sources and citations
@router.route("GET", "/api/docs/{sid}/sources")
def sources(app, req: Request):
    return app.academic.sources(session_of(app, req))


@router.route("POST", "/api/docs/{sid}/sources")
def source_put(app, req: Request):
    body = req.json()
    data = body.get("data")
    if not isinstance(data, dict):
        raise BadRequest("Send the source as {data: {...}}.")
    return created(app.academic.put_source(session_of(app, req), data, text(body, "id", required=False, max_len=64) or None,
                                           text(body, "status", required=False, max_len=12, default="user") or "user"))


@router.route("DELETE", "/api/docs/{sid}/sources/{id}")
def source_delete(app, req: Request):
    return app.academic.delete_source(session_of(app, req), req.params["id"])


@router.route("POST", "/api/docs/{sid}/sources/{id}/checked")
def source_checked(app, req: Request):
    return app.academic.mark_checked(session_of(app, req), req.params["id"], text(req.json(), "note", required=False, max_len=500))


@router.route("POST", "/api/docs/{sid}/sources/{id}/verify-doi")
def source_verify(app, req: Request):
    return app.academic.verify_doi(session_of(app, req), req.params["id"])


@router.route("POST", "/api/docs/{sid}/cite")
def cite(app, req: Request):
    body = req.json()
    return app.academic.cite(session_of(app, req), text(body, "block", max_len=100), whole(body, "at", low=0, high=10**7, required=True),
                             text(body, "source", max_len=64), base=base_version(body))


@router.route("POST", "/api/docs/{sid}/footnote")
def footnote(app, req: Request):
    body = req.json()
    return app.academic.footnote(session_of(app, req), text(body, "block", max_len=100), whole(body, "at", low=0, high=10**7, required=True),
                                 text(body, "text", max_len=20_000), base=base_version(body))


@router.route("POST", "/api/docs/{sid}/bibliography")
def bibliography(app, req: Request):
    body = req.json()
    return app.academic.bibliography(session_of(app, req), only_cited=flag(body, "onlyCited", True), after=text(body, "after", required=False, max_len=100) or None,
                                     heading=text(body, "heading", required=False, max_len=80, default="References") or "References")


@router.route("POST", "/api/docs/{sid}/contents")
def contents(app, req: Request):
    body = req.json()
    return app.academic.contents(session_of(app, req), text(body, "after", required=False, max_len=100) or None,
                                 text(body, "title", required=False, max_len=80, default="Contents") or "Contents", whole(body, "depth", low=1, high=6, default=3) or 3)


@router.route("POST", "/api/docs/{sid}/contents/refresh")
def refresh_contents(app, req: Request):
    body = req.json()
    return app.academic.refresh_contents(session_of(app, req), text(body, "tocId", max_len=24))


@router.route("POST", "/api/docs/{sid}/xref")
def xref(app, req: Request):
    body = req.json()
    return app.academic.cross_reference(session_of(app, req), text(body, "block", max_len=100), whole(body, "start", low=0, high=10**7, required=True),
                                        whole(body, "end", low=0, high=10**7, required=True), text(body, "target", max_len=100))


# ======================================================================================== export, import and print
@router.route("GET", "/api/exchange/formats")
def formats(app, req: Request):
    from .export import available_formats
    return available_formats(app.docmaster)


@router.route("GET", "/api/docs/{sid}/preflight")
def preflight(app, req: Request):
    return app.exchange.preflight(session_of(app, req), req.str_query("target", max_len=10) or None)


def _out_dir(app: Any, session: S.DocumentSession, body: dict[str, Any]) -> Path:
    if body.get("directory"):
        return clean_path(body["directory"], what="folder")
    return session.path.parent if session.path else app.library_view.ensure_library()


@router.route("POST", "/api/docs/{sid}/export")
def export(app, req: Request):
    """Write a copy in another format into a folder on this computer (it never replaces the SLDC original)."""
    body = req.json()
    session = session_of(app, req)
    options = body.get("options")
    return app.exchange.export(session, text(body, "format", max_len=10), _out_dir(app, session, body), stem=text(body, "name", required=False, max_len=120) or None,
                               options=options if isinstance(options, dict) else None, password=text(body, "password", required=False, max_len=500) or None)


@router.route("POST", "/api/docs/{sid}/download")
def download(app, req: Request):
    """The same conversion, handed to the browser as a file download instead of written to a folder."""
    body = req.json()
    session = session_of(app, req)
    fmt = text(body, "format", max_len=10)
    options = body.get("options")
    scratch = Path(tempfile.mkdtemp(prefix="wr-dl-", dir=app.exchange._tmp()))                               # noqa: SLF001
    try:
        report = app.exchange.export(session, fmt, scratch, stem=text(body, "name", required=False, max_len=120) or None,
                                     options=options if isinstance(options, dict) else None, password=text(body, "password", required=False, max_len=500) or None)
        target = Path(report["path"])
        data = target.read_bytes()
        response = file_response(data, target.name, DOWNLOAD_TYPES.get(fmt, "application/octet-stream"))
        response.headers["X-Writer-Report"] = _report_header(report)
        return response
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _report_header(report: dict[str, Any]) -> str:
    import json
    import urllib.parse
    slim = {k: report.get(k) for k in ("format", "bytes", "pages", "lost", "warnings", "sha256")}
    return urllib.parse.quote(json.dumps(slim)[:1800])


@router.route("POST", "/api/docs/{sid}/preview")
def preview(app, req: Request):
    body = req.json()
    pages = body.get("pages")
    wanted = [int(p) for p in pages if isinstance(p, int) and not isinstance(p, bool)][:12] if isinstance(pages, list) else [1]
    return app.exchange.preview(session_of(app, req), wanted or [1], whole(body, "width", low=200, high=1600, default=720) or 720)


@router.route("POST", "/api/import")
def import_upload(app, req: Request):
    """Import an uploaded file (the raw request body). ``name`` is the file's name, only used to help recognise it."""
    profile, _, _ = who(app, req)
    data = req.bytes(app.settings.max_upload_bytes)
    session = app.exchange.import_bytes(data, req.str_query("name", "document", 200), password=req.str_query("password", max_len=500) or None, profile=profile,
                                        ocr=req.str_query("ocr") == "1", as_text=req.str_query("asText") == "1")
    app.sessions.add(session)
    return created({**session.state(), "import": session.origin})


@router.route("POST", "/api/import/path")
def import_path(app, req: Request):
    body = req.json()
    profile, _, _ = who(app, req)
    session = app.exchange.import_path(clean_path(body.get("path"), what="file"), password=text(body, "password", required=False, max_len=500) or None, profile=profile,
                                       ocr=flag(body, "ocr"), as_text=flag(body, "asText"))
    app.sessions.add(session)
    return created({**session.state(), "import": session.origin})


# =================================================================================================== workspace
@router.route("GET", "/api/workspace")
def workspace(app, req: Request):
    return app.workspace.status()


@router.route("POST", "/api/docs/{sid}/workspace/{action}")
def workspace_action(app, req: Request):
    """Sharing live, requesting access and workspace roles need a workspace server. Without one this says so; it never pretends."""
    app.workspace.require()
    return {}


@router.route("POST", "/api/docs/{sid}/merge-copy")
def merge_copy(app, req: Request):
    """Merge an edited copy of this document (an .sldc file, the raw request body) into it. Conflicts are shown, never decided silently."""
    session = session_of(app, req)
    data = req.bytes(app.settings.max_upload_bytes)
    return app.workspace.merge_copy(session, data, password=req.str_query("password", max_len=500) or None, author=author_of(app, req),
                                    accept_conflicts=req.str_query("acceptConflicts") == "1")
