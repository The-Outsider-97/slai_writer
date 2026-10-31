"""Integration regression for real bundled fonts, cover semantics, and SLDC spans."""
import tempfile
import unittest
from pathlib import Path

from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench
from applications.slai_writer.routes_tools import document_font_file, document_fonts
from src.utils.doc.fonts import FONT_ROOT, bundled_catalogue, discover_fonts, resolve_bundled_font


class BundledFontTests(unittest.TestCase):
    def test_font_catalogue_has_real_faces_and_no_filesystem_paths(self):
        self.assertTrue(FONT_ROOT.is_dir())
        catalog = bundled_catalogue()
        self.assertGreaterEqual(len(catalog["families"]), 6)
        self.assertIn("EB Garamond", catalog["families"])
        for face in catalog["faces"]:
            self.assertNotIn("path", face)
            actual = resolve_bundled_font(face["id"])
            self.assertIsNotNone(actual)
            self.assertTrue(actual.path.is_file())
            self.assertIsNotNone(face["license"])

    def test_invalid_font_and_untrusted_face_ids_are_not_resolved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "Broken.ttf").write_bytes(b"not a font")
            self.assertEqual(discover_fonts(root), ())
            self.assertEqual(bundled_catalogue(root)["faces"], [])
        self.assertIsNone(resolve_bundled_font("../../etc/passwd"))

    def test_served_font_bytes_are_from_the_indexed_face(self):
        data = document_fonts(None, None)
        font = data["faces"][0]
        request = type("Request", (), {"params": {"face_id": font["id"]}})()
        reply = document_font_file(None, request)
        self.assertTrue(reply.content_type.startswith("font/"))
        self.assertEqual(reply.body[:4], resolve_bundled_font(font["id"]).path.read_bytes()[:4])
        with self.assertRaises(Exception):
            document_font_file(None, type("Request", (), {"params": {"face_id": "../../../etc/passwd"}})())


class CoverAndSpacingTests(Workbench):
    def test_style_lifecycle_renames_references_and_prevents_dangling_parents(self):
        session = self.new_session(text="A style example")
        bid = session.doc["blocks"][-1]["id"]
        session.apply({"op": "batch", "ops": [
            {"op": "style_define", "kind": "paragraph", "name": "Section Style", "props": {"font_size_pt": 14}},
            {"op": "style_define", "kind": "paragraph", "name": "Derived", "props": {"based_on": "Section Style"}},
            {"op": "block_set", "block": bid, "style": "Section Style"},
        ]}, None)
        session.apply({"op": "style_rename", "kind": "paragraph", "name": "Section Style", "new_name": "Renamed Style"}, None)
        styles = session.doc["styles"]["paragraph"]
        self.assertNotIn("Section Style", styles)
        self.assertEqual(styles["Derived"]["based_on"], "Renamed Style")
        self.assertEqual(session.doc["blocks"][-1]["style"], "Renamed Style")
        with self.assertRaises(Exception):
            session.apply({"op": "style_define", "kind": "paragraph", "name": "Renamed Style", "delete": True}, None)
        session.undo(None)
        self.assertIn("Section Style", session.doc["styles"]["paragraph"])
        sldc().validate_package(session.pkg)

    def test_named_title_style_can_be_created_and_applied_atomically(self):
        session = self.new_session(text="My manuscript")
        block = session.doc["blocks"][-1]["id"]
        former = dict(session.doc["styles"]["paragraph"]["Title"])
        session.apply({"op": "batch", "ops": [
            {"op": "style_define", "kind": "paragraph", "name": "Title",
             "props": {"font_family": "EB Garamond", "font_size_pt": 30, "bold": True}},
            {"op": "block_set", "block": block, "type": "paragraph", "style": "Title"}],
                       "label": "apply title"}, None)
        document = sldc().loads_package(session.to_bytes()).document
        self.assertEqual(document["blocks"][-1]["style"], "Title")
        self.assertEqual(document["styles"]["paragraph"]["Title"]["font_size_pt"], 30)
        session.undo(None)
        self.assertEqual(session.doc["styles"]["paragraph"]["Title"], former)

    def test_cover_insert_and_remove_preserve_content_and_sections(self):
        session = self.new_session(text="First chapter")
        old_ids = [b["id"] for b in session.doc["blocks"]]
        session.apply({"op": "cover_insert"}, None)
        cover = session.doc["sections"][0]
        self.assertEqual(cover["role"], "cover")
        self.assertFalse(cover["numbering"]["show"])
        self.assertEqual(session.doc["blocks"][0]["section"], cover["id"])
        self.assertTrue(all(b["section"] != cover["id"] for b in session.doc["blocks"][1:]))
        self.assertEqual([b["id"] for b in session.doc["blocks"][1:]], old_ids)
        restored = sldc().loads_package(session.to_bytes()).document
        self.assertEqual(restored["sections"][0]["role"], "cover")
        self.assertFalse(restored["sections"][0]["numbering"]["show"])
        session.apply({"op": "cover_unmark"}, None)
        self.assertEqual([b["id"] for b in session.doc["blocks"][1:]], old_ids)
        self.assertNotIn("role", session.doc["sections"][0])
        session.undo(None)
        self.assertEqual(session.doc["sections"][0]["role"], "cover")

    def test_letter_and_word_spacing_precise_and_persistent(self):
        session = self.new_session(text="A word and a word")
        block = session.doc["blocks"][-1]["id"]
        session.apply({"op": "format", "block": block, "start": 2, "end": 6,
                       "set": {"letter_spacing_pt": 0.5, "word_spacing_pt": 0, "color": "#456789"}}, None)
        saved = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        span = next(s for s in saved["spans"] if s.get("letter_spacing_pt") == 0.5)
        self.assertEqual((span["start"], span["end"]), (2, 6))
        self.assertEqual(span["word_spacing_pt"], 0)
        self.assertEqual(span["color"], "#456789")
        session.apply({"op": "format", "block": block, "start": 2, "end": 6,
                       "unset": ["letter_spacing_pt"]}, None)
        self.assertTrue(any(s.get("color") == "#456789" for s in session.doc["blocks"][-1]["spans"]))
        with self.assertRaises(Exception):
            session.apply({"op": "format", "block": block, "start": 2, "end": 6,
                           "set": {"word_spacing_pt": 9999}}, None)


if __name__ == "__main__":
    unittest.main()
