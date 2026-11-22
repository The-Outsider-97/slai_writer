"""The cell grid of a table and the keys under which a table keeps its own settings in the document.

A leaf module: :mod:`.tableops` (the table operations) and :mod:`.table_styles` (the style resolver) both read tables through :class:`Grid`,
so it lives here and neither of them has to import the other.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .opcore import OpError

LAYOUT_KEY = "slai.writer.table_layout"
CELLS_KEY = "slai.writer.table_cell_styles"
BORDERS_KEY = "slai.writer.table_borders"
STYLE_KEY = "slai.writer.table_style"
TABLE_EXT_KEYS = (LAYOUT_KEY, CELLS_KEY, BORDERS_KEY, STYLE_KEY)


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
