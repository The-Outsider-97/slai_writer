"""End-to-end document transaction and SLDC persistence checks for ribbon formatting."""
import unittest

from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench


class RibbonFormatting(Workbench):
    def make(self, text="Title and body"):
        session = self.new_session(text=text)
        block = session.doc["blocks"][-1]
        return session, block["id"]

    def test_inline_font_and_colour_survive_save_and_reopen(self):
        session, block_id = self.make()
        session.apply({"op": "format", "block": block_id, "start": 0, "end": 5,
                       "set": {"font_family": "Georgia", "font_size_pt": 14.5, "color": "#123456",
                               "background": "#ffff00", "bold": True}}, None)
        state = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        span = next(s for s in state["spans"] if s["type"] == "format")
        self.assertEqual((span["font_family"], span["font_size_pt"], span["color"]),
                         ("Georgia", 14.5, "#123456"))
        self.assertEqual((span["start"], span["end"]), (0, 5))
        self.assertEqual(state["text"], "Title and body")
        self.assertIn("font-runs", sldc()._required_features(sldc().loads_package(session.to_bytes()).document))

    def test_mixed_inline_formatting_and_reset_preserves_unrelated_props(self):
        session, block_id = self.make()
        session.apply({"op": "format", "block": block_id, "start": 0, "end": 5,
                       "set": {"bold": True, "font_family": "Cambria"}}, None)
        session.apply({"op": "format", "block": block_id, "start": 2, "end": 4,
                       "set": {"font_size_pt": 19}}, None)
        session.apply({"op": "format", "block": block_id, "start": 0, "end": 5,
                       "unset": ["font_family"]}, None)
        saved = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        self.assertTrue(any(s.get("bold") and "font_family" not in s for s in saved["spans"]))
        self.assertTrue(any(s.get("font_size_pt") == 19 for s in saved["spans"]))

    def test_paragraph_layout_and_list_semantics_survive_round_trip(self):
        session, block_id = self.make()
        session.apply({"op": "block_set", "block": block_id, "attributes": {
            "align": "justify", "line_height": 1.5, "space_before_pt": 8,
            "space_after_pt": 12, "indent_mm": 10}}, None)
        session.apply({"op": "block_set", "block": block_id, "type": "list_item", "attributes": {
            "ordered": True, "depth": 1}}, None)
        saved = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        self.assertEqual(saved["type"], "list_item")
        self.assertEqual(saved["attributes"]["line_height"], 1.5)
        self.assertEqual(saved["attributes"]["space_after_pt"], 12)
        self.assertEqual(saved["attributes"]["depth"], 1)
        self.assertIn("paragraph-layout", sldc()._required_features(sldc().loads_package(session.to_bytes()).document))

    def test_invalid_font_and_spacing_are_rejected_atomically(self):
        session, block_id = self.make()
        original = dict(session.doc["blocks"][-1])
        for bad in (True, float("nan"), 3, 401, "16"):
            with self.assertRaises(Exception, msg=repr(bad)):
                session.apply({"op": "format", "block": block_id, "start": 0, "end": 2,
                               "set": {"font_size_pt": bad}}, None)
        for name in ("x;y", "font\nname", "name{bad}"):
            with self.assertRaises(Exception, msg=name):
                session.apply({"op": "format", "block": block_id, "start": 0, "end": 2,
                               "set": {"font_family": name}}, None)
        for bad in (-1, "2", float("inf")):
            with self.assertRaises(Exception):
                session.apply({"op": "block_set", "block": block_id, "attributes": {"line_height": bad}}, None)
            self.assertNotIn("line_height", session.doc["blocks"][-1].get("attributes", {}))
        self.assertEqual(session.doc["blocks"][-1]["text"], original["text"])

    def test_unicode_case_change_keeps_character_spans_and_is_undoable(self):
        session, block_id = self.make("Straße and Blue")
        session.apply({"op": "format", "block": block_id, "start": 0, "end": 6,
                       "set": {"italic": True, "font_family": "Georgia"}}, None)
        session.apply({"op": "case", "block": block_id, "start": 0, "end": 6, "mode": "upper"}, None)
        block = session.doc["blocks"][-1]
        self.assertEqual(block["text"], "STRASSE and Blue")
        self.assertTrue(any(s.get("font_family") == "Georgia" and s["end"] == 7 for s in block["spans"]))
        session.undo(None)
        self.assertEqual(session.doc["blocks"][-1]["text"], "Straße and Blue")

    def test_page_break_is_not_inherited_by_enter_or_subsequent_paragraphs(self):
        session, first_id = self.make("First paragraph")
        session.apply({"op": "block_set", "block": first_id,
                       "attributes": {"page_break_before": True}}, None)
        session.apply({"op": "split", "block": first_id, "at": 5,
                       "new_id": "after-break"}, None)
        session.apply({"op": "split", "block": "after-break", "at": 3,
                       "new_id": "ordinary-enter"}, None)
        blocks = session.doc["blocks"]
        self.assertTrue(blocks[0].get("attributes", {}).get("page_break_before"))
        self.assertFalse(blocks[1].get("attributes", {}).get("page_break_before", False))
        self.assertFalse(blocks[2].get("attributes", {}).get("page_break_before", False))
        saved = sldc().loads_package(session.to_bytes()).document["blocks"]
        self.assertEqual(sum(b.get("attributes", {}).get("page_break_before") is True
                             for b in saved), 1)

    def test_enter_at_start_moves_existing_page_break_with_original_text(self):
        session, first_id = self.make("Original text")
        session.apply({"op": "block_set", "block": first_id,
                       "attributes": {"page_break_before": True}}, None)
        session.apply({"op": "split", "block": first_id, "at": 0,
                       "new_id": "original-after-enter"}, None)
        left, right = session.doc["blocks"]
        self.assertEqual(left["text"], "")
        self.assertFalse(left.get("attributes", {}).get("page_break_before", False))
        self.assertEqual(right["text"], "Original text")
        self.assertTrue(right.get("attributes", {}).get("page_break_before"))

    def test_cursor_table_insertion_split_preserves_order_spans_and_undo(self):
        session, first_id = self.make("BeforeAfter")
        session.apply({"op": "format", "block": first_id, "start": 6, "end": 11,
                       "set": {"italic": True}}, None)
        session.apply({"op": "batch", "label": "insert table", "ops": [
            {"op": "split", "block": first_id, "at": 6, "new_id": "after-table"},
            {"op": "block_insert", "after": first_id,
             "block": {"id": "cursor-table", "type": "table", "rows": 2, "columns": 2}},
        ]}, None)
        blocks = session.doc["blocks"]
        self.assertEqual([(b["type"], b["text"]) for b in blocks],
                         [("paragraph", "Before"), ("table", ""), ("paragraph", "After")])
        self.assertTrue(any(s.get("italic") for s in blocks[2].get("spans", [])))
        saved = sldc().loads_package(session.to_bytes()).document["blocks"]
        self.assertEqual([b["id"] for b in saved], [first_id, "cursor-table", "after-table"])
        session.undo(None)
        self.assertEqual(len(session.doc["blocks"]), 1)
        self.assertEqual(session.doc["blocks"][0]["text"], "BeforeAfter")

    def test_markdown_table_content_uses_native_table_cells(self):
        session, first_id = self.make("Intro")
        table = {"columns": 2, "header_rows": 1, "rows": [
            [{"text": "Name"}, {"text": "Value"}],
            [{"text": "A|B"}, {"text": "123"}],
        ]}
        session.apply({"op": "block_insert", "after": first_id,
                       "block": {"type": "table", "text": "", "table": table}}, None)
        saved = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        self.assertEqual(saved["table"]["rows"][1][0]["text"], "A|B")
        self.assertEqual(saved["table"]["header_rows"], 1)

    def test_table_expansion_handles_append_a_row_and_column(self):
        session, first_id = self.make("Intro")
        session.apply({"op": "block_insert", "after": first_id,
                       "block": {"id": "expand-table", "type": "table", "rows": 2, "columns": 2}}, None)
        session.apply({"op": "table_edit", "block": "expand-table", "action": "insert_row", "index": 2}, None)
        session.apply({"op": "table_edit", "block": "expand-table", "action": "insert_col", "index": 2}, None)
        table = session.doc["blocks"][-1]["table"]
        self.assertEqual(table["columns"], 3)
        self.assertEqual(len(table["rows"]), 3)
        self.assertTrue(all(len(row) == 3 for row in table["rows"]))
        session.undo(None)
        self.assertEqual(session.doc["blocks"][-1]["table"]["columns"], 2)


if __name__ == "__main__":
    unittest.main()
