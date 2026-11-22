import { h, toast } from "./kit.js";
import { errorText } from "./net.js";
import { shapeOf } from "./shape.js";
import { diffText } from "./textops.js";
export function rebaseTextSpans(spans, start, end, insertSize) {
    const delta = insertSize - (end - start), next = [];
    for (const entry of spans) {
        if (entry.end <= start)
            next.push({ ...entry });
        else if (entry.start >= end)
            next.push({ ...entry, start: entry.start + delta, end: entry.end + delta });
        else {
            if (entry.start < start)
                next.push({ ...entry, end: start });
            if (entry.end > end)
                next.push({ ...entry, start: start + insertSize, end: entry.end + delta });
        }
    }
    return next.filter(span => span.start < span.end);
}
export function openShapeTextEditor(ed, id) {
    if (ed.readOnly)
        return;
    const shape = shapeOf(ed.model.block(id));
    const host = ed.els.get(id)?.querySelector(".writer-shape");
    if (!shape || !host)
        return;
    const prior = host.querySelector(".shape-direct-textarea");
    if (prior) {
        prior.focus();
        return;
    }
    const textRegion = host.querySelector(".writer-shape-text");
    const text = h("textarea", { class: "shape-direct-textarea", rows: 3, maxLength: 4000,
        attrs: { spellcheck: "true", "aria-label": `Edit text inside ${shape.kind}`, "data-shape-edit": "true", contenteditable: "false" } });
    text.value = shape.text.content;
    const editor = h("div", { class: "shape-direct-editor", attrs: { contenteditable: "false", role: "group", "aria-label": "Shape text editor" } }, text);
    const menu = h("div", { class: "shape-direct-toolbar", attrs: { role: "toolbar", "aria-label": "Selected shape text formatting" } });
    const styles = (shape.text.spans ?? []).map(v => ({ ...v }));
    let spans = styles, lastText = text.value, composing = false, closed = false;
    const stop = (event) => event.stopPropagation();
    for (const key of ["beforeinput", "input", "paste", "copy", "cut", "compositionstart", "compositionend"]) {
        text.addEventListener(key, stop);
    }
    text.addEventListener("compositionstart", () => { composing = true; });
    text.addEventListener("compositionend", () => { composing = false; updateSpans(); });
    const updateSpans = () => {
        const next = text.value;
        if (next === lastText)
            return;
        const diff = diffText(lastText, next, text.selectionStart);
        if (diff)
            spans = rebaseTextSpans(spans, diff.start, diff.end, diff.insert.length);
        lastText = next;
    };
    text.addEventListener("input", () => { if (!composing)
        updateSpans(); });
    const format = (flag) => {
        updateSpans();
        const start = text.selectionStart, end = text.selectionEnd;
        if (end <= start) {
            toast("Select text within the shape to format it.", { kind: "info" });
            return;
        }
        spans.push({ type: "format", start, end, [flag]: true });
        if (spans.length > 300)
            spans = spans.slice(-300);
        text.focus();
        text.setSelectionRange(start, end);
    };
    for (const [name, key] of [["Bold", "bold"], ["Italic", "italic"], ["Underline", "underline"],
        ["Strike", "strike"], ["Superscript", "superscript"], ["Subscript", "subscript"]]) {
        const control = h("button", { type: "button", class: "shape-direct-tool", text: name,
            attrs: { "aria-label": `${name} selected shape text` } });
        control.addEventListener("pointerdown", event => event.preventDefault());
        control.addEventListener("click", () => format(key));
        menu.append(control);
    }
    const paintRange = (key, value) => {
        updateSpans();
        const start = text.selectionStart, end = text.selectionEnd;
        if (end <= start) {
            toast("Select shape text to color first.", { kind: "info" });
            text.focus();
            return;
        }
        spans.push({ type: "format", start, end, [key]: value });
        if (spans.length > 300)
            spans = spans.slice(-300);
        text.focus();
        text.setSelectionRange(start, end);
    };
    const ink = h("input", { type: "color", value: shape.text.color,
        attrs: { "aria-label": "Selected shape text color" } });
    ink.addEventListener("change", () => paintRange("color", ink.value));
    const highlight = h("input", { type: "color", value: "#ffff00",
        attrs: { "aria-label": "Highlight selected shape text" } });
    highlight.addEventListener("change", () => paintRange("background", highlight.value));
    menu.append(ink, highlight);
    const saveBtn = h("button", { type: "button", class: "shape-direct-tool", text: "✓ Done",
        attrs: { "aria-label": "Finish editing shape text" } });
    const cancelBtn = h("button", { type: "button", class: "shape-direct-tool", text: "Cancel",
        attrs: { "aria-label": "Cancel shape text edits" } });
    const detach = () => { document.removeEventListener("pointerdown", outside, true); editor.remove(); };
    const complete = (commit) => {
        if (closed)
            return;
        closed = true;
        updateSpans();
        detach();
        if (!commit || ed.readOnly)
            return;
        const source = shapeOf(ed.model.block(id));
        if (!source)
            return;
        const content = text.value;
        if (content === source.text.content && JSON.stringify(spans) === JSON.stringify(source.text.spans ?? []))
            return;
        const next = structuredClone(source);
        next.text.content = content;
        next.text.spans = spans;
        void ed.op({ op: "shape_set", block: id, shape: next, label: "edit shape text" })
            .catch(error => toast(errorText(error), { kind: "error" }));
    };
    saveBtn.addEventListener("pointerdown", event => event.preventDefault());
    cancelBtn.addEventListener("pointerdown", event => event.preventDefault());
    saveBtn.addEventListener("click", () => complete(true));
    cancelBtn.addEventListener("click", () => complete(false));
    menu.append(saveBtn, cancelBtn);
    editor.append(menu);
    text.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            complete(false);
        }
        else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            complete(true);
        }
        else if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "b" || key === "i" || key === "u") {
                event.preventDefault();
                format(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
            }
        }
    });
    // A pointer outside the actual editor commits rather than waiting for blur
    // (popover actions may preserve focus programmatically).
    const outside = (event) => {
        if (!editor.contains(event.target)) {
            document.removeEventListener("pointerdown", outside, true);
            complete(true);
        }
    };
    document.addEventListener("pointerdown", outside, true);
    const focusOut = () => {
        queueMicrotask(() => {
            if (!closed && !editor.contains(document.activeElement))
                complete(true);
        });
    };
    editor.addEventListener("focusout", focusOut);
    text.addEventListener("blur", focusOut);
    host.append(editor);
    if (textRegion) {
        editor.style.left = textRegion.style.left;
        editor.style.top = textRegion.style.top;
        editor.style.width = textRegion.style.width;
        editor.style.height = textRegion.style.height;
    }
    editor.style.fontSize = `${shape.text.font_size_pt}pt`;
    editor.style.color = shape.text.color;
    text.style.fontSize = "inherit";
    text.style.fontWeight = shape.text.bold ? "700" : "400";
    text.style.fontStyle = shape.text.italic ? "italic" : "normal";
    text.style.textAlign = shape.text.align;
    text.style.padding = `${shape.text.padding_mm}mm`;
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
}
