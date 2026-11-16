"""The table style gallery: 12 looks, options, accent colours, and agreement between the server resolver and the browser one (golden file)."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from applications.slai_writer import table_styles as ts
from applications.slai_writer.tableops import BORDERS_KEY, CELLS_KEY, STYLE_KEY

GOLDEN = Path(__file__).parent / "fixtures" / "table_style_golden.json"
ROOT = Path(__file__).resolve().parent.parent
GALLERY = ["plain", "simple_grid", "minimal_borders", "horizontal_rules", "header_emphasis", "alternating_rows", "alternating_columns",
           "professional_report", "academic", "financial", "modern_accent", "dark_header"]


def table(rows=5, columns=4, header=1, merges=True):
    grid = [[{"text": f"{r}{c}"} for c in range(columns)] for r in range(rows)]
    if merges:
        grid[2][1] = {"text": "m", "colspan": 2, "rowspan": 2}
        del grid[2][2]
        del grid[3][1:3]
    return {"columns": columns, "header_rows": header, "rows": grid}


def cases():
    out = {}
    for preset in ["default", *GALLERY]:
        out[preset] = {"type": "table", "table": table(), "extensions": {STYLE_KEY: {"preset": preset}}}
    out["accent"] = {"type": "table", "table": table(), "extensions": {STYLE_KEY: {"preset": "professional_report", "accent": "#C0392B"}}}
    out["options_off"] = {"type": "table", "table": table(), "extensions": {STYLE_KEY: {"preset": "alternating_rows", "header_row": False, "banded_rows": False}}}
    out["options_on"] = {"type": "table", "table": table(), "extensions": {STYLE_KEY: {"preset": "plain", "header_row": True, "first_column": True, "banded_rows": True, "banded_columns": True, "accent": "#117733"}}}
    out["by_hand"] = {"type": "table", "table": table(), "extensions": {
        STYLE_KEY: {"preset": "simple_grid"}, CELLS_KEY: {"1,0": {"background": "#ffee00"}},
        BORDERS_KEY: {"h": {"0,0": {"color": "#FF0000", "width_pt": 2, "style": "dashed"}, "1,1": None}, "v": {"2,0": {"color": "#00FF00", "width_pt": 1, "style": "dotted"}}}}}
    out["legacy"] = {"type": "table", "table": table(merges=False, header=2)}
    out["no_header"] = {"type": "table", "table": table(header=0), "extensions": {STYLE_KEY: {"preset": "dark_header"}}}
    return out


def expected(block):
    return {key: look for key, look in ts.resolve(block).items()}


class TableStyles(unittest.TestCase):
    def test_the_gallery_has_exactly_the_twelve_looks_in_order(self):
        self.assertEqual(ts.DATA["order"], GALLERY)
        for preset in GALLERY:
            self.assertTrue(ts.PRESETS[preset]["label"] and ts.PRESETS[preset]["description"])

    def test_every_look_resolves_for_every_cell_including_merged_ones(self):
        for name, block in cases().items():
            with self.subTest(name):
                look = ts.resolve(block)
                self.assertEqual(len(look), sum(len(r) for r in block["table"]["rows"]))
                for entry in look.values():
                    self.assertEqual(set(entry["borders"]), {"top", "bottom", "left", "right"})

    def test_expected_properties_of_a_few_looks(self):
        academic = ts.resolve({"type": "table", "table": table(merges=False), "extensions": {STYLE_KEY: {"preset": "academic"}}})
        self.assertEqual(academic["0,0"]["borders"]["top"]["width_pt"], 1.5)
        self.assertEqual(academic["0,0"]["borders"]["bottom"]["width_pt"], 0.75)       # the rule under the header row
        self.assertIsNone(academic["1,1"]["borders"]["left"])
        self.assertTrue(academic["0,0"]["bold"])
        rows = ts.resolve({"type": "table", "table": table(merges=False), "extensions": {STYLE_KEY: {"preset": "alternating_rows", "accent": "#336699"}}})
        self.assertIsNone(rows["1,0"]["fill"])
        self.assertEqual(rows["2,0"]["fill"], ts.mix("#336699", (255, 255, 255), 0.85))
        dark = ts.resolve({"type": "table", "table": table(merges=False), "extensions": {STYLE_KEY: {"preset": "dark_header"}}})
        self.assertEqual((dark["0,0"]["fill"], dark["0,0"]["color"]), ("#1F1F1F", "#FFFFFF"))

    def test_an_edge_set_by_hand_wins_over_the_style_and_none_means_none(self):
        look = ts.resolve(cases()["by_hand"])
        self.assertEqual(look["0,0"]["borders"]["top"], {"color": "#FF0000", "width_pt": 2, "style": "dashed"})
        self.assertIsNone(look["0,1"]["borders"]["bottom"])                          # explicit "no border" beats the grid
        self.assertEqual(look["0,1"]["borders"]["top"]["style"], "solid")             # the cell beside it still has the style's rule
        self.assertEqual(look["1,0"]["fill"], "#FFEE00")

    def test_a_shared_edge_is_one_edge(self):
        look = ts.resolve(cases()["by_hand"])
        # the line between row 0 and row 1 above column 1: bottom of the cell above, top of the cell below
        self.assertEqual(look["0,1"]["borders"]["bottom"], look["1,1"]["borders"]["top"])
        self.assertEqual(look["0,0"]["borders"]["right"], look["0,1"]["borders"]["left"])

    def test_untouched_tables_keep_their_old_look(self):
        look = ts.resolve(cases()["legacy"])
        self.assertEqual(look["0,0"]["fill"], "#EDEDED")
        self.assertEqual(look["0,0"]["borders"]["top"]["color"], "#888888")
        self.assertIsNone(look["3,0"]["fill"])

    def test_golden_file_matches_the_server_and_is_what_the_browser_is_tested_against(self):
        data = {name: {"block": block, "expected": expected(block)} for name, block in cases().items()}
        if os.environ.get("UPDATE_GOLDEN"):
            GOLDEN.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
        self.assertTrue(GOLDEN.exists(), "run with UPDATE_GOLDEN=1 to create the golden file")
        self.assertEqual(json.loads(GOLDEN.read_text(encoding="utf-8")), json.loads(json.dumps(data, sort_keys=True)))

    def test_the_generated_browser_data_is_current(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "gen_table_styles.py"), "--check"], capture_output=True)
        self.assertEqual(result.returncode, 0, "run scripts/gen_table_styles.py")


if __name__ == "__main__":
    unittest.main()
