"""End-to-end tests of the document routes against a real server: the guest's offline path, editing, saving, history, recovery and safety."""
import hashlib
import io
import os
import time

from .api_helpers import ApiCase
from .helpers import png


def last_block(state):
    return state["blocks"][-1]


class GuestDocuments(ApiCase):
    def test_guest_creates_edits_saves_reopens_and_exports_offline(self):
        state = self.new_doc("Field notes", "notes")
        sid = state["sid"]
        self.assertEqual(state["access"]["role"], "owner")
        para = next(b for b in state["blocks"] if b["type"] == "paragraph")
        patch = self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": para["id"], "start": 0, "end": 0, "insert": "Water samples were taken at dawn."}, "base": state["version"]})
        self.assertTrue(patch["dirty"])
        saved = self.web.ok("POST", f"/api/docs/{sid}/save", {})
        self.assertFalse(saved["dirty"])
        path = saved["path"]
        self.web.ok("POST", f"/api/docs/{sid}/close", {})
        again = self.web.ok("POST", "/api/docs/open", {"path": path})
        text = " ".join(b["text"] for b in again["blocks"])
        self.assertIn("Water samples were taken at dawn.", text)
        out = self.web.ok("POST", f"/api/docs/{again['sid']}/export", {"format": "sldc", "directory": str(self.docs), "name": "copy"})
        self.assertTrue(os.path.isfile(out["path"]))
        self.assertEqual(out["verification"]["ok"], True)

    def test_stale_edits_are_refused_not_overwritten(self):
        state = self.new_doc()
        sid, block = state["sid"], state["blocks"][0]["id"]
        op = {"op": "text", "block": block, "start": 0, "end": 0, "insert": "a"}
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": op, "base": state["version"]})
        status, body = self.web.api("POST", f"/api/docs/{sid}/ops", {"op": op, "base": state["version"]})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["details"]["kind"], "stale_version")

    def test_undo_redo_with_dropdown_counts(self):
        state = self.new_doc()
        sid, block = state["sid"], state["blocks"][0]["id"]
        version = state["version"]
        for word in ("one", "two"):
            patch = self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "block_insert", "after": block, "block": {"type": "paragraph", "text": word}}, "base": version})
            version = patch["version"]
        stack = self.web.ok("GET", f"/api/docs/{sid}/history-stack")
        self.assertEqual(len(stack["undo"]), 2)
        back = self.web.ok("POST", f"/api/docs/{sid}/undo", {"count": 2})
        self.assertEqual(len(back["state"]["blocks"]), 1)
        fwd = self.web.ok("POST", f"/api/docs/{sid}/redo", {"count": 1})
        self.assertIn("patch", fwd)

    def test_closing_with_unsaved_changes_needs_a_decision(self):
        state = self.new_doc()
        sid = state["sid"]
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": state["blocks"][0]["id"], "start": 0, "end": 0, "insert": "x"}, "base": state["version"]})
        status, body = self.web.api("POST", f"/api/docs/{sid}/close", {})
        self.assertEqual((status, body["error"]["details"]["kind"]), (409, "unsaved"))
        self.web.ok("POST", f"/api/docs/{sid}/close", {"discard": True})
        status, _ = self.web.api("GET", f"/api/docs/{sid}")
        self.assertEqual(status, 404)

    def test_name_and_location_validation_never_overwrite(self):
        self.new_doc("Same")
        status, body = self.web.api("POST", "/api/docs/new", {"name": "Same", "directory": str(self.docs)})
        self.assertEqual(status, 409)
        for bad in ("", "a/b", "..\\x", "CON", "ends.", "x" * 200):
            status, _ = self.web.api("POST", "/api/docs/new", {"name": bad, "directory": str(self.docs)})
            self.assertEqual(status, 400, bad)
        status, _ = self.web.api("POST", "/api/docs/new", {"name": "Rel", "directory": "relative/dir"})
        self.assertEqual(status, 400)
        self.assertEqual(sorted(p.name for p in self.docs.iterdir()), ["Same.sldc"])

    def test_suggested_name_gets_a_free_variant_but_a_chosen_name_never_does(self):
        self.new_doc("Untitled document")
        state = self.web.ok("POST", "/api/docs/new", {"name": "Untitled document", "directory": str(self.docs), "suggestedName": True})
        self.assertEqual(state["name"], "Untitled document (2)")
        self.assertEqual(state["title"], "Untitled document (2)")
        status, _ = self.web.api("POST", "/api/docs/new", {"name": "Untitled document", "directory": str(self.docs)})
        self.assertEqual(status, 409)
        self.assertEqual(sorted(p.name for p in self.docs.iterdir()), ["Untitled document (2).sldc", "Untitled document.sldc"])

    def test_adding_an_equation_upgrades_the_package_and_says_so_instead_of_failing(self):
        state = self.new_doc("Maths")
        sid, first = state["sid"], state["blocks"][0]["id"]
        patch = self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "block_insert", "after": first, "block": {"type": "equation", "text": "", "equation": {"syntax": "latex", "source": "E = mc^2", "domain": "mathematics"}}}, "base": state["version"]})
        self.assertTrue(any("SLDC 1.1" in n for n in patch["notices"]))
        again = self.web.ok("GET", f"/api/docs/{sid}")
        self.assertTrue(any(b["type"] == "equation" for b in again["blocks"]))
        saved = self.web.ok("POST", f"/api/docs/{sid}/save", {})
        self.assertTrue(saved["saved"])
        reopened = self.web.ok("POST", "/api/docs/open", {"path": saved["path"]})
        self.assertTrue(any(b["type"] == "equation" for b in reopened["blocks"]))

    def test_extension_is_kept_on_rename(self):
        state = self.new_doc("Before")
        renamed = self.web.ok("POST", f"/api/docs/{state['sid']}/rename", {"name": "After.sldc"})
        self.assertTrue(renamed["path"].endswith("After.sldc"))
        self.assertTrue((self.docs / "After.sldc").is_file())
        self.assertFalse((self.docs / "Before.sldc").exists())

    def test_save_as_refuses_existing_files_unless_confirmed(self):
        state = self.new_doc("Original")
        sid = state["sid"]
        self.new_doc("Other")
        status, _ = self.web.api("POST", f"/api/docs/{sid}/save-as", {"name": "Other", "directory": str(self.docs)})
        self.assertEqual(status, 409)
        self.web.ok("POST", f"/api/docs/{sid}/save-as", {"name": "Other", "directory": str(self.docs), "overwrite": True})

    def test_autosave_setting_per_document(self):
        sid = self.new_doc()["sid"]
        out = self.web.ok("POST", f"/api/docs/{sid}/autosave", {"enabled": False, "seconds": 120})
        self.assertEqual((out["enabled"], out["seconds"]), (False, 120))
        self.assertEqual(self.web.ok("GET", "/api/prefs")["autosave_seconds"], 120)
        self.web.ok("PUT", "/api/prefs", {"autosave_seconds": 60})

    def test_malformed_and_foreign_files_are_refused_clearly(self):
        bad = self.docs / "broken.sldc"
        bad.write_bytes(b"this is not a zip")
        status, body = self.web.api("POST", "/api/docs/open", {"path": str(bad)})
        self.assertEqual(status, 400)
        self.assertTrue(body["error"]["details"].get("damaged"))
        status, body = self.web.api("POST", "/api/docs/open", {"path": str(self.docs / "nothing.sldc")})
        self.assertEqual(status, 404)
        other = self.docs / "note.txt"
        other.write_text("hello")
        status, body = self.web.api("POST", "/api/docs/open", {"path": str(other)})
        self.assertEqual((status, body["error"]["details"].get("importable")), (400, True))

    def test_legacy_sdoc_is_opened_only_if_really_sldc_and_never_renamed(self):
        state = self.new_doc("Legacy")
        src = self.docs / "Legacy.sldc"
        legacy = self.docs / "old.sdoc"
        legacy.write_bytes(src.read_bytes())
        digest = hashlib.sha256(legacy.read_bytes()).hexdigest()
        opened = self.web.ok("POST", "/api/docs/open", {"path": str(legacy)})
        self.assertIsNone(opened["path"])
        self.assertEqual(opened["origin"], "legacy")
        self.assertTrue(any(".sdoc" in n for n in opened["notices"]))
        status, _ = self.web.api("POST", f"/api/docs/{opened['sid']}/save", {})
        self.assertEqual(status, 400)
        self.web.ok("POST", f"/api/docs/{opened['sid']}/save-as", {"name": "migrated", "directory": str(self.docs), "newCopy": True})
        self.assertEqual(hashlib.sha256(legacy.read_bytes()).hexdigest(), digest)
        fake = self.docs / "fake.sdoc"
        fake.write_text("not sldc at all")
        status, body = self.web.api("POST", "/api/docs/open", {"path": str(fake)})
        self.assertEqual((status, body["error"]["details"].get("legacy")), (400, True))

    def test_same_file_opens_once(self):
        state = self.new_doc("Once")
        again = self.web.ok("POST", "/api/docs/open", {"path": state["path"]})
        self.assertEqual(again["sid"], state["sid"])
        self.assertTrue(again["alreadyOpen"])


class VersionsAndRecovery(ApiCase):
    def edit(self, state, text):
        block = state["blocks"][0]["id"]
        return self.web.ok("POST", f"/api/docs/{state['sid']}/ops", {"op": {"op": "text", "block": block, "start": 0, "end": len(state["blocks"][0]["text"]), "insert": text}, "base": None})

    def test_named_versions_and_restore_as_new_revision(self):
        state = self.new_doc("History")
        sid = state["sid"]
        self.edit(state, "first draft")
        self.web.ok("POST", f"/api/docs/{sid}/save", {})
        made = self.web.ok("POST", f"/api/docs/{sid}/versions", {"label": "Before review"})
        self.assertEqual(made["snapshot"]["label"], "Before review")
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": state["blocks"][0]["id"], "start": 0, "end": 11, "insert": "second draft"}, "base": None})
        versions = self.web.ok("GET", f"/api/docs/{sid}/versions")["versions"]
        manual = next(v for v in versions if v["label"] == "Before review")
        restored = self.web.ok("POST", f"/api/docs/{sid}/versions/{manual['id']}/restore", {})
        self.assertEqual(restored["blocks"][0]["text"], "first draft")
        self.assertGreater(restored["revision"]["number"], manual["revision"])
        after = self.web.ok("GET", f"/api/docs/{sid}/versions")["versions"]
        self.assertTrue(any(v["label"].startswith("Before restoring") for v in after))
        view = self.web.ok("POST", f"/api/docs/{sid}/versions/{manual['id']}/open", {})
        self.assertTrue(view["access"]["readOnlyReason"])
        status, _ = self.web.api("POST", f"/api/docs/{view['sid']}/ops", {"op": {"op": "text", "block": view["blocks"][0]["id"], "start": 0, "end": 0, "insert": "x"}})
        self.assertEqual(status, 403)

    def test_external_change_is_detected_and_can_be_merged(self):
        from applications.slai_writer import session as S
        state = self.new_doc("Shared", "notes")
        sid, path = state["sid"], state["path"]
        self.web.ok("POST", f"/api/docs/{sid}/save", {})
        # we edit (unsaved); meanwhile another program writes a different edit of the same document to the file
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "block_insert", "after": state["blocks"][0]["id"], "block": {"type": "paragraph", "text": "mine"}}, "base": None})
        theirs = S.load_bytes(__import__("pathlib").Path(path).read_bytes(), None)
        theirs = S.sldc().next_revision(theirs, author="other", note="edited elsewhere")
        theirs.document["blocks"].append(S.sldc().make_block("paragraph", "theirs", section="s1", block_id=S.sldc().new_block_id()))
        with open(path, "wb") as handle:
            handle.write(S.sldc().dumps_package(theirs))
        os.utime(path, (time.time() + 5, time.time() + 5))
        status, body = self.web.api("POST", f"/api/docs/{sid}/save", {})
        self.assertEqual((status, body["error"]["details"]["kind"]), (409, "external_change"))
        self.assertTrue(self.web.ok("GET", f"/api/docs/{sid}/external")["changed"])
        merged = self.web.ok("POST", f"/api/docs/{sid}/external", {"action": "merge"})
        self.assertTrue(merged["applied"])
        texts = [b["text"] for b in merged["state"]["blocks"]]
        self.assertIn("mine", texts)
        self.assertIn("theirs", texts)
        self.web.ok("POST", f"/api/docs/{sid}/save", {})

    def test_overwrite_and_keep_both_are_explicit_choices(self):
        state = self.new_doc("Choice")
        sid, path = state["sid"], state["path"]
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"op": {"op": "text", "block": state["blocks"][0]["id"], "start": 0, "end": 0, "insert": "mine"}, "base": None})
        with open(path, "ab") as handle:
            handle.write(b"x")
        os.utime(path, (time.time() + 5, time.time() + 5))
        kept = self.web.ok("POST", f"/api/docs/{sid}/external", {"action": "keep_both"})
        self.assertTrue(kept["keptBoth"])
        self.assertTrue((self.docs / kept["name"]).is_file())
        self.assertTrue(os.path.isfile(path))                 # the other program's file is untouched
        status, _ = self.web.api("POST", f"/api/docs/{sid}/external", {"action": "nonsense"})
        self.assertEqual(status, 400)

    def test_recovery_copy_is_offered_after_a_crash_and_opens(self):
        state = self.new_doc("Crashy")
        sid = state["sid"]
        self.edit(state, "unsaved words")
        session = self.app.sessions.get(sid)
        self.assertTrue(session.write_recovery())
        recovery = self.web.ok("GET", "/api/home")["recovery"]
        self.assertEqual(recovery, [])                       # the document is still open, so it is not "left over"
        self.app.sessions.sessions.pop(sid)
        self.app.sessions.order.remove(sid)
        recovery = self.web.ok("GET", "/api/home")["recovery"]
        self.assertEqual(len(recovery), 1)
        reopened = self.web.ok("POST", f"/api/recovery/{recovery[0]['id']}/open", {})
        self.assertIn("unsaved words", reopened["blocks"][0]["text"])
        self.assertTrue(reopened["dirty"])
        self.web.ok("POST", f"/api/docs/{reopened['sid']}/close", {"discard": True})
        self.assertEqual(self.web.ok("GET", "/api/home")["recovery"], [])

    def test_a_recovery_copy_can_be_discarded_without_opening(self):
        state = self.new_doc("Discard me")
        self.edit(state, "never mind")
        session = self.app.sessions.get(state["sid"])
        session.write_recovery()
        self.app.sessions.sessions.pop(state["sid"])
        self.app.sessions.order.remove(state["sid"])
        rid = self.web.ok("GET", "/api/home")["recovery"][0]["id"]
        self.web.ok("DELETE", f"/api/recovery/{rid}")
        self.assertEqual(self.web.ok("GET", "/api/home")["recovery"], [])
        status, _ = self.web.api("DELETE", f"/api/recovery/{rid}")
        self.assertEqual(status, 404)
        status, _ = self.web.api("DELETE", "/api/recovery/..%2F..%2Fetc")
        self.assertIn(status, (400, 404))


class HomeAndLibrary(ApiCase):
    def test_recents_favorites_missing_and_locate(self):
        state = self.new_doc("Findable")
        path = state["path"]
        self.web.ok("POST", f"/api/docs/{state['sid']}/close", {})
        home = self.web.ok("GET", "/api/home")
        row = next(d for d in home["documents"] if d["path"] == path)
        self.assertEqual(row["state"], "saved")
        self.web.ok("POST", "/api/library/favorite", {"path": path, "value": True})
        self.assertTrue(next(d for d in self.web.ok("GET", "/api/home")["documents"] if d["path"] == path)["favorite"])
        moved = self.docs / "moved.sldc"
        os.replace(path, moved)
        row = next(d for d in self.web.ok("GET", "/api/home")["documents"] if d["path"] == path)
        self.assertEqual(row["state"], "missing")
        status, _ = self.web.api("POST", "/api/docs/open", {"path": path})
        self.assertEqual(status, 404)
        self.web.ok("POST", "/api/library/locate", {"path": path, "newPath": str(moved)})
        self.assertTrue(any(d["path"] == str(moved) for d in self.web.ok("GET", "/api/home")["documents"]))
        self.web.ok("POST", "/api/library/forget", {"path": str(moved)})
        self.assertFalse(any(d["path"] == str(moved) for d in self.web.ok("GET", "/api/home")["documents"]))
        self.assertTrue(moved.exists())                       # forgetting never touches the file

    def test_locate_refuses_a_different_document(self):
        a, b = self.new_doc("A"), self.new_doc("B")
        self.web.ok("POST", f"/api/docs/{a['sid']}/close", {})
        status, _ = self.web.api("POST", "/api/library/locate", {"path": a["path"], "newPath": b["path"]})
        self.assertEqual(status, 409)

    def test_folders_scan_and_search(self):
        self.new_doc("Alpha report")
        folder = self.web.ok("POST", "/api/library/folders", {"path": str(self.docs), "name": "Work"})
        listing = self.web.ok("GET", f"/api/library/folders/{folder['id']}/documents")["documents"]
        self.assertEqual([d["name"] for d in listing], ["Alpha report"])
        found = self.web.ok("GET", "/api/home?q=alpha")["documents"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["folder"], "Work")
        self.assertEqual(self.web.ok("GET", "/api/home?q=zzzz")["documents"], [])
        status, _ = self.web.api("POST", "/api/library/folders", {"path": str(self.docs / "nope")})
        self.assertEqual(status, 400)

    def test_folder_browser_lists_names_only_and_hides_dotfiles(self):
        (self.docs / ".secret").write_text("x")
        (self.docs / "visible.txt").write_text("x")
        (self.docs / "sub").mkdir()
        listing = self.web.ok("GET", f"/api/fs/browse?path={self.docs}&files=1")
        names = [e["name"] for e in listing["entries"]]
        self.assertEqual(names, ["sub", "visible.txt"])
        self.assertNotIn("content", listing["entries"][1])
        dirs_only = self.web.ok("GET", f"/api/fs/browse?path={self.docs}")
        self.assertEqual([e["name"] for e in dirs_only["entries"]], ["sub"])
        status, _ = self.web.api("GET", f"/api/fs/browse?path={self.docs}/missing")
        self.assertEqual(status, 404)

    def test_templates_follow_the_plan_and_say_so(self):
        listing = self.web.ok("GET", "/api/templates")
        by_id = {t["id"]: t for t in listing["templates"]}
        self.assertTrue(by_id["blank"]["available"])
        self.assertFalse(by_id["thesis"]["available"])
        status, body = self.web.api("POST", "/api/docs/new", {"name": "Thesis", "template": "thesis", "directory": str(self.docs)})
        self.assertEqual((status, body["error"]["details"]["requires"]), (403, "professional"))
        self.assertFalse((self.docs / "Thesis.sldc").exists())


class Content(ApiCase):
    def test_pictures_need_a_description_or_decorative_flag(self):
        state = self.new_doc("Pics")
        sid = state["sid"]
        data = png()
        status, _ = self.web.api("POST", f"/api/docs/{sid}/images", raw=data, headers={"Content-Type": "image/png"})
        self.assertEqual(status, 400)
        out = self.web.ok("POST", f"/api/docs/{sid}/images?alt=A%20wavy%20line", raw=data, headers={"Content-Type": "image/png"})
        self.assertEqual(len(out["assets"]), 1)
        response, body = self.web.request("GET", f"/api/docs/{sid}/assets/{out['asset']}")
        self.assertEqual((response.status, response.getheader("Content-Type")), (200, "image/png"))
        self.assertEqual(body[:4], b"\x89PNG")
        status, _ = self.web.api("POST", f"/api/docs/{sid}/images?alt=x", raw=b"GIF89a-not-really", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 400)
        status, _ = self.web.api("POST", f"/api/docs/{sid}/images?alt=x", raw=b"not an image", headers={"Content-Type": "image/png"})
        self.assertEqual(status, 400)
        saved = self.web.ok("POST", f"/api/docs/{sid}/save", {})
        self.assertTrue(saved["saved"])

    def test_comments_are_part_of_the_document_and_notes_stay_local(self):
        state = self.new_doc("Review", "notes")
        sid = state["sid"]
        block = next(b for b in state["blocks"] if b["type"] == "heading")
        out = self.web.ok("POST", f"/api/docs/{sid}/comments", {"block": block["id"], "text": "Is this the right title?"})
        self.assertEqual(len(out["comments"]), 1)
        tid = out["comments"][0]["id"]
        out = self.web.ok("POST", f"/api/docs/{sid}/comments/{tid}/reply", {"text": "Yes."})
        self.assertEqual(len(out["comments"][0]["messages"]), 2)
        note = self.web.ok("POST", f"/api/docs/{sid}/notes", {"block": block["id"], "start": 0, "end": 3, "anchorText": block["text"][:3], "body": "check later"})
        notes = self.web.ok("GET", f"/api/docs/{sid}/notes")
        self.assertEqual(len(notes["notes"]), 1)
        self.assertIn("not part of the document", notes["scope"])
        self.web.ok("DELETE", f"/api/docs/{sid}/notes/{note['id']}")
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/notes")["notes"], [])
        status, _ = self.web.api("POST", f"/api/docs/{sid}/comments", {"block": "nope", "text": "x"})
        self.assertEqual(status, 400)

    def test_search_and_outline(self):
        state = self.new_doc("Find", "notes")
        sid = state["sid"]
        found = self.web.ok("GET", f"/api/docs/{sid}/search?q=agenda")
        self.assertGreaterEqual(found["count"], 1)
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/search?q=AGENDA&case=1")["count"], 0)
        self.assertGreaterEqual(len(self.web.ok("GET", f"/api/docs/{sid}/outline")["outline"]), 3)
        match = found["matches"][0]
        out = self.web.ok("POST", f"/api/docs/{sid}/replace", {"block": match["block"], "start": match["start"], "end": match["end"], "expect": "Agenda", "with": "Plan"})
        self.assertIn("blocks", out)
        status, _ = self.web.api("POST", f"/api/docs/{sid}/replace", {"block": match["block"], "start": 0, "end": 4, "expect": "stale", "with": "x"})
        self.assertEqual(status, 409)

    def test_cursor_import_assign_and_delete_resets_the_preference(self):
        out = self.web.ok("POST", "/api/cursors?label=Pen&x=2&y=3", raw=png(40, 40), headers={"Content-Type": "image/png"})
        self.assertEqual(out["hotspot"], [2, 3])
        self.web.ok("PUT", "/api/prefs", {"cursor_draw": out["value"]})
        response, body = self.web.request("GET", f"/api/cursors/{out['id']}.png")
        self.assertEqual((response.status, body[:4]), (200, b"\x89PNG"))
        self.web.ok("DELETE", f"/api/cursors/{out['id']}")
        self.assertEqual(self.web.ok("GET", "/api/prefs")["cursor_draw"], "crosshair")
        status, _ = self.web.api("POST", "/api/cursors", raw=b"not an image", headers={"Content-Type": "image/png"})
        self.assertEqual(status, 400)
        status, _ = self.web.api("PUT", "/api/prefs", {"cursor_draw": "custom:../../etc/passwd"})
        self.assertEqual(status, 400)

    def test_a_custom_page_size_replaces_a_named_one_and_back(self):
        doc = self.new_doc("Pages", "blank")
        sid = doc["sid"]
        patch = self.web.ok("POST", f"/api/docs/{sid}/ops", {"base": doc["version"], "op": {"op": "page_setup", "page": {"width_mm": 120, "height_mm": 180}}})
        page = self.web.ok("GET", f"/api/docs/{sid}")["document"]["sections"][0]["page"]
        self.assertNotIn("size", page)
        self.assertEqual((page["width_mm"], page["height_mm"]), (120, 180))
        self.web.ok("POST", f"/api/docs/{sid}/ops", {"base": patch["version"], "op": {"op": "page_setup", "page": {"size": "Legal"}}})
        page = self.web.ok("GET", f"/api/docs/{sid}")["document"]["sections"][0]["page"]
        self.assertEqual(page["size"], "Legal")
        self.assertNotIn("width_mm", page)
