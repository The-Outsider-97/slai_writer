"""What leaves Writer: columns (continuous regions, column breaks) and table-of-contents looks in the PDF and Word files.

Positions are read back from the real exported files, never from the model the writer was given.
"""
import re
import tempfile
import types
import unittest
from pathlib import Path

from applications.slai_writer import columns as colmod
from applications.slai_writer.docmaster import DocumasterLink
from applications.slai_writer.academic import Academic
from applications.slai_writer.export import Exchange
from .helpers import Workbench

try:
    import pdfplumber
except ImportError:                                    # pragma: no cover - optional dependency of the test only
    pdfplumber = None


def words_of(n, count=60):
    return " ".join(f"p{n}w{i}" for i in range(count))


ROOT = Path(__file__).resolve().parents[3]


class ExportLayoutTests(Workbench):
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
        if not self.dm.available:
            self.skipTest("Documaster is not available: " + str(self.dm.reason))
        if pdfplumber is None:
            self.skipTest("pdfplumber is not installed")
        self.app.docmaster = self.dm
        self.app.settings = types.SimpleNamespace(signatures={"max_distinct": 2, "max_samples": 20}, max_upload_bytes=1024 * 1024,
                                                  data_dir=self.root / "data")
        self.ex = Exchange(self.app)
        self.app.preferences = lambda: {"lookup_online": False}
        self.ac = Academic(self.app, fetch=lambda doi: {})

    def paragraphs(self, count=10, words=60):
        s = self.new_session("blank", title="Layout", text=words_of(0, words))
        for n in range(1, count):
            s.apply({"op": "block_insert", "after": s.doc["blocks"][-1]["id"], "block": {"type": "paragraph", "text": words_of(n, words)}}, None)
        return s

    def pdf(self, session, stem="layout"):
        report = self.ex.export(session, "pdf", self.root / "out", stem=stem)
        self.assertTrue(report["verification"]["ok"], report["verification"])
        return report

    def positions(self, path):
        """{paragraph number: [(page, x0, x1, top, bottom)]} for every word p<n>w<i> in the PDF."""
        found = {}
        with pdfplumber.open(path) as pdf:
            for number, page in enumerate(pdf.pages, 1):
                for w in page.extract_words():
                    m = re.fullmatch(r"p(\d+)w\d+", w["text"])
                    if m:
                        found.setdefault(int(m.group(1)), []).append((number, w["x0"], w["x1"], w["top"], w["bottom"]))
        return found

    # -- a selection in its own columns --------------------------------------------------------------------------------------
    def test_selection_columns_share_the_page_with_the_text_around_them(self):
        s = self.paragraphs()
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[3], "end_block": ids[6], "columns": 2, "gap_mm": 10,
                 "rule": {"color": "#ff0000", "width_pt": 1}}, None)
        report = self.pdf(s)
        pos = self.positions(report["path"])
        left = 25 * 72 / 25.4
        width = 210 * 72 / 25.4 - 2 * left
        column = (width - 10 * 72 / 25.4) / 2
        for n in (0, 1, 2, 7, 8, 9):                                                 # outside the selection: one column, full width
            xs = [x0 for _, x0, *_ in pos[n]]
            self.assertAlmostEqual(min(xs), left, delta=1.5, msg=n)
            self.assertGreater(max(x1 for _, _, x1, *_ in pos[n]), left + column + 20, msg=n)
        inside = [w for n in (3, 4, 5, 6) for w in pos[n]]
        self.assertTrue(all(w[0] == 1 for w in pos[3] + pos[6]), "the region and the text around it stay on the first page")
        x0s = sorted({round(w[1]) for w in inside})
        self.assertAlmostEqual(min(x0s), left, delta=1.5)
        right_start = left + column + 10 * 72 / 25.4
        self.assertTrue(any(abs(x - right_start) < 2 for x in x0s), f"a second column starts at {right_start}: {x0s}")
        for _, _, x1, _, _ in inside:                                                # no word crosses into the gutter or past the margin
            self.assertLessEqual(x1, left + width + 1)
        gutter = (left + column, right_start)
        for _, x0, x1, *_ in inside:
            self.assertFalse(x0 < gutter[1] - 1 and x1 > gutter[0] + 1 and not (x1 <= gutter[0] + 1 or x0 >= gutter[1] - 1), "a word sits in the gutter")
        # the text after the selection starts below everything inside it
        self.assertGreater(min(w[3] for w in pos[7]), max(w[4] for w in inside) - 1)
        self.assertLess(max(w[4] for w in pos[2]), min(w[3] for w in inside) + 1)

    def test_the_separator_line_is_drawn_between_the_columns_in_its_colour(self):
        s = self.paragraphs()
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[3], "end_block": ids[6], "columns": 2, "gap_mm": 10,
                 "rule": {"color": "#ff0000", "width_pt": 1}}, None)
        report = self.pdf(s)
        with pdfplumber.open(report["path"]) as pdf:
            page = pdf.pages[0]
            lines = [o for o in page.lines + page.rects + page.curves if o.get("stroking_color") in ((1, 0, 0), [1, 0, 0], (1.0, 0.0, 0.0))]
        self.assertTrue(lines, "no red separator line")
        middle = 595.2756 / 2
        self.assertTrue(any(abs((o["x0"] + o["x1"]) / 2 - middle) < 3 for o in lines))

    def test_unequal_widths_and_separator_of_a_whole_page_layout_are_drawn_in_the_pdf(self):
        s = self.paragraphs(count=6, words=60)
        s.apply({"op": "columns_set", "scope": "document", "columns": 2, "gap_mm": 10, "widths_mm": [40, 110], "rule": {"color": "#0000ff", "width_pt": 1}}, None)
        report = self.pdf(s)
        pos = self.positions(report["path"])
        left = 25 * 72 / 25.4
        first = (40 * 150 / 150) * 72 / 25.4                                   # 40 + 110 already fill 160 - 10 mm
        second = left + first + 10 * 72 / 25.4
        starts = sorted({round(w[1]) for ws in pos.values() for w in ws})
        self.assertTrue(any(abs(x - second) < 2 for x in starts), (second, starts))
        narrow = [w for ws in pos.values() for w in ws if w[1] < left + first + 5]
        self.assertTrue(narrow and max(w[2] for w in narrow) <= left + first + 1)
        with pdfplumber.open(report["path"]) as pdf:
            page = pdf.pages[0]
            blue = [o for o in page.lines + page.rects + page.curves if tuple(o.get("stroking_color") or ()) == (0, 0, 1)]
        self.assertTrue(blue, "the separator line is drawn")
        self.assertTrue(any(abs((o["x0"] + o["x1"]) / 2 - (left + first + 5 * 72 / 25.4)) < 2 for o in blue))

    def test_a_table_inside_the_columns_of_a_selection_is_written_and_split_across_columns(self):
        s = self.paragraphs(count=5, words=20)
        s.apply({"op": "block_insert", "after": s.doc["blocks"][2]["id"], "block": {"id": "tt", "type": "table", "rows": 60, "columns": 2}}, None)
        for r in range(60):
            s.apply({"op": "table_cell", "block": "tt", "row": r, "col": 0, "text": f"row{r}x"}, None)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[4], "columns": 2, "gap_mm": 10}, None)
        report = self.pdf(s)
        with pdfplumber.open(report["path"]) as pdf:
            words = [w for page in pdf.pages for w in page.extract_words() if re.fullmatch(r"row\d+x", w["text"])]
        self.assertEqual(len({w["text"] for w in words}), 60, "every row is in the file (the header row is repeated where the table continues)")
        self.assertGreater(len({round(w["x0"]) for w in words}), 1, "the rows continue in the second column")
        self.assertFalse([w for w in report["warnings"] if "could not be balanced" in w])

    def test_three_columns_are_equal_and_balanced(self):
        s = self.paragraphs()
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[7], "columns": 3, "gap_mm": 6}, None)
        pos = self.positions(self.pdf(s)["path"])
        starts = sorted({round(w[1]) for n in range(2, 8) for w in pos[n] if w[1] > 71.5 or True})
        left = 25 * 72 / 25.4
        col = (210 * 72 / 25.4 - 2 * left - 2 * 6 * 72 / 25.4) / 3
        for k in range(3):
            expect = left + k * (col + 6 * 72 / 25.4)
            self.assertTrue(any(abs(x - expect) < 2 for x in starts), f"column {k + 1} should start near {expect}: {starts}")
        # balanced: the three columns end at about the same height
        ends = {}
        for n in range(2, 8):
            for _, x0, _, _, bottom in pos[n]:
                k = min(2, int((x0 - left + 3) // (col + 6 * 72 / 25.4)))
                ends[k] = max(ends.get(k, 0), bottom)
        self.assertEqual(len(ends), 3)
        self.assertLess(max(ends.values()) - min(ends.values()), 40)

    def test_page_numbers_of_headings_inside_a_region_are_still_measured(self):
        s = self.new_session("blank", title="Layout", text=words_of(0, 5))
        s.apply({"op": "block_insert", "after": s.doc["blocks"][-1]["id"], "block": {"type": "heading", "level": 1, "text": "Inside the columns"}}, None)
        heading = s.doc["blocks"][-1]["id"]
        for n in range(1, 4):
            s.apply({"op": "block_insert", "after": s.doc["blocks"][-1]["id"], "block": {"type": "paragraph", "text": words_of(n, 30)}}, None)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[3], "columns": 2}, None)
        layout = self.ex.layout(s)
        self.assertEqual(layout["blockPages"].get(heading), 1)
        self.assertEqual(layout["blockPages"].get(ids[3]), 1)

    # -- column breaks ---------------------------------------------------------------------------------------------------------
    def test_column_break_starts_the_next_column_of_a_two_column_page(self):
        s = self.paragraphs(count=4, words=20)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "document", "columns": 2, "gap_mm": 10}, None)
        s.apply({"op": "column_break", "block": ids[2]}, None)
        pos = self.positions(self.pdf(s)["path"])
        middle = 595.2756 / 2
        self.assertTrue(all(w[1] < middle for n in (0, 1) for w in pos[n]))
        self.assertTrue(all(w[1] > middle - 5 for w in pos[2]), "the block with the break is at the top of the second column")
        self.assertAlmostEqual(min(w[3] for w in pos[2]), min(w[3] for w in pos[0]), delta=3)

    def test_column_break_in_a_one_column_page_is_a_page_break(self):
        s = self.paragraphs(count=3, words=10)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "column_break", "block": ids[2]}, None)
        pos = self.positions(self.pdf(s)["path"])
        self.assertEqual({w[0] for w in pos[1]}, {1})
        self.assertEqual({w[0] for w in pos[2]}, {2})

    def test_columns_that_cannot_share_the_page_are_disclosed(self):
        s = self.paragraphs(count=4, words=20)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[1], "end_block": ids[2], "columns": 3}, None)
        report = self.pdf(s)
        self.assertTrue(any("new page" in w for w in report.get("warnings", [])), report.get("warnings"))

    # -- table of contents looks -----------------------------------------------------------------------------------------------
    def contents_rows(self, path, look):
        """The lines of the table of contents on page 1: [(text, words, horizontal rules at that height)]."""
        with pdfplumber.open(path) as pdf:
            page = pdf.pages[0]
            rows = []
            for line in page.extract_text_lines():
                if any(name in line["text"] for name in ("Abstract", "Introduction", "Method", "Results", "Discussion", "References")):
                    rules = [r for r in page.lines + page.rects if r["x1"] - r["x0"] > 40 and abs((r["top"] + r["bottom"]) / 2 - (line["top"] + line["bottom"]) / 2) < 8]
                    rows.append((line["text"], line["chars"], rules, page.width))
        return rows

    def contents_pdf(self, **look):
        s = self.new_session("report", title="R")
        toc = self.ac.contents(s, after=None, look={"preset": "classic", **look})["tocId"]
        self.assertTrue(toc)
        return self.pdf(s, "toc")["path"]

    def test_leader_kinds_are_drawn_in_the_pdf(self):
        for kind, pattern in (("dots", r"\.{6,}"), ("dashes", r"(?:- ?){6,}")):
            rows = self.contents_rows(self.contents_pdf(leader=kind), kind)
            entries = [r for r in rows if re.search(r"\d\s*$", r[0]) and ("Method" in r[0] or "Results" in r[0])]
            self.assertTrue(entries, (kind, [r[0] for r in rows]))
            for text, *_ in entries:
                self.assertRegex(text, pattern, kind)
        solid = self.contents_rows(self.contents_pdf(leader="solid"), "solid")
        entries = [r for r in solid if "Results" in r[0] and re.search(r"\d\s*$", r[0])]
        self.assertTrue(entries and all(r[2] for r in entries), "a solid leader is a rule on the line")
        self.assertFalse(any(re.search(r"\.{4,}", r[0]) for r in entries))
        none = self.contents_rows(self.contents_pdf(leader="none"), "none")
        entries = [r for r in none if "Results" in r[0] and re.search(r"\d\s*$", r[0])]
        self.assertTrue(entries)
        for text, _, rules, _ in entries:
            self.assertFalse(re.search(r"\.{3,}|- - -", text) or rules, text)

    def test_page_number_placement_is_followed_in_the_pdf(self):
        right = [r for r in self.contents_rows(self.contents_pdf(page_align="right", leader="none"), "r") if "Results" in r[0] and re.search(r"\d\s*$", r[0])]
        self.assertTrue(right)
        chars = right[0][1]
        self.assertGreater(chars[-1]["x1"], right[0][3] - 25 * 72 / 25.4 - 4)                 # the number is at the right margin
        inline = [r for r in self.contents_rows(self.contents_pdf(page_align="inline"), "i") if "Results" in r[0] and re.search(r"\d\s*$", r[0])]
        self.assertTrue(inline)
        self.assertLess(inline[0][1][-1]["x1"], inline[0][3] / 2, "the number follows the title closely")
        self.assertNotRegex(inline[0][0], r"\.{3,}")
        left = [r for r in self.contents_rows(self.contents_pdf(page_align="left"), "l") if "Results" in r[0] and re.search(r"Results", r[0])]
        self.assertTrue(left)
        self.assertRegex(left[0][0], r"^\s*\d+\s+Results")                                     # the number comes first

    # -- Word ---------------------------------------------------------------------------------------------------------------------
    def docx(self, session, stem="layout"):
        report = self.ex.export(session, "docx", self.root / "out", stem=stem)
        self.assertTrue(report["verification"]["ok"], report["verification"])
        import docx
        return docx.Document(report["path"])

    def cols_of(self, section):
        from docx.oxml.ns import qn
        element = section._sectPr.find(qn("w:cols"))
        return element, {k.split("}")[1]: v for k, v in element.attrib.items()}

    def test_word_gets_a_continuous_section_with_its_columns_separator_and_widths(self):
        from docx.enum.section import WD_SECTION
        s = self.paragraphs(count=8, words=10)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[4], "columns": 3, "gap_mm": 8,
                 "widths_mm": [30, 50, 70], "rule": {"color": "#00aa00", "width_pt": 1}}, None)
        d = self.docx(s)
        self.assertEqual(len(d.sections), 3)
        self.assertEqual([x.start_type for x in d.sections][1:], [WD_SECTION.CONTINUOUS, WD_SECTION.CONTINUOUS])
        first, middle, last = (self.cols_of(x) for x in d.sections)
        self.assertEqual(first[1]["num"], "1")
        self.assertEqual(middle[1]["num"], "3")
        self.assertEqual(middle[1]["sep"], "1")
        self.assertEqual(middle[1]["equalWidth"], "0")
        from docx.oxml.ns import qn
        widths = [int(c.get(qn("w:w"))) for c in middle[0].findall(qn("w:col"))]
        want = [w * 144 / 150 * 56.7 for w in (30, 50, 70)]                       # scaled to fill the 160 mm line less two 8 mm gaps
        self.assertTrue(all(abs(a - b) <= 1 for a, b in zip(widths, want)), (widths, want))
        self.assertEqual(last[1]["num"], "1")
        self.assertNotIn("sep", last[1])
        self.assertNotIn("equalWidth", last[1], "the section after the columns does not inherit them")
        self.assertEqual(sum(1 for x in d.sections if x._sectPr.find(qn("w:bidi")) is not None), 0)

    def test_word_right_to_left_flow_and_equal_columns(self):
        from docx.oxml.ns import qn
        s = self.paragraphs(count=4, words=10)
        s.apply({"op": "columns_set", "scope": "document", "columns": 2, "gap_mm": 12, "flow": "rtl"}, None)
        d = self.docx(s)
        self.assertEqual(len(d.sections), 1)
        element, attrs = self.cols_of(d.sections[0])
        self.assertEqual((attrs["num"], attrs.get("equalWidth")), ("2", None))
        self.assertEqual(attrs["space"], str(int(12 * 56.7)))
        self.assertIsNotNone(d.sections[0]._sectPr.find(qn("w:bidi")))

    def test_word_column_break_sits_at_the_start_of_the_blocks_own_paragraph(self):
        from docx.oxml.ns import qn
        s = self.paragraphs(count=4, words=5)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        s.apply({"op": "column_break", "block": ids[2]}, None)
        d = self.docx(s)
        paragraphs = [p for p in d.paragraphs if p.text.strip()]
        breaking = [p for p in d.paragraphs if p._p.findall(".//" + qn("w:br")) and p._p.find(".//" + qn("w:br")).get(qn("w:type")) == "column"]
        self.assertEqual(len(breaking), 1)
        self.assertTrue(breaking[0].text.startswith("p2w0"), breaking[0].text)
        self.assertEqual(len(paragraphs), 4, "no empty line was left behind")
        self.assertEqual(breaking[0]._p[1].tag if breaking[0]._p[0].tag == qn("w:pPr") else breaking[0]._p[0].tag, qn("w:r"))

    # -- RTF ----------------------------------------------------------------------------------------------------------------------
    def rtf(self, session, stem="layout"):
        report = self.ex.export(session, "rtf", self.root / "out", stem=stem)
        self.assertTrue(report["verification"]["ok"], report["verification"])
        return Path(report["path"]).read_text(encoding="ascii")

    def test_rtf_gets_a_continuous_section_with_columns_widths_and_separator(self):
        s = self.paragraphs(count=8, words=10)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[2], "end_block": ids[4], "columns": 2, "gap_mm": 8,
                 "widths_mm": [40, 80], "rule": {}}, None)
        text = self.rtf(s)
        sections = re.findall(r"\\sectd[^ ]*", text)
        self.assertEqual(len(sections), 3)
        self.assertIn("\\sbkpage", sections[0])
        self.assertIn("\\sbknone", sections[1])
        self.assertIn("\\sbknone", sections[2])
        widths = [int(x) for x in re.findall(r"\\colw(\d+)", sections[1])]
        self.assertEqual(len(widths), 2)
        self.assertLessEqual(abs(widths[0] - 40 * 152 / 120 * 56.7), 1)                   # scaled to fill the 160 mm line less the 8 mm gap
        self.assertLessEqual(abs(widths[1] - 80 * 152 / 120 * 56.7), 1)
        self.assertRegex(sections[1], r"\\cols2\\colno1\\colw\d+\\colsr%d\\colno2" % round(8 * 56.7))
        self.assertIn("\\linebetcol", sections[1])
        self.assertNotIn("\\cols", sections[2])

    def test_rtf_column_break_is_in_the_blocks_paragraph(self):
        s = self.paragraphs(count=4, words=5)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "document", "columns": 2}, None)
        s.apply({"op": "column_break", "block": ids[2]}, None)
        text = self.rtf(s)
        self.assertEqual(text.count("\\column "), 1)
        self.assertRegex(text, r"\\column p2w0")

    # -- an independent reader ----------------------------------------------------------------------------------------------------
    def through_libreoffice(self, path):
        """Print the exported Word/RTF file with LibreOffice (a reader that is not ours) and return the positions of the words in the result."""
        import shutil
        import subprocess
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            self.skipTest("LibreOffice is not installed")
        out = self.root / "lo"
        out.mkdir(exist_ok=True)
        done = subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out), str(path)], capture_output=True, timeout=180,
                              env={**__import__("os").environ, "HOME": str(self.root)})
        pdf = out / (Path(path).stem + ".pdf")
        if done.returncode != 0 or not pdf.exists():
            self.skipTest("LibreOffice could not convert the file here")
        return self.positions(pdf)

    def test_libreoffice_reads_the_word_and_rtf_columns_as_we_wrote_them(self):
        s = self.paragraphs(count=10, words=40)
        ids = [b["id"] for b in s.doc["blocks"]]
        s.apply({"op": "columns_set", "scope": "selection", "block": ids[3], "end_block": ids[6], "columns": 2, "gap_mm": 10,
                 "widths_mm": [50, 80]}, None)
        for fmt in ("docx", "rtf"):
            report = self.ex.export(s, fmt, self.root / "out", stem="lo-" + fmt)
            pos = self.through_libreoffice(report["path"])
            left = 25 * 72 / 25.4
            inside = [w for n in (3, 4, 5, 6) for w in pos[n]]
            starts = sorted({round(w[1]) for w in inside})
            self.assertAlmostEqual(min(starts), left, delta=2, msg=fmt)
            second = left + (50 * 150 / 130 + 10) * 72 / 25.4              # the first column (scaled to fill the line) and the gap come before the second
            self.assertTrue(any(abs(x - second) < 3 for x in starts), (fmt, second, starts))
            self.assertEqual({w[0] for n in (2, 3, 6, 7) for w in pos[n]}, {1}, fmt)
            for n in (2, 7):                                                  # the text around the selection is back to one column
                self.assertGreater(max(w[2] for w in pos[n]), second + 60, (fmt, n))
            self.assertGreater(min(w[3] for w in pos[7]), max(w[4] for w in inside) - 1, fmt)

    # -- the contents in Word ----------------------------------------------------------------------------------------------------
    def contents_docx(self, **look):
        s = self.new_session("report", title="R")
        toc = self.ac.contents(s, after=None, look={"preset": "classic", **look})["tocId"]
        for n in range(3):                                                   # push the later headings onto later pages
            s.apply({"op": "block_insert", "after": [b["id"] for b in s.doc["blocks"] if b["type"] == "heading"][1], "block":
                     {"type": "paragraph", "text": words_of(n, 400)}}, None)
        self.ac.refresh(s, toc) if hasattr(self.ac, "refresh") else None
        report = self.ex.export(s, "docx", self.root / "out", stem="toc-" + "-".join(look.values()))
        self.assertTrue(report["verification"]["ok"], report["verification"])
        import docx
        return s, report, docx.Document(report["path"])

    def test_word_contents_entries_get_leader_tab_and_a_page_reference_to_a_bookmark(self):
        from docx.oxml.ns import qn
        s, report, d = self.contents_docx(leader="dashes")
        entries = [p for p in d.paragraphs if p._p.findall(".//" + qn("w:instrText")) and "PAGEREF" in "".join(i.text for i in p._p.iter(qn("w:instrText")))]
        headings = [b for b in s.doc["blocks"] if b["type"] == "heading"]
        self.assertEqual(len(entries), len(headings))
        names = {b.get(qn("w:name")) for b in d.element.body.iter(qn("w:bookmarkStart"))}
        for p in entries:
            tabs = p._p.findall(".//" + qn("w:tab"))
            self.assertTrue(any(t.get(qn("w:leader")) == "hyphen" and t.get(qn("w:val")) == "right" for t in tabs), [t.attrib for t in tabs])
            target = re.search(r"PAGEREF (\S+)", "".join(i.text for i in p._p.iter(qn("w:instrText")))).group(1)
            self.assertIn(target, names)
        labels = self.ex.layout(s)["blockLabels"]
        cached = [p.text.split("\t")[-1].strip() for p in entries]
        self.assertTrue(set(cached) <= set(labels.values()) and cached == sorted(cached, key=int), cached)
        self.assertTrue(any("page numbers in the table of contents" in w for w in report["warnings"]), report["warnings"])

    def test_word_contents_placement_and_leader_kinds(self):
        from docx.oxml.ns import qn
        for kind, word in (("dots", "dot"), ("solid", "underscore"), ("none", None)):
            _, _, d = self.contents_docx(leader=kind)
            entry = next(p for p in d.paragraphs if "PAGEREF" in "".join(i.text for i in p._p.iter(qn("w:instrText"))))
            leaders = [t.get(qn("w:leader")) for t in entry._p.findall(".//" + qn("w:tab")) if t.get(qn("w:val")) == "right"]
            self.assertEqual(leaders, [word] if word else [None], kind)
        _, _, d = self.contents_docx(page_align="inline")
        entry = next(p for p in d.paragraphs if "PAGEREF" in "".join(i.text for i in p._p.iter(qn("w:instrText"))))
        self.assertFalse(entry._p.findall(".//" + qn("w:tab")) and any(t.get(qn("w:val")) == "right" for t in entry._p.findall(".//" + qn("w:tab"))))
        self.assertRegex(entry.text, r"\S\s{2,}\d+$")
        _, _, d = self.contents_docx(page_align="left")
        entry = next(p for p in d.paragraphs if "PAGEREF" in "".join(i.text for i in p._p.iter(qn("w:instrText"))))
        self.assertRegex(entry.text, r"^\d+\s+\S")

    def test_libreoffice_computes_the_same_contents_page_numbers_from_the_word_fields(self):
        s, report, d = self.contents_docx(leader="dots")
        import shutil
        import subprocess
        soffice = shutil.which("soffice") or shutil.which("libreoffice")
        if not soffice:
            self.skipTest("LibreOffice is not installed")
        out = self.root / "lo2"
        out.mkdir()
        done = subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(out), report["path"]], capture_output=True, timeout=180,
                              env={**__import__("os").environ, "HOME": str(self.root)})
        pdf = out / (Path(report["path"]).stem + ".pdf")
        if done.returncode != 0 or not pdf.exists():
            self.skipTest("LibreOffice could not convert the file here")
        with pdfplumber.open(pdf) as doc:
            texts = [(page.extract_text() or "") for page in doc.pages]
        rows = {m.group(1): int(m.group(2)) for m in re.finditer(r"^(Abstract|Introduction|Method|Results|Discussion|References)\W+(\d+)\s*$", texts[0], re.M)}
        self.assertEqual(len(rows), 6, texts[0][:400])
        for name, number in rows.items():                         # the field LibreOffice computed is the page the heading really is on
            actual = next(i for i, text in enumerate(texts, 1) if any(line.strip() == name for line in text.splitlines()))
            self.assertEqual(actual, number, (name, rows))
        from docx.oxml.ns import qn
        cached = {}
        for p in d.paragraphs:
            if "PAGEREF" in "".join(i.text for i in p._p.iter(qn("w:instrText"))):
                name, _, number = p.text.partition("\t")
                cached[name.strip()] = int(number)
        # The number Writer cached comes from its own PDF layout. Another program lays the pages out a little differently (here LibreOffice
        # puts "Introduction" on page 1, Writer's PDF on page 2), which is why the export tells the person to update the fields in Word.
        self.assertEqual(set(cached), set(rows))
        self.assertTrue(all(abs(cached[k] - rows[k]) <= 1 for k in rows), (cached, rows))

    def test_rtf_contents_have_leader_tab_bookmarks_and_page_references_and_libreoffice_reads_them(self):
        s = self.new_session("report", title="R")
        toc = self.ac.contents(s, after=None, look={"preset": "classic", "leader": "dashes"})["tocId"]
        self.assertTrue(toc)
        report = self.ex.export(s, "rtf", self.root / "out", stem="toc-rtf")
        text = Path(report["path"]).read_text(encoding="ascii")
        self.assertEqual(text.count("PAGEREF"), 6)
        self.assertEqual(text.count("\\*\\bkmkstart"), text.count("\\*\\bkmkend"))
        self.assertGreaterEqual(text.count("\\*\\bkmkstart"), 6)
        self.assertEqual(text.count("\\tqr\\tlhyph\\tx"), 6)
        names = set(re.findall(r"\\bkmkstart (\S+?)\}", text))
        self.assertTrue(set(re.findall(r"PAGEREF (\S+) ", text)) <= names)
        self.assertTrue(any("page numbers in the table of contents" in w for w in report["warnings"]))
        positions = self.through_libreoffice(report["path"])                  # it opens and shows the text
        self.assertIsInstance(positions, dict)
        import shutil
        if shutil.which("soffice"):
            with pdfplumber.open(self.root / "lo" / "toc-rtf.pdf") as pdf:
                first = pdf.pages[0].extract_text()
            self.assertRegex(first, r"Method\s*(?:- ?){5,}\s*\d+")


if __name__ == "__main__":
    unittest.main()
