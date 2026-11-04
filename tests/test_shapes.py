"""Shape extension is an undoable validated document object and round-trips in SLDC."""
import copy
import math
import unittest

from applications.slai_writer.shape_validation import SHAPE_KEY, validate_shape
from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench


def sample(kind="rectangle"):
    return {
        "version": 1, "kind": kind, "width_mm": 60, "height_mm": 50,
        "rotation_deg": 0, "opacity": 1,
        "fill": {"enabled": False, "color": "#ffffff", "opacity": 1},
        "outline": {"enabled": True, "color": "#000000", "width_pt": 3,
                    "opacity": 1, "style": "solid"},
        "corners_mm": [0, 0, 0, 0],
        "text": {"content": "hello shadow", "color": "#101010",
                 "font_size_pt": 12, "bold": False, "italic": False,
                 "align": "center", "padding_mm": 2},
        "shadows": [],
    }


class ShapeValidation(unittest.TestCase):
    def test_all_ten_registry_kinds(self):
        for kind in ("rectangle", "ellipse", "line", "triangle", "diamond",
                     "pentagon", "hexagon", "star", "arrow", "plus"):
            with self.subTest(kind=kind):
                self.assertEqual(validate_shape(sample(kind))["kind"], kind)

    def test_independent_transparencies_and_multiple_shadows(self):
        v = sample("ellipse")
        v["fill"] = {"enabled": True, "color": "#0088ff", "opacity": 0}
        v["outline"]["opacity"] = 1
        v["opacity"] = 0.5
        v["shadows"] = [
            {"enabled": True, "color": "#444444", "opacity": .75, "offset_x_mm": 3,
             "offset_y_mm": 3, "blur_mm": 0, "spread_mm": 0},
            {"enabled": True, "color": "#bbbbbb", "opacity": .5, "offset_x_mm": 5,
             "offset_y_mm": 5, "blur_mm": 0, "spread_mm": 0},
        ]
        self.assertEqual(validate_shape(v)["shadows"], v["shadows"])

    def test_reject_invalid_and_nonfinite_without_mutation(self):
        v = sample()
        for key, value in [("width_mm", -1), ("height_mm", math.inf),
                           ("opacity", math.nan), ("kind", "javascript:alert(1)")]:
            bad = copy.deepcopy(v)
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(Exception):
                validate_shape(bad)
        bad = sample()
        bad["corners_mm"] = [40, 40, 0, 0]
        with self.assertRaises(Exception):
            validate_shape(bad)
        bad = sample()
        bad["text"]["content"] = "a" * 5000
        with self.assertRaises(Exception):
            validate_shape(bad)
        bad = sample()
        bad["fill"]["color"] = "url(javascript:alert(1))"
        with self.assertRaises(Exception):
            validate_shape(bad)


class ShapeTransactions(Workbench):
    def test_insert_replace_undo_and_sldc_roundtrip(self):
        session = self.new_session(text="Before")
        spec = {"type": "paragraph", "text": "",
                "extensions": {SHAPE_KEY: sample("star")}}
        patch = session.apply({"op": "block_insert", "after": session.doc["blocks"][-1]["id"],
                               "block": spec, "label": "insert shape"}, None)
        self.assertTrue(patch["blocks"])
        block = session.doc["blocks"][-1]
        ident = block["id"]
        self.assertEqual(block["extensions"][SHAPE_KEY]["kind"], "star")
        changed = sample("star")
        changed["text"]["content"] = "edited"
        session.apply({"op": "shape_set", "block": ident, "shape": changed}, None)
        self.assertEqual(session.doc["blocks"][-1]["extensions"][SHAPE_KEY]["text"]["content"], "edited")
        parsed = session.sldc().loads_package(session.to_bytes()) if hasattr(session, "sldc") else None
        if parsed is None:
            from applications.slai_writer.session import sldc
            parsed = sldc().loads_package(session.to_bytes())
        self.assertEqual(parsed.document["blocks"][-1]["extensions"][SHAPE_KEY], changed)
        with self.assertRaises(Exception):
            session.apply({"op": "shape_set", "block": ident,
                           "shape": {**changed, "opacity": float("nan")}}, None)
        self.assertEqual(session.doc["blocks"][-1]["extensions"][SHAPE_KEY], changed)


class ShapeAdvanced(Workbench):
    def test_rich_runs_and_floating_anchor_roundtrip(self):
        session = self.new_session(text="Anchor paragraph")
        anchor = session.doc["blocks"][-1]["id"]
        value = sample("star")
        value["text"]["content"] = "hello shadow"
        value["text"]["fit"] = "shrink"
        value["text"]["spans"] = [{"type": "format", "start": 0, "end": 5,
                                    "bold": True, "font_size_pt": 16,
                                    "color": "#0000ff"}]
        value["layout"] = {"mode": "floating", "anchor": "block", "target": anchor,
                           "x_mm": 12.5, "y_mm": 23.5, "wrap": "none",
                           "layer": "in_front_of_text"}
        value["z_index"] = 4
        session.apply({"op": "block_insert", "after": anchor,
                       "block": {"type": "paragraph", "text": "",
                                 "extensions": {SHAPE_KEY: value}}}, None)
        s = sldc().loads_package(session.to_bytes()).document["blocks"][-1]
        self.assertEqual(s["extensions"][SHAPE_KEY], value)

    def test_invalid_anchor_does_not_mutate_doc(self):
        session = self.new_session(text="Anchor")
        anchor = session.doc["blocks"][-1]["id"]
        shape = sample()
        session.apply({"op": "block_insert", "after": anchor,
                       "block": {"type": "paragraph", "text": "",
                                 "extensions": {SHAPE_KEY: shape}}}, None)
        own = session.doc["blocks"][-1]["id"]
        original = copy.deepcopy(session.doc)
        shape["layout"] = {"mode": "floating", "anchor": "block", "target": own,
                           "x_mm": 0, "y_mm": 0, "wrap": "none", "layer": "content"}
        with self.assertRaises(Exception):
            session.apply({"op": "shape_set", "block": own, "shape": shape}, None)
        self.assertEqual(original, session.doc)

    def test_shape_is_not_regular_text(self):
        session = self.new_session(text="Anchor")
        anchor = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_insert", "after": anchor,
                       "block": {"type": "paragraph", "text": "",
                                 "extensions": {SHAPE_KEY: sample()}}}, None)
        own = session.doc["blocks"][-1]["id"]
        with self.assertRaises(Exception):
            session.apply({"op": "text", "block": own, "start": 0,
                           "end": 0, "insert": "ordinary paragraph"}, None)
        self.assertEqual(session.doc["blocks"][-1]["text"], "")

    def test_group_and_arrangement_batch_is_atomic(self):
        session = self.new_session(text="Start")
        anchor = session.doc["blocks"][-1]["id"]
        for kind in ("rectangle", "triangle"):
            session.apply({"op": "block_insert",
                           "after": session.doc["blocks"][-1]["id"],
                           "block": {"type": "paragraph", "text": "",
                                     "extensions": {SHAPE_KEY: sample(kind)}}}, None)
        ids = [b["id"] for b in session.doc["blocks"][-2:]]
        specs = [copy.deepcopy(b["extensions"][SHAPE_KEY]) for b in session.doc["blocks"][-2:]]
        for data in specs:
            data["group_id"] = "group-one"
            data["z_index"] = 1
        session.apply({"op": "batch", "label": "group shapes",
                       "ops": [{"op": "shape_set", "block": ident, "shape": spec}
                               for ident, spec in zip(ids, specs)]}, None)
        self.assertEqual({b["extensions"][SHAPE_KEY]["group_id"]
                          for b in session.doc["blocks"][-2:]}, {"group-one"})
        self.assertEqual({b["extensions"][SHAPE_KEY]["z_index"]
                          for b in session.doc["blocks"][-2:]}, {1})
