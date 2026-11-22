"""How the 2.4 parts work together (audit finding E): one revision counter for every edit, all-or-nothing transactions, services that are missing or fail
half-way, and documents that carry data Writer does not know.

Everything here goes through the same entry points the editor uses (session.apply, the Academic and Assist services, the HTTP routes).
"""
from __future__ import annotations

import copy
import types
import unittest
from pathlib import Path

from applications.slai_writer import assist as assist_module
from applications.slai_writer.academic import Academic
from applications.slai_writer.ops import OpError
from applications.slai_writer.session import DocumentSession, sldc
from applications.tools.errors import BadRequest, Conflict, DependencyMissing
from .api_helpers import ApiCase
from .helpers import Workbench


class Transactions(Workbench):
    def setUp(self):
        super().setUp()
        self.s = self.new_session("blank", title="Transactions", text="First paragraph.")
        self.block = self.s.doc["blocks"][-1]["id"]

    def snapshot(self):
        return (copy.deepcopy(self.s.doc), self.s.version, len(self.s.undo_stack), len(self.s.redo_stack))

    def test_a_batch_with_one_bad_step_changes_nothing_at_all(self):
        before = self.snapshot()
        with self.assertRaises((OpError, BadRequest)):
            self.s.apply({"op": "batch", "ops": [
                {"op": "text", "block": self.block, "start": 0, "end": 0, "insert": ">> "},
                {"op": "block_insert", "after": self.block, "block": {"id": "n1", "type": "paragraph", "text": "New"}},
                {"op": "text", "block": "does-not-exist", "start": 0, "end": 0, "insert": "x"}]}, None)
        self.assertEqual(self.snapshot(), before, "document, version and both history stacks are exactly as they were")

    def test_a_text_edit_made_for_other_text_is_refused_whole(self):
        before = self.snapshot()
        with self.assertRaises(Conflict):
            self.s.apply({"op": "batch", "ops": [{"op": "text", "block": self.block, "start": 0, "end": 5, "insert": "Other", "expect": "First"},
                                                 {"op": "text", "block": self.block, "start": 6, "end": 15, "insert": "x", "expect": "NOT THERE"}]}, None)
        self.assertEqual(self.snapshot(), before)

    def test_every_accepted_edit_moves_one_version_and_one_undo_step(self):
        v, n = self.s.version, len(self.s.undo_stack)
        self.s.apply({"op": "batch", "ops": [{"op": "text", "block": self.block, "start": 0, "end": 0, "insert": "A"},
                                             {"op": "block_insert", "after": self.block, "block": {"id": "n2", "type": "paragraph", "text": "B"}}]}, None)
        self.assertEqual((self.s.version, len(self.s.undo_stack)), (v + 1, n + 1))
        self.s.undo(None)
        self.assertEqual(self.s.doc["blocks"][-1]["text"], "First paragraph.", "one undo takes back the whole batch")

    def test_a_stale_base_is_refused_and_changes_nothing(self):
        stale = self.s.version
        self.s.apply({"op": "text", "block": self.block, "start": 0, "end": 0, "insert": "Moved. "}, None)
        before = self.snapshot()
        with self.assertRaises(Conflict):
            self.s.apply({"op": "text", "block": self.block, "start": 3, "end": 3, "insert": "x"}, stale)
        self.assertEqual(self.snapshot(), before)

    def test_unknown_extensions_blocks_and_spans_of_other_producers_survive_editing_and_saving(self):
        package = sldc().loads_package(self.s.to_bytes())
        document = package.document
        document["extensions"] = {**(document.get("extensions") or {}), "vendor.other": {"keep": [1, 2, {"deep": True}]}}
        document["blocks"][-1]["extensions"] = {"vendor.other": {"note": "on a block"}}
        foreign = DocumentSession(self.store, package, path=self.root / "docs" / "foreign.sldc", profile="guest")
        foreign.apply({"op": "text", "block": foreign.doc["blocks"][-1]["id"], "start": 0, "end": 0, "insert": "Edited. "}, None)
        reopened = sldc().loads_package(foreign.to_bytes()).document
        self.assertEqual(reopened["extensions"]["vendor.other"], {"keep": [1, 2, {"deep": True}]})
        self.assertEqual(reopened["blocks"][-1]["extensions"]["vendor.other"], {"note": "on a block"})
        self.assertTrue(reopened["blocks"][-1]["text"].startswith("Edited. "))


class Services(Workbench):
    """A service that is missing or fails half-way never leaves the document half-changed, and says what is missing."""

    def setUp(self):
        super().setUp()
        self.app.preferences = lambda: {"lookup_online": False}
        self.ac = Academic(self.app, fetch=lambda doi: {})
        self.s = self.new_session("blank", title="Services", text="Text to cite.")
        self.block = self.s.doc["blocks"][-1]["id"]
        self.sid = self.ac.put_source(self.s, {"title": "A Study", "authors": ["Ng, Ada"], "year": "2021", "container": "J"})["id"]

    def test_citing_without_the_citation_processor_still_works_and_the_bibliography_says_which_layout_it_used(self):
        from applications.slai_writer import citation_engine
        original = citation_engine.CitationEngine.__init__

        def missing(self, references):
            from applications.tools.errors import DependencyMissing
            raise DependencyMissing("APA 7 citation formatting needs the 'citeproc-py' package (pip install citeproc-py).")
        citation_engine.CitationEngine.__init__ = missing
        self.addCleanup(setattr, citation_engine.CitationEngine, "__init__", original)
        self.ac.cite(self.s, self.block, 4, self.sid)
        out = self.ac.bibliography(self.s)
        self.assertTrue(any("citeproc-py" in w for w in out.get("warnings", [])), out.get("warnings"))
        self.assertIn("Ng", "\n".join(b["text"] for b in self.s.doc["blocks"]))

    def test_a_failure_while_building_the_bibliography_leaves_the_document_untouched(self):
        from applications.slai_writer import academic
        before = (copy.deepcopy(self.s.doc), self.s.version)
        original = academic.CitationEngine.bibliography

        def explode(self):
            raise RuntimeError("the style crashed")
        academic.CitationEngine.bibliography = explode
        self.addCleanup(setattr, academic.CitationEngine, "bibliography", original)
        try:
            self.ac.bibliography(self.s)
        except Exception:  # noqa: BLE001 - what is raised is not the point: the document must be as it was
            pass
        self.assertEqual((self.s.doc, self.s.version), before)

    def test_proofing_with_a_checker_that_cannot_load_says_so_with_when_it_will_try_again_and_changes_nothing(self):
        before = (copy.deepcopy(self.s.doc), self.s.version)
        proof = assist_module.Assist(self.app)
        with self.assertRaises(DependencyMissing) as first:
            proof.proofread(self.s, ("spelling",), None, 50, None)
        self.assertIn("retryAfter", first.exception.details or {}, "the answer says when Writer will try again")
        with self.assertRaises(DependencyMissing) as paused:
            proof.proofread(self.s, ("spelling",), None, 50, None)
        self.assertGreater(paused.exception.details["retryAfter"], 0, "a second request during the pause is answered without trying to load the checker again")
        with self.assertRaises(DependencyMissing):
            proof.proofread(self.s, ("spelling",), None, 50, None, retry=True)                      # pressing Check does not wait for the pause
        self.assertEqual((self.s.doc, self.s.version), before, "checking never edits")


class Concurrency(ApiCase):
    def test_two_windows_editing_the_same_text_cannot_overwrite_each_other(self):
        state = self.new_doc("Two windows")
        sid, block, base = state["sid"], state["blocks"][0]["id"], state["version"]
        one = self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": block, "start": 0, "end": 0, "insert": "One. "}, "base": base})
        status, body = self.web.api("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": block, "start": 0, "end": 0, "insert": "Two. "}, "base": base})
        self.assertEqual((status, body["error"]["details"]["kind"]), (409, "stale_version"))
        now = self.web.ok("GET", f"/api/docs/{sid}")
        text = next(b for b in now["blocks"] if b["id"] == block)["text"]
        self.assertTrue(text.startswith("One. ") and "Two." not in text)
        retry = self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": block, "start": 0, "end": 0, "insert": "Two. "}, "base": one["version"]})
        self.assertGreater(retry["version"], one["version"])

    def test_a_derived_edit_runs_against_the_current_text_not_a_stale_one(self):
        """The contents list and the bibliography are built on the server from the text as it is when the request runs: no base is needed, and none can be stale."""
        state = self.new_doc("Derived")
        sid = state["sid"]
        head = state["blocks"][0]["id"]
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "block_insert", "after": head, "block": {"id": "h2", "type": "heading", "text": "Method", "attributes": {"level": 1}}}, "base": None})
        out = self.web.ok("POST", f"/api/docs/{sid}/contents", {"title": "Contents"})
        again = self.web.ok("GET", f"/api/docs/{sid}")
        self.assertIn("Method", "\n".join(b["text"] for b in again["blocks"]))
        self.assertTrue(out)


if __name__ == "__main__":
    unittest.main()
