/** Pure text arithmetic shared by the editor and its tests: diffs, inline segments, caret offsets and small text helpers.
 *  Offsets are UTF-16 code units, exactly like the server's block text. An inline object (equation or picture) is one U+FFFC character. */
import { OBJECT_CHAR } from "./types.js";
/** The smallest single replacement that turns `before` into `after`; null when they are equal. `caretAfter` resolves repeated characters
 *  (typing the second "l" of "hello") the way the person would expect: an insertion ends at the caret. */
export function diffText(before, after, caretAfter) {
    if (before === after)
        return null;
    let prefix = 0;
    const max = Math.min(before.length, after.length);
    while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix))
        prefix += 1;
    let suffix = 0;
    while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix))
        suffix += 1;
    if (caretAfter !== undefined && caretAfter > after.length - suffix) {
        // The caret is past the changed region, so the common suffix was overstated; shorten it.
        suffix -= Math.min(suffix, caretAfter - (after.length - suffix));
    }
    if (caretAfter !== undefined && before.length - suffix === prefix) {
        // A pure insertion of repeated characters ("hel|lo" gaining an "l") can be placed in several equal ways; choose the one that ends at the caret.
        const inserted = after.length - suffix - prefix;
        const target = caretAfter - inserted;
        let start = prefix;
        while (start > target && start > 0 && after.charCodeAt(start - 1) === after.charCodeAt(start - 1 + inserted))
            start -= 1;
        suffix = before.length - start;
        prefix = start;
    }
    // Never split a surrogate pair.
    const hi = (s, i) => i > 0 && i < s.length && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff;
    while (prefix > 0 && hi(before, prefix))
        prefix -= 1;
    return { start: prefix, end: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}
const FLAGS = ["bold", "italic", "underline", "strike", "code", "superscript", "subscript"];
/** Split a block's text into pieces that each have one uniform set of spans. Objects (U+FFFC) are always their own piece. */
export function segments(block) {
    const text = block.text;
    const spans = block.spans ?? [];
    if (!text)
        return [];
    const cuts = new Set([0, text.length]);
    for (const s of spans) {
        if (s.start >= 0 && s.end <= text.length) {
            cuts.add(s.start);
            cuts.add(s.end);
        }
    }
    for (let i = 0; i < text.length; i += 1)
        if (text[i] === OBJECT_CHAR) {
            cuts.add(i);
            cuts.add(i + 1);
        }
    const points = [...cuts].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
        const start = points[i];
        const end = points[i + 1];
        if (end <= start)
            continue;
        const seg = { start, end, text: text.slice(start, end), flags: {} };
        for (const s of spans) {
            if (s.start > start || s.end < end)
                continue;
            if (s.type === "format") {
                for (const f of FLAGS)
                    if (s[f])
                        seg.flags[f] = true;
                if (s.color)
                    seg.color = s.color;
                if (s.background)
                    seg.background = s.background;
                if (s.font_family)
                    seg.font_family = s.font_family;
                if (s.font_size_pt)
                    seg.font_size_pt = s.font_size_pt;
            }
            else if (s.type === "link" && s.href)
                seg.href = s.href;
            else if (s.type === "style" && s.style)
                seg.style = s.style;
            else if (s.type === "ref" && s.ref)
                seg.ref = s.ref;
            else if (s.type === "xref" && s.target)
                seg.target = s.target;
            else if ((s.type === "equation" || s.type === "image") && s.start === start && s.end === end)
                seg.object = s;
        }
        out.push(seg);
    }
    return out;
}
/** Text with each inline object stood in by U+FFFC (what the DOM serialiser also produces). */
export function textOf(block) { return block.text; }
/** Paragraphs of pasted text: normalise newlines, keep empty lines. */
export function splitLines(text) { return text.replace(/\r\n?/g, "\n").split("\n"); }
/** Remove characters a block cannot hold (control characters other than tab) from typed or pasted text. */
export function cleanInsert(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￼]/g, "");
}
/** Start and end of the word touching `offset` (letters, digits, apostrophes and hyphens inside a word). */
export function wordAt(text, offset) {
    const isWord = (c) => c !== undefined && /[\p{L}\p{N}_'’-]/u.test(c);
    let start = offset;
    let end = offset;
    while (start > 0 && isWord(text[start - 1]))
        start -= 1;
    while (end < text.length && isWord(text[end]))
        end += 1;
    if (end === start)
        return null;
    return { start, end };
}
/** Whole-word count the way the status bar shows it (matches the server's counting closely enough to display between saves). */
export function countWords(text) { return (text.replace(new RegExp(OBJECT_CHAR, "g"), " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length; }
/** Where a caret at `offset` ends up after the text edit `edit` was applied (for restoring the caret after a re-render). */
export function mapOffset(offset, edit) {
    if (offset <= edit.start)
        return offset;
    if (offset >= edit.end)
        return offset - (edit.end - edit.start) + edit.insert.length;
    return edit.start + edit.insert.length;
}
/** Page sizes in millimetres (portrait) for the sizes the server accepts. */
export const PAGE_MM = {
    A4: [210, 297], A5: [148, 210], A3: [297, 420], B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Tabloid: [279.4, 431.8],
};
export function clampNumber(value, low, high) { return Math.min(high, Math.max(low, value)); }
export const MM_PX = 96 / 25.4;
/** Roman numerals and letters for page-number styles. */
export function roman(n) {
    const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let rest = Math.max(1, Math.floor(n));
    let out = "";
    for (const [value, glyph] of table)
        while (rest >= value) {
            out += glyph;
            rest -= value;
        }
    return out;
}
