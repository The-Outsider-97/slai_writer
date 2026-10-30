import types
import unittest
from pathlib import Path

from applications.tools.errors import BadRequest, LimitExceeded
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange, available_formats
from applications.slai_writer.session import sldc
from .helpers import Workbench, png

ROOT = Path(__file__).resolve().parents[3]


class ExportTests(Workbench):
    @classmethod
    def setUpClass(cls):
        import tempfile
        cls._dm_dir = tempfile.TemporaryDirectory()
        cls.dm = DocumasterLink(ROOT, Path(cls._dm_dir.name)).load()

    @classmethod
    def tearDownClass(cls):
        cls.dm.close()
        cls._dm_dir.cleanup()

    def setUp(self):
        super().setUp()
        if not self.dm.available:
            self.skipTest("Documaster is not available: " + str(self.dm.reason))
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024,
                                                  data_dir=self.root / "data")
        self.ex = Exchange(self.app)

    def doc(self):
        s = self.new_session("report", title="Quarterly report", text="Findings: sales rose by twelve percent in the north region.")
        return s

    def test_formats_listing_is_honest(self):
        listing = available_formats(self.dm)
        ids = {f["id"]: f for f in listing["export"]}
        self.assertTrue(ids["pdf"]["available"] and ids["sldc"]["available"])
        self.assertTrue(ids["pdf"]["lossy"])
        down = types.SimpleNamespace(available=False, reason="Documaster was not found.", status=lambda: {"available": False}, services=None)
        off = {f["id"]: f for f in available_formats(down)["export"]}
        self.assertTrue(off["sldc"]["available"])
        self.assertFalse(off["pdf"]["available"])
        self.assertIn("not found", off["pdf"]["reason"])

    def test_export_every_format_verified(self):
        session = self.doc()
        out_dir = self.root / "out"
        for fmt in ("sldc", "pdf", "docx", "odt", "rtf", "html", "md", "txt", "xml"):
            report = self.ex.export(session, fmt, out_dir, stem="quarterly")
            self.assertTrue(Path(report["path"]).is_file(), fmt)
            self.assertTrue(report["verification"]["ok"], (fmt, report["verification"]))
            self.assertGreater(report["bytes"], 100)
            if fmt != "sldc":
                self.assertTrue(report["lost"], fmt)                 # lossy conversions are disclosed
        self.assertEqual(report["name"], "quarterly.xml")

    def test_export_never_overwrites(self):
        session = self.doc()
        a = self.ex.export(session, "pdf", self.root / "out", stem="same")
        b = self.ex.export(session, "pdf", self.root / "out", stem="same")
        self.assertNotEqual(a["path"], b["path"])
        self.assertEqual(Path(a["path"]).name, "same.pdf")
        self.assertEqual(Path(b["path"]).name, "same (1).pdf")

    def test_pdf_facts_and_preview_come_from_the_real_pdf(self):
        session = self.doc()
        report = self.ex.export(session, "pdf", self.root / "out", stem="p")
        self.assertGreaterEqual(report["pdf"]["pages"], 1)
        # the PDF writer's default font is not embedded: that must be reported, not hidden
        self.assertIn("Helvetica", report["pdf"]["unembeddedFonts"])
        self.assertTrue(any("not embedded" in w for w in report["warnings"]))
        embedded = self.ex.export(session, "pdf", self.root / "out", stem="p2", options={"font_family": "DejaVu Sans"})
        self.assertTrue(any(f["embedded"] for f in embedded["pdf"]["fonts"]), embedded["pdf"])       # the body font is embedded now
        self.assertLess(len(embedded["pdf"]["unembeddedFonts"]), len(report["pdf"]["fonts"]))
        preview = self.ex.preview(session, [1], width=400)
        self.assertEqual(preview["pages"][0]["image"][:22], "data:image/png;base64,")
        self.assertEqual(preview["total"], report["pdf"]["pages"])
        self.assertEqual(self.ex.page_count(session), preview["total"])

    def test_preflight_findings(self):
        session = self.new_session("blank", title="Untitled", text="Plain")
        from applications.slai_writer.session import sldc as S
        asset = session.add_image(png(100, 40))
        with self.assertRaises(BadRequest):                    # SLDC itself refuses a picture with neither a description nor decorative=true
            session.apply({"op": "block_insert", "block": {"type": "figure", "text": "", "figure": {"asset": asset.id, "alt": "", "width_mm": 150}}}, None)
        session.apply({"op": "block_insert", "block": {"type": "figure", "text": "", "figure": {"asset": asset.id, "alt": "A chart", "width_mm": 150}}}, None)
        session.apply({"op": "block_insert", "block": {"type": "heading", "text": "Deep", "attributes": {"level": 3}}}, None)
        codes = {i["code"] for i in self.ex.preflight(session, "pdf")["issues"]}
        self.assertTrue({"title", "resolution", "heading_skip"} <= codes, codes)

    def test_preflight_flags_a_signed_document(self):
        session = self.doc()
        from applications.slai_writer.signing import SigningService
        sign = SigningService(self.app)
        sign.create_key("guest", "A", "a long passphrase!")
        sign.sign(session, "guest", "a long passphrase!", "approval", None, None)
        codes = {i["code"] for i in self.ex.preflight(session, "docx")["issues"]}
        self.assertIn("signature", codes)

    def test_import_roundtrip_docx_and_loss_disclosure(self):
        session = self.doc()
        exported = self.ex.export(session, "docx", self.root / "out", stem="rt")
        imported = self.ex.import_bytes(Path(exported["path"]).read_bytes(), "rt.docx", profile="guest")
        self.assertIsNone(imported.path)
        self.assertTrue(imported.dirty)
        self.assertIn("sales rose by twelve percent", imported.plain_text())
        self.assertTrue(any("Imported from Word" in n for n in imported.notices))
        self.assertNotEqual(imported.doc_id, session.doc_id)

    def test_import_text_markdown_html(self):
        md = self.ex.import_bytes(b"# Title\n\nSome *words* here.\n\n- one\n- two\n", "n.md", profile="guest")
        self.assertIn("Some words here", md.plain_text())
        self.assertTrue(any(b["type"] == "heading" for b in md.doc["blocks"]))
        html = self.ex.import_bytes(b"<html><body><h1>Hi</h1><p>Body text</p><script>alert(1)</script></body></html>", "p.html", profile="guest")
        self.assertIn("Body text", html.plain_text())
        self.assertNotIn("alert", html.plain_text())

    def test_import_rejects_unknown_empty_and_oversize(self):
        with self.assertRaises(BadRequest):
            self.ex.import_bytes(b"", "x.docx", profile="guest")
        with self.assertRaises(LimitExceeded):
            self.ex.import_bytes(b"0" * (1024 * 1024 + 1), "x.docx", profile="guest")
        with self.assertRaises(BadRequest):
            self.ex.import_bytes(b"\x00\x01\x02\x03binary", "x.docx", profile="guest")
        with self.assertRaises(BadRequest):
            self.ex.import_bytes(b"PK\x03\x04not really a zip", "x.docx", profile="guest")

    def test_sdoc_is_never_silently_reinterpreted(self):
        session = self.doc()
        data = sldc().dumps_package(session._settled(session.pkg.copy()))
        copy = self.ex.import_bytes(data, "old.sdoc", profile="guest")
        self.assertIsNone(copy.path)                                   # an unsaved copy; the original is not renamed
        self.assertTrue(any(".sdoc" in n for n in copy.notices))
        with self.assertRaises(BadRequest) as ctx:
            self.ex.import_bytes(b"\x00\x01\x02 opaque legacy bytes", "old.sdoc", profile="guest")
        self.assertTrue(ctx.exception.details.get("legacy"))
        as_text = self.ex.import_bytes(b"just some words", "old.sdoc", profile="guest", as_text=True)
        self.assertIn("just some words", as_text.plain_text())

    def test_import_strips_signatures_and_gets_new_identity(self):
        session = self.doc()
        from applications.slai_writer.signing import SigningService
        sign = SigningService(self.app)
        sign.create_key("guest", "A", "a long passphrase!")
        sign.sign(session, "guest", "a long passphrase!", "approval", None, None)
        data = session.to_bytes()
        copy = self.ex.import_bytes(data, "signed.sldc", profile="guest")
        self.assertEqual(len(copy.pkg.signatures), 0)
        self.assertNotEqual(copy.doc_id, session.doc_id)


if __name__ == "__main__":
    unittest.main()
