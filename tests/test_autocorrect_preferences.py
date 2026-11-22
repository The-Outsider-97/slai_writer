"""The five AutoCorrect & AutoFormat settings: their names and defaults, that they are validated, that they persist across a restart, and that an older
preferences file (without them) gets the defaults."""
import json
import tempfile
import unittest
from pathlib import Path

from applications.slai_writer.preferences import PREF_DEFAULTS, PREF_SCHEMA
from applications.tools.storage import Prefs

KEYS = ("autocorrect_capitalize", "autocorrect_dash", "autocorrect_rule", "autocorrect_regions", "autocorrect_paste")


class AutoCorrectPreferences(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "prefs.json"

    def test_the_defaults_are_the_specified_ones(self):
        self.assertEqual({k: PREF_DEFAULTS[k] for k in KEYS},
                         {"autocorrect_capitalize": True, "autocorrect_dash": True, "autocorrect_rule": True, "autocorrect_regions": True, "autocorrect_paste": False})

    def test_every_default_passes_its_own_validation(self):
        for key in KEYS:
            self.assertEqual(PREF_SCHEMA[key].check(PREF_DEFAULTS[key]), PREF_DEFAULTS[key])

    def test_only_true_or_false_is_accepted(self):
        for key in KEYS:
            for bad in ("yes", 1, None, "true"):
                with self.assertRaises(ValueError, msg=f"{key}={bad!r}"):
                    PREF_SCHEMA[key].check(bad)

    def test_a_change_is_saved_and_read_back_after_a_restart(self):
        prefs = Prefs(self.path, PREF_SCHEMA)
        prefs.update({"autocorrect_capitalize": False, "autocorrect_paste": True})
        again = Prefs(self.path, PREF_SCHEMA)
        self.assertIs(again.data["autocorrect_capitalize"], False)
        self.assertIs(again.data["autocorrect_paste"], True)
        self.assertNotIn("autocorrect_dash", again.data, "what was not changed is not stored: the default applies")

    def test_an_older_preferences_file_is_still_read(self):
        self.path.write_text(json.dumps({"theme": "dark", "spell": False}), encoding="utf-8")
        prefs = Prefs(self.path, PREF_SCHEMA)
        self.assertIsNone(prefs.recovered)
        self.assertEqual(prefs.data["theme"], "dark")

    def test_a_wrong_value_in_the_file_is_dropped_not_trusted(self):
        self.path.write_text(json.dumps({"autocorrect_dash": "maybe", "autocorrect_rule": False}), encoding="utf-8")
        prefs = Prefs(self.path, PREF_SCHEMA)
        self.assertNotIn("autocorrect_dash", prefs.data)
        self.assertIs(prefs.data["autocorrect_rule"], False)


if __name__ == "__main__":
    unittest.main()
