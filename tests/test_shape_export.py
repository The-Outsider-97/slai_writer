"""Real shape raster-fallback, external-format export, and non-mutating adaptation tests."""
from __future__ import annotations

import copy
import io
import types
import unittest
from pathlib import Path

from PIL import Image

from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from applications.slai_writer.shape_export import prepare_shapes, render_shape_png
from applications.slai_writer.shape_validation import SHAPE_KEY
from applications.slai_writer.session import sldc
from applications.slai_writer.tests.helpers import Workbench
from applications.slai_writer.tests.test_shapes import sample


class ShapeImageTests(unittest.TestCase):
    def test_all_ten_shapes_are_real_pngs(self):
        kinds = ("rectangle", "ellipse", "line", "triangle", "diamond",
                 "pentagon", "hexagon", "star", "arrow", "plus")
        for kind in kinds:
            with self.subTest(kind=kind):
                data, width = render_shape_png(sample(kind))
                self.assertTrue(data.startswith(b"\x89PNG"))
                with Image.open(io.BytesIO(data)) as image:
                    self.assertEqual(image.mode, "RGBA")
                    self.assertGreater(image.getbbox()[2], 0)
                self.assertGreater(width, 50)

    def test_shadow_rotated_and_translucent(self):
        shape = sample("ellipse")
        shape.update(rotation_deg=30, opacity=0.4)
        shape["shadows"] = [
            {"enabled": True, "color": "#111111", "opacity": .7,
             "offset_x_mm": 8, "offset_y_mm": 8, "blur_mm": 2, "spread_mm": 1},
            {"enabled": True, "color": "#888888", "opacity": .45,
             "offset_x_mm": 13, "offset_y_mm": 13, "blur_mm": 0, "spread_mm": 0},
        ]
        data, full_width = render_shape_png(shape)
        self.assertGreater(full_width, shape["width_mm"])
        with Image.open(io.BytesIO(data)) as image:
            self.assertLess(image.getextrema()[3][1], 255)
            self.assertGreater(image.width, 20)

    def test_ignores_unsupported_markup_and_larger_shapes_are_bounded(self):
        shape = sample("star")
        shape["width_mm"] = 1000
        shape["height_mm"] = 1000
        data, width = render_shape_png(shape)
        with Image.open(io.BytesIO(data)) as image:
            self.assertLessEqual(image.width, 5000)
            self.assertLessEqual(image.height, 5000)
        self.assertGreater(width, 0)
        self.assertLess(len(data), 15_000_000)


class ShapeConversion(Workbench):
    def make(self, kind="star"):
        session = self.new_session(text="First paragraph.")
        first = session.doc["blocks"][-1]["id"]
        session.apply({"op": "block_insert", "after": first, "block": {
            "type": "paragraph", "text": "", "extensions": {SHAPE_KEY: sample(kind)}}}, None)
        return session

    def test_conversion_does_not_mutate_native_shapes(self):
        session = self.make()
        orig = copy.deepcopy(session.pkg.document)
        pkg, warnings = prepare_shapes(session.pkg, "pdf", sldc())
        self.assertTrue(warnings)
        self.assertEqual(pkg.document["blocks"][-1]["type"], "figure")
        self.assertEqual(pkg.document["blocks"][-1]["figure"]["alt"], "star shape. hello shadow")
        sldc().validate_package(pkg)
        self.assertEqual(session.pkg.document, orig)
        self.assertEqual(session.pkg.document["blocks"][-1]["extensions"][SHAPE_KEY]["kind"], "star")

    def test_documaster_pdf_and_docx_contain_shape_image(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as root:
            dm = DocumasterLink(Path(__file__).resolve().parents[3], Path(root)).load()
            self.addCleanup(dm.close)
            if not dm.available:
                self.skipTest("Documaster unavailable: " + str(dm.reason))
            self.app.docmaster = dm
            self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20},
                max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
            exchange = Exchange(self.app)
            session = self.make()
            for kind in ("pdf", "docx"):
                with self.subTest(kind=kind):
                    report = exchange.export(session, kind, self.root / "out", stem="shape-" + kind)
                    self.assertTrue(Path(report["path"]).is_file())
                    raster = any("editable vector shape" in w for w in report["warnings"])
                    if not raster:
                        # Once the companion Documaster PR is installed,
                        # verify the actual native representation instead of
                        # continuing to require a raster-fallback warning.
                        if kind == "pdf":
                            from pypdf import PdfReader
                            reader = PdfReader(report["path"])
                            self.assertIn("hello", "\\n".join(p.extract_text() or "" for p in reader.pages))
                        else:
                            import zipfile
                            with zipfile.ZipFile(report["path"]) as archive:
                                xml = archive.read("word/document.xml").decode("utf-8")
                            self.assertIn("wsp", xml)
                            self.assertIn("hello shadow", xml)
                    self.assertTrue(report["verification"]["ok"])
            self.assertTrue(exchange.print_pdf(session).startswith(b"%PDF"))
