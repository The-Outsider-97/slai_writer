"""Writer's proofreading layer: the false positives of the 16 November screenshot, the rules, the verification of provider findings, the normaliser,
the integration with Assist (ignores, dictionaries, language), and the measured quality on the curated corpus."""
from __future__ import annotations

import types
import unittest
from pathlib import Path

from applications.slai_writer import proofing as P
from applications.slai_writer.app import WriterApp as App
from applications.slai_writer.assist import Assist
from applications.slai_writer.tests import proofing_corpus as C
from applications.slai_writer.tests import proofing_eval as E
from applications.slai_writer.tests.helpers import Workbench

ROOT = Path(__file__).resolve().parents[3]
HAVE_LIST = (ROOT / "src" / "agents" / "language" / "library" / "wordlist_en.json").is_file()
needs_list = unittest.skipUnless(HAVE_LIST, "SLAI's English word list is not installed here")


def check(text, *, language="en-US", block_type="paragraph", kinds=("spelling", "grammar", "style"), pr=None, **kw):
    pr = pr or P.Proofreader(slai_root=ROOT)
    return pr.check([("b", text, block_type)], language=language, kinds=kinds, **kw)


def marked(result):
    return [(i["text"], i["rule"]) for i in result.issues]


@needs_list
class ScreenshotCases(unittest.TestCase):
    """The three false positives on the screenshot, and the page they came from."""

    def test_timeline_is_a_word(self):
        for kind in ("heading", "paragraph"):
            self.assertEqual(marked(check("Timeline", block_type=kind)), [])
        self.assertEqual(marked(check("The timeline for the project is fixed.")), [])

    def test_convinced_has_no_agreement_error(self):
        self.assertEqual(marked(check("Convinced that the council would act, Yarla waited.")), [])

    def test_lone_a_is_not_an_article_error(self):
        self.assertEqual(marked(check("Plan a is cheaper than plan b, and section a comes first.")), [])
        self.assertEqual(marked(check("Options: (a) wait, (b) leave.")), [])

    def test_the_page_from_the_screenshot_is_clean(self):
        blocks = [("h1", "Premise", "heading"), ("h2", "Timeline", "heading"), ("h3", "Vol I", "heading"), ("h4", "Vol II", "heading"), ("h5", "Vol III", "heading"),
                  ("p1", "Timeline of the Yarla Accord, as told by Abiarra to the WTPA.", "paragraph"),
                  ("p2", "Convinced that the WTPA would act, Abiarra waited. Yarla said nothing.", "paragraph")]
        r = P.Proofreader(slai_root=ROOT).check(blocks, language="en-US", kinds=("spelling", "grammar", "style"))
        self.assertEqual(r.issues, [])

    def test_unknown_names_are_not_typos_but_a_real_typo_beside_them_is(self):
        r = check("Abiarra and Yarla signed the acord with Quillfeather.")
        self.assertEqual([i["text"] for i in r.issues], ["acord"])

    def test_the_old_pipeline_showed_all_of_them_and_the_new_one_shows_none(self):
        # What SLAI's checkers returned for the screenshot, passed through Writer 2.3's filter (confidence >= 0.8, a replacement, a changed range) ...
        for raw in C.SLAI_GRAMMAR_OBSERVED:
            self.assertGreaterEqual(raw["confidence"], 0.8)
            self.assertTrue(raw["replacement"].strip() and raw["replacement"] != raw["text"])
        # ... and through the new verification:
        lex = P.Proofreader(slai_root=ROOT).lexicon("en")
        text = "Convinced that the council would act."
        raw = {"block": "b", "start": 0, "end": 9, "replacement": "Convinceds", "rule": "subject_verb_agreement", "message": "Potential subject-verb agreement error with 'Convinced'.", "confidence": 0.82}
        self.assertIsNone(P.verify_provider_issue(raw, text, lex))
        text = "Plan a a priori."
        raw = {"block": "b", "start": 5, "end": 6, "replacement": "an", "rule": "article", "message": "Incorrect article: 'a' is unlikely before 'a'.", "confidence": 0.9}
        self.assertIsNone(P.verify_provider_issue(raw, text, lex))


class ArticleSounds(unittest.TestCase):
    def test_vowel_sound_table(self):
        yes = ["apple", "hour", "honest", "heir", "umbrella", "unimportant", "urgent", "usher", "FBI", "MRI", "NGO", "SQL", "8", "11th", "18-year", "X-ray", "iPhone".lower(), "ox"]
        no = ["unicorn", "university", "user", "European", "one-time", "once", "house", "NASA", "UNESCO", "WTPA", "100", "uniform", "unit", "useful", "ubiquitous", "Utopia"]
        for w in yes:
            self.assertTrue(P.vowel_sound(w), w)
        for w in no:
            self.assertFalse(P.vowel_sound(w), w)

    def test_unknown_is_none_not_a_guess(self):
        for w in ("SLAI", "HttpOnly", "iPhone", "hotel", "herb", "1800", "$5", ""):
            self.assertIsNone(P.vowel_sound(w), w)


class Rules(unittest.TestCase):
    def rules(self, text, language="en"):
        return [(i.text, i.replacements[0] if i.replacements else None, i.rule) for i in P.grammar_rules(text, "b", language=language)]

    def test_articles(self):
        self.assertEqual(self.rules("an unique chance"), [("an", "a", "article-a-an")])
        self.assertEqual(self.rules("a hour later"), [("a", "an", "article-a-an")])
        self.assertEqual(self.rules("a MRI scan"), [("a", "an", "article-a-an")])
        self.assertEqual(self.rules("an NGO and a URL"), [])
        self.assertEqual(self.rules("a is the first letter"), [])

    def test_repeated_words_but_not_had_had(self):
        self.assertEqual(self.rules("This is the the end."), [("the the", "the", "repeated-word")])
        self.assertEqual(self.rules("She had had enough, and he knew that that was true."), [])

    def test_agreement_with_pronouns(self):
        self.assertEqual(self.rules("He go home."), [("go", "goes", "subject-verb")])
        self.assertEqual(self.rules("They was late."), [("was", "were", "subject-verb")])
        self.assertEqual(self.rules("It don't work."), [("don't", "doesn't", "subject-verb")])
        for fine in ("Let it go.", "Make it work.", "It is essential that he go now.", "In the middle of it start the notes.", "We cut it, she cut it, and it fit."):
            self.assertEqual(self.rules(fine), [], fine)

    def test_verb_forms(self):
        self.assertEqual(self.rules("She can goes now."), [("goes", "go", "verb-form")])
        self.assertEqual(self.rules("They have went away."), [("went", "gone", "participle")])
        self.assertEqual(self.rules("You should of known."), [("should of", "should have", "modal-of")])

    def test_tense_only_with_a_past_time_word(self):
        self.assertEqual(self.rules("Yesterday I walk to the shop."), [("walk", "walked", "tense")])
        self.assertEqual(self.rules("I walk to the shop every day."), [])
        self.assertEqual(self.rules("Yesterday we walked and she took the train."), [])

    def test_confusions(self):
        self.assertEqual(self.rules("Their is a problem."), [("Their is", "There is", "there-their")])
        self.assertEqual(self.rules("I think its a good plan."), [("its", "it's", "its-it's")])
        self.assertEqual(self.rules("This is better then that."), [("then", "than", "than-then")])
        self.assertEqual(self.rules("Its purpose is simple and it's clear."), [])

    def test_punctuation_and_capitals(self):
        self.assertEqual(self.rules("Hello,world."), [(",", ", ", "space-after-comma")])
        self.assertEqual(self.rules("He left , then."), [(" ,", ",", "space-before-punctuation")])
        self.assertEqual(self.rules("We left.Then it rained."), [(".", ". ", "space-after-period")])
        self.assertEqual(self.rules("Yesterday i went."), [("i", "I", "pronoun-i")])
        self.assertEqual(self.rules("It is. then we left."), [("then", "Then", "sentence-capital")])
        for fine in ("Dr. Smith met Mr. Jones e.g. at five.", "See example.com and report.docx.", "Vol i is short.", "(i) first, (ii) second"):
            self.assertEqual(self.rules(fine), [], fine)

    def test_english_rules_do_not_run_on_dutch(self):
        self.assertEqual(self.rules("Het is een goede dag, en ik ga naar de markt.", "nl"), [])

    def test_dutch(self):
        self.assertEqual(self.rules("Hij word morgen gebeld.", "nl"), [("word", "wordt", "nl-subject-verb")])
        self.assertEqual(self.rules("Ik wordt blij.", "nl"), [("wordt", "word", "nl-subject-verb")])
        self.assertEqual(self.rules("Dit is groter als dat.", "nl"), [("als", "dan", "nl-dan-als")])
        for fine in ("Zij heeft gelijk en ze hebben tijd.", "Je kan het doen.", "Ik hoor het gaan.", "In de zomer als het warm is."):
            self.assertEqual(self.rules(fine, "nl"), [], fine)


@needs_list
class Spelling(unittest.TestCase):
    def test_suggestions_are_words_and_ranked(self):
        lex = P.Proofreader(slai_root=ROOT).lexicon("en")
        for typo, want in (("recieve", "receive"), ("definately", "definitely"), ("seperate", "separate"), ("tommorow", "tomorrow"), ("teh", "the")):
            sug = lex.suggest(typo)
            self.assertEqual(sug[0], want, typo)
            self.assertTrue(all(lex.known(s) for s in sug), sug)
        self.assertEqual(lex.suggest("wich")[0], "which")

    def test_typos_that_slai_lists_as_words_are_caught(self):
        for typo in ("wich", "accomodate", "wierd", "untill", "enviroment"):
            self.assertTrue(marked(check(f"This is {typo} here.")), typo)

    def test_inflections_the_list_lacks_are_words(self):
        for ok in ("prioritizes", "rasterised", "serialises", "organiser", "unembedded", "tooltip", "stopped", "co-author"):
            self.assertEqual(marked(check(f"They {ok} it.", kinds=("spelling",))), [], ok)
        for bad in ("occured", "begining", "writting"):
            self.assertTrue(marked(check(f"They {bad} it.", kinds=("spelling",))), bad)

    def test_names_terms_and_headings(self):
        self.assertEqual(marked(check("Then Marlowe met Quillfeather at Brightwater Bay.", kinds=("spelling",))), [])
        self.assertEqual(marked(check("Brightwater Bay", block_type="heading", kinds=("spelling",))), [])
        # an unknown lower-case word used three times is the document's own terminology
        blocks = [(f"b{n}", "The glorpt arrived.", "paragraph") for n in range(3)]
        self.assertEqual(P.Proofreader(slai_root=ROOT).check(blocks, language="en", kinds=("spelling",)).issues, [])
        self.assertEqual(len(P.Proofreader(slai_root=ROOT).check(blocks[:1], language="en", kinds=("spelling",)).issues), 1)

    def test_locale_variants_only_when_the_document_says_which(self):
        self.assertEqual(marked(check("The colour of the programme.", language="en", kinds=("spelling",))), [])
        self.assertEqual([i[0] for i in marked(check("The colour of the organisation.", language="en-US", kinds=("spelling",)))], ["colour", "organisation"])
        self.assertEqual([i[0] for i in marked(check("The color of the organization.", language="en-GB", kinds=("spelling",)))], ["color", "organization"])

    def test_user_words_and_ignores(self):
        self.assertTrue(marked(check("A zorbleflax appeared.", kinds=("spelling",))))
        self.assertEqual(marked(check("A zorbleflax appeared.", kinds=("spelling",), known_words=["Zorbleflax"])), [])
        self.assertEqual(marked(check("He go home.", kinds=("grammar",), ignore_rules=["subject-verb|go"])), [])

    def test_urls_and_identifiers_are_left_alone(self):
        t = "See https://example.com/qzx and mail info@qzx.example about db_cache, getElementById and report.docx."
        self.assertEqual(marked(check(t, kinds=("spelling",))), [])


class Normaliser(unittest.TestCase):
    def issue(self, start, end, **kw):
        text = "The quick brown fox"
        base = dict(block="b", start=start, end=end, text=text[start:end], kind="grammar", category="grammar", rule="r", message="m", replacements=["x"], confidence=0.9)
        base.update(kw)
        return P.Issue(**base)

    def test_drops_invalid_unchanged_and_weak(self):
        text = "The quick brown fox"
        out = P.normalise([self.issue(0, 3), self.issue(0, 3, replacements=["The"], rule="same"), self.issue(4, 9, confidence=0.3, rule="weak"),
                           self.issue(10, 99, rule="range"), self.issue(10, 15, text="WRONG", rule="stale")], text, lex=None)
        self.assertEqual([(i.start, i.end) for i in out], [(0, 3)])

    def test_overlaps_keep_the_stronger_and_style_yields(self):
        text = "The quick brown fox"
        a = self.issue(4, 9, kind="style", category="style", rule="s")
        b = self.issue(4, 9, rule="g", confidence=0.7)
        self.assertEqual([i.rule for i in P.normalise([a, b], text, lex=None)], ["g"])
        c = self.issue(4, 9, rule="g", provider="SLAI grammar processor")
        merged = P.normalise([b, c], text, lex=None)
        self.assertEqual(len(merged), 1)
        self.assertIn("SLAI grammar processor", merged[0].provider)

    def test_public_shape_has_everything_the_panel_needs(self):
        pub = self.issue(4, 9).public("The quick brown fox")
        for key in ("id", "kind", "category", "block", "start", "end", "text", "message", "suggestions", "replacement", "severity", "confidence", "rule", "provider"):
            self.assertIn(key, pub)
        self.assertEqual(pub["id"], self.issue(4, 9).public("The quick brown fox")["id"])             # stable, so Ignore once survives a recheck


class NoProviders(unittest.TestCase):
    def test_writer_rules_run_without_slai_and_the_spelling_gap_is_explained(self):
        r = P.Proofreader(slai_root=None).check([("b", "The the cat. He go.", "paragraph")], language="en", kinds=("spelling", "grammar"))
        self.assertEqual(sorted(i["rule"] for i in r.issues), ["repeated-word", "subject-verb"])
        self.assertIn("No word list", r.reason or "")

    def test_a_language_without_a_list_says_so(self):
        r = P.Proofreader(slai_root=ROOT).check([("b", "Hallo daar, dit is een zin die genoeg woorden bevat.", "paragraph")], language="nl", kinds=("spelling",))
        self.assertFalse(r.available)
        self.assertIn("NL", r.reason or "")

    def test_text_in_another_language_than_the_document_is_skipped_not_marked(self):
        r = P.Proofreader(slai_root=ROOT).check([("b", "Het is een mooie dag en we gaan naar de markt met alle kinderen.", "paragraph")], language="en", kinds=("spelling", "grammar"))
        self.assertEqual(r.issues, [])
        self.assertEqual(len(r.skipped), 1)


class CuratedCorpus(unittest.TestCase):
    """Measured, not asserted by eye: thresholds below are the numbers recorded in docs/PROOFING_V24.md. They only ratchet up."""

    @classmethod
    def setUpClass(cls):
        if not HAVE_LIST:
            raise unittest.SkipTest("SLAI's English word list is not installed here")
        cls.after = E.run_after()

    def test_no_false_positives_on_clean_text(self):
        self.assertEqual(self.after["false_positives"], 0, self.after["fp_detail"])

    def test_recall_and_suggestion_quality(self):
        self.assertEqual(self.after["hits"], self.after["errors"], self.after["misses"])
        self.assertGreaterEqual(self.after["top1"], 51)
        self.assertGreaterEqual(self.after["top3"], 52)

    def test_better_than_writer_2_3_on_spelling(self):
        before = E.run_before()
        if before is None:
            self.skipTest("no recorded baseline")
        self.assertGreaterEqual(before["false_positives"], 15)                     # the recorded 2.3 numbers: names, contractions, 'timeline', file names
        self.assertGreater(before["false_positives"], self.after["false_positives"])
        self.assertLess(before["hits"], before["spelling_errors"])                  # 2.3 missed typos that SLAI's list holds as words
        spelling = [e for e in C.ERRORS if e[3] == "spelling"]
        self.assertEqual(len(spelling), before["spelling_errors"])


@needs_list
class AssistIntegration(Workbench):
    def setUp(self):
        super().setUp()
        self.app.root = ROOT
        self.app.settings.data_dir = self.root / "data"
        self.app.user_dictionary = lambda: App.user_dictionary(self.app)
        self.app.add_user_word = lambda w: App.add_user_word(self.app, w)

    def assist(self):
        lex = P.Proofreader(slai_root=ROOT).lexicon("en")           # a stand-in for SLAI's checker that knows what the shared word list knows
        return Assist(self.app, spell_factory=lambda: types.SimpleNamespace(language="en", check=lambda w: types.SimpleNamespace(is_correct=lex.has(w), checkable=True, suggestions=[])))

    def test_one_pass_returns_categories_and_providers(self):
        s = self.new_session(text="The the cat recieve a letter. He go.")
        out = self.assist().proofread(s, ("spelling", "grammar"))
        self.assertTrue(out["available"])
        self.assertEqual({i["category"] for i in out["issues"]}, {"spelling", "grammar", "agreement"})
        out = self.assist().proofread(s, ("spelling",))
        self.assertEqual([i["text"] for i in out["issues"]], ["recieve"])
        self.assertIn("Writer dictionary", out["providers"])

    def test_blocks_restrict_the_check(self):
        s = self.new_session(text="He go.")
        self.assertEqual(self.assist().proofread(s, ("grammar",), ["no-such-block"])["issues"], [])

    def test_ignore_all_for_grammar_persists_in_the_document(self):
        s = self.new_session(text="He go home.")
        a = self.assist()
        self.assertEqual(len(a.grammar(s)["issues"]), 1)
        s.apply({"op": "ext_set", "values": {"proof_ignore": ["subject-verb|go"]}}, None)
        self.assertEqual(a.grammar(s)["issues"], [])
        with self.assertRaises(Exception):
            s.apply({"op": "ext_set", "values": {"proof_ignore": [1]}}, None)

    def test_document_and_user_dictionaries(self):
        s = self.new_session(text="A zorbleflax and a frumbleton.")
        a = self.assist()
        self.assertEqual(len(a.spelling(s)["issues"]), 2)
        a.add_to_dictionary(s, "zorbleflax")
        self.assertEqual([i["text"] for i in a.spelling(s)["issues"]], ["frumbleton"])
        a.add_to_dictionary(s, "frumbleton", scope="user")
        self.assertEqual(a.spelling(s)["issues"], [])
        other = self.new_session(name="other", text="A frumbleton.")
        self.assertEqual(a.spelling(other)["issues"], [])                       # the user's dictionary follows the person to other documents

    def test_language_override_and_the_document_language(self):
        s = self.new_session(text="The colour of the programme.")
        a = self.assist()
        self.assertEqual(a.spelling(s)["issues"], [])
        self.assertEqual(len(a.spelling(s, language="en-US")["issues"]), 2)
        s.apply({"op": "meta", "set": {"language": "en-GB"}}, None)
        self.assertEqual(a.spelling(s)["issues"], [])
        s.apply({"op": "meta", "set": {"language": "fr"}}, None)
        out = a.proofread(s)
        self.assertFalse(out["available"])
        self.assertEqual(out["issues"], [])

    def test_results_are_for_the_version_asked_about(self):
        s = self.new_session(text="He go.")
        out = self.assist().grammar(s)
        self.assertEqual(out["version"], s.version)


if __name__ == "__main__":
    unittest.main()
