"""The parts of the APA 7 engine that are ours, not citeproc-py's: how a typed author name becomes CSL-JSON, and how a parenthetical citation the CSL style
produced becomes a narrative one. They need no citeproc-py, so they run everywhere; the rendering itself (punctuation, ordering, et al.) is the bundled
CSL style's, and test_academic exercises it where citeproc-py is installed."""
import unittest

from applications.slai_writer.citation_engine import CitationEngine, csl_source, _person

narrative = CitationEngine.narrative


class Names(unittest.TestCase):
    def test_family_comma_given_is_read_as_written(self):
        self.assertEqual(_person("Smith, J. A."), {"family": "Smith", "given": "J. A."})

    def test_given_family_takes_the_last_word_as_the_family_name(self):
        self.assertEqual(_person("Jane Smith"), {"family": "Smith", "given": "Jane"})
        self.assertEqual(_person("Plato"), {"family": "Plato"})

    def test_a_particle_stays_with_the_family_name_which_APA_files_under_it(self):
        self.assertEqual(_person("Ludwig van Beethoven"), {"family": "van Beethoven", "given": "Ludwig"})
        self.assertEqual(_person("Ana de la Cruz"), {"family": "de la Cruz", "given": "Ana"})
        self.assertEqual(_person("Ursula K. Le Guin"), {"family": "Le Guin", "given": "Ursula K."})

    def test_a_first_name_that_looks_like_a_particle_is_still_a_first_name(self):
        self.assertEqual(_person("Al Gore"), {"family": "Gore", "given": "Al"})

    def test_a_generational_suffix_is_not_the_family_name(self):
        self.assertEqual(_person("Martin Luther King Jr."), {"family": "King", "given": "Martin Luther", "suffix": "Jr."})
        self.assertEqual(_person("King, Martin Luther, Jr."), {"family": "King", "given": "Martin Luther", "suffix": "Jr."})

    def test_a_source_carries_its_authors_and_date_into_csl(self):
        record = csl_source({"id": "k", "title": "T", "authors": ["Ludwig van Beethoven", "Smith, J."], "published": "2020-03", "container": "J", "volume": "4"})
        self.assertEqual(record["author"][0], {"family": "van Beethoven", "given": "Ludwig"})
        self.assertEqual(record["issued"], {"date-parts": [[2020, 3]]})
        self.assertEqual((record["type"], record["container-title"], record["volume"]), ("article-journal", "J", "4"))


class Narrative(unittest.TestCase):
    def test_single_author_pair_and_et_al(self):
        self.assertEqual(narrative("(Smith, 2020)"), "Smith (2020)")
        self.assertEqual(narrative("(Smith & Jones, 2020)"), "Smith and Jones (2020)")
        self.assertEqual(narrative("(Smith et al., 2020)"), "Smith et al. (2020)")

    def test_a_locator_stays_inside_the_brackets_with_the_year(self):
        self.assertEqual(narrative("(Smith & Jones, 2020, p. 5)"), "Smith and Jones (2020, p. 5)")

    def test_several_years_by_one_author_and_year_suffixes_are_kept(self):
        self.assertEqual(narrative("(Smith, 2019, 2020)"), "Smith (2019, 2020)")
        self.assertEqual(narrative("(Smith, 2020a, 2020b)"), "Smith (2020a, 2020b)")

    def test_no_date_and_in_press(self):
        self.assertEqual(narrative("(Smith, n.d.)"), "Smith (n.d.)")
        self.assertEqual(narrative("(Smith, in press)"), "Smith (in press)")

    def test_a_group_of_sources_is_one_narrative_citation_per_source(self):
        self.assertEqual(narrative("(Jones, 2021; Smith, 2020)"), "Jones (2021) and Smith (2020)")
        self.assertEqual(narrative("(Smith, 2019, 2020; Jones, 2021)"), "Smith (2019, 2020) and Jones (2021)")
        self.assertEqual(narrative("(A, 2019; B, 2020; C, 2021)"), "A (2019), B (2020), and C (2021)")

    def test_a_name_with_a_comma_in_it_is_not_split_at_that_comma(self):
        self.assertEqual(narrative("(University of California, Berkeley, 2020)"), "University of California, Berkeley (2020)")
        self.assertEqual(narrative("(American Psychological Association [APA], 2020)"), "American Psychological Association [APA] (2020)")

    def test_an_ampersand_inside_an_organization_name_is_kept(self):
        self.assertEqual(narrative("(Johnson & Johnson, 2019)", ["Johnson & Johnson"]), "Johnson & Johnson (2019)")
        self.assertEqual(narrative("(Smith & Jones, 2019)", ["Johnson & Johnson"]), "Smith and Jones (2019)")

    def test_text_that_cannot_be_split_reliably_comes_back_unchanged(self):
        for mark in ("Smith 2020", "(nothing recognisable)", "", "(Smith)"):
            self.assertEqual(narrative(mark), mark)


class Through(unittest.TestCase):
    def test_cite_applies_it_to_what_the_style_returned(self):
        engine = object.__new__(CitationEngine)
        engine.references = [{"id": "a", "kind": "citation", "organization": "Johnson & Johnson"}]
        engine.groups = ["g"]
        engine.bib = type("Bib", (), {"cite": staticmethod(lambda group, warn: "(<i>Jones</i> &amp; Smith, 2021; Lee, 2020)")})()
        self.assertEqual(engine.cite(0, narrative=True), "Jones and Smith (2021) and Lee (2020)")
        self.assertEqual(engine.cite(0), "(Jones & Smith, 2021; Lee, 2020)")


if __name__ == "__main__":
    unittest.main()
