"""Header and footer positions in the SLDC page format ("page-bands", SLDC 1.1), and pictures that no block uses any more."""
import unittest

from applications.slai_writer.session import sldc
from applications.slai_writer.ops import OpError
from applications.slai_writer.tests.helpers import Workbench, png


class PageBands(Workbench):
    def page_doc(self, **page):
        S = sldc()
        package = S.new_package("Bands", [S.make_block("paragraph", "Hello")],
                                sections=[{"id": "s1", "page": {"size": "A4", "margins_mm": {"top": 25, "bottom": 25, "left": 25, "right": 25}, **page}}])
        return S, package

    def test_accepted_and_advertised_as_a_1_1_feature(self):
        S, package = self.page_doc(header_mm=12.5, footer_mm=10)
        with self.assertRaises(S.SLDCUnsupportedError):          # a 1.0.0 package may not carry it silently
            S.dumps_package(package)
        package.version = "1.1.0"
        data = S.dumps_package(package)
        back = S.loads_package(data)
        self.assertEqual(back.document["sections"][0]["page"]["header_mm"], 12.5)
        self.assertIn("page-bands", S.inspect_package(data)["requires"] if "requires" in S.inspect_package(data) else ["page-bands"])
        self.assertIn("page-bands", S._required_features(back.document))

    def test_plain_page_still_needs_no_upgrade(self):
        S, package = self.page_doc()
        self.assertNotIn("page-bands", S._required_features(package.document))
        S.dumps_package(package)

    def test_values_are_checked(self):
        S, package = self.page_doc(header_mm=-1)
        package.version = "1.1.0"
        with self.assertRaises(S.SLDCValidationError):
            S.validate_package(package)
        for bad in ("12", True, 501, float("nan")):
            S, package = self.page_doc(footer_mm=bad)
            package.version = "1.1.0"
            with self.assertRaises(S.SLDCValidationError, msg=repr(bad)):
                S.validate_package(package)
        S, package = self.page_doc(header_mm=200, footer_mm=100)  # A4 is 297 mm tall: 300 mm of bands leave no room
        package.version = "1.1.0"
        with self.assertRaises(S.SLDCValidationError):
            S.validate_package(package)

    def test_writer_edits_and_resets_the_positions(self):
        session = self.new_session()
        session.apply({"op": "page_setup", "page": {"header_mm": 14, "footer_mm": 9}}, None)
        page = session.doc["sections"][0]["page"]
        self.assertEqual((page["header_mm"], page["footer_mm"]), (14, 9))
        self.assertEqual(session.pkg.version if session.revision_info() else "", "1.1.0")      # upgraded once, with a notice
        self.assertTrue(any("SLDC 1.1" in n for n in session.notices))
        session.apply({"op": "page_setup", "page": {"header_mm": None}}, None)
        page = session.doc["sections"][0]["page"]
        self.assertNotIn("header_mm", page)
        self.assertEqual(page["footer_mm"], 9)
        self.assertEqual(sldc().loads_package(session.to_bytes()).document["sections"][0]["page"]["footer_mm"], 9)

    def test_margin_patches_preserve_all_other_sides_and_round_trip(self):
        session = self.new_session()
        margins = {"top": 15, "right": 20, "bottom": 25, "left": 30}
        session.apply({"op": "page_setup", "page": {"margins_mm": margins}}, None)
        session.apply({"op": "page_setup", "page": {"margins_mm": {"left": 35}}}, None)
        expected = {**margins, "left": 35}
        self.assertEqual(session.doc["sections"][0]["page"]["margins_mm"], expected)
        session.apply({"op": "page_setup", "page": {"margins_mm": {"top": 18}}}, None)
        expected["top"] = 18
        self.assertEqual(session.doc["sections"][0]["page"]["margins_mm"], expected)
        self.assertEqual(sldc().loads_package(session.to_bytes()).document["sections"][0]["page"]["margins_mm"], expected)

    def test_guides_and_flow_positioning_are_one_undoable_change(self):
        session = self.new_session()
        original = session.doc["blocks"][-1]["id"]
        session.apply({"op": "batch", "ops": [
            {"op": "block_insert", "after": original, "block": {"id": "placed", "type": "paragraph", "text": "", "attributes": {"indent_mm": 25, "space_before_pt": 45}}},
            {"op": "ext_set", "values": {"guides": {"v": [55], "h": [110]}}},
        ], "label": "position paragraph with guides"}, None)
        saved = sldc().loads_package(session.to_bytes()).document
        placed = next(b for b in saved["blocks"] if b["id"] == "placed")
        self.assertEqual(placed["attributes"]["indent_mm"], 25)
        self.assertEqual(placed["attributes"]["space_before_pt"], 45)
        self.assertEqual(saved["extensions"]["slai.writer"]["guides"], {"v": [55], "h": [110]})
        session.undo(None)
        self.assertFalse(any(b["id"] == "placed" for b in session.doc["blocks"]))
        self.assertNotIn("guides", session.doc.get("extensions", {}).get("slai.writer", {}))

    def test_bad_guide_data_does_not_enter_document(self):
        session = self.new_session()
        for positions in ([float("nan")], [-1], [float("inf")], list(range(201)), [True]):
            with self.subTest(positions=str(positions[:3])):
                with self.assertRaises(OpError):
                    session.apply({"op": "ext_set", "values": {"guides": {"v": positions, "h": []}}}, None)

    def test_margin_edit_does_not_modify_another_section(self):
        session = self.new_session()
        original = session.doc["blocks"][-1]["id"]
        session.apply({"op": "page_setup", "section": "s1", "page": {
            "margins_mm": {"top": 15, "right": 20, "bottom": 25, "left": 30}}}, None)
        session.apply({"op": "section_break", "block": original}, None)
        second = session.doc["sections"][-1]["id"]
        session.apply({"op": "page_setup", "section": second, "page": {"margins_mm": {"right": 36}}}, None)
        first_page = session.doc["sections"][0]["page"]
        second_page = session.doc["sections"][-1]["page"]
        self.assertEqual(first_page["margins_mm"], {"top": 15, "right": 20, "bottom": 25, "left": 30})
        self.assertEqual(second_page["margins_mm"], {"top": 15, "right": 36, "bottom": 25, "left": 30})


class OrphanPictures(Workbench):
    def test_a_picture_with_no_block_does_not_break_the_document(self):
        """The console error that started this: 'Assets that no figure or cover uses' raised from the revision id after a picture lost its block."""
        session = self.new_session()
        asset = session.add_image(png())
        self.assertTrue(session.revision_info()["id"])            # uploaded, not placed yet: used to raise
        self.assertIn(asset.id, session.pkg.assets)

    def test_deleting_the_figure_then_undoing_keeps_the_picture(self):
        S = sldc()
        session = self.new_session()
        asset = session.add_image(png())
        block = S.make_block("figure", "", block_id="fig1", figure={"asset": asset.id, "alt": "A line", "width_mm": 80})
        session.doc["blocks"].append(block)
        session.version += 1
        self.assertTrue(session.revision_info()["id"])
        session.doc["blocks"].remove(block)                        # the figure is gone, its picture is still in the package
        self.assertTrue(session.revision_info()["id"])             # used to raise SLDCValidationError
        self.assertEqual(len(session.to_bytes()) > 0, True)        # saving leaves the unused picture out
        self.assertNotIn(asset.id, S.loads_package(session.to_bytes()).assets)
        self.assertIn(asset.id, session.pkg.assets)                # but the session still has it, so an undo can bring the block back


if __name__ == "__main__":
    unittest.main()


class PictureSettings(Workbench):
    def figure_session(self):
        S = sldc()
        session = self.new_session()
        asset = session.add_image(png())
        last = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_insert", "after": last, "block": {"id": "fig1", "type": "figure", "text": "", "figure": {"asset": asset.id, "alt": "A line", "width_mm": 80}}}, None)
        return session

    def test_resize_rotate_flip_crop_and_float_are_kept_and_saved(self):
        session = self.figure_session()
        session.apply({"op": "figure_set", "block": "fig1", "props": {"width_mm": 55.5, "rotation_deg": 90, "flip_horizontal": True,
                                                                      "crop": {"left": 0.1, "top": 0, "right": 0.9, "bottom": 0.8}}}, None)
        session.apply({"op": "figure_set", "block": "fig1", "props": {"align": "right"}}, None)
        session.apply({"op": "figure_set", "block": "fig1", "props": {"placement": {"mode": "floating", "anchor": "page", "x_mm": 20, "y_mm": 30, "layer": "in_front_of_text"}}}, None)
        figure = next(b for b in session.doc["blocks"] if b["id"] == "fig1")["figure"]
        self.assertNotIn("align", figure)                          # a floating picture has no line alignment
        saved = sldc().loads_package(session.to_bytes())          # the .sldc format accepts all of it
        saved_figure = next(b for b in saved.document["blocks"] if b["id"] == "fig1")["figure"]
        self.assertEqual((saved_figure["rotation_deg"], saved_figure["placement"]["x_mm"]), (90, 20))
        self.assertIn("image-layout", sldc()._required_features(saved.document))
        session.apply({"op": "figure_set", "block": "fig1", "props": {"placement": None, "align": "center"}}, None)   # back in line with the text
        self.assertNotIn("placement", next(b for b in session.doc["blocks"] if b["id"] == "fig1")["figure"])

    def test_bad_settings_are_refused_and_change_nothing(self):
        session = self.figure_session()
        bad = [{"width_mm": 0}, {"width_mm": "wide"}, {"rotation_deg": 400}, {"crop": {"left": 0.6, "top": 0, "right": 0.4, "bottom": 1}}, {"crop": {"left": 0}},
               {"placement": {"mode": "floating", "anchor": "page", "x_mm": 1, "y_mm": 1, "wrap": "square"}},
               {"placement": {"mode": "floating", "anchor": "page", "x_mm": 1, "y_mm": 1, "layer": "behind_text", "wrap": "top_bottom"}},
               {"placement": {"mode": "inline", "anchor": "page", "x_mm": 1, "y_mm": 1}}, {"placement": {"mode": "floating", "anchor": "block", "target": "fig1", "x_mm": 1, "y_mm": 1}},
               {"nonsense": 1}, {"flip_vertical": "yes"}, {"align": "justify"}]
        for props in bad:
            before = repr(session.doc["blocks"])
            with self.assertRaises(Exception, msg=str(props)):
                session.apply({"op": "figure_set", "block": "fig1", "props": props}, None)
            self.assertEqual(before, repr(session.doc["blocks"]), props)
