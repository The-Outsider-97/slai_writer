import { toast, announce } from "./kit.js";
import { errorText } from "./net.js";
import { columnSpec, layoutOf, DEFAULT_GAP_MM } from "./column_layout.js";
import { COLUMN_BREAK, TEXT_TYPES } from "./types.js";
async function send(ed, op) {
    if (ed.readOnly) {
        toast("This document is read-only.", { kind: "info" });
        return false;
    }
    try {
        await ed.op(op);
        return true;
    }
    catch (error) {
        if (error.details?.kind !== "stale_version")
            toast(errorText(error), { kind: "error" });
        return false;
    }
}
/** The blocks the selection covers (the caret alone covers the paragraph it is in). Columns are whole paragraphs, as in Word's section breaks. */
export function selectedBlocks(ed) {
    const sel = ed.recallSelection();
    if (!sel)
        return null;
    const a = ed.model.indexOf(sel.start.block), b = ed.model.indexOf(sel.end.block);
    if (a < 0 || b < 0)
        return null;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { first: ed.model.order[lo], last: ed.model.order[hi], collapsed: sel.collapsed };
}
/** The section the caret is in and its columns (null spec: one column). */
export function columnsAtCaret(ed) {
    const sel = selectedBlocks(ed);
    const section = (sel ? ed.model.block(sel.first)?.section : undefined) ?? ed.model.meta.sections?.[0]?.id;
    const spec = columnSpec(ed.model.meta, section);
    return { section, spec, layout: layoutOf(ed.model.meta, section), gapMm: spec?.gapMm ?? DEFAULT_GAP_MM };
}
/** Text width of the section in millimetres, for the presets that need unequal columns. */
export function textWidthMm(ed, section) {
    const g = ed.model.geometry(section);
    return g.widthMm - g.margins.left - g.margins.right;
}
export async function setColumns(ed, scope, patch) {
    const sel = selectedBlocks(ed);
    const op = { op: "columns_set", scope, ...patch, label: "columns" };
    if (scope === "selection") {
        if (!sel) {
            toast("Select the text that should be set in columns.", { kind: "info" });
            return false;
        }
        op["block"] = sel.first;
        op["end_block"] = sel.last;
    }
    else if (scope === "section") {
        const at = columnsAtCaret(ed).section;
        if (at)
            op["section"] = at;
    }
    const ok = await send(ed, op);
    if (ok && patch.columns !== undefined)
        announce(patch.columns === 1 ? "One column." : `${patch.columns} columns.`);
    return ok;
}
/** The scope the Columns drop-down uses: the selected text when there is a selection, otherwise the section the caret is in. */
export function defaultScope(ed) {
    const sel = selectedBlocks(ed);
    return sel && !sel.collapsed ? "selection" : "section";
}
/** Start the next column at the caret. */
export async function insertColumnBreak(ed) {
    const sel = ed.readSelection() ?? ed.recallSelection();
    if (!sel)
        return false;
    const block = ed.model.block(sel.start.block);
    if (!block)
        return false;
    const text = TEXT_TYPES.includes(block.type) && sel.start.field === "text";
    const at = text && sel.start.offset > 0 ? sel.start.offset : undefined;
    const ok = await send(ed, { op: "column_break", block: block.id, ...(at !== undefined ? { at } : {}), label: "column break" });
    if (ok) {
        const cols = columnSpec(ed.model.meta, block.section);
        announce(cols ? "Column break inserted." : "This section has one column, so the break starts a new page.");
    }
    return ok;
}
export async function removeColumnBreak(ed) {
    const sel = selectedBlocks(ed);
    if (!sel)
        return false;
    const ids = ed.model.order.slice(ed.model.indexOf(sel.first), ed.model.indexOf(sel.last) + 1).filter((id) => ed.model.block(id)?.extensions?.[COLUMN_BREAK] !== undefined);
    if (!ids.length) {
        toast("There is no column break here.", { kind: "info" });
        return false;
    }
    return send(ed, { op: "batch", ops: ids.map((id) => ({ op: "column_break", block: id, remove: true })), label: "remove column break" });
}
/** The Scripture paragraph style and a two-column section around the selected paragraphs. */
export async function applyScripture(ed) {
    const sel = selectedBlocks(ed);
    if (!sel) {
        toast("Select the passage first.", { kind: "info" });
        return false;
    }
    const ok = await send(ed, { op: "scripture_apply", block: sel.first, end_block: sel.last, label: "Scripture style" });
    if (ok)
        announce("Scripture style applied: two columns.");
    return ok;
}
