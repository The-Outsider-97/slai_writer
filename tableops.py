"""Table operations: cell text, structure (insert, delete, merge, split at any position), layout, cell formatting, styles and borders.

A table is stored the way ``.sldc`` stores it: ``{"columns", "header_rows", "rows"}``, where ``rows`` lists, for every row, only the cells that
*start* in it (a cell covered by a ``rowspan`` from above, or by a ``colspan`` to its left, is simply not listed). Everything Writer adds
(widths, heights, cell formatting, borders, the table style) is kept in namespaced, inert block extensions, which other readers preserve:

``slai.writer.table_layout``       ``width_mm``, ``column_widths_mm``, ``row_heights_mm``, ``align``, ``indent_mm``, ``fit`` …
``slai.writer.table_cell_styles``  ``"row,cell"`` -> formatting of one cell (``cell`` is the cell's position in its row's list)
``slai.writer.table_borders``      ``{"h": {"line,column": border|null}, "v": {"row,line": border|null}}``: one entry per *edge of the grid*
``slai.writer.table_style``        ``{"preset", "accent", "header_row", "first_column", "banded_rows", "banded_columns"}``

Borders are stored per grid edge, not per cell, so two cells that share an edge can never disagree about it.

Rules for merged cells (the same ones in every operation, so the result of an edit is always predictable and always a valid table):

* inserting rows (columns) *inside* a merged cell makes that cell taller (wider); everywhere else a new empty cell is created;
* deleting rows (columns) shrinks a merged cell that overlaps them; a merged cell that starts in a deleted row (column) but continues past it
  keeps its content and moves to the first row (column) that remains; only cells wholly inside the deleted rows (columns) are removed;
* merging expands the chosen rectangle until it holds only whole cells, then joins their text (non-empty cells, one line each);
* splitting gives every grid position its own cell again, or splits into a given number of parts (inserting grid lines when the cell has to
  become more parts than it spans).
"""
from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..tools.errors import LimitExceeded
from . import textmodel as tm
from .ops import MAX_TABLE_CELLS, OpError, Tracker, _COLOUR, _d, _i, _s, handler
from . import table_styles as ts

LAYOUT_KEY = "slai.writer.table_layout"
CELLS_KEY = "slai.writer.table_cell_styles"
BORDERS_KEY = "slai.writer.table_borders"
STYLE_KEY = "slai.writer.table_style"
TABLE_EXT_KEYS = (LAYOUT_KEY, CELLS_KEY, BORDERS_KEY, STYLE_KEY)

MAX_ROWS = 10_000
MAX_COLUMNS = 256
MAX_CELL_CHARS = 100_000
MIN_COLUMN_MM, MIN_ROW_MM = 4.0, 4.0
BORDER_STYLES = ("solid", "dashed", "dotted", "double", "none")
_ALIGNS = ("left", "center", "right", "justify")
_VALIGNS = ("top", "middle", "bottom")


# ------------------------------------------------------------------------------------------------------------------ the grid
@dataclass(eq=False)
class Cell:
    """One cell with its place on the grid. ``data`` is the SLDC cell (text, spans, align, header)."""
    r: int
    c: int
    rs: int
    cs: int
    data: dict[str, Any]
    key: str | None = None                    # where its formatting is stored now ("row,position in row"); None for a new cell
    source: "Cell | None" = None              # a cell this one inherits its formatting from

    @property
    def bottom(self) -> int:
        return self.r + self.rs

    @property
    def right(self) -> int:
        return self.c + self.cs


class Grid:
    """The cells of a table with their grid positions; edits change positions and spans, :meth:`rows` writes the table back."""

    def __init__(self, table: dict[str, Any]) -> None:
        self.columns: int = table["columns"]
        self.header_rows: int = table.get("header_rows", 0)
        self.cells: list[Cell] = []
        carry = [0] * self.columns
        for r, row in enumerate(table["rows"]):
            occupied = [v > 0 for v in carry]
            column = 0
            starts: list[Cell] = []
            for index, data in enumerate(row):
                while column < self.columns and occupied[column]:
                    column += 1
                cs, rs = data.get("colspan", 1), data.get("rowspan", 1)
                if column + cs > self.columns:
                    raise OpError("This table is malformed (a cell runs past the last column)")
                cell = Cell(r, column, rs, cs, data, key=f"{r},{index}")
                starts.append(cell)
                self.cells.append(cell)
                column += cs
            carry = [max(v - 1, 0) for v in carry]
            for cell in starts:
                for c in range(cell.c, cell.right):
                    carry[c] = cell.rs - 1
        self.n_rows: int = len(table["rows"])

    # ---- reading
    def covering(self, r: int, c: int) -> Cell | None:
        for cell in self.cells:
            if cell.r <= r < cell.bottom and cell.c <= c < cell.right:
                return cell
        return None

    def by_key(self, row: int, col: int) -> Cell:
        found = next((cell for cell in self.cells if cell.key == f"{row},{col}"), None)
        if found is None:
            raise OpError("That table cell does not exist")
        return found

    # ---- writing
    def rows(self) -> tuple[list[list[dict[str, Any]]], dict[Cell, str]]:
        """The table's rows again (and each cell's new formatting key). Raises when the cells leave a hole or overlap, which would be a bug."""
        grid = [[None] * self.columns for _ in range(self.n_rows)]
        for cell in self.cells:
            if cell.r < 0 or cell.c < 0 or cell.bottom > self.n_rows or cell.right > self.columns or cell.rs < 1 or cell.cs < 1:
                raise OpError("The change would leave the table malformed")
            for r in range(cell.r, cell.bottom):
                for c in range(cell.c, cell.right):
                    if grid[r][c] is not None:
                        raise OpError("The change would make two table cells overlap")
                    grid[r][c] = cell
        if any(slot is None for line in grid for slot in line):
            raise OpError("The change would leave a hole in the table")
        out: list[list[dict[str, Any]]] = [[] for _ in range(self.n_rows)]
        keys: dict[Cell, str] = {}
        for cell in sorted(self.cells, key=lambda x: (x.r, x.c)):
            data = cell.data
            for name, value in (("colspan", cell.cs), ("rowspan", cell.rs)):
                if value > 1:
                    data[name] = value
                else:
                    data.pop(name, None)
            keys[cell] = f"{cell.r},{len(out[cell.r])}"
            out[cell.r].append(data)
        return out, keys


def _new_cell(r: int, c: int, source: Cell | None, rs: int = 1, cs: int = 1) -> Cell:
    data: dict[str, Any] = {"text": ""}
    if source is not None:
        for key in ("align", "header"):
            if key in source.data:
                data[key] = source.data[key]
    return Cell(r, c, rs, cs, data, source=source)


# ---------------------------------------------------------------------------------------------------- the extension data
def _ext(block: dict[str, Any]) -> dict[str, Any]:
    ext = block.get("extensions")
    if not isinstance(ext, dict):
        ext = block["extensions"] = {}
    return ext


def _tidy_ext(block: dict[str, Any]) -> None:
    ext = block.get("extensions")
    if isinstance(ext, dict):
        for key in TABLE_EXT_KEYS:
            if key in ext and not ext[key]:
                del ext[key]
        if ext.get("slai.writer.table_borders") == {"h": {}, "v": {}}:
            del ext["slai.writer.table_borders"]
        if not ext:
            block.pop("extensions", None)


def _store(block: dict[str, Any], key: str, value: Any) -> None:
    if value in (None, {}, []):
        ext = block.get("extensions")
        if isinstance(ext, dict):
            ext.pop(key, None)
    else:
        _ext(block)[key] = value
    _tidy_ext(block)


def _styles_of(block: dict[str, Any]) -> dict[str, Any]:
    value = (block.get("extensions") or {}).get(CELLS_KEY)
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _edges_of(block: dict[str, Any]) -> dict[str, dict[str, Any]]:
    value = (block.get("extensions") or {}).get(BORDERS_KEY)
    out: dict[str, dict[str, Any]] = {"h": {}, "v": {}}
    if isinstance(value, dict):
        for axis in ("h", "v"):
            if isinstance(value.get(axis), dict):
                out[axis] = copy.deepcopy(value[axis])
    return out


def _layout_of(block: dict[str, Any]) -> dict[str, Any]:
    value = (block.get("extensions") or {}).get(LAYOUT_KEY)
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _rebuild(block: dict[str, Any], grid: Grid, *, styles: dict[str, Any], edges: dict[str, dict[str, Any]], layout: dict[str, Any]) -> None:
    """Write grid, formatting keys, edges and layout back after a structural change."""
    rows, keys = grid.rows()
    block["table"] = {"columns": grid.columns, "header_rows": min(grid.header_rows, len(rows)), "rows": rows}
    new_styles: dict[str, Any] = {}
    for cell in grid.cells:
        origin = cell.key if cell.key is not None else (cell.source.key if cell.source is not None else None)
        if origin is not None and origin in styles:
            new_styles[keys[cell]] = copy.deepcopy(styles[origin])
    for cell in grid.cells:                                          # from now on a cell is known by where it is stored
        cell.key, cell.source = keys[cell], None
    for axis in ("h", "v"):                                           # inside a merged cell there is nothing to draw
        for cell in grid.cells:
            if cell.rs > 1 or cell.cs > 1:
                for key in [k for k in edges[axis] if _inside_cell(axis, k, cell)]:
                    del edges[axis][key]
    _store(block, CELLS_KEY, new_styles)
    _store(block, BORDERS_KEY, {"h": edges["h"], "v": edges["v"]} if edges["h"] or edges["v"] else None)
    for name, size in (("column_widths_mm", grid.columns), ("row_heights_mm", len(rows))):
        if name in layout and (not isinstance(layout[name], list) or len(layout[name]) != size):
            layout.pop(name)                                           # a list of the wrong length cannot be mapped; the browser lays it out
    _store(block, LAYOUT_KEY, layout)


def _check_size(rows: int, columns: int) -> None:
    if rows > MAX_ROWS or columns > MAX_COLUMNS or rows * columns > MAX_TABLE_CELLS:
        raise LimitExceeded("The table would become too large")


def _count(op: dict[str, Any], default: int = 1) -> int:
    value = _i(op, "count", 1, 1000, required=False)
    return default if value is None else value


# ---- moving edges and sizes along with a structural change
def _shift_list(values: Any, index: int, count: int, source: int) -> Any:
    if not isinstance(values, list):
        return values
    source = min(max(source, 0), len(values) - 1) if values else 0
    return values[:index] + [values[source]] * count + values[index:] if values else values


def _drop_list(values: Any, index: int, count: int) -> Any:
    return values[:index] + values[index + count:] if isinstance(values, list) else values


def _edge_key(a: int, b: int) -> str:
    return f"{a},{b}"


def _parse_key(key: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"(\d{1,5}),(\d{1,5})", key)
    return (int(match.group(1)), int(match.group(2))) if match else None


def _remap_edges(edges: dict[str, dict[str, Any]], h: Any, v: Any) -> dict[str, dict[str, Any]]:
    """``h`` and ``v`` map an old edge (line, position) to the list of new edges it becomes (usually one, none when it is gone)."""
    out: dict[str, dict[str, Any]] = {"h": {}, "v": {}}
    for axis, fn in (("h", h), ("v", v)):
        for key, spec in edges[axis].items():
            parsed = _parse_key(key)
            if parsed is None:
                continue
            for a, b in fn(*parsed):
                out[axis][_edge_key(a, b)] = copy.deepcopy(spec)
    return out


# ------------------------------------------------------------------------------------------------------------------ cell text
def _table(tr: Tracker, block_id: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    block = tr.get(block_id)
    if block["type"] != "table":
        raise OpError("This block is not a table")
    return block, block["table"]


def cell_of(table: dict[str, Any], row: int, col: int) -> dict[str, Any]:
    """The cell at ``row`` and position ``col`` in that row's list (the addressing every cell operation uses)."""
    rows = table["rows"]
    if row >= len(rows) or col >= len(rows[row]):
        raise OpError("That table cell does not exist")
    return rows[row][col]


@handler("table_cell")
def op_table_cell(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Replace the whole text of a cell. Only the part that really changed is replaced, so formatting elsewhere in the cell is kept."""
    _, table = _table(tr, op.get("block"))
    cell = cell_of(table, _i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS))
    text = _s(op, "text", limit=MAX_CELL_CHARS)
    old = cell["text"]
    if old == text:
        return {}
    prefix = 0
    while prefix < min(len(old), len(text)) and old[prefix] == text[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(len(old), len(text)) - prefix and old[len(old) - 1 - suffix] == text[len(text) - 1 - suffix]:
        suffix += 1
    try:
        tm.replace_text(cell, prefix, len(old) - suffix, text[prefix:len(text) - suffix])
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    return {}


@handler("table_cell_text")
def op_table_cell_text(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    _, table = _table(tr, op.get("block"))
    cell = cell_of(table, _i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS))
    start, end, insert = _i(op, "start"), _i(op, "end"), _s(op, "insert", required=False) or ""
    if len(cell["text"]) - (end - start) + len(insert) > MAX_CELL_CHARS:
        raise LimitExceeded("That cell would become longer than the format allows")
    try:
        tm.replace_text(cell, start, end, insert)
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    return {}


# --------------------------------------------------------------------------------------------------------- structure
def _insert_lines(block: dict[str, Any], grid: Grid, axis: str, index: int, count: int, *, within: bool = False) -> None:
    """Insert ``count`` rows (axis "row") or columns (axis "col") before grid line ``index``.

    With ``within`` the new lines are added *inside* the row (column) just before ``index``: every cell that covers it grows, which is what
    splitting a cell into more parts than it spans needs.
    """
    styles, edges, layout = _styles_of(block), _edges_of(block), _layout_of(block)
    rows = axis == "row"
    total = grid.n_rows if rows else grid.columns
    if not 0 <= index <= total:
        raise OpError(f"There is no {axis} position {index} in this table")
    _check_size(grid.n_rows + (count if rows else 0), grid.columns + (0 if rows else count))
    start = (lambda x: x.r) if rows else (lambda x: x.c)
    size = (lambda x: x.rs) if rows else (lambda x: x.cs)
    crossing = [cell for cell in grid.cells
                if start(cell) < index < start(cell) + size(cell) or (within and start(cell) < index == start(cell) + size(cell))]
    covered: set[int] = set()
    for cell in crossing:                                            # a merged cell the new lines run through grows to hold them
        covered.update(range(cell.c, cell.right) if rows else range(cell.r, cell.bottom))
    source_line = max(index - 1, 0) if total else 0
    sources: dict[int, Cell | None] = {}
    other = range(grid.columns) if rows else range(grid.n_rows)
    for position in other:
        sources[position] = grid.covering(source_line, position) if rows else grid.covering(position, source_line)
    for cell in grid.cells:
        if start(cell) >= index:
            if rows:
                cell.r += count
            else:
                cell.c += count
    for cell in crossing:
        if rows:
            cell.rs += count
        else:
            cs = cell.cs + count
            cell.cs = cs
    for position in other:
        if position in covered:
            continue
        for k in range(count):
            grid.cells.append(_new_cell(index + k, position, sources[position]) if rows else _new_cell(position, index + k, sources[position]))
    if rows:
        grid.n_rows += count
        if index < grid.header_rows or (within and index <= grid.header_rows):
            grid.header_rows += count
        layout["row_heights_mm"] = _shift_list(layout.get("row_heights_mm"), index, count, index - 1)
        edges = _remap_edges(
            edges,
            h=lambda line, col: ([(line + count, col)] + ([(line + k, col) for k in range(count)] if line == index else [])) if line >= index else [(line, col)],
            v=lambda row, line: ([(row + count, line)] if row >= index else [(row, line)]) + ([(index + k, line) for k in range(count)] if row == source_line else []))
    else:
        grid.columns += count
        layout["column_widths_mm"] = _shift_list(layout.get("column_widths_mm"), index, count, index - 1)
        edges = _remap_edges(
            edges,
            h=lambda line, col: ([(line, col + count)] if col >= index else [(line, col)]) + ([(line, index + k) for k in range(count)] if col == source_line else []),
            v=lambda row, line: ([(row, line + count)] + ([(row, line + k) for k in range(count)] if line == index else [])) if line >= index else [(row, line)])
    for name in ("column_widths_mm", "row_heights_mm"):
        if name in layout and layout[name] is None:
            layout.pop(name)
    _rebuild(block, grid, styles=styles, edges=edges, layout=layout)


def _delete_lines(block: dict[str, Any], grid: Grid, axis: str, index: int, count: int) -> None:
    styles, edges, layout = _styles_of(block), _edges_of(block), _layout_of(block)
    rows = axis == "row"
    total = grid.n_rows if rows else grid.columns
    if index < 0 or index + count > total:
        raise OpError(f"There is no such {axis} in this table")
    if count >= total:
        raise OpError(f"A table keeps at least one {axis}")
    end = index + count
    keep: list[Cell] = []
    for cell in grid.cells:
        top, bottom = (cell.r, cell.bottom) if rows else (cell.c, cell.right)
        if bottom <= index:
            keep.append(cell)
        elif top >= end:
            keep.append(cell)
            if rows:
                cell.r -= count
            else:
                cell.c -= count
        elif top >= index and bottom <= end:
            continue                                                  # wholly inside the deleted lines: gone
        else:
            if top < index and bottom <= end:                          # its far end is cut off
                new_top, new_size = top, index - top
            elif top < index:                                          # it spans the deleted lines
                new_top, new_size = top, (bottom - top) - count
            else:                                                      # it starts in them and continues: it keeps its content and moves up to the first line left
                new_top, new_size = index, bottom - end
            if rows:
                cell.r, cell.rs = new_top, new_size
            else:
                cell.c, cell.cs = new_top, new_size
            keep.append(cell)
    grid.cells = keep
    if rows:
        grid.n_rows -= count
        grid.header_rows = max(0, grid.header_rows - max(0, min(end, grid.header_rows) - index))
        layout["row_heights_mm"] = _drop_list(layout.get("row_heights_mm"), index, count)
        edges = _remap_edges(
            edges,
            h=lambda line, col: [(line, col)] if line <= index else ([] if line <= end else [(line - count, col)]),
            v=lambda row, line: [(row, line)] if row < index else ([] if row < end else [(row - count, line)]))
    else:
        grid.columns -= count
        layout["column_widths_mm"] = _drop_list(layout.get("column_widths_mm"), index, count)
        edges = _remap_edges(
            edges,
            h=lambda line, col: [(line, col)] if col < index else ([] if col < end else [(line, col - count)]),
            v=lambda row, line: [(row, line)] if line <= index else ([] if line <= end else [(row, line - count)]))
    _rebuild(block, grid, styles=styles, edges=edges, layout=layout)


def _rectangle(grid: Grid, a: Cell, b: Cell) -> tuple[int, int, int, int]:
    """The smallest rectangle holding both cells, grown until it holds only whole cells (half a merged cell would be malformed)."""
    r0, c0 = min(a.r, b.r), min(a.c, b.c)
    r1, c1 = max(a.bottom, b.bottom), max(a.right, b.right)
    changed = True
    while changed:
        changed = False
        for cell in grid.cells:
            inside = cell.r >= r0 and cell.bottom <= r1 and cell.c >= c0 and cell.right <= c1
            touches = cell.r < r1 and cell.bottom > r0 and cell.c < c1 and cell.right > c0
            if touches and not inside:
                r0, c0, r1, c1 = min(r0, cell.r), min(c0, cell.c), max(r1, cell.bottom), max(c1, cell.right)
                changed = True
    return r0, c0, r1, c1


def _merge(block: dict[str, Any], grid: Grid, op: dict[str, Any]) -> None:
    styles, edges, layout = _styles_of(block), _edges_of(block), _layout_of(block)
    first = grid.by_key(_i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS))
    last_row, last_col = _i(op, "end_row", 0, MAX_ROWS, required=False), _i(op, "end_col", 0, MAX_COLUMNS, required=False)
    last = first if last_row is None or last_col is None else grid.by_key(last_row, last_col)
    r0, c0, r1, c1 = _rectangle(grid, first, last)
    members = sorted((cell for cell in grid.cells if cell.r >= r0 and cell.bottom <= r1 and cell.c >= c0 and cell.right <= c1),
                     key=lambda cell: (cell.r, cell.c))
    if len(members) < 2:
        raise OpError("Select two or more cells to merge")
    anchor = members[0]
    for other in members[1:]:
        if other.data.get("text"):
            if anchor.data.get("text"):
                tm.join(anchor.data, {"text": "\n"})
            tm.join(anchor.data, {"text": other.data["text"], **({"spans": other.data["spans"]} if other.data.get("spans") else {})})
    dropped = set(map(id, members[1:]))
    grid.cells = [cell for cell in grid.cells if id(cell) not in dropped]
    anchor.r, anchor.c, anchor.rs, anchor.cs = r0, c0, r1 - r0, c1 - c0
    edges = {"h": {k: v for k, v in edges["h"].items() if not _inside(k, r0 + 1, r1 - 1, c0, c1 - 1)},
             "v": {k: v for k, v in edges["v"].items() if not _inside(k, r0, r1 - 1, c0 + 1, c1 - 1)}}
    _rebuild(block, grid, styles=styles, edges=edges, layout=layout)


def _inside(key: str, r_lo: int, r_hi: int, c_lo: int, c_hi: int) -> bool:
    parsed = _parse_key(key)
    return parsed is not None and r_lo <= parsed[0] <= r_hi and c_lo <= parsed[1] <= c_hi


def _split(block: dict[str, Any], grid: Grid, op: dict[str, Any]) -> None:
    target = grid.by_key(_i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS))
    want_c = _i(op, "cols", 1, 64, required=False) or target.cs
    want_r = _i(op, "rows", 1, 64, required=False) or target.rs
    if want_c == 1 and want_r == 1:
        raise OpError("Choose how many parts to split the cell into")
    if target.cs == 1 and target.rs == 1 and want_c == 1 and want_r == 1:
        raise OpError("This cell is not merged")
    if want_c > target.cs:
        _insert_lines(block, grid, "col", target.right, want_c - target.cs, within=True)
    if want_r > target.rs:
        _insert_lines(block, grid, "row", target.bottom, want_r - target.rs, within=True)
    styles, edges, layout = _styles_of(block), _edges_of(block), _layout_of(block)
    # the parts: sizes as even as possible, the extra grid positions going to the first parts
    def parts(total: int, n: int) -> list[int]:
        base, extra = divmod(total, n)
        return [base + (1 if i < extra else 0) for i in range(n)]
    widths, heights = parts(target.cs, want_c), parts(target.rs, want_r)
    origin = copy.copy(target)
    top = target.r
    for i, height in enumerate(heights):
        left = target.c
        for j, width in enumerate(widths):
            if i == 0 and j == 0:
                target.rs, target.cs = height, width
            else:
                grid.cells.append(_new_cell(top, left, origin, height, width))
            left += width
        top += height
    _rebuild(block, grid, styles=styles, edges=edges, layout=layout)


@handler("table_edit")
def op_table_edit(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block, table = _table(tr, op.get("block"))
    action = _s(op, "action")
    grid = Grid(table)
    if action == "insert_row":
        _insert_lines(block, grid, "row", _i(op, "index", 0, MAX_ROWS, required=False) or 0, _count(op))
    elif action == "insert_col":
        _insert_lines(block, grid, "col", _i(op, "index", 0, MAX_COLUMNS, required=False) or 0, _count(op))
    elif action == "delete_row":
        _delete_lines(block, grid, "row", _i(op, "index", 0, MAX_ROWS, required=False) or 0, _count(op))
    elif action == "delete_col":
        _delete_lines(block, grid, "col", _i(op, "index", 0, MAX_COLUMNS, required=False) or 0, _count(op))
    elif action == "header_rows":
        table["header_rows"] = _i(op, "count", 0, grid.n_rows)
    elif action == "merge_cells":
        _merge(block, grid, op)
    elif action == "split_cell":
        _split(block, grid, op)
    else:
        raise OpError(f"Unknown table action '{action}'")
    return {}


# ------------------------------------------------------------------------------------------------------- formatting
def _opt_number(props: dict[str, Any], key: str, low: float, high: float) -> None:
    value = props.get(key)
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high):
        raise OpError(f"{key} must be a number from {low:g} to {high:g}")


def _opt_choice(props: dict[str, Any], key: str, choices: Iterable[str]) -> None:
    value = props.get(key)
    if value is not None and value not in tuple(choices):
        raise OpError(f"{key} must be one of {', '.join(choices)}")


def _opt_colour(props: dict[str, Any], key: str) -> None:
    value = props.get(key)
    if value is not None and (not isinstance(value, str) or not _COLOUR.fullmatch(value)):
        raise OpError(f"{key} must be a #rrggbb colour")


CELL_STYLE_KEYS = frozenset({"align", "valign", "background", "padding_mm", "border_color", "border_width_pt", "border_style",
                             "line_height", "space_before_pt", "space_after_pt", "indent_mm", "paragraph_style"})


def check_cell_props(props: dict[str, Any], doc: dict[str, Any] | None = None) -> None:
    unknown = set(props) - CELL_STYLE_KEYS
    if unknown:
        raise OpError(f"Unknown table cell setting: {sorted(unknown)[0]}")
    _opt_choice(props, "align", _ALIGNS)
    _opt_choice(props, "valign", _VALIGNS)
    _opt_choice(props, "border_style", BORDER_STYLES)
    _opt_colour(props, "background")
    _opt_colour(props, "border_color")
    _opt_number(props, "padding_mm", 0, 50)
    _opt_number(props, "border_width_pt", 0, 12)
    _opt_number(props, "line_height", 0.5, 5)
    _opt_number(props, "space_before_pt", 0, 1000)
    _opt_number(props, "space_after_pt", 0, 1000)
    _opt_number(props, "indent_mm", 0, 1000)
    name = props.get("paragraph_style")
    if name is not None:
        if not isinstance(name, str) or (doc is not None and name not in (doc.get("styles", {}).get("paragraph", {}))):
            raise OpError(f"There is no paragraph style '{name}'")


@handler("table_cell_style")
def op_table_cell_style(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block, table = _table(tr, op.get("block"))
    row, col = _i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS)
    cell = cell_of(table, row, col)
    props = dict(_d(op, "props"))
    check_cell_props(props, tr.doc)
    styles = _styles_of(block)
    key = f"{row},{col}"
    entry = styles.get(key, {})
    for name, value in props.items():
        if name == "align":                                           # the one setting the .sldc format itself has for a cell
            if value is None:
                cell.pop("align", None)
            else:
                cell["align"] = value
        elif value is None:
            entry.pop(name, None)
        else:
            entry[name] = value
    if entry:
        styles[key] = entry
    else:
        styles.pop(key, None)
    _store(block, CELLS_KEY, styles)
    if {"border_color", "border_width_pt", "border_style"} & set(props):
        _outline_cell(block, Grid(table), cell, entry)
    return {}


def _outline_cell(block: dict[str, Any], grid: Grid, cell: dict[str, Any], entry: dict[str, Any]) -> None:
    """A border set on one cell is written to the four grid edges around it, where every border lives."""
    target = next((x for x in grid.cells if x.data is cell), None)
    if target is None:
        return
    spec = ts.border_spec(entry.get("border_color"), entry.get("border_width_pt"), entry.get("border_style"))
    edges = _edges_of(block)
    for axis, a, b in ts.region_edges(target.r, target.c, target.bottom, target.right, "outside", grid.n_rows, grid.columns):
        edges[axis][_edge_key(a, b)] = copy.deepcopy(spec)
    _store(block, BORDERS_KEY, {"h": edges["h"], "v": edges["v"]} if edges["h"] or edges["v"] else None)


def check_layout(props: dict[str, Any], columns: int, rows: int) -> None:
    known = {"width_mm", "column_widths_mm", "row_heights_mm", "align", "indent_mm", "fit", "row_height_rule", "keep_rows_together",
             "allow_row_split", "cell_padding_mm"}
    unknown = set(props) - known
    if unknown:
        raise OpError(f"Unknown table layout setting: {sorted(unknown)[0]}")
    _opt_number(props, "width_mm", 10, 2000)
    _opt_number(props, "indent_mm", 0, 500)
    _opt_number(props, "cell_padding_mm", 0, 50)
    _opt_choice(props, "align", ("left", "center", "right"))
    _opt_choice(props, "fit", ("auto", "content", "window", "fixed"))
    _opt_choice(props, "row_height_rule", ("min", "exact"))
    for name in ("keep_rows_together", "allow_row_split"):
        if props.get(name) is not None and not isinstance(props[name], bool):
            raise OpError(f"{name} must be true or false")
    for name, size, low, high in (("column_widths_mm", columns, MIN_COLUMN_MM, 2000), ("row_heights_mm", rows, MIN_ROW_MM, 1000)):
        values = props.get(name)
        if values is None:
            continue
        if not isinstance(values, list) or len(values) != size:
            raise OpError(f"{name} needs one number for each of the {size} {'columns' if name.startswith('column') else 'rows'}")
        for value in values:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise OpError(f"Every entry of {name} must be a number from {low:g} to {high:g} mm")


@handler("table_layout")
def op_table_layout(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block, table = _table(tr, op.get("block"))
    props = dict(_d(op, "props"))
    check_layout(props, table["columns"], len(table["rows"]))
    layout = _layout_of(block)
    for name, value in props.items():
        if value is None:
            layout.pop(name, None)
        else:
            layout[name] = value
    _store(block, LAYOUT_KEY, layout)
    return {}


# ------------------------------------------------------------------------------------------------ styles and borders
@handler("table_style")
def op_table_style(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Choose the table's style (one of the gallery, or one the person saved), its accent colour and the options that switch parts of it on or off.

    ``clear`` also removes the formatting set by hand (cell colours, borders), which is what "restore default formatting" means.
    """
    block, table = _table(tr, op.get("block"))
    custom = (tr.doc.get("extensions") or {}).get("slai.writer", {}).get("table_styles") or {}
    current = copy.deepcopy((block.get("extensions") or {}).get(STYLE_KEY) or {})
    if op.get("clear"):                                              # "restore default formatting": the look, hand-made colours and borders
        ext = block.get("extensions") or {}
        for key in (STYLE_KEY, CELLS_KEY, BORDERS_KEY):
            ext.pop(key, None)
        _tidy_ext(block)
        return {}
    update = {key: op[key] for key in ("preset", "accent", "header_row", "first_column", "banded_rows", "banded_columns") if key in op}
    if not update:
        raise OpError("Choose a table style or an option to change")
    merged = {**current, **{k: v for k, v in update.items() if v is not None}}
    for key in update:
        if update[key] is None:
            merged.pop(key, None)
    ts.check_style(merged, custom)
    if "preset" in update and update["preset"] is not None:
        for key in ("header_row", "first_column", "banded_rows", "banded_columns"):
            if key not in update:
                merged.pop(key, None)                                    # a new look brings its own defaults for the options
    _store(block, STYLE_KEY, merged or None)
    return {}


BORDER_TARGETS = ("all", "none", "outside", "inside", "inside_h", "inside_v", "top", "bottom", "left", "right")


@handler("table_borders")
def op_table_borders(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Set (or remove) the border on part of the table: its edges, or the edges of the cells in a rectangle.

    ``target`` is one of all, none, outside, inside, inside_h, inside_v, top, bottom, left, right; the rectangle is given by the two corner
    cells (``row``/``col`` and ``end_row``/``end_col``, as every cell operation addresses them) and is the whole table when they are left out.
    ``border`` is ``{"color", "width_pt", "style"}``; ``null`` clears the border back to what the table's style gives; ``"none"`` draws none.
    """
    block, table = _table(tr, op.get("block"))
    target = _s(op, "target")
    if target not in BORDER_TARGETS:
        raise OpError(f"target must be one of {', '.join(BORDER_TARGETS)}")
    grid = Grid(table)
    if op.get("row") is None:
        r0, c0, r1, c1 = 0, 0, grid.n_rows, grid.columns
    else:
        first = grid.by_key(_i(op, "row", 0, MAX_ROWS), _i(op, "col", 0, MAX_COLUMNS))
        last_row, last_col = _i(op, "end_row", 0, MAX_ROWS, required=False), _i(op, "end_col", 0, MAX_COLUMNS, required=False)
        last = first if last_row is None or last_col is None else grid.by_key(last_row, last_col)
        r0, c0, r1, c1 = _rectangle(grid, first, last)
    border = op.get("border")
    if "border" not in op:
        raise OpError("The operation needs 'border'")
    spec: Any
    if border is None:
        spec = ts.INHERIT
    else:
        if not isinstance(border, dict):
            raise OpError("'border' must be an object or null")
        spec = ts.checked_border(border)
    edges = _edges_of(block)
    effective = "none" if target == "none" else target
    for axis, a, b in ts.region_edges(r0, c0, r1, c1, effective, grid.n_rows, grid.columns):
        key = _edge_key(a, b)
        if target == "none":
            edges[axis][key] = None
        elif spec is ts.INHERIT:
            edges[axis].pop(key, None)
        else:
            edges[axis][key] = copy.deepcopy(spec)
    for axis in ("h", "v"):                                           # inside a merged cell there is nothing to draw
        for cell in grid.cells:
            if cell.rs > 1 or cell.cs > 1:
                for key in [k for k in edges[axis] if _inside_cell(axis, k, cell)]:
                    del edges[axis][key]
    if len(edges["h"]) + len(edges["v"]) > 2 * MAX_TABLE_CELLS:
        raise LimitExceeded("Too many separate borders")
    _store(block, BORDERS_KEY, {"h": edges["h"], "v": edges["v"]} if edges["h"] or edges["v"] else None)
    # the cells touched no longer have a single remembered border of their own
    styles = _styles_of(block)
    for cell in grid.cells:
        if cell.r >= r0 and cell.bottom <= r1 and cell.c >= c0 and cell.right <= c1 and cell.key in styles:
            for name in ("border_color", "border_width_pt", "border_style"):
                styles[cell.key].pop(name, None)
            if not styles[cell.key]:
                del styles[cell.key]
    _store(block, CELLS_KEY, styles)
    return {}


def _inside_cell(axis: str, key: str, cell: Cell) -> bool:
    parsed = _parse_key(key)
    if parsed is None:
        return False
    a, b = parsed
    if axis == "h":
        return cell.r < a < cell.bottom and cell.c <= b < cell.right
    return cell.r <= a < cell.bottom and cell.c < b < cell.right


@handler("table_style_define")
def op_table_style_define(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Save the style of a table under a name so it can be used for other tables, or delete a saved style."""
    name = _s(op, "name", limit=48)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _.-]{0,47}", name):
        raise OpError("A table style name needs letters, digits, spaces, dots, dashes or underscores")
    ext = copy.deepcopy(tr.key("extensions") or {})
    mine = ext.setdefault("slai.writer", {})
    saved = dict(mine.get("table_styles") or {})
    if op.get("delete"):
        saved.pop(name, None)
        for block in tr.doc["blocks"]:                                # a table that used it falls back to the style it was based on
            style = (block.get("extensions") or {}).get(STYLE_KEY)
            if isinstance(style, dict) and style.get("preset") == f"custom:{name}":
                base = saved.get(name) or {}
                tr.get(block["id"])["extensions"][STYLE_KEY] = {**style, "preset": base.get("preset", "plain")}
    else:
        block, _ = _table(tr, op.get("block"))
        style = copy.deepcopy((block.get("extensions") or {}).get(STYLE_KEY) or {})
        style.setdefault("preset", "plain")
        if str(style["preset"]).startswith("custom:"):
            raise OpError("Save a style from a table that uses one of the gallery's looks")
        if name not in saved and len(saved) >= 24:
            raise LimitExceeded("A document can keep up to 24 saved table styles")
        ts.check_style(style, {})
        saved[name] = style
    if saved:
        mine["table_styles"] = saved
    else:
        mine.pop("table_styles", None)
    if not mine:
        ext.pop("slai.writer")
    tr.doc["extensions"] = ext
    if not ext:
        tr.doc.pop("extensions")
    return {"name": name}


def validate_table_extensions(block: dict[str, Any], doc: dict[str, Any] | None = None) -> None:
    """Refuse malformed Writer table data (it can arrive by paste, import or a hand-edited file). Used by block insertion."""
    ext = block.get("extensions")
    if not isinstance(ext, dict) or block.get("type") != "table":
        return
    table = block["table"]
    columns, rows = table["columns"], len(table["rows"])
    if LAYOUT_KEY in ext:
        if not isinstance(ext[LAYOUT_KEY], dict):
            raise OpError("Table layout must be an object")
        check_layout(ext[LAYOUT_KEY], columns, rows)
    if CELLS_KEY in ext:
        styles = ext[CELLS_KEY]
        if not isinstance(styles, dict) or len(styles) > MAX_TABLE_CELLS:
            raise OpError("Table cell formatting must be an object")
        for key, props in styles.items():
            parsed = _parse_key(key) if isinstance(key, str) else None
            if parsed is None or not isinstance(props, dict):
                raise OpError("Table cell formatting is keyed by 'row,cell'")
            check_cell_props(props, doc)
    if BORDERS_KEY in ext:
        ts.check_borders(ext[BORDERS_KEY], rows, columns)
    if STYLE_KEY in ext:
        custom = ((doc or {}).get("extensions") or {}).get("slai.writer", {}).get("table_styles") or {}
        ts.check_style(ext[STYLE_KEY], custom)
