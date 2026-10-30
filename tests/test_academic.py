import types
import unittest

from applications.tools.errors import BadRequest, DependencyMissing, NotFound
from applications.slai_writer.academic import Academic, clean_entry, in_text, reference_line, FOOTNOTE_ANCHOR
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
        toc = [b for b in s.doc["blocks"] if b["type"] == "list_item"][:out["entries"]]
        self.assertTrue(all(any(sp["type"] == "xref" for sp in b.get("spans", [])) for b in toc))

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
