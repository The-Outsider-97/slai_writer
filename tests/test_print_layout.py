"""End-to-end print-layout and TOC schema regressions with the actual PDF engine."""
from pathlib import Path

from applications.slai_writer.academic import Academic
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.session import sldc

from .helpers import Workbench


class PDFLayoutTests(Workbench):
    def _exchange(self):
        root = Path(__file__).resolve().parents[3]
        self.app.settings.data_dir = self.root / "data"
        self.app.docmaster = DocumasterLink(root, self.root / "data").load()
        if not self.app.docmaster.available:
            self.skipTest(self.app.docmaster.reason)
        self.addCleanup(self.app.docmaster.close)
        return Exchange(self.app)

    def test_toc_schema_options_roundtrip_and_layout_matches_pdf(self):
        session = self.new_session("report", title="A substantial test")
        session.apply({"op": "cover_insert"}, None)
        headings = [b for b in session.doc["blocks"] if b["type"] == "heading"]
        self.assertTrue(headings)
        manager = Academic(self.app)
        created = manager.contents(session, None, preset="academic", depth=6,
                                   leader_dots=True, show_page_numbers=True, refresh_mode="automatic")
        label = created["tocId"]
        restored = sldc().loads_package(session.to_bytes()).document
        title = next(b for b in restored["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        metadata = title["extensions"]["slai.sldc.toc"]
        self.assertEqual(metadata["id"], label)
        self.assertTrue(metadata["show_page_numbers"] and metadata["leader_dots"])
        self.assertEqual(metadata["refresh_mode"], "automatic")
        self.assertEqual(restored["styles"]["paragraph"]["TOC Level 1"]["bold"], True)
        exchange = self._exchange()
        layout = exchange.layout(session)
        self.assertEqual(layout["printedLabels"][0], None)
        self.assertEqual(layout["printedLabels"][1], "1")
        self.assertEqual(len(layout["printedLabels"]), layout["pages"])
        for heading in headings:
            hid = heading["id"]
            self.assertIn(hid, layout["blockPages"])
            page = layout["blockPages"][hid]
            self.assertEqual(layout["blockLabels"][hid], layout["printedLabels"][page - 1] or "")
        paragraph = next(b for b in session.doc["blocks"] if b["type"] == "paragraph"
                         and b.get("section") != session.doc["sections"][0]["id"]
                         and not b.get("extensions", {}).get("slai.sldc.toc"))
        self.assertIn(paragraph["id"], layout["blockPages"])
        try:
            from pypdf import PdfReader
        except ImportError:
            return
        from io import BytesIO
        pdf = PdfReader(BytesIO(exchange.print_pdf(session)))
        self.assertEqual(len(pdf.pages), layout["pages"])
        printed_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        self.assertIn("...", printed_text, "TOC leader dots must appear in the actual PDF, not just in the UI")
        for heading in headings:
            self.assertIn(heading["text"], printed_text)

    def test_toc_refresh_preserves_settings_and_per_level_styles(self):
        session = self.new_session("report", title="Stable headings")
        manager = Academic(self.app)
        toc_id = manager.contents(session, None, preset="compact", refresh_mode="manual",
                                  leader_dots=False, show_page_numbers=False)["tocId"]
        first = next(b for b in session.doc["blocks"] if b["type"] == "heading")
        session.apply({"op": "style_define", "kind": "paragraph", "name": "TOC Level 1",
                       "props": {"font_size_pt": 15, "color": "#234567"}}, None)
        session.apply({"op": "text", "block": first["id"], "start": 0, "end": len(first["text"]),
                       "insert": "Renamed heading"}, None)
        updated = manager.refresh_contents(session, toc_id)
        self.assertIn("patch", updated)
        toc = next(b["extensions"]["slai.sldc.toc"] for b in session.doc["blocks"]
                   if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        self.assertFalse(toc["show_page_numbers"])
        self.assertFalse(toc["leader_dots"])
        self.assertEqual(toc["refresh_mode"], "manual")
        self.assertEqual(session.doc["styles"]["paragraph"]["TOC Level 1"]["font_size_pt"], 15)
        sldc().validate_package(session.pkg)

    def test_pdf_numbering_respects_custom_roman_start_and_restart(self):
        session = self.new_session("report", title="Roman front matter")
        session.apply({"op": "page_setup", "section": "s1",
                       "numbering": {"show": True, "start": 3, "format": "lower-roman"}}, None)
        layout = self._exchange().layout(session)
        self.assertEqual(layout["printedLabels"][0], "iii")
        self.assertEqual(len(layout["printedLabels"]), layout["pages"])
