import unittest

from applications.tools.errors import BadRequest, Conflict, DependencyMissing
from applications.slai_writer.session import open_file, sldc
from applications.slai_writer.workspace import WorkspaceService
from .helpers import Workbench


class WorkspaceTests(Workbench):
    def setUp(self):
        super().setUp()
        self.ws = WorkspaceService(self.root)

    def two_blocks(self):
        s = self.new_session(text="First paragraph.")
        s.apply({"op": "split", "block": s.doc["blocks"][-1]["id"], "at": 16}, None)
        s.apply({"op": "text", "block": s.doc["blocks"][-1]["id"], "start": 0, "end": 0, "insert": "Second paragraph."}, None)
        s.save()
        s.create_version("Shared", "me")
        s.save()
        return s

    def test_collaboration_is_not_simulated(self):
        self.assertFalse(self.ws.status()["available"])
        with self.assertRaises(DependencyMissing):
            self.ws.require()

    def test_merge_copy_takes_both_sides_changes(self):
        s = self.two_blocks()
        copy_bytes = s.to_bytes()
        theirs = open_file(self.store, s.path, profile="guest")
        theirs.path = self.root / "docs" / "theirs.sldc"
        a = theirs.doc["blocks"][-2]["id"]
        theirs.apply({"op": "text", "block": a, "start": 0, "end": 5, "insert": "FIRST"}, None)
        data = theirs.to_bytes()
        b = s.doc["blocks"][-1]["id"]
        s.apply({"op": "text", "block": b, "start": 0, "end": 6, "insert": "SECOND"}, None)
        out = self.ws.merge_copy(s, data, password=None, author="me", accept_conflicts=False)
        self.assertTrue(out["applied"], out)
        text = s.plain_text()
        self.assertIn("FIRST paragraph.", text)
        self.assertIn("SECOND paragraph.", text)

    def test_conflicts_are_reported_and_not_forced(self):
        s = self.two_blocks()
        theirs = open_file(self.store, s.path, profile="guest")
        a = theirs.doc["blocks"][-1]["id"]
        theirs.apply({"op": "text", "block": a, "start": 0, "end": 6, "insert": "THEIRS"}, None)
        data = theirs.to_bytes()
        s.apply({"op": "text", "block": a, "start": 0, "end": 6, "insert": "OURS!!"}, None)
        out = self.ws.merge_copy(s, data, password=None, author=None, accept_conflicts=False)
        self.assertFalse(out["applied"])
        self.assertEqual(out["conflicts"][0]["ours"][:6], "OURS!!")
        self.assertEqual(out["conflicts"][0]["theirs"][:6], "THEIRS")
        self.assertIn("OURS!!", s.plain_text())
        forced = self.ws.merge_copy(s, data, password=None, author=None, accept_conflicts=True)
        self.assertTrue(forced["applied"])
        self.assertIn("OURS!!", s.plain_text())                                        # ours is kept ...
        self.assertTrue(any(r["kind"] == "merge" for r in self.store.snapshots(s.doc_id)))      # ... and theirs is kept in history

    def test_unrelated_documents_do_not_merge(self):
        s = self.two_blocks()
        other = self.new_session(name="other", text="Different")
        with self.assertRaises(BadRequest):
            self.ws.merge_copy(s, other.to_bytes(), password=None, author=None, accept_conflicts=False)

    # --- external changes to the file on disk
    def edited_elsewhere(self, s):
        other = open_file(self.store, s.path, profile="guest")
        other.apply({"op": "text", "block": other.doc["blocks"][-1]["id"], "start": 0, "end": 0, "insert": "ELSEWHERE "}, None)
        other.save()

    def test_save_detects_external_change_and_each_resolution_works(self):
        for action in ("merge", "keep_both", "overwrite", "reload"):
            with self.subTest(action):
                s = self.new_session(name=f"ext-{action}", text="Alpha.")
                s.save()
                s.create_version("v", "me")
                s.save()
                self.edited_elsewhere(s)
                s.apply({"op": "block_insert", "block": {"type": "paragraph", "text": "Mine."}}, None)
                with self.assertRaises(Conflict) as ctx:
                    s.save()
                self.assertEqual(ctx.exception.details["kind"], "external_change")
                result = s.resolve_external(action)
                on_disk = open_file(self.store, s.path, profile="guest").plain_text()
                if action == "merge":
                    self.assertTrue(result["applied"], result)
                    s.save()
                    merged = open_file(self.store, s.path, profile="guest").plain_text()
                    self.assertIn("ELSEWHERE", merged)
                    self.assertIn("Mine.", merged)
                elif action == "keep_both":
                    self.assertTrue(result["keptBoth"])
                    self.assertIn("(my changes)", s.path.name)
                    self.assertIn("Mine.", on_disk)
                    original = s.path.with_name(f"ext-{action}.sldc")
                    self.assertIn("ELSEWHERE", open_file(self.store, original, profile="guest").plain_text())
                elif action == "overwrite":
                    self.assertIn("Mine.", on_disk)
                    self.assertNotIn("ELSEWHERE", on_disk)
                else:
                    self.assertIn("ELSEWHERE", on_disk)
                    self.assertNotIn("Mine.", s.plain_text())


if __name__ == "__main__":
    unittest.main()
