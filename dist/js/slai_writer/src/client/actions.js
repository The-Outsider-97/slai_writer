/** What the person can do to a document, expressed as operations. Each action works out the operations from the current selection and
 *  sends them through the editor (never touching the DOM itself), so undo, redo, history and conflict detection treat them all alike. */
import { announce, toast } from "./kit.js";
import { api, errorText } from "./net.js";
import { MM_PX } from "./textops.js";
import { layerList } from "./model.js";
import { TEXT_TYPES } from "./types.js";
const FLAGS = ["bold", "italic", "underline", "strike", "code", "superscript", "subscript"];
function isTextBlock(b) { return !!b && TEXT_TYPES.includes(b.type); }
/** Text blocks touched by a selection, each with the covered range. */
export function textRanges(ed, sel) {
    const i = ed.model.indexOf(sel.start.block);
    const j = ed.model.indexOf(sel.end.block);
    const out = [];
    for (let k = i; k <= j; k += 1) {
        const b = ed.model.block(ed.model.order[k]);
        if (!isTextBlock(b))
            continue;
        const from = k === i ? sel.start.offset : 0;
        const to = k === j ? sel.end.offset : b.text.length;
        if (to > from || (sel.collapsed && k === i))
            out.push({ block: b, from, to });
    }
    return out;
}
function covered(b, from, to, flag) {
    if (to <= from)
        return false;
    const spans = (b.spans ?? []).filter((s) => s.type === "format" && s[flag]);
    let at = from;
    for (const s of [...spans].sort((x, y) => x.start - y.start)) {
        if (s.start > at)
            return false;
        at = Math.max(at, s.end);
        if (at >= to)
            return true;
    }
    return at >= to;
}
async function guarded(ed, work) {
    try {
        return await work();
    }
    catch (error) {
        const stale = error.details?.kind === "stale_version";
        if (!stale)
            toast(errorText(error), { kind: "error" });
        ed.events.emit({ type: "error", error });
        return undefined;
    }
}
/* ---------------------------------------------------------------------------------------------- undo and redo */
export async function undoRedo(ed, direction, count = 1) {
    await guarded(ed, async () => {
        await ed.flush();
        const reply = await ed.queue.run(async () => {
            const r = await api.post(`/docs/${encodeURIComponent(ed.sid)}/${direction}`, { count, base: ed.model.version });
            if (r.patch)
                ed.applyExternalPatch(r.patch);
            return r;
        });
        if (reply.state)
            await ed.resync(reply.state);
        const first = reply.patch ? Object.keys(reply.patch.blocks).find((id) => ed.model.block(id)) : undefined;
        if (first && ed.isText(first))
            ed.focusBlock(first);
        announce(direction === "undo" ? "Undone" : "Redone");
    });
}
/* ---------------------------------------------------------------------------------------------- text */
export async function replaceRange(ed, sel, insert) {
    return (await guarded(ed, async () => {
        await ed.flush();
        const { start, end } = sel;
        const first = ed.model.block(start.block);
        const last = ed.model.block(end.block);
        if (!first || !last)
            return null;
        if (start.block === end.block) {
            if (start.field !== "text")
                return null;
            if (start.offset === end.offset && !insert)
                return start;
            await ed.queue.send({ op: "text", block: start.block, start: start.offset, end: end.offset, insert });
            return { block: start.block, offset: start.offset + insert.length, field: "text" };
        }
        const ids = ed.model.order.slice(ed.model.indexOf(start.block), ed.model.indexOf(end.block) + 1);
        const middle = ids.slice(1, -1);
        const ops = [];
        const firstText = isTextBlock(first);
        const lastText = isTextBlock(last);
        if (firstText) {
            if (start.offset < first.text.length || insert)
                ops.push({ op: "text", block: first.id, start: start.offset, end: first.text.length, insert });
        }
        else
            middle.unshift(first.id);
        if (lastText) {
            if (end.offset > 0)
                ops.push({ op: "text", block: last.id, start: 0, end: end.offset, insert: "" });
        }
        else
            middle.push(last.id);
        if (middle.length)
            ops.push({ op: "block_delete", blocks: middle });
        if (firstText && lastText)
            ops.push({ op: "merge", block: last.id });
        if (!ops.length)
            return start;
        await ed.queue.send({ op: "batch", ops, label: "delete" });
        return firstText ? { block: first.id, offset: start.offset + insert.length, field: "text" } : { block: last.id, offset: 0, field: "text" };
    })) ?? null;
}
/** Insert (possibly multi-line) text at the selection, replacing it. */
export async function insertText(ed, raw) {
    const text = ed.clean(raw);
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return;
    const lines = ed.lines(text);
    const block = ed.model.block(sel.start.block);
    if (lines.length === 1 || block?.type === "code" || sel.start.field !== "text") {
        const at = await replaceRange(ed, sel, lines.join(block?.type === "code" ? "\n" : " "));
        if (at)
            ed.focusBlock(at.block, at.offset);
        return;
    }
    if (lines.length > 2400) {
        toast("That is a lot of text at once. Paste it in smaller parts (up to about 2,400 lines).", { kind: "error" });
        return;
    }
    await guarded(ed, async () => {
        let at = sel.start;
        if (!sel.collapsed) {
            const next = await replaceRange(ed, sel, "");
            if (!next)
                return;
            at = next;
        }
        await ed.flush();
        const ops = [];
        let target = at.block;
        let offset = at.offset;
        const [head = "", ...rest] = lines;
        if (head) {
            ops.push({ op: "text", block: target, start: offset, end: offset, insert: head });
            offset += head.length;
        }
        for (const line of rest) {
            const id = ed.newId();
            ops.push({ op: "split", block: target, at: offset, new_id: id, keep_type: true });
            target = id;
            offset = 0;
            if (line) {
                ops.push({ op: "text", block: id, start: 0, end: 0, insert: line });
                offset = line.length;
            }
        }
        await ed.queue.send({ op: "batch", ops, label: "paste" });
        ed.focusBlock(target, offset);
    });
}
export async function enter(ed) {
    let sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return;
    if (!sel.collapsed) {
        const at = await replaceRange(ed, sel, "");
        if (!at)
            return;
        ed.focusBlock(at.block, at.offset);
        sel = ed.readSelection();
        if (!sel)
            return;
    }
    const pt = sel.start;
    const block = ed.model.block(pt.block);
    if (!block)
        return;
    await guarded(ed, async () => {
        if (pt.field === "cell") {
            const rows = block.table?.rows.length ?? 0;
            const next = (pt.row ?? 0) + 1;
            if (next >= rows)
                await ed.op({ op: "table_edit", block: block.id, action: "insert_row", index: rows });
            focusCell(ed, block.id, Math.min(next, (block.table?.rows.length ?? rows + 1) - 0), pt.col ?? 0);
            return;
        }
        if (pt.field === "caption") {
            moveToNext(ed, block.id);
            return;
        }
        if (!isTextBlock(block))
            return;
        if (block.type === "code") {
            await ed.flush();
            await ed.queue.send({ op: "text", block: block.id, start: pt.offset, end: pt.offset, insert: "\n" });
            ed.focusBlock(block.id, pt.offset + 1);
            return;
        }
        if (block.type === "list_item" && !block.text) {
            await ed.op({ op: "block_set", block: block.id, type: "paragraph", attributes: { ordered: null, depth: null } });
            ed.focusBlock(block.id, 0);
            return;
        }
        if ((block.type === "heading" || block.type === "quote") && pt.offset === 0 && block.text) {
            const index = ed.model.indexOf(block.id);
            const after = index > 0 ? ed.model.order[index - 1] : null;
            const id = ed.newId();
            await ed.op({ op: "block_insert", after, block: { id, type: "paragraph", text: "" } });
            ed.focusBlock(block.id, 0);
            return;
        }
        const id = ed.newId();
        await ed.op({ op: "split", block: block.id, at: pt.offset, new_id: id });
        ed.focusBlock(id, 0);
    });
}
function focusCell(ed, id, row, col) {
    const cell = ed.els.get(id)?.querySelector(`[data-edit=cell][data-row="${row}"][data-col="${col}"]`);
    if (!cell)
        return;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
}
export function focusNextCell(ed, pt, backwards) {
    const block = ed.model.block(pt.block);
    const cols = block?.table?.columns ?? 0;
    const rows = block?.table?.rows.length ?? 0;
    if (!block || !cols)
        return false;
    let r = pt.row ?? 0;
    let c = (pt.col ?? 0) + (backwards ? -1 : 1);
    if (c >= cols) {
        c = 0;
        r += 1;
    }
    if (c < 0) {
        c = cols - 1;
        r -= 1;
    }
    if (r < 0) {
        moveToPrevious(ed, block.id);
        return true;
    }
    if (r >= rows) {
        void (async () => { await ed.op({ op: "table_edit", block: block.id, action: "insert_row", index: rows }); focusCell(ed, block.id, rows, 0); })();
        return true;
    }
    focusCell(ed, block.id, r, c);
    return true;
}
function moveToNext(ed, id) {
    const next = ed.model.order[ed.model.indexOf(id) + 1];
    if (next)
        ed.focusBlock(next, 0);
}
function moveToPrevious(ed, id) {
    const prev = ed.model.order[ed.model.indexOf(id) - 1];
    if (prev)
        ed.focusBlock(prev);
}
/** Backspace. Returns true when it handled the key (the browser's own deletion must then be cancelled). */
export async function backspace(ed) {
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return false;
    if (!sel.collapsed) {
        const at = await replaceRange(ed, sel, "");
        if (at)
            ed.focusBlock(at.block, at.offset);
        return true;
    }
    const pt = sel.start;
    if (pt.field !== "text")
        return pt.offset === 0; // at the start of a cell or caption nothing may be merged away
    if (pt.offset > 0)
        return false; // ordinary deletion inside the text: the browser does it, the diff is sent
    const block = ed.model.block(pt.block);
    if (!isTextBlock(block))
        return true;
    await guarded(ed, async () => {
        if (block.type === "list_item" && (block.attributes?.depth ?? 0) > 0) {
            await ed.op({ op: "block_set", block: block.id, attributes: { depth: (block.attributes?.depth ?? 1) - 1 } });
            ed.focusBlock(block.id, 0);
            return;
        }
        if (block.type !== "paragraph") {
            await ed.op({ op: "block_set", block: block.id, type: "paragraph", attributes: { ordered: null, depth: null, level: null } });
            ed.focusBlock(block.id, 0);
            return;
        }
        const index = ed.model.indexOf(block.id);
        if (index === 0)
            return;
        const prev = ed.model.block(ed.model.order[index - 1]);
        if (isTextBlock(prev)) {
            const joinAt = prev.text.length;
            await ed.op({ op: "merge", block: block.id });
            ed.focusBlock(prev.id, joinAt);
        }
        else if (prev) {
            if (!block.text) {
                await ed.op({ op: "block_delete", block: block.id });
            }
            selectBlock(ed, prev.id);
        }
    });
    return true;
}
export async function forwardDelete(ed) {
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return false;
    if (!sel.collapsed) {
        const at = await replaceRange(ed, sel, "");
        if (at)
            ed.focusBlock(at.block, at.offset);
        return true;
    }
    const pt = sel.start;
    if (pt.field !== "text")
        return false;
    const block = ed.model.block(pt.block);
    if (!isTextBlock(block) || pt.offset < block.text.length)
        return false;
    await guarded(ed, async () => {
        const next = ed.model.block(ed.model.order[ed.model.indexOf(block.id) + 1]);
        if (!next)
            return;
        if (isTextBlock(next)) {
            await ed.op({ op: "merge", block: next.id });
            ed.focusBlock(block.id, pt.offset);
        }
        else {
            if (!block.text)
                await ed.op({ op: "block_delete", block: block.id });
            selectBlock(ed, next.id);
        }
    });
    return true;
}
/** Select a picture, table, equation or EMBED as a whole (Delete then removes it). */
export function selectBlock(ed, id) {
    if (ed.selectedBlock)
        ed.els.get(ed.selectedBlock)?.removeAttribute("data-selected");
    ed.selectedBlock = id;
    const el = ed.els.get(id);
    el?.setAttribute("data-selected", "");
    el?.scrollIntoView({ block: "nearest" });
    const label = ed.model.block(id)?.type ?? "block";
    announce(`${label} selected. Press Delete to remove it, or Enter to edit it.`);
    ed.events.emit({ type: "block-selected", id });
}
export function clearBlockSelection(ed) {
    if (ed.selectedBlock)
        ed.els.get(ed.selectedBlock)?.removeAttribute("data-selected");
    const had = ed.selectedBlock !== null;
    ed.selectedBlock = null;
    if (had)
        ed.events.emit({ type: "block-selected", id: null });
}
export async function deleteBlocks(ed, ids) {
    if (!ids.length || ed.readOnly)
        return;
    const next = ed.model.order[Math.max(0, ed.model.indexOf(ids[0]) - 1)];
    await guarded(ed, async () => { await ed.op({ op: "block_delete", blocks: ids }); clearBlockSelection(ed); if (next && ed.model.block(next))
        ed.focusBlock(next); });
}
/* ---------------------------------------------------------------------------------------------- formatting */
export async function toggleFormat(ed, flag) {
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return;
    if (sel.collapsed) {
        if (ed.pendingFormat.has(flag))
            ed.pendingFormat.delete(flag);
        else
            ed.pendingFormat.add(flag);
        announce(`${flag} ${ed.pendingFormat.has(flag) ? "on" : "off"} for the next text you type`);
        return;
    }
    const ranges = textRanges(ed, sel).filter((r) => r.to > r.from);
    if (!ranges.length)
        return;
    const all = ranges.every((r) => covered(r.block, r.from, r.to, flag));
    const ops = ranges.map((r) => (all ? { op: "format", block: r.block.id, start: r.from, end: r.to, unset: [flag] } : { op: "format", block: r.block.id, start: r.from, end: r.to, set: { [flag]: true } }));
    await guarded(ed, async () => { await ed.op(ops.length === 1 ? ops[0] : { op: "batch", ops, label: "formatting" }); ed.restoreSelection(sel); });
}
export async function setInlineProperty(ed, key, value) {
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return;
    if (sel.collapsed) {
        ed.pendingInline.set(key, value);
        announce(`${key.replaceAll("_", " ")} ${value === null ? "reset to default" : "set"} for the next text you type`);
        return;
    }
    const ops = textRanges(ed, sel).filter((r) => r.to > r.from).map((r) => (value ? { op: "format", block: r.block.id, start: r.from, end: r.to, set: { [key]: value } } : { op: "format", block: r.block.id, start: r.from, end: r.to, unset: [key] }));
    if (ops.length)
        await guarded(ed, async () => { await ed.op({ op: "batch", ops, label: "inline formatting" }); ed.restoreSelection(sel); });
}
export async function setColour(ed, key, value) {
    await setInlineProperty(ed, key, value);
}
/** Change the real text, not a CSS presentation effect; the backend remaps format/link spans. */
export async function transformCase(ed, mode) {
    const sel = ed.readSelection();
    if (!sel || sel.collapsed || ed.readOnly) {
        toast("Select text to change its case.", { kind: "info" });
        return;
    }
    const ranges = textRanges(ed, sel).filter((r) => r.to > r.from);
    if (!ranges.length)
        return;
    await guarded(ed, async () => {
        const oldEnd = ed.model.block(sel.end.block)?.text.length ?? 0;
        const ops = ranges.map((r) => ({ op: "case", block: r.block.id, start: r.from, end: r.to, mode }));
        await ed.op({ op: "batch", ops, label: mode === "upper" ? "uppercase" : "lowercase" });
        const newEnd = ed.model.block(sel.end.block)?.text.length ?? oldEnd;
        ed.restoreSelection({ ...sel, end: { ...sel.end, offset: sel.end.offset + newEnd - oldEnd } });
    });
}
export async function clearFormatting(ed) {
    const sel = ed.readSelection();
    if (!sel || sel.collapsed || ed.readOnly)
        return;
    const ops = textRanges(ed, sel).filter((r) => r.to > r.from).map((r) => ({ op: "format", block: r.block.id, start: r.from, end: r.to, unset: [...FLAGS, "color", "background", "font_family", "font_size_pt"] }));
    if (ops.length)
        await guarded(ed, async () => { await ed.op({ op: "batch", ops, label: "clear formatting" }); ed.restoreSelection(sel); });
}
export async function setLink(ed, href) {
    const sel = ed.readSelection();
    if (!sel || sel.collapsed || sel.start.block !== sel.end.block || ed.readOnly) {
        toast("Select some text in one paragraph to make a link.", { kind: "info" });
        return;
    }
    const op = href ? { op: "span", block: sel.start.block, start: sel.start.offset, end: sel.end.offset, kind: "link", href } : { op: "span", block: sel.start.block, start: sel.start.offset, end: sel.end.offset, kind: "link", clear: true };
    await guarded(ed, async () => { await ed.op(op); ed.restoreSelection(sel); });
}
/* ---------------------------------------------------------------------------------------------- blocks */
function selectedTextIds(ed) {
    const sel = ed.readSelection();
    if (!sel)
        return [];
    return textRanges(ed, sel).map((r) => r.block.id);
}
export async function setBlockType(ed, type, attrs = {}) {
    const ids = selectedTextIds(ed);
    if (!ids.length || ed.readOnly)
        return;
    const clear = { ordered: null, depth: null, level: null, language: null };
    const same = ids.every((id) => { const b = ed.model.block(id); return b?.type === type && Object.entries(attrs).every(([k, v]) => b.attributes?.[k] === v); });
    const target = same && type !== "paragraph" ? "paragraph" : type;
    const attributes = target === "paragraph" ? clear : { ...clear, ...attrs };
    const sel = ed.readSelection();
    await guarded(ed, async () => {
        const ops = ids.map((id) => ({ op: "block_set", block: id, type: target, attributes }));
        await ed.op(ops.length === 1 ? ops[0] : { op: "batch", ops, label: "paragraph type" });
        ed.restoreSelection(sel);
    });
}
export async function setBlockAttribute(ed, attrs, label = "paragraph") {
    const ids = selectedTextIds(ed);
    if (!ids.length || ed.readOnly)
        return;
    const sel = ed.readSelection();
    await guarded(ed, async () => {
        const ops = ids.map((id) => ({ op: "block_set", block: id, attributes: attrs }));
        await ed.op({ op: "batch", ops, label });
        ed.restoreSelection(sel);
    });
}
export async function setParagraphStyle(ed, name) {
    const ids = selectedTextIds(ed);
    if (!ids.length || ed.readOnly)
        return;
    const sel = ed.readSelection();
    await guarded(ed, async () => { await ed.op({ op: "batch", ops: ids.map((id) => ({ op: "block_set", block: id, style: name })), label: "paragraph style" }); ed.restoreSelection(sel); });
}
export async function indent(ed, delta) {
    const ids = selectedTextIds(ed);
    if (!ids.length)
        return false;
    const sel = ed.readSelection();
    await guarded(ed, async () => {
        const ops = ids.map((id) => {
            const block = ed.model.block(id);
            if (block?.type === "list_item")
                return { op: "block_set", block: id, attributes: { depth: Math.max(0, Math.min(8, (block.attributes?.depth ?? 0) + delta)) } };
            const current = Number(block?.attributes?.indent_mm ?? 0);
            return { op: "block_set", block: id, attributes: { indent_mm: Math.max(0, Math.min(1000, current + delta * 5)) } };
        });
        await ed.op({ op: "batch", ops, label: delta > 0 ? "indent" : "outdent" });
        ed.restoreSelection(sel);
    });
    return true;
}
export async function moveBlocks(ed, direction) {
    const sel = ed.readSelection();
    const ids = ed.selectedBlock ? [ed.selectedBlock] : sel ? ed.model.order.slice(ed.model.indexOf(sel.start.block), ed.model.indexOf(sel.end.block) + 1) : [];
    if (!ids.length || ed.readOnly)
        return;
    const first = ed.model.indexOf(ids[0]);
    const last = ed.model.indexOf(ids[ids.length - 1]);
    let after;
    if (direction < 0) {
        if (first === 0)
            return;
        after = first - 2 >= 0 ? ed.model.order[first - 2] : null;
    }
    else {
        if (last >= ed.model.order.length - 1)
            return;
        after = ed.model.order[last + 1];
    }
    await guarded(ed, async () => { await ed.op({ op: "move", blocks: ids, after }); announce(direction < 0 ? "Moved up" : "Moved down"); if (sel)
        ed.restoreSelection(sel); });
}
export async function moveBlocksTo(ed, ids, after) {
    if (!ids.length || ed.readOnly || (after && ids.includes(after)))
        return;
    await guarded(ed, async () => { await ed.op({ op: "move", blocks: ids, after }); announce("Moved"); });
}
/** The block after which new content goes: the one holding the caret (or the selected object), else the last block. */
export function anchorBlock(ed) {
    if (ed.selectedBlock)
        return ed.selectedBlock;
    const sel = ed.readSelection();
    return sel ? sel.end.block : (ed.model.order[ed.model.order.length - 1] ?? null);
}
export async function insertBlock(ed, spec, after) {
    if (ed.readOnly)
        return undefined;
    return guarded(ed, async () => {
        const id = ed.newId();
        await ed.op({ op: "block_insert", after: after === undefined ? anchorBlock(ed) : after, block: { id, ...spec } });
        return id;
    });
}
/** The caret is not inside any paragraph (after Ctrl+End past a picture, say). Put it in the last text block, adding an empty paragraph when the document ends in an object. */
export async function landCaret(ed) {
    if (ed.readOnly)
        return false;
    const order = ed.model.order;
    const last = order[order.length - 1];
    if (last && ed.isText(last)) {
        ed.focusBlock(last, ed.model.block(last)?.text.length ?? 0);
        return "existing";
    }
    const id = await insertBlock(ed, { type: "paragraph", text: "" }, last ?? null);
    if (id) {
        ed.focusBlock(id, 0);
        return "created";
    }
    return false;
}
export async function insertTable(ed, rows, columns) {
    const id = await insertBlock(ed, { type: "table", text: "", rows, columns });
    if (id) {
        ed.scrollToBlock(id);
        focusCell(ed, id, 0, 0);
    }
}
export async function insertEquationBlock(ed, source, syntax = "latex") {
    const id = await insertBlock(ed, { type: "equation", text: "", equation: { syntax, source, domain: syntax === "mhchem" ? "chemistry" : syntax === "sequence" ? "biology" : "mathematics" } });
    if (id)
        selectBlock(ed, id);
}
export async function insertInlineEquation(ed, source, syntax = "latex") {
    const sel = ed.readSelection();
    if (!sel || sel.start.field !== "text") {
        toast("Place the cursor in a paragraph first.", { kind: "info" });
        return;
    }
    await guarded(ed, async () => { await ed.op({ op: "inline_object", block: sel.start.block, at: sel.start.offset, kind: "equation", equation: { syntax, source, domain: syntax === "mhchem" ? "chemistry" : "mathematics" } }); });
}
export async function insertPageBreak(ed) {
    const sel = ed.readSelection();
    const id = sel?.start.block;
    if (!id || !isTextBlock(ed.model.block(id)))
        return;
    const current = ed.model.block(id)?.attributes?.["page_break_before"] === true;
    await guarded(ed, async () => { await ed.op({ op: "block_set", block: id, attributes: { page_break_before: current ? null : true }, label: "page break" }); });
}
/** New page at the caret, as Ctrl+Enter does in Word and Canva: the text after the caret (or an empty paragraph, when the caret is at the end) starts the next page and the caret goes there.
 *  With the caret at the very start of a paragraph the break goes before that paragraph (pressing it again takes the break away). */
export async function newPage(ed) {
    const sel = ed.readSelection();
    if (!sel || ed.readOnly)
        return;
    const block = ed.model.block(sel.start.block);
    if (!block || !isTextBlock(block) || sel.start.field !== "text")
        return;
    if (block.type === "code" || (sel.collapsed && sel.start.offset === 0)) {
        await insertPageBreak(ed);
        return;
    }
    await enter(ed);
    const id = ed.readSelection()?.start.block;
    if (!id || id === block.id)
        return;
    await guarded(ed, async () => { await ed.op({ op: "block_set", block: id, attributes: { page_break_before: true }, label: "new page" }); });
    ed.focusBlock(id, 0);
    announce("New page.");
}
export async function sectionBreak(ed) {
    const sel = ed.readSelection();
    if (!sel)
        return;
    await guarded(ed, async () => { await ed.op({ op: "section_break", block: sel.start.block }); toast("A new section starts here. Change its page setup from Pages / Chapters / Sections.", { kind: "ok" }); });
}
export async function tableEdit(ed, block, action, index = 0, count) {
    await guarded(ed, async () => { await ed.op({ op: "table_edit", block, action, index, ...(count !== undefined ? { count } : {}) }); });
}
export function pxToMm(px) { return px / MM_PX; }
/* ------------------------------------------------------------------------------------------------------------- layers */
/** Write the layers and which block is on which. Nothing is stored while everything is as in a new document. */
export async function writeLayers(ed, rows, onLayer) {
    const plain = rows.every((r) => !r.custom && r.visible && !r.locked);
    const saved = rows.map((r) => ({ id: r.id, name: r.name, visible: r.visible, ...(r.locked ? { locked: true } : {}), ...(r.custom ? { custom: true } : {}) }));
    await ed.op({ op: "ext_set", values: { layers: plain ? null : saved, layer_of: Object.keys(onLayer).length ? onLayer : null }, label: "layers" });
}
/** The blocks an action on "the selection" means: the selected object, or the blocks the text selection touches. */
export function selectedBlockIds(ed) {
    if (ed.selectedBlock)
        return [ed.selectedBlock];
    const sel = ed.recallSelection();
    return sel ? ed.model.order.slice(ed.model.indexOf(sel.start.block), ed.model.indexOf(sel.end.block) + 1) : [];
}
/** Put blocks on a layer (a block is on the layer of its kind unless it was moved, so moving it back removes the note). */
export async function moveToLayer(ed, layer, ids) {
    if (ed.readOnly || !ids.length)
        return;
    const next = { ...(ed.model.ext.layer_of ?? {}) };
    for (const id of ids) {
        const block = ed.model.block(id);
        if (!block)
            continue;
        if (layer === (block.type === "figure" ? "illustrations" : "text"))
            delete next[id];
        else
            next[id] = layer;
    }
    await guarded(ed, () => writeLayers(ed, layerList(ed.model.ext), next));
}
/** A new, empty layer. If a picture, table or other object is selected, it goes onto the new layer (like "new layer from selection"). Returns the layer's id. */
export async function newLayer(ed) {
    if (ed.readOnly)
        return undefined;
    const rows = layerList(ed.model.ext);
    let n = rows.filter((r) => r.custom).length + 1;
    while (rows.some((r) => r.name === `Layer ${n}`))
        n += 1;
    const id = `layer-${Math.random().toString(36).slice(2, 10)}`;
    const taken = ed.selectedBlock ? [ed.selectedBlock] : [];
    const onLayer = { ...(ed.model.ext.layer_of ?? {}) };
    for (const b of taken)
        onLayer[b] = id;
    const ok = await guarded(ed, async () => { await writeLayers(ed, [...rows, { id, name: `Layer ${n}`, visible: true, locked: false, custom: true }], onLayer); return true; });
    if (!ok)
        return undefined;
    announce(taken.length ? `Layer ${n} added, with the selected object on it.` : `Layer ${n} added. Select something and use Move selection here in the Layers panel to put it on this layer.`);
    return id;
}
export async function renameLayer(ed, id, name) {
    const rows = layerList(ed.model.ext).map((r) => (r.id === id && r.custom ? { ...r, name: name.trim().slice(0, 80) || r.name } : r));
    await guarded(ed, () => writeLayers(ed, rows, ed.model.ext.layer_of ?? {}));
}
/** Delete one of the person's layers; what was on it goes back to its own layer. */
export async function deleteLayer(ed, id) {
    const rows = layerList(ed.model.ext).filter((r) => r.id !== id);
    const onLayer = Object.fromEntries(Object.entries(ed.model.ext.layer_of ?? {}).filter(([, layer]) => layer !== id));
    await guarded(ed, () => writeLayers(ed, rows, onLayer));
}
