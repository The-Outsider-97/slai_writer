/** What the Layout tab does about columns: one server operation each (columns_set, column_break; scripture_apply for the Scripture paragraph style), so every change is undoable, saved and exported. */
import type { Editor } from "./editor.js";
import { toast, announce } from "./kit.js";
import { errorText } from "./net.js";
import { columnSpec, layoutOf, DEFAULT_GAP_MM, type ColumnSpec } from "./column_layout.js";
import { COLUMN_BREAK, TEXT_TYPES, type ColumnLayout, type Op } from "./types.js";

export type ColumnScope = "document" | "section" | "selection";
export interface ColumnPatch {
  columns?: number; gap_mm?: number | null; widths_mm?: number[] | null; rule?: { color: string; width_pt: number; style: string } | null; balance?: boolean; flow?: "ltr" | "rtl";
}

async function send(ed: Editor, op: Op): Promise<boolean> {
  if (ed.readOnly) { toast("This document is read-only.", { kind: "info" }); return false; }
  try { await ed.op(op); return true; } catch (error) {
    if ((error as { details?: { kind?: string } }).details?.kind !== "stale_version") toast(errorText(error), { kind: "error" });
    return false;
  }
}

/** The blocks the selection covers (the caret alone covers the paragraph it is in). Columns are whole paragraphs, as in Word's section breaks. */
export function selectedBlocks(ed: Editor): { first: string; last: string; collapsed: boolean } | null {
  const sel = ed.recallSelection();
  if (!sel) return null;
  const a = ed.model.indexOf(sel.start.block), b = ed.model.indexOf(sel.end.block);
  if (a < 0 || b < 0) return null;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { first: ed.model.order[lo] as string, last: ed.model.order[hi] as string, collapsed: sel.collapsed };
}

/** The section the caret is in and its columns (null spec: one column). */
export function columnsAtCaret(ed: Editor): { section: string | undefined; spec: ColumnSpec | null; layout: ColumnLayout; gapMm: number } {
  const sel = selectedBlocks(ed);
  const section = (sel ? ed.model.block(sel.first)?.section : undefined) ?? ed.model.meta.sections?.[0]?.id;
  const spec = columnSpec(ed.model.meta, section);
  return { section, spec, layout: layoutOf(ed.model.meta, section), gapMm: spec?.gapMm ?? DEFAULT_GAP_MM };
}

/** Text width of the section in millimetres, for the presets that need unequal columns. */
export function textWidthMm(ed: Editor, section: string | undefined): number {
  const g = ed.model.geometry(section);
  return g.widthMm - g.margins.left - g.margins.right;
}

export async function setColumns(ed: Editor, scope: ColumnScope, patch: ColumnPatch): Promise<boolean> {
  const sel = selectedBlocks(ed);
  const op: Record<string, unknown> = { op: "columns_set", scope, ...patch, label: "columns" };
  if (scope === "selection") {
    if (!sel) { toast("Select the text that should be set in columns.", { kind: "info" }); return false; }
    op["block"] = sel.first; op["end_block"] = sel.last;
  } else if (scope === "section") {
    const at = columnsAtCaret(ed).section;
    if (at) op["section"] = at;
  }
  const ok = await send(ed, op as Op);
  if (ok && patch.columns !== undefined) announce(patch.columns === 1 ? "One column." : `${patch.columns} columns.`);
  return ok;
}

/** The scope the Columns drop-down uses: the selected text when there is a selection, otherwise the section the caret is in. */
export function defaultScope(ed: Editor): ColumnScope {
  const sel = selectedBlocks(ed);
  return sel && !sel.collapsed ? "selection" : "section";
}

/** Start the next column at the caret. */
export async function insertColumnBreak(ed: Editor): Promise<boolean> {
  const sel = ed.readSelection() ?? ed.recallSelection();
  if (!sel) return false;
  const block = ed.model.block(sel.start.block);
  if (!block) return false;
  const text = TEXT_TYPES.includes(block.type) && sel.start.field === "text";
  const at = text && sel.start.offset > 0 ? sel.start.offset : undefined;
  const ok = await send(ed, { op: "column_break", block: block.id, ...(at !== undefined ? { at } : {}), label: "column break" });
  if (ok) {
    const cols = columnSpec(ed.model.meta, block.section);
    announce(cols ? "Column break inserted." : "This section has one column, so the break starts a new page.");
  }
  return ok;
}

export async function removeColumnBreak(ed: Editor): Promise<boolean> {
  const sel = selectedBlocks(ed);
  if (!sel) return false;
  const ids = ed.model.order.slice(ed.model.indexOf(sel.first), ed.model.indexOf(sel.last) + 1).filter((id) => ed.model.block(id)?.extensions?.[COLUMN_BREAK] !== undefined);
  if (!ids.length) { toast("There is no column break here.", { kind: "info" }); return false; }
  return send(ed, { op: "batch", ops: ids.map((id) => ({ op: "column_break", block: id, remove: true })), label: "remove column break" });
}

/** The Scripture paragraph style, chosen from the Home tab's style list: the style on the selected paragraphs and a two-column section around them. */
export async function applyScripture(ed: Editor): Promise<boolean> {
  const sel = selectedBlocks(ed);
  if (!sel) { toast("Select the passage first.", { kind: "info" }); return false; }
  const before = ed.readSelection() ?? ed.recallSelection();
  const ok = await send(ed, { op: "scripture_apply", block: sel.first, end_block: sel.last, label: "Scripture style" });
  if (ok && before) ed.restoreSelection(before);
  if (ok) announce("Scripture style applied: two columns.");
  return ok;
}
