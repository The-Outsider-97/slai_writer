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


if __name__ == "__main__":
    unittest.main()
