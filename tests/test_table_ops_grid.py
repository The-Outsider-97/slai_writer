"""Row and column insertion/deletion, merging, splitting, borders and styles on tables, including merged cells, and a randomized sequence."""
import copy
import random
import unittest

from applications.slai_writer.session import sldc
from applications.slai_writer.tableops import BORDERS_KEY, CELLS_KEY, LAYOUT_KEY, STYLE_KEY, Grid
from applications.slai_writer.tests.helpers import Workbench

TID = "t1"


def edit(action, **kw):
    return {"op": "table_edit", "block": TID, "action": action, **kw}


class GridOps(Workbench):
    def make(self, rows=3, columns=3, fill=True):
        session = self.new_session(text="Intro")
        session.apply({"op": "block_insert", "after": session.doc["blocks"][-1]["id"],
                       "block": {"id": TID, "type": "table", "rows": rows, "columns": columns}}, None)
        if fill:
            for r in range(rows):
                for c in range(columns):
                    session.apply({"op": "table_cell", "block": TID, "row": r, "col": c, "text": f"{r}{c}"}, None)
        return session

    def block(self, session):
        return next(b for b in session.doc["blocks"] if b["id"] == TID)

    def texts(self, session):
        return [[c["text"] for c in row] for row in self.block(session)["table"]["rows"]]

    def valid(self, session):
        """The authoritative SLDC validation accepts the table, and every Writer extension still points at something that exists."""
        saved = sldc().loads_package(session.to_bytes()).document
        block = next(b for b in saved["blocks"] if b["id"] == TID)
        table = block["table"]
        grid = Grid(table)
        ext = block.get("extensions", {})
        keys = {c.key for c in grid.cells}
        for key in ext.get(CELLS_KEY, {}):
            self.assertIn(key, keys)
        for key in ext.get(BORDERS_KEY, {}).get("h", {}):
            line, col = map(int, key.split(","))
            self.assertTrue(0 <= line <= grid.n_rows and 0 <= col < grid.columns, key)
        for key in ext.get(BORDERS_KEY, {}).get("v", {}):
            row, line = map(int, key.split(","))
            self.assertTrue(0 <= row < grid.n_rows and 0 <= line <= grid.columns, key)
        layout = ext.get(LAYOUT_KEY, {})
        if "column_widths_mm" in layout:
            self.assertEqual(len(layout["column_widths_mm"]), grid.columns)
        if "row_heights_mm" in layout:
            self.assertEqual(len(layout["row_heights_mm"]), grid.n_rows)
        self.assertLessEqual(table.get("header_rows", 0), grid.n_rows)
        return block

    # ---- plain tables
    def test_insert_rows_and_columns_above_below_left_right_and_several_at_once(self):
        session = self.make()
        session.apply(edit("insert_row", index=1), None)
        self.assertEqual(self.texts(session), [["00", "01", "02"], ["", "", ""], ["10", "11", "12"], ["20", "21", "22"]])
        session.apply(edit("insert_row", index=4, count=2), None)
        self.assertEqual(len(self.texts(session)), 6)
        session.apply(edit("insert_col", index=3, count=2), None)
        self.assertEqual({len(r) for r in self.texts(session)}, {5})
        session.apply(edit("insert_col", index=0), None)
        self.assertEqual(self.texts(session)[0], ["", "00", "01", "02", "", ""])
        self.valid(session)

    def test_delete_rows_and_columns_several_at_once_and_keep_at_least_one(self):
        session = self.make(4, 4)
        session.apply(edit("delete_row", index=1, count=2), None)
        self.assertEqual(self.texts(session), [["00", "01", "02", "03"], ["30", "31", "32", "33"]])
        session.apply(edit("delete_col", index=0, count=2), None)
        self.assertEqual(self.texts(session), [["02", "03"], ["32", "33"]])
        for action in ("delete_row", "delete_col"):
            with self.assertRaises(Exception):
                session.apply(edit(action, index=0, count=2), None)
        self.valid(session)

    def test_header_rows_follow_insertions_and_deletions(self):
        session = self.make()
        session.apply(edit("header_rows", count=2), None)
        session.apply(edit("insert_row", index=0), None)                 # above the header: part of it
        self.assertEqual(self.block(session)["table"]["header_rows"], 3)
        session.apply(edit("insert_row", index=3), None)                 # directly below it: not
        self.assertEqual(self.block(session)["table"]["header_rows"], 3)
        session.apply(edit("delete_row", index=0, count=2), None)
        self.assertEqual(self.block(session)["table"]["header_rows"], 1)

    def test_new_cells_inherit_alignment_and_formatting_of_the_neighbour(self):
        session = self.make()
        session.apply({"op": "table_cell_style", "block": TID, "row": 1, "col": 1, "props": {"background": "#112233", "align": "right"}}, None)
        session.apply(edit("insert_row", index=2), None)                  # below the styled cell
        block = self.valid(session)
        self.assertEqual(block["extensions"][CELLS_KEY]["1,1"]["background"], "#112233")
        self.assertEqual(block["extensions"][CELLS_KEY]["2,1"]["background"], "#112233")
        self.assertEqual(block["table"]["rows"][2][1].get("align"), "right")

    # ---- merged cells
    def merged(self):
        session = self.make(4, 4)
        session.apply(edit("merge_cells", row=1, col=1, end_row=2, end_col=2), None)
        return session

    def test_merge_joins_text_and_blocks_half_merged_results(self):
        session = self.merged()
        cell = self.block(session)["table"]["rows"][1][1]
        self.assertEqual((cell["rowspan"], cell["colspan"], cell["text"]), (2, 2, "11\n12\n21\n22"))
        # selecting part of the merged cell and a neighbour grows the selection to whole cells
        session.apply(edit("merge_cells", row=1, col=1, end_row=1, end_col=2), None)
        merged = self.block(session)["table"]["rows"][1][1]
        self.assertEqual((merged["rowspan"], merged["colspan"]), (2, 3))
        self.valid(session)
        with self.assertRaises(Exception):
            session.apply(edit("merge_cells", row=0, col=0), None)         # one cell is nothing to merge

    def test_inserting_inside_a_merged_cell_makes_it_taller_or_wider(self):
        session = self.merged()
        session.apply(edit("insert_row", index=2), None)                  # between its two rows
        cell = self.block(session)["table"]["rows"][1][1]
        self.assertEqual(cell["rowspan"], 3)
        self.assertEqual(len(self.block(session)["table"]["rows"][2]), 2)  # only the two cells outside it are new
        session.apply(edit("insert_col", index=2), None)
        self.assertEqual(self.block(session)["table"]["rows"][1][1]["colspan"], 3)
        self.valid(session)

    def test_inserting_at_the_edge_of_a_merged_cell_does_not_grow_it(self):
        session = self.merged()
        for action, index in (("insert_row", 1), ("insert_row", 3), ("insert_col", 1), ("insert_col", 3)):
            session = self.merged()
            session.apply(edit(action, index=index), None)
            cell = next(c for row in self.block(session)["table"]["rows"] for c in row if c["text"].startswith("11"))
            self.assertEqual((cell.get("rowspan", 1), cell.get("colspan", 1)), (2, 2), (action, index))
            self.valid(session)

    def test_deleting_through_a_merged_cell_shrinks_it_and_keeps_its_content(self):
        session = self.merged()
        session.apply(edit("delete_row", index=2), None)                  # its second row
        cell = self.block(session)["table"]["rows"][1][1]
        self.assertEqual((cell.get("rowspan", 1), cell["text"]), (1, "11\n12\n21\n22"))
        session = self.merged()
        session.apply(edit("delete_row", index=1), None)                  # its first row: the cell moves up and keeps its text
        cell = self.block(session)["table"]["rows"][1][1]
        self.assertEqual((cell.get("rowspan", 1), cell["text"]), (1, "11\n12\n21\n22"))
        session = self.merged()
        session.apply(edit("delete_row", index=1, count=2), None)         # wholly inside: gone
        self.assertNotIn("11\n12\n21\n22", [c["text"] for row in self.texts(session) for c in [{"text": t} for t in row]])
        self.valid(session)

    def test_every_boundary_of_every_merge_keeps_a_valid_table(self):
        shapes = [(0, 0, 1, 1), (1, 1, 2, 2), (0, 1, 3, 1), (2, 0, 2, 3), (0, 0, 3, 3)]
        for r0, c0, r1, c1 in shapes:
            for action in ("insert_row", "insert_col", "delete_row", "delete_col"):
                limit = 5 if action.startswith("insert_") else 4
                for index in range(limit):
                    for count in (1, 2):
                        session = self.make(4, 4)
                        session.apply(edit("merge_cells", row=r0, col=c0, end_row=r1, end_col=c1), None) if (r0, c0) != (r1, c1) else None
                        before = copy.deepcopy(self.block(session))
                        try:
                            session.apply(edit(action, index=index, count=count), None)
                        except Exception:
                            self.assertEqual(self.block(session), before)    # a refused edit changes nothing
                            continue
                        self.valid(session)
                        session.undo(None)
                        self.assertEqual(self.block(session), before)

    def test_split_cell_back_into_grid_positions_and_into_more_parts(self):
        session = self.merged()
        session.apply(edit("split_cell", row=1, col=1), None)
        self.assertEqual({len(r) for r in self.texts(session)}, {4})
        self.valid(session)
        session = self.make(2, 2)
        session.apply(edit("split_cell", row=0, col=0, cols=3), None)       # more parts than it spans: columns are added elsewhere too
        table = self.block(session)["table"]
        self.assertEqual(table["columns"], 4)
        self.assertEqual(len(table["rows"][0]), 4)
        self.assertEqual(table["rows"][1][0]["colspan"], 3)                 # the cell below spans the new columns, so nothing else moves
        self.valid(session)
        session.undo(None)
        self.assertEqual(self.block(session)["table"]["columns"], 2)

    def test_layout_borders_and_styles_follow_structure(self):
        session = self.make()
        session.apply({"op": "table_layout", "block": TID, "props": {"column_widths_mm": [20, 30, 40], "row_heights_mm": [8, 9, 10]}}, None)
        session.apply({"op": "table_borders", "block": TID, "target": "all", "border": {"color": "#112233", "width_pt": 2, "style": "dashed"}}, None)
        session.apply({"op": "table_borders", "block": TID, "target": "bottom", "row": 1, "col": 1, "end_row": 1, "end_col": 1, "border": None}, None)
        session.apply(edit("insert_row", index=1), None)
        session.apply(edit("insert_col", index=3), None)
        block = self.valid(session)
        self.assertEqual(block["extensions"][LAYOUT_KEY]["row_heights_mm"], [8, 8, 9, 10])
        self.assertEqual(block["extensions"][LAYOUT_KEY]["column_widths_mm"], [20, 30, 40, 40])
        h = block["extensions"][BORDERS_KEY]["h"]
        self.assertEqual(h["0,0"]["style"], "dashed")
        self.assertIn("4,0", h)                                           # the old bottom line moved down with its row
        self.assertNotIn("3,1", h)                                        # the line the person cleared stays cleared
        session.undo(None)
        session.undo(None)
        self.assertEqual(self.block(session)["extensions"][LAYOUT_KEY]["column_widths_mm"], [20, 30, 40])

    # ---- borders
    def test_borders_every_target_and_shared_edges(self):
        spec = {"color": "#ff0000", "width_pt": 1, "style": "solid"}
        for target, count in (("outside", 12), ("inside", 12), ("inside_h", 6), ("inside_v", 6), ("top", 3), ("bottom", 3), ("left", 3), ("right", 3), ("all", 24)):
            session = self.make()
            session.apply({"op": "table_borders", "block": TID, "target": target, "border": spec}, None)
            ext = self.valid(session)["extensions"][BORDERS_KEY]
            self.assertEqual(len(ext["h"]) + len(ext["v"]), count, target)
        session = self.make()
        session.apply({"op": "table_borders", "block": TID, "target": "all", "border": spec}, None)
        session.apply({"op": "table_borders", "block": TID, "target": "none", "row": 0, "col": 0, "end_row": 0, "end_col": 0, "border": None}, None)
        ext = self.valid(session)["extensions"][BORDERS_KEY]
        self.assertIsNone(ext["h"]["0,0"])                                 # explicit "no border" is kept, it is not "inherit"
        session.apply({"op": "table_borders", "block": TID, "target": "outside", "row": 0, "col": 0, "end_row": 0, "end_col": 0, "border": None}, None)
        self.assertNotIn("0,0", self.valid(session)["extensions"][BORDERS_KEY]["h"])

    def test_cell_border_is_written_to_the_shared_edges(self):
        session = self.make()
        session.apply({"op": "table_cell_style", "block": TID, "row": 0, "col": 0, "props": {"border_color": "#00ff00", "border_width_pt": 2, "border_style": "double"}}, None)
        session.apply({"op": "table_cell_style", "block": TID, "row": 0, "col": 1, "props": {"border_color": "#0000ff"}}, None)
        edges = self.valid(session)["extensions"][BORDERS_KEY]
        self.assertEqual(edges["v"]["0,1"]["color"], "#0000FF")           # the shared edge: the later edit wins, deterministically
        self.assertEqual(edges["h"]["0,0"]["style"], "double")

    def test_border_validation(self):
        session = self.make()
        for border in ({"color": "red"}, {"width_pt": 99}, {"style": "groove"}, {"nope": 1}, "x"):
            with self.assertRaises(Exception):
                session.apply({"op": "table_borders", "block": TID, "target": "all", "border": border}, None)
        with self.assertRaises(Exception):
            session.apply({"op": "table_borders", "block": TID, "target": "diagonal", "border": None}, None)

    # ---- styles
    def test_style_options_clear_and_saved_styles(self):
        session = self.make()
        session.apply({"op": "table_style", "block": TID, "preset": "professional_report", "accent": "#aa3300"}, None)
        session.apply({"op": "table_style", "block": TID, "banded_rows": False}, None)
        style = self.valid(session)["extensions"][STYLE_KEY]
        self.assertEqual(style, {"preset": "professional_report", "accent": "#aa3300", "banded_rows": False})
        session.apply({"op": "table_style_define", "block": TID, "name": "House style"}, None)
        session.apply({"op": "table_style", "block": TID, "preset": "custom:House style"}, None)
        self.valid(session)
        with self.assertRaises(Exception):
            session.apply({"op": "table_style", "block": TID, "preset": "custom:Nothing"}, None)
        with self.assertRaises(Exception):
            session.apply({"op": "table_style", "block": TID, "preset": "bogus"}, None)
        session.apply({"op": "table_borders", "block": TID, "target": "all", "border": {"style": "solid"}}, None)
        session.apply({"op": "table_style", "block": TID, "clear": True}, None)
        ext = self.valid(session).get("extensions", {})
        self.assertNotIn(STYLE_KEY, ext)
        self.assertNotIn(BORDERS_KEY, ext)
        session.apply({"op": "table_style_define", "block": TID, "name": "House style", "delete": True}, None)
        self.assertNotIn("table_styles", session.doc.get("extensions", {}).get("slai.writer", {}))

    def test_style_survives_save_and_reopen(self):
        session = self.make()
        session.apply({"op": "table_style", "block": TID, "preset": "academic"}, None)
        session.apply({"op": "table_borders", "block": TID, "target": "inside_h", "border": {"color": "#445566"}}, None)
        reopened = sldc().loads_package(session.to_bytes()).document
        block = next(b for b in reopened["blocks"] if b["id"] == TID)
        self.assertEqual(block["extensions"][STYLE_KEY]["preset"], "academic")
        self.assertEqual(block["extensions"][BORDERS_KEY]["h"]["1,0"]["color"], "#445566")

    def test_malformed_extensions_on_inserted_blocks_are_rejected(self):
        session = self.make()
        bad = {"id": "t2", "type": "table", "rows": 2, "columns": 2}
        session.apply({"op": "block_insert", "after": TID, "block": bad}, None)
        block = session.doc["blocks"][-1]
        for key, value in ((BORDERS_KEY, {"h": {"9,9": None}}), (LAYOUT_KEY, {"column_widths_mm": [1]}), (CELLS_KEY, {"zz": {}}), (STYLE_KEY, {"preset": "x"})):
            candidate = {**copy.deepcopy(block), "id": "t3", "extensions": {key: value}}
            with self.assertRaises(Exception):
                session.apply({"op": "block_insert", "after": TID, "block": candidate}, None)

    # ---- randomized
    def test_random_edit_sequences_keep_every_invariant(self):
        for seed in range(25):
            rng = random.Random(seed)
            session = self.make(rng.randint(1, 4), rng.randint(1, 4))
            history = []
            for _ in range(30):
                table = self.block(session)["table"]
                grid = Grid(table)
                pick = rng.choice(["insert_row", "insert_col", "delete_row", "delete_col", "merge", "split", "border", "style", "layout", "header"])
                if pick in ("insert_row", "insert_col"):
                    n = grid.n_rows if pick == "insert_row" else grid.columns
                    op = edit(pick, index=rng.randint(0, n), count=rng.randint(1, 2))
                elif pick in ("delete_row", "delete_col"):
                    n = grid.n_rows if pick == "delete_row" else grid.columns
                    op = edit(pick, index=rng.randrange(n), count=rng.randint(1, 2))
                elif pick in ("merge", "split"):
                    a, b = rng.choice(grid.cells), rng.choice(grid.cells)
                    ka, kb = map(int, a.key.split(",")), map(int, b.key.split(","))
                    ka, kb = list(ka), list(kb)
                    op = edit("merge_cells", row=ka[0], col=ka[1], end_row=kb[0], end_col=kb[1]) if pick == "merge" else edit("split_cell", row=ka[0], col=ka[1], **({"cols": 2} if rng.random() < .4 else {}))
                elif pick == "border":
                    c = rng.choice(grid.cells)
                    r, i = map(int, c.key.split(","))
                    op = {"op": "table_borders", "block": TID, "target": rng.choice(["all", "outside", "inside_h", "top", "none"]), "row": r, "col": i,
                          "border": rng.choice([None, {"color": "#abcdef", "width_pt": 1, "style": "dotted"}])}
                elif pick == "style":
                    op = {"op": "table_cell_style", "block": TID, "row": 0, "col": 0, "props": {"background": "#%06x" % rng.randrange(1 << 24)}}
                elif pick == "layout":
                    op = {"op": "table_layout", "block": TID, "props": {"column_widths_mm": [rng.randint(10, 60) for _ in range(grid.columns)]}}
                else:
                    op = edit("header_rows", count=rng.randint(0, grid.n_rows))
                before = copy.deepcopy(self.block(session))
                try:
                    session.apply(op, None)
                except Exception:
                    self.assertEqual(self.block(session), before, (seed, op))
                    continue
                self.valid(session)
                history.append(before)
                if rng.random() < 0.3:
                    session.undo(None)
                    self.assertEqual(self.block(session), history.pop(), (seed, op))
            while history:                                                # undo all the way back restores every state exactly
                session.undo(None)
                self.assertEqual(self.block(session), history.pop())


if __name__ == "__main__":
    unittest.main()
