"""A table looks the same in the editor and in what leaves Writer: its style, borders, shading, widths and heights, in PDF (and so in the Rendered View, which
shows that PDF), Word, OpenDocument and RTF.

The expectation is the editor's own resolution (``table_styles.resolve``, which a golden file ties to the browser's resolver); the drawn result is read back with
software that did not write it: pdfplumber for the PDF, python-docx for Word, LibreOffice and pdftoppm for the others.
"""
from __future__ import annotations

import io
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer import table_styles as ts
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.tablegrid import BORDERS_KEY, CELLS_KEY, LAYOUT_KEY, STYLE_KEY
from . import independent, pdf_tables
from .helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]
GALLERY = ["default", "plain", "simple_grid", "minimal_borders", "horizontal_rules", "header_emphasis", "alternating_rows", "alternating_columns",
           "professional_report", "academic", "financial", "modern_accent", "dark_header"]
ROWS, COLS = 5, 4


def table(rows=ROWS, cols=COLS, merges=False):
    grid = [[{"text": f"r{r}c{c}"} for c in range(cols)] for r in range(rows)]
    if merges:                                       # a 2x2 merge in the body, away from the first row and first column
        grid[2][2] = {"text": "r2c2", "colspan": 2, "rowspan": 2}
        del grid[2][3]
        del grid[3][2:4]
    return {"columns": cols, "header_rows": 1, "rows": grid}


def hex_close(a, b):
    return a == b or (a and b and all(abs(int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) <= 2 for i in (1, 3, 5)))


class Base(Workbench):
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
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=8 * 1024 * 1024, data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)

    def document(self, tables):
        """One table per page (a page break before each). ``tables`` is a list of (table, extensions)."""
        s = self.new_session("blank", title="Tables", name="tables")
        last = s.doc["blocks"][-1]["id"]
        ops = []
        for n, (data, ext) in enumerate(tables):
            ops.append({"op": "block_insert", "after": last, "block": {"id": f"t{n}", "type": "table", "text": "", "table": data, "extensions": ext,
                                                                      "attributes": {"page_break_before": n > 0}}})
            last = f"t{n}"
        s.apply({"op": "batch", "ops": ops}, None)
        return s

    def expected(self, session, n):
        block = next(b for b in session.doc["blocks"] if b["id"] == f"t{n}")
        custom = ((session.doc.get("extensions") or {}).get("slai.writer") or {}).get("table_styles") or {}
        return ts.export_look(block, custom)

    def pdf_pages(self, session):
        import pdfplumber
        return pdfplumber.open(io.BytesIO(self.ex.print_pdf(session)))


class Pdf(Base):
    def assert_page_matches(self, page, look, label, rows=ROWS, cols=COLS):
        got = pdf_tables.read(page, rows, cols)
        for key, spec in look["h"].items():
            self.assertIn(key, got["h"], f"{label}: the horizontal border {key} {spec} is not drawn")
            self.assertTrue(any(hex_close(g["color"], spec["color"]) and abs(g["width"] - spec["width_pt"]) < 0.06 or spec["style"] == "double" for g in got["h"][key]),
                            f"{label}: border {key} should be {spec}, the PDF has {got['h'][key]}")
        for key, spec in look["v"].items():
            self.assertIn(key, got["v"], f"{label}: the vertical border {key} {spec} is not drawn")
            self.assertTrue(any(hex_close(g["color"], spec["color"]) and abs(g["width"] - spec["width_pt"]) < 0.06 or spec["style"] == "double" for g in got["v"][key]),
                            f"{label}: border {key} should be {spec}, the PDF has {got['v'][key]}")
        for key in set(got["h"]) - set(look["h"]):
            self.fail(f"{label}: the PDF draws a horizontal border {key} the style does not have: {got['h'][key]}")
        for key in set(got["v"]) - set(look["v"]):
            self.fail(f"{label}: the PDF draws a vertical border {key} the style does not have: {got['v'][key]}")
        for key, cell in look["cells"].items():
            self.assertTrue(hex_close(got["fills"].get(key), cell["fill"]), f"{label}: cell {key} fill should be {cell['fill']}, the PDF has {got['fills'].get(key)}")

    def test_every_style_of_the_gallery_is_drawn_as_the_editor_resolves_it(self):
        s = self.document([(table(), {STYLE_KEY: {"preset": name}}) for name in GALLERY])
        with self.pdf_pages(s) as pdf:
            self.assertEqual(len(pdf.pages), len(GALLERY))
            for n, name in enumerate(GALLERY):
                with self.subTest(style=name):
                    self.assert_page_matches(pdf.pages[n], self.expected(s, n), name)

    def test_options_accents_and_borders_set_by_hand_are_kept(self):
        by_hand = {STYLE_KEY: {"preset": "simple_grid", "accent": "#C0392B"}, CELLS_KEY: {"1,0": {"background": "#FFEE00"}, "2,1": {"background": "#00AACC", "valign": "middle"}},
                   BORDERS_KEY: {"h": {"1,1": {"color": "#FF0000", "width_pt": 2, "style": "solid"}, "3,2": None},
                                 "v": {"2,2": {"color": "#00AA00", "width_pt": 1.5, "style": "solid"}}}}
        options = {STYLE_KEY: {"preset": "plain", "header_row": True, "first_column": True, "banded_rows": True, "banded_columns": True, "accent": "#117733"}}
        s = self.document([(table(), by_hand), (table(), options), (table(), {STYLE_KEY: {"preset": "alternating_rows", "header_row": False, "banded_rows": False}})])
        with self.pdf_pages(s) as pdf:
            for n, label in enumerate(("by hand", "options on", "options off")):
                with self.subTest(table=label):
                    self.assert_page_matches(pdf.pages[n], self.expected(s, n), label)
        look = self.expected(s, 0)
        self.assertEqual(look["h"]["1,1"], {"color": "#FF0000", "width_pt": 2, "style": "solid"})
        self.assertNotIn("3,2", look["h"], "an edge set to 'no border' stays empty")

    def test_merged_cells_keep_their_outer_borders_and_have_none_inside(self):
        s = self.document([(table(merges=True), {STYLE_KEY: {"preset": "simple_grid"}}), (table(merges=True), {STYLE_KEY: {"preset": "alternating_rows"}})])
        with self.pdf_pages(s) as pdf:
            for n in (0, 1):
                look = self.expected(s, n)
                self.assertNotIn("3,2", look["h"], "inside the merged cell")
                self.assertNotIn("2,3", look["v"], "inside the merged cell")
                self.assert_page_matches(pdf.pages[n], look, f"merged {n}")

    def test_a_shared_edge_is_one_border_chosen_by_the_css_rule(self):
        thick, thin = {"color": "#112233", "width_pt": 2.0, "style": "solid"}, {"color": "#AABBCC", "width_pt": 0.5, "style": "solid"}
        self.assertEqual(ts.collapse(thin, thick), thick, "the wider border wins")
        self.assertEqual(ts.collapse(thick, None), thick, "a border beats no border")
        self.assertIsNone(ts.collapse(None, None))
        self.assertEqual(ts.collapse({**thin, "style": "dotted"}, {**thin, "style": "dashed", "color": "#000000"})["style"], "dashed", "dashed ranks above dotted")
        a, b = {**thin, "color": "#010101"}, {**thin, "color": "#020202"}
        self.assertEqual(ts.collapse(a, b), a, "a tie goes to the cell above or to the left")
        # a merged cell next to two cells whose borders disagree: one border per grid edge in the look
        block = {"type": "table", "table": table(merges=True), "extensions": {STYLE_KEY: {"preset": "plain"}, BORDERS_KEY: {"v": {"2,2": thick, "3,2": thin}}}}
        look = ts.export_look(block)
        self.assertEqual(look["v"]["2,2"], thick)

    def test_column_widths_and_row_heights_the_person_set_are_used(self):
        layout = {LAYOUT_KEY: {"column_widths_mm": [20, 50, 30, 60], "row_heights_mm": [14, 14, 14, 14, 14], "row_height_rule": "min", "fit": "fixed"},
                  STYLE_KEY: {"preset": "simple_grid"}}
        s = self.document([(table(), layout)])
        with self.pdf_pages(s) as pdf:
            got = pdf_tables.read(pdf.pages[0], ROWS, COLS)
        xs = sorted({round(c[0]["x"], 1) for k, c in got["v"].items() if k.startswith("0,")})
        widths = [round((b - a) * 25.4 / 72, 1) for a, b in zip(xs, xs[1:])]
        self.assertEqual(widths, [20.0, 50.0, 30.0, 60.0])
        ys = sorted({round(c[0]["y"], 1) for k, c in got["h"].items() if k.endswith(",0")})
        heights = [round((b - a) * 25.4 / 72, 1) for a, b in zip(ys, ys[1:])]
        self.assertEqual(heights, [14.0] * 5)

    def test_a_table_over_several_pages_repeats_its_header_with_its_look(self):
        data = table(rows=80)
        s = self.document([(data, {STYLE_KEY: {"preset": "dark_header"}})])
        with self.pdf_pages(s) as pdf:
            self.assertGreater(len(pdf.pages), 1)
            look = self.expected(s, 0)
            for page in pdf.pages[:2]:
                fills = [r for r in page.rects if r.get("fill") and _rgb(r["non_stroking_color"]) == look["cells"]["0,0"]["fill"]]
                self.assertTrue(fills, "the repeated header row keeps its shading")


class Docx(Base):
    """Word: the XML python-docx reads back, and what LibreOffice draws from the file (pixels)."""

    def export_docx(self, session):
        out = self.root / "docx_out"
        report = self.ex.export(session, "docx", out, stem="tables")
        return Path(report["path"])

    def test_cell_borders_and_shading_in_the_file_are_the_resolved_ones(self):
        import docx
        from docx.oxml.ns import qn
        by_hand = {STYLE_KEY: {"preset": "simple_grid", "accent": "#C0392B"}, CELLS_KEY: {"1,0": {"background": "#FFEE00"}},
                   BORDERS_KEY: {"h": {"1,1": {"color": "#FF0000", "width_pt": 2, "style": "solid"}, "3,2": None}, "v": {"2,2": {"color": "#00AA00", "width_pt": 1.5, "style": "solid"}}}}
        s = self.document([(table(), {STYLE_KEY: {"preset": "dark_header"}}), (table(), by_hand), (table(merges=True), {STYLE_KEY: {"preset": "alternating_rows"}})])
        document = docx.Document(str(self.export_docx(s)))
        self.assertEqual(len(document.tables), 3)
        for n, tbl in enumerate(document.tables):
            look = self.expected(s, n)
            with self.subTest(table=n):
                for r, row in enumerate(tbl._tbl.tr_lst):
                    col = 0
                    for tc in row.tc_lst:
                        tcPr = tc.tcPr
                        span = tcPr.find(qn("w:gridSpan"))
                        cs = int(span.get(qn("w:val"))) if span is not None else 1
                        vmerge = tcPr.find(qn("w:vMerge"))
                        if vmerge is None or vmerge.get(qn("w:val")) == "restart":
                            shd = tcPr.find(qn("w:shd"))
                            got = "#" + shd.get(qn("w:fill")) if shd is not None else None
                            want = look["cells"].get(f"{r},{col}", {}).get("fill")
                            self.assertTrue(hex_close(got, want) or (got is None and want in (None, "#FFFFFF")), f"cell {r},{col}: shading {got} should be {want}")
                            borders = tcPr.find(qn("w:tcBorders"))
                            for side, edge in (("top", look["h"].get(f"{r},{col}")), ("left", look["v"].get(f"{r},{col}")), ("right", look["v"].get(f"{r},{col + cs}"))):
                                el = borders.find(qn(f"w:{side}"))
                                self.assertIsNotNone(el, f"cell {r},{col}: {side} border missing")
                                if edge is None:
                                    self.assertEqual(el.get(qn("w:val")), "nil", f"cell {r},{col}: {side} should have no border")
                                else:
                                    self.assertEqual(el.get(qn("w:color")), edge["color"][1:].upper(), f"cell {r},{col} {side}")
                                    self.assertEqual(int(el.get(qn("w:sz"))), round(edge["width_pt"] * 8), f"cell {r},{col} {side}")
                        col += cs

    def test_libreoffice_draws_the_word_file_with_the_same_look(self):
        independent.need(self, "LibreOffice", bool(independent.soffice()), "soffice not found")
        by_hand = {STYLE_KEY: {"preset": "simple_grid", "accent": "#C0392B"}, CELLS_KEY: {"1,0": {"background": "#FFEE00"}},
                   BORDERS_KEY: {"h": {"1,1": {"color": "#FF0000", "width_pt": 2, "style": "solid"}, "3,2": None}, "v": {"2,2": {"color": "#00AA00", "width_pt": 1.5, "style": "solid"}}}}
        names = ["dark_header", "alternating_rows", "professional_report", "financial"]
        s = self.document([(table(), {STYLE_KEY: {"preset": n}}) for n in names] + [(table(), by_hand)])
        path = self.export_docx(s)
        pdf = independent.to_pdf(path, self.root / "lo")
        pdf_tables.check_pixels(self, pdf, [self.expected(s, n) for n in range(len(names) + 1)], ROWS, COLS, labels=names + ["by hand"])
        with self.assertRaises(AssertionError, msg="the probe must notice a table that does not look like what was asked for"):
            pdf_tables.check_pixels(self, pdf, [self.expected(s, 1), self.expected(s, 0), self.expected(s, 2), self.expected(s, 3), self.expected(s, 4)], ROWS, COLS, labels=names + ["x"])


class Lifecycle(Base):
    """A style changed after the table was inserted, undone, saved and opened again: the PDF follows each time."""

    def first_page(self, session):
        with self.pdf_pages(session) as pdf:
            return pdf_tables.read(pdf.pages[0], ROWS, COLS)

    def matches(self, session, label):
        got = self.first_page(session)
        look = self.expected(session, 0)
        self.assertEqual(sorted(got["h"]), sorted(look["h"]), label)
        self.assertEqual(sorted(got["v"]), sorted(look["v"]), label)
        for key, cell in look["cells"].items():
            self.assertTrue(hex_close(got["fills"].get(key), cell["fill"]), f"{label}: cell {key} should be {cell['fill']}, drawn {got['fills'].get(key)}")
        return look

    def test_changing_undoing_saving_and_reopening_keep_the_pdf_in_step(self):
        from applications.slai_writer.session import DocumentSession, sldc
        s = self.document([(table(), {})])
        plain = self.matches(s, "as inserted")
        s.apply({"op": "table_style", "block": "t0", "preset": "dark_header"}, None)
        dark = self.matches(s, "after choosing a style")
        self.assertNotEqual(plain["cells"]["0,0"], dark["cells"]["0,0"])
        s.apply({"op": "table_style", "block": "t0", "accent": "#C0392B"}, None)
        self.matches(s, "after choosing an accent")
        s.undo(None)
        self.assertEqual(self.matches(s, "after undo")["cells"], dark["cells"])
        s.redo(None)
        accent = self.matches(s, "after redo")
        # saved and opened again
        package = sldc().loads_package(s.to_bytes())
        again = DocumentSession(self.store, package, path=self.root / "docs" / "again.sldc", profile="guest")
        self.assertEqual(self.matches(again, "after reopening")["cells"], accent["cells"])
        s.apply({"op": "table_style", "block": "t0", "clear": True}, None)
        self.assertEqual(self.matches(s, "after clearing")["cells"].get("0,0"), plain["cells"].get("0,0"))


BY_HAND = {STYLE_KEY: {"preset": "simple_grid", "accent": "#C0392B"}, CELLS_KEY: {"1,0": {"background": "#FFEE00"}},
           BORDERS_KEY: {"h": {"1,1": {"color": "#FF0000", "width_pt": 2, "style": "solid"}, "3,2": None}, "v": {"2,2": {"color": "#00AA00", "width_pt": 1.5, "style": "solid"}}}}


class Others(Base):
    """OpenDocument and RTF, drawn by LibreOffice and read back as pixels."""

    def drawn(self, fmt, names):
        independent.need(self, "LibreOffice", bool(independent.soffice()), "soffice not found")
        s = self.document([(table(), {STYLE_KEY: {"preset": n}}) for n in names] + [(table(), BY_HAND)])
        path = Path(self.ex.export(s, fmt, self.root / f"{fmt}_out", stem="tables")["path"])
        pdf = independent.to_pdf(path, self.root / f"lo_{fmt}")
        return s, pdf

    def check(self, fmt):
        names = ["dark_header", "alternating_rows", "professional_report", "financial"]
        s, pdf = self.drawn(fmt, names)
        pdf_tables.check_pixels(self, pdf, [self.expected(s, n) for n in range(len(names) + 1)], ROWS, COLS, labels=[f"{fmt} {n}" for n in names] + [f"{fmt} by hand"])

    def test_opendocument_text_keeps_the_look(self):
        self.check("odt")

    def test_rtf_keeps_the_look(self):
        self.check("rtf")


def _rgb(colour):
    return pdf_tables._hex(colour)


if __name__ == "__main__":
    unittest.main()
