"""Import, export, print preview and preflight. Conversion is Documaster's (readers, writers, verification); this module only adapts it
to Writer's sessions and adds the honest account the person needs: what each format keeps, what it loses, and what to fix first.

* Export writes a *copy*. It never overwrites an existing file (a free name is chosen), the written file is re-opened and its text is
  compared with the document before it is delivered, and a copy that fails verification is discarded, not offered.
* Lossy conversions are listed before and after the export: a fixed list per format plus whatever the writer itself reports it dropped.
* Print preview is rasterised from the real PDF the PDF writer produces (pypdfium2), not from the editor's own layout.
* Import reads through Documaster into the SLDC model and opens the result as an unsaved new document with a conversion report.
"""
from __future__ import annotations

import base64
import copy
import io
import os
import re
import secrets
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from ..tools.errors import BadRequest, DependencyMissing, Forbidden, LimitExceeded, NotFound, Unauthorized
from .session import DocumentSession, load_bytes, sldc

EXPORT_FORMATS = ("sldc", "pdf", "docx", "odt", "rtf", "html", "md", "txt", "xml")
IMPORT_FORMATS = ("sldc", "docx", "doc", "odt", "rtf", "html", "md", "txt", "xml", "csv", "pdf")
LABELS = {"sldc": "SLDC (Writer's own format)", "pdf": "PDF", "docx": "Word (DOCX)", "odt": "OpenDocument Text (ODT)", "rtf": "Rich Text (RTF)",
          "html": "HTML", "md": "Markdown", "txt": "Plain text", "xml": "XML", "doc": "Word 97-2003 (DOC)", "csv": "CSV", }
COMMON_LOSS = ("Review comments, revision history and signatures are not carried into this format.",
               "EMBED components appear only as their last valid output, never as active content.")
LOSSY = {
    "sldc": [],
    "pdf": ["A PDF is a fixed layout: it cannot be edited as a Writer document and does not reflow.", *COMMON_LOSS,
            "Heading structure is not tagged for screen readers by the PDF writer; keep the SLDC original for accessible use."],
    "docx": ["Paragraph and character styles become the nearest Word styles; fonts follow what the other computer has.", *COMMON_LOSS],
    "odt": ["Paragraph and character styles become the nearest OpenDocument styles; fonts follow what the other computer has.", *COMMON_LOSS],
    "rtf": ["RTF carries only basic formatting; tables and figures may be simplified.", *COMMON_LOSS],
    "html": ["Exact page breaks, margins, headers and footers are not represented; the page flows to the reader's window.", *COMMON_LOSS],
    "md": ["Markdown has no colours, fonts, margins, columns or headers and footers; tables become simple tables.", *COMMON_LOSS],
    "txt": ["All formatting, figures and tables layout are dropped; only the text remains.", *COMMON_LOSS],
    "xml": ["XML is a structural dump of the text, not a layout.", *COMMON_LOSS],
}
IMPORT_LOSS = {
    "pdf": "Text was read from the PDF. Page layout, fonts, columns and figures are not reconstructed, and scanned pages need OCR (not applied unless you ask).",
    "docx": "Text, headings, lists and tables were read. Page layout, fonts and anything the converter does not model are not carried over.",
    "doc": "The old Word format was converted with LibreOffice first (when installed); layout and fonts are not carried over.",
    "odt": "Text, headings, lists and tables were read. Page layout and fonts are not carried over.",
    "rtf": "Basic text and formatting were read through LibreOffice (when installed); layout is not carried over.",
    "html": "Text and structure were read; scripts, styles from the web page and layout are ignored.",
    "md": "Markdown structure was read; formatting that Markdown cannot express is simply absent.",
    "txt": "Plain text has no structure; every line break may start a paragraph.",
    "xml": "The text of the XML was read.", "csv": "Rows were read as a table.", "sldc": "",
}
PREVIEW_CACHE = 6


def map_error(exc: Exception) -> Exception:
    """Documaster's typed errors -> the shared application errors the server turns into {ok:false}."""
    code = getattr(exc, "code", None)
    message = getattr(exc, "message", None) or str(exc)
    details = dict(getattr(exc, "details", {}) or {})
    if code == "password_required":
        return Unauthorized(message, details={**details, "passwordRequired": True})
    if code == "wrong_password":
        return Unauthorized(message, details={**details, "wrongPassword": True})
    if code == "dependency_missing":
        return DependencyMissing(message, hint="See docs/OPERATIONS.md for the optional dependency.")
    if code == "limit_exceeded":
        return LimitExceeded(message, details=details)
    if code == "permission_denied":
        return Forbidden(message, details=details)
    return BadRequest(message, details={**details, "code": code})


def available_formats(docmaster: Any) -> dict[str, Any]:
    reason = None if docmaster.available else (docmaster.reason or "Documaster is not available.")
    export = [{"id": f, "label": LABELS[f], "available": f == "sldc" or docmaster.available, "reason": None if (f == "sldc" or docmaster.available) else reason,
               "lossy": LOSSY[f]} for f in EXPORT_FORMATS]
    tools = getattr(getattr(docmaster, "services", None), "tools", None)
    soffice = bool(getattr(tools, "soffice", None)) if tools is not None else False
    imports = []
    for f in IMPORT_FORMATS:
        ok = f == "sldc" or docmaster.available
        why = None if ok else reason
        if ok and f in ("doc", "rtf") and not soffice:
            ok, why = False, "Reading this older format needs LibreOffice, which is not installed."
        if ok and f in ("md", "txt", "html", "xml", "csv", "pdf") and not _parser_ready(docmaster):
            ok, why = False, "Reading this format needs SLAI Reader's parser engine, which could not be loaded."
        imports.append({"id": f, "label": LABELS.get(f, f), "available": ok, "reason": why, "note": IMPORT_LOSS.get(f, "")})
    return {"export": export, "import": imports, "documaster": docmaster.status(), "libreoffice": soffice}


def _parser_ready(docmaster: Any) -> bool:
    try:
        return bool(docmaster.services.reader.available("parser"))
    except Exception:  # noqa: BLE001
        return False


class Exchange:
    def __init__(self, app: Any) -> None:
        self.app = app
        self._cache: OrderedDict[tuple[str, int], bytes] = OrderedDict()
        self._layout_cache: OrderedDict[tuple[str, int], dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()

    # -------------------------------------------------------------------------------------------------------- helpers
    def _dm(self) -> Any:
        if not self.app.docmaster.available:
            raise DependencyMissing(self.app.docmaster.reason or "Documaster is not available.",
                                    hint="Export and import of PDF, Word, OpenDocument, RTF, HTML and Markdown need Documaster (applications/Documaster).")
        return self.app.docmaster

    def _tmp(self) -> Path:
        folder = self.app.settings.data_dir / "tmp"
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def _settled(self, session: DocumentSession) -> Any:
        with session.lock:
            return session._settled(session.pkg.copy())                         # noqa: SLF001

    # ---------------------------------------------------------------------------------------------------- preflight
    def preflight(self, session: DocumentSession, target: str | None = None) -> dict[str, Any]:
        """Problems worth fixing before the document leaves Writer. Findings never block an export; they say what to check."""
        package = self._settled(session)
        doc = package.document
        issues: list[dict[str, Any]] = []

        def add(severity: str, code: str, message: str, block: str | None = None) -> None:
            issues.append({"severity": severity, "code": code, "message": message, "block": block})

        title = (doc.get("title") or "").strip()
        if not title or title.lower() in ("untitled", "untitled document"):
            add("warn", "title", "The document has no title. Exports and screen readers use it.")
        if not doc.get("language"):
            add("warn", "language", "The document language is not set; spelling, hyphenation and screen readers need it.")
        last_level = 0
        refs = {r.get("id") for r in (doc.get("references") or [])} if isinstance(doc.get("references"), list) else set((doc.get("references") or {}).keys())
        ids = {b["id"] for b in doc["blocks"]}
        for block in doc["blocks"]:
            kind = block["type"]
            if kind == "figure":
                fig = block.get("figure", {})
                if not fig.get("decorative") and not (fig.get("alt") or "").strip():
                    add("warn", "alt_text", "A picture has no description for people who cannot see it.", block["id"])
                asset = package.assets.get(fig.get("asset"))
                width = fig.get("width_mm")
                if asset is not None and width:
                    dpi = self._dpi(asset.data, width)
                    if dpi is not None and dpi < 150:
                        add("warn", "resolution", f"A picture prints at about {int(dpi)} dpi, which may look blurry on paper (150 or more is better).", block["id"])
            if kind == "heading":
                level = int((block.get("attributes") or {}).get("level", 1))
                if not (block.get("text") or "").strip():
                    add("warn", "empty_heading", "A heading is empty.", block["id"])
                if level > last_level + 1:
                    where = f"jumps from level {last_level} to {level}" if last_level else f"starts at level {level} instead of 1"
                    add("warn", "heading_skip", f"The heading outline {where}; screen-reader navigation relies on an unbroken outline.", block["id"])
                last_level = level
            if kind == "table":
                table = block.get("table", {})
                if not table.get("header_rows"):
                    add("info", "table_header", "A table has no header row, which makes it harder to read with assistive technology.", block["id"])
            for span in block.get("spans", []):
                if span.get("type") == "ref" and span.get("ref") and span["ref"] not in refs:
                    add("error", "missing_reference", "A citation points to a source that is not in the document's source list.", block["id"])
                if span.get("type") == "xref" and span.get("target") and span["target"] not in ids:
                    add("error", "broken_xref", "A cross-reference points to something that no longer exists.", block["id"])
            if kind == "embed":
                add("info", "embed", "An EMBED component will appear as its last valid output, not as an active component.", block["id"])
        open_threads = [t for t in package.comments if t.get("status", "open") == "open"]
        if open_threads:
            add("info", "comments", f"{len(open_threads)} open comment thread{'s' if len(open_threads) != 1 else ''}. Comments are not exported (except in SLDC).")
        if package.signatures and target not in (None, "sldc"):
            add("info", "signature", "This document is signed. Other formats cannot carry the signature, so the copy will not verify.")
        try:
            from .academic import Academic
            issues.extend(Academic(self.app).audit(session))
        except Exception:  # noqa: BLE001 - the audit is advice; it must never stop an export
            pass
        order = {"error": 0, "warn": 1, "info": 2}
        issues.sort(key=lambda i: order[i["severity"]])
        return {"issues": issues, "counts": {k: sum(1 for i in issues if i["severity"] == k) for k in order},
                "target": target, "lossy": LOSSY.get(target or "", []) if target else []}

    @staticmethod
    def _dpi(data: bytes, width_mm: float) -> float | None:
        try:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as image:
                return image.width / (float(width_mm) / 25.4)
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------------------------------------------ export
    def export(self, session: DocumentSession, fmt: str, out_dir: Path, *, stem: str | None = None, options: dict[str, Any] | None = None,
               password: str | None = None) -> dict[str, Any]:
        if fmt not in EXPORT_FORMATS:
            raise BadRequest(f"Writer cannot export to '{fmt}'.", details={"supported": list(EXPORT_FORMATS)})
        options = options or {}
        out_dir = Path(out_dir)
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise BadRequest(f"The destination folder cannot be used: {exc.strerror or exc}") from exc
        stem = (stem or session.path.stem if (stem or session.path) else (stem or session.title)) or "document"
        pre = self.preflight(session, fmt)
        package = self._settled(session)
        if fmt == "sldc":
            return self._export_sldc(session, package, out_dir, stem, password, pre)
        dm = self._dm()
        files = dm.module("files")
        writers = dm.module("docmodel.writers")
        verify = dm.module("docmodel.verify")
        formats = dm.module("formats")
        errors = dm.module("errors")
        wopts = writers.WriteOptions(title=options.get("title") or session.title, page_size=options.get("page_size"),
                                     margins_mm=options.get("margins_mm"), font_size_pt=float(options.get("font_size_pt", 11.0)),
                                     font_family=options.get("font_family"), page_numbers=bool(options.get("page_numbers", True)),
                                     author=options.get("author"), include_notes=bool(options.get("include_notes", True)),
                                     line_ending=options.get("line_ending", "\n"))
        try:
            with files.atomic_output(out_dir, stem, formats.ext_for(fmt)) as out:
                wopts.stem = out.destination.stem
                written = writers.get_writer(fmt)(package, out.temp, wopts)
                check = verify.verify_written(out.temp, fmt, package, dm.services)
                if not check["ok"]:
                    failed = "; ".join(f"{c['name']} ({c['detail']})" for c in check["checks"] if c["ok"] is False)
                    raise BadRequest("The exported file failed its own check and was discarded: " + failed,
                                     hint="Your document is unchanged. Try another format, or report this document.", details={"verification": check})
                final = out.commit()
        except errors.DocumasterError as exc:
            raise map_error(exc) from exc
        except (BadRequest, DependencyMissing):
            raise
        except sldc().SLDCError as exc:
            raise BadRequest(f"The document could not be converted: {exc}") from exc
        except OSError as exc:
            raise BadRequest(f"The file could not be written: {exc.strerror or exc}") from exc
        extras: list[str] = []
        for rel, data in written.extra_data:
            target = (out_dir / rel).resolve()
            if out_dir.resolve() not in target.parents:
                continue                                                           # a writer may not place files outside the folder
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            extras.append(str(target))
        report = {"path": str(final), "name": final.name, "format": fmt, "bytes": final.stat().st_size, "sha256": files.sha256_file(final),
                  "pages": written.pages, "kept": written.kept, "lost": sorted(set([*LOSSY[fmt], *written.lost])), "warnings": written.warnings,
                  "extras": extras, "backend": written.backend, "preflight": pre,
                  "verification": {"ok": check["ok"], "checks": check["checks"]}}
        if fmt == "pdf":
            facts = report["pdf"] = self.pdf_facts(final)
            if facts.get("unembeddedFonts"):
                report["warnings"] = [*report["warnings"], "These fonts are not embedded in the PDF: " + ", ".join(facts["unembeddedFonts"]) +
                                      ". Viewers normally have them, but a print shop or archive may require embedded fonts; choose an installed font family in the export options to embed it."]
        return report

    def _export_sldc(self, session: DocumentSession, package: Any, out_dir: Path, stem: str, password: str | None, pre: dict[str, Any]) -> dict[str, Any]:
        recipients = [sldc().password_recipient(password)] if password else ([sldc().password_recipient(session.password)] if session.password else None)
        try:
            data = sldc().dumps_package(package, recipients=recipients)
        except sldc().SLDCError as exc:
            raise BadRequest(f"The copy could not be written: {exc}") from exc
        from ..tools.storage import atomic_write
        for n in range(10_000):
            name = f"{stem}.sldc" if n == 0 else f"{stem} ({n}).sldc"
            target = out_dir / name
            try:
                atomic_write(target, data, exclusive=True)
                break
            except FileExistsError:
                continue
            except OSError as exc:
                raise BadRequest(f"The file could not be written: {exc.strerror or exc}") from exc
        else:
            raise BadRequest("No free file name was found in that folder.")
        return {"path": str(target), "name": target.name, "format": "sldc", "bytes": len(data), "pages": None, "kept": ["everything"],
                "lost": [], "warnings": [], "extras": [], "preflight": pre, "encrypted": bool(recipients),
                "verification": {"ok": True, "checks": [{"name": "SLDC validator", "ok": True, "detail": "the copy was validated before writing"}]}}

    @staticmethod
    def pdf_facts(path: Path) -> dict[str, Any]:
        """What a print shop would check: page count, page size, fonts embedded, encryption, title."""
        try:
            import pypdf
            reader = pypdf.PdfReader(str(path))
            fonts: dict[str, bool] = {}
            for page in reader.pages[:200]:
                resources = page.get("/Resources") or {}
                for ref in ((resources.get("/Font") or {}).values() if hasattr(resources.get("/Font") or {}, "values") else []):
                    font = ref.get_object()
                    desc = font.get("/FontDescriptor")
                    name = str(font.get("/BaseFont", "?")).lstrip("/")
                    embedded = False
                    if desc is not None:
                        d = desc.get_object()
                        embedded = any(k in d for k in ("/FontFile", "/FontFile2", "/FontFile3"))
                    elif font.get("/Subtype") == "/Type0":
                        embedded = True
                    fonts[name] = fonts.get(name, True) and embedded
            box = reader.pages[0].mediabox if reader.pages else None
            return {"pages": len(reader.pages), "pageSizeMm": [round(float(box.width) * 25.4 / 72, 1), round(float(box.height) * 25.4 / 72, 1)] if box else None,
                    "fonts": [{"name": n, "embedded": e} for n, e in sorted(fonts.items())], "unembeddedFonts": sorted(n for n, e in fonts.items() if not e),
                    "encrypted": bool(reader.is_encrypted), "title": (reader.metadata.title if reader.metadata else None)}
        except Exception as exc:  # noqa: BLE001
            return {"error": f"The PDF could not be inspected ({type(exc).__name__})."}

    # --------------------------------------------------------------------------------------------------- print preview
    def _pdf_bytes(self, session: DocumentSession) -> bytes:
        key = (session.sid, session.version)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        dm = self._dm()
        writers, files, errors = dm.module("docmodel.writers"), dm.module("files"), dm.module("errors")
        package = self._settled(session)
        with tempfile.TemporaryDirectory(prefix="wr-pdf-", dir=self._tmp()) as tmp:
            target = Path(tmp) / "preview.pdf"
            try:
                result = writers.get_writer("pdf")(package, target, writers.WriteOptions(title=session.title, stem="preview"))
            except errors.DocumasterError as exc:
                raise map_error(exc) from exc
            except Exception as exc:  # noqa: BLE001
                raise BadRequest(f"The print preview could not be made: {type(exc).__name__}") from exc
            data = target.read_bytes()
        with self._lock:
            self._cache[key] = data
            if result.layout is not None:
                self._layout_cache[key] = result.layout
            while len(self._cache) > PREVIEW_CACHE:
                dropped, _ = self._cache.popitem(last=False)
                self._layout_cache.pop(dropped, None)
        return data

    def layout(self, session: DocumentSession) -> dict[str, Any]:
        """Exact PDF page positions from Documaster's layout pass, cached per document version."""
        key = (session.sid, session.version)
        self._pdf_bytes(session)
        with self._lock:
            layout = copy.deepcopy(self._layout_cache.get(key))
        if layout is None:
            raise DependencyMissing("The installed PDF writer does not expose measured page positions.",
                                    hint="Update Documaster alongside SLAI Writer.")
        return {**layout, "version": session.version}

    def print_pdf(self, session: DocumentSession) -> bytes:
        return self._pdf_bytes(session)

    def preview(self, session: DocumentSession, pages: list[int], width: int = 720) -> dict[str, Any]:
        data = self._pdf_bytes(session)
        dm = self._dm()
        lock = dm.module("pdfium_lock").PDFIUM_LOCK
        try:
            import pypdfium2 as pdfium
        except Exception as exc:  # noqa: BLE001
            raise DependencyMissing("The print preview needs pypdfium2 (pip install pypdfium2).") from exc
        out = []
        with lock:
            pdf = pdfium.PdfDocument(data)
            try:
                total = len(pdf)
                for n in pages[:12]:
                    if not 1 <= n <= total:
                        continue
                    page = pdf[n - 1]
                    w, h = page.get_size()
                    image = page.render(scale=max(0.2, min(3.0, width / w))).to_pil()
                    buf = io.BytesIO()
                    image.convert("RGB").save(buf, "PNG", optimize=False)
                    out.append({"page": n, "widthPt": w, "heightPt": h, "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")})
            finally:
                pdf.close()
        facts = self._facts_from_bytes(data)
        return {"total": total, "pages": out, "facts": facts, "version": session.version,
                "note": "This preview is drawn from the PDF Writer would export. The editor's page breaks are an approximation; this is the exact result for PDF and print."}

    def _facts_from_bytes(self, data: bytes) -> dict[str, Any]:
        with tempfile.NamedTemporaryFile(dir=self._tmp(), suffix=".pdf", delete=False) as handle:
            handle.write(data)
            name = handle.name
        try:
            return self.pdf_facts(Path(name))
        finally:
            try:
                os.unlink(name)
            except OSError:
                pass

    def page_count(self, session: DocumentSession) -> int | None:
        try:
            return self._facts_from_bytes(self._pdf_bytes(session)).get("pages")
        except Exception:  # noqa: BLE001
            return None

    # ------------------------------------------------------------------------------------------------------- import
    def import_bytes(self, data: bytes, name: str, *, password: str | None = None, profile: str, ocr: bool = False,
                     as_text: bool = False) -> DocumentSession:
        limit = self.app.settings.max_upload_bytes
        if len(data) > limit:
            raise LimitExceeded(f"That file is larger than the {limit // 1024 // 1024} MiB limit.")
        if not data:
            raise BadRequest("That file is empty.")
        name = Path(name or "document").name[:200]
        with tempfile.TemporaryDirectory(prefix="wr-imp-", dir=self._tmp()) as tmp:
            source = Path(tmp) / ("upload" + secrets.token_hex(4))               # a neutral name: the claimed name is only a claim
            source.write_bytes(data)
            return self._read_source(source, name, password, profile, ocr, as_text)

    def import_path(self, path: Path, *, password: str | None, profile: str, ocr: bool = False, as_text: bool = False) -> DocumentSession:
        path = Path(path)
        try:
            size = path.stat().st_size
        except OSError as exc:
            raise NotFound(f"That file cannot be read: {exc.strerror or exc}") from exc
        if size > self.app.settings.max_upload_bytes:
            raise LimitExceeded(f"That file is larger than the {self.app.settings.max_upload_bytes // 1024 // 1024} MiB limit.")
        return self._read_source(path, path.name, password, profile, ocr, as_text)

    def _read_source(self, source: Path, name: str, password: str | None, profile: str, ocr: bool, as_text: bool) -> DocumentSession:
        dm = self._dm()
        formats, readers, errors = dm.module("formats"), dm.module("docmodel.readers"), dm.module("errors")
        found = formats.sniff(source, name)
        fmt = found.get("format")
        if fmt is None and Path(name).suffix.lower() == ".sdoc" and as_text:
            fmt = "txt"
        scratch = None
        if fmt and fmt in formats.FORMATS and source.suffix.lower() not in formats.FORMATS[fmt].exts:
            # The readers choose their parser by extension, so a neutrally named upload gets the extension of what it really is.
            scratch = tempfile.TemporaryDirectory(prefix="wr-ext-", dir=self._tmp())
            link = Path(scratch.name) / ("source" + formats.ext_for(fmt))
            link.write_bytes(source.read_bytes())
            source = link
        try:
            return self._read_typed(source, name, found, fmt, password, profile, ocr, as_text, dm, formats, readers, errors)
        finally:
            if scratch is not None:
                scratch.cleanup()

    def _read_typed(self, source: Path, name: str, found: dict[str, Any], fmt: str | None, password: str | None, profile: str, ocr: bool,
                    as_text: bool, dm: Any, formats: Any, readers: Any, errors: Any) -> DocumentSession:
        legacy = Path(name).suffix.lower() == ".sdoc"
        notes: list[str] = []
        if fmt == "txt" and legacy and as_text and found.get("format") is None:
            notes.append("This .sdoc file was read as plain text because you asked for that; no formatting was understood.")
        if fmt is None:
            hint = "If this is an old .sdoc file, Writer cannot read its structure. You can import it as plain text instead." if legacy else None
            raise BadRequest(f"Writer cannot tell what kind of file '{name}' is, so it was not opened.", hint=hint, details={"format": None, "legacy": legacy})
        if fmt not in IMPORT_FORMATS:
            raise BadRequest(f"Writer cannot import {formats.label_for(fmt)} files.", details={"format": fmt})
        if found.get("mismatch"):
            notes.append(found.get("note") or f"The file name says {found.get('claimed')} but its content is {fmt}; it was read as {fmt}.")
        if legacy and fmt == "sldc":
            notes.append("This .sdoc file contains SLDC content. It was opened as an unsaved copy; the original is untouched, and saving writes a .sldc file.")
        if fmt == "sldc":
            try:
                package = load_bytes(source.read_bytes(), password)
            except Unauthorized:
                raise
            except sldc().SLDCError as exc:
                raise BadRequest(f"That SLDC file is not valid: {exc}") from exc
            warnings, lost = [], []
        else:
            try:
                result = readers.read_document(source, fmt, dm.services, password=password, name=name, ocr=ocr)
            except errors.DocumasterError as exc:
                raise map_error(exc) from exc
            package = result.package
            warnings, lost = list(result.warnings), list(result.dropped)
            notes.append(f"Imported from {LABELS.get(fmt, fmt)}. " + IMPORT_LOSS.get(fmt, ""))
        package.document["id"] = "doc-" + secrets.token_hex(8)                      # a new identity: an import is a new document
        package.signatures = []
        if not package.document.get("title"):
            package.document["title"] = Path(name).stem[:200] or "Imported document"
        session = DocumentSession(self.app.store, package, path=None, profile=profile, notices=[n for n in notes if n] + warnings,
                                  origin={"kind": "import", "format": fmt, "name": name, "lost": lost})
        session.dirty = True
        session.recovery_dirty = True
        return session
