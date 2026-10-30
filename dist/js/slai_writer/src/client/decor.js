/** Highlights drawn over the text without touching the DOM (CSS Custom Highlight API): search results (green), typos (transparent red),
 *  grammar (transparent orange), the person's own notes (pastel blue) and comment anchors. Ranges are kept in model offsets and
 *  re-resolved after every re-render, so they follow edits. Browsers without the API simply show no highlight; the lists still work. */
import { rangeFor } from "./domtext.js";
function registry() { return globalThis.CSS?.highlights ?? null; }
function ctor() { return globalThis.Highlight ?? null; }
export function highlightsSupported() { return registry() !== null && ctor() !== null; }
export class Decor {
    textOf;
    marks = new Map();
    constructor(textOf) {
        this.textOf = textOf;
    }
    set(kind, marks) { this.marks.set(kind, marks); this.paint(kind); }
    get(kind) { return this.marks.get(kind) ?? []; }
    clear(kind) {
        if (kind) {
            this.marks.delete(kind);
            registry()?.delete(`w-${kind}`);
            return;
        }
        for (const k of [...this.marks.keys()])
            this.clear(k);
    }
    /** Re-resolve every range against the current DOM (after a render or a pagination pass). */
    refresh() { for (const kind of this.marks.keys())
        this.paint(kind); }
    /** The mark touching a text position (for hovering a typo or a note). */
    at(kind, block, offset) {
        return this.get(kind).find((m) => m.block === block && offset >= m.start && offset <= m.end);
    }
    paint(kind) {
        const reg = registry();
        const Highlight = ctor();
        if (!reg || !Highlight)
            return;
        const ranges = [];
        for (const m of this.marks.get(kind) ?? []) {
            const el = this.textOf(m.block);
            if (!el)
                continue;
            try {
                ranges.push(rangeFor(el, m.start, m.end));
            }
            catch { /* the text moved on; the next refresh drops it */ }
        }
        if (ranges.length)
            reg.set(`w-${kind}`, new Highlight(...ranges));
        else
            reg.delete(`w-${kind}`);
    }
}
