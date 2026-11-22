/** Mapping between the model's text offsets and the DOM. Every editable text element holds text nodes plus inline objects
 *  (`[data-obj]`, not editable), and an object counts as exactly one character, like the U+FFFC it is stored as. */
import { OBJECT_CHAR } from "./types.js";
export function isObject(node) { return node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-obj"); }
/** The block text a DOM subtree stands for. `<br>` placeholders that browsers add to empty lines contribute nothing. */
export function serialise(root) {
    if (root.nodeType === Node.TEXT_NODE)
        return root.data;
    if (isObject(root))
        return OBJECT_CHAR;
    let out = "";
    root.childNodes.forEach((child) => { out += serialise(child); });
    return out;
}
export function lengthOf(root) { return serialise(root).length; }
/** Offset in the block's text of a DOM position inside `root`. */
export function offsetOf(root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    try {
        range.setEnd(node, offset);
    }
    catch {
        return lengthOf(root);
    }
    const fragment = range.cloneContents();
    return serialise(fragment).length;
}
function locate(node, left) {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i += 1) {
        const child = kids[i];
        if (child.nodeType === Node.TEXT_NODE) {
            const len = child.data.length;
            if (left.n <= len)
                return { node: child, offset: left.n };
            left.n -= len;
        }
        else if (isObject(child)) {
            if (left.n === 0)
                return { node, offset: i };
            left.n -= 1;
            if (left.n === 0)
                return { node, offset: i + 1 };
        }
        else if (child.nodeType === Node.ELEMENT_NODE) {
            const hit = locate(child, left);
            if (hit)
                return hit;
        }
    }
    return null;
}
/** A DOM position for a model offset (the end of the text when the offset is past it). */
export function pointFor(root, offset) {
    const hit = locate(root, { n: Math.max(0, offset) });
    return hit ?? { node: root, offset: root.childNodes.length };
}
export function rangeFor(root, start, end) {
    const range = document.createRange();
    const a = pointFor(root, start);
    const b = pointFor(root, end);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
}
/** The editable element (a text block, a table cell or a caption) that contains `node`, if any. */
export function editableOf(node) {
    let n = node;
    while (n) {
        if (n.nodeType === Node.ELEMENT_NODE && n.hasAttribute("data-edit"))
            return n;
        n = n.parentNode;
    }
    return null;
}
export function blockIdOf(node) {
    let n = node;
    while (n) {
        if (n.nodeType === Node.ELEMENT_NODE && n.hasAttribute("data-id"))
            return n.dataset["id"] ?? null;
        n = n.parentNode;
    }
    return null;
}
export function caretAt(node, offset) {
    const el = editableOf(node);
    const id = blockIdOf(node);
    if (!el || !id)
        return null;
    const field = (el.dataset["edit"] ?? "text");
    const point = { block: id, offset: offsetOf(el, node, offset), field };
    if (field === "cell") {
        point.row = Number(el.dataset["row"]);
        point.col = Number(el.dataset["col"]);
    }
    return point;
}
export function placeCaret(root, offset, end) {
    const selection = window.getSelection();
    if (!selection)
        return;
    const range = rangeFor(root, offset, end ?? offset);
    selection.removeAllRanges();
    selection.addRange(range);
}
/** Support for `contenteditable="plaintext-only"`, which keeps browsers from inserting their own formatting elements. */
export function plaintextOnlySupported() {
    const probe = document.createElement("div");
    try {
        probe.contentEditable = "plaintext-only";
    }
    catch {
        return false;
    }
    return probe.contentEditable === "plaintext-only";
}
