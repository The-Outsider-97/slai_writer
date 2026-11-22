"""A horizontal rule leaves Writer as a real line: drawn in PDF, a bottom-bordered paragraph in Word, OpenDocument and RTF, <hr> in HTML, ``---`` in Markdown.
Each file is read back with an independent parser, and the PDF (and a LibreOffice rendering of the Word file) is measured: the line must span the text width
between the paragraph above and the paragraph below. Needs Documaster; skips without it."""
import tempfile
import types
import unittest
import zipfile
from pathlib import Path

from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from . import independent
from .helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]
MM = 72.0 / 25.4


def para(bid, text, **extra):
    return {"id": bid, "type": "paragraph", "text": text, **extra}


class RuleExport(Workbench):
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
        independent.need(self, "Documaster", self.dm.available, str(self.dm.reason))
        try:
            import docx, pdfplumber  # noqa: F401
            readers = None
        except ImportError as exc:
            readers = str(exc)
        independent.need(self, "the independent readers (python-docx, pdfplumber)", readers is None, str(readers))
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
        self.ex = Exchange(self.app)

    def build(self, rule=None, margins=None):
        session = self.new_session("report", title="Rules")
        last = session.doc["blocks"][-1]["id"]
        session.apply({"op": "batch", "label": "build", "ops": [
            {"op": "block_insert", "after": last, "block": para("above", "Text above the line")},
            {"op": "block_insert", "after": "above", "block": para("rule", "___")},
            {"op": "block_insert", "after": "rule", "block": para("below", "Text below the line")}]}, None)
        session.apply({"op": "rule_insert", "block": "rule", **({"rule": rule} if rule else {})}, None)
        if margins:
            session.apply({"op": "page_setup", "page": {"size": "A4", "orientation": "portrait", "margins_mm": margins}}, None)
        return session

    def export(self, session, fmt):
        report = self.ex.export(session, fmt, self.root / "out", stem="rule")
        self.assertTrue(report["verification"]["ok"], report["verification"])
        return Path(report["path"])

    # ------------------------------------------------------------------------------------------------------------- PDF
    def horizontal_lines(self, page):
        """Every drawn horizontal stroke on the page as (x0, x1, top, thickness): lines, thin rectangles and curves alike."""
        out = []
        for line in page.lines:
            if abs(line["top"] - line["bottom"]) < 0.5:
                out.append((line["x0"], line["x1"], line["top"], float(line.get("linewidth") or 0)))
        for rect in page.rects:
            if rect["height"] <= 14 and rect["width"] > 50:
                out.append((rect["x0"], rect["x1"], (rect["top"] + rect["bottom"]) / 2, rect["height"]))
        return out

    def test_the_pdf_draws_one_line_from_margin_to_margin_between_the_paragraphs(self):
        import pdfplumber
        margins = {"top": 25, "right": 30, "bottom": 25, "left": 20}
        path = self.export(self.build(margins=margins), "pdf")
        with pdfplumber.open(str(path)) as pdf:
            page = pdf.pages[0]
            words = {w["text"]: w for w in page.extract_words()}
            above, below = words["above"] if "above" in words else None, words["below"] if "below" in words else None
            self.assertIsNotNone(above)
            self.assertIsNotNone(below)
            lines = [ln for ln in self.horizontal_lines(page) if above["bottom"] < ln[2] < below["top"]]
            self.assertEqual(len(lines), 1, f"one rule between the two paragraphs; found {self.horizontal_lines(page)}")
            x0, x1, _, thickness = lines[0]
            self.assertAlmostEqual(x0, margins["left"] * MM, delta=1.5)
            self.assertAlmostEqual(x1, page.width - margins["right"] * MM, delta=1.5)
            self.assertAlmostEqual(thickness, 1.0, delta=0.3)
            self.assertNotIn("___", page.extract_text(), "the underscores are gone: the rule is an element, not characters")

    def test_the_look_is_what_the_rule_says(self):
        import pdfplumber
        path = self.export(self.build(rule={"style": "dashed", "width_pt": 3, "color": "#cc0000", "space_before_pt": 20, "space_after_pt": 10}), "pdf")
        with pdfplumber.open(str(path)) as pdf:
            page = pdf.pages[0]
            words = {w["text"]: w for w in page.extract_words()}
            lines = [ln for ln in self.horizontal_lines(page) if words["above"]["bottom"] < ln[2] < words["below"]["top"]]
            self.assertTrue(lines, "the dashed line is drawn")
            self.assertAlmostEqual(lines[0][3], 3.0, delta=0.4)
            colored = [ln for ln in page.lines if ln.get("stroking_color") and abs(ln["top"] - lines[0][2]) < 2]
            self.assertTrue(colored and colored[0]["stroking_color"][0] > 0.7 and colored[0]["stroking_color"][1] < 0.2, f"red stroke: {colored}")
            gap_above = lines[0][2] - words["above"]["bottom"]
            gap_below = words["below"]["top"] - lines[0][2]
            self.assertGreater(gap_above, gap_below, "20 pt above, 10 pt below")

    # ------------------------------------------------------------------------------------------------------------ Word
    def test_word_gets_a_bordered_paragraph_in_the_right_place(self):
        import docx
        doc = docx.Document(str(self.export(self.build(rule={"width_pt": 2, "color": "#336699", "space_before_pt": 12, "space_after_pt": 3}), "docx")))
        texts = [p.text for p in doc.paragraphs]
        i = texts.index("Text above the line")
        j = texts.index("Text below the line")
        between = doc.paragraphs[i + 1:j]
        self.assertEqual(len(between), 1, "exactly one paragraph between the two")
        ppr = between[0]._p.pPr
        bottom = ppr.xpath("./w:pBdr/w:bottom")[0]
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        self.assertEqual((bottom.get(ns + "val"), bottom.get(ns + "sz"), bottom.get(ns + "color")), ("single", "16", "336699"))
        self.assertEqual((between[0].paragraph_format.space_before.pt, between[0].paragraph_format.space_after.pt), (12.0, 3.0))
        self.assertEqual(between[0].text, "")
        # the schema order inside w:pPr matters to Word: pBdr before spacing, ind and rPr
        tags = [child.tag.split("}")[1] for child in ppr]
        self.assertLess(tags.index("pBdr"), tags.index("spacing"))
        self.assertLess(tags.index("spacing"), tags.index("ind"))
        self.assertEqual(tags[-1], "rPr")

    def test_a_rendering_of_the_word_file_shows_the_same_line(self):
        import shutil
        import subprocess
        import pdfplumber
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        independent.need(self, "LibreOffice", bool(soffice), "soffice is not installed")
        docx_path = self.export(self.build(margins={"top": 25, "right": 25, "bottom": 25, "left": 25}), "docx")
        out = self.root / "lo"
        out.mkdir()
        run = subprocess.run([soffice, "--headless", f"-env:UserInstallation=file://{self.root}/lo-profile", "--convert-to", "pdf", "--outdir", str(out), str(docx_path)],
                             capture_output=True, timeout=150)
        pdfs = list(out.glob("*.pdf"))
        independent.need(self, "LibreOffice's conversion", bool(pdfs), run.stderr.decode(errors="replace")[:300])
        with pdfplumber.open(str(pdfs[0])) as pdf:
            page = pdf.pages[0]
            words = {w["text"]: w for w in page.extract_words()}
            lines = [ln for ln in self.horizontal_lines(page) if words["above"]["bottom"] <= ln[2] <= words["below"]["top"]]
            self.assertTrue(lines, f"LibreOffice draws the paragraph border; strokes: {self.horizontal_lines(page)}")
            self.assertAlmostEqual(lines[0][0], 25 * MM, delta=3)
            self.assertAlmostEqual(lines[0][1], page.width - 25 * MM, delta=3)

    # --------------------------------------------------------------------------------------- OpenDocument, RTF, HTML, text
    def test_opendocument_rtf_html_and_the_text_formats(self):
        session = self.build(rule={"style": "double", "width_pt": 1.5, "color": "#111111"})
        odt = zipfile.ZipFile(str(self.export(session, "odt")))
        content = odt.read("content.xml").decode()
        self.assertIn("Rule1", content)
        self.assertIn('fo:border-bottom="4.5pt double #111111"', content)
        self.assertIn('style:border-line-width-bottom="1.5pt 1.5pt 1.5pt"', content)
        rtf = self.export(session, "rtf").read_text(encoding="ascii")
        self.assertIn("\\brdrb\\brdrdb\\brdrw30", rtf)
        html = self.export(session, "html").read_text(encoding="utf-8")
        self.assertIn("<hr", html)
        self.assertIn("border-top:4.5pt double #111111", html)
        self.assertNotIn("___", html)
        md = self.export(session, "md").read_text(encoding="utf-8")
        self.assertRegex(md, r"(?m)^---\s*$", "a thematic break")
        txt = self.export(session, "txt").read_text(encoding="utf-8")
        self.assertIn("-" * 40, txt)

    def test_every_format_still_exports_a_document_without_rules(self):
        session = self.new_session("report", title="No rules")
        for fmt in ("pdf", "docx", "odt", "rtf", "html", "md", "txt"):
            self.assertTrue(self.export(session, fmt).exists(), fmt)


if __name__ == "__main__":
    unittest.main()
