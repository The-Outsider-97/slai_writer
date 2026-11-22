/** Find and replace. The server searches (so the count is the document's, not the screen's); matches are drawn green with the CSS Custom
 *  Highlight API, the current one stronger, and replacing sends an operation that names the exact text it expects to replace. */
import { announce, toast } from "./kit.js";
import { api, errorText } from "./net.js";
export class Find {
    ctx;
    query = "";
    caseSensitive = false;
    wholeWord = false;
    matches = [];
    index = -1;
    truncated = false;
    ticket = 0;
    onChange = () => undefined;
    constructor(ctx) {
        this.ctx = ctx;
    }
    bind(onChange) { this.onChange = onChange; }
    get active() { return this.query.length > 0; }
    get label() { return this.query ? (this.matches.length ? `${this.index + 1}/${this.matches.length}${this.truncated ? "+" : ""}` : "0/0") : ""; }
    async search(query, keepPosition = false) {
        const ticket = ++this.ticket;
        this.query = query;
        if (!query) {
            this.matches = [];
            this.index = -1;
            this.paint();
            this.onChange();
            return;
        }
        try {
            await this.ctx.ed.whenIdle();
            const out = await api.get(`/docs/${encodeURIComponent(this.ctx.sid)}/search`, { q: query, case: this.caseSensitive ? "1" : "", whole: this.wholeWord ? "1" : "" });
            if (ticket !== this.ticket)
                return;
            const previous = this.matches[this.index];
            this.matches = out.matches;
            this.truncated = out.truncated;
            this.index = out.matches.length ? 0 : -1;
            if (keepPosition && previous) {
                const same = out.matches.findIndex((m) => m.block === previous.block && m.where === previous.where && m.start >= previous.start);
                if (same >= 0)
                    this.index = same;
            }
            else if (out.matches.length) {
                const here = this.nearest();
                if (here >= 0)
                    this.index = here;
            }
            this.paint();
            this.onChange();
            if (!keepPosition) {
                this.reveal();
                announce(out.count ? `${out.count} match${out.count === 1 ? "" : "es"}.` : "No matches.");
            }
        }
        catch (e) {
            if (ticket === this.ticket)
                toast(errorText(e), { kind: "error" });
        }
    }
    /** The first match at or after the caret, so searching starts where the person is. */
    nearest() {
        const sel = this.ctx.ed.recallSelection();
        if (!sel)
            return 0;
        const at = this.ctx.ed.model.indexOf(sel.start.block);
        const i = this.matches.findIndex((m) => { const b = this.ctx.ed.model.indexOf(m.block); return b > at || (b === at && m.start >= sel.start.offset); });
        return i >= 0 ? i : 0;
    }
    paint() {
        const { decor } = this.ctx.ed;
        const text = this.matches.filter((m) => m.where === "text");
        const current = this.matches[this.index];
        decor.set("search", text.filter((m) => m !== current).map((m) => ({ block: m.block, start: m.start, end: m.end })));
        decor.set("search-current", current && current.where === "text" ? [{ block: current.block, start: current.start, end: current.end }] : []);
    }
    reveal() {
        const m = this.matches[this.index];
        if (!m)
            return;
        if (m.where.startsWith("cell:")) {
            const [, r, c] = m.where.split(":");
            this.ctx.ed.fieldEl(`${m.block}#${r},${c}`)?.scrollIntoView({ block: "center" });
            return;
        }
        this.ctx.ed.scrollToBlock(m.block);
    }
    step(delta) {
        if (!this.matches.length)
            return;
        this.index = (this.index + delta + this.matches.length) % this.matches.length;
        this.paint();
        this.reveal();
        this.onChange();
        const m = this.matches[this.index];
        if (m)
            announce(`Match ${this.index + 1} of ${this.matches.length}: ${m.snippet}`);
    }
    clear() { this.ticket += 1; this.query = ""; this.matches = []; this.index = -1; this.paint(); this.onChange(); }
    /** Replace the current match, then move to the next one. */
    async replaceCurrent(replacement) {
        const m = this.matches[this.index];
        if (!m)
            return;
        if (m.where !== "text") {
            toast("This match is inside a table cell. Edit it in the table.", { kind: "info" });
            this.step(1);
            return;
        }
        const original = this.ctx.ed.model.block(m.block)?.text.slice(m.start, m.end) ?? "";
        try {
            await this.ctx.ed.op({ op: "text", block: m.block, start: m.start, end: m.end, insert: replacement, expect: original, label: "replace" });
        }
        catch (e) {
            toast(`${errorText(e)} The list is being refreshed.`, { kind: "error" });
        }
        await this.search(this.query, true);
    }
    /** Replace every match in running text as ONE edit, so one Undo puts them all back. Matches inside table cells are reported, not replaced. */
    async replaceAll(replacement) {
        const { ed } = this.ctx;
        const text = this.matches.filter((m) => m.where === "text");
        const skipped = this.matches.length - text.length;
        if (!text.length) {
            toast(skipped ? "Every match is inside a table cell; edit those in the table." : "Nothing to replace.", { kind: "info" });
            return;
        }
        const ordered = [...text].sort((a, b) => ed.model.indexOf(b.block) - ed.model.indexOf(a.block) || b.start - a.start);
        const ops = ordered.map((m) => ({ op: "text", block: m.block, start: m.start, end: m.end, insert: replacement, expect: ed.model.block(m.block)?.text.slice(m.start, m.end) ?? "" }));
        try {
            await ed.op({ op: "batch", ops, label: "replace all" });
            toast(`Replaced ${ops.length}. Undo puts them all back.${skipped ? ` ${skipped} inside table cells were left alone.` : ""}`, { kind: "ok" });
        }
        catch (e) {
            toast(errorText(e), { kind: "error" });
        }
        await this.search(this.query, true);
    }
}
