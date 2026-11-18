"""The settings of a table of contents that decide where the parts of an entry go: validation, storage, the native flags they stay in step with, what an update keeps,
and the table following the document (insert, delete, rename, level change)."""
import unittest

from applications.tools.errors import BadRequest
from applications.slai_writer import toc_presets as tp
from applications.slai_writer.academic import Academic
from applications.slai_writer.session import sldc
from .helpers import Workbench

TOC = "slai.sldc.toc"
LAYOUT = ("page_position", "custom_tab_mm", "number_align", "number_column_mm", "leader_char", "leader_gap_pt", "text_align")


class TocSettingsTests(Workbench):
    def setUp(self):
        super().setUp()
        self.app.preferences = lambda: {"lookup_online": False}
        self.ac = Academic(self.app, fetch=lambda doi: {})
        self.s = self.new_session("blank", title="R")
        last = self.s.doc["blocks"][-1]["id"]
        for n, (level, text) in enumerate(((1, "Alpha"), (2, "Beta"), (1, "Gamma"))):
            self.s.apply({"op": "block_insert", "after": last, "block": {"id": f"h{n}", "type": "heading", "text": text, "attributes": {"level": level}}}, None)
            last = f"h{n}"
        self.toc = self.ac.contents(self.s, after=None, look={"preset": "classic"})["tocId"]

    def parts(self):
        blocks = [b for b in self.s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("id") == self.toc]
        return next(b for b in blocks if b["extensions"][TOC]["role"] == "title"), [b for b in blocks if b["extensions"][TOC]["role"] == "entry"]

    def look(self):
        title, _ = self.parts()
        return title["extensions"][tp.EXTENSION], title["extensions"][TOC]

    def styles(self):
        return self.s.doc.get("styles", {}).get("paragraph", {})

    def test_every_layout_setting_is_stored_and_survives_save_and_reopen(self):
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "custom", "custom_tab_mm": 110, "number_align": "center", "number_column_mm": 14,
                                                           "leader": "custom", "leader_char": "*", "leader_gap_pt": 2.5, "text_align": "right"})
        own, native = self.look()
        self.assertEqual((own["page_position"], own["custom_tab_mm"], own["number_align"], own["number_column_mm"], own["leader"], own["leader_char"], own["leader_gap_pt"],
                          own["text_align"]), ("custom", 110.0, "center", 14.0, "custom", "*", 2.5, "right"))
        self.assertIs(native["show_page_numbers"], True)
        self.assertIs(native["leader_dots"], True)
        reopened = sldc().loads_package(self.s.to_bytes()).document
        title = next(b for b in reopened["blocks"] if b.get("extensions", {}).get(TOC, {}).get("role") == "title")
        self.assertEqual(title["extensions"][tp.EXTENSION], own)

    def test_hidden_page_numbers_and_the_native_flag_stay_in_step(self):
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "hidden"})
        own, native = self.look()
        self.assertEqual(own["page_position"], "hidden")
        self.assertIs(native["show_page_numbers"], False)
        self.ac.refresh_contents(self.s, self.toc, look={"leader": "dashes"})
        self.assertIs(self.look()[1]["show_page_numbers"], False, "a change that is not about the numbers does not bring them back")
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "left"})
        own, native = self.look()
        self.assertEqual(own["page_position"], "left")
        self.assertIs(native["show_page_numbers"], True)
        sldc().validate_package(self.s.pkg)

    def test_the_older_page_align_still_means_what_it_meant(self):
        self.ac.refresh_contents(self.s, self.toc, look={"page_align": "left"})
        own, _ = self.look()
        self.assertEqual((own["page_position"], own["page_align"]), ("left", "left"))
        self.ac.refresh_contents(self.s, self.toc, look={"page_align": "inline"})
        self.assertEqual(self.look()[0]["page_position"], "inline")
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "custom"})
        own, _ = self.look()
        self.assertEqual((own["page_position"], own["page_align"]), ("custom", "right"), "what older readers see is the nearest thing they know")
        self.assertEqual(own["custom_tab_mm"], 120.0, "a tab stop is always there to read")

    def test_choosing_a_look_brings_its_own_place_for_the_numbers_but_keeps_nothing_stale(self):
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "custom", "custom_tab_mm": 90, "number_align": "center"})
        self.ac.refresh_contents(self.s, self.toc, look={"preset": "modern"})
        own, _ = self.look()
        self.assertNotIn("custom_tab_mm", own)
        self.assertNotIn("number_align", own)
        self.assertEqual(own["page_position"], tp.PRESETS["modern"]["page_align"])

    def test_text_alignment_reaches_every_level_unless_a_level_has_its_own(self):
        self.ac.refresh_contents(self.s, self.toc, look={"text_align": "right", "levels": {"2": {"align": "center"}}})
        self.assertEqual(self.styles()["TOC Level 1"]["align"], "right")
        self.assertEqual(self.styles()["TOC Level 2"]["align"], "center")
        self.assertEqual(self.styles()["TOC Level 3"]["align"], "right")
        self.ac.refresh_contents(self.s, self.toc, look={"text_align": "left"})
        self.assertNotIn("align", self.styles()["TOC Level 1"])

    def test_bad_layout_values_are_refused_and_change_nothing(self):
        before = sldc().revision_id(self.s.pkg)
        for bad in ({"page_position": "middle"}, {"number_align": "justify"}, {"text_align": "top"}, {"custom_tab_mm": -1}, {"custom_tab_mm": 9999},
                    {"custom_tab_mm": "wide"}, {"custom_tab_mm": True}, {"number_column_mm": 0}, {"leader_gap_pt": 99}, {"leader_char": ""}, {"leader_char": "abcd"},
                    {"leader_char": " "}, {"leader_char": 5}, {"leader": "wavy"}):
            with self.assertRaises(BadRequest, msg=str(bad)):
                self.ac.refresh_contents(self.s, self.toc, look=bad)
        self.assertEqual(sldc().revision_id(self.s.pkg), before)

    def test_clearing_a_setting_brings_back_the_default(self):
        self.ac.refresh_contents(self.s, self.toc, look={"number_align": "center", "leader_gap_pt": 3})
        self.ac.refresh_contents(self.s, self.toc, look={"number_align": None, "leader_gap_pt": None})
        own, _ = self.look()
        self.assertNotIn("number_align", own)
        self.assertNotIn("leader_gap_pt", own)

    def test_one_undo_takes_a_change_of_layout_back(self):
        before = dict(self.look()[0])
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "left", "text_align": "right", "leader": "dashes"})
        self.assertNotEqual(self.look()[0], before)
        self.s.undo(None)
        self.assertEqual(self.look()[0], before)
        self.s.redo(None)
        self.assertEqual(self.look()[0]["page_position"], "left")

    def test_updating_keeps_what_the_writer_did_to_the_entries(self):
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "left", "text_align": "right"})
        _, entries = self.parts()
        entry = entries[0]
        self.s.apply({"op": "format", "block": entry["id"], "start": 0, "end": 3, "set": {"color": "#aa0000"}}, None)
        self.ac.refresh_contents(self.s, self.toc)                                   # an update: nothing about the look changes
        _, again = self.parts()
        self.assertEqual([e["id"] for e in again], [e["id"] for e in entries], "the entries keep their identity")
        self.assertTrue(any(sp.get("color") == "#aa0000" for sp in again[0].get("spans", [])), "the coloured word is still coloured")
        self.assertEqual(self.look()[0]["page_position"], "left")
        self.assertEqual(self.look()[0]["text_align"], "right")

    def test_the_table_follows_the_document(self):
        _, entries = self.parts()
        self.assertEqual([e["text"] for e in entries], ["Alpha", "Beta", "Gamma"])
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "left", "text_align": "right", "leader": "dots"})
        last = self.s.doc["blocks"][-1]["id"]
        self.s.apply({"op": "block_insert", "after": last, "block": {"id": "h9", "type": "heading", "text": "Delta", "attributes": {"level": 2}}}, None)       # insert
        self.ac.refresh_contents(self.s, self.toc)
        self.assertEqual([e["text"] for e in self.parts()[1]], ["Alpha", "Beta", "Gamma", "Delta"])
        self.s.apply({"op": "block_delete", "blocks": ["h1"]}, None)                                                                                        # delete
        self.ac.refresh_contents(self.s, self.toc)
        self.assertEqual([e["text"] for e in self.parts()[1]], ["Alpha", "Gamma", "Delta"])
        self.s.apply({"op": "text", "block": "h2", "start": 0, "end": 5, "insert": "Omega"}, None)                                                         # rename
        self.ac.refresh_contents(self.s, self.toc)
        self.assertEqual([e["text"] for e in self.parts()[1]], ["Alpha", "Omega", "Delta"])
        self.s.apply({"op": "block_set", "block": "h2", "attributes": {"level": 3}}, None)                                                                  # level change
        self.ac.refresh_contents(self.s, self.toc)
        levels = {e["extensions"][TOC]["heading"]: e["extensions"][TOC]["level"] for e in self.parts()[1]}
        self.assertEqual(levels["h2"], 3)
        self.assertEqual(self.parts()[1][1]["style"], "TOC Level 3")
        own, _ = self.look()
        self.assertEqual((own["page_position"], own["text_align"], own["leader"]), ("left", "right", "dots"), "the look survives every update")

    def test_a_renamed_entry_and_a_hidden_entry_survive_a_change_of_layout(self):
        _, entries = self.parts()
        first, second = (e["extensions"][TOC]["heading"] for e in entries[:2])
        self.ac.refresh_contents(self.s, self.toc, entry={"heading": first, "label": "Opening"})
        self.ac.refresh_contents(self.s, self.toc, entry={"heading": second, "hidden": True})
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "left", "text_align": "right"})
        self.assertEqual([e["text"] for e in self.parts()[1]], ["Opening", "Gamma"])
        self.ac.refresh_contents(self.s, self.toc, look={"page_position": "hidden"})
        self.assertEqual([e["text"] for e in self.parts()[1]], ["Opening", "Gamma"])

    def test_an_old_table_without_any_of_these_settings_is_still_read_the_way_it_was(self):
        old = self.ac.contents(self.s, after=None)["tocId"]                           # no look: the way every earlier Writer made it
        blocks = [b for b in self.s.doc["blocks"] if b.get("extensions", {}).get(TOC, {}).get("id") == old]
        title = next(b for b in blocks if b["extensions"][TOC]["role"] == "title")
        self.assertNotIn(tp.EXTENSION, title["extensions"])
        from applications.Documaster.slai.docmodel.writers.toc_layout import resolve_look
        look = resolve_look(None, show_page_numbers=title["extensions"][TOC]["show_page_numbers"], leader_dots=title["extensions"][TOC]["leader_dots"])
        self.assertEqual((look["position"], look["leader"], look["number_align"]), ("right", "dots", "right"))


if __name__ == "__main__":
    unittest.main()
