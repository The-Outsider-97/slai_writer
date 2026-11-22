"""Header and footer shapes in the files Writer exports, read back by independent software: PDF (pdfplumber, poppler's pixels), Word (python-docx and LibreOffice)."""
from __future__ import annotations

import tempfile
import types
import unittest
from pathlib import Path

try:
    import pdfplumber
except ImportError:                                             # pragma: no cover
    pdfplumber = None

from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from . import independent
from .helpers import Workbench
from .pdf_tables import rasterise
from .test_band_shapes import item, shape

ROOT = Path(__file__).resolve().parents[3]
MM = 72 / 25.4


def solid(colour, w=40, h=8, **extra):
    return shape("rectangle", w, h, fill={"enabled": True, "color": colour, "opacity": 1}, outline={"enabled": False, "color": "#000000", "opacity": 1, "width_pt": 1, "style": "solid"}, **extra)


class Base(Workbench):
    @classmethod
    def setUpClass(cls):
        cls._dm_dir = tempfile.TemporaryDirectory()
        cls.dm = DocumasterLink(ROOT, Path(cls._dm_dir.name)).load()

    @classmethod
    def tearDownClass(cls):
        cls.dm.close()
        cls._dm_dir.cleanup()

    def setUp(self):
        super().setUp()
        independent.need(self, "Documaster", self.dm.available, str(self.dm.reason))
        independent.need(self, "pdfplumber", pdfplumber is not None, "pip install pdfplumber")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)

    def document(self, pages=6, split=3):
        s = self.new_session("blank", title="Bands")
        last = s.doc["blocks"][-1]["id"]
        for n in range(pages):
            s.apply({"op": "block_insert", "after": last, "block": {"id": f"p{n}", "type": "paragraph", "text": f"Page text {n}.", "attributes": {"page_break_before": n > 0}}}, None)
            last = f"p{n}"
        if split:
            s.apply({"op": "section_break", "block": f"p{split}"}, None)
        return s

    def put(self, s, ident, colour, section=None, edge="header", variant="default", **extra):
        item_ = {**item(ident), "shape": solid(colour), **extra}
        s.apply({"op": "band_shape_set", "section": section, "edge": edge, "variant": variant, "item": item_}, None)

    def export(self, s, fmt="pdf", stem="out"):
        report = self.ex.export(s, fmt, self.root / "out", stem=stem)
        return Path(report["path"]), report

    def rects(self, path, colour):
        """Per page: the filled rectangles of that colour, in points from the top-left corner."""
        found = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                mine = []
                for r in [*page.rects, *page.curves]:
                    c = r.get("non_stroking_color")
                    if c and len(c) >= 3 and "#%02X%02X%02X" % tuple(round(v * 255) for v in c[:3]) == colour.upper():
                        mine.append({"x0": r["x0"], "x1": r["x1"], "top": r["top"], "bottom": r["bottom"]})
                found.append(mine)
        return found

    def margins(self, s, section=0):
        m = (s.doc["sections"][section].get("page") or {}).get("margins_mm") or {}
        return float(m.get("left", 25)), float(m.get("right", 25))


class Pdf(Base):
    def test_a_header_shape_repeats_on_the_pages_that_use_it_and_only_on_those(self):
        s = self.document()
        a = s.doc["sections"][0]["id"]
        self.put(s, "h", "#336699", a, x_mm=10, y_mm=6)
        path, report = self.export(s)
        self.assertTrue(report["verification"]["ok"], report["verification"])
        pages = self.rects(path, "#336699")
        self.assertEqual(len(pages), 6)
        left, _ = self.margins(s)
        for n in range(3):
            self.assertEqual(len(pages[n]), 1, f"page {n + 1} of the section that has it")
            r = pages[n][0]
            self.assertAlmostEqual(r["x0"], (left + 10) * MM, delta=0.6)
            self.assertAlmostEqual(r["x1"] - r["x0"], 40 * MM, delta=0.6)
            self.assertAlmostEqual(r["top"], 6 * MM, delta=0.6)
            self.assertAlmostEqual(r["bottom"] - r["top"], 8 * MM, delta=0.6)
        for n in range(3, 6):
            self.assertEqual(pages[n], [], f"page {n + 1} belongs to a section without it")

    def test_a_footer_shape_is_measured_from_the_bottom_and_follows_the_page_size_and_margins(self):
        s = self.document()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "f", "#CC3300", a, edge="footer", x_mm=5, y_mm=7)
        s.apply({"op": "band_config", "section": b, "link": {"footer": True}}, None)
        s.apply({"op": "page_layout", "scope": "sections", "sections": [b], "margins_mm": {"left": 15, "right": 15}}, None)
        path, _ = self.export(s)
        pages = self.rects(path, "#CC3300")
        with pdfplumber.open(path) as pdf:
            heights = [float(p.height) for p in pdf.pages]
        for n in range(3):
            r = pages[n][0]
            self.assertAlmostEqual(heights[n] - r["bottom"], 7 * MM, delta=0.6, msg=f"page {n + 1} bottom")
            self.assertAlmostEqual(r["x0"], (25 + 5) * MM, delta=0.6)
        for n in range(3, 6):
            self.assertEqual(len(pages[n]), 1, f"the linked section shows it too (page {n + 1})")
            self.assertAlmostEqual(pages[n][0]["x0"], (15 + 5) * MM, delta=0.6, msg="and measures it from its own, narrower margin")

    def test_a_smaller_page_keeps_the_shapes_on_their_edges(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        self.put(s, "h", "#336699", a, x_mm=10, y_mm=6)
        self.put(s, "f", "#CC3300", a, edge="footer", x_mm=10, y_mm=6)
        s.apply({"op": "page_setup", "section": a, "page": {"size": "A5"}}, None)
        path, _ = self.export(s)
        with pdfplumber.open(path) as pdf:
            height = float(pdf.pages[0].height)
            self.assertLess(height, 600)
        top, bottom = self.rects(path, "#336699")[0][0], self.rects(path, "#CC3300")[0][0]
        self.assertAlmostEqual(top["top"], 6 * MM, delta=0.6)
        self.assertAlmostEqual(height - bottom["bottom"], 6 * MM, delta=0.6)

    def test_odd_and_even_and_first_page_variants(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True}, None)
        s.apply({"op": "band_config", "section": a, "first_page": True}, None)
        self.put(s, "d", "#0000FF", a)
        self.put(s, "e", "#00AA00", a, variant="even")
        self.put(s, "f", "#FF00FF", a, variant="first")
        path, _ = self.export(s)
        blue, green, pink = (self.rects(path, c) for c in ("#0000FF", "#00AA00", "#FF00FF"))
        for n in range(6):
            expected = "pink" if n == 0 else "green" if n % 2 == 1 else "blue"
            got = [name for name, found in (("blue", blue), ("green", green), ("pink", pink)) if found[n]]
            self.assertEqual(got, [expected], f"page {n + 1}")

    def test_a_book_swaps_the_shape_to_the_outer_edge_on_left_hand_pages(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        s.apply({"op": "page_layout", "scope": "document", "mirror": True}, None)
        self.put(s, "h", "#336699", a, x_mm=0, y_mm=6)
        path, _ = self.export(s)
        pages = self.rects(path, "#336699")
        with pdfplumber.open(path) as pdf:
            width = float(pdf.pages[0].width)
        right_hand, left_hand = pages[0][0], pages[1][0]
        self.assertLess(right_hand["x0"], width / 2)
        self.assertGreater(left_hand["x0"], width / 2, "on a left-hand page the same shape stands at the other edge of the text")
        self.assertAlmostEqual(left_hand["x1"], width - self.margins(s)[1] * MM, delta=0.6, msg="flush with the outer edge of the text, as the shape was flush with the inner one")
        self.assertAlmostEqual(right_hand["x0"], self.margins(s)[0] * MM, delta=0.6)

    def test_a_shape_that_spans_the_frame_follows_the_margins(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        self.put(s, "h", "#336699", a, span=True)
        s.apply({"op": "page_layout", "scope": "document", "margins_mm": {"left": 40, "right": 30}}, None)
        path, _ = self.export(s)
        r = self.rects(path, "#336699")[0][0]
        with pdfplumber.open(path) as pdf:
            width = float(pdf.pages[0].width)
        self.assertAlmostEqual(r["x0"], 40 * MM, delta=0.6)
        self.assertAlmostEqual(r["x1"], width - 30 * MM, delta=0.6)

    def test_behind_the_text_and_in_front_of_it(self):
        s = self.document(pages=2, split=0)
        a = s.doc["sections"][0]["id"]
        # one big shape across the first line of the text of the page
        self.put(s, "behind", "#2255DD", a, layer="behind", x_mm=0, y_mm=20, span=True)
        s.apply({"op": "band_shape_set", "section": a, "edge": "header", "item": {"id": "behind", "shape": solid("#2255DD", 160, 270)}}, None)
        self.put(s, "front", "#DD5522", a, edge="footer", layer="front", x_mm=0, y_mm=0)
        s.apply({"op": "band_shape_set", "section": a, "edge": "footer", "item": {"id": "front", "shape": solid("#DD5522", 160, 270), "y_mm": 0}}, None)
        path, _ = self.export(s)
        # the text of page 1 lies over the "behind" rectangle and under the "front" one: look at the pixels where the first word is
        with pdfplumber.open(path) as pdf:
            word = next(w for w in pdf.pages[0].extract_words() if w["text"] == "Page")
        # both rectangles cover the whole text area, so the page shows the front one with nothing of the text; remove it and the text must show over the behind one
        image = rasterise(path.read_bytes(), 1, 100)
        px = image.getpixel((int((word["x0"] + word["x1"]) / 2 * 100 / 72), int((word["top"] + word["bottom"]) / 2 * 100 / 72)))
        self.assertTrue(abs(px[0] - 0xDD) < 40 and abs(px[2] - 0x22) < 40, f"the shape in front covers the text: {px}")
        s.apply({"op": "band_shape_delete", "section": a, "edge": "footer", "ids": ["front"]}, None)
        path, _ = self.export(s, stem="behind")
        image = rasterise(path.read_bytes(), 1, 100)
        dark = [image.getpixel((x, int((word["top"] + word["bottom"]) / 2 * 100 / 72))) for x in range(int(word["x0"] * 100 / 72), int(word["x1"] * 100 / 72))]
        self.assertTrue(any(sum(p) < 200 for p in dark), "the text is drawn over the shape behind it")
        self.assertTrue(any(abs(p[2] - 0xDD) < 40 and p[0] < 0x66 for p in dark) or image.getpixel((20, 20))[2] > 0, "and the shape is there")


class Word(Base):
    """The Word file: the shapes are in the header and footer parts (one per definition), anchored to the page; LibreOffice prints them where Writer put them."""

    def part_shapes(self, path):
        import docx
        from docx.oxml.ns import qn
        found = {}
        document = docx.Document(str(path))
        for n, section in enumerate(document.sections):
            for name in ("header", "footer", "even_page_header", "even_page_footer", "first_page_header", "first_page_footer"):
                part = getattr(section, name)
                if part.is_linked_to_previous:
                    continue
                shapes = []
                for anchor in part._element.iter("{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}anchor"):
                    ns = {"wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
                    off = lambda tag: int(anchor.find(f"wp:position{tag}/wp:posOffset", ns).text) / 36000
                    ext = anchor.find("wp:extent", ns)
                    fill = anchor.find(".//a:solidFill/a:srgbClr", ns)
                    shapes.append({"x": off("H"), "y": off("V"), "w": int(ext.get("cx")) / 36000, "h": int(ext.get("cy")) / 36000, "behind": anchor.get("behindDoc") == "1",
                                   "fill": fill.get("val") if fill is not None else None, "from": anchor.find("wp:positionH", ns).get("relativeFrom")})
                found[(n, name)] = shapes
        return found

    def test_the_header_and_footer_parts_hold_the_shapes_with_their_places(self):
        s = self.document()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "h", "#336699", a, x_mm=10, y_mm=6)
        self.put(s, "f", "#CC3300", a, edge="footer", x_mm=5, y_mm=7, layer="behind")
        path, report = self.export(s, "docx")
        found = self.part_shapes(path)
        head = found[(0, "header")]
        self.assertEqual(len(head), 1)
        self.assertEqual((round(head[0]["x"], 2), round(head[0]["y"], 2), round(head[0]["w"], 2), round(head[0]["h"], 2)), (35.0, 6.0, 40.0, 8.0))
        self.assertEqual((head[0]["from"], head[0]["fill"], head[0]["behind"]), ("page", "336699", False))
        foot = found[(0, "footer")][0]
        self.assertEqual((round(foot["x"], 2), round(foot["y"], 2), foot["behind"]), (30.0, round(297 - 7 - 8, 2), True))
        self.assertEqual(found.get((1, "header"), []), [], "the section without them has none")

    def test_libreoffice_prints_the_word_file_with_the_shapes_where_writer_put_them(self):
        independent.need(self, "LibreOffice", bool(independent.soffice()), "soffice not found")
        s = self.document()
        a, b = (x["id"] for x in s.doc["sections"])
        self.put(s, "h", "#336699", a, x_mm=10, y_mm=6)
        self.put(s, "f", "#CC3300", a, edge="footer", x_mm=5, y_mm=7)
        path, _ = self.export(s, "docx")
        pdf = self.root / "lo.pdf"
        pdf.write_bytes(independent.to_pdf(path, self.root / "lo"))
        head, foot = self.rects(pdf, "#336699"), self.rects(pdf, "#CC3300")
        with pdfplumber.open(pdf) as doc:
            heights = [float(p.height) for p in doc.pages]
        for n in range(3):
            self.assertEqual(len(head[n]), 1, f"page {n + 1}")
            self.assertAlmostEqual(head[n][0]["x0"], 35 * MM, delta=1.5)
            self.assertAlmostEqual(head[n][0]["top"], 6 * MM, delta=1.5)
            self.assertAlmostEqual(heights[n] - foot[n][0]["bottom"], 7 * MM, delta=1.5)
        for n in range(3, 6):
            self.assertEqual((head[n], foot[n]), ([], []), f"page {n + 1} is in the other section")

    def test_odd_even_and_first_page_parts(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True}, None)
        s.apply({"op": "band_config", "section": a, "first_page": True}, None)
        self.put(s, "d", "#0000FF", a)
        self.put(s, "e", "#00AA00", a, variant="even")
        self.put(s, "f", "#FF00FF", a, variant="first")
        found = self.part_shapes(self.export(s, "docx")[0])
        self.assertEqual([x["fill"] for x in found[(0, "header")]], ["0000FF"])
        self.assertEqual([x["fill"] for x in found[(0, "even_page_header")]], ["00AA00"])
        self.assertEqual([x["fill"] for x in found[(0, "first_page_header")]], ["FF00FF"])


class Notes(Base):
    def test_the_formats_that_cannot_carry_them_say_so_and_the_text_of_the_bands_stays(self):
        s = self.document(split=0)
        a = s.doc["sections"][0]["id"]
        s.apply({"op": "page_setup", "header": {"left": "RUNNING HEAD"}}, None)
        self.put(s, "h", "#336699", a)
        for fmt in ("odt", "rtf", "html"):
            _, report = self.export(s, fmt)
            self.assertTrue(any("headers and footers are not carried" in w for w in report["warnings"]), (fmt, report["warnings"]))
        for fmt in ("pdf", "docx"):
            _, report = self.export(s, fmt)
            self.assertFalse(any("headers and footers are not carried" in w for w in report["warnings"]), fmt)

    def test_the_editor_and_documaster_read_the_same_arithmetic(self):
        from applications.Documaster.slai.docmodel.writers import band_shapes as dm
        from applications.slai_writer import bands as wr
        s = self.document()
        a, b = (x["id"] for x in s.doc["sections"])
        s.apply({"op": "page_layout", "scope": "document", "odd_even": True, "mirror": True}, None)
        s.apply({"op": "band_config", "section": a, "first_page": True}, None)
        s.apply({"op": "band_config", "section": b, "link": {"header": True}}, None)
        for variant in ("default", "even", "first"):
            self.put(s, f"h{variant}", "#336699", a, variant=variant, x_mm=3 if variant == "default" else 9)
        self.put(s, "ff", "#CC3300", a, edge="footer", span=True)
        for sid in (a, b):
            for edge in ("header", "footer"):
                for physical in range(1, 7):
                    for first in (False, True):
                        self.assertEqual(dm.shapes_for_page(s.doc, sid, edge, physical, first), wr.shapes_for_page(s.doc, sid, edge, physical, first), (sid, edge, physical, first))
        item = wr.items_of(s.doc, a, "header", "default")[0]
        for mirrored in (False, True):
            for edge in ("header", "footer"):
                self.assertEqual(dm.place(item, edge, 210, 297, 25, 20, mirrored), wr.place(item, edge, 210, 297, 25, 20, mirrored))


if __name__ == "__main__":
    unittest.main()
