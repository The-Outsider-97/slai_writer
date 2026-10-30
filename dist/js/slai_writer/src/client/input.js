/** Keyboard, mouse, clipboard and drag-and-drop for the editor. The browser handles plain typing natively (the edit is sent right
 *  after); anything that changes structure (Enter, joining paragraphs, deleting across blocks, pasting, formatting, drops) is cancelled
 *  here and expressed as operations instead. */
import { announce, toast } from "./kit.js";
import * as A from "./actions.js";
import { blockIdOf, editableOf } from "./domtext.js";
import { highlightsSupported } from "./decor.js";
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
        if (!sel && !ed.selectedBlock && (type === "insertText" || type === "insertParagraph" || type === "insertLineBreak" || type === "insertFromPaste")) {
            // Nothing editable holds the caret. The browser would show the text but nothing would send it, so it is held, the caret is placed, and it is replayed.
            e.preventDefault();
            const data = type === "insertText" && typeof e.data === "string" ? e.data : null;
            if (type === "insertFromPaste") {
                const text = e.dataTransfer?.getData("text/plain") ?? "";
                serial(async () => { if (await A.landCaret(ed))
                    await A.insertText(ed, text); });
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
            case "insertLineBreak":
                e.preventDefault();
                serial(() => A.enter(ed));
                return;
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
                e.preventDefault();
                const files = Array.from(e.dataTransfer?.files ?? []);
                if (files.length) {
                    ed.events.emit({ type: "files", files, after: sel?.end.block ?? null });
                    return;
                }
                const text = e.dataTransfer?.getData("text/plain") ?? "";
                if (text)
                    void A.insertText(ed, text);
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
                    serial(async () => { const at = await A.replaceRange(ed, sel, ed.clean(e.data ?? "")); if (at)
                        ed.focusBlock(at.block, at.offset); });
                }
                return;
            }
            case "deleteByCut":
            case "deleteByDrag":
            case "deleteContent": {
                if (sel && !sel.collapsed) {
                    e.preventDefault();
                    if (type !== "deleteByDrag")
                        serial(async () => { const at = await A.replaceRange(ed, sel, ""); if (at)
                            ed.focusBlock(at.block, at.offset); });
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
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        const run = (fn) => { e.preventDefault(); void fn(); };
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
            if (e.key === "Enter")
                return run(() => { const b = ed.model.block(ed.selectedBlock); if (b && (b.type === "figure" || b.type === "equation" || b.type === "embed" || b.type === "table"))
                    ed.events.emit({ type: "open-object", kind: b.type, block: b.id }); });
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
    /* ------------------------------------------------------------------------------------------ pointer */
    on("click", (e) => {
        const target = e.target;
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
        if (wrap && !inField && (type === "figure" || type === "equation" || type === "embed" || type === "table")) {
            A.selectBlock(ed, wrap.dataset["id"]);
            if (type === "embed")
                ed.events.emit({ type: "open-object", kind: "embed", block: wrap.dataset["id"] });
            return;
        }
        if (ed.selectedBlock)
            A.clearBlockSelection(ed);
    });
    on("dblclick", (e) => {
        const target = e.target;
        const wrap = wrapperAt(ed, target);
        const type = wrap?.dataset["type"];
        if (target.closest(".i-eq")) {
            const id = blockIdOf(target);
            if (id)
                ed.events.emit({ type: "open-object", kind: "equation", block: id });
            return;
        }
        if (wrap && (type === "figure" || type === "equation" || type === "embed") && !target.closest("[data-edit]")) {
            ed.events.emit({ type: "open-object", kind: type, block: wrap.dataset["id"] });
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
    on("contextmenu", (e) => { e.preventDefault(); ed.events.emit({ type: "context", x: e.clientX, y: e.clientY }); });
    /* ------------------------------------------------------------------------------------------ clipboard */
    /** A picture on the clipboard (a screenshot, "Copy image" in a browser, a file copied in the file manager) is brought in as a picture. Text that comes with it
     *  (a spreadsheet cell copies both) wins: then the text is pasted as usual. A picture that only exists as a web address is not fetched. */
    on("paste", (e) => {
        const data = e.clipboardData;
        if (!data || ed.readOnly)
            return;
        const pictures = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
        const hasText = data.getData("text/plain").trim() !== "";
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
        const text = ed.selectionText();
        if (!text)
            return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", text);
    });
    on("cut", (e) => {
        const sel = ed.readSelection();
        const text = ed.selectionText(sel);
        if (!sel || !text || ed.readOnly)
            return;
        e.preventDefault();
        e.clipboardData?.setData("text/plain", text);
        void (async () => { const at = await A.replaceRange(ed, sel, ""); if (at)
            ed.focusBlock(at.block, at.offset); })();
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
