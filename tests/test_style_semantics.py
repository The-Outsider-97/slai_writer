"""Built-in named styles keep heading semantics and render via block styles."""
from __future__ import annotations

import unittest

from applications.slai_writer.ops import OpError
from applications.slai_writer.tests.helpers import Workbench


class SemanticStyles(Workbench):
    def test_defining_heading_style_updates_unstyled_semantic_headings(self):
        session = self.new_session()
        original = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_set", "block": original, "type": "heading", "attributes": {"level": 2}}, None)
        session.apply({"op": "style_define", "kind": "paragraph", "name": "Heading 2", "props": {"font_size_pt": 20, "color": "#123456"}}, None)
        self.assertEqual(session.doc["blocks"][-1]["style"], "Heading 2")
        self.assertEqual(session.doc["styles"]["paragraph"]["Heading 2"]["font_size_pt"], 20)

    def test_builtin_semantic_style_cannot_be_renamed_or_deleted(self):
        session = self.new_session()
        session.apply({"op": "style_define", "kind": "paragraph", "name": "Heading 1", "props": {"font_size_pt": 17}}, None)
        with self.assertRaises(OpError):
            session.apply({"op": "style_rename", "kind": "paragraph", "name": "Heading 1", "new_name": "Chapter"}, None)
        with self.assertRaises(OpError):
            session.apply({"op": "style_define", "kind": "paragraph", "name": "Heading 1", "delete": True}, None)


if __name__ == "__main__":
    unittest.main()
