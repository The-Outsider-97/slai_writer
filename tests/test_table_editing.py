"""Regression tests for table typing, rich text, geometry and persisted cell styling."""
import unittest

from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench


class TableEditing(Workbench):
    def make(self):
        session = self.new_session(text="Timeline")
        after = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_insert", "after": after,
                       "block": {"id": "timeline-table", "type": "table", "rows": 3, "columns": 3}}, None)
        return session

    @staticmethod
    def cell(session, row=0, col=0):
        return session.doc["blocks"][-1]["table"]["rows"][row][col]

    def saved(self, session):
        return sldc().loads_package(session.to_bytes()).document["blocks"][-1]

    def test_continuous_typing_preserves_cell_content_and_format(self):
        session = self.make()
        text = "Dedicated development timeline for SLAI Writer"
        for pos, letter in enumerate(text):
            session.apply({"op": "table_cell_text", "block": "timeline-table", "row": 0, "col": 0,
                           "start": pos, "end": pos, "insert": letter}, None)
        self.assertEqual(self.cell(session)["text"], text)
        session.apply({"op": "format", "block": "timeline-table", "row": 0, "col": 0,
                       "start": 0, "end": 9, "set": {"bold": True, "font_family": "Georgia"}}, None)
        session.apply({"op": "table_cell", "block": "timeline-table", "row": 0, "col": 0,
                       "text": "!" + text}, None)
        self.assertTrue(any(span.get("bold") and span.get("font_family") == "Georgia"
                            for span in self.cell(session)["spans"]))
        self.assertEqual(self.saved(session)["table"]["rows"][0][0]["text"], "!" + text)

    def test_enter_multiline_replace_and_undo(self):
        session = self.make()
        session.apply({"op": "table_cell_text", "block": "timeline-table", "row": 1, "col": 2,
                       "start": 0, "end": 0, "insert": "Hello\nWorld"}, None)
        self.assertEqual(self.cell(session, 1, 2)["text"], "Hello\nWorld")
        session.apply({"op": "table_cell_text", "block": "timeline-table", "row": 1, "col": 2,
                       "start": 5, "end": 6, "insert": " "}, None)
        self.assertEqual(self.cell(session, 1, 2)["text"], "Hello World")
        session.undo(None)
        self.assertEqual(self.cell(session, 1, 2)["text"], "Hello\nWorld")

    def test_table_layout_cell_styles_and_roundtrip(self):
        session = self.make()
        session.apply({"op": "table_cell_style", "block": "timeline-table", "row": 1, "col": 1,
                       "props": {"align": "center", "valign": "middle", "background": "#aabbcc",
                                 "padding_mm": 2, "border_color": "#000000", "border_width_pt": 1.5,
                                 "border_style": "dashed"}}, None)
        session.apply({"op": "table_layout", "block": "timeline-table", "props": {
            "column_widths_mm": [30, 40, 50], "row_heights_mm": [9, 13, 11], "align": "center"}}, None)
        saved = self.saved(session)
        self.assertEqual(saved["table"]["rows"][1][1]["align"], "center")
        self.assertEqual(saved["extensions"]["slai.writer.table_cell_styles"]["1,1"]["valign"], "middle")
        self.assertEqual(saved["extensions"]["slai.writer.table_cell_styles"]["1,1"]["border_style"], "dashed")
        self.assertEqual(saved["extensions"]["slai.writer.table_layout"]["column_widths_mm"], [30, 40, 50])
        self.assertEqual(saved["extensions"]["slai.writer.table_layout"]["align"], "center")
        session.undo(None)
        self.assertNotIn("slai.writer.table_layout", session.doc["blocks"][-1].get("extensions", {}))

    def test_invalid_geometry_and_styling_are_rejected(self):
        session = self.make()
        for props in ({"column_widths_mm": [10, 20]}, {"column_widths_mm": [2, 10, 20]},
                      {"row_heights_mm": [10, 10, 3]}):
            with self.assertRaises(Exception):
                session.apply({"op": "table_layout", "block": "timeline-table", "props": props}, None)
        for props in ({"align": "banana"}, {"background": "expression(foo)"}, {"padding_mm": -5}, {"border_style": "groove"}):
            with self.assertRaises(Exception):
                session.apply({"op": "table_cell_style", "block": "timeline-table", "row": 0, "col": 0,
                               "props": props}, None)

    def test_editing_existing_merged_cell_preserves_topology(self):
        session = self.make()
        block = session.doc["blocks"][-1]
        block["table"]["rows"][0] = [{"text": "Merged", "colspan": 2}, {"text": "Other"}]
        session.apply({"op": "table_cell_text", "block": "timeline-table", "row": 0, "col": 0,
                       "start": 6, "end": 6, "insert": "!"}, None)
        self.assertEqual(self.saved(session)["table"]["rows"][0][0]["colspan"], 2)
        self.assertEqual(self.cell(session)["text"], "Merged!")

    def test_grid_insert_delete_keeps_layout_and_cell_style_mapped(self):
        session = self.make()
        session.apply({"op": "table_cell_style", "block": "timeline-table", "row": 1, "col": 1,
                       "props": {"background": "#abcdef"}}, None)
        session.apply({"op": "table_layout", "block": "timeline-table", "props": {
            "column_widths_mm": [21, 32, 43], "row_heights_mm": [8, 14, 20]}}, None)
        session.apply({"op": "table_edit", "block": "timeline-table", "action": "insert_row", "index": 1}, None)
        session.apply({"op": "table_edit", "block": "timeline-table", "action": "insert_col", "index": 0}, None)
        saved = self.saved(session)
        self.assertEqual(saved["extensions"]["slai.writer.table_cell_styles"]["2,2"]["background"], "#abcdef")
        self.assertEqual(saved["extensions"]["slai.writer.table_layout"]["column_widths_mm"], [21, 21, 32, 43])
        self.assertEqual(saved["extensions"]["slai.writer.table_layout"]["row_heights_mm"], [8, 8, 14, 20])

    def test_merge_and_split_preserve_content_spans_and_roundtrip(self):
        session = self.make()
        session.apply({"op": "table_cell_style", "block": "timeline-table", "row": 0, "col": 2,
                       "props": {"background": "#ddeeff"}}, None)
        for row, col, text in ((0, 0, "One"), (0, 1, "Two"), (1, 0, "Three"), (1, 1, "Four")):
            session.apply({"op": "table_cell", "block": "timeline-table", "row": row, "col": col,
                           "text": text}, None)
        session.apply({"op": "format", "block": "timeline-table", "row": 0, "col": 1,
                       "start": 0, "end": 3, "set": {"italic": True}}, None)
        session.apply({"op": "table_edit", "block": "timeline-table", "action": "merge_cells",
                       "row": 0, "col": 0, "end_row": 1, "end_col": 1}, None)
        merged = self.cell(session)
        self.assertEqual((merged["colspan"], merged["rowspan"]), (2, 2))
        self.assertEqual(merged["text"], "One\nTwo\nThree\nFour")
        self.assertTrue(any(span.get("italic") for span in merged.get("spans", [])))
        saved_merged = self.saved(session)
        self.assertEqual(saved_merged["table"]["rows"][0][0]["rowspan"], 2)
        self.assertEqual(saved_merged["extensions"]["slai.writer.table_cell_styles"]["0,1"]["background"], "#ddeeff")
        session.apply({"op": "table_edit", "block": "timeline-table", "action": "split_cell",
                       "row": 0, "col": 0}, None)
        self.assertEqual(len(self.cell(session)["text"]), len("One\nTwo\nThree\nFour"))
        self.assertEqual(len(self.saved(session)["table"]["rows"][0]), 3)
        self.assertEqual(self.saved(session)["extensions"]["slai.writer.table_cell_styles"]["0,2"]["background"], "#ddeeff")
        session.undo(None)
        self.assertEqual(self.cell(session)["colspan"], 2)

    def test_row_column_operations_on_merged_cells_keep_a_valid_grid(self):
        session = self.make()
        session.apply({"op": "table_edit", "block": "timeline-table", "action": "merge_cells",
                       "row": 0, "col": 0, "end_row": 1, "end_col": 1}, None)
        for action, index in (("insert_row", 1), ("insert_col", 1), ("delete_row", 0), ("delete_col", 0)):
            session.apply({"op": "table_edit", "block": "timeline-table", "action": action, "index": index}, None)
            self.saved(session)  # authoritative SLDC validation rejects holes or overlaps
        table = self.saved(session)["table"]
        self.assertEqual((table["columns"], len(table["rows"])), (3, 3))

    def test_spreadsheet_paste_expands_table_in_one_undoable_transaction(self):
        session = self.make()
        session.apply({"op": "batch", "label": "paste table data", "ops": [
            {"op": "table_edit", "block": "timeline-table", "action": "insert_col", "index": 3},
            {"op": "table_edit", "block": "timeline-table", "action": "insert_row", "index": 3},
            {"op": "table_cell", "block": "timeline-table", "row": 2, "col": 2, "text": "A"},
            {"op": "table_cell", "block": "timeline-table", "row": 2, "col": 3, "text": "B"},
            {"op": "table_cell", "block": "timeline-table", "row": 3, "col": 2, "text": "C"},
            {"op": "table_cell", "block": "timeline-table", "row": 3, "col": 3, "text": "D"},
        ]}, None)
        saved = self.saved(session)["table"]
        self.assertEqual(saved["columns"], 4)
        self.assertEqual([[cell["text"] for cell in row[-2:]] for row in saved["rows"][-2:]],
                         [["A", "B"], ["C", "D"]])
        session.undo(None)
        self.assertEqual(self.saved(session)["table"]["columns"], 3)
        self.assertEqual(len(self.saved(session)["table"]["rows"]), 3)

    def test_merged_track_edits_at_every_boundary(self):
        for action in ("insert_row", "insert_col", "delete_row", "delete_col"):
            for index in range(4 if action.startswith("insert_") else 3):
                with self.subTest(action=action, index=index):
                    session = self.make()
                    session.apply({"op": "table_edit", "block": "timeline-table", "action": "merge_cells",
                                   "row": 0, "col": 0, "end_row": 1, "end_col": 1}, None)
                    session.apply({"op": "table_edit", "block": "timeline-table", "action": action,
                                   "index": index}, None)
                    self.saved(session)

    def test_move_table_in_document_flow_and_undo(self):
        session = self.make()
        table_id = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_insert", "after": table_id,
                       "block": {"id": "paragraph-after", "type": "paragraph", "text": "After table"}}, None)
        first = session.doc["blocks"][0]["id"]
        session.apply({"op": "move", "blocks": [table_id], "after": "paragraph-after"}, None)
        self.assertEqual([block["id"] for block in session.doc["blocks"]],
                         [first, "paragraph-after", table_id])
        session.undo(None)
        self.assertEqual([block["id"] for block in session.doc["blocks"]],
                         [first, table_id, "paragraph-after"])


if __name__ == "__main__":
    unittest.main()
