"""The twelve contents looks: styles, leaders, page-number placement, numbering, hyperlinks, stable ids, per-level and title formatting, undo, save and reopen."""
import unittest

from applications.tools.errors import BadRequest
from applications.slai_writer import toc_presets as tp
from applications.slai_writer.academic import Academic
from applications.slai_writer.session import sldc
from .helpers import Workbench

TOC = "slai.sldc.toc"


class TocStyleTests(Workbench):
    def setUp(self):
        super().setUp()
        self.app.preferences = lambda: {"lookup_online": False}
        self.ac = Academic(self.app, fetch=lambda doi: {})
        self.s = self.new_session("report", title="R")

    def parts(self, toc_id):
        blocks = [b for b in self.s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("id") == toc_id]
        title = next(b for b in blocks if b["extensions"][TOC]["role"] == "title")
        return title, [b for b in blocks if b["extensions"][TOC]["role"] == "entry"]

    def saved(self):
        return sldc().loads_package(self.s.to_bytes()).document

    def styles(self):
        return self.s.doc.get("styles", {}).get("paragraph", {})

    def test_there_are_twelve_looks_in_the_documented_order(self):
        self.assertEqual(len(tp.ORDER), 12)
        self.assertEqual([tp.PRESETS[k]["name"] for k in tp.ORDER], [
            "Classic", "Modern", "Minimalist", "Academic", "Professional Report", "Formal", "Compact", "Elegant", "Technical Documentation",
            "Book / Manuscript", "Numbered Outline", "Custom"])
        for key in tp.ORDER:
            preset = tp.PRESETS[key]
            self.assertIn(preset["core"], ("standard", "compact", "academic"), key)
            self.assertIn(preset["leader"], tp.LEADERS)
            self.assertIn(preset["page_align"], tp.ALIGNS)

    def test_every_look_makes_a_valid_document_that_survives_save_and_reopen(self):
        for key in tp.ORDER:
            s = self.new_session("report", title="R")
            self.s = s
            toc = self.ac.contents(s, after=None, look={"preset": key})["tocId"]
            title, entries = self.parts(toc)
            self.assertTrue(entries, key)
            reopened = self.saved()
            ext = next(b for b in reopened["blocks"] if b["id"] == title["id"])["extensions"]
            self.assertEqual(ext[tp.EXTENSION]["preset"], key)
            self.assertEqual(ext[TOC]["preset"], tp.PRESETS[key]["core"])
            self.assertEqual(ext[TOC]["leader_dots"], tp.PRESETS[key]["leader"] != "none")
            if key != "custom":
                level1 = reopened["styles"]["paragraph"]["TOC Level 1"]
                self.assertEqual(level1, tp.PRESETS[key]["levels"][0], key)
                self.assertEqual(reopened["styles"]["paragraph"]["TOC Title"], tp.PRESETS[key]["title"], key)

    def test_changing_the_look_restyles_without_touching_headings_and_is_one_undo(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        headings = [(b["id"], b["text"]) for b in self.s.doc["blocks"] if b["type"] == "heading"]
        before_styles = dict(self.styles())
        self.ac.refresh_contents(self.s, toc, look={"preset": "modern"})
        self.assertEqual(self.styles()["TOC Level 1"]["font_family"], "Arial")
        self.assertEqual(self.styles()["TOC Title"]["color"], "#1f4e79")
        self.assertEqual([(b["id"], b["text"]) for b in self.s.doc["blocks"] if b["type"] == "heading"], headings)
        title, _ = self.parts(toc)
        self.assertEqual(title["extensions"][tp.EXTENSION]["leader"], "none")
        self.assertIs(title["extensions"][TOC]["leader_dots"], False)
        self.s.undo(None)
        self.assertEqual(self.styles()["TOC Level 1"], before_styles["TOC Level 1"])
        self.assertEqual(self.parts(toc)[0]["extensions"][tp.EXTENSION]["preset"], "classic")

    def test_ids_are_stable_when_the_table_is_brought_up_to_date(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        title, entries = self.parts(toc)
        ids = [title["id"]] + [e["id"] for e in entries]
        self.ac.refresh_contents(self.s, toc)
        self.ac.refresh_contents(self.s, toc, look={"preset": "formal"})
        title2, entries2 = self.parts(toc)
        self.assertEqual([title2["id"]] + [e["id"] for e in entries2], ids)

    def test_options_leader_page_align_hyperlinks_numbering(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        self.ac.refresh_contents(self.s, toc, look={"leader": "dashes", "page_align": "inline", "hyperlinks": False, "numbered": True})
        title, entries = self.parts(toc)
        ext = title["extensions"][tp.EXTENSION]
        self.assertEqual((ext["leader"], ext["page_align"], ext["hyperlinks"], ext["numbered"]), ("dashes", "inline", False, True))
        self.assertEqual(ext["preset"], "classic")                          # the options alone do not turn the look into a custom one
        self.assertTrue(all("spans" not in e for e in entries))
        self.assertRegex(entries[0]["text"], r"^1 ")
        self.ac.refresh_contents(self.s, toc, look={"hyperlinks": True, "numbered": False, "leader": "none"})
        title, entries = self.parts(toc)
        self.assertIs(title["extensions"][TOC]["leader_dots"], False)
        self.assertTrue(all(any(sp["type"] == "xref" for sp in e["spans"]) for e in entries))
        self.assertNotRegex(entries[0]["text"], r"^\d")

    def test_numbering_follows_the_heading_outline(self):
        s = self.new_session("blank", title="N")
        self.s = s
        last = s.doc["blocks"][-1]["id"]
        for level, text in ((1, "Alpha"), (2, "Beta"), (2, "Gamma"), (1, "Delta"), (2, "Eps"), (3, "Zeta")):
            ident = f"h{text}"
            s.apply({"op": "block_insert", "after": last, "block": {"id": ident, "type": "heading", "text": text, "attributes": {"level": level}}}, None)
            last = ident
        toc = self.ac.contents(s, after=None, look={"preset": "outline"})["tocId"]
        _, entries = self.parts(toc)
        self.assertEqual([e["text"] for e in entries], ["1 Alpha", "1.1 Beta", "1.2 Gamma", "2 Delta", "2.1 Eps", "2.1.1 Zeta"])

    def test_per_level_and_title_formatting(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        self.ac.refresh_contents(self.s, toc, look={"levels": {"1": {"font_size_pt": 15, "italic": True, "color": "#aa0000", "indent_mm": 2}, "2": {"bold": True}},
                                                    "title": {"align": "right", "font_size_pt": 26}})
        self.assertEqual(self.styles()["TOC Level 1"]["font_size_pt"], 15)
        self.assertIs(self.styles()["TOC Level 1"]["italic"], True)
        self.assertEqual(self.styles()["TOC Level 1"]["color"], "#aa0000")
        self.assertIs(self.styles()["TOC Level 2"]["bold"], True)
        self.assertEqual(self.styles()["TOC Level 2"]["font_family"], "Times New Roman")      # the rest of the look stays
        self.assertEqual(self.styles()["TOC Title"]["align"], "right")
        title, _ = self.parts(toc)
        self.assertEqual(title["extensions"][tp.EXTENSION]["preset"], "custom")
        sldc().validate_package(self.s.pkg)

    def test_bad_settings_are_refused_and_change_nothing(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        before = sldc().revision_id(self.s.pkg)
        for bad in ({"preset": "fancy"}, {"leader": "stars"}, {"page_align": "centre"}, {"hyperlinks": "yes"}, {"levels": {"7": {"bold": True}}},
                    {"levels": {"1": {"bogus": 1}}}, {"title": {"font_size_pt": 1, "nope": 1}}, {"unknown": 1}):
            with self.assertRaises(BadRequest, msg=str(bad)):
                self.ac.refresh_contents(self.s, toc, look=bad)
        self.assertEqual(sldc().revision_id(self.s.pkg), before)

    def test_edited_entry_text_and_hidden_entries_survive_a_restyle(self):
        toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]
        _, entries = self.parts(toc)
        heading = entries[0]["extensions"][TOC]["heading"]
        self.ac.refresh_contents(self.s, toc, entry={"heading": heading, "label": "Short label"})
        self.ac.refresh_contents(self.s, toc, look={"preset": "technical"})
        _, entries = self.parts(toc)
        self.assertEqual(entries[0]["text"], "Short label")

    def test_a_table_made_before_the_twelve_looks_keeps_its_look(self):
        toc = self.ac.contents(self.s, after=None)["tocId"]                   # no look: the way every earlier Writer made it
        title, entries = self.parts(toc)
        self.assertNotIn(tp.EXTENSION, title.get("extensions", {}))
        before = [(e["text"], e.get("attributes")) for e in entries]
        self.ac.refresh_contents(self.s, toc)
        title, entries = self.parts(toc)
        self.assertNotIn(tp.EXTENSION, title.get("extensions", {}))
        self.assertEqual([(e["text"], e.get("attributes")) for e in entries], before)


if __name__ == "__main__":
    unittest.main()
