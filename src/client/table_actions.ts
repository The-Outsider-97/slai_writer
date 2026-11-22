/** Everything the table ribbon tabs, the right-click menu and the command palette do to a table.
 *
 *  Each function reads what the caret or the selection covers (a rectangle of whole cells, see table_geometry.ts), sends ONE operation (or one batch),
 *  and puts the caret back in a sensible cell. The operations are the server's table_* operations, so every change is undoable, saved and exported. */
import type { Editor } from "./editor.js";
import { toast } from "./kit.js";
import { errorText } from "./net.js";
import { MM_PX } from "./textops.js";
import { addressAt, cornersOf, gridOf, rectOf, wholeColumns, wholeRows, type CellRef, type GridModel, type Rect } from "./table_geometry.js";
import { BORDERS_KEY, CELLS_KEY, LAYOUT_KEY, STYLE_KEY, type BorderSpec, type OptionKey, type TableStyleExt } from "./table_style.js";
import { focusCell } from "./actions.js";
import type { Block, Op, TableData, TableLayout } from "./types.js";

export interface TableTarget { block: Block; table: TableData; model: GridModel; rect: Rect; anchor: CellRef; whole: boolean }
export type BorderTarget = "all" | "none" | "outside" | "inside" | "inside_h" | "inside_v" | "top" | "bottom" | "left" | "right";

/** The table the caret is in (or the table selected as an object) and the cells it covers. */
export function tableTarget(ed: Editor): TableTarget | null {
  const sel = ed.recallSelection();
  if (sel && sel.start.field === "cell" && sel.end.field === "cell" && sel.start.block === sel.end.block) {
    const block = ed.model.block(sel.start.block);
    if (block?.type === "table" && block.table) {
      const model = gridOf(block.table);
      const a = model.byAddress(sel.start.row ?? 0, sel.start.col ?? 0), b = model.byAddress(sel.end.row ?? 0, sel.end.col ?? 0);
      if (a && b) return { block, table: block.table, model, rect: rectOf(model, a, b), anchor: { row: a.row, col: a.idx }, whole: false };
    }
  }
  const id = ed.selectedBlock;
  const block = id ? ed.model.block(id) : undefined;
  if (block?.type === "table" && block.table) {
    const model = gridOf(block.table);
    return { block, table: block.table, model, rect: { r0: 0, c0: 0, r1: model.rows, c1: model.columns }, anchor: { row: 0, col: 0 }, whole: true };
  }
  return null;
}

export const tableIdAtCaret = (ed: Editor): string | null => tableTarget(ed)?.block.id ?? null;

async function send(ed: Editor, op: Op | Op[], label?: string): Promise<boolean> {
  if (ed.readOnly) { toast("This document is read-only.", { kind: "info" }); return false; }
  try {
    await ed.op(Array.isArray(op) ? { op: "batch", ops: op, label: label ?? "table" } : label ? { ...op, label } : op);
    return true;
  } catch (error) {
    if ((error as { details?: { kind?: string } }).details?.kind !== "stale_version") toast(errorText(error), { kind: "error" });
    return false;
  }
}

const place = (ed: Editor, id: string, r: number, c: number): void => {
  const table = ed.model.block(id)?.table;
  if (!table) return;
  const model = gridOf(table);
  const at = addressAt(model, Math.min(r, model.rows - 1), Math.min(c, model.columns - 1));
  if (at) focusCell(ed, id, at.row, at.col, 0);
};

/* ------------------------------------------------------------------------------------------------ rows and columns */
export async function insertRows(ed: Editor, where: "above" | "below", count = 1): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const index = where === "above" ? t.rect.r0 : t.rect.r1;
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "insert_row", index, count }, count > 1 ? `insert ${count} rows` : "insert row")) place(ed, t.block.id, index, t.rect.c0);
}
export async function insertColumns(ed: Editor, where: "left" | "right", count = 1): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const index = where === "left" ? t.rect.c0 : t.rect.c1;
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "insert_col", index, count }, count > 1 ? `insert ${count} columns` : "insert column")) place(ed, t.block.id, t.rect.r0, index);
}
export async function deleteRows(ed: Editor): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const count = t.rect.r1 - t.rect.r0;
  if (count >= t.model.rows) { await deleteTable(ed); return; }
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "delete_row", index: t.rect.r0, count }, count > 1 ? "delete rows" : "delete row")) place(ed, t.block.id, t.rect.r0, t.rect.c0);
}
export async function deleteColumns(ed: Editor): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const count = t.rect.c1 - t.rect.c0;
  if (count >= t.model.columns) { await deleteTable(ed); return; }
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "delete_col", index: t.rect.c0, count }, count > 1 ? "delete columns" : "delete column")) place(ed, t.block.id, t.rect.r0, t.rect.c0);
}
export async function deleteTable(ed: Editor): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  await send(ed, { op: "block_delete", blocks: [t.block.id] }, "delete table");
}
/** Rows or columns selected as whole lines (a caret in one cell counts as that cell's row or column): used to label the menu entries truthfully. */
export function selectedLines(t: TableTarget): { rows: number; columns: number; wholeRows: boolean; wholeColumns: boolean } {
  return { rows: t.rect.r1 - t.rect.r0, columns: t.rect.c1 - t.rect.c0, wholeRows: wholeRows(t.rect, t.model.columns), wholeColumns: wholeColumns(t.rect, t.model.rows) };
}

/* ------------------------------------------------------------------------------------------------ merge and split */
export async function mergeCells(ed: Editor): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const corners = cornersOf(t.model, t.rect);
  if (!corners || t.model.at(t.rect.r0, t.rect.c0) === t.model.at(t.rect.r1 - 1, t.rect.c1 - 1)) { toast("Select two or more cells to merge.", { kind: "info" }); return; }
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "merge_cells", row: corners.from.row, col: corners.from.col, end_row: corners.to.row, end_col: corners.to.col }, "merge cells"))
    place(ed, t.block.id, t.rect.r0, t.rect.c0);
}
export async function splitCell(ed: Editor, columns?: number, rows?: number): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const cell = t.model.byAddress(t.anchor.row, t.anchor.col);
  if (!cell) return;
  if (columns === undefined && rows === undefined && cell.cs === 1 && cell.rs === 1) { toast("This cell is not merged. Choose how many columns and rows to split it into.", { kind: "info" }); return; }
  if (await send(ed, { op: "table_edit", block: t.block.id, action: "split_cell", row: cell.row, col: cell.idx, ...(columns ? { cols: columns } : {}), ...(rows ? { rows } : {}) }, "split cell"))
    place(ed, t.block.id, cell.r, cell.c);
}

/* ---------------------------------------------------------------------------------------------------------- styles */
export async function setStyle(ed: Editor, props: TableStyleExt | { clear: true }): Promise<void> {
  const t = tableTarget(ed);
  if (t) await send(ed, { op: "table_style", block: t.block.id, ...props }, "table style");
}
export async function setOption(ed: Editor, key: OptionKey, value: boolean): Promise<void> { await setStyle(ed, { [key]: value }); }
export async function restoreDefaultStyle(ed: Editor): Promise<void> { await setStyle(ed, { clear: true }); }
export async function saveCustomStyle(ed: Editor, name: string): Promise<boolean> {
  const t = tableTarget(ed);
  return t ? send(ed, { op: "table_style_define", block: t.block.id, name }, "save table style") : false;
}
export async function deleteCustomStyle(ed: Editor, name: string): Promise<void> {
  const t = tableTarget(ed);
  if (t) await send(ed, { op: "table_style_define", block: t.block.id, name, delete: true }, "delete table style");
}
export async function setShading(ed: Editor, colour: string | null): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const ops: Op[] = t.model.cells.filter((c) => c.r >= t.rect.r0 && c.r + c.rs <= t.rect.r1 && c.c >= t.rect.c0 && c.c + c.cs <= t.rect.c1)
    .map((c) => ({ op: "table_cell_style", block: t.block.id, row: c.row, col: c.idx, props: { background: colour } }));
  await send(ed, ops, "cell shading");
}

/** The pen the border buttons draw with. */
export const pen: BorderSpec = { color: "#000000", width_pt: 0.75, style: "solid" };

/** Set (or, with null, clear back to the style's rule) the border on `target` of the selected cells, or of the whole table. */
export async function setBorders(ed: Editor, target: BorderTarget, border: BorderSpec | null, scope: "selection" | "table" = "selection"): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const op: Op = { op: "table_borders", block: t.block.id, target, border: target === "none" ? null : border };
  if (scope === "selection" && !t.whole) {
    const corners = cornersOf(t.model, t.rect);
    if (corners) Object.assign(op, { row: corners.from.row, col: corners.from.col, end_row: corners.to.row, end_col: corners.to.col });
  }
  await send(ed, op, "table borders");
}

/* ------------------------------------------------------------------------------------------------------- layout */
const layoutOf = (b: Block): TableLayout => (b.extensions?.[LAYOUT_KEY] as TableLayout | undefined) ?? {};

export async function setLayout(ed: Editor, props: Record<string, unknown>): Promise<void> {
  const t = tableTarget(ed);
  if (t) await send(ed, { op: "table_layout", block: t.block.id, props }, "table layout");
}

/** The widths of the columns as the browser lays them out now, in millimetres. */
export function measuredColumns(ed: Editor, t: TableTarget): number[] {
  const known = layoutOf(t.block).column_widths_mm;
  if (known && known.length === t.model.columns) return [...known];
  const el = ed.els.get(t.block.id)?.querySelector<HTMLTableElement>("table.tbl");
  const total = (el?.getBoundingClientRect().width ?? 600) / MM_PX / ed.page.zoom;
  const first = el?.rows[0]?.cells;
  if (first && first.length === t.model.columns) return Array.from(first, (c) => Math.max(4, c.getBoundingClientRect().width / MM_PX / ed.page.zoom));
  return new Array<number>(t.model.columns).fill(Math.max(4, total / t.model.columns));
}
export function measuredRows(ed: Editor, t: TableTarget): number[] {
  const known = layoutOf(t.block).row_heights_mm;
  if (known && known.length === t.model.rows) return [...known];
  const el = ed.els.get(t.block.id)?.querySelector<HTMLTableElement>("table.tbl");
  const rows = Array.from(el?.rows ?? [], (tr) => Math.max(4, tr.getBoundingClientRect().height / MM_PX / ed.page.zoom));
  return rows.length === t.model.rows ? rows : new Array<number>(t.model.rows).fill(7);
}

export async function setColumnWidth(ed: Editor, mm: number): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const widths = measuredColumns(ed, t);
  for (let c = t.rect.c0; c < t.rect.c1; c += 1) widths[c] = mm;
  await send(ed, { op: "table_layout", block: t.block.id, props: { column_widths_mm: widths, fit: "fixed" } }, "column width");
}
export async function setRowHeight(ed: Editor, mm: number, rule: "min" | "exact"): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const heights = measuredRows(ed, t);
  for (let r = t.rect.r0; r < t.rect.r1; r += 1) heights[r] = mm;
  await send(ed, { op: "table_layout", block: t.block.id, props: { row_heights_mm: heights, row_height_rule: rule } }, "row height");
}
export async function distribute(ed: Editor, axis: "columns" | "rows"): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  if (axis === "columns") {
    const widths = measuredColumns(ed, t);
    const span = widths.slice(t.rect.c0, t.rect.c1);
    const even = span.reduce((a, b) => a + b, 0) / Math.max(1, span.length);
    for (let c = t.rect.c0; c < t.rect.c1; c += 1) widths[c] = Math.max(4, even);
    await send(ed, { op: "table_layout", block: t.block.id, props: { column_widths_mm: widths, fit: "fixed" } }, "distribute columns");
  } else {
    const heights = measuredRows(ed, t);
    const span = heights.slice(t.rect.r0, t.rect.r1);
    const even = span.reduce((a, b) => a + b, 0) / Math.max(1, span.length);
    for (let r = t.rect.r0; r < t.rect.r1; r += 1) heights[r] = Math.max(4, even);
    await send(ed, { op: "table_layout", block: t.block.id, props: { row_heights_mm: heights } }, "distribute rows");
  }
}
export async function autoFit(ed: Editor, mode: "content" | "window" | "fixed"): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  if (mode === "fixed") await send(ed, { op: "table_layout", block: t.block.id, props: { fit: "fixed", column_widths_mm: measuredColumns(ed, t) } }, "fixed column width");
  else await send(ed, { op: "table_layout", block: t.block.id, props: { fit: mode, column_widths_mm: null, width_mm: null } }, mode === "content" ? "autofit to contents" : "autofit to window");
}
export async function setHeaderRows(ed: Editor, count: number): Promise<void> {
  const t = tableTarget(ed);
  if (t) await send(ed, { op: "table_edit", block: t.block.id, action: "header_rows", count }, "header rows");
}
export async function alignCells(ed: Editor, props: { align?: string; valign?: string; padding_mm?: number | null }): Promise<void> {
  const t = tableTarget(ed);
  if (!t) return;
  const ops: Op[] = t.model.cells.filter((c) => c.r >= t.rect.r0 && c.r + c.rs <= t.rect.r1 && c.c >= t.rect.c0 && c.c + c.cs <= t.rect.c1)
    .map((c) => ({ op: "table_cell_style", block: t.block.id, row: c.row, col: c.idx, props }));
  await send(ed, ops, "cell alignment");
}

export const edgesOf = (b: Block): unknown => b.extensions?.[BORDERS_KEY];
export const cellStylesOf = (b: Block): unknown => b.extensions?.[CELLS_KEY];
export const styleOf = (b: Block): TableStyleExt => (b.extensions?.[STYLE_KEY] as TableStyleExt | undefined) ?? {};
export { layoutOf };
