/** Where the cells of a table sit on its grid, and what a selection of cells means in terms of rows and columns.
 *
 *  A table is stored the way .sldc stores it: for each row only the cells that START in it, so a cell covered by a rowspan from above or a colspan to
 *  its left has no entry. The server addresses a cell by its row and its position in that row's list (the `data-row` / `data-col` of the browser);
 *  rows and columns for structural changes are *grid* positions. This module is the one translation between them, mirroring Grid in tableops.py. */
import type { Cell, TableData } from "./types.js";

export interface GridCell {
  /** Grid row and column where the cell starts, and how far it spans. */
  r: number; c: number; rs: number; cs: number;
  /** The address operations use: the row, and the cell's position in that row's list. */
  row: number; idx: number;
  cell: Cell;
}
export interface GridModel {
  rows: number; columns: number; cells: GridCell[];
  /** The cell covering a grid position. */
  at(r: number, c: number): GridCell | undefined;
  /** The cell at an operation address. */
  byAddress(row: number, idx: number): GridCell | undefined;
}
/** A rectangle of the grid: rows r0 up to (not including) r1, columns c0 up to c1. */
export interface Rect { r0: number; c0: number; r1: number; c1: number }

export function gridOf(table: TableData): GridModel {
  const columns = table.columns;
  const cells: GridCell[] = [];
  let carry: number[] = new Array<number>(columns).fill(0);
  table.rows.forEach((row, r) => {
    const occupied = carry.map((v) => v > 0);
    let column = 0;
    const starts: GridCell[] = [];
    row.forEach((cell, idx) => {
      while (column < columns && occupied[column]) column += 1;
      const cs = Math.max(1, cell.colspan ?? 1), rs = Math.max(1, cell.rowspan ?? 1);
      const item: GridCell = { r, c: column, rs, cs, row: r, idx, cell };
      starts.push(item); cells.push(item);
      column += cs;
    });
    carry = carry.map((v) => Math.max(v - 1, 0));
    for (const item of starts) for (let c = item.c; c < Math.min(columns, item.c + item.cs); c += 1) carry[c] = item.rs - 1;
  });
  const grid = new Map<number, GridCell>();
  for (const item of cells) for (let r = item.r; r < item.r + item.rs; r += 1) for (let c = item.c; c < item.c + item.cs; c += 1) grid.set(r * (columns + 1) + c, item);
  return {
    rows: table.rows.length, columns, cells,
    at: (r, c) => grid.get(r * (columns + 1) + c),
    byAddress: (row, idx) => cells.find((x) => x.row === row && x.idx === idx),
  };
}

/** The smallest rectangle holding both cells, grown until it holds only whole cells (the same rule the server applies to a merge or a border). */
export function rectOf(model: GridModel, a: GridCell, b: GridCell): Rect {
  let r0 = Math.min(a.r, b.r), c0 = Math.min(a.c, b.c), r1 = Math.max(a.r + a.rs, b.r + b.rs), c1 = Math.max(a.c + a.cs, b.c + b.cs);
  for (let changed = true; changed;) {
    changed = false;
    for (const cell of model.cells) {
      const bottom = cell.r + cell.rs, right = cell.c + cell.cs;
      const touches = cell.r < r1 && bottom > r0 && cell.c < c1 && right > c0;
      const inside = cell.r >= r0 && bottom <= r1 && cell.c >= c0 && right <= c1;
      if (touches && !inside) { r0 = Math.min(r0, cell.r); c0 = Math.min(c0, cell.c); r1 = Math.max(r1, bottom); c1 = Math.max(c1, right); changed = true; }
    }
  }
  return { r0, c0, r1, c1 };
}

export interface CellRef { row: number; col: number }

/** What a caret or selection inside a table covers, as a rectangle of whole cells (a caret is the one cell it is in). */
export function selectedRect(table: TableData, start: CellRef, end: CellRef = start): Rect | null {
  const model = gridOf(table);
  const a = model.byAddress(start.row, start.col), b = model.byAddress(end.row, end.col);
  if (!a || !b) return null;
  return rectOf(model, a, b);
}

/** The operation address of the cell that starts at (or covers) a grid position. */
export function addressAt(model: GridModel, r: number, c: number): CellRef | null {
  const cell = model.at(r, c);
  return cell ? { row: cell.row, col: cell.idx } : null;
}

/** Corner cells (as operation addresses) of a rectangle: for merging and for borders. */
export function cornersOf(model: GridModel, rect: Rect): { from: CellRef; to: CellRef } | null {
  const from = addressAt(model, rect.r0, rect.c0), to = addressAt(model, rect.r1 - 1, rect.c1 - 1);
  return from && to ? { from, to } : null;
}

export const wholeRows = (rect: Rect, columns: number): boolean => rect.c0 === 0 && rect.c1 === columns;
export const wholeColumns = (rect: Rect, rows: number): boolean => rect.r0 === 0 && rect.r1 === rows;
