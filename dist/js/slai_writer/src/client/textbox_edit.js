import { announce, toast } from "./kit.js";
import { errorText } from "./net.js";
import { shapeOf } from "./shape.js";
import { paragraphStyler } from "./render.js";
import { TEXTBOX_MIN_MM, continuation, formatRange, fromLines, lineLength, neededHeightMm, paragraphElement, parseTextBox, pointOfPos, posOfPoint, rangeHas, rangeValue, replaceRange, textBoxOf, toLines, withParagraphs, comparePos, } from "./textbox.js";
let active = null;
const watched = new WeakSet();
/** Pagination moves the page's blocks around (after an insert, a resize, a remote change), and moving a node drops its focus: give it back, with the caret where it was. */
function watchPlacement(ed) {
    if (watched.has(ed))
        return;
    watched.add(ed);
    ed.page.onPlaced(() => {
        const session = active;
        if (!session || session.done || session.ed !== ed || !session.body.isConnected)
            return;
        if (document.activeElement === session.body)
            return;
        session.body.focus({ preventScroll: true });
        const lines = parseTextBox(session.body);
        const a = pointOfPos(session.body, clampPos(lines, session.lastSel.start)), b = pointOfPos(session.body, clampPos(lines, session.lastSel.end));
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    });
}
/** The text box being edited right now, if any. */
export const activeTextBoxId = () => (active && !active.done && active.body.isConnected ? active.id : null);
export const isEditingTextBox = (id) => (id ? activeTextBoxId() === id : activeTextBoxId() !== null);
const stopped = ["keydown", "keyup", "keypress", "input", "paste", "cut", "copy", "compositionstart", "compositionend", "dragstart", "drop", "contextmenu"];
function snapshot(session) {
    const lines = parseTextBox(session.body);
    const sel = window.getSelection();
    if (sel && sel.rangeCount && session.body.contains(sel.anchorNode)) {
        const a = posOfPoint(session.body, sel.anchorNode, sel.anchorOffset);
        const b = posOfPoint(session.body, sel.focusNode, sel.focusOffset);
        const [start, end] = comparePos(a, b) <= 0 ? [a, b] : [b, a];
        session.lastSel = { start, end };
    }
    return { lines, ...session.lastSel };
}
const clampPos = (lines, pos) => {
    const p = Math.max(0, Math.min(lines.length - 1, pos.p));
    return { p, o: Math.max(0, Math.min(lineLength(lines[p]), pos.o)) };
};
function paint(session, lines, sel) {
    const shape = shapeOf(session.ed.model.block(session.id));
    if (!shape)
        return;
    const styler = paragraphStyler(session.ed.model.meta);
    const paragraphs = fromLines(lines);
    session.body.replaceChildren(...paragraphs.map((para) => paragraphElement(para, shape, styler)));
    session.body.dataset["empty"] = String(paragraphs.length === 1 && !paragraphs[0]?.text);
    if (sel) {
        const a = pointOfPos(session.body, clampPos(lines, sel.start)), b = pointOfPos(session.body, clampPos(lines, sel.end));
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        session.lastSel = { start: clampPos(lines, sel.start), end: clampPos(lines, sel.end) };
    }
    grow(session);
}
/** Auto-expand: the box gets taller as the text needs it (shown at once; saved when editing ends). */
function grow(session) {
    const shape = shapeOf(session.ed.model.block(session.id));
    if (!shape || !textBoxOf(shape)?.auto_expand)
        return;
    const need = neededHeightMm(session.host);
    if (need !== null && need > shape.height_mm + 0.05)
        session.host.style.height = `${Math.min(1000, Math.ceil(need * 10) / 10)}mm`;
}
export function openTextBoxEditor(ed, id, options = {}) {
    if (ed.readOnly)
        return;
    const shape = shapeOf(ed.model.block(id));
    const box = textBoxOf(shape);
    if (!shape || !box)
        return;
    if (box.locked) {
        toast("This text box is locked. Unlock it to edit its text.", { kind: "info" });
        return;
    }
    if (active && !active.done && active.id === id && active.body.isConnected) {
        active.body.focus();
        return;
    }
    void closeTextBoxEditor(true);
    const host = ed.els.get(id)?.querySelector(".writer-shape");
    const body = host?.querySelector(".tb-body");
    if (!host || !body)
        return;
    body.contentEditable = "true";
    body.dataset["editing"] = "true";
    body.setAttribute("role", "textbox");
    body.setAttribute("aria-multiline", "true");
    body.setAttribute("aria-label", box.name ? `Text in ${box.name}` : "Text in text box");
    body.spellcheck = true;
    host.dataset["editing"] = "true";
    const session = { ed, id, host, body, original: JSON.stringify(box.paragraphs), lastSel: { start: { p: 0, o: 0 }, end: { p: 0, o: 0 } }, done: false, teardown: () => { } };
    const listeners = [];
    const on = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); listeners.push([target, type, fn, capture]); };
    for (const type of stopped)
        on(body, type, (event) => event.stopPropagation());
    const insertText = (text, newAttrs) => {
        const { lines, start, end } = snapshot(session);
        const result = replaceRange(lines, clampPos(lines, start), clampPos(lines, end), text, newAttrs);
        paint(session, result.lines, { start: result.caret, end: result.caret });
    };
    on(body, "keydown", ((event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            void closeTextBoxEditor(true);
            announce("Finished editing text box");
            return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            const toggle = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
            if (toggle) {
                event.preventDefault();
                void applyTextBoxAction(ed, id, { kind: "toggle", key: toggle });
            }
            else if (event.key === "Enter") {
                event.preventDefault();
                void closeTextBoxEditor(true);
            }
        }
    }));
    on(body, "beforeinput", ((event) => {
        event.stopPropagation();
        const type = event.inputType;
        if (type === "insertParagraph" || type === "insertLineBreak") {
            event.preventDefault();
            const { lines, start, end } = snapshot(session);
            const line = lines[start.p];
            // Enter on an empty list item ends the list, as it does in a document.
            if (line && comparePos(start, end) === 0 && lineLength(line) === 0 && line.attrs.list) {
                const next = lines.map((l, i) => (i === start.p ? { ...l, attrs: { ...l.attrs, list: undefined } } : l));
                paint(session, next, { start, end });
            }
            else
                insertText("\n", continuation);
        }
        else if (type === "insertFromPaste" || type === "insertFromDrop" || type === "insertFromPasteAsQuotation") {
            event.preventDefault();
            const text = event.dataTransfer?.getData("text/plain") ?? "";
            if (text)
                insertText(text.replace(/\t/g, "    "));
        }
        else if (type === "formatBold" || type === "formatItalic" || type === "formatUnderline" || type === "formatStrikeThrough") {
            event.preventDefault();
            void applyTextBoxAction(ed, id, { kind: "toggle", key: type === "formatBold" ? "bold" : type === "formatItalic" ? "italic" : type === "formatUnderline" ? "underline" : "strike" });
        }
    }));
    on(body, "input", ((event) => { event.stopPropagation(); body.dataset["empty"] = String(!body.textContent); grow(session); }));
    on(document, "selectionchange", (() => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && body.contains(sel.anchorNode)) {
            snapshot(session);
            ed.events.emit({ type: "selection" });
        }
    }));
    // Clicking anywhere that is not this box, its selection chrome or the ribbon ends editing and keeps the text.
    on(document, "pointerdown", ((event) => {
        const target = event.target;
        if (!target || host.contains(target))
            return;
        if (target.closest(".imgsel, .writer-ribbon, [role='dialog'], [role='menu'], .popover"))
            return;
        void closeTextBoxEditor(true);
    }), true);
    on(window, "blur", (() => { }));
    const off = ed.events.on((event) => {
        if (session.done)
            return;
        if (event.type === "block-selected" && event.id !== id)
            void closeTextBoxEditor(true);
        else if ((event.type === "patch" || event.type === "layout") && !body.isConnected) {
            session.done = true;
            session.teardown();
            if (active === session)
                active = null;
        }
    });
    session.teardown = () => {
        for (const [target, type, fn, capture] of listeners)
            target.removeEventListener(type, fn, capture);
        off();
    };
    active = session;
    watchPlacement(ed);
    body.focus();
    const caretAt = () => {
        const doc = document;
        const sel = window.getSelection();
        let node = null, offset = 0;
        if (options.x !== undefined && options.y !== undefined) {
            const caret = doc.caretPositionFromPoint?.(options.x, options.y);
            if (caret) {
                node = caret.offsetNode;
                offset = caret.offset;
            }
            else {
                const r = doc.caretRangeFromPoint?.(options.x, options.y);
                if (r) {
                    node = r.startContainer;
                    offset = r.startOffset;
                }
            }
        }
        if (!node || !body.contains(node)) {
            const lines = parseTextBox(body);
            const last = lines.length - 1;
            const at = pointOfPos(body, { p: last, o: lineLength(lines[last]) });
            node = at.node;
            offset = at.offset;
        }
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(range);
        snapshot(session);
    };
    caretAt();
}
/** Finish editing. With `commit`, the text goes into the document as one operation. Resolves once the document has it. */
export async function closeTextBoxEditor(commit) {
    const session = active;
    if (!session || session.done)
        return;
    session.done = true;
    active = null;
    const { ed, id, host, body } = session;
    const lines = body.isConnected ? parseTextBox(body) : null;
    session.teardown();
    body.removeAttribute("contenteditable");
    delete body.dataset["editing"];
    delete host.dataset["editing"];
    host.style.removeProperty("height");
    if (!commit || !lines || ed.readOnly) {
        if (lines)
            refreshFromModel(session);
        return;
    }
    const source = shapeOf(ed.model.block(id));
    if (!source || !textBoxOf(source))
        return;
    const paragraphs = fromLines(lines);
    if (JSON.stringify(paragraphs) === session.original) {
        refreshFromModel(session);
        return;
    }
    const next = withParagraphs(source, paragraphs);
    if (textBoxOf(next)?.auto_expand) {
        const need = neededHeightMm(host);
        if (need !== null && need > next.height_mm)
            next.height_mm = Math.min(1000, Math.ceil(need * 10) / 10);
    }
    try {
        await ed.op({ op: "shape_set", block: id, shape: next, label: "edit text box" });
    }
    catch (error) {
        toast(errorText(error), { kind: "error" });
        refreshFromModel(session);
    }
}
/** Put the saved text back (cancelled or unchanged editing). */
function refreshFromModel(session) {
    const shape = shapeOf(session.ed.model.block(session.id));
    const box = textBoxOf(shape);
    if (!shape || !box || !session.body.isConnected)
        return;
    const styler = paragraphStyler(session.ed.model.meta);
    session.body.replaceChildren(...box.paragraphs.map((para) => paragraphElement(para, shape, styler)));
    session.body.dataset["empty"] = String(box.paragraphs.length === 1 && !box.paragraphs[0]?.text);
}
/* --------------------------------------------------------------------------------------------------------- formatting */
const EXEC = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough", superscript: "superscript", subscript: "subscript" };
function transform(lines, start, end, action, whole) {
    if (action.kind === "paragraph") {
        return lines.map((line, index) => {
            if (!whole && (index < start.p || index > end.p))
                return line;
            const attrs = { ...line.attrs };
            for (const [key, value] of Object.entries(action.attrs)) {
                if (value === null || value === undefined)
                    delete attrs[key];
                else
                    attrs[key] = value;
            }
            if (attrs.role === "normal")
                delete attrs.role;
            if (attrs.list === "none")
                delete attrs.list;
            return { attrs, runs: line.runs };
        });
    }
    if (action.kind === "toggle") {
        const on = !rangeHas(lines, start, end, action.key);
        return formatRange(lines, start, end, (fmt) => {
            const next = { ...fmt };
            if (on) {
                next[action.key] = true;
                if (action.key === "superscript")
                    delete next.subscript;
                if (action.key === "subscript")
                    delete next.superscript;
            }
            else
                delete next[action.key];
            return next;
        });
    }
    if (action.kind === "clear-format")
        return formatRange(lines, start, end, () => ({}));
    return formatRange(lines, start, end, (fmt) => {
        const next = { ...fmt };
        for (const [key, value] of Object.entries(action.props)) {
            if (value === undefined || value === null)
                delete next[key];
            else
                next[key] = value;
        }
        return next;
    });
}
/** Apply a formatting command to the text box: to the selected text while editing, to all of its text when only the box is selected. */
export function applyTextBoxAction(ed, id, action) {
    const run = changes.then(() => applyNow(ed, id, action));
    changes = run.catch(() => undefined);
    return run;
}
async function applyNow(ed, id, action) {
    if (ed.readOnly)
        return;
    const session = active && !active.done && active.id === id && active.body.isConnected ? active : null;
    if (session) {
        const { lines, start, end } = snapshot(session);
        const collapsed = comparePos(start, end) === 0;
        if (collapsed && (action.kind === "format" || action.kind === "clear-format")) {
            toast("Select some of the text first, or leave the cursor and use the paragraph controls.", { kind: "info" });
            return;
        }
        if (collapsed && action.kind === "toggle") {
            session.body.focus();
            document.execCommand(EXEC[action.key]);
            return;
        }
        const next = transform(lines, start, end, action, false);
        paint(session, next, { start, end });
        session.body.focus();
        return;
    }
    const source = shapeOf(ed.model.block(id));
    const box = textBoxOf(source);
    if (!source || !box)
        return;
    if (box.locked) {
        toast("This text box is locked.", { kind: "info" });
        return;
    }
    const lines = toLines(box.paragraphs);
    const last = lines.length - 1;
    const start = { p: 0, o: 0 }, end = { p: last, o: lineLength(lines[last]) };
    const next = withParagraphs(source, fromLines(transform(lines, start, end, action, true)));
    try {
        await ed.op({ op: "shape_set", block: id, shape: next, label: "text box formatting" });
    }
    catch (error) {
        toast(errorText(error), { kind: "error" });
    }
}
/** What the ribbon shows: the formatting of the selected text (or of all the text when not editing). */
export function textBoxFormatState(ed, id) {
    const source = shapeOf(ed.model.block(id));
    const box = textBoxOf(source);
    if (!source || !box)
        return null;
    const session = active && !active.done && active.id === id && active.body.isConnected ? active : null;
    const lines = session ? parseTextBox(session.body) : toLines(box.paragraphs);
    let start = { p: 0, o: 0 }, end = { p: lines.length - 1, o: lineLength(lines[lines.length - 1]) };
    if (session) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && session.body.contains(sel.anchorNode))
            snapshot(session);
        start = clampPos(lines, session.lastSel.start);
        end = clampPos(lines, session.lastSel.end);
        if (comparePos(start, end) === 0)
            end = { p: start.p, o: Math.min(lineLength(lines[start.p]), start.o + 1) };
        if (comparePos(start, end) === 0 && start.o > 0)
            start = { p: start.p, o: start.o - 1 };
    }
    const toggles = {};
    for (const key of ["bold", "italic", "underline", "strike", "superscript", "subscript"])
        toggles[key] = rangeHas(lines, start, end, key);
    const fmt = {};
    for (const key of ["color", "font_family", "font_size_pt", "background"])
        fmt[key] = rangeValue(lines, start, end, key);
    return { toggles, fmt, attrs: lines[Math.min(start.p, lines.length - 1)]?.attrs ?? {}, editing: Boolean(session) };
}
/* ------------------------------------------------------------------------------------------------------ box changes */
/** Change a text box through one `shape_set`. Editing is ended first (its text is kept) and resumed afterwards, so the document never
 *  holds a stale copy of the text and the cursor stays where it was. */
let changes = Promise.resolve();
/** Changes run one after another, each starting from the box as the previous one left it, so two quick edits never overwrite each other. */
export function changeTextBox(ed, id, change, label) {
    const run = changes.then(() => changeNow(ed, id, change, label));
    changes = run.catch(() => undefined);
    return run;
}
async function changeNow(ed, id, change, label) {
    if (ed.readOnly)
        return;
    const session = active && !active.done && active.id === id ? active : null;
    const resume = session ? { ...session.lastSel } : null;
    if (session)
        await closeTextBoxEditor(true);
    const source = shapeOf(ed.model.block(id));
    if (!source)
        return;
    const next = structuredClone(source);
    change(next);
    if (next.width_mm < TEXTBOX_MIN_MM.width)
        next.width_mm = TEXTBOX_MIN_MM.width;
    if (next.height_mm < TEXTBOX_MIN_MM.height)
        next.height_mm = TEXTBOX_MIN_MM.height;
    try {
        await ed.op({ op: "shape_set", block: id, shape: next, label });
    }
    catch (error) {
        toast(errorText(error), { kind: "error" });
        return;
    }
    if (resume && !textBoxOf(next)?.locked) {
        openTextBoxEditor(ed, id);
        const again = active;
        if (again && again.id === id) {
            const lines = parseTextBox(again.body);
            const a = pointOfPos(again.body, clampPos(lines, resume.start)), b = pointOfPos(again.body, clampPos(lines, resume.end));
            const range = document.createRange();
            range.setStart(a.node, a.offset);
            range.setEnd(b.node, b.offset);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
    }
}
