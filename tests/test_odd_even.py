"""Odd and even pages with their own header and footer, from the operation to the pages read back by independent software.

Stored with the book layout of a section (``book_layouts[section]``: ``odd_even``, ``header_even``, ``footer_even``), so the core SLDC header and footer stay what
every reader understands. Left-hand pages (every even one by position in the document) use the even text; a band without even text uses the ordinary one, with its
edges swapped in a mirrored section. Checked through the operations (validation, undo, section breaks, save and reopen) and in PDF (pdfplumber), DOCX (python-docx),
and DOCX/ODT/RTF as printed by LibreOffice.
"""
from __future__ import annotations

import io
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.ops import OpError
from applications.slai_writer.session import sldc
from . import independent
from .helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]
ODD_HEAD, EVEN_HEAD, EVEN_FOOT = "ODDHEAD", "EVENHEAD", "EVENFOOT"


def build(test: Workbench, pages: int = 6):
    s = test.new_session("blank", title="Running heads", name="oddeven")
    last = s.doc["blocks"][-1]["id"]
    for n in range(pages):
        s.apply({"op": "block_insert", "after": last, "block": {"id": f"p{n}", "type": "paragraph", "text": f"Page text {n}.",
                                                                "attributes": {"page_break_before": n > 0}}}, None)
        last = f"p{n}"
    s.apply({"op": "page_setup", "header": {"left": ODD_HEAD, "right": "R {page}"}, "footer": {"center": "{page}"}}, None)
    return s


class Operations(Workbench):
    def book(self, s):
        return ((s.doc.get("extensions") or {}).get("slai.writer") or {}).get("book_layouts") or {}

    def test_it_is_stored_with_the_book_layout_and_the_core_header_is_untouched(self):
        s = build(self, 2)
        before = [dict(x) for x in s.doc["sections"]]
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}, "footer_even": {"right": "{page}"}}, None)
        entry = next(iter(self.book(s).values()))
        self.assertEqual(entry, {"odd_even": True, "header_even": {"left": EVEN_HEAD}, "footer_even": {"right": "{page}"}})
        after = s.doc["sections"]
        self.assertEqual([x.get("header") for x in after], [x.get("header") for x in before])
        self.assertEqual([x.get("footer") for x in after], [x.get("footer") for x in before])

    def test_text_that_the_format_cannot_carry_is_refused_and_changes_nothing(self):
        s = build(self, 2)
        snapshot = (s.version, dict(s.doc.get("extensions") or {}))
        for bad in ({"header_even": {"left": "{nope}"}}, {"header_even": {"left": "x" * 501}}, {"header_even": {"middle": "x"}}, {"header_even": "text"},
                    {"footer_even": {"left": "{page"}}, {"odd_even": "yes"}):
            with self.assertRaises(OpError, msg=str(bad)):
                s.apply({"op": "page_layout", "scope": "document", **{"odd_even": True, **bad}}, None)
            self.assertEqual((s.version, dict(s.doc.get("extensions") or {})), snapshot, str(bad))

    def test_even_text_without_the_setting_on_is_refused_rather_than_dropped_silently(self):
        s = build(self, 2)
        with self.assertRaises(OpError):
            s.apply({"op": "page_layout", "scope": "document", "header_even": {"left": "x"}}, None)

    def test_turning_it_off_takes_the_even_text_with_it_and_undo_brings_it_back(self):
        s = build(self, 2)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}}, None)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": None, "header_even": None, "footer_even": None}, None)
        self.assertEqual(self.book(s), {})
        s.undo(None)
        self.assertEqual(next(iter(self.book(s).values())), {"odd_even": True, "header_even": {"left": EVEN_HEAD}})

    def test_a_new_section_starts_like_the_one_before_it_and_the_setting_survives_saving(self):
        s = build(self, 4)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "footer_even": {"left": EVEN_FOOT}}, None)
        s.apply({"op": "section_break", "block": "p2"}, None)
        entries = list(self.book(s).values())
        self.assertEqual(len(entries), 2)
        self.assertTrue(all(e == {"odd_even": True, "footer_even": {"left": EVEN_FOOT}} for e in entries))
        reopened = sldc().loads_package(s.to_bytes()).document
        self.assertEqual(list(reopened["extensions"]["slai.writer"]["book_layouts"].values()), entries)

    def test_it_can_be_given_to_one_section_only(self):
        s = build(self, 4)
        s.apply({"op": "section_break", "block": "p2"}, None)
        second = next(b for b in s.doc["blocks"] if b["id"] == "p2")["section"]
        s.apply({"op": "page_layout", "scope": "section", "section": second, "odd_even": True, "header_even": {"center": EVEN_HEAD}}, None)
        self.assertEqual(list(self.book(s)), [second])


class Exports(Workbench):
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
        independent.need(self, "LibreOffice", independent.soffice() is not None, "install it or put 'soffice' on PATH")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=8 * 1024 * 1024, data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)

    def pages(self, data: bytes) -> list[str]:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return [p.extract_text() or "" for p in pdf.pages]

    def first_and_last_lines(self, text: str) -> tuple[str, str]:
        lines = [x for x in text.splitlines() if x.strip()]
        return lines[0], lines[-1]

    def assert_alternates(self, texts: list[str], label: str, even_head=EVEN_HEAD, even_foot=EVEN_FOOT):
        self.assertGreaterEqual(len(texts), 6, label)
        for n, text in enumerate(texts[:6], 1):
            if n % 2 == 0:
                self.assertIn(even_head, text, f"{label}: page {n} is a left-hand page and has the even header")
                self.assertIn(even_foot, text, f"{label}: page {n} has the even footer")
                self.assertNotIn(ODD_HEAD, text, f"{label}: page {n} does not have the ordinary header")
            else:
                self.assertIn(ODD_HEAD, text, f"{label}: page {n} is a right-hand page and has the ordinary header")
                self.assertNotIn(even_head, text, f"{label}: page {n}")
                self.assertNotIn(even_foot, text, f"{label}: page {n}")

    def test_pdf_has_the_even_text_on_every_left_hand_page_and_the_ordinary_text_on_the_others(self):
        s = build(self)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}, "footer_even": {"left": EVEN_FOOT}}, None)
        self.assert_alternates(self.pages(self.ex.print_pdf(s)), "pdf")

    def test_page_number_fields_are_filled_in_on_even_pages(self):
        s = build(self)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "footer_even": {"right": "Even {page} of {pages}"}}, None)
        texts = self.pages(self.ex.print_pdf(s))
        self.assertIn("Even 2 of 6", texts[1])
        self.assertIn("Even 4 of 6", texts[3])

    def test_off_means_every_page_has_the_ordinary_text(self):
        s = build(self)
        texts = self.pages(self.ex.print_pdf(s))
        for n, text in enumerate(texts[:6], 1):
            self.assertIn(ODD_HEAD, text, f"page {n}")

    def test_a_band_with_no_even_text_uses_the_ordinary_one_and_swaps_its_edges_in_a_book(self):
        s = build(self)
        s.apply({"op": "page_layout", "scope": "document", "mirror": True, "odd_even": True, "footer_even": {"left": EVEN_FOOT}}, None)
        import pdfplumber
        with pdfplumber.open(io.BytesIO(self.ex.print_pdf(s))) as pdf:
            left_hand, right_hand = pdf.pages[1], pdf.pages[2]
            def position(page, word):
                hit = next(w for w in page.extract_words() if w["text"] == word)
                return hit["x0"] / page.width
            self.assertLess(position(right_hand, ODD_HEAD), 0.5, "on a right-hand page the ordinary header's left text sits on the left")
            self.assertGreater(position(left_hand, ODD_HEAD), 0.5, "on a left-hand page the same text trades sides")
            self.assertIn(EVEN_FOOT, left_hand.extract_text())
            self.assertNotIn(EVEN_FOOT, right_hand.extract_text())

    def test_docx_is_paired_and_each_even_page_reads_the_even_text_in_the_reader_and_in_libreoffice(self):
        s = build(self)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}, "footer_even": {"left": EVEN_FOOT}}, None)
        report = self.ex.export(s, "docx", self.root / "out", stem="oe")
        self.assertTrue(report["verification"]["ok"], report["verification"])
        import docx
        word = docx.Document(report["path"])
        self.assertTrue(word.settings.odd_and_even_pages_header_footer, "Word is told to keep the two apart")
        section = word.sections[0]
        self.assertIn(ODD_HEAD, "\n".join(p.text for p in section.header.paragraphs))
        self.assertIn(EVEN_HEAD, "\n".join(p.text for p in section.even_page_header.paragraphs))
        self.assertIn(EVEN_FOOT, "\n".join(p.text for p in section.even_page_footer.paragraphs))
        self.assert_alternates(self.pages(independent.to_pdf(Path(report["path"]), self.root / "lo-docx")), "docx in LibreOffice")

    def test_odt_and_rtf_as_libreoffice_prints_them(self):
        s = build(self)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}, "footer_even": {"left": EVEN_FOOT}}, None)
        for fmt in ("odt", "rtf"):
            report = self.ex.export(s, fmt, self.root / "out", stem="oe")
            self.assertTrue(report["verification"]["ok"], (fmt, report["verification"]))
            self.assert_alternates(self.pages(independent.to_pdf(Path(report["path"]), self.root / f"lo-{fmt}")), fmt)

    def test_odt_says_so_when_unequal_margins_make_left_hand_headers_impossible(self):
        s = build(self)
        s.apply({"op": "page_setup", "page": {"margins_mm": {"left": 30, "right": 15}}}, None)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "header_even": {"left": EVEN_HEAD}}, None)
        report = self.ex.export(s, "odt", self.root / "out", stem="unequal")
        text = " ".join(str(w) for w in report.get("warnings", []) + [i.get("message", "") for i in report["verification"].get("issues", [])])
        self.assertIn("left-hand pages their own header", text)

    def test_a_section_without_the_setting_keeps_its_ordinary_header_on_every_page(self):
        s = build(self, 6)
        s.apply({"op": "section_break", "block": "p3"}, None)
        first = s.doc["blocks"][0]["section"] if s.doc["blocks"][0].get("section") else s.doc["sections"][0]["id"]
        s.apply({"op": "page_layout", "scope": "section", "section": first, "odd_even": True, "header_even": {"left": EVEN_HEAD}}, None)
        texts = self.pages(self.ex.print_pdf(s))
        self.assertIn(EVEN_HEAD, texts[1])
        self.assertIn(ODD_HEAD, texts[5], "page 6 is in the second section, which did not ask for it")
        self.assertNotIn(EVEN_HEAD, texts[5])


if __name__ == "__main__":
    unittest.main()
