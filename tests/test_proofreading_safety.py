"""Proofreading must fail safely rather than underline normal prose with a tiny dictionary."""
from __future__ import annotations

import types
import unittest

from applications.tools.errors import DependencyMissing
from applications.slai_writer.assist import Assist
from applications.slai_writer.tests.helpers import Workbench


class ProofreadingSafety(Workbench):
    def test_missing_core_dictionary_disables_spelling_instead_of_mass_marking(self):
        class SeedOnly:
            language = "en"

            def stats(self):
                return types.SimpleNamespace(word_count=33)

        checker = Assist(self.app, spell_factory=SeedOnly)
        with self.assertRaises(DependencyMissing) as failure:
            checker.spelling(self.new_session(text="The component shows relationships."))
        self.assertIn("dictionary was not loaded", str(failure.exception))

    def test_nonstatistical_test_checker_still_uses_existing_public_contract(self):
        class ContractChecker:
            language = "en"

            def check(self, word):
                return types.SimpleNamespace(is_correct=word.lower() != "diagramm", checkable=True,
                                             suggestions=[types.SimpleNamespace(word="diagram")])

        checker = Assist(self.app, spell_factory=ContractChecker)
        result = checker.spelling(self.new_session(text="The diagramm shows a diagram."))
        self.assertEqual([x["text"] for x in result["issues"]], ["diagramm"])
        self.assertEqual(result["issues"][0]["suggestions"], ["diagram"])

    def test_grammar_filters_low_confidence_style_and_duplicate_diagnostics(self):
        make = lambda start, end, confidence, replacement: types.SimpleNamespace(
            source_text_char_span=(start, end), confidence=confidence, replacement=replacement,
            description="Agreement", suggestion="are", severity="error", rule_id="agreement", code="G1")
        agent = types.SimpleNamespace(
            nlp_engine=types.SimpleNamespace(analyze_text=lambda text: types.SimpleNamespace(tokens=[text], dependencies=[])),
            grammar_processor=types.SimpleNamespace(analyze_tokens=lambda *args, **kwargs: types.SimpleNamespace(
                issues=[make(15, 16, 0.97, "are"), make(15, 16, 0.97, "are"), make(0, 2, 0.35, "These")])))

        class Gateway:
            def call(self, name, operation, timeout):
                return operation(agent)

        self.app.preferences = lambda: {"ai_enabled": True, "ai_budget": 8000}
        checker = Assist(self.app, gateway=Gateway())
        checker._gate = lambda session, text: None  # type: ignore[method-assign] - no external agent in this unit test
        result = checker.grammar(self.new_session(text="The components is connected."))
        self.assertEqual(len(result["issues"]), 1)
        self.assertEqual(result["issues"][0]["rule"], "agreement")


if __name__ == "__main__":
    unittest.main()
