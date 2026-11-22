"""Shapes in headers and footers: the operations (validation, undo, linked and unlinked sections, first page, odd and even), where a page puts them, and the document
saved and opened again."""
from __future__ import annotations

import copy
import unittest

from applications.slai_writer import bands
from applications.slai_writer.ops import OpError
from applications.slai_writer.session import sldc
from .helpers import Workbench

EXT = "slai.writer"


def shape(kind="rectangle", w=40, h=8, **extra):
    base = {"version": 1, "kind": kind, "width_mm": w, "height_mm": h, "rotation_deg": 0, "fill": {"enabled": True, "color": "#336699", "opacity": 1},
            "outline": {"enabled": True, "color": "#112233", "opacity": 1, "width_pt": 1, "style": "solid"}, "opacity": 1, "corners_mm": [0, 0, 0, 0],
            "text": {"content": "", "color": "#222222", "font_size_pt": 10, "bold": False, "italic": False, "align": "center", "padding_mm": 0}, "shadows": []}
    base.update(extra)
    return base


def item(ident, **extra):
    return {"id": ident, "shape": shape(), "x_mm": 10, "y_mm": 6, **extra}


class Model(Workbench):
    def doc(self, sections=2):
        s = self.new_session("blank", title="Bands")
        last = s.doc["blocks"][-1]["id"]
        for n in range(6):
            s.apply({"op": "block_insert", "after": last, "block": {"id": f"p{n}", "type": "paragraph", "text": f"Text {n}.", "attributes": {"page_break_before": n > 0}}}, None)
            last = f"p{n}"
        if sections > 1:
            s.apply({"op": "section_break", "block": "p3"}, None)
        return s

    def bs(self, s):
        return ((s.doc.get("extensions") or {}).get(EXT) or {}).get("band_shapes") or {}

    def put(self, s, ident, section=None, edge="header", variant="default", **extra):
        return s.apply({"op": "band_shape_set", "section": section, "edge": edge, "variant": variant, "item": item(ident, **extra)}, None)

    def ids(self, s, section, edge="header", variant="default"):
        return [i["id"] for i in bands.items_of(s.doc, section, edge, variant)]

    def test_a_document_without_them_is_unchanged_and_with_them_it_saves_and_opens_again(self):
        s = self.doc()
        sections = [x["id"] for x in s.doc["sections"]]
        self.assertEqual(self.bs(s), {})
        before = sldc().revision_id(s.pkg)
        self.put(s, "a", sections[0])
        self.put(s, "b", sections[1], edge="footer")
        self.assertNotEqual(sldc().revision_id(s.pkg), before)
        self.assertEqual(self.ids(s, sections[0]), ["a"])
        self.assertEqual(self.ids(s, sections[1], "footer"), ["b"])
        reopened = sldc().loads_package(s.to_bytes()).document
        self.assertEqual(((reopened.get("extensions") or {}).get(EXT) or {}).get("band_shapes"), self.bs(s))
        sldc().validate_package(s.pkg)
        self.assertEqual(bands.items_of(reopened, sections[0], "header", "default")[0]["shape"]["kind"], "rectangle")

    def test_every_change_is_one_undo_step_and_redoes(self):
        s = self.doc(1)
        sec = s.doc["sections"][0]["id"]
        self.put(s, "a", sec)
        self.assertEqual(self.ids(s, sec), ["a"])
        s.apply({"op": "band_shape_set", "section": sec, "edge": "header", "item": {"id": "a", "x_mm": 33}}, None)
        s.undo(None)
        self.assertEqual(bands.items_of(s.doc, sec, "header", "default")[0]["x_mm"], 10)
        s.undo(None)
        self.assertEqual(self.bs(s), {})
        s.redo(None); s.redo(None)
        self.assertEqual(bands.items_of(s.doc, sec, "header", "default")[0]["x_mm"], 33)

    def test_the_shape_is_a_body_shape_and_bad_ones_are_refused_without_changing_anything(self):
        s = self.doc(1)
        sec = s.doc["sections"][0]["id"]
        before = sldc().revision_id(s.pkg)
        bad = [{"id": "x", "shape": shape(kind="blob")}, {"id": "x", "shape": shape(w=1)}, {"id": "x", "shape": shape(), "layer": "middle"}, {"id": "x", "shape": shape(), "x_mm": "a"},
               {"id": "x", "shape": shape(), "x_mm": 99999}, {"id": "bad id", "shape": shape()}, {"id": "x", "shape": shape(), "extra": 1}, {"id": "x", "shape": shape(), "locked": "yes"},
               {"id": "x", "shape": {**shape(), "unknown": 1}}, {"id": "x"}]
        for raw in bad:
            with self.assertRaises(OpError, msg=str(raw)):
                s.apply({"op": "band_shape_set", "section": sec, "edge": "header", "item": raw}, None)
        for raw in ({"edge": "side"}, {"edge": "header", "variant": "odd"}, {"edge": "header", "section": "nope"}):
            with self.assertRaises(OpError, msg=str(raw)):
                s.apply({"op": "band_shape_set", "item": item("y"), **raw}, None)
        self.assertEqual(sldc().revision_id(s.pkg), before)

    def test_every_kind_a_body_shape_has_and_a_text_box_are_accepted(self):
        s = self.doc(1)
        sec = s.doc["sections"][0]["id"]
        for n, kind in enumerate(("rectangle", "ellipse", "line", "triangle", "diamond", "pentagon", "hexagon", "star", "arrow", "plus")):
            s.apply({"op": "band_shape_set", "section": sec, "edge": "footer", "item": {"id": f"k{n}", "shape": shape(kind, 30, 6 if kind != "line" else 2), "x_mm": n}}, None)
        s.apply({"op": "band_shape_set", "section": sec, "edge": "footer", "item": {"id": "rr", "shape": shape(corners_mm=[3, 3, 3, 3], opacity=0.5), "x_mm": 1}}, None)
        self.assertEqual(len(self.ids(s, sec, "footer")), 11)
        sldc().validate_package(s.pkg)

    def test_pages_of_other_definitions_are_not_touched(self):
        s = self.doc()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "h1", a)
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True}, None)
        self.put(s, "ev", a, variant="even")
        self.put(s, "ft", a, edge="footer")
        self.assertEqual((self.ids(s, a), self.ids(s, a, variant="even"), self.ids(s, a, "footer"), self.ids(s, b)), (["h1"], ["ev"], ["ft"], []))
        self.assertEqual(bands.shapes_for_page(s.doc, a, "header", 1, True)[0][0]["id"], "h1")
        self.assertEqual(bands.shapes_for_page(s.doc, a, "header", 2, False)[0][0]["id"], "ev")
        self.assertEqual(bands.shapes_for_page(s.doc, a, "header", 3, False)[0][0]["id"], "h1")
        self.assertEqual(bands.shapes_for_page(s.doc, b, "header", 4, True)[0], [])

    def test_an_even_page_without_its_own_shapes_shows_the_ordinary_ones_from_the_other_side_in_a_book(self):
        s = self.doc(1)
        a = s.doc["sections"][0]["id"]
        self.put(s, "h1", a)
        s.apply({"op": "page_layout", "scope": "document", "mirror": True}, None)
        shapes, variant, mirrored = bands.shapes_for_page(s.doc, a, "header", 2, False)
        self.assertEqual((variant, mirrored, [i["id"] for i in shapes]), ("default", True, ["h1"]))
        self.assertFalse(bands.shapes_for_page(s.doc, a, "header", 1, True)[2])
        s.apply({"op": "page_layout", "scope": "document", "mirror_edges": False}, None)
        self.assertFalse(bands.shapes_for_page(s.doc, a, "header", 2, False)[2])

    def test_first_page_has_its_own_shapes_only_while_it_is_asked_for(self):
        s = self.doc()
        a = s.doc["sections"][0]["id"]
        self.put(s, "h1", a)
        self.assertEqual(bands.variant_for(s.doc, a, 1, True), "default")
        s.apply({"op": "band_config", "section": a, "first_page": True}, None)
        self.put(s, "f1", a, variant="first")
        self.assertEqual((bands.variant_for(s.doc, a, 1, True), bands.variant_for(s.doc, a, 2, False)), ("first", "default"))
        self.assertEqual([i["id"] for i in bands.shapes_for_page(s.doc, a, "header", 1, True)[0]], ["f1"])
        s.apply({"op": "band_config", "section": a, "first_page": False}, None)
        self.assertEqual(self.ids(s, a, variant="first"), [], "turning it off takes its shapes with it")
        self.assertEqual(bands.variant_for(s.doc, a, 1, True), "default")

    def test_linked_sections_share_one_definition_and_unlinking_copies_it(self):
        s = self.doc()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "h1", a)
        self.assertEqual(self.ids(s, b), [], "a section has its own band until it is linked")
        s.apply({"op": "band_config", "section": b, "link": {"header": True}}, None)
        self.assertEqual(self.ids(s, b), ["h1"], "linked: the previous section's")
        self.assertEqual(bands.owner(s.doc, b, "header"), a)
        self.put(s, "h2", b)                                                  # edited in the linked section: edits the shared definition
        self.assertEqual((self.ids(s, a), self.ids(s, b)), (["h1", "h2"], ["h1", "h2"]))
        self.assertEqual(bands.owner(s.doc, b, "footer"), b, "the footer is not linked")
        s.apply({"op": "band_config", "section": b, "link": {"header": False}}, None)
        self.assertEqual(len(self.ids(s, b)), 2, "unlinking keeps what the pages showed")
        self.assertNotEqual(self.ids(s, b), self.ids(s, a), "with ids of its own")
        s.apply({"op": "band_shape_delete", "section": b, "edge": "header", "ids": [self.ids(s, b)[0]]}, None)
        self.assertEqual((len(self.ids(s, a)), len(self.ids(s, b))), (2, 1), "and from now on independent")
        with self.assertRaises(OpError):
            s.apply({"op": "band_config", "section": a, "link": {"header": True}}, None)

    def test_lock_order_duplicate_and_delete(self):
        s = self.doc(1)
        sec = s.doc["sections"][0]["id"]
        for ident in ("a", "b", "c"):
            self.put(s, ident, sec)
        s.apply({"op": "band_shape_order", "section": sec, "edge": "header", "id": "a", "to": "front"}, None)
        self.assertEqual(self.ids(s, sec), ["b", "c", "a"])
        s.apply({"op": "band_shape_order", "section": sec, "edge": "header", "id": "a", "to": "backward"}, None)
        s.apply({"op": "band_shape_order", "section": sec, "edge": "header", "id": "c", "to": "back"}, None)
        self.assertEqual(self.ids(s, sec), ["c", "b", "a"])
        s.apply({"op": "band_shape_duplicate", "section": sec, "edge": "header", "id": "b", "new_id": "b2", "dx_mm": 7}, None)
        dup = next(i for i in bands.items_of(s.doc, sec, "header", "default") if i["id"] == "b2")
        self.assertEqual((dup["x_mm"], dup["y_mm"]), (17, 11))
        self.assertEqual(self.ids(s, sec), ["c", "b", "b2", "a"])
        s.apply({"op": "band_shape_set", "section": sec, "edge": "header", "item": {"id": "b", "locked": True}}, None)
        for op in ({"op": "band_shape_set", "item": {"id": "b", "x_mm": 1}}, {"op": "band_shape_delete", "ids": ["b"]}):
            with self.assertRaises(OpError):
                s.apply({"section": sec, "edge": "header", **op}, None)
        s.apply({"op": "band_shape_set", "section": sec, "edge": "header", "item": {"id": "b", "locked": False}}, None)
        s.apply({"op": "band_shape_delete", "section": sec, "edge": "header", "ids": ["b", "a"]}, None)
        self.assertEqual(self.ids(s, sec), ["c", "b2"])
        with self.assertRaises(OpError):
            s.apply({"op": "band_shape_delete", "section": sec, "edge": "header", "ids": ["zzz"]}, None)
        s.apply({"op": "band_shape_delete", "section": sec, "edge": "header", "ids": ["c", "b2"]}, None)
        self.assertEqual(self.bs(s), {}, "an empty store leaves nothing in the document")

    def test_ids_are_unique_across_the_document_and_the_limit_holds(self):
        s = self.doc()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "same", a)
        with self.assertRaises(OpError):
            self.put(s, "same", b)
        for n in range(bands.MAX_ITEMS - 1):
            self.put(s, f"m{n}", a, edge="footer")
        self.put(s, "last", a, edge="footer")
        with self.assertRaises(OpError):
            self.put(s, "one-too-many", a, edge="footer")

    def test_a_section_that_goes_takes_its_shapes_and_the_next_one_follows_the_previous(self):
        s = self.doc()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "ha", a)
        self.put(s, "hb", b)
        sections_before = [x["id"] for x in s.doc["sections"]]
        self.assertEqual(sections_before, [a, b])
        doc = copy.deepcopy(s.doc)
        doc["sections"] = [x for x in doc["sections"] if x["id"] != b]
        with self.assertRaises(OpError):
            bands.validate_document(doc)                                      # shapes of a section that does not exist are refused on their own

    def test_where_a_page_puts_a_shape(self):
        it = item("a")
        it["shape"] = shape(w=40, h=8)
        page = dict(page_w=210.0, page_h=297.0, left=25.0, right=20.0)
        self.assertEqual(bands.place({**it, "x_mm": 10, "y_mm": 6}, "header", **page), {"x": 35.0, "y": 6.0, "w": 40.0, "h": 8.0})
        self.assertEqual(bands.place({**it, "x_mm": 10, "y_mm": 6}, "footer", **page), {"x": 35.0, "y": 283.0, "w": 40.0, "h": 8.0}, "a footer shape is measured from the bottom")
        self.assertEqual(bands.place({**it, "span": True}, "header", **page), {"x": 25.0, "y": 6.0, "w": 165.0, "h": 8.0}, "spanning the frame follows the margins")
        self.assertEqual(bands.place({**it, "x_mm": 10}, "header", mirrored=True, **page)["x"], 25 + 165 - 10 - 40, "measured from the other edge on a swapped page")
        other = dict(page_w=148.0, page_h=210.0, left=15.0, right=15.0)
        self.assertEqual(bands.place({**it, "x_mm": 10, "y_mm": 6}, "footer", **other)["y"], 196.0, "a smaller page keeps the footer shape on its bottom")


GOLDEN = __import__("pathlib").Path(__file__).parent / "fixtures" / "band_shapes_golden.json"


def golden_cases() -> dict:
    """Documents of every kind of band (linked sections, first page, odd and even, mirrored books) and, for each page, what it shows and where: the editor's TypeScript
    port (src/client/bands.ts) is tested against this file."""
    sections = [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}]

    def lists(prefix):
        return {"default": [{**item(prefix + "d"), "shape": shape(w=30, h=5)}], "even": [{**item(prefix + "e"), "shape": shape(w=20, h=6)}], "first": [{**item(prefix + "f"), "shape": shape(w=50, h=4)}]}

    docs = []
    for label, store, books in (
        ("plain", {"s1": {"header": {"default": [item("a")]}}}, {}),
        ("linked", {"s1": {"header": lists("h1"), "footer": lists("f1")}, "s2": {"link": {"header": True}}, "s3": {"link": {"header": True, "footer": False}, "footer": {"default": [item("own")]}}}, {}),
        ("first", {"s1": {"first_page": True, "header": lists("h1")}, "s2": {"first_page": True}}, {}),
        ("oddeven", {"s1": {"header": {"default": [item("a")]}, "footer": lists("f")}}, {"s1": {"odd_even": True}}),
        ("book", {"s1": {"header": {"default": [item("a", span=False), item("b", span=True)]}}}, {"s1": {"mirror": True, "gutter_mm": 8}}),
        ("book-fixed-edges", {"s1": {"header": {"default": [item("a")]}}}, {"s1": {"mirror": True, "mirror_edges": False, "odd_even": True}}),
    ):
        docs.append({"label": label, "doc": {"sections": sections, "extensions": {EXT: {"band_shapes": store, "book_layouts": books}}}})
    cases = []
    for entry in docs:
        for section in ("s1", "s2", "s3"):
            for edge in ("header", "footer"):
                for physical in range(1, 5):
                    for first in (False, True):
                        items, variant, mirrored = bands.shapes_for_page(entry["doc"], section, edge, physical, first)
                        cases.append({"doc": entry["label"], "section": section, "edge": edge, "physical": physical, "first": first, "ids": [i["id"] for i in items],
                                      "variant": variant, "mirrored": mirrored, "owner": bands.owner(entry["doc"], section, edge)})
    places = []
    for edge in ("header", "footer"):
        for span in (False, True):
            for mirrored in (False, True):
                for page_w, page_h, left, right in ((210, 297, 25, 25), (215.9, 279.4, 30, 18), (148, 210, 12.5, 20), (297, 210, 40, 10)):
                    it = {**item("x", span=span), "x_mm": 13.5, "y_mm": 7.25, "shape": shape(w=37, h=11)}
                    box = bands.place(it, edge, page_w, page_h, left, right, mirrored)
                    places.append({"item": it, "edge": edge, "page": [page_w, page_h, left, right], "mirrored": mirrored, "box": box})
    return {"docs": docs, "cases": cases, "places": places}


class Golden(unittest.TestCase):
    def test_the_golden_file_is_what_the_engine_says_and_what_the_browser_is_tested_against(self):
        import json
        import os
        data = json.loads(json.dumps(golden_cases(), sort_keys=True))
        if os.environ.get("UPDATE_GOLDEN"):
            GOLDEN.write_text(json.dumps(data, indent=0, sort_keys=True), encoding="utf-8")
        self.assertTrue(GOLDEN.exists(), "run with UPDATE_GOLDEN=1 to create the golden file")
        self.assertEqual(json.loads(GOLDEN.read_text(encoding="utf-8")), data)


if __name__ == "__main__":
    unittest.main()
