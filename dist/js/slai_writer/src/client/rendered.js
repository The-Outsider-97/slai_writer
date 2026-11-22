/** The Rendered View: the document as the PDF export draws it, read only.
 *
 *  Nothing here lays a page out. The server renders the pages of the very PDF that Export produces (the canonical layout of Documaster) and this view
 *  shows those pictures, so margins (mirrored, gutter), breaks, columns, tables, text boxes, images, headers and footers, page numbers, footnotes and
 *  the table of contents are the exported ones and not an approximation. There is no caret, no selection, no ruler, no guide and no object outline,
 *  because there is no editable content: a picture of a page cannot be changed. How the pages are arranged (one to four across, or the two-page book
 *  view) and how they are fitted to the window come from `arrangement.ts`, the same code the editing view uses. */
import { api } from "./net.js";
import { arrange, fitFraction, groupTarget, rowOf } from "./arrangement.js";
import { h } from "./kit.js";
const PX_PER_PT = 96 / 72;
const MM_PER_PT = 25.4 / 72;
const GAP = 28;
const SIDE_PAD = 28;
/** The width to ask the server for: the shown width at the screen's density, rounded up to a bucket so zooming does not ask for a new picture at every step. */
export function pictureWidth(shownPx, density) {
    const wanted = Math.max(1, shownPx) * Math.max(1, density);
    return Math.max(200, Math.min(3200, Math.ceil(wanted / 200) * 200));
}
export class RenderedView {
    sid;
    events;
    el;
    scroller;
    sizer;
    grid;
    status;
    info = null;
    figures = [];
    view = { perRow: 1, facing: false };
    percent = 100;
    observer = null;
    resizeObserver = null;
    pictureTimer;
    staleSaid = false;
    slot = null;
    onKeyDown = (e) => this.keys(e);
    onWheel = (e) => this.wheel(e);
    onScroll = () => { this.events.changed(); };
    constructor(sid, events) {
        this.sid = sid;
        this.events = events;
        this.grid = h("div", { class: "rv-grid" });
        this.sizer = h("div", { class: "rv-sizer" }, this.grid);
        this.scroller = h("div", { class: "rv-scroller", attrs: { tabindex: "0", role: "document", "aria-label": "Rendered view of the document, read only" } }, this.sizer);
        this.status = h("div", { class: "rv-status", attrs: { role: "status", "aria-live": "polite" } });
        this.el = h("div", { class: "rendered" }, this.scroller, this.status);
        this.scroller.addEventListener("keydown", this.onKeyDown);
        this.scroller.addEventListener("wheel", this.onWheel, { passive: false });
        this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
        this.scroller.addEventListener("dragstart", (e) => e.preventDefault());
        this.scroller.addEventListener("contextmenu", (e) => e.preventDefault());
    }
    /** Ask the server for the pages of the document as it is now. Throws when the export cannot be drawn (the caller says why and stays in the editing view). */
    async load() {
        const list = await api.get(`/docs/${encodeURIComponent(this.sid)}/pages`);
        this.info = list;
        this.staleSaid = false;
        this.build();
    }
    get total() { return this.info?.total ?? 0; }
    get version() { return this.info?.version ?? 0; }
    get zoom() { return this.percent; }
    get arrangementMode() { return { ...this.view }; }
    get arrangement() { return arrange(this.total, this.view.perRow, this.view.facing); }
    /** The printed label of a page, as the export draws it ("iv", "12"), or null. */
    labelOf(page) { return this.info?.pages[page - 1]?.label ?? null; }
    boxes() {
        return (this.info?.pages ?? []).map((p) => ({ widthMm: p.widthPt * MM_PER_PT, heightMm: p.heightPt * MM_PER_PT }));
    }
    build() {
        this.observer?.disconnect();
        this.resizeObserver?.disconnect();
        this.grid.replaceChildren();
        this.figures = [];
        this.slot = null;
        const pages = this.info?.pages ?? [];
        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries)
                if (entry.isIntersecting)
                    this.load1(entry.target);
        }, { root: this.scroller, rootMargin: "150% 0px 150% 0px" });
        for (const page of pages) {
            const img = h("img", { class: "rv-img", attrs: { alt: `Page ${page.label ?? page.n} of ${pages.length}`, draggable: "false", decoding: "async" } });
            img.addEventListener("error", () => this.failed());
            const figure = h("figure", { class: "rv-page", attrs: { "data-page": String(page.n), "data-side": page.n % 2 === 1 ? "right" : "left" } }, img, h("figcaption", { class: "rv-no", text: page.label ? `${page.label}${String(page.n) !== page.label ? ` (page ${page.n})` : ""}` : String(page.n) }));
            this.figures.push(figure);
            this.grid.appendChild(figure);
            this.observer.observe(figure);
        }
        this.resizeObserver = new ResizeObserver(() => { this.layout(); });
        this.resizeObserver.observe(this.scroller);
        this.layout();
    }
    /** Size and place the pages again (the view was attached, or the window changed). */
    refresh() { this.layout(); }
    /** Size the pages and place them in rows. Only sizes and places change; the pictures are asked for again only when the width bucket changes. */
    layout() {
        const pages = this.info?.pages ?? [];
        if (!pages.length)
            return;
        const z = this.percent / 100;
        const { perRow, facing } = this.view;
        const per = facing ? 2 : perRow;
        this.grid.dataset["perRow"] = String(per);
        this.grid.toggleAttribute("data-facing", facing);
        this.grid.style.setProperty("--rv-per-row", String(per));
        this.grid.style.setProperty("--rv-gap", `${GAP * z}px`);
        pages.forEach((page, at) => {
            const figure = this.figures[at];
            const img = figure?.firstElementChild;
            if (!figure || !img)
                return;
            const w = page.widthPt * PX_PER_PT * z, hgt = page.heightPt * PX_PER_PT * z;
            figure.style.setProperty("width", `${w}px`);
            figure.style.setProperty("height", `${hgt}px`);
            img.dataset["want"] = String(pictureWidth(w, window.devicePixelRatio || 1));
        });
        this.slot?.remove();
        this.slot = null;
        const first = this.figures[0];
        if (facing && first) { // the empty place beside page 1: a place on the desk, never a page
            const slot = h("div", { class: "rv-slot", attrs: { "aria-hidden": "true" } });
            slot.style.setProperty("width", first.style.getPropertyValue("width"));
            slot.style.setProperty("height", first.style.getPropertyValue("height"));
            this.grid.insertBefore(slot, first);
            this.slot = slot;
        }
        const w = this.grid.offsetWidth, hgt = this.grid.offsetHeight;
        const room = this.scroller.clientWidth;
        this.sizer.style.setProperty("width", `${Math.max(room, w + 2 * SIDE_PAD * z)}px`);
        // room after the last row, so that every page (the last too) can be brought to the top of the window: going to a page is then exact
        const rows = this.arrangement.rows.length, lastRow = this.figures.length ? (this.figures.at(-1)?.offsetHeight ?? 0) : 0;
        const after = rows ? Math.max(0, this.scroller.clientHeight - lastRow - 2 * SIDE_PAD * z) : 0;
        this.sizer.style.setProperty("height", `${hgt + 2 * SIDE_PAD * z + after}px`);
        this.sizer.style.setProperty("padding", `${SIDE_PAD * z}px`);
        window.clearTimeout(this.pictureTimer);
        this.pictureTimer = window.setTimeout(() => { for (const f of this.figures)
            this.load1(f); }, 120);
    }
    /** Give a page its picture when it is near the window, and draw it again when the width bucket grew. A picture that is already wide enough stays. */
    load1(figure) {
        const img = figure.firstElementChild;
        if (!img || !this.info)
            return;
        const want = Number(img.dataset["want"] ?? 900), have = Number(img.dataset["have"] ?? 0);
        if (have >= want)
            return;
        if (!have && !this.near(figure))
            return;
        img.dataset["have"] = String(want);
        img.src = `/api/docs/${encodeURIComponent(this.sid)}/pages/${figure.dataset["page"]}.png?w=${want}&v=${this.info.version}`;
    }
    near(figure) {
        const view = this.scroller.getBoundingClientRect();
        const r = figure.getBoundingClientRect();
        return r.bottom > view.top - view.height * 1.5 && r.top < view.bottom + view.height * 1.5;
    }
    failed() {
        if (this.staleSaid)
            return;
        this.staleSaid = true;
        this.events.stale();
    }
    /* ------------------------------------------------------------------------------------------------ arrangement and zoom */
    setArrangement(perRow, facing) {
        if (this.view.perRow === perRow && this.view.facing === facing)
            return;
        const keep = this.anchor();
        this.view = { perRow, facing };
        this.layout();
        this.restore(keep);
        this.events.changed();
    }
    setZoom(percent) {
        const next = Math.max(10, Math.min(400, Math.round(percent)));
        if (next === this.percent)
            return;
        const keep = this.anchor();
        this.percent = next;
        this.layout();
        this.restore(keep);
        this.events.changed();
    }
    /** The zoom at which the arrangement fits the window across, down or both. */
    fitZoom(mode) {
        if (!this.info?.pages.length)
            return 100;
        const view = { width: Math.max(50, this.scroller.clientWidth - 2 * SIDE_PAD - 14), height: Math.max(50, this.scroller.clientHeight - 2 * SIDE_PAD) };
        return Math.round(fitFraction(mode, this.arrangement, this.boxes(), view, PX_PER_PT * (72 / 25.4), GAP) * 100);
    }
    /** The row at the top of the window and how far into it the window is, so a change of zoom or arrangement keeps the reader in the same place. */
    anchor() {
        const view = this.scroller.getBoundingClientRect();
        const at = Math.max(0, this.figures.findIndex((f) => f.getBoundingClientRect().bottom > view.top + 1));
        const figure = this.figures[at];
        if (!figure)
            return { page: 1, fraction: 0 };
        const r = figure.getBoundingClientRect();
        return { page: at + 1, fraction: Math.max(0, Math.min(1, (view.top - r.top) / Math.max(1, r.height))) };
    }
    restore(at) {
        const figure = this.figures[at.page - 1];
        if (!figure)
            return;
        const view = this.scroller.getBoundingClientRect();
        const r = figure.getBoundingClientRect();
        this.scroller.scrollTop += r.top + at.fraction * r.height - view.top;
    }
    /* ------------------------------------------------------------------------------------------------ position */
    /** The page that holds the middle of the window (1-based). */
    currentPage() {
        const view = this.scroller.getBoundingClientRect();
        const mid = view.top + view.height / 3;
        const hit = this.figures.findIndex((f) => { const r = f.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
        if (hit >= 0)
            return hit + 1;
        const after = this.figures.findIndex((f) => f.getBoundingClientRect().top > mid);
        return after < 0 ? Math.max(1, this.figures.length) : Math.max(1, after);
    }
    /** How far into the current page the top of the window is (0..1), to come back to the same place. */
    fractionInPage() { return this.anchor().fraction; }
    goTo(page, fraction = 0) {
        const figure = this.figures[Math.max(1, Math.min(this.figures.length, page)) - 1];
        if (!figure)
            return;
        const view = this.scroller.getBoundingClientRect();
        const r = figure.getBoundingClientRect();
        this.scroller.scrollTop += r.top + fraction * r.height - view.top - SIDE_PAD * (this.percent / 100) / 2;
        this.events.changed();
    }
    /** Previous or next group of pages (a row of the arrangement); `by` is -1 or 1. */
    group(by) {
        const target = groupTarget(this.arrangement, this.currentPage() - 1, by);
        this.goTo(target + 1);
    }
    /** The pages shown on the row of the current page, for the status line ("pages 4–5 of 12"). */
    rowPages() {
        const a = this.arrangement;
        const row = a.rows[rowOf(a, this.currentPage() - 1)] ?? [];
        return row.flatMap((slot) => (slot.page === null ? [] : [slot.page + 1]));
    }
    focus() { this.scroller.focus({ preventScroll: true }); }
    say(text) { this.status.textContent = text; }
    /* ------------------------------------------------------------------------------------------------ keys and wheel */
    keys(e) {
        const mod = e.ctrlKey || e.metaKey;
        const line = 56, screen = Math.max(80, this.scroller.clientHeight * 0.9);
        switch (e.key) {
            case "Escape":
                e.preventDefault();
                this.events.leave();
                return;
            case "PageDown":
                e.preventDefault();
                this.group(1);
                return;
            case "PageUp":
                e.preventDefault();
                this.group(-1);
                return;
            case " ":
                e.preventDefault();
                this.scroller.scrollBy({ top: e.shiftKey ? -screen : screen });
                return;
            case "ArrowDown":
                e.preventDefault();
                this.scroller.scrollBy({ top: line });
                return;
            case "ArrowUp":
                e.preventDefault();
                this.scroller.scrollBy({ top: -line });
                return;
            case "ArrowRight":
                e.preventDefault();
                this.scroller.scrollBy({ left: line });
                return;
            case "ArrowLeft":
                e.preventDefault();
                this.scroller.scrollBy({ left: -line });
                return;
            case "Home":
                e.preventDefault();
                this.goTo(1);
                return;
            case "End":
                e.preventDefault();
                this.goTo(this.total);
                return;
            default: break;
        }
        // everything else that would edit (typing, Delete, Enter, paste) does nothing here: there is nothing to edit. Zoom keys belong to the screen.
        if (!mod && e.key.length === 1)
            e.preventDefault();
    }
    wheel(e) {
        if (!(e.ctrlKey || e.metaKey))
            return;
        e.preventDefault();
        this.events.zoom(this.percent + (e.deltaY < 0 ? 10 : -10));
    }
    destroy() {
        window.clearTimeout(this.pictureTimer);
        this.observer?.disconnect();
        this.resizeObserver?.disconnect();
        this.scroller.removeEventListener("keydown", this.onKeyDown);
        this.scroller.removeEventListener("wheel", this.onWheel);
        this.scroller.removeEventListener("scroll", this.onScroll);
        this.el.remove();
    }
}
