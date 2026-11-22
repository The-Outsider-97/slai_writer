"""Every request that edits by position carries the version the person was looking at; a stale one is refused (409) and changes nothing."""
from __future__ import annotations

from .api_helpers import ApiCase


class StaleRevisions(ApiCase):
    def setUp(self):
        super().setUp()
        self.state = self.new_doc("Revisions")
        self.sid = self.state["sid"]
        self.block = self.state["blocks"][0]["id"]
        first = self.web.ok("POST", f"/api/docs/{self.sid}/ops", {"op": {"op": "text", "block": self.block, "start": 0, "end": 0, "insert": "Prior work shows an effect."},
                                                                  "base": self.state["version"]})
        self.seen = first["version"]                                      # the version a browser would be holding
        self.web.ok("POST", f"/api/docs/{self.sid}/ops", {"op": {"op": "text", "block": self.block, "start": 0, "end": 0, "insert": ">> "}, "base": self.seen})
        # another tab has now moved the text: ``self.seen`` is stale

    def text(self) -> str:
        return next(b for b in self.web.ok("GET", f"/api/docs/{self.sid}")["blocks"] if b["id"] == self.block)["text"]

    def assert_refused(self, path: str, body: dict):
        before = self.text()
        status, payload = self.web.api("POST", f"/api/docs/{self.sid}/{path}", {**body, "base": self.seen})
        self.assertEqual((status, payload["error"]["details"]["kind"]), (409, "stale_version"), path)
        self.assertEqual(self.text(), before, f"{path} changed the document although it was refused")

    def test_cross_reference_is_refused_when_the_text_moved(self):
        heading = self.web.ok("POST", f"/api/docs/{self.sid}/ops", {"op": {"op": "block_insert", "after": self.block, "block": {"type": "heading", "text": "Method", "attributes": {"level": 1}}}})
        self.assert_refused("xref", {"block": self.block, "start": 0, "end": 5, "target": heading["result"]["block"]})

    def test_footnote_is_refused_when_the_text_moved(self):
        self.assert_refused("footnote", {"block": self.block, "at": 5, "text": "A note."})

    def test_citation_is_refused_when_the_text_moved(self):
        source = self.web.ok("POST", f"/api/docs/{self.sid}/sources", {"data": {"title": "A Study of Things", "authors": ["Ng, Ada"], "year": 2021, "container": "Journal of Things"}})
        self.assert_refused("cite", {"block": self.block, "at": 5, "source": source["id"]})

    def test_the_current_version_is_accepted(self):
        heading = self.web.ok("POST", f"/api/docs/{self.sid}/ops", {"op": {"op": "block_insert", "after": self.block, "block": {"type": "heading", "text": "Method", "attributes": {"level": 1}}}})
        current = heading["version"]
        done = self.web.ok("POST", f"/api/docs/{self.sid}/xref", {"block": self.block, "start": 3, "end": 8, "target": heading["result"]["block"], "base": current})
        self.assertGreater(done["version"], current)
