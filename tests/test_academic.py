import types
import unittest

from applications.tools.errors import BadRequest, DependencyMissing, NotFound
from applications.slai_writer.academic import Academic, clean_entry, in_text, reference_line, FOOTNOTE_ANCHOR
from applications.slai_writer.session import sldc
from .helpers import Workbench

CROSSREF_OK = {"message": {"title": ["Deep learning for document layout"], "issued": {"date-parts": [[2020, 5]]},
                           "author": [{"family": "Smith", "given": "Ann"}, {"family": "Jones", "given": "Bo"}]}}


class AcademicTests(Workbench):
    def setUp(self):
        super().setUp()
        self.prefs = {"lookup_online": False}
        self.app.preferences = lambda: dict(self.prefs)
        self.ac = Academic(self.app, fetch=lambda doi: CROSSREF_OK)
        self.s = self.new_session(text="Layout analysis has improved.")
        self.block = self.s.doc["blocks"][-1]["id"]

    def add(self, **kw):
        data = {"title": "Deep learning for document layout", "authors": ["Smith, Ann", "Jones, Bo"], "year": "2020", "doi": "10.1000/xyz123",
                "container": "Journal of Layout", "volume": "4", "issue": "2", "pages": "10-20"}
        data.update(kw)
        return self.ac.put_source(self.s, data)

    def test_nothing_is_filled_in_or_invented(self):
        entry = clean_entry({"title": "A bare title"})
        self.assertEqual(entry, {"kind": "citation", "title": "A bare title"})
        self.assertEqual(in_text(entry), "(A bare title, n.d.)")
        self.assertEqual(reference_line(entry), "(n.d.) A bare title.")
        with self.assertRaises(BadRequest):
            clean_entry({"authors": ["X"]})                                   # a title is required; it is not guessed
        for bad in ({"year": "20x0"}, {"year": "3050"}, {"doi": "not-a-doi"}, {"url": "ftp://x"}, {"url": "https://user:pw@host/x"},
                    {"accessed": "yesterday"}, {"authors": ["x" * 300]}):
            with self.assertRaises(BadRequest, msg=bad):
                clean_entry({"title": "T", **bad})

    def test_doi_formats_are_normalised_not_invented(self):
        self.assertEqual(clean_entry({"title": "T", "doi": "https://doi.org/10.1000/abc"})["doi"], "10.1000/abc")
        self.assertEqual(clean_entry({"title": "T", "doi": "doi: 10.1000/abc"})["doi"], "10.1000/abc")

    def test_in_text_and_reference_line_use_only_given_fields(self):
        e = clean_entry({"title": "T", "authors": ["Smith, Ann", "Jones, Bo", "Lee, Cy"], "year": "2020"})
        self.assertEqual(in_text(e), "(Smith et al., 2020)")
        self.assertEqual(in_text(clean_entry({"title": "T", "authors": ["Ann Smith", "Bo Jones"], "year": "2020"})), "(Smith & Jones, 2020)")
        self.assertNotIn("doi.org", reference_line(e))

    def test_sources_start_as_user_provided_and_never_verified_by_default(self):
        out = self.add()
        self.assertEqual(out["status"], "user")
        listing = self.ac.sources(self.s)
        self.assertEqual(listing["sources"][0]["statusLabel"], "Provided by you")
        with self.assertRaises(BadRequest):
            self.ac.put_source(self.s, {"title": "X"}, status="registry")      # verified status cannot be requested, only earned
        with self.assertRaises(BadRequest):
            self.ac.put_source(self.s, {"title": "X"}, status="checked")

    def test_cite_links_text_to_source_and_survives_undo(self):
        sid = self.add()["id"]
        self.ac.cite(self.s, self.block, 0, sid)
        block = self.s.doc["blocks"][-1]
        self.assertTrue(block["text"].startswith("(Smith & Jones, 2020)"))
        self.assertEqual([sp for sp in block["spans"] if sp["type"] == "ref"][0]["ref"], sid)
        self.assertEqual(self.ac.sources(self.s)["sources"][0]["uses"], 1)
        self.s.undo(None)
        self.assertEqual(self.s.doc["blocks"][-1]["text"], "Layout analysis has improved.")

    def test_editing_a_checked_source_drops_the_claim(self):
        sid = self.add()["id"]
        self.ac.mark_checked(self.s, sid, "Compared with the PDF")
        self.assertEqual(self.ac.sources(self.s)["sources"][0]["status"], "checked")
        self.ac.put_source(self.s, {"title": "Deep learning for document layout, 2nd ed."}, source_id=sid)
        self.assertEqual(self.ac.sources(self.s)["sources"][0]["status"], "user")

    def test_registry_check_is_opt_in_offline_safe_and_honest(self):
        sid = self.add()["id"]
        with self.assertRaises(DependencyMissing) as ctx:
            self.ac.verify_doi(self.s, sid)
        self.assertIn("switched off", str(ctx.exception))
        self.prefs["lookup_online"] = True
        out = self.ac.verify_doi(self.s, sid)
        self.assertTrue(out["match"])
        self.assertEqual(self.ac.sources(self.s)["sources"][0]["status"], "registry")

    def test_registry_mismatch_is_not_marked_verified(self):
        self.prefs["lookup_online"] = True
        sid = self.add(title="Something entirely different about cooking")["id"]
        out = self.ac.verify_doi(self.s, sid)
        self.assertFalse(out["match"])
        self.assertEqual(self.ac.sources(self.s)["sources"][0]["status"], "user")
        sid2 = self.add(title="Deep learning for document layout", year="1999", doi="10.1000/other")["id"]
        self.assertFalse(self.ac.verify_doi(self.s, sid2)["match"])

    def test_registry_unreachable_changes_nothing(self):
        self.prefs["lookup_online"] = True

        def offline(doi):
            raise DependencyMissing("The DOI registry could not be reached")
        ac = Academic(self.app, fetch=offline)
        sid = self.add()["id"]
        with self.assertRaises(DependencyMissing):
            ac.verify_doi(self.s, sid)
        self.assertEqual(ac.sources(self.s)["sources"][0]["status"], "user")

    def test_unknown_doi(self):
        self.prefs["lookup_online"] = True
        ac = Academic(self.app, fetch=lambda d: {"status": "not_found"})
        sid = self.add()["id"]
        self.assertFalse(ac.verify_doi(self.s, sid)["found"])

    def test_footnote_anchor_and_text(self):
        out = self.ac.footnote(self.s, self.block, 8, "See the appendix for details.")
        block = self.s.doc["blocks"][-1]
        self.assertEqual(block["text"][8], FOOTNOTE_ANCHOR)
        fn = [r for r in self.s.doc["references"] if r["id"] == out["footnote"]][0]
        self.assertEqual(fn["text"], "See the appendix for details.")
        with self.assertRaises(BadRequest):
            self.ac.footnote(self.s, self.block, 0, "  ")

    def test_bibliography_lists_only_cited_sources_and_warns(self):
        cited = self.add()["id"]
        self.add(title="Never cited", doi=None, year="2019")
        self.ac.cite(self.s, self.block, 0, cited)
        out = self.ac.bibliography(self.s, only_cited=True, after=self.block)
        self.assertEqual(out["entries"], 1)
        text = self.s.plain_text()
        self.assertIn("Deep learning for document layout", text)
        self.assertNotIn("Never cited", text)

    def test_ai_marked_source_blocks_a_clean_export_check(self):
        sid = self.ac.put_source(self.s, {"title": "Maybe real"}, status="ai")["id"]
        self.ac.cite(self.s, self.block, 0, sid)
        issues = self.ac.audit(self.s)
        self.assertEqual(issues[0]["code"], "ai_source")
        self.assertEqual(issues[0]["severity"], "error")

    def test_contents_links_to_headings(self):
        s = self.new_session("report", title="R")
        out = self.ac.contents(s, after=None)
        self.assertGreaterEqual(out["entries"], 1)
        toc = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertTrue(all(b["type"] == "paragraph" for b in toc))
        self.assertTrue(all(any(sp["type"] == "xref" for sp in b.get("spans", [])) for b in toc))

    def test_managed_contents_refresh_is_atomic_and_does_not_include_itself(self):
        s = self.new_session("report", title="R")
        initial = self.ac.contents(s, after=None)
        toc_id = initial["tocId"]
        before_count = len(s.doc["blocks"])
        original_title = next(b for b in s.doc["blocks"] if b["id"] == initial["heading"])
        self.assertEqual(original_title["type"], "paragraph")
        heading = next(b for b in s.doc["blocks"] if b["type"] == "heading")
        s.apply({"op": "text", "block": heading["id"], "start": 0, "end": len(heading["text"]), "insert": "Renamed section"}, None)
        updated = self.ac.refresh_contents(s, toc_id)
        self.assertEqual(len(s.doc["blocks"]), before_count)
        self.assertEqual(updated["entries"], initial["entries"])
        linked = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertIn("Renamed section", [b["text"] for b in linked])
        self.assertNotIn("Contents", [b["text"] for b in linked])
        self.assertEqual(s.pkg.version, "1.1.0")
        sldc().validate_package(s.pkg)
        s.undo(None)
        linked_after_undo = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertNotIn("Renamed section", [b["text"] for b in linked_after_undo])

    def test_missing_managed_toc_does_not_mutate_document(self):
        s = self.new_session("report", title="R")
        before = sldc().revision_id(s.pkg)
        with self.assertRaises(BadRequest):
            self.ac.refresh_contents(s, "0" * 24)
        self.assertEqual(sldc().revision_id(s.pkg), before)

    def test_toc_refresh_preserves_custom_label_format_and_preset(self):
        s = self.new_session("report", title="R")
        created = self.ac.contents(s, after=None, preset="academic")
        toc_id = created["tocId"]
        entry = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry")
        original_heading = entry["extensions"]["slai.sldc.toc"]["heading"]
        custom = "My short TOC caption"
        s.apply({"op": "text", "block": entry["id"], "start": 0, "end": len(entry["text"]), "insert": custom}, None)
        s.apply({"op": "block_set", "block": entry["id"], "attributes": {"indent_mm": 19}}, None)
        self.ac.refresh_contents(s, toc_id, depth=6, title="My Contents")
        entries = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertTrue(any(b["text"] == custom and b["attributes"]["indent_mm"] == 19 for b in entries))
        self.assertEqual(entries[0]["type"], "paragraph")
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        self.assertEqual(title["text"], "My Contents")
        self.assertEqual(title["extensions"]["slai.sldc.toc"]["preset"], "academic")
        self.assertEqual(title["extensions"]["slai.sldc.toc"]["overrides"][original_heading]["label"], custom)
        sldc().validate_package(s.pkg)

    def test_toc_entry_customization_and_removal_are_undoable(self):
        s = self.new_session("report", title="R")
        toc_id = self.ac.contents(s, after=None)["tocId"]
        entry = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry")
        heading_id = entry["extensions"]["slai.sldc.toc"]["heading"]
        original_heading = next(b["text"] for b in s.doc["blocks"] if b["id"] == heading_id)

        self.ac.refresh_contents(s, toc_id, entry={"heading": heading_id, "label": "Short label", "hidden": False})
        entries = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertIn("Short label", [b["text"] for b in entries])
        self.assertEqual(next(b["text"] for b in s.doc["blocks"] if b["id"] == heading_id), original_heading)

        self.ac.refresh_contents(s, toc_id, entry={"heading": heading_id, "hidden": True})
        entries = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertNotIn(heading_id, [b["extensions"]["slai.sldc.toc"]["heading"] for b in entries])
        self.ac.refresh_contents(s, toc_id, entry={"heading": heading_id, "label": None, "hidden": False})
        entries = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertIn(original_heading, [b["text"] for b in entries])

        before_remove = sldc().revision_id(s.pkg)
        removed = self.ac.remove_contents(s, toc_id)
        self.assertGreater(removed["removed"], 0)
        self.assertFalse([b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc")])
        self.assertTrue(any(b["id"] == heading_id for b in s.doc["blocks"]))
        self.assertNotEqual(sldc().revision_id(s.pkg), before_remove)
        s.undo(None)
        self.assertTrue(any(b.get("extensions", {}).get("slai.sldc.toc") for b in s.doc["blocks"]))
        sldc().validate_package(s.pkg)

    def test_toc_rejects_invalid_entry_customizations_without_mutating(self):
        s = self.new_session("report", title="R")
        toc_id = self.ac.contents(s, after=None)["tocId"]
        heading_id = next(b["id"] for b in s.doc["blocks"] if b["type"] == "heading")
        before = sldc().revision_id(s.pkg)
        for invalid in ({"heading": heading_id, "label": ""}, {"heading": heading_id, "hidden": "yes"},
                        {"heading": "missing", "hidden": True}, {"heading": heading_id, "unexpected": 1}):
            with self.subTest(invalid=invalid), self.assertRaises(BadRequest):
                self.ac.refresh_contents(s, toc_id, entry=invalid)
        self.assertEqual(sldc().revision_id(s.pkg), before)

    def test_deleting_heading_removes_only_its_toc_entry_and_dangling_link(self):
        s = self.new_session("report", title="R")
        toc_id = self.ac.contents(s, after=None)["tocId"]
        entry = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry")
        heading_id = entry["extensions"]["slai.sldc.toc"]["heading"]
        self.ac.refresh_contents(s, toc_id, entry={"heading": heading_id, "label": "Short label"})
        before = len([b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"])
        s.apply({"op": "block_delete", "blocks": [heading_id]}, None)
        after = [b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "entry"]
        self.assertEqual(len(after), before - 1)
        self.assertFalse(any(b["extensions"]["slai.sldc.toc"]["heading"] == heading_id for b in after))
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        self.assertNotIn(heading_id, title["extensions"]["slai.sldc.toc"]["overrides"])
        sldc().validate_package(s.pkg)
        s.undo(None)
        self.assertTrue(any(b["id"] == heading_id for b in s.doc["blocks"]))

    def test_delete_source_removes_citations(self):
        sid = self.add()["id"]
        self.ac.cite(self.s, self.block, 0, sid)
        self.ac.delete_source(self.s, sid)
        self.assertFalse(self.s.doc.get("references"))
        self.assertFalse([sp for sp in self.s.doc["blocks"][-1].get("spans", []) if sp["type"] == "ref"])
        with self.assertRaises(NotFound):
            self.ac.delete_source(self.s, sid)


if __name__ == "__main__":
    unittest.main()
