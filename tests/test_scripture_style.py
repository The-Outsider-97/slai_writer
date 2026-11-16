"""Scripture as a paragraph style: one definition, applied from the style gallery; the two columns are a section that the style makes and un-makes.
Empty / populated paragraphs, single and multiple selection, existing multi-column sections, repeated application, switching to Normal and
headings, undo / redo, save and reopen, PDF and DOCX export."""
import copy
import re
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer import columns as colmod
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.tests.helpers import Workbench
from applications.slai_writer.tests.test_columns import ColumnTests

try:
    import pdfplumber
except ImportError:                                    # pragma: no cover
    pdfplumber = None

ROOT = Path(__file__).resolve().parents[3]
APPLY = lambda a, b=None: {"op": "scripture_apply", "block": a, "end_block": b or a}            # noqa: E731
NORMAL = lambda block: {"op": "block_set", "block": block, "type": "paragraph", "style": None}   # noqa: E731


class Base(Workbench):
    make, ids, reopen, sections_of, layouts = (ColumnTests.make, ColumnTests.ids, ColumnTests.reopen, ColumnTests.sections_of, ColumnTests.layouts)


del ColumnTests            # imported for its helpers only; its own tests run in test_columns


class ScriptureStyleTests(Base):
    def state(self, s):
        doc = self.reopen(s)
        by = {b["id"]: b for b in doc["blocks"]}
        sec = self.sections_of(doc)
        return doc, by, {i: int(sec.get(b.get("section"), {}).get("columns", 1)) for i, b in by.items()}

    def cols(self, s):
        return self.state(s)[2]

    # -- the definition ------------------------------------------------------------------------------------------------------
    def test_defaults_are_the_specified_ones_and_the_client_reset_default_is_the_same(self):
        self.assertEqual(colmod.SCRIPTURE_PROPS, {"font_family": "Times New Roman", "font_size_pt": 11, "italic": True, "align": "left"})
        text = (Path(__file__).resolve().parents[1] / "src" / "client" / "named_styles.ts").read_text(encoding="utf-8")
        found = re.search(r"Scripture:\s*\{([^}]*)\}", text)
        self.assertIsNotNone(found, "the style manager's reset needs the same definition")
        import json
        client = json.loads("{" + re.sub(r"(\w+):", r'"\1":', found.group(1)) + "}")
        self.assertEqual(client, colmod.SCRIPTURE_PROPS)

    def test_a_definition_the_person_changed_is_kept_when_the_style_is_applied_again(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1]), None)
        s.apply({"op": "style_define", "kind": "paragraph", "name": "Scripture", "props": {**colmod.SCRIPTURE_PROPS, "font_size_pt": 13}}, None)
        s.apply(APPLY(ids[2]), None)
        self.assertEqual(self.reopen(s)["styles"]["paragraph"]["Scripture"]["font_size_pt"], 13)

    # -- applying ------------------------------------------------------------------------------------------------------------
    def test_empty_paragraph_gets_the_style_and_columns(self):
        s = self.make(3)
        ids = self.ids(s)
        s.apply({"op": "text", "block": ids[1], "start": 0, "end": 2, "insert": ""}, None)
        s.apply(APPLY(ids[1]), None)
        doc, by, cols = self.state(s)
        self.assertEqual(by[ids[1]]["style"], "Scripture")
        self.assertEqual(cols[ids[1]], 2)
        self.assertEqual((cols[ids[0]], cols[ids[2]]), (1, 1))

    def test_caret_in_one_paragraph_and_new_paragraphs_typed_after_it_stay_scripture(self):
        s = self.make(4)
        ids = self.ids(s)
        s.apply(APPLY(ids[1]), None)
        result = s.apply({"op": "split", "block": ids[1], "at": 2}, None)
        doc, by, cols = self.state(s)
        new = [b for b in doc["blocks"] if b["id"] not in ids][0]["id"]
        self.assertEqual(by[new]["style"], "Scripture")
        self.assertEqual((cols[ids[1]], cols[new]), (2, 2))
        self.assertEqual(by[new]["section"], by[ids[1]]["section"])
        self.assertEqual(cols[ids[0]], 1)

    def test_multi_paragraph_selection_is_one_section(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[3]), None)
        doc, by, cols = self.state(s)
        self.assertEqual({by[i]["section"] for i in ids[1:4]}, {by[ids[1]]["section"]})
        self.assertEqual([cols[i] for i in ids], [1, 2, 2, 2, 1, 1])
        self.assertEqual(len(doc["sections"]), 3)

    def test_repeated_application_changes_nothing(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[3]), None)
        before = copy.deepcopy(self.reopen(s))
        s.apply(APPLY(ids[1], ids[3]), None)
        s.apply(APPLY(ids[2]), None)
        after = self.reopen(s)
        self.assertEqual((after["sections"], after["blocks"], after["styles"]), (before["sections"], before["blocks"], before["styles"]))

    def test_inside_an_existing_three_column_section_the_rest_keeps_three_columns(self):
        s = self.make(8)
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[6], "columns": 3, "gap_mm": 7}, None)
        s.apply(APPLY(ids[4]), None)
        doc, by, cols = self.state(s)
        self.assertEqual([cols[i] for i in ids], [1, 1, 3, 3, 2, 3, 3, 1])
        gap = {i: self.sections_of(doc)[by[i]["section"]].get("column_gap_mm") for i in ids}
        self.assertEqual((gap[ids[2]], gap[ids[6]]), (7, 7))
        # and taking Scripture off again gives the three-column text back its section, as one section
        s.apply(NORMAL(ids[4]), None)
        doc, by, cols = self.state(s)
        self.assertEqual([cols[i] for i in ids], [1, 1, 3, 3, 1, 3, 3, 1])

    # -- switching away ------------------------------------------------------------------------------------------------------
    def test_switching_everything_to_normal_text_removes_the_columns_and_the_extra_sections(self):
        s = self.make()
        ids = self.ids(s)
        base = copy.deepcopy(self.reopen(s)["sections"])
        s.apply(APPLY(ids[1], ids[3]), None)
        for i in ids[1:4]:
            s.apply(NORMAL(i), None)
        doc, by, cols = self.state(s)
        self.assertEqual(set(cols.values()), {1})
        self.assertEqual(len(doc["sections"]), len(base), doc["sections"])
        self.assertTrue(all("style" not in b for b in doc["blocks"]))
        self.assertNotIn(colmod.LAYOUTS, (doc.get("extensions") or {}).get(colmod.WRITER_EXT, {}))

    def test_switching_the_middle_paragraph_splits_the_section_and_keeps_the_others(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[4]), None)
        s.apply(NORMAL(ids[2]), None)
        doc, by, cols = self.state(s)
        self.assertEqual([cols[i] for i in ids], [1, 2, 1, 2, 2, 1])
        self.assertEqual(by[ids[3]]["section"], by[ids[4]]["section"])

    def test_switching_to_a_heading_works_like_normal_text(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[2]), None)
        s.apply({"op": "block_set", "block": ids[1], "type": "heading", "attributes": {"level": 1}, "style": None}, None)
        doc, by, cols = self.state(s)
        self.assertEqual((by[ids[1]]["type"], cols[ids[1]], cols[ids[2]]), ("heading", 1, 2))

    def test_switching_back_to_scripture_after_normal_restores_the_columns(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[3]), None)
        s.apply(NORMAL(ids[2]), None)
        s.apply(APPLY(ids[2]), None)
        doc, by, cols = self.state(s)
        self.assertEqual([cols[i] for i in ids], [1, 2, 2, 2, 1, 1])
        self.assertEqual(len({by[i]["section"] for i in ids[1:4]}), 1, "coalesced again, no stray sections")

    def test_columns_the_person_set_by_hand_are_not_taken_away(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[3], "columns": 3}, None)
        s.apply({"op": "style_define", "kind": "paragraph", "name": "Scripture", "props": dict(colmod.SCRIPTURE_PROPS)}, None)
        s.apply({"op": "block_set", "block": ids[2], "style": "Scripture"}, None)         # the style alone changes no layout
        s.apply(NORMAL(ids[2]), None)
        self.assertEqual([self.cols(s)[i] for i in ids], [1, 3, 3, 3, 1, 1])
        s.apply(APPLY(ids[1], ids[3]), None)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[3], "columns": 3}, None)   # now they are the person's
        s.apply(NORMAL(ids[2]), None)
        self.assertEqual([self.cols(s)[i] for i in ids], [1, 3, 3, 3, 1, 1])

    def test_other_sections_are_never_touched_by_switching(self):
        s = self.make(8)
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[5], "end_block": ids[6], "columns": 4}, None)
        s.apply(APPLY(ids[1], ids[2]), None)
        before = {i: c for i, c in self.cols(s).items() if i in ids[3:]}
        s.apply(NORMAL(ids[1]), None)
        s.apply(NORMAL(ids[2]), None)
        self.assertEqual({i: c for i, c in self.cols(s).items() if i in ids[3:]}, before)

    def test_a_table_inside_the_passage_keeps_the_passage_in_one_section(self):
        s = self.make(6)
        ids = self.ids(s)
        s.apply({"op": "block_insert", "after": ids[2], "block": {"id": "tbl", "type": "table", "rows": 2, "columns": 2}}, None)
        s.apply(APPLY(ids[1], ids[3]), None)
        _, by, cols = self.state(s)
        self.assertEqual((cols[ids[1]], cols["tbl"], cols[ids[3]]), (2, 2, 2))
        self.assertNotIn("style", by["tbl"])

    # -- undo, redo, save --------------------------------------------------------------------------------------------------------
    def test_undo_and_redo_restore_style_and_columns_together(self):
        s = self.make()
        ids = self.ids(s)
        start = copy.deepcopy(self.reopen(s))
        s.apply(APPLY(ids[1], ids[3]), None)
        applied = copy.deepcopy(self.reopen(s))
        s.apply(NORMAL(ids[2]), None)
        switched = copy.deepcopy(self.reopen(s))
        s.undo(None)
        self.assertEqual(self.reopen(s)["blocks"], applied["blocks"])
        self.assertEqual(self.reopen(s)["sections"], applied["sections"])
        s.redo(None)
        self.assertEqual(self.reopen(s)["sections"], switched["sections"])
        s.undo(None)
        s.undo(None)
        self.assertEqual(self.reopen(s)["sections"], start["sections"])
        self.assertTrue(all("style" not in b for b in self.reopen(s)["blocks"]))

    def test_save_and_reopen_then_switch_away(self):
        s = self.make()
        ids = self.ids(s)
        s.apply(APPLY(ids[1], ids[3]), None)
        from applications.slai_writer.session import DocumentSession
        again = DocumentSession(self.store, __import__("applications.slai_writer.session", fromlist=["sldc"]).sldc().loads_package(s.to_bytes()),
                                path=self.root / "docs" / "again.sldc", profile="guest")
        again.apply(NORMAL(ids[1]), None)
        again.apply(NORMAL(ids[2]), None)
        again.apply(NORMAL(ids[3]), None)
        doc = sldc_doc = self.reopen(again)
        self.assertEqual({int(x.get("columns", 1)) for x in doc["sections"]}, {1})


class ScriptureExportTests(Base):
    """Documaster output: the Scripture passage is two columns in the PDF and in the Word file, and the text around it is not."""
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
        if not self.dm.available or pdfplumber is None:
            self.skipTest("Documaster or pdfplumber is not available")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)

    def doc_with_passage(self):
        s = self.new_session("blank", title="Verses", text=" ".join(f"p0w{i}" for i in range(50)))
        for n in range(1, 8):
            s.apply({"op": "block_insert", "after": s.doc["blocks"][-1]["id"], "block": {"type": "paragraph", "text": " ".join(f"p{n}w{i}" for i in range(50))}}, None)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply(APPLY(ids[2], ids[5]), None)
        return s

    def test_pdf_has_two_columns_in_italic_times_for_the_passage_only(self):
        s = self.doc_with_passage()
        report = self.ex.export(s, "pdf", self.root / "out", stem="verses")
        left = 25 * 72 / 25.4
        starts = {}
        fonts = {}
        with pdfplumber.open(report["path"]) as pdf:
            for page in pdf.pages:
                for w in page.extract_words(extra_attrs=["fontname"]):
                    m = re.fullmatch(r"p(\d+)w\d+", w["text"])
                    if m:
                        starts.setdefault(int(m.group(1)), set()).add(round(w["x0"]))
                        fonts.setdefault(int(m.group(1)), set()).add(w["fontname"])
        inside = set().union(*(starts[n] for n in (2, 3, 4, 5)))
        self.assertGreater(max(inside) - min(inside), 150, "a second column starts far to the right of the first")
        self.assertAlmostEqual(min(starts[0]), left, delta=1.5)
        self.assertGreater(max(starts[0]), left + 250, "the text before the passage runs the full width")
        self.assertTrue(all("Italic" in f or "Oblique" in f for n in (2, 3, 4, 5) for f in fonts[n]), fonts)
        self.assertTrue(all("Italic" not in f for n in (0, 1, 6, 7) for f in fonts[n]), fonts)

    def test_docx_has_a_two_column_section_around_the_passage(self):
        import zipfile
        s = self.doc_with_passage()
        report = self.ex.export(s, "docx", self.root / "out", stem="verses")
        xml = zipfile.ZipFile(report["path"]).read("word/document.xml").decode("utf-8")
        self.assertEqual(len(re.findall(r'<w:cols [^>]*w:num="2"', xml)), 1, "one two-column section")
        run = xml[xml.rindex("<w:r>", 0, xml.index("p2w0")):xml.index("p2w0")]                  # the style is written out as the run's own formatting
        self.assertIn('w:ascii="Times New Roman"', run)
        self.assertIn("<w:i/>", run)
        before = xml[xml.rindex("<w:r>", 0, xml.index("p0w0")):xml.index("p0w0")]
        self.assertNotIn("<w:i/>", before)


if __name__ == "__main__":
    unittest.main()
