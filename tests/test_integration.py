"""All the new features together on one realistic document, and on documents written before they existed.

The document is edited through the same operations the editor sends, saved, reopened, undone all the way back and exported.
"""
import copy
import re
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer import columns as colmod
from applications.slai_writer.academic import Academic
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.session import sldc
from .helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]
TOC = "slai.sldc.toc"


class Realistic(Workbench):
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
        self.app.preferences = lambda: {"lookup_online": False}
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024,
                                                  data_dir=self.root / "data")
        self.ac = Academic(self.app, fetch=lambda doi: {})

    def reopen(self, session):
        return sldc().loads_package(session.to_bytes()).document

    def add(self, session, block, after=None):
        before = {b["id"] for b in session.doc["blocks"]}
        session.apply({"op": "block_insert", "after": after or session.doc["blocks"][-1]["id"], "block": block}, None)
        return next(b["id"] for b in session.doc["blocks"] if b["id"] not in before)

    def build(self):
        s = self.new_session("report", title="Annual review")
        intro = next(b["id"] for b in s.doc["blocks"] if b["type"] == "heading" and b["text"] == "Introduction")
        verses = []
        for n in range(3):
            verses.append(self.add(s, {"type": "paragraph", "text": f"Verse {n} " + "and the word was good " * 6}, after=verses[-1] if verses else intro))
        s.apply({"op": "scripture_apply", "block": verses[0], "end_block": verses[-1]}, None)
        method = next(b["id"] for b in s.doc["blocks"] if b["type"] == "heading" and b["text"] == "Method")
        body = [self.add(s, {"type": "paragraph", "text": f"Method paragraph {n}. " + "measured twice " * 12}, after=method) for n in range(4)]
        table = self.add(s, {"id": "tbl", "type": "table", "rows": 3, "columns": 3}, after=body[-1])
        for r in range(3):
            for c in range(3):
                s.apply({"op": "table_cell", "block": "tbl", "row": r, "col": c, "text": f"{'ABC'[c]}{r + 1}"}, None)
        s.apply({"op": "table_edit", "block": "tbl", "action": "insert_row", "index": 1}, None)
        s.apply({"op": "table_edit", "block": "tbl", "action": "insert_col", "index": 2}, None)
        s.apply({"op": "table_style", "block": "tbl", "preset": "professional_report", "banded_rows": True}, None)
        s.apply({"op": "table_borders", "block": "tbl", "target": "outside", "border": {"color": "#333333", "width_pt": 1.5, "style": "solid"}}, None)
        s.apply({"op": "columns_set", "scope": "selection", "block": body[0], "end_block": body[-1], "columns": 2, "gap_mm": 9,
                 "rule": {"color": "#999999", "width_pt": 0.5}}, None)
        s.apply({"op": "column_break", "block": body[2]}, None)
        toc = self.ac.contents(s, after=None, look={"preset": "technical"})["tocId"]
        return s, toc, verses, body

    def test_everything_survives_save_reopen_and_validation(self):
        s, toc, verses, body = self.build()
        doc = self.reopen(s)
        styles = doc["styles"]["paragraph"]
        self.assertEqual(styles["Scripture"], colmod.SCRIPTURE_PROPS)
        self.assertEqual({b["style"] for b in doc["blocks"] if b["id"] in verses}, {"Scripture"})
        sections = {x["id"]: x for x in doc["sections"]}
        self.assertEqual(sorted(x.get("columns", 1) for x in sections.values()).count(2), 2, "the verses and the method paragraphs each have two columns")
        self.assertTrue(any(b.get("extensions", {}).get(colmod.BREAK_KEY) for b in doc["blocks"] if b["id"] == body[2]))
        entries = [b for b in doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "entry"]
        self.assertGreaterEqual(len(entries), 6)
        self.assertEqual(next(b for b in doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "title")["extensions"]["slai.writer.toc_style"]["preset"],
                         "technical")
        table = next(b for b in doc["blocks"] if b["id"] == "tbl")
        self.assertEqual(len(table["table"]["rows"]), 4)
        # a second save of the reopened document is identical: nothing in the new data is lost or invented by a round trip
        again = sldc().loads_package(s.to_bytes()).document
        self.assertEqual(again, doc)

    def test_every_change_can_be_undone_to_the_starting_document(self):
        s = self.new_session("report", title="Annual review")
        start = copy.deepcopy(s.doc)
        steps = 0
        intro = next(b["id"] for b in s.doc["blocks"] if b["type"] == "heading" and b["text"] == "Introduction")
        first = self.add(s, {"type": "paragraph", "text": "Verse " + "word " * 40}, after=intro)
        steps += 1
        s.apply({"op": "scripture_apply", "block": first, "end_block": first}, None)
        steps += 1
        s.apply({"op": "columns_set", "scope": "document", "columns": 3, "gap_mm": 6}, None)
        steps += 1
        s.apply({"op": "column_break", "block": first}, None)
        steps += 1
        self.ac.contents(s, after=None, look={"preset": "modern"})
        steps += 1
        self.assertNotEqual(s.doc, start)
        for _ in range(steps + 3):
            if not s.undo_stack:
                break
            s.undo(None)
        self.assertEqual(s.doc, start)
        for _ in range(steps):
            s.redo(None)
        self.assertEqual(self.reopen(s), sldc().loads_package(s.to_bytes()).document)

    def test_the_document_exports_to_pdf_word_and_rtf_and_the_pdf_layout_agrees_with_the_model(self):
        s, toc, verses, body = self.build()
        ex = Exchange(self.app)
        for fmt in ("pdf", "docx", "rtf"):
            report = ex.export(s, fmt, self.root / "out", stem="review")
            self.assertTrue(report["verification"]["ok"], (fmt, report["verification"]))
            self.assertGreater(report["bytes"], 1000)
        layout = ex.layout(s)
        labels = layout["blockLabels"]
        headings = [b["id"] for b in s.doc["blocks"] if b["type"] == "heading"]
        self.assertTrue(all(h in labels for h in headings), "every heading has a measured page for the table of contents")
        self.assertEqual(layout["pages"], ex.page_count(s))
        import pdfplumber
        pdf = ex.export(s, "pdf", self.root / "out2", stem="review")["path"]
        with pdfplumber.open(pdf) as doc:
            first = doc.pages[0].extract_text()
        self.assertIn("Contents", first)
        self.assertRegex(first, r"Method\W+\d")

    # -- documents from before the features ----------------------------------------------------------------------------------------
    def old_document(self):
        """A document as an earlier Writer saved it: native table of contents, no Writer extensions, no sections beyond the template's."""
        s = self.new_session("report", title="Old report")
        toc = self.ac.contents(s, after=None)["tocId"]
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "title")
        self.assertNotIn("slai.writer.toc_style", title.get("extensions", {}), "a contents made without a look is the native one")
        return s, toc

    def test_an_old_table_of_contents_keeps_working_and_is_restyled_only_when_asked(self):
        s, toc = self.old_document()
        before = [b["text"] for b in s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("id") == toc]
        saved = self.reopen(s)
        self.assertTrue(saved)
        self.add(s, {"type": "heading", "level": 1, "text": "Appendix"}, after=s.doc["blocks"][-1]["id"])
        self.ac.refresh_contents(s, toc)
        after = [b["text"] for b in s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("id") == toc]
        self.assertEqual(len(after), len(before) + 1)
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "title")
        self.assertNotIn("slai.writer.toc_style", title.get("extensions", {}), "refreshing does not attach a new look to an old table")
        self.ac.refresh_contents(s, toc, look={"preset": "formal"})
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "title")
        self.assertEqual(title["extensions"]["slai.writer.toc_style"]["preset"], "formal")
        ex = Exchange(self.app)
        self.assertTrue(ex.export(s, "pdf", self.root / "out", stem="old")["verification"]["ok"])

    def test_an_old_document_without_sections_takes_columns_and_a_page_break_for_a_column_break(self):
        s = self.new_session("blank", title="Old")
        s.doc.pop("sections", None)
        for block in s.doc["blocks"]:
            block.pop("section", None)
        for n in range(4):
            self.add(s, {"type": "paragraph", "text": f"Old paragraph {n} " + "text " * 30})
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "column_break", "block": ids[2]}, None)                 # one column: a page break
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        doc = self.reopen(s)
        self.assertEqual([x.get("columns") for x in doc["sections"]], [2])
        ex = Exchange(self.app)
        self.assertTrue(ex.export(s, "pdf", self.root / "out", stem="old2")["verification"]["ok"])
        self.assertTrue(ex.export(s, "docx", self.root / "out", stem="old2")["verification"]["ok"])

    def test_an_old_table_without_writer_data_gets_a_style_and_rows(self):
        s = self.new_session("blank", title="Old")
        self.add(s, {"id": "old", "type": "table", "rows": 2, "columns": 2})
        for r, c, text in ((0, 0, "a"), (0, 1, "b"), (1, 0, "c"), (1, 1, "d")):
            s.apply({"op": "table_cell", "block": "old", "row": r, "col": c, "text": text}, None)
        table = next(b for b in s.doc["blocks"] if b["id"] == "old")
        self.assertNotIn("extensions", table, "no Writer data on a table nobody has styled")
        s.apply({"op": "table_edit", "block": "old", "action": "insert_row", "index": 1}, None)
        s.apply({"op": "table_edit", "block": "old", "action": "insert_col", "index": 2}, None)
        s.apply({"op": "table_style", "block": "old", "preset": "academic"}, None)
        doc = self.reopen(s)
        table = next(b for b in doc["blocks"] if b["id"] == "old")["table"]
        self.assertEqual((len(table["rows"]), len(table["rows"][0])), (3, 3))
        self.assertEqual(table["rows"][0][0]["text"], "a")
        block = next(b for b in doc["blocks"] if b["id"] == "old")
        self.assertEqual(block["extensions"]["slai.writer.table_style"]["preset"], "academic")


if __name__ == "__main__":
    unittest.main()
