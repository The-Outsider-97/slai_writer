import types
import unittest
from pathlib import Path

from applications.tools.errors import BadRequest, Conflict, DependencyMissing, Forbidden
from applications.slai_writer.embeds import Embeds, KINDS, block_digest
from applications.slai_writer.plans import Plans
from .helpers import Workbench

PLANS = Path(__file__).resolve().parents[1] / "configs" / "plans.yaml"


class EmbedTests(Workbench):
    def setUp(self):
        super().setUp()
        self.app.plans = Plans(PLANS)
        self.em = Embeds(self.app)
        self.session = self.new_session(text="Ten words here: the quick brown fox jumps over the lazy dog. It is nice.")
        self.src = self.session.doc["blocks"][-1]["id"]

    def decl(self, **kw):
        base = {"kind": "writer.stats", "params": {"metric": "words"}, "inputs": [{"ref": self.src}]}
        base.update(kw)
        return base

    def test_validate_reports_each_problem_and_never_runs_unknown_kinds(self):
        for bad, path in ((self.decl(kind="evil.shell"), "kind"), (self.decl(params={"metric": "bytes"}), "params.metric"),
                          (self.decl(params={}), "params.metric"), (self.decl(params={"metric": "words", "extra": 1}), "params.extra"),
                          (self.decl(inputs=[]), "inputs"), (self.decl(inputs=[{"ref": "nope"}]), "inputs[0]"),
                          (self.decl(capabilities=["network.fetch"]), "capabilities")):
            result = self.em.validate(self.session, bad)
            self.assertFalse(result["valid"], bad)
            self.assertIn(path, [e["path"] for e in result["errors"]])
            self.assertIsNone(result["output"])

    def test_preview_changes_nothing_and_apply_is_unavailable_until_valid(self):
        before = self.session.version
        ok = self.em.preview(self.session, self.decl())
        self.assertTrue(ok["valid"] and ok["canApply"])
        self.assertTrue(ok["preview"].startswith("Words: "))
        self.assertEqual(self.session.version, before)
        bad = self.em.preview(self.session, self.decl(params={"metric": "bytes"}))
        self.assertFalse(bad["canApply"])
        with self.assertRaises(BadRequest):
            self.em.apply(self.session, self.decl(params={"metric": "bytes"}), after=self.src, embed_id=None, base=self.session.version, plan="creator")

    def test_apply_is_bound_to_version_inputs_and_plan(self):
        d = self.decl(inputs=[{"ref": self.src, "sha256": block_digest(self.session.doc["blocks"][-1])}])
        with self.assertRaises(BadRequest):
            self.em.apply(self.session, d, after=self.src, embed_id=None, base=None, plan="creator")
        with self.assertRaises(Conflict):
            self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version - 1, plan="creator")
        with self.assertRaises(Exception) as ctx:                                    # the Guest plan can view but not create components
            self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version, plan="guest")
        self.assertIn("plan", str(ctx.exception).lower())
        out = self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version, plan="creator")
        block = next(b for b in self.session.doc["blocks"] if b.get("embed") == out["embed"])
        self.assertEqual(block["text"], out["output"])
        decl = self.session.doc["embeds"][0]
        self.assertEqual(decl["capabilities"] if "capabilities" in decl else [], [])
        self.assertEqual(decl["output_sha256"], __import__("hashlib").sha256(out["output"].encode()).hexdigest())
        self.session.undo(None)                                                      # one undoable edit
        self.assertFalse(self.session.doc.get("embeds"))

    def test_changed_input_makes_apply_and_state_stale(self):
        d = self.decl(inputs=[{"ref": self.src, "sha256": block_digest(self.session.doc["blocks"][-1])}])
        out = self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version, plan="creator")
        self.assertEqual(self.em.stale(self.session), [])
        self.session.apply({"op": "text", "block": self.src, "start": 0, "end": 3, "insert": "Eleven"}, None)
        self.assertEqual(self.em.stale(self.session)[0]["embed"], out["embed"])
        with self.assertRaises(Conflict):
            self.em.apply(self.session, d, after=None, embed_id=out["embed"], base=self.session.version, plan="creator")

    def test_table_total_rejects_non_numbers(self):
        self.session.apply({"op": "block_insert", "block": {"type": "table", "rows": 3, "cols": 2}}, None)
        table = next(b for b in self.session.doc["blocks"] if b["type"] == "table")
        for r, (a, b) in enumerate((("Item", "Cost"), ("A", "1,250.50"), ("B", "n/a"))):
            self.session.apply({"op": "table_cell", "block": table["id"], "row": r, "col": 0, "text": a}, None)
            self.session.apply({"op": "table_cell", "block": table["id"], "row": r, "col": 1, "text": b}, None)
        self.session.apply({"op": "table_edit", "block": table["id"], "action": "header_rows", "count": 1}, None)
        d = {"kind": "writer.table_total", "params": {"column": 1, "operation": "sum"}, "inputs": [{"ref": table["id"]}]}
        bad = self.em.validate(self.session, d)
        self.assertFalse(bad["valid"])
        self.assertIn("not a number", bad["errors"][0]["message"])
        self.session.apply({"op": "table_cell", "block": table["id"], "row": 2, "col": 1, "text": "49.50"}, None)
        self.assertEqual(self.em.validate(self.session, d)["output"], "Sum: 1,300.00")

    def test_a_component_cannot_read_another_component(self):
        d = self.decl(inputs=[{"ref": self.src, "sha256": block_digest(self.session.doc["blocks"][-1])}])
        out = self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version, plan="creator")
        block = next(b for b in self.session.doc["blocks"] if b.get("embed") == out["embed"])
        r = self.em.validate(self.session, self.decl(inputs=[{"ref": block["id"]}]))
        self.assertFalse(r["valid"])

    def test_document_with_unknown_component_is_shown_never_run(self):
        self.session.apply({"op": "embed_put", "embed": {"id": "ext1", "kind": "vendor.widget", "schema_version": 1, "capabilities": ["network.fetch"]}}, None)
        self.session.apply({"op": "block_insert", "block": {"type": "embed", "text": "Fallback text", "embed": "ext1"}}, None)
        view = self.em.view(self.session, "ext1")
        self.assertFalse(view["known"])
        self.assertEqual(view["capabilities"], ["network.fetch"])                   # reported, never granted
        r = self.em.validate(self.session, self.session.doc["embeds"][0])
        self.assertFalse(r["valid"])

    # --- locks and roles
    def locked(self):
        d = self.decl(inputs=[{"ref": self.src, "sha256": block_digest(self.session.doc["blocks"][-1])}], params={"metric": "words", "title": "Private interview source"})
        out = self.em.apply(self.session, d, after=self.src, embed_id=None, base=self.session.version, plan="creator")
        self.em.lock(self.session, out["embed"], "Private interview source", "Public summary: 10 words.")
        return out["embed"]

    def test_locked_component_hides_its_source_from_a_reviewer(self):
        eid = self.locked()
        self.assertEqual(self.em.view(self.session, eid)["access"], "granted")          # the owner
        self.store.claim(self.session.doc_id, "someone-else")                            # the document belongs to another account
        self.assertEqual(self.session.role(), "reviewer")
        view = self.em.view(self.session, eid)
        self.assertEqual(view["access"], "denied")
        self.assertNotIn("params", view)
        self.assertIn("Access denied", view["message"])
        self.assertTrue(view["output"])                                                  # the public summary stays available
        state = self.session.state()
        decl = [e for e in state["document"]["embeds"] if e["id"] == eid][0]
        self.assertEqual(decl["params"], {})
        self.assertTrue(decl["redacted"])
        with self.assertRaises(Forbidden):
            self.em.apply(self.session, self.decl(), after=None, embed_id=eid, base=self.session.version, plan="creator")
        with self.assertRaises(Forbidden):
            self.session.apply({"op": "embed_delete", "id": eid}, None)
        with self.assertRaises(Forbidden):
            self.em.unlock(self.session, eid)
        with self.assertRaises(DependencyMissing):
            self.em.request_access(self.session)

    def test_lock_state_does_not_leak_through_patches(self):
        eid = self.locked()
        self.store.claim(self.session.doc_id, "someone-else")
        patch = self.session.apply({"op": "text", "block": self.src, "start": 0, "end": 1, "insert": "X"}, None)
        self.assertNotIn("params", str(patch.get("document", {}).get("embeds", "")).replace("'params': {}", ""))


if __name__ == "__main__":
    unittest.main()
