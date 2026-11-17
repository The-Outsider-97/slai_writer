/** Keyboard, mouse, clipboard and drag-and-drop for the editor. The browser handles plain typing natively (the edit is sent right
 *  after); anything that changes structure (Enter, joining paragraphs, deleting across blocks, pasting, formatting, drops) is cancelled
 *  here and expressed as operations instead. */
import { announce, toast } from "./kit.js";
import * as A from "./actions.js";
import { blockIdOf, editableOf } from "./domtext.js";
import { highlightsSupported } from "./decor.js";
import { analyzeMarkdownTable, MM_PX } from "./textops.js";
import { objectKind } from "./object_kind.js";
import { openShapeTextEditor } from "./shape_text_edit.js";
import { isEditingTextBox, openTextBoxEditor } from "./textbox_edit.js";
import { shapeOf } from "./shape.js";
import { textBoxOf } from "./textbox.js";
function pointFromXY(x, y) {
    const doc = document;
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos)
        return { node: pos.offsetNode, offset: pos.offset };
    const range = doc.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
}
function wrapperAt(ed, target) {
    return target instanceof Element ? target.closest(".blk") : null;
}
function lockedBlock(ed, id) {
    const block = ed.model.block(id);
    if (!block)
        return false;
    const ctx = ed.ctx();
    return ctx.locks.has(`layer:${ctx.layerOf(block)}`);
}
export function installInput(ed) {
    const host = ed.host;
    let enterWithShift = false;
    const off = [];
    const on = (type, fn, target = host) => {
        target.addEventListener(type, fn);
        off.push(() => target.removeEventListener(type, fn));
    };
    let busy = false;
    let running = null;
    const backlog = [];
    const drain = async () => {
        try {
            while (backlog.length) {
                const next = backlog.shift();
                if (!next)
                    continue;
                try {
                    await next.run();
                }
                catch { /* each action reports its own error */ }
            }
        }
        finally {
            busy = false;
            running = null;
        }
    };
    const serial = (fn) => {
        backlog.push({ run: fn });
        if (busy)
            return;
        busy = true;
        running = drain();
    };
    /** ClipboardEvent is the authoritative source of pasted text. Chromium and Firefox
     * may expose no DataTransfer on the subsequent beforeinput event, so relying on
     * beforeinput alone silently discards content copied from other applications. */
    const pasteGrid = async (values, saved) => {
        if (!saved || saved.start.field !== "cell" || values.length === 0 || !values[0]?.length)
            return false;
        const pt = saved.start;
        const table = ed.model.block(pt.block)?.table;
        if (!table)
            return false;
        if (table.rows.some((row) => row.some((cell) => (cell.rowspan ?? 1) > 1 || (cell.colspan ?? 1) > 1))) {
            toast("Paste into merged tables cell by cell; expanding merged grids is not supported.", { kind: "info" });
            return true;
        }
        const startRow = pt.row ?? 0, startCol = pt.col ?? 0;
        const height = values.length, width = Math.max(...values.map((row) => row.length));
        if (startRow + height > 10000 || startCol + width > 256 || (startRow + height) * (startCol + width) > 20000) {
            toast("The pasted grid exceeds the table's size limits.", { kind: "error" });
            return true;
        }
        await ed.flush();
        const ops = [];
        for (let c = table.columns; c < startCol + width; c++)
            ops.push({ op: "table_edit", block: pt.block, action: "insert_col", index: c });
        for (let r = table.rows.length; r < startRow + height; r++)
            ops.push({ op: "table_edit", block: pt.block, action: "insert_row", index: r });
        values.forEach((row, r) => row.forEach((text, c) => ops.push({ op: "table_cell", block: pt.block,
            row: startRow + r, col: startCol + c, text: ed.clean(text).slice(0, 20000) })));
        await ed.op({ op: "batch", ops, label: "paste table data" });
        A.focusCell(ed, pt.block, startRow, startCol);
        return true;
    };
    const pasteText = (text, saved = ed.readSelection(), grid) => {
        serial(async () => {
            if (ed.readOnly)
                return;
            if (saved)
                ed.refocus(saved);
            else if (!(await A.landCaret(ed))) {
                toast("Click in the document before pasting.", { kind: "info" });
                return;
            }
            const rows = grid ?? (text.includes("\t") ? text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((row) => row.split("\t")) : undefined);
            if (rows && await pasteGrid(rows, saved))
                return;
            const found = analyzeMarkdownTable(text);
            const wherever = !!saved?.collapsed && saved.start.field === "text"; // a table is only made at a caret in the text, never over a selection or in a cell
            if (found.kind === "table" && wherever) {
                await A.insertTable(ed, found.table.rows.length, found.table.columns, { selection: saved, object: null }, found.table);
                return;
            }
            await A.insertText(ed, text);
            if (found.kind === "rejected")
                A.tableLeftAsText(found.message);
            else if (found.kind === "table")
                toast("Pasted as text because text was selected or the cursor was not in a paragraph. Use Convert Markdown text to table to make it a table.", { kind: "info" });
        });
    };
    /** Typed characters held behind a structural edit are merged into one insertion, so catching up costs one round trip, not one per key. */
    const holdText = (data) => {
        const last = backlog[backlog.length - 1];
        if (last && last.text !== undefined) {
            last.text += data;
            return;
        }
        const item = { text: data, run: async () => { const t = item.text ?? ""; if (!(t === "/" && openSlash()))
                await A.insertText(ed, t); } };
        backlog.push(item);
    };
    ed.settleHook = async () => { while (running)
        await running; };
    /** A "/" typed in an empty paragraph opens the function search instead of being inserted. True when it did. */
    const openSlash = () => {
        const sel = ed.readSelection();
        if (!sel?.collapsed || sel.start.field !== "text")
            return false;
        const block = ed.model.block(sel.start.block);
        if (!block || block.type === "code" || block.text !== "")
            return false;
        const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
        const r = range?.getBoundingClientRect();
        ed.events.emit({ type: "slash", block: block.id, x: r?.left || 80, y: r?.bottom || 120 });
        return true;
    };
    let dragged = null;
    /* ------------------------------------------------------------------------------------------ beforeinput */
    on("beforeinput", (raw) => {
        const e = raw;
        if (ed.readOnly) {
            e.preventDefault();
            return;
        }
        const type = e.inputType;
        if (type.startsWith("insertComposition") || type === "insertCompositionText")
            return;
        const sel = ed.readSelection();
        if (!sel && !ed.selectedBlock && (type === "insertText" || type === "insertParagraph" || type === "insertLineBreak" || (type === "insertFromPaste" && !!e.dataTransfer?.getData("text/plain")))) {
            // Nothing editable holds the caret. The browser would show the text but nothing would send it, so it is held, the caret is placed, and it is replayed.
            e.preventDefault();
            const data = type === "insertText" && typeof e.data === "string" ? e.data : null;
            if (type === "insertFromPaste") {
                pasteText(e.dataTransfer?.getData("text/plain") ?? "", null);
                return;
            }
            serial(async () => { const landed = await A.landCaret(ed); if (!landed)
                return; if (data !== null)
                await A.insertText(ed, data);
            else if (landed === "existing")
                await A.enter(ed); });
            return;
        }
        if (sel && lockedBlock(ed, sel.start.block)) {
            e.preventDefault();
            announce("This layer is locked. Unlock it in the Layers panel to edit.", "assertive");
            return;
        }
        if (busy && type === "insertText" && typeof e.data === "string") {
            e.preventDefault();
            holdText(e.data);
            return;
        }
        const spans = !!sel && !sel.collapsed && (sel.start.block !== sel.end.block || sel.start.field !== sel.end.field);
        if (ed.selectedBlock && (type.startsWith("delete") || type === "insertText")) {
            e.preventDefault();
            if (type.startsWith("delete"))
                void A.deleteBlocks(ed, [ed.selectedBlock]);
            return;
        }
        switch (type) {
            case "insertParagraph":
                e.preventDefault();
                serial(() => A.enter(ed));
                return;
            case "insertLineBreak":
                e.preventDefault();
                serial(() => (enterWithShift ? A.lineBreak(ed) : A.enter(ed)));
                return; // a plain-text field reports Enter as a line break too: the key says which it was
            case "historyUndo":
                e.preventDefault();
                serial(() => A.undoRedo(ed, "undo"));
                return;
            case "historyRedo":
                e.preventDefault();
                serial(() => A.undoRedo(ed, "redo"));
                return;
            case "formatBold":
                e.preventDefault();
                void A.toggleFormat(ed, "bold");
                return;
            case "formatItalic":
                e.preventDefault();
                void A.toggleFormat(ed, "italic");
                return;
            case "formatUnderline":
                e.preventDefault();
                void A.toggleFormat(ed, "underline");
                return;
            case "formatStrikeThrough":
                e.preventDefault();
                void A.toggleFormat(ed, "strike");
                return;
            case "formatSubscript":
                e.preventDefault();
                void A.toggleFormat(ed, "subscript");
                return;
            case "formatSuperscript":
                e.preventDefault();
                void A.toggleFormat(ed, "superscript");
                return;
            case "insertFromDrop":
                e.preventDefault();
                return;
            case "insertFromPaste":
            case "insertFromPasteAsQuotation":
            case "insertFromYank": {
                // The paste handler normally consumes this event first. If a browser
                // supplies neither clipboard data here nor a usable paste event, allow
                // native insertion to flow through the editor's input observer.
                const data = e.dataTransfer;
                if (!data)
                    return;
                e.preventDefault();
                const files = Array.from(data.files);
                if (files.length) {
                    ed.events.emit({ type: "files", files, after: sel?.end.block ?? null });
                    return;
                }
                const text = data.getData("text/plain");
                if (text)
                    pasteText(text, sel);
                return;
            }
            case "insertText":
            case "insertReplacementText": {
                if (e.data === "/" && openSlash()) {
                    e.preventDefault();
                    return;
                }
                if (spans && sel) {
                    e.preventDefault();
                    serial(async () => {
                        const at = await A.replaceRange(ed, sel, ed.clean(e.data ?? ""));
                        if (at) {
                            if (at.field === "cell")
                                A.focusCell(ed, at.block, at.row ?? 0, at.col ?? 0, at.offset);
                            else
                                ed.focusBlock(at.block, at.offset);
                        }
                    });
                }
                return;
            }
            case "deleteByCut":
            case "deleteByDrag":
            case "deleteContent": {
                if (sel && !sel.collapsed) {
                    e.preventDefault();
                    if (type !== "deleteByDrag")
                        serial(async () => {
                            const at = await A.replaceRange(ed, sel, "");
                            if (at) {
                                if (at.field === "cell")
                                    A.focusCell(ed, at.block, at.row ?? 0, at.col ?? 0, at.offset);
                                else
                                    ed.focusBlock(at.block, at.offset);
                            }
                        });
                }
                return;
            }
            default: break;
        }
        if (type.startsWith("deleteContentBackward") || type === "deleteWordBackward" || type === "deleteSoftLineBackward" || type === "deleteHardLineBackward") {
            if (!sel)
                return;
            if (!sel.collapsed || sel.start.offset === 0) {
                e.preventDefault();
                serial(() => A.backspace(ed));
            }
            return;
        }
        if (type === "deleteContentForward" || type === "deleteWordForward" || type === "deleteSoftLineForward" || type === "deleteHardLineForward") {
            if (!sel)
                return;
            const block = ed.model.block(sel.start.block);
            const atEnd = sel.start.field === "text" && !!block && sel.start.offset >= block.text.length;
            if (!sel.collapsed || atEnd) {
                e.preventDefault();
                serial(() => A.forwardDelete(ed));
            }
            return;
        }
        if (spans)
            e.preventDefault();
    });
    on("input", () => {
        const s = window.getSelection();
        const field = editableOf(s?.anchorNode ?? null);
        if (field)
            ed.touched(field);
    });
    on("compositionstart", () => { ed.composing = true; });
    on("compositionend", () => {
        ed.composing = false;
        const field = editableOf(window.getSelection()?.anchorNode ?? null);
        if (field)
            ed.touched(field);
    });
    /* ------------------------------------------------------------------------------------------ keys */
    on("keydown", (e) => {
        if (e.isComposing || ed.composing)
            return;
        if (e.key === "Enter")
            enterWithShift = e.shiftKey;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        const run = (fn) => { e.preventDefault(); void fn(); };
        if (!mod && !e.altKey && (e.key === "PageDown" || e.key === "PageUp")) {
            // PageDown / PageUp move the caret one screen and keep it where it was on the screen, as in a word processor (the browser would only scroll)
            const selection = window.getSelection();
            const scroller = ed.page.scroller;
            if (!selection || !selection.rangeCount || !host.contains(selection.anchorNode))
                return;
            const range = selection.getRangeAt(0).cloneRange();
            range.collapse(selection.isCollapsed ? true : false);
            const rects = range.getClientRects();
            const field = editableOf(selection.anchorNode)?.getBoundingClientRect();
            const caret = rects[0] && rects[0].height > 0 ? rects[0] : null; // an empty line has no rectangle of its own: the paragraph's line is used
            const x = caret ? caret.left : (field?.left ?? 0) + 12;
            const y = caret ? caret.top + caret.height / 2 : (field?.top ?? scroller.getBoundingClientRect().top + 60) + 10;
            const delta = (e.key === "PageDown" ? 1 : -1) * Math.max(80, scroller.clientHeight * 0.9);
            const before = scroller.scrollTop;
            scroller.scrollTop = before + delta;
            const moved = scroller.scrollTop - before;
            const rect = scroller.getBoundingClientRect();
            const target = Math.max(rect.top + 4, Math.min(rect.bottom - 4, y));
            const hit = document.caretPositionFromPoint?.(x, target);
            const at = hit ?? (() => { const r = document.caretRangeFromPoint?.(x, target); return r ? { offsetNode: r.startContainer, offset: r.startOffset } : null; })();
            if (at && host.contains(at.offsetNode) && editableOf(at.offsetNode)) {
                e.preventDefault();
                if (e.shiftKey && selection.anchorNode)
                    selection.extend(at.offsetNode, at.offset);
                else
                    selection.collapse(at.offsetNode, at.offset);
            }
            else {
                // Nothing to land on at that height (the desk below the last page, or above the first): the caret goes to the end or the start of the document, as in a word processor
                e.preventDefault();
                const texts = [...host.querySelectorAll("[data-edit='text']")];
                const edge = e.key === "PageDown" ? texts[texts.length - 1] : texts[0];
                if (edge) {
                    const offset = e.key === "PageDown" ? edge.childNodes.length : 0;
                    if (e.shiftKey && selection.anchorNode)
                        selection.extend(edge, offset);
                    else {
                        edge.focus({ preventScroll: true });
                        selection.collapse(edge, offset);
                    }
                    edge.scrollIntoView({ block: "nearest" });
                }
            }
            void moved;
            return;
        }
        if (mod && !e.altKey && (e.key === "Home" || e.key === "End")) {
            // Ctrl+Home / Ctrl+End: the start and the end of the document, in a paragraph (the browser would leave the caret on the page itself)
            const texts = [...host.querySelectorAll("[data-edit='text']")];
            const target = e.key === "Home" ? texts[0] : texts[texts.length - 1];
            if (!target)
                return;
            e.preventDefault();
            const selection = window.getSelection();
            const at = e.key === "Home" ? 0 : target.childNodes.length;
            if (e.shiftKey && selection?.anchorNode)
                selection.extend(target, at);
            else {
                target.focus({ preventScroll: true });
                selection?.collapse(target, at);
            }
            target.scrollIntoView({ block: "nearest" });
            return;
        }
        if (mod && !e.altKey) {
            if (k === "b" && !e.shiftKey)
                return run(() => A.toggleFormat(ed, "bold"));
            if (k === "i" && !e.shiftKey)
                return run(() => A.toggleFormat(ed, "italic"));
            if (k === "u" && !e.shiftKey)
                return run(() => A.toggleFormat(ed, "underline"));
            if (k === "x" && e.shiftKey)
                return run(() => A.toggleFormat(ed, "strike"));
            if (k === ",")
                return run(() => A.toggleFormat(ed, "subscript"));
            if (k === ".")
                return run(() => A.toggleFormat(ed, "superscript"));
            if (k === "z")
                return run(() => serial(() => A.undoRedo(ed, e.shiftKey ? "redo" : "undo")));
            if (k === "y")
                return run(() => serial(() => A.undoRedo(ed, "redo")));
            if (k === "s")
                return run(() => { ed.events.emit({ type: "save" }); });
            if (k === "f" || k === "h")
                return run(() => { ed.events.emit({ type: "find" }); });
            if (k === "k")
                return run(() => { ed.events.emit({ type: "command", name: "link" }); });
            if (k === "/")
                return run(() => { ed.events.emit({ type: "slash", block: ed.readSelection()?.start.block ?? "", x: 120, y: 160 }); });
            if (k === "e" && e.shiftKey)
                return run(() => A.setBlockAttribute(ed, { align: "center" }, "alignment"));
            if (k === "l" && e.shiftKey)
                return run(() => A.setBlockAttribute(ed, { align: "left" }, "alignment"));
            if (k === "r" && e.shiftKey)
                return run(() => A.setBlockAttribute(ed, { align: "right" }, "alignment"));
            if (k === "j" && e.shiftKey)
                return run(() => A.setBlockAttribute(ed, { align: "justify" }, "alignment"));
            if (e.code === "Digit7" && e.shiftKey)
                return run(() => A.setBlockType(ed, "list_item", { ordered: true, depth: 0 }));
            if (e.code === "Digit8" && e.shiftKey)
                return run(() => A.setBlockType(ed, "list_item", { ordered: false, depth: 0 }));
            if (e.key === "Enter")
                return run(() => A.newPage(ed));
        }
        if (mod && e.altKey && /^[0-6]$/.test(e.key)) {
            return run(() => (e.key === "0" ? A.setBlockType(ed, "paragraph") : A.setBlockType(ed, "heading", { level: Number(e.key) })));
        }
        if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
            return run(() => A.moveBlocks(ed, e.key === "ArrowUp" ? -1 : 1));
        if (e.key === "Tab" && !mod && !e.altKey) {
            const sel = ed.readSelection();
            if (sel?.start.field === "cell") {
                if (A.focusNextCell(ed, sel.start, e.shiftKey))
                    e.preventDefault();
                return;
            }
            if (sel && ed.model.block(sel.start.block)?.type === "list_item")
                return run(() => { void A.indent(ed, e.shiftKey ? -1 : 1); });
            return; // anywhere else Tab leaves the page (no keyboard trap)
        }
        if (ed.selectedBlock) {
            if (e.key === "Delete" || e.key === "Backspace")
                return run(() => A.deleteBlocks(ed, [ed.selectedBlock]));
            if (e.key === "Enter" && textBoxOf(shapeOf(ed.model.block(ed.selectedBlock)))) {
                e.preventDefault();
                openTextBoxEditor(ed, ed.selectedBlock);
                return;
            }
            if (e.key === "Enter")
                return run(() => { const b = ed.model.block(ed.selectedBlock); const kind = b ? objectKind(b.type, Boolean(b.extensions?.["slai.writer.shape"])) : null; if (b && kind)
                    ed.events.emit({ type: "open-object", kind, block: b.id }); });
            if (e.key === "Escape") {
                A.clearBlockSelection(ed);
                return;
            }
        }
        if (e.key === "Escape") {
            const s = window.getSelection();
            if (s && !s.isCollapsed)
                s.collapseToEnd();
        }
    });
    let gridDrag = null;
    const logicalBoundary = (rows, row, index) => {
        const occupied = new Set();
        for (let r = 0; r <= row; r++) {
            let column = 0;
            for (const [position, cell] of (rows[r] ?? []).entries()) {
                while (occupied.has(`${r},${column}`))
                    column++;
                const width = cell.colspan ?? 1, height = cell.rowspan ?? 1;
                if (r === row && position === index)
                    return column + width - 1;
                for (let y = r; y < r + height; y++)
                    for (let x = column; x < column + width; x++)
                        occupied.add(`${y},${x}`);
                column += width;
            }
        }
        return -1;
    };
    const gridBorder = (target, x, y) => {
        const cell = target instanceof Element ? target.closest("table.tbl .cell") : null;
        const table = cell?.closest("table.tbl");
        const wrap = table?.closest(".b-table");
        const id = wrap?.dataset["id"];
        const data = id ? ed.model.block(id)?.table : null;
        if (!cell || !table || !wrap || !id || !data || ed.readOnly || lockedBlock(ed, id))
            return null;
        const rect = cell.getBoundingClientRect();
        const tolerance = 7;
        const column = logicalBoundary(data.rows, Number(cell.dataset["row"]), Number(cell.dataset["col"]));
        const row = Number(cell.dataset["row"]) + cell.rowSpan - 1;
        const vertical = Math.abs(x - rect.right) <= tolerance;
        const horizontal = Math.abs(y - rect.bottom) <= tolerance;
        if (vertical && column < data.columns)
            return { wrap, table, block: id, axis: "col", index: column };
        if (horizontal && row < data.rows.length)
            return { wrap, table, block: id, axis: "row", index: row };
        return null;
    };
    const measureGrid = (hit, start) => {
        const block = ed.model.block(hit.block);
        const count = block?.table?.columns ?? 1;
        const layout = block?.extensions?.["slai.writer.table_layout"];
        const width = hit.table.getBoundingClientRect().width / MM_PX / ed.page.zoom / count;
        const widths = layout?.column_widths_mm?.length === count ? [...layout.column_widths_mm] : Array(count).fill(width);
        const total = block?.table?.rows.length ?? hit.table.rows.length; // a table cut across pages is in several pieces: rows are found by their number
        const rowOf = (r) => {
            for (let c = 0; c < 64; c += 1) {
                const cell = ed.page.cellEl(hit.block, r, c);
                if (cell)
                    return cell.closest("tr");
            }
            return null;
        };
        const heights = layout?.row_heights_mm?.length === total ? [...layout.row_heights_mm]
            : Array.from({ length: total }, (_, r) => { const tr = rowOf(r); return tr ? tr.getBoundingClientRect().height / MM_PX / ed.page.zoom : 7; });
        return { ...hit, start, widths, heights };
    };
    const previewGrid = (drag, delta) => {
        if (drag.axis === "col") {
            const index = drag.index;
            const next = drag.widths[index] ?? 8;
            const neighbor = drag.widths[index + 1];
            const allowed = neighbor === undefined ? Math.max(8, next + delta) - next
                : Math.max(8 - next, Math.min(delta, neighbor - 8));
            drag.widths[index] = next + allowed;
            if (neighbor !== undefined)
                drag.widths[index + 1] = neighbor - allowed;
            let cols = drag.table.querySelector("colgroup");
            if (!cols) {
                cols = document.createElement("colgroup");
                drag.table.prepend(cols);
            }
            cols.replaceChildren(...drag.widths.map((mm) => {
                const col = document.createElement("col");
                col.style.width = `${mm}mm`;
                return col;
            }));
            drag.table.style.width = `${drag.widths.reduce((a, b) => a + b, 0)}mm`;
        }
        else {
            drag.heights[drag.index] = Math.max(4, (drag.heights[drag.index] ?? 4) + delta);
            let tr = null;
            for (let c = 0; c < 64 && !tr; c += 1)
                tr = ed.page.cellEl(drag.block, drag.index, c)?.closest("tr") ?? null;
            if (tr)
                tr.style.height = `${drag.heights[drag.index]}mm`;
        }
    };
    on("pointermove", (e) => {
        if (gridDrag)
            return;
        const hit = gridBorder(e.target, e.clientX, e.clientY);
        const table = e.target?.closest?.("table.tbl");
        if (table)
            table.style.cursor = hit ? hit.axis === "col" ? "col-resize" : "row-resize" : "";
    });
    on("pointerdown", (e) => {
        if (e.button !== 0)
            return;
        const hit = gridBorder(e.target, e.clientX, e.clientY);
        if (!hit)
            return;
        e.preventDefault();
        gridDrag = measureGrid(hit, hit.axis === "col" ? e.clientX : e.clientY);
        hit.wrap.dataset["tableResizing"] = hit.axis;
    });
    const moveGrid = (event) => {
        if (!gridDrag)
            return;
        event.preventDefault();
        const next = gridDrag.axis === "col" ? event.clientX : event.clientY;
        const delta = (next - gridDrag.start) / MM_PX / ed.page.zoom;
        gridDrag.start = next;
        previewGrid(gridDrag, delta);
    };
    const endGrid = () => {
        const drag = gridDrag;
        if (!drag)
            return;
        gridDrag = null;
        delete drag.wrap.dataset["tableResizing"];
        const props = drag.axis === "col" ? { column_widths_mm: drag.widths.map((n) => Math.round(n * 10) / 10) }
            : { row_heights_mm: drag.heights.map((n) => Math.round(n * 10) / 10) };
        void ed.op({ op: "table_layout", block: drag.block, props }).catch((error) => ed.failed(error));
    };
    document.addEventListener("pointermove", moveGrid);
    document.addEventListener("pointerup", endGrid);
    document.addEventListener("pointercancel", endGrid);
    off.push(() => {
        document.removeEventListener("pointermove", moveGrid);
        document.removeEventListener("pointerup", endGrid);
        document.removeEventListener("pointercancel", endGrid);
    });
    on("click", (e) => {
        const target = e.target;
        if (target.closest(".shape-direct-editor"))
            return;
        const add = target.closest("[data-table-add]");
        if (add) {
            e.preventDefault();
            const id = add.closest(".blk")?.dataset["id"];
            const table = id ? ed.model.block(id)?.table : undefined;
            if (!id || !table || ed.readOnly || lockedBlock(ed, id))
                return;
            const row = add.dataset["tableAdd"] === "row";
            void A.tableEdit(ed, id, row ? "insert_row" : "insert_col", row ? table.rows.length : table.columns);
            return;
        }
        const link = target.closest(".i-link");
        if (link) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey)
                ed.events.emit({ type: "link", href: link.dataset["href"] ?? "" });
            return;
        }
        const ref = target.closest(".i-cite, .i-fn");
        if (ref) {
            ed.events.emit({ type: "reference", id: ref.dataset["ref"] ?? "" });
            return;
        }
        const xref = target.closest(".i-xref");
        if (xref) {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey)
                ed.scrollToBlock(xref.dataset["target"] ?? "");
            return;
        }
        const wrap = wrapperAt(ed, target);
        const type = wrap?.dataset["type"];
        const inField = !!target.closest("[data-edit]");
        if (wrap && !inField && wrap.querySelector(".writer-shape[data-textbox]")) {
            // A text box: its border selects it; a click on the text inside edits the text. Neither moves or resizes anything.
            const id = wrap.dataset["id"];
            const box = wrap.querySelector(".writer-shape[data-textbox]");
            if (isEditingTextBox(id))
                return;
            A.selectBlock(ed, id, e.shiftKey);
            const r = box.getBoundingClientRect();
            const band = 7;
            const onBorder = e.clientX - r.left < band || r.right - e.clientX < band || e.clientY - r.top < band || r.bottom - e.clientY < band;
            if (!onBorder && !e.shiftKey && target.closest(".tb-body"))
                openTextBoxEditor(ed, id, { x: e.clientX, y: e.clientY });
            return;
        }
        if (wrap && !inField && (wrap.querySelector(".writer-shape") || type === "figure" || type === "equation" || type === "embed" || type === "table")) {
            A.selectBlock(ed, wrap.dataset["id"], e.shiftKey && !!wrap.querySelector(".writer-shape"));
            if (type === "embed")
                ed.events.emit({ type: "open-object", kind: "embed", block: wrap.dataset["id"] });
            return;
        }
        if (ed.selectedBlock)
            A.clearBlockSelection(ed);
    });
    on("dblclick", (e) => {
        const target = e.target;
        if (target.closest(".shape-direct-editor"))
            return;
        const shapeWrap = wrapperAt(ed, target);
        const shapeId = shapeWrap?.dataset["id"];
        if (shapeId && shapeWrap?.querySelector(".writer-shape[data-textbox]")) {
            if (isEditingTextBox(shapeId))
                return; // inside the text, the browser selects the word
            if (!ed.readOnly) {
                e.preventDefault();
                e.stopPropagation();
                A.selectBlock(ed, shapeId);
                openTextBoxEditor(ed, shapeId, { x: e.clientX, y: e.clientY });
            }
            return;
        }
        if (shapeId && shapeWrap?.querySelector(".writer-shape") && !ed.readOnly) {
            e.preventDefault();
            e.stopPropagation();
            openShapeTextEditor(ed, shapeId);
            return;
        }
        const wrap = wrapperAt(ed, target);
        const type = wrap?.dataset["type"];
        if (target.closest(".i-eq")) {
            const id = blockIdOf(target);
            if (id)
                ed.events.emit({ type: "open-object", kind: "equation", block: id });
            return;
        }
        const kind = objectKind(type, Boolean(wrap?.querySelector(".writer-shape")), false);
        if (wrap && kind && !target.closest("[data-edit]")) {
            ed.events.emit({ type: "open-object", kind, block: wrap.dataset["id"] });
            return;
        }
        // double-click on a search result turns it into a note
        const at = pointFromXY(e.clientX, e.clientY);
        const id = at ? blockIdOf(at.node) : null;
        if (at && id && highlightsSupported()) {
            const field = editableOf(at.node);
            if (field?.dataset["edit"] === "text") {
                const sel = ed.readSelection();
                const offset = sel?.start.block === id ? sel.start.offset : 0;
                const mark = ed.decor.at("search", id, offset) ?? ed.decor.at("search-current", id, offset);
                if (mark)
                    ed.events.emit({ type: "note-from-match", block: id, start: mark.start, end: mark.end });
            }
        }
    });
    on("contextmenu", (e) => {
        const target = e.target;
        const wrap = target instanceof Element ? wrapperAt(ed, target) : null;
        if (wrap?.querySelector(".writer-shape") && wrap.dataset["id"])
            A.selectBlock(ed, wrap.dataset["id"]);
        e.preventDefault();
        ed.events.emit({ type: "context", x: e.clientX, y: e.clientY });
    });
    /* ------------------------------------------------------------------------------------------ clipboard */
    const SHAPE_CLIP = "application/x-slai-writer-shape+json";
    const shapeClipText = (shape) => {
        const box = shape.textbox;
        return box?.paragraphs ? box.paragraphs.map((p) => p.text).join("\n") : `Writer ${shape.kind} vector shape`;
    };
    const selectedShape = () => {
        const id = ed.selectedBlock;
        const item = id ? ed.model.block(id) : undefined;
        const shape = item?.extensions?.["slai.writer.shape"];
        return id && shape && item?.type === "paragraph" ? { id, shape } : null;
    };
    const pasteShape = (raw) => {
        if (raw.length > 50_000) {
            toast("Copied shape is too large.", { kind: "error" });
            return;
        }
        try {
            const shape = JSON.parse(raw);
            if (shape.version !== 1 || typeof shape.kind !== "string")
                throw Error("Not a Writer shape");
            const clone = structuredClone(shape);
            delete clone.group_id;
            const pasted = clone.textbox;
            if (pasted) {
                pasted.pinned = false;
                pasted.locked = false;
            } // a copy is a new, free text box
            const place = clone.layout;
            if (pasted && place?.mode === "floating") {
                place.x_mm = Math.min(5000, (place.x_mm ?? 0) + 5);
                place.y_mm = Math.min(5000, (place.y_mm ?? 0) + 5);
            }
            void A.insertBlock(ed, { type: "paragraph", text: "", extensions: { "slai.writer.shape": clone } })
                .then(id => { if (id)
                A.selectBlock(ed, id); })
                .catch(error => ed.failed(error));
        }
        catch (_error) {
            toast("The clipboard does not contain a valid Writer shape.", { kind: "error" });
        }
    };
    /** A picture on the clipboard (a screenshot, "Copy image" in a browser, a file copied in the file manager) is brought in as a picture. Text that comes with it
     *  (a spreadsheet cell copies both) wins: then the text is pasted as usual. A picture that only exists as a web address is not fetched. */
    on("paste", (e) => {
        const data = e.clipboardData;
        if (ed.readOnly) {
            e.preventDefault();
            return;
        }
        if (!data)
            return;
        if (data.types.includes(SHAPE_CLIP)) {
            e.preventDefault();
            e.stopPropagation();
            pasteShape(data.getData(SHAPE_CLIP));
            return;
        }
        const pictures = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
        const text = data.getData("text/plain");
        const html = data.getData("text/html");
        const grid = (() => {
            if (!html || !ed.readSelection()?.start.field.includes("cell"))
                return undefined;
            const htmlDoc = new DOMParser().parseFromString(html, "text/html");
            const table = htmlDoc.querySelector("table");
            if (!table)
                return undefined;
            const rows = Array.from(table.querySelectorAll("tr")).map((row) => Array.from(row.children)
                .filter((cell) => /^(TD|TH)$/.test(cell.tagName)).map((cell) => cell.textContent ?? ""));
            return rows.length && rows.every((row) => row.length > 0) ? rows : undefined;
        })();
        const hasText = text.length > 0;
        if (hasText || grid) {
            e.preventDefault();
            pasteText(text, ed.readSelection(), grid);
            return;
        }
        if (pictures.length && !hasText) {
            e.preventDefault();
            e.stopPropagation();
            ed.events.emit({ type: "files", files: pictures, after: A.anchorBlock(ed) });
            return;
        }
        if (!pictures.length && !hasText && /<img\b/i.test(data.getData("text/html"))) {
            e.preventDefault();
            toast("That picture is only a link to a web page, which Writer does not download for you. Save the picture, then drag it in or use Insert > Picture.", { kind: "info" });
        }
    });
    on("copy", (e) => {
        const selected = selectedShape();
        if (selected && e.clipboardData) {
            e.preventDefault();
            e.clipboardData.setData(SHAPE_CLIP, JSON.stringify(selected.shape));
            e.clipboardData.setData("text/plain", shapeClipText(selected.shape));
            return;
        }
        const text = ed.selectionText();
        if (!text)
            return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", text);
    });
    on("cut", (e) => {
        const selected = selectedShape();
        if (selected && e.clipboardData && !ed.readOnly) {
            e.preventDefault();
            e.clipboardData.setData(SHAPE_CLIP, JSON.stringify(selected.shape));
            e.clipboardData.setData("text/plain", shapeClipText(selected.shape));
            void A.deleteBlocks(ed, [selected.id]);
            return;
        }
        const sel = ed.readSelection();
        const text = ed.selectionText(sel);
        if (!sel || !text || ed.readOnly || !e.clipboardData)
            return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
        serial(async () => {
            ed.refocus(sel);
            const at = await A.replaceRange(ed, sel, "");
            if (at) {
                if (at.field === "cell")
                    A.focusCell(ed, at.block, at.row ?? 0, at.col ?? 0, at.offset);
                else
                    ed.focusBlock(at.block, at.offset);
            }
        });
    });
    /* ------------------------------------------------------------------------------------------ drag and drop */
    const clearIndicators = () => host.querySelectorAll(".drop-before, .drop-after, .dragging").forEach((n) => n.classList.remove("drop-before", "drop-after", "dragging"));
    on("dragstart", (e) => {
        const target = e.target;
        const grip = target.closest("[data-grip]");
        if (grip) {
            const wrap = grip.closest(".blk");
            if (!wrap || !e.dataTransfer)
                return;
            dragged = { kind: "block", id: wrap.dataset["id"] };
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-writer-block", wrap.dataset["id"]);
            e.dataTransfer.setData("text/plain", "");
            try {
                e.dataTransfer.setDragImage(wrap, 10, 10);
            }
            catch { /* optional */ }
            wrap.classList.add("dragging");
            return;
        }
        const sel = ed.readSelection();
        const text = ed.selectionText(sel);
        dragged = sel && text ? { kind: "text", text, sel } : null;
    });
    on("dragover", (e) => {
        const types = Array.from(e.dataTransfer?.types ?? []);
        if (ed.readOnly)
            return;
        const files = types.includes("Files");
        if (!files && !types.includes("application/x-writer-block") && !types.includes("text/plain"))
            return;
        e.preventDefault();
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = dragged?.kind === "text" ? "move" : files ? "copy" : "move";
        host.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
        if (dragged?.kind === "block" || files) {
            const wrap = wrapperAt(ed, e.target);
            if (wrap) {
                const r = wrap.getBoundingClientRect();
                wrap.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
            }
        }
    });
    on("dragleave", (e) => { if (e.target === host)
        clearIndicators(); });
    on("dragend", () => { clearIndicators(); dragged = null; });
    on("drop", (e) => {
        if (ed.readOnly)
            return;
        e.preventDefault();
        const wrap = wrapperAt(ed, e.target);
        const rect = wrap?.getBoundingClientRect();
        const dropAfter = !!rect && e.clientY >= rect.top + rect.height / 2;
        clearIndicators();
        const files = Array.from(e.dataTransfer?.files ?? []);
        const index = wrap ? ed.model.indexOf(wrap.dataset["id"]) : ed.model.order.length - 1;
        const afterId = wrap ? (dropAfter ? wrap.dataset["id"] : (index > 0 ? ed.model.order[index - 1] : null)) : (ed.model.order[ed.model.order.length - 1] ?? null);
        if (files.length) {
            ed.events.emit({ type: "files", files, after: afterId });
            dragged = null;
            return;
        }
        if (dragged?.kind === "block") {
            void A.moveBlocksTo(ed, [dragged.id], afterId);
            dragged = null;
            return;
        }
        const text = dragged?.kind === "text" ? dragged.text : e.dataTransfer?.getData("text/plain") ?? "";
        if (!text) {
            dragged = null;
            return;
        }
        const at = pointFromXY(e.clientX, e.clientY);
        const id = at ? blockIdOf(at.node) : null;
        const field = at ? editableOf(at.node) : null;
        if (!at || !id || field?.dataset["edit"] !== "text") {
            dragged = null;
            return;
        }
        const target = { block: id, offset: caretOffset(field, at), field: "text" };
        const source = dragged?.kind === "text" ? dragged.sel : null;
        dragged = null;
        void (async () => {
            if (source && source.start.block === source.end.block && source.start.field === "text") {
                const ops = dropMoveOps(source.start.block, source.start.offset, source.end.offset, target.block, target.offset, ed.clean(text));
                if (!ops)
                    return;
                await ed.batch(ops, "move text");
                ed.focusBlock(target.block, target.offset);
            }
            else if (source) {
                toast("Drag text within one paragraph, or use cut and paste to move it further.", { kind: "info" });
            }
            else {
                await ed.op({ op: "text", block: target.block, start: target.offset, end: target.offset, insert: ed.clean(text).replace(/\n+/g, " ") });
                ed.focusBlock(target.block, target.offset + text.length);
            }
        })();
    });
    return () => { for (const fn of off)
        fn(); };
}
function caretOffset(field, at) {
    const range = document.createRange();
    range.selectNodeContents(field);
    try {
        range.setEnd(at.node, at.offset);
    }
    catch {
        return 0;
    }
    return serialiseLength(range.cloneContents());
}
function serialiseLength(fragment) {
    let n = 0;
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            n += node.data.length;
            return;
        }
        if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-obj")) {
            n += 1;
            return;
        }
        node.childNodes.forEach(walk);
    };
    walk(fragment);
    return n;
}
/** Operations that move [from,to) of a block to `at` (in the same or another block) without losing text. */
export function dropMoveOps(srcBlock, from, to, dstBlock, at, text) {
    if (srcBlock === dstBlock && at >= from && at <= to)
        return null;
    const ins = { op: "text", block: dstBlock, start: at, end: at, insert: text };
    if (srcBlock !== dstBlock)
        return [ins, { op: "text", block: srcBlock, start: from, end: to, insert: "" }];
    if (at > to)
        return [ins, { op: "text", block: srcBlock, start: from, end: to, insert: "" }];
    return [ins, { op: "text", block: srcBlock, start: from + text.length, end: to + text.length, insert: "" }];
}
