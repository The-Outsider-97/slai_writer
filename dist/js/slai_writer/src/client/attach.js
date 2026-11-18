/** Everything attached to a page: three coloured tabs per page (pink on the left for corrections, gold on the right for notes, grey below for
 *  EMBED) and the three panels they open. The panels belong to the page, not to the window: they grow out of the page's own edge, stay with
 *  it while the document scrolls and zooms, are never part of the printed page, and open and close independently of each other and of
 *  the two application panels. Design: SLAI Writer (main), pages 11 to 14.
 *
 *  All of it lives in PageView's layer, beside the editable text and never inside it, so no tab or panel can change the document. */
import { chevron } from "./dico.js";
import { h } from "./kit.js";
import { MM_PX } from "./textops.js";
import { pagesInRow } from "./arrangement.js";
import { conflicts, layoutSeams } from "./panel_layout.js";
const TAB_W = 20; // page units (px at 100 %), how far a side tab sticks out of the page
const PANEL_MM = 72; // the notes and corrections panels are at most 100 mm wide (design page 12); this is their working width
const PANEL_MAX_MM = 100;
const EMBED_TAB_H = 20;
const TUCK = 14; // how far a panel reaches in behind its page, so it looks as if it comes out of the page
const MIN_TAB_PX = 14; // on screen, so the tabs stay clickable when the page is zoomed far out
const SLIDE_MS = 380; // the length of the slide; the layout follows it frame by frame
const GRID_GAP = 28; // the gap the page grid leaves between pages side by side (styles.css .sheets)
const COLOUR_NAME = { red: "Corrections", yellow: "Notes", embed: "EMBED" };
export class PageAttachments {
    page;
    currentSheet;
    /** The sheet (0-based) each panel is open on, or null when it is closed. */
    openAt = { red: null, yellow: null, embed: null };
    tabs = new Map();
    panels = new Map();
    specs = new Map();
    marginSheet = null;
    /** Where each panel last was, so that a closing panel slides back into the page it came out of. */
    lastAt = { red: null, yellow: null, embed: null };
    busy = false;
    pending = false;
    following = false;
    seamKey = "";
    /** The page that owns the panel that is opening or closing: it stays where it is on the screen while the pages beside it move apart (``PageView.holding``). */
    pin = null;
    onChange = () => undefined;
    constructor(page, specs, currentSheet) {
        this.page = page;
        this.currentSheet = currentSheet;
        for (const spec of specs) {
            this.specs.set(spec.kind, spec);
            const panel = h("aside", { class: `ppanel ${spec.kind}`, id: `panel-${spec.kind}`, attrs: { "aria-label": spec.label, tabindex: "-1", "aria-hidden": "true" } }, spec.content);
            panel.inert = true;
            panel.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.target.closest("dialog, [role=menu], .slash")) {
                e.preventDefault();
                e.stopPropagation();
                const at = this.openAt[spec.kind];
                this.close(spec.kind);
                if (at !== null)
                    this.tab(spec.kind, at)?.focus();
            } });
            this.panels.set(spec.kind, panel);
            page.layer.appendChild(panel);
            // The EMBED panel pushes the pages after it down by its own height, so a change of its height re-places everything.
            if (spec.kind === "embed")
                new ResizeObserver(() => this.place()).observe(panel);
        }
        page.onPlace = () => this.place();
        // Whatever starts a slide of the pages (a panel, another arrangement) the tabs and panels follow it to its end.
        const slides = (e) => (e.propertyName === "transform" || e.propertyName === "margin-bottom") && e.target instanceof HTMLElement && e.target.classList.contains("sheet");
        page.host.addEventListener("transitionrun", (e) => { if (slides(e))
            this.follow(); });
        page.host.addEventListener("transitionend", (e) => { if (slides(e))
            this.place(); });
    }
    isOpen(kind) { return this.openAt[kind] !== null; }
    sheetOf(kind) { return this.openAt[kind]; }
    panel(kind) { return this.panels.get(kind); }
    /** The pages of every row, in reading order (0-based): the rows of the arrangement, so panels and pages agree with the page view in every arrangement. */
    rows() {
        const arrangement = this.page.arrangement;
        return arrangement.rows.map((_, row) => pagesInRow(arrangement, row));
    }
    open(kind, sheet = this.currentSheet(), focus = false) {
        const index = Math.max(0, Math.min(this.page.sheets.length - 1, sheet));
        const was = this.openAt[kind];
        // Two panels never share the room between two pages: the Notes of a page and the Corrections of the page after it are that room's one panel.
        for (const other of conflicts(this.rows(), this.openAt, kind, index))
            this.close(other);
        this.holdPage(index);
        this.openAt[kind] = index;
        this.place();
        this.follow();
        if (was !== index)
            this.onChange(kind, true, index);
        if (focus)
            this.panels.get(kind)?.focus({ preventScroll: true });
        this.reveal(kind);
    }
    close(kind) {
        const was = this.openAt[kind];
        if (was === null)
            return;
        this.holdPage(was);
        this.openAt[kind] = null;
        this.place();
        this.follow();
        this.onChange(kind, false, was);
    }
    toggle(kind, sheet = this.currentSheet(), focus = false) {
        if (this.openAt[kind] === sheet)
            this.close(kind);
        else
            this.open(kind, sheet, focus);
    }
    tab(kind, sheet) { return this.tabs.get(`${kind}:${sheet}`); }
    /** Bring the panel into view when it opened on a page that is not on screen. Only the page is scrolled up or down, and only when the panel is out of sight: the pages beside
     *  it have already made room (a sideways scroll here would only throw away the place the reader was at). */
    reveal(kind) {
        const panel = this.panels.get(kind);
        if (!panel || this.openAt[kind] === null)
            return;
        const scroller = this.page.scroller;
        const view = scroller.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        if (box.bottom < view.top + 24 || box.top > view.bottom - 24)
            scroller.scrollTop += box.top - view.top - 16;
    }
    /* ------------------------------------------------------------------------------------------------- placement */
    place() {
        if (this.busy) {
            this.pending = true;
            return;
        }
        this.busy = true;
        try {
            let rounds = 0;
            do {
                this.pending = false;
                this.placeOnce();
                rounds += 1;
            } while (this.pending && rounds < 3);
        }
        finally {
            this.busy = false;
        }
    }
    holdPage(sheet) { this.pin = { sheet, until: performance.now() + SLIDE_MS + 120 }; }
    /** While a panel slides, the pages below an EMBED panel move with it, so the placement is redone every frame for the length of the slide. */
    follow() {
        if (this.following)
            return;
        this.following = true;
        const start = performance.now();
        const step = () => {
            this.place();
            if (performance.now() - start < SLIDE_MS + 60)
                requestAnimationFrame(step);
            else {
                this.following = false;
                this.place();
            }
        };
        requestAnimationFrame(step);
    }
    panelWidth() { return Math.min(PANEL_MAX_MM, PANEL_MM) * MM_PX; }
    embedWidth(pageWidth) { return pageWidth * 0.89; }
    placeOnce() {
        const { page } = this;
        const count = page.sheets.length;
        for (const kind of ["red", "yellow", "embed"]) {
            const at = this.openAt[kind];
            if (at !== null && at >= count)
                this.openAt[kind] = count ? count - 1 : null;
        }
        const pw = this.panelWidth();
        const z = page.zoom;
        const tw = Math.max(TAB_W, MIN_TAB_PX / z);
        const th = Math.max(EMBED_TAB_H, MIN_TAB_PX / z);
        /* Room for the tabs and panels: beside the first and last page of a row so nothing is clipped at the edge of the window, and between two pages side by side
           (a margin on the page after the seam: layout, never one thing drawn over another). The page that owns the panel that is opening stays where it is. */
        const mode = page.arrangementMode;
        const seams = layoutSeams(this.rows(), count, this.openAt, { tab: tw, panel: pw, gap: mode.facing ? 0 : GRID_GAP, facing: mode.facing });
        const pinned = this.pin && performance.now() < this.pin.until ? this.pin.sheet : null;
        /* the pages glide to their new places (see ``PageView.holding``): when the margins change for any reason (a panel, another arrangement, another zoom) the tabs follow them */
        const key = seams.margins.map((m) => Math.round(m)).join(",");
        if (key !== this.seamKey) {
            this.seamKey = key;
            if (!this.following)
                this.follow();
        }
        page.holding(pinned, () => {
            page.setRoom(seams.room.left, seams.room.right);
            page.setSeams(seams.margins);
        });
        /* the EMBED panel hangs below its page and pushes the next pages down by its own height */
        const embedAt = this.openAt.embed;
        const embedPanel = this.panels.get("embed");
        let margin = null;
        if (embedPanel && embedAt !== null) {
            const sheet = page.sheets[embedAt];
            const rect = page.sheetRect(embedAt);
            if (sheet && rect) {
                embedPanel.style.setProperty("width", `${Math.round(this.embedWidth(rect.width))}px`);
                embedPanel.style.setProperty("max-height", `${Math.round(Math.max(260, rect.height * 0.6))}px`);
                const need = Math.max(0, embedPanel.offsetHeight - TUCK + th + 10 - 28);
                sheet.el.style.setProperty("margin-bottom", `${need}px`);
                margin = sheet.el;
            }
        }
        else if (embedPanel)
            embedPanel.style.removeProperty("margin-bottom");
        if (this.marginSheet && this.marginSheet !== margin)
            this.marginSheet.style.removeProperty("margin-bottom");
        this.marginSheet = margin;
        /* tabs and panels: one trio per page. A closed panel stays where it will open, tucked in behind the page; opening slides it out. */
        const wanted = new Set();
        for (let i = 0; i < count; i += 1) {
            const r = page.sheetRect(i);
            const sheet = page.sheets[i];
            if (!r || !sheet)
                continue;
            const m = sheet.geometry.margins;
            const tabTop = r.top + r.height * 0.37;
            const tabH = Math.max(90, r.height * 0.26);
            for (const kind of ["red", "yellow", "embed"]) {
                if (!this.specs.has(kind))
                    continue;
                const key = `${kind}:${i}`;
                wanted.add(key);
                const open = this.openAt[kind] === i;
                const tab = this.tabs.get(key) ?? this.makeTab(kind, i);
                tab.toggleAttribute("hidden", seams.hidden.has(key)); // at the spine of a book, where the two pages touch, a closed tab has no room
                tab.classList.toggle("open", open);
                tab.setAttribute("aria-expanded", String(open));
                const label = `${COLOUR_NAME[kind]} panel, page ${i + 1}`;
                tab.setAttribute("aria-label", label);
                tab.title = `${open ? "Hide" : "Show"} the ${COLOUR_NAME[kind].toLowerCase()} panel of page ${i + 1}`;
                const embedH = embedPanel?.offsetHeight ?? 0;
                let left;
                let top;
                let w;
                let hgt;
                if (kind === "red") {
                    w = tw;
                    hgt = tabH;
                    top = tabTop;
                    left = (open ? r.left - pw : r.left) - tw + 1;
                }
                else if (kind === "yellow") {
                    w = tw;
                    hgt = tabH;
                    top = tabTop;
                    left = (open ? r.left + r.width + pw : r.left + r.width) - 1;
                }
                else {
                    w = Math.max(120, r.width * 0.39);
                    hgt = th;
                    left = r.left + (r.width - w) / 2;
                    top = (open ? r.top + r.height - TUCK + embedH : r.top + r.height) - 1;
                }
                tab.style.setProperty("left", `${Math.round(left)}px`);
                tab.style.setProperty("top", `${Math.round(top)}px`);
                tab.style.setProperty("width", `${Math.round(w)}px`);
                tab.style.setProperty("height", `${Math.round(hgt)}px`);
                tab.replaceChildren(chevron(kind === "red" ? (open ? "right" : "left") : kind === "yellow" ? (open ? "left" : "right") : (open ? "up" : "down")));
            }
            /* the panels of this page (a panel is placed on the page it is open on, or on the first page while it is closed) */
            for (const kind of ["red", "yellow", "embed"]) {
                const panel = this.panels.get(kind);
                if (!panel)
                    continue;
                const at = this.openAt[kind];
                if (at !== i && !(at === null && i === (this.lastAt[kind] ?? 0)))
                    continue;
                if (kind === "embed") {
                    const w = this.embedWidth(r.width);
                    panel.style.setProperty("left", `${Math.round(r.left + (r.width - w) / 2)}px`);
                    panel.style.setProperty("top", `${Math.round(r.top + r.height - TUCK)}px`);
                }
                else {
                    panel.style.setProperty("left", `${Math.round(kind === "red" ? r.left - pw : r.left + r.width - TUCK)}px`);
                    panel.style.setProperty("top", `${Math.round(r.top + m.top * MM_PX)}px`);
                    panel.style.setProperty("width", `${Math.round(pw + TUCK)}px`);
                    panel.style.setProperty("height", `${Math.round(Math.max(160, r.height - (m.top + m.bottom) * MM_PX))}px`);
                }
            }
        }
        for (const [key, tab] of this.tabs)
            if (!wanted.has(key)) {
                tab.remove();
                this.tabs.delete(key);
            }
        for (const kind of ["red", "yellow", "embed"]) {
            const panel = this.panels.get(kind);
            if (!panel)
                continue;
            const open = this.openAt[kind] !== null;
            if (open)
                this.lastAt[kind] = this.openAt[kind];
            panel.classList.toggle("open", open);
            panel.setAttribute("aria-hidden", String(!open));
            panel.inert = !open;
        }
    }
    makeTab(kind, sheet) {
        const tab = h("button", { class: `ptab ${kind}`, type: "button", attrs: { "aria-controls": `panel-${kind}`, "aria-expanded": "false" } });
        tab.addEventListener("click", () => { const i = Number(tab.dataset["sheet"]); this.toggle(kind, i, this.openAt[kind] !== i); });
        tab.dataset["sheet"] = String(sheet);
        this.tabs.set(`${kind}:${sheet}`, tab);
        this.page.layer.appendChild(tab);
        return tab;
    }
}
