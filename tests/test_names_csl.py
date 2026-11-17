"""Author names through the real APA 7 CSL style (citeproc-py and the bundled upstream apa.csl), the one rendering the offline tests cannot reach.

Multilingual and compound names, particles, generational suffixes, institutions, and two authors who share a family name: what Writer reads from the typed text
(names.py) is handed to the style as structured CSL-JSON and the printed result is checked here. The expectations are APA 7's rules stated loosely enough that
they do not depend on citeproc-py's punctuation details: what must hold is which part is the family name, what is an initial, what stays whole, and that two
different authors never print as the same citation.

These tests need citeproc-py. Where it is not installed they skip on a developer's machine and **fail under SLAI_REQUIRE_INTEGRATION=1** (docs/INTEGRATION_GATE.md),
so the CI gate runs them on Windows and Linux. They were NOT run in the build environment of 2026-11-17 (citeproc-py could not be installed there).
"""
from __future__ import annotations

import importlib.util
import unittest

from applications.slai_writer.citation_engine import CitationEngine
from . import independent


def ref(rid, title, authors, year, kind="book", **more):
    return {"id": rid, "kind": "citation", "title": title, "authors": authors, "year": year, "source_type": kind, "publisher": "Press", **more}


class Names(unittest.TestCase):
    def setUp(self):
        independent.need(self, "citeproc-py", importlib.util.find_spec("citeproc") is not None, "pip install citeproc-py")

    def render(self, *refs):
        engine = CitationEngine(refs)
        marks = {r["id"]: engine.cite(engine.register([r["id"]])) for r in refs}
        lines = {sid: text for sid, text, _ in engine.bibliography()}
        return marks, {k.casefold(): v for k, v in lines.items()}

    def test_a_name_written_family_comma_given_is_taken_exactly(self):
        marks, lines = self.render(ref("a", "Cien años de soledad", ["García Márquez, Gabriel"], 1967))
        self.assertEqual(marks["a"], "(García Márquez, 1967)")
        self.assertTrue(lines["a"].startswith("García Márquez, G."), lines["a"])

    def test_the_same_name_typed_without_a_comma_is_a_reading_and_the_difference_is_visible(self):
        marks, lines = self.render(ref("a", "Cien años de soledad", ["Gabriel García Márquez"], 1967))
        self.assertEqual(marks["a"], "(Márquez, 1967)", "the last word is the family name until the person says otherwise")
        self.assertTrue(lines["a"].startswith("Márquez, G. G."), lines["a"])

    def test_a_particle_stays_with_the_family_name(self):
        marks, lines = self.render(ref("b", "Symphonies", ["Ludwig van Beethoven"], 1801))
        self.assertEqual(marks["b"], "(van Beethoven, 1801)")
        self.assertTrue(lines["b"].startswith("van Beethoven, L."), lines["b"])

    def test_a_generational_suffix_follows_the_initials_and_is_not_the_family_name(self):
        marks, lines = self.render(ref("c", "Why we can't wait", ["Martin Luther King Jr."], 1964))
        self.assertEqual(marks["c"], "(King, 1964)")
        self.assertIn("King, M. L.", lines["c"])
        self.assertIn("Jr.", lines["c"].split("(")[0])

    def test_an_institution_is_printed_whole_in_both_places(self):
        marks, lines = self.render(ref("d", "Global report", ["{World Health Organization}"], 2020, "report"))
        self.assertEqual(marks["d"], "(World Health Organization, 2020)")
        self.assertTrue(lines["d"].startswith("World Health Organization"), lines["d"])
        self.assertNotIn("W. H. O.", lines["d"])

    def test_a_name_in_another_script_is_not_cut_into_initials_of_letters_that_are_not_there(self):
        marks, lines = self.render(ref("e", "示例", ["王, 小明"], 2018))
        self.assertIn("王", marks["e"])
        self.assertTrue(lines["e"].startswith("王"), lines["e"])

    def test_two_authors_with_one_family_name_never_print_as_the_same_citation(self):
        marks, lines = self.render(ref("f", "First work", ["Smith, Jane"], 2020, "article-journal", container="Journal"),
                                   ref("g", "Second work", ["Smith, Adam"], 2020, "article-journal", container="Journal"))
        self.assertNotEqual(marks["f"], marks["g"], f"{marks} : two different people must be told apart (by initials or a year letter)")

    def test_the_same_person_typed_three_ways_is_one_author_and_gets_year_letters(self):
        marks, _ = self.render(ref("h", "Alpha", ["Smith, Jane"], 2021), ref("i", "Beta", ["Jane Smith"], 2021))
        self.assertEqual(sorted(marks.values()), ["(Smith, 2021a)", "(Smith, 2021b)"])


if __name__ == "__main__":
    unittest.main()
