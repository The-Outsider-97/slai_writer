"""The layout of a table-of-contents entry: where the page number goes and how it is aligned, how the text is aligned, and where the leader starts and ends.

The engine (``toc_layout``) is tested on its own with plain numbers (the properties every placement must have), and then through the whole path: Writer's settings ->
the document -> the exported PDF, read back with pdfplumber, for every combination of position, number alignment, text alignment and leader. Nothing is read from
the model the writer was given: the checks use the characters of the PDF.
"""
from __future__ import annotations

import itertools
import re
import tempfile
import types
import unittest
from pathlib import Path

from applications.Documaster.slai.docmodel.writers import toc_layout as tl
from applications.slai_writer.academic import Academic
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.export import Exchange
from . import independent
from .helpers import Workbench

try:
    import pdfplumber
except ImportError:                                    # pragma: no cover
    pdfplumber = None

ROOT = Path(__file__).resolve().parents[3]
MM = 72 / 25.4


# ------------------------------------------------------------------------------------------------------------------------------- the engine
class EngineProperties(unittest.TestCase):
    """What must hold for any placement, over a grid of widths and settings."""

    def look(self, **kw):
        return tl.resolve_look({"leader": "dots", **kw})

    def cases(self):
        for position, align, leader in itertools.product(("right", "left", "custom"), tl.ALIGNS, ("dots", "dashes", "solid", "custom")):
            look = self.look(page_position=position, number_align=align, leader=leader, custom_tab_mm=130, leader_gap_pt=1.5 if leader == "custom" else None)
            for indent, column, number_w, text_w in itertools.product((0, 17), (14, 22), (6, 14), (30, 120, 260)):
                yield look, 453.0, indent, 0.0, column, max(number_w, 1.0), text_w

    def place(self, look, width, indent, rindent, column, number_w, text_w, text_align="left"):
        plan = tl.plan_entry(look, width, indent, rindent, column)
        x0, x1 = plan["text"]
        text_w = min(text_w, x1 - x0)
        start = x0 if text_align == "left" else x1 - text_w if text_align == "right" else x0 + (x1 - x0 - text_w) / 2
        mark = 3.1
        gap = tl.leader_gap_pt(look, 11)
        return plan, (start, start + text_w), tl.place_entry(look, plan, number_w, (start, start + text_w), (start, start + text_w), mark, gap), mark, gap

    def test_the_leader_never_touches_the_text_or_the_number_and_hugs_both(self):
        n = 0
        for look, width, indent, rindent, column, number_w, text_w in self.cases():
            for text_align in tl.ALIGNS:
                plan, text, placed, mark, gap = self.place(look, width, indent, rindent, column, number_w, text_w, text_align)
                leader = placed["leader"]
                nx = placed["number_x"]
                n += 1
                self.assertIsNotNone(nx)
                self.assertGreaterEqual(nx, plan["column"][0] - 1e-9)
                self.assertLessEqual(nx + number_w, plan["column"][1] + 1e-9, "the number stays inside its column")
                if not leader:
                    continue
                if leader["kind"] == "solid":
                    x0, x1 = leader["x0"], leader["x1"]
                else:
                    x0, x1 = leader["x0"], leader["x0"] + (leader["count"] - 1) * leader["pitch"] + leader["mark_w"]
                label = (look["position"], look["number_align"], look["leader"], indent, column, number_w, text_w, text_align)
                if look["position"] == "left":
                    self.assertGreaterEqual(x0, nx + number_w + tl.PAD_PT - 1e-6, label)
                    self.assertLessEqual(x1, text[0] - tl.PAD_PT + 1e-6, label)
                    near = x0 - (nx + number_w)
                    far = text[0] - x1
                else:
                    self.assertGreaterEqual(x0, text[1] + tl.PAD_PT - 1e-6, label)
                    self.assertLessEqual(x1, nx - tl.PAD_PT + 1e-6, label)
                    near = x0 - text[1]
                    far = nx - x1
                step = leader["pitch"] if leader["kind"] != "solid" else 0.0
                self.assertLess(near, tl.PAD_PT + step + 1e-6, f"starts right after the text {label}")
                self.assertLess(far, tl.PAD_PT + step + 1e-6, f"ends right before the number {label}")
        self.assertGreater(n, 1500)

    def test_marks_lie_on_one_grid_whatever_the_text(self):
        look = self.look(page_position="right", number_align="right", leader="dots")
        starts = set()
        for text_w in range(20, 380, 7):
            plan, text, placed, mark, gap = self.place(look, 453.0, 0, 0, 20.0, 8.0, text_w)
            if placed["leader"]:
                starts.add(round((placed["leader"]["x0"] - 453.0 + tl.PAD_PT + mark) % placed["leader"]["pitch"], 6) % round(placed["leader"]["pitch"], 6))
        self.assertEqual(len(starts), 1, "every entry's marks line up with those of the others")

    def test_no_room_means_no_leader(self):
        look = self.look(page_position="right", number_align="right", leader="dots")
        plan = tl.plan_entry(look, 453.0, 0, 0, 20.0)
        end = plan["text"][1]
        placed = tl.place_entry(look, plan, 20.0, (0, end), (0, end), 3.1, 0.0)
        self.assertIsNone(placed["leader"], "a heading that fills the line, beside the widest number, has nothing to lead from")

    def test_hidden_and_inline_have_no_leader_and_inline_follows_the_text(self):
        hidden = self.look(page_position="hidden")
        plan = tl.plan_entry(hidden, 453.0, 5, 0, 20.0)
        self.assertEqual(plan["text"], (5, 453.0))
        self.assertEqual(tl.place_entry(hidden, plan, 8.0, (5, 50), (5, 50), 3.1, 0.0), {"number_x": None, "leader": None})
        inline = self.look(page_position="inline", leader="dots")
        self.assertEqual(inline["leader"], "none")
        plan = tl.plan_entry(inline, 453.0, 0, 0, 20.0, 9.0, 7.7)
        placed = tl.place_entry(inline, plan, 9.0, (0, 60), (0, 140), 3.1, 0.0, 7.7)
        self.assertAlmostEqual(placed["number_x"], 147.7)
        self.assertIsNone(placed["leader"])
        self.assertLessEqual(plan["text"][1] + 9.0 + 7.7, 453.0 + 1e-9, "the number that follows a full line still fits")

    def test_legacy_settings_and_bad_values(self):
        self.assertEqual(tl.resolve_look({"page_align": "left"})["position"], "left")
        self.assertEqual(tl.resolve_look({"page_align": "inline"})["position"], "inline")
        self.assertEqual(tl.resolve_look({"page_position": "custom", "page_align": "left"})["position"], "custom", "the new setting wins")
        self.assertEqual(tl.resolve_look({"page_position": "nonsense"})["position"], "right")
        self.assertEqual(tl.resolve_look({}, show_page_numbers=False)["position"], "hidden")
        self.assertEqual(tl.resolve_look({}, leader_dots=False)["leader"], "none")
        self.assertEqual(tl.resolve_look({"leader": "custom", "leader_char": "\n"})["leader_char"], ".")
        self.assertEqual(tl.resolve_look({"leader": "custom", "leader_char": "·"})["leader_char"], "·")
        self.assertIsNone(tl.resolve_look({"leader_gap_pt": -3})["leader_gap_pt"])
        self.assertEqual(tl.resolve_look({"page_position": "left"})["number_align"], "left")
        self.assertEqual(tl.resolve_look({"page_position": "custom"})["number_align"], "right")


# ------------------------------------------------------------------------------------------------------------------------------- the PDF
HEADINGS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"]
LONG = ("Mike heading that is long enough to run onto a second and then onto a third line of the contents page for certain because it goes on and on about "
        "nothing in particular for far longer than any heading should ever be allowed to do in a book")


class PdfLayout(Workbench):
    @classmethod
    def setUpClass(cls):
        cls._dm_dir = tempfile.TemporaryDirectory()
        cls.dm = DocumasterLink(ROOT, Path(cls._dm_dir.name)).load()

    @classmethod
    def tearDownClass(cls):
        cls.dm.close()
        cls._dm_dir.cleanup()

    def setUp(self):
        super().setUp()
        independent.need(self, "Documaster", self.dm.available, str(self.dm.reason))
        independent.need(self, "pdfplumber", pdfplumber is not None, "pip install pdfplumber")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024, data_dir=self.root / "data")
        self.app.preferences = lambda: {"lookup_online": False}
        self.ex = Exchange(self.app)
        self.ac = Academic(self.app, fetch=lambda doi: {})

    def document(self, long=True, levels=None):
        s = self.new_session("report", title="Layout test")
        last = s.doc["blocks"][-1]["id"]
        names = HEADINGS + ([LONG] if long else [])
        ops = []
        for n, name in enumerate(names):
            ops.append({"op": "block_insert", "after": last, "block": {"id": f"h{n}", "type": "heading", "text": name,
                                                                       "attributes": {"level": (levels or {}).get(n, 1), "page_break_before": True}}})
            ops.append({"op": "block_insert", "after": f"h{n}", "block": {"id": f"b{n}", "type": "paragraph", "text": "Body text of the section."}})
            last = f"b{n}"
        s.apply({"op": "batch", "ops": ops}, None)
        return s

    def export(self, session, **look):
        session_toc = self.ac.contents(session, after=None, look={"preset": "classic", **look})
        report = self.ex.export(session, "pdf", self.root / "out", stem="toc")
        self.assertTrue(report["verification"]["ok"], report["verification"])
        return session_toc, report["path"]

    # reading the page ---------------------------------------------------------------------------------------------------------------
    def entries(self, path, leader_char):
        """For every heading, its lines on the contents page: {first word: [{'text': chars, 'leader': chars, 'number': chars, 'bottom': y}]}"""
        with pdfplumber.open(path) as pdf:
            page = pdf.pages[0]
            chars = [c for c in page.chars if c["top"] > 100 and c["bottom"] < page.height - 70]       # the running head and foot are not the contents
            width = float(page.width)
        rows: dict[float, list[dict]] = {}
        for c in chars:
            rows.setdefault(round(c["bottom"] - 0.212 * c["size"], 0), []).append(c)       # by baseline: an entry may mix sizes (a bold heading, a plain number)
        lines = []
        for bottom, row in sorted(rows.items()):
            row.sort(key=lambda c: c["x0"])
            number = [c for c in row if c["text"].isdigit()]
            leader = [c for c in row if c["text"] == leader_char and not c["text"].isalpha()]
            text = [c for c in row if c not in number and c not in leader and c["text"].strip()]
            lines.append({"bottom": row[0]["bottom"], "text": text, "leader": leader, "number": number})
        grouped: dict[str, list[dict]] = {}
        current = None
        previous = -100.0
        for line in lines:
            near = line["bottom"] - previous < 20.0                     # a line this close under another belongs to the same entry
            previous = line["bottom"]
            if line["text"]:
                word = "".join(c["text"] for c in line["text"])
                found = next((name for name in HEADINGS + [LONG.split()[0]] if word.startswith(name)), None)
                if found:
                    current = found
                elif not near:
                    current = None
                if current:
                    grouped.setdefault(current, []).append(line)
            elif current and (line["leader"] or line["number"]):
                grouped[current][-1] = {**grouped[current][-1], "leader": grouped[current][-1]["leader"] + line["leader"], "number": grouped[current][-1]["number"] + line["number"]}
        return grouped, width

    def margins(self, session):
        s = session.doc["sections"][0] if session.doc.get("sections") else {}
        m = (s.get("page") or {}).get("margins_mm") or {}
        return float(m.get("left", 25)) * MM, float(m.get("right", 25)) * MM

    def check(self, path, look, session, label):
        leader_char = {"dots": ".", "dashes": "-", "custom": look.get("leader_char", "·")}.get(look.get("leader", "dots"), "\x00")
        grouped, page_width = self.entries(path, leader_char)
        left, right = self.margins(session)
        edge = page_width - right
        self.assertEqual(sorted(grouped), sorted(HEADINGS + [LONG.split()[0]]), f"{label}: every heading has an entry")
        position = look.get("page_position", "right")
        align = look.get("number_align") or ("left" if position in ("left", "inline") else "right")
        pitch_of = {}
        widths = [max(c["x1"] for c in e["number"]) - min(c["x0"] for c in e["number"]) for lines in grouped.values() for e in lines[-1:] if e["number"]] if position != "left" else \
                 [max(c["x1"] for c in lines[0]["number"]) - min(c["x0"] for c in lines[0]["number"]) for lines in grouped.values() if lines[0]["number"]]
        column = max(widths) if widths else 0.0
        for name, lines in grouped.items():
            tag = f"{label} {name}"
            numbered = [line for line in lines if line["number"]]
            self.assertEqual(len(numbered), 1, f"{tag}: one page number")
            row = numbered[0]
            if position == "hidden":
                self.fail(f"{tag}: a hidden page number is drawn")
            self.assertIs(row, lines[0] if position == "left" else lines[-1], f"{tag}: the number is on the {'first' if position == 'left' else 'last'} line")
            n0, n1 = min(c["x0"] for c in row["number"]), max(c["x1"] for c in row["number"])
            if position == "right":
                want = {"right": edge - (n1 - n0) + 0, "left": edge - column, "center": edge - column + (column - (n1 - n0)) / 2}[align]
                self.assertAlmostEqual(n0, want, delta=0.8, msg=f"{tag}: number x")
            elif position == "left":
                want = {"left": left, "right": left + column - (n1 - n0), "center": left + (column - (n1 - n0)) / 2}[align]
                self.assertAlmostEqual(n0, want, delta=0.8, msg=f"{tag}: number x")
            elif position == "custom":
                tab = left + look["custom_tab_mm"] * MM
                want = {"left": tab, "right": tab - (n1 - n0), "center": tab - (n1 - n0) / 2}[align]
                self.assertAlmostEqual(n0, want, delta=1.0 + (column - (n1 - n0)) / 2, msg=f"{tag}: number x")
            # no text runs under the number column
            for line in lines:
                for c in line["text"]:
                    self.assertLessEqual(c["x1"], (n0 - tl.PAD_PT + 1.0) if position != "left" else edge + 0.5, f"{tag}: text under the number")
                    if position == "left":
                        self.assertGreaterEqual(c["x0"], left + column + tl.PAD_PT - 1.0, f"{tag}: text under the number column")
            # the leader
            kind = look.get("leader", "dots")
            marks = row["leader"] if position != "left" else lines[0]["leader"]
            if kind in ("none", "solid") or position in ("hidden", "inline"):
                self.assertFalse(marks, f"{tag}: a leader of kind {kind}/{position} must not be drawn as characters")
                continue
            text_chars = row["text"]
            if position == "left":
                text_start = min(c["x0"] for c in row["text"])
                number_end = max(c["x1"] for c in row["number"])
                if marks:
                    self.assertGreaterEqual(min(c["x0"] for c in marks), number_end + tl.PAD_PT - 0.6, f"{tag}: the leader starts after the number")
                    self.assertLessEqual(max(c["x1"] for c in marks), text_start - tl.PAD_PT + 0.6, f"{tag}: the leader ends before the text")
                    self.assertLess(text_start - max(c["x1"] for c in marks), tl.PAD_PT + 12.0, f"{tag}: the leader ends right before the text")
            else:
                text_end = max(c["x1"] for c in text_chars)
                if marks:
                    self.assertGreaterEqual(min(c["x0"] for c in marks), text_end + tl.PAD_PT - 0.6, f"{tag}: the leader starts after the text")
                    self.assertLessEqual(max(c["x1"] for c in marks), n0 - tl.PAD_PT + 0.6, f"{tag}: the leader ends before the number")
                    self.assertLess(min(c["x0"] for c in marks) - text_end, tl.PAD_PT + 12.0, f"{tag}: the leader starts right after the text")
                    self.assertLess(n0 - max(c["x1"] for c in marks), tl.PAD_PT + 12.0, f"{tag}: the leader ends right before the number")
            self.assertTrue(all(abs(c["bottom"] - row["bottom"]) < 0.6 for c in marks), f"{tag}: the marks stand on the baseline of the text")
            if len(marks) > 1:
                pitch = sorted({round(b["x0"] - a["x0"], 1) for a, b in zip(marks, marks[1:])})
                self.assertEqual(len(pitch), 1, f"{tag}: even spacing, got {pitch}")
                pitch_of[name] = (pitch[0], marks[0]["x0"], marks[-1]["x1"])
        if pitch_of:
            pitches = {v[0] for v in pitch_of.values()}
            self.assertEqual(len(pitches), 1, f"{label}: one pitch")
            pitch = pitches.pop()
            anchor = {v[2] if position != "left" else v[1] for v in pitch_of.values()}
            phase = {round((a % pitch) / pitch, 1) % 1.0 for a in anchor}
            self.assertLessEqual(len(phase), 2, f"{label}: the marks of different entries are on one grid {sorted(phase)}")
        return grouped, page_width, (left, right, edge, column)

    # the combinations ----------------------------------------------------------------------------------------------------------------
    def run_combo(self, **look):
        s = self.document()
        toc, path = self.export(s, **look)
        label = ",".join(f"{k}={v}" for k, v in look.items())
        return self.check(path, look, s, label)

    def test_position_and_number_alignment(self):
        for position, align in itertools.product(("right", "left", "custom"), tl.ALIGNS):
            with self.subTest(position=position, number_align=align):
                self.run_combo(page_position=position, number_align=align, leader="dots", **({"custom_tab_mm": 140} if position == "custom" else {}))

    def test_every_leader_style_at_every_position(self):
        for position, leader in itertools.product(("right", "left", "custom"), ("dots", "dashes", "solid", "custom", "none")):
            with self.subTest(position=position, leader=leader):
                self.run_combo(page_position=position, leader=leader, **({"custom_tab_mm": 140} if position == "custom" else {}),
                               **({"leader_char": "*"} if leader == "custom" else {}))

    def test_leader_spacing(self):
        pitches = {}
        for gap in (0, 2, 6):
            grouped, *_ = self.run_combo(page_position="right", leader="dots", leader_gap_pt=gap)
            marks = grouped["Alpha"][-1]["leader"]
            pitches[gap] = round(marks[1]["x0"] - marks[0]["x0"], 1)
        self.assertLess(pitches[0], pitches[2])
        self.assertLess(pitches[2], pitches[6])
        self.assertAlmostEqual(pitches[6] - pitches[2], 4.0, delta=0.3, msg="the setting is the room between marks, in points")

    def test_a_solid_leader_is_one_rule_from_just_after_the_text_to_just_before_the_number(self):
        for position, align in (("right", "right"), ("custom", "left"), ("left", "right")):
            with self.subTest(position=position):
                s = self.document(long=False)
                toc, path = self.export(s, page_position=position, number_align=align, leader="solid", text_align="left" if position != "left" else "right",
                                        **({"custom_tab_mm": 140} if position == "custom" else {}))
                grouped, width = self.entries(path, "\x00")
                with pdfplumber.open(path) as pdf:
                    page = pdf.pages[0]
                    rules = [r for r in page.lines if abs(r["top"] - r["bottom"]) < 0.01 and r["x1"] - r["x0"] > 8]
                for name, lines in grouped.items():
                    row = lines[0] if position == "left" else lines[-1]
                    mine = [r for r in rules if abs(r["top"] - row["bottom"]) < 6]
                    self.assertEqual(len(mine), 1, f"{position} {name}: one rule on the line of the entry")
                    rule = mine[0]
                    n0, n1 = min(c["x0"] for c in row["number"]), max(c["x1"] for c in row["number"])
                    if position == "left":
                        self.assertAlmostEqual(rule["x0"], n1 + tl.PAD_PT, delta=0.8, msg=f"{name}: starts right after the number")
                        self.assertAlmostEqual(rule["x1"], min(c["x0"] for c in row["text"]) - tl.PAD_PT, delta=0.8, msg=f"{name}: ends right before the text")
                    else:
                        self.assertAlmostEqual(rule["x0"], max(c["x1"] for c in row["text"]) + tl.PAD_PT, delta=0.8, msg=f"{name}: starts right after the text")
                        self.assertAlmostEqual(rule["x1"], n0 - tl.PAD_PT, delta=0.8, msg=f"{name}: ends right before the number")

    def test_text_alignment_of_the_entries(self):
        for position, text_align in itertools.product(("right", "left", "custom", "hidden"), tl.ALIGNS):
            with self.subTest(position=position, text_align=text_align):
                s = self.document(long=False)
                look = {"page_position": position, "text_align": text_align, "leader": "dots", **({"custom_tab_mm": 140} if position == "custom" else {})}
                toc, path = self.export(s, **look)
                grouped, width = self.entries(path, ".")
                left, right = self.margins(s)
                edge = width - right
                number_col = max((max(c["x1"] for c in lines[-1]["number"]) - min(c["x0"] for c in lines[-1]["number"]) for lines in grouped.values() if lines[-1]["number"]), default=0)
                for name, lines in grouped.items():
                    row = lines[-1]
                    x0, x1 = min(c["x0"] for c in row["text"]), max(c["x1"] for c in row["text"])
                    if position == "right":
                        area = (left, edge - number_col - tl.PAD_PT)
                    elif position == "left":
                        area = (left + number_col + tl.PAD_PT, edge)
                    elif position == "custom":
                        tab = left + 140 * MM
                        area = (left, tab - number_col - tl.PAD_PT)
                    else:
                        area = (left, edge)
                    if text_align == "left":
                        self.assertAlmostEqual(x0, area[0], delta=1.2, msg=f"{position} {name}")
                    elif text_align == "right":
                        self.assertAlmostEqual(x1, area[1], delta=1.2, msg=f"{position} {name}")
                    else:
                        self.assertAlmostEqual((x0 + x1) / 2, (area[0] + area[1]) / 2, delta=1.5, msg=f"{position} {name}")
                    if position != "hidden":
                        self.assertTrue(row["number"], f"{position} {name}: page number")
                    else:
                        self.assertFalse(row["number"], "no page numbers when they are hidden")

    def test_numbers_left_text_right_with_leaders_between_and_the_reverse(self):
        grouped, width, (left, right, edge, column) = self.run_combo(page_position="left", number_align="left", text_align="right", leader="dots")
        for name, lines in grouped.items():
            row = lines[0]
            self.assertAlmostEqual(max(c["x1"] for c in lines[-1]["text"]), edge, delta=1.2, msg=f"{name}: the text is at the right edge")
            if name == "Mike":
                continue                                                   # its first line is as long as the room: nothing to lead across
            self.assertTrue(row["leader"], f"{name}: dot leaders between the page number and the title")
            self.assertLess(max(c["x1"] for c in row["number"]), min(c["x0"] for c in row["leader"]) + 0.5)
            self.assertLess(max(c["x1"] for c in row["leader"]), min(c["x0"] for c in row["text"]))
        grouped, width, (left, right, edge, column) = self.run_combo(page_position="right", number_align="right", text_align="left", leader="dots")
        for name, lines in grouped.items():
            self.assertAlmostEqual(min(c["x0"] for c in lines[0]["text"]), left, delta=1.2, msg=f"{name}: the text is at the left margin")
            self.assertTrue(lines[-1]["leader"], f"{name}: dot leaders between the title and the page number")

    def test_a_wrapped_heading_stays_aligned_and_keeps_out_of_the_number_column(self):
        for position, text_align in (("right", "left"), ("left", "left"), ("right", "right"), ("custom", "left")):
            with self.subTest(position=position, text_align=text_align):
                grouped, width, (left, right, edge, column) = self.run_combo(page_position=position, text_align=text_align, leader="dots",
                                                                              **({"custom_tab_mm": 140} if position == "custom" else {}))
                lines = grouped["Mike"]
                self.assertGreaterEqual(len(lines), 3, "the long heading wraps onto three lines")
                if text_align == "left":
                    starts = {round(min(c["x0"] for c in line["text"]), 0) for line in lines}
                    self.assertEqual(len(starts), 1, f"every line of the wrapped heading starts at the same place: {starts}")
                numbered = [line for line in lines if line["number"]]
                self.assertEqual(len(numbered), 1)
                self.assertIs(numbered[0], lines[0] if position == "left" else lines[-1])

    def test_a_wide_number_column_and_several_digits_stay_aligned(self):
        grouped, width, (left, right, edge, column) = self.run_combo(page_position="right", number_align="right", leader="dots")
        widths = {round(max(c["x1"] for c in lines[-1]["number"]) - min(c["x0"] for c in lines[-1]["number"]), 1) for lines in grouped.values()}
        self.assertGreater(len(widths), 1, "the document has page numbers of one and two digits")
        self.assertEqual({round(max(c["x1"] for c in lines[-1]["number"]), 0) for lines in grouped.values()}, {round(edge, 0)})
        grouped, *_ = self.run_combo(page_position="right", number_align="left", leader="dots")
        self.assertEqual(len({round(min(c["x0"] for c in lines[-1]["number"]), 0) for lines in grouped.values()}), 1, "left-aligned numbers start at one x")

    def test_inline_and_hidden(self):
        s = self.document(long=False)
        toc, path = self.export(s, page_position="inline")
        grouped, width = self.entries(path, "\x00")
        left, right = self.margins(s)
        for name, lines in grouped.items():
            row = lines[-1]
            gap = min(c["x0"] for c in row["number"]) - max(c["x1"] for c in row["text"])
            self.assertTrue(3 < gap < 14, f"{name}: the number follows the title closely ({gap:.1f} pt)")
            self.assertFalse(row["leader"])
        s = self.document(long=False)
        toc, path = self.export(s, page_position="hidden")
        grouped, width = self.entries(path, ".")
        for name, lines in grouped.items():
            self.assertFalse(any(line["number"] or line["leader"] for line in lines), f"{name}: nothing but the title")
        self.assertEqual(toc["state"]["blocks"] and True, True)
        title = next(b for b in s.doc["blocks"] if b.get("extensions", {}).get("slai.sldc.toc", {}).get("role") == "title")
        self.assertIs(title["extensions"]["slai.sldc.toc"]["show_page_numbers"], False, "the core extension says the numbers are off, for every other reader")


class WordAndRtf(PdfLayout):
    """The same settings in Word and RTF files: the tab stops python-docx reads back, and what LibreOffice draws from the file."""

    def converted(self, fmt, **look):
        independent.need(self, "LibreOffice", bool(independent.soffice()), "soffice not found")
        s = self.document(long=False)
        self.ac.contents(s, after=None, look={"preset": "classic", **look})
        path = Path(self.ex.export(s, fmt, self.root / "out", stem="toc")["path"])
        pdf = independent.to_pdf(path, self.root / f"lo-{fmt}")
        out = self.root / f"toc-{fmt}-{len(list(self.root.glob('toc-*.pdf')))}.pdf"
        out.write_bytes(pdf)
        return s, path, out

    def test_tab_stops_in_the_word_file(self):
        import docx
        from docx.oxml.ns import qn
        cases = {("right", "right", "left", "dots"): [("right", "dot")], ("right", "left", "right", "dashes"): [("right", None), ("left", "hyphen")],
                 ("left", "left", "right", "dots"): [("right", "dot")], ("custom", "center", "left", "solid"): [("center", "underscore")],
                 ("left", "right", "left", "dots"): [("right", None), ("left", "dot")]}
        for (position, number_align, text_align, leader), want in cases.items():
            with self.subTest(position=position, number_align=number_align, text_align=text_align):
                s = self.document(long=False)
                self.ac.contents(s, after=None, look={"preset": "classic", "page_position": position, "number_align": number_align, "text_align": text_align, "leader": leader,
                                                      **({"custom_tab_mm": 120} if position == "custom" else {})})
                path = Path(self.ex.export(s, "docx", self.root / "out", stem="tabs")["path"])
                document = docx.Document(str(path))
                entry = next(p for p in document.paragraphs if p.text.startswith("Alpha") or p.text.lstrip().startswith("Alpha") or "Alpha" in p.text and "\t" in p.text)
                tabs = entry._p.pPr.find(qn("w:tabs"))
                got = [(t.get(qn("w:val")), t.get(qn("w:leader"))) for t in tabs.findall(qn("w:tab"))]
                self.assertEqual([(a, b if b != "none" else None) for a, b in got], want)
                xml = entry._p.xml
                self.assertIn("PAGEREF", xml, "the page number is a real page-reference field")
                self.assertEqual(entry.text.count("\t"), len(want), "one tab for each stop")
                order = [entry.text.find("Alpha"), entry.text.find("\t"), len(entry.text.rstrip())]
                if position == "left" and number_align == "left":
                    self.assertTrue(entry.text[0].isdigit(), "the number comes first")

    def check_drawn(self, pdf, position, number_align, text_align, leader, s, tab_mm=None, label=""):
        grouped, width = self.entries(pdf, "." if leader == "dots" else "-")
        left, right = self.margins(s)
        edge = width - right
        self.assertEqual(sorted(grouped), sorted(HEADINGS), label)
        for name, lines in grouped.items():
            row = lines[0]
            tag = f"{label} {name}"
            self.assertTrue(row["number"], f"{tag}: page number")
            n0, n1 = min(c["x0"] for c in row["number"]), max(c["x1"] for c in row["number"])
            t0, t1 = min(c["x0"] for c in row["text"]), max(c["x1"] for c in row["text"])
            if position == "right" and number_align == "right":
                self.assertAlmostEqual(n1, edge, delta=2.0, msg=f"{tag}: number at the right edge")
            if position == "left" and number_align == "left":
                self.assertAlmostEqual(n0, left, delta=2.0, msg=f"{tag}: number at the left margin")
            if position == "custom" and tab_mm is not None:
                tab = left + tab_mm * MM
                want = {"left": n0, "right": n1, "center": (n0 + n1) / 2}[number_align]
                self.assertAlmostEqual(want, tab, delta=2.0, msg=f"{tag}: number at the custom tab")
            if position == "left":
                self.assertLess(n1, t0, f"{tag}: number before the text")
                if text_align == "right":
                    self.assertAlmostEqual(t1, edge, delta=2.0, msg=f"{tag}: text at the right edge")
                    if leader == "dots":
                        self.assertTrue(row["leader"], f"{tag}: leaders between the number and the text")
                        self.assertLess(max(c["x1"] for c in row["number"]), min(c["x0"] for c in row["leader"]) + 0.5)
                        self.assertLess(max(c["x1"] for c in row["leader"]), t0 + 0.5)
            else:
                self.assertLess(t1, n0, f"{tag}: text before the number")
                if text_align == "left":
                    self.assertAlmostEqual(t0, left, delta=2.0, msg=f"{tag}: text at the left margin")
                    if leader == "dots":
                        self.assertTrue(row["leader"], f"{tag}: leaders between the text and the number")
                        self.assertLess(t1, min(c["x0"] for c in row["leader"]) + 0.5)
                        self.assertLess(max(c["x1"] for c in row["leader"]), n0 + 0.5)

    def test_libreoffice_draws_the_word_and_rtf_files_as_laid_out(self):
        for fmt in ("docx", "rtf"):
            for position, number_align, text_align in (("right", "right", "left"), ("left", "left", "right"), ("custom", "right", "left"), ("custom", "left", "left"),
                                                       ("left", "right", "left")):
                with self.subTest(format=fmt, position=position, number_align=number_align, text_align=text_align):
                    look = {"page_position": position, "number_align": number_align, "text_align": text_align, "leader": "dots", **({"custom_tab_mm": 120} if position == "custom" else {})}
                    s, path, pdf = self.converted(fmt, **look)
                    self.check_drawn(pdf, position, number_align, text_align, "dots", s, tab_mm=120 if position == "custom" else None, label=f"{fmt} {position}/{number_align}/{text_align}")

    def test_hidden_numbers_and_inline_numbers_in_word(self):
        s, path, pdf = self.converted("docx", page_position="hidden")
        grouped, width = self.entries(pdf, ".")
        for name, lines in grouped.items():
            self.assertFalse(any(line["number"] or line["leader"] for line in lines), name)
        s, path, pdf = self.converted("docx", page_position="inline")
        grouped, width = self.entries(pdf, ".")
        for name, lines in grouped.items():
            row = lines[-1]
            self.assertTrue(row["number"] and not row["leader"], name)
            self.assertLess(min(c["x0"] for c in row["number"]) - max(c["x1"] for c in row["text"]), 16)


GOLDEN = Path(__file__).parent / "fixtures" / "toc_layout_golden.json"


def golden_cases() -> dict:
    """Every position, number alignment and leader kind, at a few widths: what the engine says, in points, for the browser's port of it to be tested against."""
    raws = [None, {}, {"page_align": "left"}, {"page_align": "inline"}, {"page_position": "nonsense"}, {"leader_char": "\n", "leader": "custom"}, {"leader": "custom", "leader_char": "·"},
            {"leader_gap_pt": 2.5, "leader": "dashes"}, {"leader_gap_pt": -3}, {"custom_tab_mm": 120, "page_position": "custom", "number_align": "center"},
            {"number_column_mm": 14, "page_position": "right", "number_align": "left"}]
    for position in ("right", "left", "inline", "custom", "hidden"):
        for align in ("left", "center", "right"):
            for leader in ("none", "dots", "dashes", "solid", "custom"):
                raws.append({"page_position": position, "number_align": align, "leader": leader, "leader_char": "*", "custom_tab_mm": 100})
    looks = []
    for raw in raws:
        for flags in ((True, True), (False, True), (True, False)):
            looks.append({"raw": raw, "show": flags[0], "dots": flags[1], "look": tl.resolve_look(raw, show_page_numbers=flags[0], leader_dots=flags[1])})
    entries = []
    for item in looks[::7]:
        look = item["look"]
        for width, indent, right_indent, column_w in ((453.5, 0.0, 0.0, 14.0), (453.5, 17.0, 6.0, 22.0), (120.0, 8.0, 0.0, 14.0), (30.0, 0.0, 0.0, 30.0)):
            plan = tl.plan_entry(look, width, indent, right_indent, column_w, 11.5, 7.7)
            case = {"look": look, "width": width, "indent": indent, "right_indent": right_indent, "column_w": column_w, "inline_w": 11.5, "inline_gap": 7.7,
                    "plan": {"position": plan["position"], "text": list(plan["text"]), "column": None if plan["column"] is None else list(plan["column"])}, "places": []}
            for number_w, first, last in ((5.6, (plan["text"][0], plan["text"][0] + 60.0), (plan["text"][0], plan["text"][0] + 60.0)),
                                          (11.2, (plan["text"][0] + 3, plan["text"][1]), (plan["text"][0], plan["text"][0] + 140.0)), (5.6, (plan["text"][0], plan["text"][1] - 1), (plan["text"][0], plan["text"][1] - 1))):
                for mark_w, gap in ((3.06, 0.0), (3.06, 3.85), (5.0, 1.0), (0.0, 0.0)):
                    placed = tl.place_entry(look, plan, number_w, first, last, mark_w, gap, 7.7)
                    case["places"].append({"number_w": number_w, "first": list(first), "last": list(last), "mark_w": mark_w, "gap": gap, "result": placed})
            entries.append(case)
    return {"looks": looks, "entries": entries}


class Golden(unittest.TestCase):
    def test_the_golden_file_is_what_the_engine_says_and_what_the_browser_is_tested_against(self):
        import json
        import os
        data = json.loads(json.dumps(golden_cases(), sort_keys=True))
        if os.environ.get("UPDATE_GOLDEN"):
            GOLDEN.write_text(json.dumps(data, indent=0, sort_keys=True), encoding="utf-8")
        self.assertTrue(GOLDEN.exists(), "run with UPDATE_GOLDEN=1 to create the golden file")
        self.assertEqual(json.loads(GOLDEN.read_text(encoding="utf-8")), data)


if __name__ == "__main__":
    unittest.main()
