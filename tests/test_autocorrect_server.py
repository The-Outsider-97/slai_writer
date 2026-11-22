"""The server half of AutoCorrect: the operations the editor sends for a typed keystroke and its correction (see src/client/autocorrect_dom.ts).

A correction is a *labelled batch* sent right after the keystroke's own text operation, so Undo takes back the correction and leaves what was typed; and
offsets are code points, so everything lands in the right place after an emoji."""
import unittest

from .helpers import Workbench

LABEL = "AutoCorrect: em dash"


class CorrectionIsItsOwnUndoStep(Workbench):
    def setUp(self):
        super().setUp()
        self.session = self.new_session("blank", title="Typing")
        self.block = self.session.doc["blocks"][-1]["id"]

    def text(self):
        return {b["id"]: b for b in self.session.doc["blocks"]}[self.block]["text"]

    def type_(self, at, chars):
        self.session.apply({"op": "text", "block": self.block, "start": at, "end": at, "insert": chars}, None)

    def correct(self, start, end, insert, label=LABEL):
        self.session.apply({"op": "batch", "label": label, "ops": [{"op": "text", "block": self.block, "start": start, "end": end, "insert": insert}]}, None)

    def top_label(self):
        return self.session.undo_stack[-1].undo.label

    def test_undo_takes_back_the_dash_and_keeps_the_hyphens(self):
        base = len(self.text())
        self.type_(base, "a-")
        self.type_(base + 2, "-")                 # the second hyphen: "a--"
        self.correct(base + 1, base + 3, "—")
        self.assertEqual(self.text()[base:], "a—")
        self.assertEqual(self.top_label(), LABEL, "the client recognises its own step by this label")
        self.session.undo(None)
        self.assertEqual(self.text()[base:], "a--")
        self.assertNotEqual(self.top_label(), LABEL)

    def test_text_typed_after_a_correction_is_not_merged_into_it(self):
        base = len(self.text())
        self.type_(base, "hello")
        self.correct(base, base + 1, "H", "AutoCorrect: capital letter")
        self.type_(base + 5, " ")
        self.type_(base + 6, "w")
        self.session.undo(None)                   # the typing since the correction (one coalesced step)
        self.assertEqual(self.text()[base:], "Hello")
        self.session.undo(None)                   # the correction
        self.assertEqual(self.text()[base:], "hello")

    def test_offsets_are_code_points_so_a_correction_after_an_emoji_lands_right(self):
        base = len(self.text())
        self.type_(base, "\U0001F600 hello")      # the emoji is one character for the server (two UTF-16 units in the browser)
        self.correct(base + 2, base + 3, "H", "AutoCorrect: capital letter")
        self.assertEqual(self.text()[base:], "\U0001F600 Hello")
        with self.assertRaises(Exception):        # the browser's UTF-16 offset (8) is past the end for the server: this is what the editor used to send
            self.type_(base + 8, "!")
        self.type_(base + 7, "!")                 # the same place in code points
        self.assertEqual(self.text()[base:], "\U0001F600 Hello!")

    def test_redo_makes_the_correction_again(self):
        base = len(self.text())
        self.type_(base, "x--")
        self.correct(base + 1, base + 3, "—")
        self.session.undo(None)
        self.session.redo(None)
        self.assertEqual(self.text()[base:], "x—")


if __name__ == "__main__":
    unittest.main()
