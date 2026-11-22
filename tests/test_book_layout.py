"""Mirrored margins and the binding gutter: the data model, the arithmetic, and what a PDF reader independently sees on every page."""
from __future__ import annotations

import copy
import io
import json
import unittest
from pathlib import Path

from applications.slai_writer import book, ops
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange

from . import independent
from .helpers import Workbench

MM_PT = 72 / 25.4
LOREM = "The quick brown fox jumps over the lazy dog. " * 12
FIXTURE = Path(__file__).with_name("fixtures") / "margin_cases.json"


def sample(blocks=3, margins=None):
    return {"blocks": [{"id": f"b{i}", "type": "paragraph", "text": f"para {i}", "section": "s1"} for i in range(1, blocks + 1)],
            "sections": [{"id": "s1", "page": {"size": "A4", "margins_mm": margins or {"top": 25, "right": 15, "bottom": 25, "left": 20}}}]}


class Arithmetic(unittest.TestCase):
    def test_shared_cases_hold(self):
        """The same table is read by the TypeScript tests: the editor, the server and the writers cannot drift apart."""
        for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case["name"]):
                for physical, expected in case["expect"].items():
                    got = book.effective_margins(case["page"], case.get("book"), int(physical))
                    self.assertEqual({k: round(v, 3) for k, v in got.items()}, expected, f"page {physical}")

    def test_gutter_is_counted_once_and_the_stored_margins_are_kept(self):
        page = {"size": "A4", "margins_mm": {"top": 25, "bottom": 25, "left": 20, "right": 15}}
        entry = {"mirror": True, "gutter_mm": 5}
        odd, even = book.effective_margins(page, entry, 1), book.effective_margins(page, entry, 2)
        self.assertEqual((odd["left"], odd["right"]), (25, 15))
        self.assertEqual((even["left"], even["right"]), (15, 25))
        self.assertAlmostEqual(book.content_mm(page, entry)[0], 210 - 20 - 15 - 5)
        self.assertEqual(page["margins_mm"], {"top": 25, "bottom": 25, "left": 20, "right": 15})   # never rewritten to carry the gutter

    def test_printed_numbers_do_not_decide_the_side(self):
        page = {"size": "A4", "margins_mm": {"top": 25, "bottom": 25, "left": 20, "right": 15}}
        self.assertEqual(book.effective_margins(page, {"mirror": True}, 7)["left"], 20)
        self.assertEqual(book.effective_margins(page, {"mirror": True}, 8)["left"], 15)

    def test_page_sizes_match_the_format(self):
        from applications.tools import slai
        self.assertEqual(book.PAGE_SIZES_MM, dict(slai.sldc()._PAGE_SIZES_MM))


class Operation(unittest.TestCase):
    def test_enable_and_scopes(self):
        doc = sample(4)
        ops.apply_operation(doc, {"op": "page_layout", "scope": "document", "mirror": True, "gutter_mm": 5, "margins_mm": {"inside": 20, "outside": 15}})
        self.assertEqual(doc["extensions"]["slai.writer"]["book_layouts"], {"s1": {"mirror": True, "gutter_mm": 5}})
        self.assertEqual(doc["sections"][0]["page"]["margins_mm"], {"top": 25, "right": 15.0, "bottom": 25, "left": 20.0})
        ops.apply_operation(doc, {"op": "page_layout", "scope": "from_here", "block": "b3", "gutter_mm": 8})
        self.assertEqual([s["id"] for s in doc["sections"]], ["s1", "s2"])
        self.assertEqual([b["section"] for b in doc["blocks"]], ["s1", "s1", "s2", "s2"])
        books = doc["extensions"]["slai.writer"]["book_layouts"]
        self.assertEqual((books["s1"]["gutter_mm"], books["s2"]["gutter_mm"]), (5, 8))
        ops.apply_operation(doc, {"op": "page_layout", "scope": "sections", "sections": ["s1"], "mirror": False})
        self.assertNotIn("mirror", doc["extensions"]["slai.writer"]["book_layouts"]["s1"])
        self.assertTrue(doc["extensions"]["slai.writer"]["book_layouts"]["s2"]["mirror"])

    def test_one_undo_step_restores_everything(self):
        doc = sample(3)
        before = copy.deepcopy(doc)
        undo, _, _ = ops.apply_operation(doc, {"op": "page_layout", "scope": "from_here", "block": "b2", "mirror": True, "gutter_mm": 6,
                                               "margins_mm": {"inside": 22, "outside": 14}})
        ops.apply_undo(doc, undo)
        self.assertEqual(doc, before)

    def test_invalid_settings_change_nothing(self):
        doc = sample(2)
        before = copy.deepcopy(doc)
        for bad in ({"gutter_mm": -1}, {"gutter_mm": 500}, {"gutter_mm": "5"}, {"gutter_position": "bottom"}, {"mirror": "yes"},
                    {"margins_mm": {"left": -3}}, {"margins_mm": {"inside": 10}}, {"scope": "nowhere"},
                    {"margins_mm": {"left": 150, "right": 40}},                        # leaves 20 mm
                    {"mirror": True, "gutter_mm": 90, "margins_mm": {"inside": 50, "outside": 50}}):
            with self.subTest(bad), self.assertRaises(ops.OpError):
                ops.apply_operation(doc, {"op": "page_layout", "scope": "document", **bad})
            self.assertEqual(doc, before)

    def test_inside_outside_and_left_right_are_one_setting(self):
        doc = sample(1)
        with self.assertRaises(ops.OpError):
            ops.apply_operation(doc, {"op": "page_layout", "scope": "document", "mirror": True, "margins_mm": {"left": 20, "inside": 30}})

    def test_section_break_and_deleted_sections_keep_the_extension_in_step(self):
        doc = sample(3)
        ops.apply_operation(doc, {"op": "page_layout", "scope": "document", "mirror": True, "gutter_mm": 4})
        ops.apply_operation(doc, {"op": "section_break", "block": "b2"})
        self.assertEqual(doc["extensions"]["slai.writer"]["book_layouts"]["s2"], {"mirror": True, "gutter_mm": 4})   # the new section looks like the one before
        doc["sections"] = [s for s in doc["sections"] if s["id"] != "s2"]
        for b in doc["blocks"]:
            b["section"] = "s1"
        ops.apply_operation(doc, {"op": "text", "block": "b1", "start": 0, "end": 0, "insert": "x"})
        self.assertEqual(list(doc["extensions"]["slai.writer"]["book_layouts"]), ["s1"])

    def test_defaults_store_nothing_and_a_plain_document_is_untouched(self):
        doc = sample(1)
        ops.apply_operation(doc, {"op": "page_layout", "scope": "document", "mirror": False, "gutter_mm": 0})
        self.assertNotIn("extensions", doc)

    def test_top_gutter_and_right_binding(self):
        page = {"size": "A4", "margins_mm": {"top": 25, "bottom": 25, "left": 20, "right": 15}}
        self.assertEqual(book.effective_margins(page, {"gutter_mm": 10, "gutter_position": "top"}, 1)["top"], 35)
        self.assertEqual(book.effective_margins(page, {"gutter_mm": 10, "gutter_position": "right"}, 1)["right"], 25)
        self.assertEqual(book.effective_margins(page, {"gutter_mm": 10}, 1)["left"], 30)


class Exports(Workbench):
    """The PDF a person prints is read back by a library that is not the one that wrote it."""

    def exchange(self):
        root = Path(__file__).resolve().parents[3]
        self.app.settings.data_dir = self.root / "data"
        self.app.docmaster = DocumasterLink(root, self.root / "data").load()
        independent.need(self, "Documaster", self.app.docmaster.available, str(self.app.docmaster.reason))
        self.addCleanup(self.app.docmaster.close)
        return Exchange(self.app)

    def manuscript(self, pages=5):
        session = self.new_session("blank", title="Book", name="book")
        last = session.doc["blocks"][-1]["id"]
        for i in range(pages * 4):
            session.apply({"op": "block_insert", "after": last, "block": {"id": f"p{i}", "type": "paragraph", "text": f"Paragraph {i}. " + LOREM * 3,
                                                                           "attributes": {"page_break_before": True} if i % 4 == 0 else {}}}, None)
            last = f"p{i}"
        return session

    def left_edges(self, data):
        return independent.text_edges(data)

    def test_pdf_pages_alternate_and_the_text_width_never_changes(self):
        exchange = self.exchange()
        session = self.manuscript()
        session.apply({"op": "page_layout", "scope": "document", "mirror": True, "gutter_mm": 5, "margins_mm": {"inside": 20, "outside": 15}}, None)
        edges = self.left_edges(exchange.print_pdf(session))
        self.assertGreaterEqual(len(edges), 5)
        for number, edge in enumerate(edges, 1):
            self.assertIsNotNone(edge, f"page {number} has text")
            left, right = edge
            if number % 2:
                self.assertAlmostEqual(left, 25, delta=1.0, msg=f"page {number} is a right-hand page: inside 20 + gutter 5 on its left")
                self.assertGreaterEqual(right, 14.0)
            else:
                self.assertAlmostEqual(left, 15, delta=1.0, msg=f"page {number} is a left-hand page: outside 15 on its left")
                self.assertGreaterEqual(right, 24.0)

    def test_not_mirrored_stays_the_same_on_every_page_and_the_gutter_is_added_once(self):
        exchange = self.exchange()
        session = self.manuscript(3)
        session.apply({"op": "page_layout", "scope": "document", "gutter_mm": 10, "margins_mm": {"left": 20, "right": 15}}, None)
        for left, _right in self.left_edges(exchange.print_pdf(session)):
            self.assertAlmostEqual(left, 30, delta=1.0)

    def test_page_numbers_follow_the_outer_edge_and_the_labels_follow_the_numbering(self):
        exchange = self.exchange()
        session = self.manuscript(4)
        session.apply({"op": "page_setup", "footer": {"right": "{page}"}}, None)
        session.apply({"op": "page_layout", "scope": "document", "mirror": True, "margins_mm": {"inside": 25, "outside": 15}}, None)
        import pdfplumber
        with pdfplumber.open(io.BytesIO(exchange.print_pdf(session))) as pdf:
            for number, page in enumerate(pdf.pages, 1):
                words = [w for w in page.extract_words() if w["top"] > page.height - 60]
                self.assertTrue(words, f"page {number} has a footer")
                x = words[-1]["x0"]
                if number % 2:
                    self.assertGreater(x, page.width / 2, f"page {number}: the number sits on the right, the outer edge of a right-hand page")
                else:
                    self.assertLess(x, page.width / 2, f"page {number}: the number sits on the left, the outer edge of a left-hand page")


    def test_other_formats_opened_by_libreoffice_alternate_the_same_way(self):
        """DOCX, ODT and RTF are written by Documaster, opened and printed by LibreOffice, and measured: not by the code that wrote them."""
        independent.need(self, "LibreOffice", independent.soffice() is not None, "install it or set PATH so that 'soffice' is found")
        exchange = self.exchange()
        session = self.manuscript(4)
        session.apply({"op": "page_layout", "scope": "document", "mirror": True, "gutter_mm": 5, "margins_mm": {"inside": 20, "outside": 15}}, None)
        for fmt in ("docx", "odt", "rtf"):
            with self.subTest(fmt):
                out = self.root / f"out-{fmt}"
                report = exchange.export(session, fmt, out)
                pdf = independent.to_pdf(Path(report["path"]), out)
                edges = independent.text_edges(pdf)
                self.assertGreaterEqual(len(edges), 4, f"{fmt}: pages")
                for number, edge in enumerate(edges, 1):
                    self.assertIsNotNone(edge)
                    expected = 25 if number % 2 else 15
                    self.assertAlmostEqual(edge[0], expected, delta=1.5, msg=f"{fmt} page {number}: left edge of the text")

    def test_a_mirrored_word_document_comes_back_as_mirrored_margins(self):
        """What Writer writes to DOCX is read back as the same book layout: the inside and outside margins, the gutter, mirrored."""
        exchange = self.exchange()
        self.app.settings.max_upload_bytes = 20 * 1024 * 1024
        session = self.manuscript(2)
        session.apply({"op": "page_layout", "scope": "document", "mirror": True, "gutter_mm": 5, "margins_mm": {"inside": 20, "outside": 15}}, None)
        report = exchange.export(session, "docx", self.root / "round")
        again = exchange.import_path(Path(report["path"]), password=None, profile="guest")
        doc = again.doc
        entry = doc["extensions"]["slai.writer"]["book_layouts"]
        self.assertEqual(list(entry.values())[0], {"mirror": True, "gutter_mm": 5.0})
        margins = doc["sections"][0]["page"]["margins_mm"]
        self.assertEqual((round(margins["left"]), round(margins["right"])), (20, 15))
