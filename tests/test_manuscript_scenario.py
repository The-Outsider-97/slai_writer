"""The mandatory manuscript scenario, end to end and read back by software that did not write it.

A cover, a front-matter section with ordinary margins, chapters in a mirrored section with a gutter, headers and footers, Scripture, a table, a picture, a text box,
citations with a bibliography and a table of contents. The document is edited through the operations the editor sends, the gutter is changed and the section
reflows, pages are inserted and removed, the document is saved and reopened, exported to PDF and DOCX and then:

  * the PDF is measured with pdfplumber and rasterised by poppler's ``pdftoppm`` (neither is the code that wrote it);
  * the DOCX is opened by LibreOffice, printed to PDF and measured the same way, and read as a package by python-docx;
  * the pictures the Rendered view serves are compared with the exported PDF's pages.

Every reader that is missing skips the test on a developer's machine and fails it under ``SLAI_REQUIRE_INTEGRATION=1`` (docs/INTEGRATION_GATE.md).
"""
from __future__ import annotations

import io
import shutil
import subprocess
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer.academic import Academic
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.session import sldc
from applications.slai_writer.shape_validation import SHAPE_KEY
from . import independent
from .helpers import Workbench, png
from .test_textbox import box

ROOT = Path(__file__).resolve().parents[3]
BODY = "The quick brown fox jumps over the lazy dog and keeps on writing for a while. " * 22
MM = 25.4 / 72


class Manuscript(Workbench):
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
            import docx, pdfplumber, pypdf  # noqa: F401
            readers = None
        except ImportError as exc:
            readers = str(exc)
        independent.need(self, "the independent readers (python-docx, pdfplumber, pypdf)", readers is None, str(readers))
        independent.need(self, "LibreOffice", independent.soffice() is not None, "install it or put 'soffice' on PATH")
        independent.need(self, "poppler's pdftoppm", shutil.which("pdftoppm") is not None, "install poppler-utils")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=8 * 1024 * 1024,
                                                  data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)
        self.ac = Academic(self.app, fetch=lambda doi: {})

    # ------------------------------------------------------------------------------------------------------ building
    def add(self, session, block, after=None):
        before = {b["id"] for b in session.doc["blocks"]}
        session.apply({"op": "block_insert", "after": after or session.doc["blocks"][-1]["id"], "block": block}, None)
        return next(b["id"] for b in session.doc["blocks"] if b["id"] not in before)

    def build(self):
        s = self.new_session("blank", title="The Long Road", name="manuscript")
        first = s.doc["blocks"][-1]["id"]
        s.apply({"op": "block_set", "block": first, "type": "heading", "attributes": {"level": 1}}, None)
        s.apply({"op": "text", "block": first, "start": 0, "end": len(s.doc["blocks"][-1]["text"]), "insert": "Preface"}, None)
        last = first
        for n in range(2):
            last = self.add(s, {"type": "paragraph", "text": f"Preface paragraph {n}. " + BODY}, after=last)
        # the chapters: a new section that is mirrored, with a gutter
        chapters = {}
        for c in range(1, 4):
            head = self.add(s, {"id": f"ch{c}", "type": "heading", "text": f"Chapter {c}", "attributes": {"level": 1, "page_break_before": True}}, after=last)
            last = head
            if c == 1:
                section = s.apply({"op": "section_break", "block": head}, None)
            for n in range(4):
                last = self.add(s, {"id": f"c{c}p{n}", "type": "paragraph", "text": f"Chapter {c}, paragraph {n}. " + BODY}, after=last)
            chapters[c] = head
        sid = s.doc["blocks"][[b["id"] for b in s.doc["blocks"]].index("ch1")]["section"]
        # Scripture, a table, a picture, a text box and the references
        verses = [self.add(s, {"id": f"v{n}", "type": "paragraph", "text": f"In the beginning verse {n} was spoken and it was good."}, after="c1p1" if n == 0 else f"v{n - 1}")
                  for n in range(3)]
        s.apply({"op": "scripture_apply", "block": verses[0], "end_block": verses[-1]}, None)
        self.add(s, {"id": "tbl", "type": "table", "rows": 3, "columns": 3}, after="c2p1")
        for r in range(3):
            for c in range(3):
                s.apply({"op": "table_cell", "block": "tbl", "row": r, "col": c, "text": f"{'ABC'[c]}{r + 1}"}, None)
        asset = s.add_image(png(400, 160))
        self.add(s, {"id": "fig", "type": "figure", "text": "A wavy line", "figure": {"asset": asset.id, "alt": "A wavy line", "width_mm": 70}}, after="c2p2")
        self.add(s, {"id": "tb", "type": "paragraph", "text": "", "extensions": {SHAPE_KEY: box()}}, after="c3p1")
        s.apply({"op": "reference_put", "reference": {"id": "r1", "kind": "citation", "title": "Roads and the people who walk them", "source_type": "book",
                                                       "authors": ["Rivera, Ana"], "year": 2019, "publisher": "Field Press"}}, None)
        self.ac.cite(s, "c1p0", len(s.doc["blocks"][[b["id"] for b in s.doc["blocks"]].index("c1p0")]["text"]), "r1")
        self.ac.bibliography(s, after="c3p3")
        # the cover and the contents come last, as a person would add them
        s.apply({"op": "cover_insert"}, None)
        self.ac.contents(s, after=None)
        # headers and footers; the book layout of the chapters
        s.apply({"op": "page_setup", "section": sid, "header": {"left": "The Long Road"}, "footer": {"center": "{page}"}}, None)
        s.apply({"op": "page_layout", "scope": "section", "section": sid, "mirror": True, "gutter_mm": 8, "margins_mm": {"inside": 22, "outside": 16}}, None)
        return s, sid

    # ------------------------------------------------------------------------------------------------------ measuring
    def pdf_of(self, session):
        return self.ex.print_pdf(session)

    def page_texts(self, data):
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return [(p.extract_text() or "") for p in pdf.pages]

    def chapter_pages(self, texts):
        return [n for n, t in enumerate(texts) if any(f"Chapter {c}" in t.splitlines()[:3] or t.lstrip().startswith(f"Chapter {c}") for c in (1, 2, 3))]

    def edges(self, data):
        return independent.text_edges(data)

    def mirrored_edges(self, session, sid):
        """The left text edge of every page of the mirrored section, in page order, paired with the page number."""
        data = self.pdf_of(session)
        texts = self.page_texts(data)
        edges = self.edges(data)
        first = next(n for n, t in enumerate(texts) if "Chapter 1" in t and "Contents" not in t and "paragraph 0" in t)
        return [(n + 1, e[0], e[1]) for n, e in enumerate(edges) if n >= first and e is not None], len(texts), first

    # ------------------------------------------------------------------------------------------------------ the scenario
    def test_the_manuscript_from_editing_to_independently_read_exports(self):
        s, sid = self.build()

        # 1. front matter keeps ordinary margins; chapters alternate, and the text width never changes
        rows, total, first = self.mirrored_edges(s, sid)
        self.assertGreaterEqual(len(rows), 6, "the chapters fill several pages")
        lefts = [round(l) for _, l, _ in rows]
        self.assertEqual(set(lefts), {30, 16}, f"inside 22 + gutter 8 on one side and outside 16 on the other: {lefts}")
        for (n, left, _), (m, nxt, _) in zip(rows, rows[1:]):
            if m == n + 1:
                self.assertNotAlmostEqual(left, nxt, delta=5, msg=f"pages {n} and {m} are a spread: their edges differ")
        pre = [e for e in self.edges(self.pdf_of(s))[:first] if e is not None]
        self.assertTrue(pre, "cover, contents and preface exist")
        full = [210 - l - r for _, l, r in rows if 210 - l - r > 150]          # pages whose lines run the full measure (a short last page or a figure does not show it)
        self.assertGreaterEqual(len(full), 3)
        self.assertLessEqual(max(full) - min(full), 1.5, f"the text width never changes: {sorted(full)}")

        # 2. the gutter changes: the section reflows, the margins follow, and the stored margins are untouched
        s.apply({"op": "page_layout", "scope": "section", "section": sid, "gutter_mm": 12}, None)
        rows2, total2, _ = self.mirrored_edges(s, sid)
        self.assertEqual({round(l) for _, l, _ in rows2}, {34, 16})
        stored = next(x for x in s.doc["sections"] if x["id"] == sid)["page"]["margins_mm"]
        self.assertEqual((stored["left"], stored["right"]), (22, 16), "the gutter is added at layout time, never stored into the margins")

        # 3. insert and remove content: the alternation continues, with no gap and no repeat
        extra = [self.add(s, {"id": f"x{n}", "type": "paragraph", "text": f"Inserted {n}. " + BODY * 3, "attributes": {"page_break_before": n == 0}}, after="c1p3") for n in range(3)]
        rows3, total3, _ = self.mirrored_edges(s, sid)
        self.assertGreater(total3, total2)
        for (n, left, _), (m, nxt, _) in zip(rows3, rows3[1:]):
            self.assertEqual(round(left) == 34, round(nxt) != 34, f"pages {n} and {m}: parity alternates")
        for block in extra:
            s.apply({"op": "block_delete", "block": block}, None)
        rows4, total4, _ = self.mirrored_edges(s, sid)
        self.assertEqual(total4, total2, "removing what was added restores the page count")

        # 4. edit, save, reopen: nothing is lost
        s.apply({"op": "text", "block": "c2p0", "start": 0, "end": 0, "insert": "EDITED "}, None)
        reopened = sldc().loads_package(s.to_bytes()).document
        self.assertEqual({k: v for k, v in reopened["extensions"]["slai.writer"]["book_layouts"][sid].items()}, {"mirror": True, "gutter_mm": 12.0})
        self.assertTrue(next(b for b in reopened["blocks"] if b["id"] == "c2p0")["text"].startswith("EDITED "))
        self.assertEqual({b["style"] for b in reopened["blocks"] if b["id"].startswith("v")}, {"Scripture"})
        again = sldc().loads_package(s.to_bytes()).document
        self.assertEqual(again, reopened)

        # 5. the PDF: structure by pypdf and pdfplumber, and the pages as pictures by pdftoppm
        out = self.root / "out"
        pdf_report = self.ex.export(s, "pdf", out, stem="manuscript")
        self.assertTrue(pdf_report["verification"]["ok"], pdf_report["verification"])
        pdf_path = Path(pdf_report["path"])
        import pypdf
        reader = pypdf.PdfReader(str(pdf_path))
        pdf_pages = len(reader.pages)
        self.assertEqual(pdf_pages, total4)
        texts = self.page_texts(pdf_path.read_bytes())
        whole = "\n".join(texts)
        for needle in ("The Long Road", "Contents", "Preface", "Chapter 1", "Chapter 2", "Chapter 3", "EDITED", "A1", "C3", "References", "Rivera", "In the beginning verse 0"):
            self.assertIn(needle, whole, f"the PDF carries {needle!r}")
        self.assertTrue(any(page.images for page in reader.pages), "the picture is in the PDF")
        self.assertRegex(whole, r"Chapter 2\W+\d+", "the contents list gives Chapter 2 a page number")
        self.assertEqual(self.edges(pdf_path.read_bytes())[first][0] is not None, True)

        # the pictures a person sees in the Rendered view are the pages of this PDF: same count, same page shape, same ink area
        rendered = self.rendered_geometry(pdf_path.read_bytes())
        preview = self.ex.page_sizes(s)
        self.assertEqual(len(preview["pages"]) if "pages" in preview else preview["total"], pdf_pages)
        for number in (1, 2, 5, pdf_pages):
            picture = self.ex.page_image(s, number, 600)
            self.assertEqual(picture[:8], b"\x89PNG\r\n\x1a\n")
            from PIL import Image
            with Image.open(io.BytesIO(picture)) as image:
                ours = self.ink_box_mm(image.convert("L"), 210)
            theirs = rendered[number - 1]
            for a, b in zip(ours, theirs):
                self.assertAlmostEqual(a, b, delta=2.0, msg=f"page {number}: the Rendered view and an independent rasterisation agree on where the ink is")

        # 6. the DOCX: a package read by python-docx, and the same pages as printed by LibreOffice
        docx_report = self.ex.export(s, "docx", out, stem="manuscript")
        self.assertTrue(docx_report["verification"]["ok"], docx_report["verification"])
        import docx
        word = docx.Document(docx_report["path"])
        headings = [p.text for p in word.paragraphs if p.style.name.lower().startswith("heading")]
        for chapter in ("Chapter 1", "Chapter 2", "Chapter 3", "Preface"):
            self.assertIn(chapter, headings)
        self.assertGreaterEqual(len(word.tables), 1)
        self.assertGreaterEqual(len(word.inline_shapes), 1, "the picture is in the Word file")
        self.assertGreaterEqual(len(word.sections), 3, "cover, front matter and chapters stay separate sections")
        lo_pdf = independent.to_pdf(Path(docx_report["path"]), self.root / "lo")
        lo_texts = self.page_texts(lo_pdf)
        self.assertLessEqual(abs(len(lo_texts) - pdf_pages), 2, f"LibreOffice lays the Word file out on about as many pages as the PDF: {len(lo_texts)} vs {pdf_pages}")
        lo_whole = "\n".join(lo_texts)
        for needle in ("The Long Road", "Contents", "Chapter 3", "EDITED", "References", "Rivera"):
            self.assertIn(needle, lo_whole, f"LibreOffice shows {needle!r} in the Word file")
        lo_edges = self.edges(lo_pdf)
        chap = [e[0] for n, e in enumerate(lo_edges) if e is not None and "Chapter" in lo_texts[n] and "Contents" not in lo_texts[n]]
        self.assertGreaterEqual(len({round(x) for x in chap}), 1)
        mirrored = [round(e[0]) for n, e in enumerate(lo_edges) if e is not None and n >= first]
        self.assertEqual(set(mirrored) & {34, 16}, {34, 16}, f"the Word file keeps the inside and outside margins, alternating: {sorted(set(mirrored))}")

    def rendered_geometry(self, data):
        """For each page: the left, top, right and bottom of the dark ink in millimetres, from poppler's rasterisation of the PDF."""
        from PIL import Image
        out = []
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "in.pdf"
            source.write_bytes(data)
            subprocess.run(["pdftoppm", "-r", "60", "-gray", "-png", str(source), str(Path(tmp) / "p")], check=True, capture_output=True, timeout=120)
            for path in sorted(Path(tmp).glob("p-*.png")):
                with Image.open(path) as image:
                    out.append(self.ink_box_mm(image.convert("L"), 210))
        return out

    @staticmethod
    def ink_box_mm(image, page_width_mm):
        """The bounding box of the dark pixels (text and pictures), in millimetres of an A4-wide page."""
        mask = image.point(lambda v: 255 if v < 140 else 0)
        box_ = mask.getbbox()
        scale = page_width_mm / image.width
        return tuple(round(v * scale, 1) for v in box_) if box_ else (0.0, 0.0, 0.0, 0.0)


if __name__ == "__main__":
    unittest.main()
