"""Columns (document / section / selection scope), column breaks, the Scripture style: model, undo/redo, idempotence, save and reopen."""
import copy
import unittest

from applications.slai_writer import columns as colmod
from applications.slai_writer.ops import BadRequest
from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench


class ColumnTests(Workbench):
    def make(self, paragraphs=6):
        session = self.new_session(text="P0")
        for n in range(1, paragraphs):
            last = session.doc["blocks"][-1]["id"]
            session.apply({"op": "block_insert", "after": last, "block": {"type": "paragraph", "text": f"P{n}"}}, None)
        return session

    def ids(self, session):
        return [b["id"] for b in session.doc["blocks"]]

    def reopen(self, session):
        return sldc().loads_package(session.to_bytes()).document

    def sections_of(self, doc):
        return {s["id"]: s for s in doc.get("sections", [])}

    def layouts(self, doc):
        return colmod.layouts_of(doc)

    # -- scopes ---------------------------------------------------------------------------------------------------------
    def test_document_scope_sets_every_section(self):
        s = self.make()
        s.apply({"op": "section_break", "block": self.ids(s)[3]}, None)
        s.apply({"op": "columns_set", "scope": "document", "columns": 3, "gap_mm": 8}, None)
        doc = self.reopen(s)
        self.assertEqual([x.get("columns") for x in doc["sections"]], [3, 3])
        self.assertEqual([x.get("column_gap_mm") for x in doc["sections"]], [8, 8])

    def test_section_scope_leaves_other_sections(self):
        s = self.make()
        s.apply({"op": "section_break", "block": self.ids(s)[3]}, None)
        s.apply({"op": "columns_set", "scope": "section", "block": self.ids(s)[4], "columns": 2}, None)
        doc = self.reopen(s)
        self.assertIsNone(doc["sections"][0].get("columns"))
        self.assertEqual(doc["sections"][1]["columns"], 2)

    def test_selection_in_the_middle_makes_a_continuous_section(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[3], "columns": 2,
                 "rule": {"color": "#333333", "width_pt": 1, "style": "dashed"}}, None)
        doc = self.reopen(s)
        by_block = {b["id"]: b["section"] for b in doc["blocks"]}
        self.assertEqual(len(doc["sections"]), 3)
        self.assertEqual(by_block[ids[0]], by_block[ids[1]])
        self.assertEqual(by_block[ids[2]], by_block[ids[3]])
        self.assertNotEqual(by_block[ids[1]], by_block[ids[2]])
        self.assertEqual(by_block[ids[4]], by_block[ids[5]])
        self.assertNotEqual(by_block[ids[3]], by_block[ids[4]])
        middle = self.sections_of(doc)[by_block[ids[2]]]
        self.assertEqual(middle["columns"], 2)
        layouts = self.layouts(doc)
        self.assertTrue(layouts[by_block[ids[2]]]["continuous"])
        self.assertEqual(layouts[by_block[ids[2]]]["rule"]["style"], "dashed")
        self.assertIsNone(self.sections_of(doc)[by_block[ids[0]]].get("columns"))
        self.assertIsNone(self.sections_of(doc)[by_block[ids[4]]].get("columns"))

    def test_selection_is_idempotent_and_reversible(self):
        s = self.make()
        ids = self.ids(s)
        before = copy.deepcopy(self.reopen(s))
        op = {"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[2], "columns": 2}
        s.apply(op, None)
        once = copy.deepcopy(self.reopen(s))
        s.apply(op, None)
        self.assertEqual(self.reopen(s)["sections"], once["sections"])
        self.assertEqual(self.layouts(self.reopen(s)), self.layouts(once))
        # back to one column: the text joins its neighbours again, nothing is left over
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[2], "columns": 1}, None)
        doc = self.reopen(s)
        self.assertEqual(len({b["section"] for b in doc["blocks"]}), 1)
        self.assertEqual(len(doc["sections"]), 1)
        self.assertEqual(self.layouts(doc), {})
        self.assertNotIn("columns", doc["sections"][0])
        self.assertEqual(before["blocks"][0].get("section"), None if "section" not in before["blocks"][0] else before["blocks"][0]["section"])

    def test_selection_at_start_and_end_of_the_document(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[0], "end_block": ids[1], "columns": 2}, None)
        doc = self.reopen(s)
        self.assertEqual(len(doc["sections"]), 2)
        self.assertEqual(doc["sections"][0]["columns"], 2)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[5], "end_block": ids[5], "columns": 3}, None)
        doc = self.reopen(s)
        self.assertEqual(doc["sections"][-1]["columns"], 3)
        self.assertEqual(doc["blocks"][-1]["section"], doc["sections"][-1]["id"])

    def test_numbering_start_is_not_repeated_in_continuous_sections(self):
        s = self.make()
        s.apply({"op": "page_setup", "numbering": {"start": 5, "format": "decimal"}}, None)
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[2], "columns": 2}, None)
        doc = self.reopen(s)
        starts = [x.get("numbering", {}).get("start") for x in doc["sections"]]
        self.assertEqual(starts, [5, None, None])

    def test_undo_redo(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[3], "columns": 2}, None)
        s.undo(None)
        doc = self.reopen(s)
        self.assertFalse(doc.get("sections") and any(x.get("columns") for x in doc["sections"]))
        self.assertEqual(self.layouts(doc), {})
        s.redo(None)
        doc = self.reopen(s)
        self.assertEqual(sorted(x.get("columns", 1) for x in doc["sections"]), [1, 1, 2])

    # -- validation -----------------------------------------------------------------------------------------------------
    def test_rejects_bad_input(self):
        s = self.make()
        for bad in ({"columns": 5}, {"columns": 0}, {"columns": 2, "gap_mm": -1}, {"columns": 2, "gap_mm": 80},
                    {"columns": 2, "widths_mm": [50]}, {"columns": 2, "widths_mm": [5, 50]},
                    {"columns": 2, "rule": {"style": "wavy"}}, {"columns": 2, "rule": {"width_pt": 40}},
                    {"columns": 2, "flow": "up"}, {"scope": "everything"}):
            with self.assertRaises(BadRequest, msg=str(bad)):
                s.apply({"op": "columns_set", "scope": "document", **bad} if "scope" not in bad else {"op": "columns_set", **bad}, None)
        self.assertFalse(any(x.get("columns") for x in self.reopen(s).get("sections", [])))

    def test_unequal_widths_rule_balance_flow_roundtrip(self):
        s = self.make()
        s.apply({"op": "columns_set", "scope": "document", "columns": 3, "gap_mm": 6, "widths_mm": [30, 60, 30],
                 "rule": {"color": "#112233", "width_pt": 0.5, "style": "solid"}, "balance": True, "flow": "rtl"}, None)
        doc = self.reopen(s)
        layout = self.layouts(doc)[doc["sections"][0]["id"]]
        self.assertEqual(layout["widths_mm"], [30, 60, 30])
        self.assertEqual(layout["flow"], "rtl")
        self.assertTrue(layout["balance"])
        # changing the number of columns drops widths that no longer fit; the line stays
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        layout = self.layouts(self.reopen(s))[doc["sections"][0]["id"]]
        self.assertNotIn("widths_mm", layout)
        self.assertEqual(layout["rule"]["color"], "#112233")
        # one column removes everything that only makes sense with several
        s.apply({"op": "columns_set", "scope": "document", "columns": 1}, None)
        self.assertEqual(self.layouts(self.reopen(s)), {})

    def test_page_setup_change_keeps_layout_consistent(self):
        s = self.make()
        s.apply({"op": "columns_set", "scope": "document", "columns": 3, "widths_mm": [30, 60, 30]}, None)
        s.apply({"op": "page_setup", "columns": 2}, None)           # an older client changes the count only
        doc = self.reopen(s)
        self.assertNotIn("widths_mm", self.layouts(doc).get(doc["sections"][0]["id"], {}))

    def test_new_section_inherits_columns_and_layout(self):
        s = self.make()
        s.apply({"op": "columns_set", "scope": "document", "columns": 2, "rule": {"color": "#000000", "width_pt": 1, "style": "solid"}}, None)
        s.apply({"op": "section_break", "block": self.ids(s)[3]}, None)
        doc = self.reopen(s)
        second = doc["sections"][1]
        self.assertEqual(second["columns"], 2)
        self.assertEqual(self.layouts(doc)[second["id"]]["rule"]["width_pt"], 1)
        self.assertNotIn("continuous", self.layouts(doc)[second["id"]])

    def test_page_setup_reaches_the_sections_that_share_the_page(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[3], "columns": 2}, None)
        s.apply({"op": "page_setup", "section": "s1", "page": {"margins_mm": {"left": 40}}}, None)
        doc = self.reopen(s)
        self.assertEqual({x["page"]["margins_mm"]["left"] for x in doc["sections"]}, {40})
        s.apply({"op": "page_setup", "section": "s1", "header": {"center": "Head"}}, None)
        self.assertTrue(all(x.get("header", {}).get("center") == "Head" for x in self.reopen(s)["sections"]))

    # -- column breaks --------------------------------------------------------------------------------------------------
    def test_column_break_inside_a_paragraph_splits_it(self):
        s = self.make(2)
        first = self.ids(s)[0]
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        s.apply({"op": "column_break", "block": first, "at": 1}, None)
        blocks = self.reopen(s)["blocks"]
        self.assertEqual([b["text"] for b in blocks][:3], ["P", "0", "P1"])
        self.assertNotIn(colmod.BREAK_KEY, blocks[0].get("extensions", {}))
        self.assertEqual(blocks[1]["extensions"][colmod.BREAK_KEY], {"before": True})
        s.undo(None)
        self.assertEqual([b["text"] for b in self.reopen(s)["blocks"]][:2], ["P0", "P1"])

    def test_column_break_at_block_start_and_remove(self):
        s = self.make(3)
        ids = self.ids(s)
        s.apply({"op": "column_break", "block": ids[1]}, None)
        self.assertIn(colmod.BREAK_KEY, self.reopen(s)["blocks"][1]["extensions"])
        s.apply({"op": "column_break", "block": ids[1], "remove": True}, None)
        self.assertNotIn("extensions", self.reopen(s)["blocks"][1])

    def test_enter_after_a_break_does_not_copy_it(self):
        s = self.make(2)
        ids = self.ids(s)
        s.apply({"op": "column_break", "block": ids[1]}, None)
        s.apply({"op": "split", "block": ids[1], "at": 1}, None)
        blocks = self.reopen(s)["blocks"]
        self.assertIn(colmod.BREAK_KEY, blocks[1]["extensions"])
        self.assertNotIn(colmod.BREAK_KEY, blocks[2].get("extensions", {}))

    # -- Scripture ------------------------------------------------------------------------------------------------------
    def test_scripture_style_and_two_columns(self):
        s = self.make()
        ids = self.ids(s)
        s.apply({"op": "scripture_apply", "block": ids[2], "end_block": ids[3]}, None)
        doc = self.reopen(s)
        style = doc["styles"]["paragraph"]["Scripture"]
        self.assertEqual(style, {"font_family": "Times New Roman", "font_size_pt": 11, "italic": True, "align": "left"})
        self.assertNotIn("color", style)
        by_id = {b["id"]: b for b in doc["blocks"]}
        self.assertEqual(by_id[ids[2]]["style"], "Scripture")
        self.assertEqual(by_id[ids[3]]["style"], "Scripture")
        self.assertNotIn("style", by_id[ids[1]])
        self.assertEqual(self.sections_of(doc)[by_id[ids[2]]["section"]]["columns"], 2)
        self.assertEqual(by_id[ids[2]]["section"], by_id[ids[3]]["section"])

    def test_scripture_is_idempotent_and_undoable(self):
        s = self.make()
        ids = self.ids(s)
        op = {"op": "scripture_apply", "block": ids[2], "end_block": ids[3]}
        s.apply(op, None)
        once = copy.deepcopy(self.reopen(s))
        s.apply(op, None)
        again = self.reopen(s)
        self.assertEqual(again["sections"], once["sections"])
        self.assertEqual(again["blocks"], once["blocks"])
        self.assertEqual(again["styles"], once["styles"])
        s.undo(None)
        s.undo(None)
        doc = self.reopen(s)
        self.assertNotIn("Scripture", doc["styles"]["paragraph"])
        self.assertTrue(all("style" not in b for b in doc["blocks"]))

    def test_scripture_clears_direct_alignment_and_spacing(self):
        s = self.make(3)
        ids = self.ids(s)
        s.apply({"op": "block_set", "block": ids[1], "attributes": {"align": "justify", "space_after_pt": 20}}, None)
        s.apply({"op": "scripture_apply", "block": ids[1]}, None)
        self.assertNotIn("attributes", self.reopen(s)["blocks"][1])


if __name__ == "__main__":
    unittest.main()
