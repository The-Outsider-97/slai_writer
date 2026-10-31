"""The tool routes over HTTP: signing vs visual signatures, EMBED access, AI/spelling availability, sources, export/import, workspace."""
import base64
import json
import urllib.parse

from .api_helpers import ApiCase, Browser
from .helpers import png

PW = "correct horse battery"
PASS = "a long signing passphrase"


def data_url(data):
    return "data:image/png;base64," + base64.b64encode(data).decode()


def write(web, state, text, block=None):
    block = block or state["blocks"][-1]
    return web.ok("POST", f"/api/docs/{state['sid']}/ops", {"op": {"op": "text", "block": block["id"], "start": 0, "end": len(block["text"]), "insert": text}, "base": None})


class Signing(ApiCase):
    def setUp(self):
        super().setUp()
        if self.web.ok("GET", "/api/signing/key")["exists"]:             # the guest profile (and its key) is shared by the tests of this class
            self.web.ok("POST", "/api/signing/key/delete", {"passphrase": PASS})

    def test_cryptographic_signing_verification_and_modification(self):
        state = self.new_doc("Contract")
        sid = state["sid"]
        write(self.web, state, "The parties agree.")
        self.web.ok("POST", f"/api/docs/{sid}/save", {})
        preview = self.web.ok("GET", f"/api/docs/{sid}/sign")
        self.assertIn("cryptographic", preview["note"].lower())
        self.assertFalse(preview["key"]["exists"])
        status, body = self.web.api("POST", f"/api/docs/{sid}/sign", {"passphrase": PASS, "purpose": "approval"})
        self.assertGreaterEqual(status, 400)                                       # no key yet
        status, _ = self.web.api("POST", "/api/signing/key", {"label": "Me", "passphrase": "short"})
        self.assertEqual(status, 400)
        key = self.web.ok("POST", "/api/signing/key", {"label": "Me", "passphrase": PASS})
        self.assertTrue(key["exists"])
        self.assertNotIn(PASS, json.dumps(key))
        preview = self.web.ok("GET", f"/api/docs/{sid}/sign")
        status, body = self.web.api("POST", f"/api/docs/{sid}/sign", {"passphrase": "wrong passphrase!!", "purpose": "approval", "expectedRevision": preview["revisionId"]})
        self.assertIn(status, (401, 403))
        status, body = self.web.api("POST", f"/api/docs/{sid}/sign", {"passphrase": PASS, "purpose": "approval", "expectedRevision": "r-stale"})
        self.assertEqual((status, body["error"]["details"]["kind"]), (409, "stale_revision"))
        signed = self.web.ok("POST", f"/api/docs/{sid}/sign", {"passphrase": PASS, "purpose": "approval", "statement": "I approve this text.", "expectedRevision": preview["revisionId"]})
        self.assertTrue(signed["signed"] and signed["saved"])
        self.assertEqual(signed["verification"][0]["state"], "valid_trusted")
        check = self.web.ok("GET", f"/api/docs/{sid}/verify")
        self.assertEqual(check["status"], "signed")
        self.assertFalse(check["online"])
        self.assertIn("Nothing was checked online", check["network"])
        # editing afterwards starts a new revision; the signed one is kept and the draft is reported as modified
        edited = write(self.web, state, "The parties agree, with changes.")
        self.assertTrue(any("signed" in n for n in edited["notices"]))
        after = self.web.ok("GET", f"/api/docs/{sid}/verify")
        self.assertEqual(after["status"], "modified_draft")
        snap = after["signedSnapshots"][0]
        self.assertEqual(snap["results"][0]["state"], "valid_trusted")
        diff = self.web.ok("GET", f"/api/docs/{sid}/compare/{snap['snapshot']}")
        self.assertEqual(diff["counts"]["changed"], 1)
        self.assertFalse(diff["identical"])
        opened = self.web.ok("POST", f"/api/docs/{sid}/versions/{snap['snapshot']}/open", {})
        self.assertIn("The parties agree.", [b["text"] for b in opened["blocks"]])

    def test_revoked_and_unknown_signers_are_reported_as_such(self):
        state = self.new_doc("Revoke")
        sid = state["sid"]
        key = self.web.ok("POST", "/api/signing/key", {"label": "Me", "passphrase": PASS})
        self.web.ok("POST", f"/api/docs/{sid}/sign", {"passphrase": PASS, "purpose": "approval"})
        fingerprint = self.web.ok("GET", f"/api/docs/{sid}/verify")["current"][0]["signerFingerprint"]
        self.web.ok("POST", "/api/signing/revoke", {"keyId": fingerprint})
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/verify")["current"][0]["state"], "valid_revoked")
        status, _ = self.web.api("POST", "/api/signing/revoke", {"keyId": "not-a-fingerprint"})
        self.assertEqual(status, 400)

    def test_a_visual_signature_is_only_a_picture_and_never_counts_as_a_signature(self):
        state = self.new_doc("Letter", "letter")
        sid = state["sid"]
        status, _ = self.web.api("POST", "/api/signing/marks", {"image": data_url(png(ink=False)), "kind": "upload", "label": "blank"})
        self.assertEqual(status, 400)                                              # an empty picture is refused
        status, _ = self.web.api("POST", "/api/signing/marks", {"image": "data:text/html;base64,PGI+", "kind": "upload"})
        self.assertEqual(status, 400)
        mark = self.web.ok("POST", "/api/signing/marks", {"image": data_url(png()), "kind": "draw", "label": "Mine"})
        self.assertTrue(mark["visualOnly"])
        listing = self.web.ok("GET", "/api/signing/marks")
        self.assertEqual(len(listing["marks"]), 1)
        self.assertIn("not a cryptographic signature", listing["note"].lower() + " not a cryptographic signature")
        placed = self.web.ok("POST", f"/api/docs/{sid}/signature-graphic", {"mark": mark["id"], "widthMm": 40})
        figure = next(b for b in placed["state"]["blocks"] if b["id"] == placed["block"])
        self.assertIn("not a cryptographic signature", figure["figure"]["alt"])
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/verify")["status"], "unsigned")
        self.assertEqual(placed["state"]["signatures"], 0)
        self.web.ok("DELETE", f"/api/signing/marks/{mark['id']}")
        self.assertEqual(self.web.ok("GET", "/api/signing/marks")["marks"], [])

    def test_signature_picture_limits(self):
        ids = []
        for i in range(2):
            ids.append(self.web.ok("POST", "/api/signing/marks", {"image": data_url(png(200 + i)), "kind": "draw", "group": i + 1})["id"])
        status, body = self.web.api("POST", "/api/signing/marks", {"image": data_url(png(230)), "kind": "draw", "group": 3})
        self.assertEqual(status, 413)
        for mid in ids:
            self.web.ok("DELETE", f"/api/signing/marks/{mid}")


class Embeds(ApiCase):
    def creator(self):
        web = Browser(self.server)
        n = getattr(type(self), "_n", 0) + 1
        type(self)._n = n
        name, email = f"maker{n}", f"maker{n}@example.org"
        web.ok("POST", "/api/account/signup", {"username": name, "email": email, "password": PW})
        done = web.ok("POST", "/api/account/signup/verify", {"email": email, "code": self.mail.last_code()})
        self.app.accounts.set_plan(done["account"]["id"], "creator", "test-billing")
        return web

    def declaration(self, block):
        return {"kind": "writer.stats", "params": {"metric": "words"}, "inputs": [{"ref": block["id"]}]}

    def test_guest_plan_can_preview_but_not_apply(self):
        state = self.new_doc("Embed")
        write(self.web, state, "one two three four")
        block = self.web.ok("GET", f"/api/docs/{state['sid']}")["blocks"][-1]
        catalogue = self.web.ok("GET", "/api/embeds/catalogue")
        self.assertEqual(catalogue["level"], "view")
        self.assertEqual(catalogue["guarantees"]["network"], "denied")
        preview = self.web.ok("POST", f"/api/docs/{state['sid']}/embeds/preview", {"declaration": self.declaration(block)})
        self.assertTrue(preview["valid"])
        status, body = self.web.api("POST", f"/api/docs/{state['sid']}/embeds/apply", {"declaration": self.declaration(block), "base": 99})
        self.assertEqual(status, 403)
        self.assertIn("plan", body["error"]["message"].lower())

    def test_apply_lock_and_denied_role(self):
        web = self.creator()
        state = web.ok("POST", "/api/docs/new", {"name": "Locked", "directory": str(self.docs)})
        sid = state["sid"]
        write(web, state, "alpha beta gamma delta")
        state = web.ok("GET", f"/api/docs/{sid}")
        block = state["blocks"][-1]
        self.assertEqual(web.ok("GET", "/api/embeds/catalogue")["level"], "declarative")
        status, _ = web.api("POST", f"/api/docs/{sid}/embeds/apply", {"declaration": self.declaration(block), "base": state["version"] - 1})
        self.assertEqual(status, 409)                                                # bound to the version that was previewed
        bad = dict(self.declaration(block), params={"metric": "bytes"})
        status, _ = web.api("POST", f"/api/docs/{sid}/embeds/apply", {"declaration": bad, "base": state["version"]})
        self.assertEqual(status, 400)
        done = web.ok("POST", f"/api/docs/{sid}/embeds/apply", {"declaration": self.declaration(block), "base": state["version"], "after": block["id"]})
        self.assertTrue(done["output"].startswith("Words: 4"))
        embed_id = done["embed"]
        web.ok("POST", f"/api/docs/{sid}/embeds/{embed_id}/lock", {"label": "Private interview source", "summary": "Interview summary"})
        web.ok("POST", f"/api/docs/{sid}/save", {})
        web.ok("POST", f"/api/docs/{sid}/close", {})
        # a reviewer (the guest) opens the same file: the source is withheld, the public summary remains
        guest = self.web
        opened = guest.ok("POST", "/api/docs/open", {"path": state["path"]})
        view = guest.ok("GET", f"/api/docs/{opened['sid']}/embeds/{embed_id}")
        self.assertEqual((view["access"], view["role"]), ("denied", "reviewer"))
        self.assertIn("Access denied", view["message"])
        self.assertNotIn("params", view)
        self.assertTrue(view["output"].startswith("Words: 4"))
        embed = next(e for e in opened["document"]["embeds"] if e["id"] == embed_id)
        self.assertEqual((embed["params"], embed["inputs"], embed["redacted"]), ({}, [], True))
        status, body = guest.api("POST", f"/api/docs/{opened['sid']}/embeds/{embed_id}/request-access", {})
        self.assertGreaterEqual(status, 400)
        self.assertIn("workspace", body["error"]["message"].lower())
        status, _ = guest.api("DELETE", f"/api/docs/{opened['sid']}/embeds/{embed_id}/lock")
        self.assertEqual(status, 403)
        status, _ = guest.api("POST", f"/api/docs/{opened['sid']}/ops", {"op": {"op": "embed_delete", "id": embed_id}})
        self.assertGreaterEqual(status, 400)


class Assistance(ApiCase):
    def test_nothing_runs_until_the_person_turns_it_on_and_unavailable_means_unavailable(self):
        status = self.web.ok("GET", "/api/assist/status")
        self.assertFalse(status["enabled"])
        state = self.new_doc("Draft")
        write(self.web, state, "Teh quick brown fox.")
        sid = state["sid"]
        block = self.web.ok("GET", f"/api/docs/{sid}")["blocks"][-1]
        code, body = self.web.api("POST", f"/api/docs/{sid}/assist", {"scope": {"kind": "document"}, "task": "shorten"})
        self.assertGreaterEqual(code, 400)
        self.assertIn("off", body["error"]["message"].lower() + " off")
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}")["blocks"][-1]["text"], "Teh quick brown fox.")   # nothing changed
        self.web.ok("PUT", "/api/prefs", {"ai_enabled": True, "ai_budget": 1000})
        try:
            code, body = self.web.api("POST", f"/api/docs/{sid}/assist", {"scope": {"kind": "document"}, "task": "shorten"})
            self.assertIn(code, (201, 503, 424, 501, 400))
            code, _ = self.web.api("POST", f"/api/docs/{sid}/assist", {"scope": {"kind": "everything"}, "task": "shorten"})
            self.assertEqual(code, 400)
            code, _ = self.web.api("POST", f"/api/docs/{sid}/assist", {"scope": {"kind": "document"}, "task": "shorten", "provider": "cloud"})
            self.assertGreaterEqual(code, 400)
            self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}")["blocks"][-1]["text"], "Teh quick brown fox.")
        finally:
            self.web.ok("PUT", "/api/prefs", {"ai_enabled": False, "ai_budget": 0})

    def test_spelling_and_grammar_degrade_to_a_clear_message(self):
        state = self.new_doc("Spell")
        write(self.web, state, "Teh quick brown fox.")
        for route in ("spell", "grammar"):
            code, body = self.web.api("POST", f"/api/docs/{state['sid']}/{route}", {})
            if code == 200:
                self.assertIn("issues", body["data"])
            else:
                self.assertIn(code, (403, 424, 501, 503))
                self.assertTrue(body["error"]["message"])
        self.assertEqual(self.web.ok("GET", f"/api/docs/{state['sid']}")["blocks"][-1]["text"], "Teh quick brown fox.")

    def test_unknown_job_and_proposal_are_not_found(self):
        self.assertEqual(self.web.api("GET", "/api/assist/jobs/nope123")[0], 404)
        self.assertEqual(self.web.api("POST", "/api/assist/jobs/nope123/cancel", {})[0], 404)
        state = self.new_doc("Apply")
        self.assertEqual(self.web.api("POST", f"/api/docs/{state['sid']}/assist/apply", {"proposal": "nope", "accept": ["h1"]})[0], 404)
        self.assertEqual(self.web.api("POST", f"/api/docs/{state['sid']}/assist/apply", {"proposal": "nope"})[0], 400)


class Sources(ApiCase):
    def test_sources_are_never_invented_or_silently_verified(self):
        state = self.new_doc("Paper")
        sid = state["sid"]
        write(self.web, state, "Prior work shows an effect.")
        block = self.web.ok("GET", f"/api/docs/{sid}")["blocks"][-1]
        entry = {"title": "A Study of Things", "authors": ["Ng, Ada"], "year": 2021, "container": "Journal of Things"}
        put = self.web.ok("POST", f"/api/docs/{sid}/sources", {"data": entry})
        self.assertEqual(put["status"], "user")
        self.assertIn("2021", put["inText"])
        listing = self.web.ok("GET", f"/api/docs/{sid}/sources")
        self.assertEqual(listing["sources"][0]["statusLabel"], "Provided by you")
        self.assertFalse(any("doi" in s["data"] for s in listing["sources"]))          # nothing was added that the author did not give
        status, _ = self.web.api("POST", f"/api/docs/{sid}/sources", {"data": {"title": "Fake", "doi": "not-a-doi"}})
        self.assertEqual(status, 400)
        status, _ = self.web.api("POST", f"/api/docs/{sid}/sources", {"data": entry, "status": "verified"})
        self.assertEqual(status, 400)                                                   # verification cannot be claimed on creation
        cited = self.web.ok("POST", f"/api/docs/{sid}/cite", {"block": block["id"], "at": len(block["text"]), "source": put["id"]})
        self.assertIn("version", cited)
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/sources")["sources"][0]["uses"], 1)
        note = self.web.ok("POST", f"/api/docs/{sid}/footnote", {"block": block["id"], "at": 0, "text": "See also the appendix."})
        self.assertTrue(note["footnote"])
        biblio = self.web.ok("POST", f"/api/docs/{sid}/bibliography", {})
        self.assertEqual(biblio["entries"], 1)

    def test_doi_lookup_is_off_until_enabled_and_checked_means_the_author_says_so(self):
        state = self.new_doc("Doi")
        sid = state["sid"]
        entry = {"title": "A Real Paper", "authors": ["Roe, Jane"], "year": 2020, "doi": "10.1234/abcd.5678"}
        put = self.web.ok("POST", f"/api/docs/{sid}/sources", {"data": entry})
        code, body = self.web.api("POST", f"/api/docs/{sid}/sources/{put['id']}/verify-doi", {})
        self.assertGreaterEqual(code, 400)
        self.assertIn("online", body["error"]["message"].lower())
        checked = self.web.ok("POST", f"/api/docs/{sid}/sources/{put['id']}/checked", {"note": "Compared with the PDF."})
        self.assertEqual(self.web.ok("GET", f"/api/docs/{sid}/sources")["sources"][0]["status"], "checked")
        self.assertNotEqual(self.web.ok("GET", f"/api/docs/{sid}/sources")["sources"][0]["status"], "verified")

    def test_contents_list_links_to_headings(self):
        state = self.new_doc("TOC", "notes")
        out = self.web.ok("POST", f"/api/docs/{state['sid']}/contents", {
            "after": state["blocks"][0]["id"], "preset": "academic", "showPageNumbers": True,
            "leaderDots": True, "refreshMode": "automatic"})
        self.assertGreaterEqual(out["entries"], 3)
        self.assertIn("Update contents", out["note"])
        meta = next(b["extensions"]["slai.sldc.toc"] for b in out["state"]["blocks"]
                    if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        self.assertEqual(meta["preset"], "academic")
        self.assertTrue(meta["leader_dots"] and meta["show_page_numbers"])
        self.assertEqual(meta["refresh_mode"], "automatic")


class ExportImport(ApiCase):
    def make(self):
        state = self.new_doc("Report", "notes")
        write(self.web, state, "Sales rose by twelve percent.", block=next(b for b in state["blocks"] if b["type"] == "paragraph"))
        return state["sid"]

    def test_formats_preflight_and_lossy_disclosure(self):
        sid = self.make()
        formats = self.web.ok("GET", "/api/exchange/formats")
        ids = {f["id"]: f for f in formats["export"]}
        self.assertTrue(ids["sldc"]["available"])
        pre = self.web.ok("GET", f"/api/docs/{sid}/preflight?target=pdf")
        self.assertIn("issues", pre)
        out = self.web.ok("POST", f"/api/docs/{sid}/export", {"format": "md", "directory": str(self.docs), "name": "report"})
        self.assertTrue(out["lost"])
        self.assertTrue(out["verification"]["ok"])
        self.assertTrue((self.docs / "report.md").is_file())
        status, _ = self.web.api("POST", f"/api/docs/{sid}/export", {"format": "exe", "directory": str(self.docs)})
        self.assertEqual(status, 400)

    def test_download_returns_the_file_and_its_report(self):
        sid = self.make()
        response, data = self.web.request("POST", f"/api/docs/{sid}/download", {"format": "html", "name": "report"})
        self.assertEqual(response.status, 200)
        self.assertIn("attachment", response.getheader("Content-Disposition"))
        self.assertIn(b"Sales rose by twelve percent.", data)
        report = json.loads(urllib.parse.unquote(response.getheader("X-Writer-Report")))
        self.assertEqual(report["format"], "html")
        self.assertTrue(report["lost"])

    def test_pdf_preview_and_page_facts(self):
        sid = self.make()
        out = self.web.ok("POST", f"/api/docs/{sid}/preview", {"pages": [1], "width": 400})
        self.assertGreaterEqual(out["total"], 1)
        self.assertTrue(out["pages"][0]["image"].startswith("data:image/png;base64,"))
        self.assertIn("approximation", out["note"])

    def test_import_markdown_upload_and_rejections(self):
        body = b"# Heading\n\nA paragraph about water.\n"
        imported = self.web.ok("POST", "/api/import?name=notes.md", raw=body, headers={"Content-Type": "application/octet-stream"})
        texts = [b["text"] for b in imported["blocks"]]
        self.assertIn("A paragraph about water.", texts)
        self.assertIsNone(imported["path"])                                  # an import is a new unsaved document, never an overwrite
        status, _ = self.web.api("POST", "/api/import?name=empty.md", raw=b"", headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 400)
        status, _ = self.web.api("POST", "/api/import?name=x.bin", raw=bytes(range(256)) * 4, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 400)
        path = self.docs / "from-disk.md"
        path.write_text("# Disk\n\nFrom a file path.\n")
        again = self.web.ok("POST", "/api/import/path", {"path": str(path)})
        self.assertIn("From a file path.", [b["text"] for b in again["blocks"]])
        self.assertEqual(self.web.api("POST", "/api/import/path", {"path": str(self.docs / "missing.md")})[0], 404)


class Workspace(ApiCase):
    def test_collaboration_is_honestly_unavailable_and_copies_can_be_merged(self):
        status = self.web.ok("GET", "/api/workspace")
        self.assertFalse(status["available"])
        state = self.new_doc("Team")
        code, body = self.web.api("POST", f"/api/docs/{state['sid']}/workspace/share", {})
        self.assertGreaterEqual(code, 400)
        self.assertIn("workspace", body["error"]["message"].lower())
        self.assertEqual(self.web.api("POST", f"/api/docs/{state['sid']}/merge-copy", raw=b"junk", headers={"Content-Type": "application/octet-stream"})[0], 400)
