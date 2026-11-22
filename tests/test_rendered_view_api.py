"""The rendered view's two routes: what the pages of the exported PDF are, and a picture of one. Over a real server, against the real PDF writer."""
from __future__ import annotations

import io
import struct

from . import independent
from .api_helpers import ApiCase


def fill(web, state, paragraphs=30):
    last = state["blocks"][-1]["id"]
    for i in range(paragraphs):
        out = web.ok("POST", f"/api/docs/{state['sid']}/ops", {"op": {"op": "block_insert", "after": last, "block": {"id": f"p{i}", "type": "paragraph", "text": "word " * 120}}, "base": None})
        last = f"p{i}"
    return out


class RenderedPages(ApiCase):
    def setUp(self):
        super().setUp()
        independent.need(self, "Documaster", self.app.docmaster.available, str(self.app.docmaster.reason))

    def test_the_pages_and_one_picture_of_a_page(self):
        state = self.new_doc("Book")
        fill(self.web, state)
        info = self.web.ok("GET", f"/api/docs/{state['sid']}/pages")
        self.assertGreaterEqual(info["total"], 2)
        self.assertEqual(len(info["pages"]), info["total"])
        first = info["pages"][0]
        self.assertAlmostEqual(first["widthPt"], 595.3, delta=1.0)             # A4, as the document says, not a guess of the editor
        self.assertAlmostEqual(first["heightPt"], 841.9, delta=1.0)
        response, data = self.web.request("GET", f"/api/docs/{state['sid']}/pages/1.png?w=600&v={info['version']}")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "image/png")
        self.assertIn("max-age", response.getheader("Cache-Control"))
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = struct.unpack(">II", data[16:24])
        self.assertAlmostEqual(width, 600, delta=2)
        self.assertAlmostEqual(height / width, 841.9 / 595.3, delta=0.01)

    def test_a_changed_document_is_a_new_address(self):
        state = self.new_doc("Book")
        info = self.web.ok("GET", f"/api/docs/{state['sid']}/pages")
        self.web.ok("POST", f"/api/docs/{state['sid']}/ops", {"op": {"op": "text", "block": state["blocks"][-1]["id"], "start": 0, "end": 0, "insert": "x"}, "base": None})
        status, body = self.web.api("GET", f"/api/docs/{state['sid']}/pages/1.png?w=600&v={info['version']}")
        self.assertEqual(status, 409)
        self.assertFalse(body["ok"])

    def test_bad_requests_are_refused_clearly(self):
        state = self.new_doc("Book")
        for path in ("/pages/0.png", "/pages/abc.png", "/pages/99999.png"):
            with self.subTest(path):
                status, body = self.web.api("GET", f"/api/docs/{state['sid']}{path}")
                self.assertIn(status, (400, 404), (path, status, body))
        status, body = self.web.api("GET", f"/api/docs/{state['sid']}/pages/1.png?v=999999")
        self.assertEqual(status, 409, "a version that is not this one is refused")
        def pixels(asked):                                                       # an absurd size is brought into range, never rendered as asked
            _, data = self.web.request("GET", f"/api/docs/{state['sid']}/pages/1.png?w={asked}")
            return struct.unpack(">I", data[16:20])[0]
        self.assertEqual(pixels(99999), pixels(3200), "both are held at the same ceiling")
        self.assertLess(pixels(99999), 3300)
        self.assertAlmostEqual(pixels(10), 200, delta=2)
        status, _ = self.web.api("GET", "/api/docs/does-not-exist/pages")
        self.assertEqual(status, 404)
        status, _ = self.web.api("GET", f"/api/docs/{state['sid']}/pages/7.png")
        self.assertEqual(status, 404)

    def test_the_picture_follows_the_book_layout(self):
        """A mirrored document's pages are drawn with their own margins: the same text sits further right on page 1 than on page 2."""
        from PIL import Image
        state = self.new_doc("Book")
        fill(self.web, state)
        self.web.ok("POST", f"/api/docs/{state['sid']}/ops", {"op": {"op": "page_layout", "scope": "document", "mirror": True, "margins_mm": {"inside": 40, "outside": 10}}, "base": None})
        info = self.web.ok("GET", f"/api/docs/{state['sid']}/pages")
        edges = []
        for n in (1, 2):
            _, data = self.web.request("GET", f"/api/docs/{state['sid']}/pages/{n}.png?w=800&v={info['version']}")
            image = Image.open(io.BytesIO(data)).convert("L")
            w, h = image.size
            band = image.crop((0, int(h * 0.3), w, int(h * 0.7)))
            dark = [x for x in range(w) if min(band.getpixel((x, y)) for y in range(0, band.size[1], 3)) < 120]
            edges.append(min(dark) / w * 210)
        self.assertAlmostEqual(edges[0], 40, delta=2.5)
        self.assertAlmostEqual(edges[1], 10, delta=2.5)
