import base64
import unittest

from applications.tools.errors import BadRequest, Conflict, Forbidden, LimitExceeded, NotFound, Unauthorized
from applications.slai_writer.signing import SigningService
from applications.slai_writer.session import sldc
from .helpers import Workbench, png

PASS = "a long signing passphrase"


class SigningTests(Workbench):
    def setUp(self):
        super().setUp()
        self.sign = SigningService(self.app)

    def signed_session(self):
        session = self.new_session(text="The agreement text.")
        self.sign.create_key("guest", "Anna", PASS)
        pv = self.sign.preview(session)
        out = self.sign.sign(session, "guest", PASS, "approval", "Reviewed", pv["revisionId"])
        return session, out

    def test_key_lifecycle_and_passphrase(self):
        self.assertFalse(self.sign.key_info("guest")["exists"])
        with self.assertRaises(BadRequest):
            self.sign.create_key("guest", "x", "short")
        info = self.sign.create_key("guest", "Anna", PASS)
        self.assertEqual(len(info["keyId"]), 64)
        with self.assertRaises(BadRequest):
            self.sign.create_key("guest", "Again", PASS)
        raw = self.store.key_for("guest")["wrapped"]
        self.assertNotIn(b"private", raw)
        with self.assertRaises(Unauthorized):
            self.sign.delete_key("guest", "wrong passphrase!")
        self.sign.delete_key("guest", PASS)
        self.assertFalse(self.sign.key_info("guest")["exists"])

    def test_wrong_passphrase_locks_out(self):
        session = self.new_session()
        self.sign.create_key("guest", "Anna", PASS)
        rid = self.sign.preview(session)["revisionId"]
        for _ in range(5):
            with self.assertRaises(Unauthorized):
                self.sign.sign(session, "guest", "nope nope nope", "approval", None, rid)
        with self.assertRaises(Forbidden):
            self.sign.sign(session, "guest", PASS, "approval", None, rid)
        self.assertFalse(session.pkg.signatures)

    def test_sign_and_verify_trusted(self):
        session, out = self.signed_session()
        self.assertTrue(out["signed"])
        self.assertTrue(out["saved"])
        result = out["verification"][0]
        self.assertEqual(result["state"], "valid_trusted")              # this computer's own key is trusted
        self.assertIn("claim", result["timestampNote"])
        self.assertTrue((self.root / "docs" / "test.sldc").exists())
        from applications.slai_writer.session import open_file
        again = open_file(self.store, self.root / "docs" / "test.sldc", profile="guest")
        self.assertEqual(self.sign.verify_package(again.pkg)[0]["state"], "valid_trusted")     # the saved file still verifies after a reload

    def test_edit_after_signing_is_a_new_revision_and_modified_draft(self):
        session, _ = self.signed_session()
        signed_no = session.revision_no
        block = session.doc["blocks"][-1]
        session.apply({"op": "text", "block": block["id"], "start": 0, "end": 3, "insert": "A"}, None)
        self.assertEqual(session.revision_no, signed_no + 1)
        report = self.sign.verify(session)
        self.assertEqual(report["status"], "modified_draft")
        self.assertEqual(len(report["signedSnapshots"]), 1)
        self.assertEqual(report["signedSnapshots"][0]["results"][0]["state"], "valid_trusted")
        cmp = self.sign.compare(session, report["signedSnapshots"][0]["snapshot"])
        self.assertFalse(cmp["identical"])
        self.assertEqual(cmp["counts"]["changed"], 1)

    def test_tampered_file_is_modified_or_invalid(self):
        session, _ = self.signed_session()
        pkg = session.pkg.copy()
        pkg.document["blocks"][-1]["text"] = "Different text."
        res = self.sign.verify_package(pkg)[0]
        self.assertIn(res["state"], ("modified", "invalid"))
        self.assertNotEqual(res["state"], "valid_trusted")

    def test_unknown_signer_not_trusted_and_revocation(self):
        session, _ = self.signed_session()
        key_id = self.sign.key_info("guest")["keyId"]
        self.store.db.execute("DELETE FROM trusted_keys")
        self.assertEqual(self.sign.verify_package(session.pkg)[0]["state"], "valid_unknown_signer")
        self.sign.trust_from_document(session, session.pkg.signatures[0]["id"], "Anna")
        self.assertEqual(self.sign.verify_package(session.pkg)[0]["state"], "valid_trusted")
        self.sign.revoke(key_id)
        self.assertEqual(self.sign.verify_package(session.pkg)[0]["state"], "valid_revoked")
        with self.assertRaises(BadRequest):
            self.sign.revoke("nonsense")

    def test_stale_preview_refused(self):
        session = self.new_session(text="One")
        self.sign.create_key("guest", "A", PASS)
        rid = self.sign.preview(session)["revisionId"]
        block = session.doc["blocks"][-1]
        session.apply({"op": "text", "block": block["id"], "start": 0, "end": 1, "insert": "Two"}, None)
        with self.assertRaises(Conflict):
            self.sign.sign(session, "guest", PASS, "approval", None, rid)

    def test_visual_signature_is_not_cryptographic(self):
        session = self.new_session(text="Body")
        self.sign.create_key("guest", "A", PASS)
        mark = self.sign.add_mark("guest", png(), kind="draw", label="Mine", group=None)
        self.assertTrue(mark["visualOnly"])
        out = self.sign.place(session, "guest", mark["id"], session.doc["blocks"][-1]["id"])
        self.assertTrue(out["placed"])
        self.assertEqual(len(session.pkg.signatures), 0)                  # placing a picture signs nothing
        self.assertEqual(self.sign.verify(session)["status"], "unsigned")
        figure = [b for b in session.doc["blocks"] if b["type"] == "figure"][0]
        self.assertIn("not a cryptographic signature", figure["figure"]["alt"])

    def test_mark_limits_and_validation(self):
        for i in range(2):
            self.sign.add_mark("guest", png(), kind="upload", label=f"s{i}", group=i + 1)
        with self.assertRaises(LimitExceeded):
            self.sign.add_mark("guest", png(), kind="upload", label="third", group=3)
        with self.assertRaises(BadRequest):
            self.sign.add_mark("guest", png(ink=False), kind="draw", label="blank", group=1)
        with self.assertRaises(BadRequest):
            self.sign.add_mark("guest", b"not an image", kind="upload", label="x", group=1)
        with self.assertRaises(BadRequest):
            self.sign.add_mark("guest", "data:text/html;base64,PGI+", kind="upload", label="x", group=1)
        for i in range(18):
            self.sign.add_mark("guest", png(), kind="upload", label=f"m{i}", group=1)
        with self.assertRaises(LimitExceeded):
            self.sign.add_mark("guest", png(), kind="upload", label="overflow", group=1)
        self.assertEqual(len(self.sign.marks("guest")["marks"]), 20)

    def test_marks_are_sealed_and_per_profile(self):
        mark = self.sign.add_mark("guest", "data:image/png;base64," + base64.b64encode(png()).decode(), kind="draw", label="Mine", group=None)
        blob = self.store.db.row("SELECT blob FROM sig_marks WHERE id=?", (mark["id"],))["blob"]
        self.assertNotIn(b"PNG", blob)
        self.assertEqual(self.sign.marks("someone-else")["marks"], [])
        with self.assertRaises(NotFound):
            self.sign.delete_mark("someone-else", mark["id"])
        self.sign.delete_mark("guest", mark["id"])

    def test_oversized_picture_rejected(self):
        from PIL import Image
        import io
        big = io.BytesIO()
        Image.new("RGB", (3000, 3000), "white").save(big, "PNG")
        with self.assertRaises((LimitExceeded, BadRequest)):
            self.sign.add_mark("guest", big.getvalue(), kind="upload", label="big", group=1)


if __name__ == "__main__":
    unittest.main()
