"""Text boxes: a rectangle shape with styled paragraphs (SLDC `slai.writer.shape`, field `textbox`, schema version 1).

Covers the schema and its rejections, undo/redo, SLDC round-trip, legacy documents, pin and lock enforcement (including inside a batch), and export.
"""
import copy
import io
import unittest

from applications.slai_writer.ops import OpError, apply_operation
from applications.slai_writer.shape_export import prepare_shapes, render_shape_png, textbox_text
from applications.slai_writer.shape_validation import SHAPE_KEY, validate_shape
from applications.slai_writer.tests.helpers import Workbench


def box(paragraphs=None, **extra):
    paragraphs = paragraphs or [{"text": "Heading", "role": "heading1"}, {"text": "Body text here", "align": "center",
                                                                          "spans": [{"type": "format", "start": 0, "end": 4, "bold": True}]}]
    shape = {
        "version": 1, "kind": "rectangle", "width_mm": 80, "height_mm": 50, "rotation_deg": 0, "opacity": 1,
        "fill": {"enabled": True, "color": "#222222", "opacity": 1},
        "outline": {"enabled": True, "color": "#ffffff", "opacity": 1, "width_pt": 1.5, "style": "double"},
        "corners_mm": [3, 3, 3, 3],
        "text": {"content": "\n".join(p["text"] for p in paragraphs), "color": "#f0b43c", "font_size_pt": 12, "bold": False, "italic": False,
                 "align": "left", "padding_mm": 3, "spans": [], "fit": "keep", "font_family": "Georgia"},
        "shadows": [], "layout": {"mode": "inline"}, "z_index": 0,
        "textbox": {"version": 1, "paragraphs": paragraphs, "vertical_align": "top", "auto_expand": True, "pinned": False, "locked": False, "name": "Note"},
    }
    shape.update(extra)
    return shape


class TextBoxSchema(unittest.TestCase):
    def test_a_valid_text_box_round_trips_through_validation(self):
        shape = box()
        self.assertEqual(validate_shape(shape), shape)

    def test_every_rejection_names_a_real_problem(self):
        cases = {
            "unknown textbox version": lambda s: s["textbox"].update(version=2),
            "not a rectangle": lambda s: s.update(kind="ellipse", corners_mm=[0, 0, 0, 0]),
            "no paragraphs": lambda s: (s["textbox"].update(paragraphs=[]), s["text"].update(content="")),
            "too many paragraphs": lambda s: (s["textbox"].update(paragraphs=[{"text": "x"}] * 201), s["text"].update(content="\n".join(["x"] * 201))),
            "newline inside a paragraph": lambda s: (s["textbox"]["paragraphs"][0].update(text="a\nb")),
            "unknown role": lambda s: s["textbox"]["paragraphs"][0].update(role="heading9"),
            "unknown alignment": lambda s: s["textbox"]["paragraphs"][0].update(align="diagonal"),
            "unknown list kind": lambda s: s["textbox"]["paragraphs"][0].update(list="roman"),
            "style name with markup": lambda s: s["textbox"]["paragraphs"][0].update(style="<b>x</b>"),
            "line height out of range": lambda s: s["textbox"]["paragraphs"][0].update(line_height=9),
            "span past the end": lambda s: s["textbox"]["paragraphs"][1]["spans"].append({"type": "format", "start": 0, "end": 99, "bold": True}),
            "bad vertical alignment": lambda s: s["textbox"].update(vertical_align="sideways"),
            "pinned not boolean": lambda s: s["textbox"].update(pinned="yes"),
            "unknown field": lambda s: s["textbox"].update(onclick="x"),
            "mirror disagrees": lambda s: s["text"].update(content="something else"),
            "blank name": lambda s: s["textbox"].update(name=""),
            "bad font family": lambda s: s["text"].update(font_family="Arial;}"),
            "bad border style": lambda s: s["outline"].update(style="wavy"),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                bad = copy.deepcopy(box())
                mutate(bad)
                with self.assertRaises(OpError):
                    validate_shape(bad)

    def test_validation_never_mutates_its_input(self):
        shape = box()
        before = copy.deepcopy(shape)
        validate_shape(shape)
        self.assertEqual(shape, before)

    def test_non_bmp_text_uses_utf16_offsets(self):
        paragraphs = [{"text": "🧠 brain", "spans": [{"type": "format", "start": 3, "end": 8, "italic": True}]}]
        validate_shape(box(paragraphs))
        paragraphs[0]["spans"][0]["end"] = 9
        with self.assertRaises(OpError):
            validate_shape(box(paragraphs))

    def test_a_plain_shape_without_a_textbox_is_unchanged(self):
        shape = box()
        del shape["textbox"]
        shape["outline"]["style"] = "solid"
        self.assertEqual(validate_shape(shape), shape)


class TextBoxDocument(Workbench):
    def insert(self, session, shape=None, ident="tb"):
        session.apply({"op": "block_insert", "after": session.doc["blocks"][-1]["id"],
                       "block": {"id": ident, "type": "paragraph", "text": "", "extensions": {SHAPE_KEY: shape or box()}}}, None)
        return ident

    def stored(self, session, ident="tb"):
        return next(b for b in session.doc["blocks"] if b["id"] == ident)["extensions"][SHAPE_KEY]

    def test_insert_edit_undo_redo(self):
        session = self.new_session(text="Before")
        self.insert(session)
        edited = box([{"text": "Changed"}])
        session.apply({"op": "shape_set", "block": "tb", "shape": edited, "label": "edit text box"}, None)
        self.assertEqual(self.stored(session)["textbox"]["paragraphs"][0]["text"], "Changed")
        session.undo(None)
        self.assertEqual(self.stored(session)["textbox"]["paragraphs"][0]["text"], "Heading")
        session.redo(None)
        self.assertEqual(self.stored(session)["textbox"]["paragraphs"][0]["text"], "Changed")

    def test_sldc_round_trip_keeps_everything(self):
        from applications.slai_writer.session import sldc
        session = self.new_session(text="Before")
        self.insert(session)
        parsed = sldc().loads_package(session.to_bytes())
        block = next(b for b in parsed.document["blocks"] if b["id"] == "tb")
        self.assertEqual(block["extensions"][SHAPE_KEY], box())
        self.assertEqual(block["text"], "")

    def test_a_future_version_is_refused_not_mangled(self):
        session = self.new_session(text="Before")
        self.insert(session)
        future = box()
        future["textbox"]["version"] = 2
        before = copy.deepcopy(self.stored(session))
        with self.assertRaises(OpError):
            session.apply({"op": "shape_set", "block": "tb", "shape": future}, None)
        self.assertEqual(self.stored(session), before)

    def test_pin_stops_moving_but_not_editing_or_resizing(self):
        session = self.new_session(text="Before")
        shape = box(layout={"mode": "floating", "anchor": "page", "x_mm": 10, "y_mm": 20, "wrap": "none", "layer": "in_front_of_text"})
        shape["textbox"]["pinned"] = True
        self.insert(session, shape)
        moved = copy.deepcopy(shape)
        moved["layout"]["x_mm"] = 30
        with self.assertRaises(OpError) as caught:
            session.apply({"op": "shape_set", "block": "tb", "shape": moved}, None)
        self.assertIn("pinned", str(caught.exception).lower())
        resized = copy.deepcopy(shape)
        resized["width_mm"] = 120
        session.apply({"op": "shape_set", "block": "tb", "shape": resized}, None)
        self.assertEqual(self.stored(session)["width_mm"], 120)
        edited = box([{"text": "New words"}], layout=shape["layout"], width_mm=120)
        edited["textbox"]["pinned"] = True
        session.apply({"op": "shape_set", "block": "tb", "shape": edited}, None)
        self.assertEqual(self.stored(session)["textbox"]["paragraphs"][0]["text"], "New words")
        with self.assertRaises(OpError):
            session.apply({"op": "move", "blocks": ["tb"], "after": None}, None)
        unpinned = copy.deepcopy(edited)
        unpinned["textbox"]["pinned"] = False
        unpinned["layout"]["x_mm"] = 44
        session.apply({"op": "shape_set", "block": "tb", "shape": unpinned}, None)           # unpin and move in one step is allowed
        self.assertEqual(self.stored(session)["layout"]["x_mm"], 44)

    def test_lock_freezes_everything_including_inside_a_batch(self):
        session = self.new_session(text="Before")
        shape = box()
        shape["textbox"]["locked"] = True
        self.insert(session, shape)
        changed = copy.deepcopy(shape)
        changed["fill"]["color"] = "#000000"
        for operation in ({"op": "shape_set", "block": "tb", "shape": changed},
                          {"op": "block_delete", "blocks": ["tb"]},
                          {"op": "move", "blocks": ["tb"], "after": None},
                          {"op": "batch", "ops": [{"op": "shape_set", "block": "tb", "shape": changed}]},
                          {"op": "batch", "ops": [{"op": "block_delete", "blocks": ["tb"]}]}):
            with self.subTest(operation["op"]), self.assertRaises(OpError) as caught:
                session.apply(operation, None)
            self.assertIn("locked", str(caught.exception).lower())
        self.assertEqual(self.stored(session), shape)
        unlocked = copy.deepcopy(shape)
        unlocked["textbox"]["locked"] = False
        session.apply({"op": "shape_set", "block": "tb", "shape": unlocked}, None)
        session.apply({"op": "block_delete", "blocks": ["tb"]}, None)
        self.assertFalse(any(b["id"] == "tb" for b in session.doc["blocks"]))

    def test_the_carrier_still_cannot_hold_document_text(self):
        session = self.new_session(text="Before")
        self.insert(session)
        with self.assertRaises(OpError):
            session.apply({"op": "text", "block": "tb", "start": 0, "end": 0, "insert": "x"}, None)

    def test_a_text_box_beside_a_table_and_a_heading_leaves_them_alone(self):
        doc = {"title": "t", "sections": [{"id": "s1"}], "blocks": [
            {"id": "h", "type": "heading", "text": "Heading", "attributes": {"level": 1}, "section": "s1"},
            {"id": "t", "type": "table", "text": "", "section": "s1", "table": {"columns": 1, "header_rows": 0, "rows": [[{"text": "a"}]]}},
            {"id": "tb", "type": "paragraph", "text": "", "section": "s1", "extensions": {SHAPE_KEY: box(layout={"mode": "floating", "anchor": "block", "target": "t",
                                                                                                           "x_mm": 5, "y_mm": 5, "wrap": "top_bottom", "layer": "content"})}}]}
        apply_operation(doc, {"op": "shape_set", "block": "tb", "shape": box(layout={"mode": "floating", "anchor": "block", "target": "h", "x_mm": 1, "y_mm": 2,
                                                                                    "wrap": "none", "layer": "behind_text"})})
        self.assertEqual(doc["blocks"][0]["text"], "Heading")
        self.assertEqual(doc["blocks"][1]["table"]["rows"][0][0]["text"], "a")
        self.assertEqual(doc["blocks"][2]["extensions"][SHAPE_KEY]["layout"]["target"], "h")


class TextBoxExport(unittest.TestCase):
    def test_paragraph_styles_reach_the_painter(self):
        shape = validate_shape(box([{"text": "Big", "role": "heading1"}, {"text": "small", "align": "right"}, {"text": "item", "list": "bullet"},
                                    {"text": "one", "list": "number"}, {"text": "two", "list": "number"}]))
        painted = textbox_text(shape, None)
        self.assertEqual(painted["content"], "Big\nsmall\n• item\n1. one\n2. two")
        self.assertGreater(painted["per_char"][0]["base"]["font_size_pt"], painted["per_char"][5]["base"]["font_size_pt"])
        self.assertTrue(painted["per_char"][0]["base"]["bold"])
        self.assertEqual(painted["per_char"][5]["align"], "right")
        self.assertEqual(painted["valign"], "top")

    def test_a_named_style_comes_from_the_document_definition(self):
        styles = {"paragraph": {"Scripture": {"font_family": "Times New Roman", "font_size_pt": 11, "italic": True, "align": "left"}}}
        shape = validate_shape(box([{"text": "Word", "style": "Scripture"}]))
        painted = textbox_text(shape, styles)
        self.assertEqual(painted["per_char"][0]["base"]["font_size_pt"], 11.0)
        self.assertTrue(painted["per_char"][0]["base"]["italic"])

    def test_scripture_without_a_document_definition_uses_the_built_in_one(self):
        shape = validate_shape(box([{"text": "Word", "style": "Scripture"}]))
        painted = textbox_text(shape, None)
        self.assertTrue(painted["per_char"][0]["base"]["italic"])
        self.assertEqual(painted["per_char"][0]["base"]["font_size_pt"], 11.0)
        edited = textbox_text(shape, {"paragraph": {"Scripture": {"italic": False, "font_size_pt": 14}}})   # the person's own edit wins
        self.assertFalse(edited["per_char"][0]["base"]["italic"])
        self.assertEqual(edited["per_char"][0]["base"]["font_size_pt"], 14.0)

    def test_spans_move_with_their_paragraph(self):
        shape = validate_shape(box([{"text": "ab"}, {"text": "cdef", "spans": [{"type": "format", "start": 1, "end": 3, "bold": True}]}]))
        painted = textbox_text(shape, None)
        self.assertEqual(painted["content"], "ab\ncdef")
        self.assertEqual((painted["spans"][0]["start"], painted["spans"][0]["end"]), (4, 6))

    def test_png_is_rendered_and_differs_with_the_text(self):
        a, width = render_shape_png(validate_shape(box()))
        b, _ = render_shape_png(validate_shape(box([{"text": "Something else entirely"}])))
        from PIL import Image
        image = Image.open(io.BytesIO(a))
        self.assertGreater(image.width, 100)
        self.assertGreater(width, 80)
        self.assertNotEqual(a, b)
        self.assertIsNotNone(image.getchannel("A").getbbox())

    def test_a_text_box_becomes_a_figure_for_pdf_and_the_original_is_untouched(self):
        from applications.slai_writer.session import sldc
        from applications.slai_writer.templates import build
        package = build(sldc(), "blank", title="x")
        package.document["blocks"].append({"id": "tb", "type": "paragraph", "text": "", "extensions": {SHAPE_KEY: box()}})
        before = copy.deepcopy(package.document["blocks"][-1])
        output, warnings = prepare_shapes(package, "pdf", sldc())
        converted = next(b for b in output.document["blocks"] if b["id"] == "tb")
        self.assertEqual(converted["type"], "figure")
        self.assertTrue(warnings)
        self.assertEqual(package.document["blocks"][-1], before)
        text_only, _ = prepare_shapes(package, "txt", sldc())
        self.assertIn("shape", next(b for b in text_only.document["blocks"] if b["id"] == "tb")["text"])


if __name__ == "__main__":
    unittest.main()
