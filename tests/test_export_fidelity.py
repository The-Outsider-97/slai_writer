"""What leaves Writer as Word and PDF, read back with independent parsers (python-docx, pdfplumber, pypdf): structure, character formatting, tables, page setup,
running header and footer, page numbers, and that the editor's page count is the PDF's. They need Documaster (the exporter) and skip without it."""
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from .helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]


def block(bid, kind, text, **extra):
    return {"id": bid, "type": kind, "text": text, **extra}


class Fidelity(Workbench):
    @classmethod
    def setUpClass(cls):
        cls._dm_dir = tempfile.TemporaryDirectory()
        cls.dm = DocumasterLink(ROOT, Path(cls._dm_dir.name)).load()

    @classmethod
    def tearDownClass(cls):
        cls.dm.close()
        cls._dm_dir.cleanup()

    def setUp(self):
        super().setUp()
        if not self.dm.available:
            self.skipTest("Documaster is not available: " + str(self.dm.reason))
        try:
            import docx, pdfplumber, pypdf  # noqa: F401
        except ImportError as exc:
            self.skipTest(f"an independent reader is not installed: {exc}")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
        self.ex = Exchange(self.app)

    def build(self, ops, title="Fidelity"):
        session = self.new_session("report", title=title)
        last = session.doc["blocks"][-1]["id"]
        chained, after = [], last
        for spec in ops:
            chained.append({"op": "block_insert", "after": after, "block": spec})
            after = spec["id"]
        session.apply({"op": "batch", "ops": chained, "label": "build"}, None)
        return session

    def export(self, session, fmt):
        import docx
        report = self.ex.export(session, fmt, self.root / "out", stem="fid")
        self.assertTrue(report["verification"]["ok"], report["verification"])
        path = Path(report["path"])
        return docx.Document(str(path)) if fmt == "docx" else path

    RICH = [
        block("h1", "heading", "Chapter One", attributes={"level": 1}),
        block("h2", "heading", "A section", attributes={"level": 2}),
        block("p1", "paragraph", "Plain bold italic both end.", spans=[
            {"type": "format", "start": 6, "end": 10, "bold": True}, {"type": "format", "start": 11, "end": 17, "italic": True},
            {"type": "format", "start": 18, "end": 22, "bold": True}, {"type": "format", "start": 18, "end": 22, "italic": True}]),
        block("b1", "list_item", "First bullet", attributes={"ordered": False, "depth": 0}),
        block("b2", "list_item", "Second bullet", attributes={"ordered": False, "depth": 0}),
        block("n1", "list_item", "Step one", attributes={"ordered": True, "depth": 0}),
        block("n2", "list_item", "Step two", attributes={"ordered": True, "depth": 0}),
        block("t1", "table", "", rows=3, columns=2, table={"columns": 2, "header_rows": 1, "rows": [
            [{"text": "Name"}, {"text": "Value"}], [{"text": "alpha"}, {"text": "1"}], [{"text": "beta"}, {"text": "2"}]]}),
    ]

    def test_word_keeps_headings_character_formatting_lists_and_tables(self):
        doc = self.export(self.build(self.RICH), "docx")
        styled = {p.text: p for p in doc.paragraphs if p.text}
        self.assertEqual(styled["Chapter One"].style.name, "Heading 1")
        self.assertEqual(styled["A section"].style.name, "Heading 2")
        runs = {r.text: (bool(r.bold), bool(r.italic)) for r in styled["Plain bold italic both end."].runs}
        self.assertEqual(runs["bold"], (True, False))
        self.assertEqual(runs["italic"], (False, True))
        self.assertEqual(runs["both"], (True, True))
        self.assertEqual((styled["First bullet"].style.name, styled["Second bullet"].style.name), ("List Bullet", "List Bullet"))
        self.assertEqual((styled["Step one"].style.name, styled["Step two"].style.name), ("List Number", "List Number"))
        table, = doc.tables
        self.assertEqual([[c.text for c in row.cells] for row in table.rows], [["Name", "Value"], ["alpha", "1"], ["beta", "2"]])
        header = table.rows[0]._tr.trPr
        self.assertTrue(header is not None and header.xpath("./w:tblHeader"), "the header row repeats on every page in Word")

    def test_word_and_pdf_carry_the_page_setup(self):
        session = self.build(self.RICH)
        session.apply({"op": "page_setup", "page": {"size": "Letter", "orientation": "landscape", "margins_mm": {"top": 20, "right": 30, "bottom": 22, "left": 28}}}, None)
        section = self.export(session, "docx").sections[0]
        self.assertEqual((round(section.page_width.mm), round(section.page_height.mm)), (279, 216))
        self.assertEqual((round(section.top_margin.mm), round(section.right_margin.mm), round(section.bottom_margin.mm), round(section.left_margin.mm)), (20, 30, 22, 28))
        import pypdf
        box = pypdf.PdfReader(str(self.export(session, "pdf"))).pages[0].mediabox
        self.assertEqual((round(float(box.width) * 25.4 / 72), round(float(box.height) * 25.4 / 72)), (279, 216))

    def test_the_running_header_and_footer_reach_both_formats_with_a_live_page_number(self):
        session = self.build(self.RICH, title="Annual report")
        section = self.export(session, "docx").sections[0]
        self.assertIn("Annual report", " ".join(p.text for p in section.header.paragraphs) + " ".join(p.text for p in section.footer.paragraphs))
        self.assertIn("PAGE", section.footer._element.xml, "the page number is a field Word updates, not typed digits")

    def test_pdf_text_is_in_reading_order_and_the_page_number_counts_up(self):
        import pdfplumber
        filler = [block(f"f{i}", "paragraph", f"Paragraph number {i:03d} " + "words " * 40) for i in range(60)]
        session = self.build(self.RICH + filler)
        with pdfplumber.open(str(self.export(session, "pdf"))) as pdf:
            pages = [(page.extract_text() or "") for page in pdf.pages]
        self.assertGreater(len(pages), 2)
        text = "\n".join(pages)
        order = [text.index(marker) for marker in ("Chapter One", "A section", "First bullet", "Step one", "Name Value", "Paragraph number 000", "Paragraph number 059")]
        self.assertEqual(order, sorted(order))
        for number, page in enumerate(pages, 1):
            self.assertTrue(page.rstrip().endswith(str(number)), f"page {number} ends with its own number, not {page.rstrip()[-12:]!r}")

    def test_the_page_count_the_editor_shows_is_the_pdfs(self):
        filler = [block(f"f{i}", "paragraph", f"Line {i:03d} " + "text " * 60) for i in range(80)]
        session = self.build(self.RICH + filler)
        layout = self.ex.layout(session)
        import pypdf
        pdf_pages = len(pypdf.PdfReader(str(self.export(session, "pdf"))).pages)
        measured = layout.get("pages") or layout.get("page_count") or layout.get("pageCount")
        measured = len(measured) if isinstance(measured, list) else measured
        self.assertEqual(measured, pdf_pages, f"layout keys: {sorted(layout)}")
        self.assertEqual(self.ex.page_count(session), pdf_pages)

    def test_a_table_longer_than_a_page_repeats_its_header_row_in_the_pdf(self):
        import pdfplumber
        rows = [[{"text": "Name"}, {"text": "Value"}]] + [[{"text": f"row{i:03d}"}, {"text": str(i)}] for i in range(120)]
        session = self.build([block("t1", "table", "", rows=len(rows), columns=2, table={"columns": 2, "header_rows": 1, "rows": rows})])
        with pdfplumber.open(str(self.export(session, "pdf"))) as pdf:
            texts = [page.extract_text() or "" for page in pdf.pages]
        with_rows = [t for t in texts if "row0" in t or "row1" in t]
        self.assertGreater(len(with_rows), 1, "the table runs over more than one page")
        self.assertTrue(all("Name Value" in t for t in with_rows), "every page of a long table starts with its header row")


if __name__ == "__main__":
    unittest.main()
