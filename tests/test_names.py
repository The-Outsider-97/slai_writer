"""APA 7 author names (audit finding D): how typed names become structured names, what is flagged instead of guessed, and what can be said to correct a reading.

These run without citeproc-py (the CSL rendering itself is exercised by test_academic where it is installed): the reading of the name, the fallback
in-text marks and reference lines, the year-suffix grouping that feeds citeproc, and the notes a person sees. A name Writer is unsure of is never rewritten.
"""
import tempfile
import unittest
from pathlib import Path

from applications.slai_writer.academic import Academic, clean_entry, in_text, reference_line
from applications.slai_writer.citation_engine import _year_suffixes, csl_source
from applications.slai_writer.names import parse, read_all
from .helpers import Workbench


class Reading(unittest.TestCase):
    def test_a_comma_or_braces_are_the_persons_statement_and_carry_no_note(self):
        for text, csl in (("Smith, J. A.", {"family": "Smith", "given": "J. A."}),
                          ("García Márquez, Gabriel", {"family": "García Márquez", "given": "Gabriel"}),
                          ("van Beethoven, Ludwig", {"family": "van Beethoven", "given": "Ludwig"}),
                          ("King, Martin Luther, Jr.", {"family": "King", "given": "Martin Luther", "suffix": "Jr."}),
                          ("{World Health Organization}", {"literal": "World Health Organization"}),
                          ("{Plato}", {"literal": "Plato"}),
                          ("Wang, Wei", {"family": "Wang", "given": "Wei"})):
            name = parse(text)
            self.assertEqual(name.csl(), csl, text)
            self.assertTrue(name.stated, text)
            self.assertIsNone(name.note, text)

    def test_particles_and_compound_family_names_without_a_comma(self):
        self.assertEqual(parse("Ludwig van Beethoven").csl(), {"family": "van Beethoven", "given": "Ludwig"})
        self.assertEqual(parse("Jan van der Berg").csl(), {"family": "van der Berg", "given": "Jan"})
        self.assertEqual(parse("Ana de la Cruz").csl(), {"family": "de la Cruz", "given": "Ana"})
        self.assertEqual(parse("Maria de los Santos").csl(), {"family": "de los Santos", "given": "Maria"})
        self.assertEqual(parse("Ursula K. Le Guin").csl(), {"family": "Le Guin", "given": "Ursula K."})
        self.assertEqual(parse("Ahmad al-Sayed").csl(), {"family": "al-Sayed", "given": "Ahmad"})
        self.assertEqual(parse("Al Gore").csl(), {"family": "Gore", "given": "Al"})              # a first name that looks like a particle is a first name

    def test_suffixes_are_not_family_names(self):
        for text in ("Martin Luther King Jr.", "Martin Luther King, Jr.", "King, Martin Luther, Jr."):
            self.assertEqual(parse(text).csl()["suffix"], "Jr.", text)
            self.assertEqual(parse(text).csl()["family"], "King", text)

    def test_hyphenated_and_initialled_given_names(self):
        self.assertEqual(parse("Jean-Pierre Dupont").csl(), {"family": "Dupont", "given": "Jean-Pierre"})
        self.assertEqual(parse("J. K. Rowling").csl(), {"family": "Rowling", "given": "J. K."})
        self.assertEqual(parse("Jean-Pierre Dupont").display(), "Dupont, J.-P.")
        self.assertEqual(parse("Rowling, Joanne Kathleen").display(), "Rowling, J. K.")

    def test_a_single_word_is_a_family_name_and_text_in_other_scripts_is_kept_whole(self):
        self.assertEqual(parse("Plato").csl(), {"family": "Plato"})
        self.assertEqual(parse("王伟").csl(), {"family": "王伟"})
        self.assertEqual(parse("Ibn Sina").csl()["family"], "Sina")
        self.assertEqual(parse("  Jane   Smith ").csl(), {"family": "Smith", "given": "Jane"})     # spaces are tidied for reading only

    def test_institutions_are_kept_whole_and_flagged_not_split(self):
        for text in ("World Health Organization", "University of California, Berkeley", "Johnson & Johnson", "Universiteit van Amsterdam", "Smith and Jones"):
            name = parse(text)
            self.assertTrue(name.literal, text)
            self.assertEqual(name.csl(), {"literal": text}, text)
            self.assertIn("{", name.note or "", f"the note says how to confirm it: {text}")
        self.assertFalse(parse("Jane Church").literal)                                                  # one institution-like word is not enough

    def test_what_cannot_be_told_is_flagged_with_the_way_to_say_it(self):
        gm = parse("Gabriel García Márquez")
        self.assertEqual(gm.csl(), {"family": "Márquez", "given": "Gabriel García"})
        self.assertIn("García Márquez, Gabriel", gm.note)
        self.assertIn("Family, Given", parse("王 伟").note)
        vancouver = parse("Smith JA")
        self.assertEqual(vancouver.csl(), {"family": "Smith", "given": "J. A."})
        self.assertIn("initials", vancouver.note)
        self.assertIsNone(parse("Jane Smith").note)                                                     # nothing to say about the ordinary case
        self.assertIsNone(parse("Ursula K. Le Guin").note)

    def test_the_correction_is_to_retype_it_and_the_note_goes_away(self):
        for text in ("Gabriel García Márquez", "Smith JA", "World Health Organization", "王 伟"):
            name = parse(text)
            again = parse(name.canonical())
            self.assertIsNone(again.note, text)
            self.assertTrue(again.stated, text)
            self.assertEqual(again.csl(), name.csl(), f"retyping what Writer read changes nothing it read: {text}")
        self.assertEqual(parse("García Márquez, Gabriel").canonical(), "García Márquez, Gabriel")
        self.assertEqual(parse("{WHO}").canonical(), "{WHO}")

    def test_the_same_person_has_the_same_key_however_typed(self):
        self.assertEqual(parse("Smith, Jane").key(), parse("Jane Smith").key())
        self.assertEqual(parse("Smith, J.").key(), parse("J. Smith").key())
        self.assertNotEqual(parse("Smith, Jane").key(), parse("Smith, Adam").key())


class Correction(unittest.TestCase):
    """What the correction controls of the source editor rely on: every reading can be written back as text that is read exactly, and the readings are described in parts."""

    CASES = ["Gabriel García Márquez", "Ludwig van Beethoven", "van Beethoven,", "Martin Luther King Jr.", "King, Martin Luther, Jr.", "Smith JA", "World Health Organization",
             "Johnson & Johnson", "{Plato}", "Plato", "王 小明", "Ana María de la Cruz", "O'Brien, Sinéad", "Jean-Pierre Dupont", "Bin Laden, Osama", "Smith,"]

    def test_the_canonical_text_of_any_reading_is_read_back_identically_and_is_never_a_guess(self):
        for typed in self.CASES:
            first = parse(typed)
            again = parse(first.canonical())
            self.assertEqual((first.family, first.given, first.suffix, first.literal), (again.family, again.given, again.suffix, again.literal), f"{typed!r} -> {first.canonical()!r}")
            if " " in first.canonical() or first.literal or first.given:
                self.assertIsNone(again.note, f"a confirmed reading carries no note: {first.canonical()!r}")

    def test_a_family_name_with_a_space_and_nothing_else_needs_its_comma(self):
        self.assertEqual(parse("van Beethoven,").canonical(), "van Beethoven,")
        self.assertEqual(parse("van Beethoven,").family, "van Beethoven")

    def test_the_texts_the_editor_writes_are_the_ones_the_server_writes(self):
        import json
        from applications.slai_writer.names import Name
        path = Path(__file__).parent / "fixtures" / "name_canonical.json"
        for c in json.loads(path.read_text(encoding="utf-8"))["cases"]:
            name = Name(family=c["family"], given=c["given"], suffix=c["suffix"], literal=c["literal"])
            self.assertEqual(name.canonical(), c["text"])
            back = parse(c["text"])
            self.assertEqual((back.family, back.given, back.suffix, back.literal), (c["family"], c["given"], c["suffix"], c["literal"]), c["text"])

    def test_describe_gives_the_parts_and_says_whether_it_was_stated(self):
        rows = read_all(["Gabriel García Márquez", "", "  García Márquez, Gabriel ", "{World Health Organization}"])
        self.assertEqual(len(rows), 4, "one answer per line typed")
        self.assertIsNone(rows[1], "a blank line has no reading")
        guess, stated, literal = rows[0], rows[2], rows[3]
        self.assertEqual((guess["family"], guess["given"], guess["stated"]), ("Márquez", "Gabriel García", False))
        self.assertIn("García Márquez, Gabriel", guess["note"])
        self.assertEqual(guess["canonical"], "Márquez, Gabriel García")
        self.assertEqual((stated["family"], stated["given"], stated["stated"], stated["note"], stated["typed"]), ("García Márquez", "Gabriel", True, None, "  García Márquez, Gabriel "), "typed is the line as sent")
        self.assertEqual((literal["literal"], literal["stated"], literal["display"]), (True, True, "World Health Organization"))

    def test_correcting_by_parts_changes_how_it_is_printed_and_cited(self):
        wrong = parse("Gabriel García Márquez")
        right = parse("García Márquez, Gabriel")
        self.assertEqual(wrong.display(), "Márquez, G. G.")
        self.assertEqual(right.display(), "García Márquez, G.")
        self.assertNotEqual(wrong.csl(), right.csl())


class Fallback(unittest.TestCase):
    """The marks and lines Writer prints itself when citeproc-py is not installed (and says so)."""

    def test_in_text_uses_the_family_name_particle_and_institution_included(self):
        self.assertEqual(in_text({"id": "a", "title": "T", "authors": ["Ludwig van Beethoven"], "year": 1801}), "(van Beethoven, 1801)")
        self.assertEqual(in_text({"id": "a", "title": "T", "authors": ["{World Health Organization}"], "year": 2020}), "(World Health Organization, 2020)")
        self.assertEqual(in_text({"id": "a", "title": "T", "organization": "World Health Organization", "year": 2020}), "(World Health Organization, 2020)")
        self.assertEqual(in_text({"id": "a", "title": "T", "authors": ["Smith, Ann", "Jones, Bo"], "year": 2020}), "(Smith & Jones, 2020)")
        self.assertEqual(in_text({"id": "a", "title": "T", "authors": ["Smith, Ann", "Jones, Bo", "Lee, Cy"], "year": 2020}), "(Smith et al., 2020)")

    def test_two_people_with_one_family_name_and_year_are_told_apart_by_initial(self):
        a = {"id": "a", "title": "T", "authors": ["Smith, Jane"], "year": 2020}
        b = {"id": "b", "title": "U", "authors": ["Smith, Adam"], "year": 2020}
        c = {"id": "c", "title": "V", "authors": ["Smith, Adam"], "year": 2019}
        self.assertEqual(in_text(a, [a, b, c]), "(J. Smith, 2020)")
        self.assertEqual(in_text(b, [a, b, c]), "(A. Smith, 2020)")
        self.assertEqual(in_text(c, [a, b, c]), "(Smith, 2019)")
        self.assertEqual(in_text(a, [a]), "(Smith, 2020)")
        same = {"id": "d", "title": "W", "authors": ["Jane Smith"], "year": 2020}
        self.assertEqual(in_text(a, [a, same]), "(Smith, 2020)", "the same person typed differently is not a second person")

    def test_reference_line_prints_the_reading_not_the_raw_text(self):
        line = reference_line({"id": "a", "title": "Roads", "authors": ["Jean-Pierre Dupont", "{World Health Organization}"], "year": 2020})
        self.assertTrue(line.startswith("Dupont, J.-P. & World Health Organization (2020). Roads."), line)
        self.assertNotIn("{", line)

    def test_the_stored_text_is_never_rewritten(self):
        typed = ["Gabriel García Márquez", "Smith JA", "World Health Organization", "  Jane   Smith "]
        entry = clean_entry({"title": "T", "authors": typed})
        self.assertEqual(entry["authors"], [t.strip() for t in typed])                                   # only the outer spaces; no reordering, no braces, no initials


class Disambiguation(unittest.TestCase):
    def test_identical_author_and_year_get_suffixes_whichever_way_the_name_was_typed(self):
        refs = [{"id": "x1", "kind": "citation", "title": "Beta", "authors": ["Smith, Jane"], "year": 2020},
                {"id": "x2", "kind": "citation", "title": "Alpha", "authors": ["Jane Smith"], "year": 2020},
                {"id": "x3", "kind": "citation", "title": "Other", "authors": ["Smith, Adam"], "year": 2020}]
        self.assertEqual(_year_suffixes(refs), {"x2": "a", "x1": "b"})            # Adam Smith is another person: no suffix, and the initial tells them apart

    def test_an_organisation_counts_as_one_author(self):
        refs = [{"id": "o1", "kind": "citation", "title": "B", "organization": "World Health Organization", "year": 2020},
                {"id": "o2", "kind": "citation", "title": "A", "authors": ["{World Health Organization}"], "year": 2020}]
        self.assertEqual(_year_suffixes(refs), {"o2": "a", "o1": "b"})


class Structured(unittest.TestCase):
    def test_csl_carries_every_author_and_editor_as_a_structured_name(self):
        record = csl_source({"id": "k", "title": "T", "authors": ["Ludwig van Beethoven", "{UNESCO}", "King, Martin Luther, Jr."], "editors": ["Jan van der Berg"], "year": 2000})
        self.assertEqual(record["author"], [{"family": "van Beethoven", "given": "Ludwig"}, {"literal": "UNESCO"},
                                            {"family": "King", "given": "Martin Luther", "suffix": "Jr."}])
        self.assertEqual(record["editor"], [{"family": "van der Berg", "given": "Jan"}])


class InTheSourcesList(Workbench):
    """What the person sees, and the manual correction, through the same calls the sources panel makes."""

    def setUp(self):
        super().setUp()
        self.app.preferences = lambda: {"lookup_online": False}
        self.ac = Academic(self.app, fetch=lambda doi: {})
        self.s = self.new_session("blank", title="Names")

    def listed(self, sid):
        return next(x for x in self.ac.sources(self.s)["sources"] if x["id"] == sid)

    def test_an_ambiguous_name_is_flagged_and_correcting_it_removes_the_flag_and_changes_only_that_text(self):
        added = self.ac.put_source(self.s, {"title": "Cien años de soledad", "authors": ["Gabriel García Márquez"], "year": "1967", "publisher": "Sudamericana"})
        sid = added["id"]
        before = self.listed(sid)
        self.assertEqual(before["data"]["authors"], ["Gabriel García Márquez"], "stored as typed")
        self.assertTrue(any("García Márquez, Gabriel" in p for p in before["problems"]), before["problems"])
        self.assertEqual(before["inText"], "(Márquez, 1967)", "the legacy mark uses the reading until the person corrects it")
        self.ac.put_source(self.s, {"title": "Cien años de soledad", "authors": ["García Márquez, Gabriel"], "year": "1967", "publisher": "Sudamericana"}, source_id=sid)
        after = self.listed(sid)
        self.assertEqual(after["data"]["authors"], ["García Márquez, Gabriel"])
        self.assertFalse(any("García" in p for p in after["problems"]), after["problems"])
        self.assertEqual(after["inText"], "(García Márquez, 1967)")

    def test_an_organisation_source_has_an_author_and_no_missing_author_warning(self):
        sid = self.ac.put_source(self.s, {"title": "Report", "authors": [], "year": "2020", "publisher": "WHO"})["id"]
        self.assertTrue(any("No author" in p for p in self.listed(sid)["problems"]))
        ref = next(r for r in self.s.doc["references"] if r["id"] == sid)
        self.assertEqual(Academic._problems({**ref, "organization": "World Health Organization"}).count("No author is recorded."), 0)


if __name__ == "__main__":
    unittest.main()
