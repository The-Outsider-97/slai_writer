"""The horizontal rule (``slai.writer.rule``) and the undo rules AutoFormat relies on.

Server side only: the operations the editor sends for ``___`` + Enter, their validation, one-step Undo/Redo, save and reopen, and the regression for
typing being merged into the undo step of a batch. The editor, the exports and the PDF are covered by the other AutoCorrect tests.
"""
import copy
import unittest

from applications.slai_writer import hrule
from applications.slai_writer.ops import OpError, apply_operation
from applications.slai_writer.session import sldc
from .helpers import Workbench

KEY = hrule.RULE_KEY


class RuleOperations(Workbench):
    def session_with(self, text="___"):
        s = self.new_session(text="x")
        block = s.doc["blocks"][-1]["id"]
        s.apply({"op": "text", "block": block, "start": 0, "end": 1, "insert": text}, None)
        return s, block

    def test_three_underscores_become_a_rule_and_a_paragraph_opens_below(self):
        s, block = self.session_with("___")
        count = len(s.doc["blocks"])
        patch = s.apply({"op": "rule_insert", "block": block, "new_id": "after1"}, None)
        self.assertEqual(patch["result"]["block"], "after1")
        blocks = s.doc["blocks"]
        self.assertEqual(len(blocks), count + 1)
        rule = next(b for b in blocks if b["id"] == block)
        self.assertEqual((rule["type"], rule["text"]), ("paragraph", ""))
        self.assertEqual(rule["extensions"][KEY], hrule.DEFAULTS)
        self.assertEqual(rule["extensions"][KEY]["width_pt"], 1.0)
        self.assertEqual(blocks[blocks.index(rule) + 1]["id"], "after1")
        self.assertEqual(blocks[blocks.index(rule) + 1]["text"], "")
        self.assertNotIn(KEY, blocks[blocks.index(rule) + 1].get("extensions", {}))

    def test_surrounding_blanks_are_insignificant_but_nothing_else_is(self):
        for text in ("___", "  ___", "___  ", " ___ \t"):
            s, block = self.session_with(text)
            s.apply({"op": "rule_insert", "block": block}, None)
        for text in ("____", "__", "_ _ _", "a___", "___a", "- - -", "___\n"):
            s, block = self.session_with(text)
            with self.assertRaises(Exception, msg=repr(text)):
                s.apply({"op": "rule_insert", "block": block}, None)
            self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["text"], text, "a refused conversion leaves the text alone")

    def test_only_an_ordinary_paragraph_converts(self):
        for kind in ("heading", "quote", "code", "list_item"):
            s, block = self.session_with("___")
            s.apply({"op": "block_set", "block": block, "type": kind}, None)
            with self.assertRaises(Exception, msg=kind):
                s.apply({"op": "rule_insert", "block": block}, None)

    def test_one_undo_restores_the_underscores_and_redo_makes_the_rule_again(self):
        s, block = self.session_with("___")
        before = copy.deepcopy(s.doc["blocks"])
        s.apply({"op": "rule_insert", "block": block, "new_id": "n"}, None)
        self.assertEqual(s.undo_stack[-1].undo.label, "horizontal rule")
        s.undo(None)
        self.assertEqual(s.doc["blocks"], before)
        s.redo(None)
        self.assertIn(KEY, next(b for b in s.doc["blocks"] if b["id"] == block)["extensions"])
        s.undo(None)
        self.assertEqual(s.doc["blocks"], before)

    def test_page_break_before_stays_with_the_rule(self):
        s, block = self.session_with("___")
        s.apply({"op": "block_set", "block": block, "attributes": {"page_break_before": True, "align": "center"}}, None)
        s.apply({"op": "rule_insert", "block": block}, None)
        rule = next(b for b in s.doc["blocks"] if b["id"] == block)
        self.assertEqual(rule["attributes"], {"page_break_before": True})

    def test_the_section_of_the_paragraph_is_kept_for_the_new_paragraph(self):
        s, block = self.session_with("___")
        section = next(b for b in s.doc["blocks"] if b["id"] == block).get("section")
        s.apply({"op": "rule_insert", "block": block, "new_id": "n"}, None)
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == "n").get("section"), section)


class RuleLook(Workbench):
    def rule_session(self):
        s = self.new_session(text="___")
        block = s.doc["blocks"][-1]["id"]
        s.apply({"op": "rule_insert", "block": block, "new_id": "after"}, None)
        return s, block

    def test_thickness_colour_style_and_spacing_can_be_changed_and_undone(self):
        s, block = self.rule_session()
        s.apply({"op": "rule_set", "block": block, "rule": {"width_pt": 2.5, "color": "#AA0000", "style": "dashed", "space_after_pt": 12}}, None)
        look = next(b for b in s.doc["blocks"] if b["id"] == block)["extensions"][KEY]
        self.assertEqual(look, {"style": "dashed", "width_pt": 2.5, "color": "#AA0000", "space_before_pt": 6.0, "space_after_pt": 12.0})
        s.undo(None)
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["extensions"][KEY], hrule.DEFAULTS)

    def test_values_Writer_would_not_write_are_refused(self):
        s, block = self.rule_session()
        for bad in ({"width_pt": 0}, {"width_pt": 99}, {"width_pt": float("nan")}, {"width_pt": True}, {"color": "red"}, {"color": "#12345"},
                    {"style": "wavy"}, {"space_before_pt": -1}, {"space_after_pt": 500}, {"length": 5}):
            with self.assertRaises(Exception, msg=str(bad)):
                s.apply({"op": "rule_set", "block": block, "rule": bad}, None)
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["extensions"][KEY], hrule.DEFAULTS)

    def test_a_block_that_is_not_a_rule_cannot_be_given_a_look(self):
        s, _ = self.rule_session()
        with self.assertRaises(Exception):
            s.apply({"op": "rule_set", "block": "after", "rule": {"width_pt": 2}}, None)


class RuleStaysARule(Workbench):
    def setUp(self):
        super().setUp()
        self.s = self.new_session(text="___")
        self.block = self.s.doc["blocks"][-1]["id"]
        self.s.apply({"op": "rule_insert", "block": self.block, "new_id": "after"}, None)

    def test_no_text_can_be_typed_into_or_formatted_in_a_rule(self):
        for op in ({"op": "text", "block": self.block, "start": 0, "end": 0, "insert": "x"},
                   {"op": "block_set", "block": self.block, "style": "Heading 1"},
                   {"op": "block_set", "block": self.block, "attributes": {"align": "center"}},
                   {"op": "block_set", "block": self.block, "type": "heading"}):
            with self.assertRaises(Exception, msg=str(op)):
                self.s.apply(op, None)
        self.assertEqual(next(b for b in self.s.doc["blocks"] if b["id"] == self.block)["text"], "")

    def test_a_rule_cannot_also_be_a_shape(self):
        block = next(b for b in self.s.doc["blocks"] if b["id"] == self.block)
        with self.assertRaises(OpError):
            hrule.check_block({**block, "extensions": {KEY: hrule.DEFAULTS, "slai.writer.shape": {}}})

    def test_it_survives_save_reopen_and_validation(self):
        self.s.apply({"op": "rule_set", "block": self.block, "rule": {"width_pt": 3, "color": "#123456"}}, None)
        reopened = sldc().loads_package(self.s.to_bytes()).document
        sldc().validate_sldc(reopened) if hasattr(sldc(), "validate_sldc") else None
        rule = next(b for b in reopened["blocks"] if b["id"] == self.block)
        self.assertEqual(rule["extensions"][KEY]["width_pt"], 3.0)
        self.assertEqual(rule["extensions"][KEY]["color"], "#123456")
        self.assertEqual(rule["text"], "")
        self.assertEqual([b["id"] for b in reopened["blocks"]], [b["id"] for b in self.s.doc["blocks"]])

    def test_an_old_reader_sees_an_empty_paragraph(self):
        """The extension is inert data: removing it (what a reader that does not know it effectively does) leaves a valid empty paragraph."""
        doc = copy.deepcopy(self.s.doc)
        for block in doc["blocks"]:
            block.get("extensions", {}).pop(KEY, None)
            if "extensions" in block and not block["extensions"]:
                del block["extensions"]
        sldc().validate_sldc(doc)


class UndoStepsAreSeparate(Workbench):
    """A batch is one deliberate undo step: typing after it must not be merged into it (this is what lets Undo revert just one AutoCorrect change)."""

    def test_typing_after_a_batch_with_text_is_its_own_undo_step(self):
        s = self.new_session(text="hello")
        block = s.doc["blocks"][-1]["id"]
        s.apply({"op": "batch", "ops": [{"op": "text", "block": block, "start": 0, "end": 1, "insert": "H"}], "label": "AutoCorrect"}, None)
        s.apply({"op": "text", "block": block, "start": 5, "end": 5, "insert": " w"}, None)     # typing, well inside the coalescing window
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["text"], "Hello w")
        s.undo(None)
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["text"], "Hello", "Undo takes back the typing only")
        s.undo(None)
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["text"], "hello", "the next Undo takes back the correction")

    def test_plain_typing_still_merges_into_one_step(self):
        s = self.new_session(text="a")
        block = s.doc["blocks"][-1]["id"]
        for i, ch in enumerate("bcd"):
            s.apply({"op": "text", "block": block, "start": 1 + i, "end": 1 + i, "insert": ch}, None)
        s.undo(None)
        # "a" came from new_session's own typing op, so all four letters were one run of typing: back to the template's empty paragraph
        self.assertEqual(next(b for b in s.doc["blocks"] if b["id"] == block)["text"], "")


if __name__ == "__main__":
    unittest.main()


class RuleSurvivesSaveAndReopen(Workbench):
    """The rule is stored in the document itself (an extension on an empty paragraph), so it survives saving, reopening, copying a block and export."""

    def _with_rule(self):
        session = self.new_session("blank", title="Round trip")
        first = session.doc["blocks"][-1]["id"]
        session.apply({"op": "batch", "label": "build", "ops": [
            {"op": "block_insert", "after": first, "block": {"id": "above", "type": "paragraph", "text": "Above"}},
            {"op": "block_insert", "after": "above", "block": {"id": "mark", "type": "paragraph", "text": "___"}}]}, None)
        session.apply({"op": "rule_insert", "block": "mark", "new_id": "after", "rule": {"style": "dotted", "width_pt": 2.5, "color": "#aa5500"}}, None)
        return session

    def test_the_bytes_reopen_with_the_same_rule_and_the_same_blocks(self):
        from applications.slai_writer.tests.helpers import sldc
        session = self._with_rule()
        reopened = sldc().loads_package(session.to_bytes())
        blocks = {b["id"]: b for b in reopened.document["blocks"]}
        self.assertEqual(blocks["mark"]["extensions"]["slai.writer.rule"],
                         {"style": "dotted", "width_pt": 2.5, "color": "#aa5500", "space_before_pt": 6.0, "space_after_pt": 6.0})
        self.assertEqual((blocks["mark"]["type"], blocks["mark"]["text"]), ("paragraph", ""))
        order = [b["id"] for b in reopened.document["blocks"]]
        self.assertEqual(order[order.index("above"):order.index("above") + 3], ["above", "mark", "after"])
        self.assertEqual(reopened.document["blocks"][order.index("after")]["text"], "")

    def test_typing_below_the_rule_goes_into_the_paragraph_that_follows_it(self):
        session = self._with_rule()
        session.apply({"op": "text", "block": "after", "start": 0, "end": 0, "insert": "Next line"}, None)
        blocks = {b["id"]: b for b in session.doc["blocks"]}
        self.assertEqual(blocks["after"]["text"], "Next line")
        self.assertNotIn("slai.writer.rule", blocks["after"].get("extensions", {}))
        self.assertEqual(blocks["mark"]["text"], "")

    def test_a_rule_can_be_deleted_and_the_deletion_undone(self):
        session = self._with_rule()
        session.apply({"op": "block_delete", "blocks": ["mark"]}, None)
        self.assertNotIn("mark", [b["id"] for b in session.doc["blocks"]])
        session.undo(None)
        restored = {b["id"]: b for b in session.doc["blocks"]}
        self.assertEqual(restored["mark"]["extensions"]["slai.writer.rule"]["style"], "dotted")
