/** The page view: sheets laid out at physical size, rulers, margin lines, guides, headers and footers, zoom and pagination.
 *
 *  Pagination is deliberately block-granular: a block moves to the next sheet when it does not fit, and a paragraph is never split in
 *  the middle. The exact page count of a printed or exported document comes from the PDF preview (Documaster's own layout), so the
 *  page count shown here is an approximation, and the status bar says so. */
import { h, s, glyph, openMenu, promptDialog } from "./kit.js";
import { MM_PX, roman } from "./textops.js";
import { geometryFor } from "./model.js";
import { lineNames, runningBand } from "./book_layout.js";
import { arrange, fitFraction, pagesInRow } from "./arrangement.js";
import { regionCss } from "./column_layout.js";
import { placeBand } from "./bands.js";
const NUMBER_FORMATS = {
    decimal: (n) => String(n), "lower-roman": (n) => roman(n), "upper-roman": (n) => roman(n).toUpperCase(),
    "lower-alpha": (n) => alpha(n), "upper-alpha": (n) => alpha(n).toUpperCase(),
};
function alpha(n) { let out = ""; let v = Math.max(1, n); while (v > 0) {
    v -= 1;
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26);
} return out; }
export function formatPageNumber(n, format) { return (NUMBER_FORMATS[format ?? "decimal"] ?? NUMBER_FORMATS["decimal"])(n); }
/** Printed numbers are distinct from physical pages and derived from section semantics. */
export function printedPageNumbers(sheets) {
    let current = 0;
    let previousSection;
    return sheets.map((sheet) => {
        const config = sheet.numbering ?? {};
        if (sheet.role === "cover" || config.show === false) {
            previousSection = sheet.section;
            return null;
        }
        if (sheet.section !== previousSection && config.start !== undefined)
            current = config.start - 1;
        previousSection = sheet.section;
        current += 1;
        return formatPageNumber(current, config.format);
    });
}
export function fillTemplate(text, values) {
    return text.replace(/\{\{|\}\}|\{page\}|\{pages\}|\{title\}/g, (m) => m === "{{" ? "{" : m === "}}" ? "}" : m === "{page}" ? values.page : m === "{pages}" ? values.pages : values.title);
}
function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const RULER = 18;
/** A margin may never squeeze the writing area below this (the .sldc format needs at least 20 mm; this leaves room to type). */
const MIN_BODY = 30;
const LINE_CLASS = { left: "outer", right: "outer", top: "outer", bottom: "outer", header: "hf", footer: "hf" };
const clampMm = (mm, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), mm));
export class PageView {
    events;
    el;
    scroller;
    /** The single editable root: every sheet, and every block in it, lives inside this element. */
    host;
    zoomer;
    sizer;
    hruler;
    /** Behind the pages and scaled with them: the layer for everything attached to a page (its tabs and panels grow out from behind the page). Coordinates are in unscaled page units. */
    layer;
    /** In front of the pages and scaled with them (page units): the handles and toolbar of the picture being edited. */
    overlay;
    placeListeners = [];
    /** The two corner cells at the ends of the ruler row: the application panels' arrows live there. */
    cornerLeft;
    cornerRight;
    /** Called after sheets were laid out, reflowed, decorated or zoomed: the attachments reposition themselves. */
    onPlace = null;
    /** The vertical ruler strip, as in Word and Canva: a bar along the left edge of the page area (right next to the left application panel, so it moves with that panel) that always stays visible; the scale of each page slides along it as the pages scroll and rescales with the zoom. */
    vlayer;
    vrulers = [];
    placed() { this.placeVRulers(); this.onPlace?.(); for (const fn of this.placeListeners)
        fn(); }
    /** Called whenever the sheets are laid out, redrawn or zoomed (the picture tools follow the picture). */
    onPlaced(fn) { this.placeListeners.push(fn); }
    room = { left: 0, right: 0 };
    /** Pixels the pages are shifted from the centre to keep the page that owns a panel where it is (see ``holding``). */
    held = 0;
    /** The left margin of each sheet that makes room for the tabs and panels between pages side by side (see ``panel_layout.ts``). Kept here because a new layout makes new sheets. */
    seams = [];
    /** The number that shows beside a ruler while a margin, header, footer or guide line is hovered, focused or dragged. */
    readout;
    locked;
    unit = "mm";
    dragging = false;
    /** Set while a line is moved with the keyboard, so the redraw that follows each step gives the focus back to it. */
    pendingFocus = null;
    rulerSvg = null;
    sheets = [];
    zoom = 1;
    /** How the sheets sit on the desk (one, two, three or four side by side, or the two-page book view). Arrangement only: the document and the layout are untouched. */
    view = { perRow: 1, facing: false };
    slot = null;
    last = null;
    /** The column settings of the sections that have columns, by section id. */
    colSpecs = new Map();
    headerFooter = () => ({});
    constructor(events, editable) {
        this.events = events;
        this.host = h("div", { class: "sheets", attrs: { contenteditable: editable, role: "textbox", "aria-multiline": "true", "aria-label": "Document", spellcheck: "false", id: "main" } });
        this.layer = h("div", { class: "page-layer" });
        this.overlay = h("div", { class: "page-overlay" });
        this.zoomer = h("div", { class: "zoomer" }, this.layer, this.host, this.overlay);
        this.vlayer = h("div", { class: "vlayer", attrs: { "aria-hidden": "false" } });
        this.sizer = h("div", { class: "sizer" }, this.zoomer);
        this.scroller = h("div", { class: "scroller" }, this.sizer);
        this.hruler = h("div", { class: "hruler", attrs: { "aria-hidden": "true" } });
        this.cornerLeft = h("div", { class: "corner left" });
        this.cornerRight = h("div", { class: "corner right" });
        this.readout = h("div", { class: "ruler-readout", attrs: { "aria-hidden": "true" } });
        this.readout.hidden = true;
        this.locked = editable === "false";
        this.el = h("div", { class: "page-area" }, this.cornerLeft, this.hruler, this.cornerRight, this.scroller, this.vlayer, this.readout);
        this.scroller.addEventListener("scroll", () => this.placeVRulers(), { passive: true });
        this.scroller.addEventListener("scroll", () => this.placeRuler());
        let seenWidth = this.scroller.clientWidth;
        new ResizeObserver(() => {
            if (this.scroller.clientWidth !== seenWidth) {
                seenWidth = this.scroller.clientWidth;
                this.held = 0;
            } // a new window width starts again from the centre; a scrollbar appearing below does not
            this.fit();
            this.placeRuler();
            this.placed();
        }).observe(this.scroller);
        this.hruler.addEventListener("dblclick", () => events.rulerDouble());
        this.host.addEventListener("dblclick", (e) => this.onDouble(e));
    }
    setHeaderFooter(fn) { this.headerFooter = fn; }
    /** The shapes of headers and footers (they repeat on every page that uses the header or footer they belong to). */
    bandSource = null;
    setBandShapes(source) { this.bandSource = source; }
    /** Called after the headers, footers and their shapes of every sheet were drawn again, so whatever edits them can put its own marks back. */
    onDecorated = null;
    /** The two layers of header and footer shapes of a sheet: behind the text of the page and in front of it. Clipped to the sheet, never taking a click. */
    bandLayers(sheet, firstOfSection) {
        const source = this.bandSource;
        if (!source)
            return [null, null];
        const g = sheet.geometry;
        const layers = { behind: null, front: null };
        for (const edge of ["header", "footer"]) {
            const { items, variant, mirrored } = source.shapes(sheet.section, edge, sheet.number, firstOfSection);
            for (const item of items) {
                const layer = item.layer === "behind" ? "behind" : "front";
                const host = layers[layer] ?? (layers[layer] = h("div", { class: `band-layer ${layer}`, attrs: { "aria-hidden": "true", "data-band-layer": layer } }));
                const at = placeBand(item, edge, g.widthMm, g.heightMm, g.margins.left, g.margins.right, mirrored);
                const node = h("div", { class: "band-shape", attrs: { "data-band-id": item.id, "data-band-edge": edge, "data-band-variant": variant, "data-band-mirrored": mirrored ? "true" : "false" } });
                node.style.setProperty("left", `${at.x}mm`);
                node.style.setProperty("top", `${at.y}mm`);
                node.style.setProperty("width", `${at.w}mm`);
                node.style.setProperty("height", `${at.h}mm`);
                node.appendChild(source.paint(item, at.w));
                host.appendChild(node);
            }
        }
        return [layers.behind, layers.front];
    }
    /* ------------------------------------------------------------------------------------------------- layout */
    layout(input) {
        const keep = this.lineFocus();
        this.last = input;
        this.unit = input.unit ?? "mm";
        this.mergeFragments(); // the rows of a table cut across pages go back into their table before the blocks are laid out again
        this.colSpecs = new Map(input.blocks.flatMap((b) => (b.cols ? [[b.cols.key, b.cols]] : [])));
        this.host.replaceChildren();
        this.sheets = [];
        let current = null;
        let section;
        const open = (sec) => {
            const sheet = this.newSheet(input, sec, this.sheets.length + 1);
            this.sheets.push(sheet);
            this.host.appendChild(sheet.el);
            section = sec;
            return sheet;
        };
        for (const first of input.blocks) {
            if (!current || first.section !== section || (first.pageBreak && current.blocks.length > 0))
                current = open(first.section);
            let block = first;
            this.place(current, block);
            for (let guard = 0; this.overflows(current) && guard < 2000; guard += 1) {
                const solo = current.blocks.length === 1;
                const rest = this.tableOf(block.el) ? this.splitTable(current, block.el, solo) : null;
                if (rest) { // a table that does not fit is cut between two rows; the rest continues on the next sheet
                    current = open(first.section);
                    block = { id: block.id, el: rest, section: first.section, cols: first.cols ?? null, footnotes: [] };
                    this.place(current, block);
                }
                else if (solo)
                    break;
                else {
                    this.unplace(current, block);
                    current = open(first.section);
                    this.place(current, block);
                }
            }
        }
        if (!this.sheets.length)
            open(undefined);
        this.applyArrangement();
        this.applySeams();
        this.decorate(input);
        this.fit();
        this.placed();
        this.restoreLineFocus(keep);
    }
    newSheet(input, section, number) {
        const base = input.geometry(section);
        const geometry = geometryFor(base, number);
        const wPx = geometry.widthMm * MM_PX;
        const hPx = geometry.heightMm * MM_PX;
        const m = geometry.margins;
        const capacity = (geometry.heightMm - m.top - m.bottom) * MM_PX;
        const body = h("div", { class: "body" });
        body.style.setProperty("height", `${capacity}px`);
        body.style.setProperty("margin", `${m.top * MM_PX}px ${m.right * MM_PX}px ${m.bottom * MM_PX}px ${m.left * MM_PX}px`);
        const foot = h("div", { class: "foot", attrs: { contenteditable: "false", role: "doc-endnotes", "aria-label": "Footnotes" } });
        body.appendChild(foot);
        const el = h("section", { class: "sheet", data: { page: String(number), section: section ?? "", side: number % 2 === 1 ? "right" : "left" }, attrs: { "aria-label": `Page ${number}` } });
        el.style.setProperty("width", `${wPx}px`);
        el.style.setProperty("height", `${hPx}px`);
        if (input.background) {
            el.style.setProperty("background-color", input.background);
            el.style.setProperty("--page-ink", luminance(input.background) < 0.35 ? "#f4f4f4" : "#1b1b1b");
        }
        el.appendChild(body);
        return { el, body, foot, geometry, base, capacity, blocks: [], section, number };
    }
    place(sheet, block) {
        if (block.cols)
            block.el.dataset["colkey"] = block.cols.key;
        else
            delete block.el.dataset["colkey"];
        this.attach(sheet, block.el, false);
        sheet.blocks.push(block.el);
        for (const note of block.footnotes) {
            const row = h("p", { class: "fn-row", data: { n: String(note.n), owner: block.id } }, h("sup", { text: String(note.n) }), " ", note.text);
            sheet.foot.appendChild(row);
        }
        sheet.foot.toggleAttribute("data-has", sheet.foot.childElementCount > 0);
        this.fitRegions(sheet);
    }
    unplace(sheet, block) {
        block.el.remove();
        this.tidy(sheet);
        sheet.blocks.pop();
        for (let i = 0; i < block.footnotes.length; i += 1)
            sheet.foot.lastElementChild?.remove();
        sheet.foot.toggleAttribute("data-has", sheet.foot.childElementCount > 0);
        this.fitRegions(sheet);
    }
    /* ------------------------------------------------------------------------------------------------- columns */
    /** Put a block into the page body: straight into it, or into the column region of its section (a region is made when the block is the first of its section on this sheet). */
    attach(sheet, el, atStart) {
        const key = el.dataset["colkey"];
        const spec = key ? this.colSpecs.get(key) : undefined;
        const first = sheet.body.querySelector(":scope > .blk, :scope > .cols, :scope > .foot");
        if (!key || !spec) {
            sheet.body.insertBefore(el, atStart ? first : sheet.foot);
            return;
        }
        const edge = atStart ? first : sheet.foot.previousElementSibling;
        let region = edge instanceof HTMLElement && edge.classList.contains("cols") && edge.dataset["key"] === key ? edge : null;
        if (!region) {
            region = h("div", { class: "cols", data: { key, flow: spec.rtl ? "rtl" : "ltr" } });
            for (const [name, value] of Object.entries(regionCss(spec, MM_PX)))
                region.style.setProperty(name, value);
            sheet.body.insertBefore(region, atStart ? first : sheet.foot);
        }
        if (atStart)
            region.insertBefore(el, region.firstChild);
        else
            region.appendChild(el);
    }
    /** Take away column regions that have no block left. */
    tidy(sheet) { for (const region of Array.from(sheet.body.querySelectorAll(":scope > .cols")))
        if (!region.childElementCount)
            region.remove(); }
    /** A region that is the last thing on its sheet is as tall as the space left (the text fills the first column to the bottom of the page, then the next);
     *  a region with something after it on the sheet, or one set to balance, is as tall as its balanced columns need. */
    fitRegions(sheet) {
        const regions = Array.from(sheet.body.querySelectorAll(":scope > .cols"));
        if (!regions.length)
            return; // no column region on this sheet: nothing to measure (measuring would force a layout for every block placed)
        const base = sheet.body.getBoundingClientRect().top;
        for (const region of regions) {
            const spec = this.colSpecs.get(region.dataset["key"] ?? "");
            if (!spec)
                continue;
            const balanced = spec.balance || region.nextElementSibling !== sheet.foot;
            region.style.setProperty("column-fill", balanced ? "balance" : "auto");
            region.dataset["fill"] = balanced ? "balance" : "auto";
            if (balanced) {
                region.style.removeProperty("height");
                continue;
            }
            const top = (region.getBoundingClientRect().top - base) / this.zoom;
            const notes = sheet.foot.childElementCount ? sheet.foot.offsetHeight : 0;
            region.style.setProperty("height", `${Math.max(24, sheet.capacity - top - notes)}px`);
        }
    }
    /** Text that runs out of the last column of a region has nowhere to go but the next page. */
    regionsOverflow(sheet) {
        return Array.from(sheet.body.querySelectorAll(":scope > .cols[data-fill=auto]")).some((r) => r.scrollWidth > r.clientWidth + 1);
    }
    /* ------------------------------------------------------------------------------------------------- tables across pages */
    /** The table of a table block (the whole table, or the part of it that lives on this sheet). */
    tableOf(el) {
        return el.classList.contains("b-table") && !el.closest(".cols") ? el.querySelector(":scope > table.tbl") : null;
    }
    /** Where a table may be cut: `cuts[k]` is true when the first k rows can stay on this page, i.e. no merged cell reaches over the cut. */
    cuts(rows) {
        const out = [false];
        let carry = [];
        for (const tr of rows) {
            const occupied = carry.map((v) => v > 0);
            let column = 0;
            const next = carry.map((v) => Math.max(v - 1, 0));
            for (const cell of Array.from(tr.cells)) {
                while (occupied[column])
                    column += 1;
                for (let k = 0; k < cell.colSpan; k += 1)
                    next[column + k] = cell.rowSpan - 1;
                column += cell.colSpan;
            }
            carry = next;
            out.push(carry.every((v) => v === 0));
        }
        return out;
    }
    /** Cut `el` (a table block placed on `sheet`) so that the part left on the sheet fits. The rows that do not fit move into a new block that is returned (the caller
     *  places it on the next sheet); it repeats the header rows. With `force` (the table is alone on a fresh sheet) at least one body row stays, so the layout always advances. */
    splitTable(sheet, el, force) {
        const table = this.tableOf(el);
        if (!table)
            return null;
        const rows = Array.from(table.rows).filter((tr) => !tr.hasAttribute("data-repeat"));
        let heads = 0;
        while (heads < rows.length && rows[heads]?.hasAttribute("data-header"))
            heads += 1;
        if (rows.length - heads < 2 && !(rows.length - heads === 1 && heads > 0 && !force))
            return null;
        const cuts = this.cuts(rows);
        const together = table.hasAttribute("data-keep-together");
        if (together && !force && sheet.blocks.length > 1 && el.offsetHeight <= sheet.capacity)
            return null; // it fits on a page of its own: move it whole instead
        const base = sheet.body.getBoundingClientRect().top;
        const limit = sheet.capacity - (sheet.foot.childElementCount ? sheet.foot.offsetHeight : 0) - 1;
        let keepRows = 0;
        for (let k = heads + 1; k <= rows.length - 1; k += 1) {
            const bottom = (rows[k - 1].getBoundingClientRect().bottom - base) / this.zoom;
            if (bottom > limit)
                break;
            if (cuts[k])
                keepRows = k;
        }
        if (keepRows === 0) {
            if (!force)
                return null;
            keepRows = cuts.findIndex((ok, k) => ok && k > heads); // alone on the sheet and still too tall: keep the first row that can stand alone
            if (keepRows < 0 || keepRows >= rows.length)
                return null;
        }
        const rest = el.cloneNode(false);
        rest.setAttribute("data-continued", "");
        rest.removeAttribute("data-selected");
        const shell = table.cloneNode(false);
        const columns = table.querySelector(":scope > colgroup");
        if (columns)
            shell.appendChild(columns.cloneNode(true));
        for (const head of rows.slice(0, heads)) {
            const copy = head.cloneNode(true);
            copy.setAttribute("data-repeat", "");
            copy.setAttribute("aria-hidden", "true");
            copy.removeAttribute("data-header");
            copy.querySelectorAll("[data-edit]").forEach((cell) => { cell.removeAttribute("data-edit"); cell.setAttribute("contenteditable", "false"); cell.setAttribute("tabindex", "-1"); });
            shell.appendChild(copy);
        }
        for (const tr of rows.slice(keepRows))
            shell.appendChild(tr);
        rest.appendChild(shell);
        return rest;
    }
    /** Put every table cut across pages back together (the pieces are re-cut by the next layout or reflow). */
    mergeFragments() {
        for (const part of Array.from(this.host.querySelectorAll(".blk[data-continued]"))) {
            const id = part.dataset["id"] ?? "";
            const primary = Array.from(this.host.querySelectorAll(".blk[data-id]")).find((x) => x.dataset["id"] === id && !x.hasAttribute("data-continued"));
            const into = primary ? this.tableOf(primary) : null, from = this.tableOf(part);
            if (into && from)
                for (const tr of Array.from(from.rows))
                    if (!tr.hasAttribute("data-repeat"))
                        into.appendChild(tr);
            part.remove();
        }
        for (const sheet of this.sheets)
            sheet.blocks = Array.from(sheet.body.querySelectorAll(":scope > .blk, :scope > .cols > .blk"));
    }
    /** Forget the pieces of one table (its block was re-rendered whole). */
    dropFragments(id) {
        for (const part of Array.from(this.host.querySelectorAll(".blk[data-continued]")))
            if (part.dataset["id"] === id)
                part.remove();
    }
    /** The element of a table cell, wherever on the pages that part of the table is. */
    cellEl(id, row, col) {
        for (const wrap of Array.from(this.host.querySelectorAll(".blk[data-type=table]"))) {
            if (wrap.dataset["id"] !== id)
                continue;
            const cell = wrap.querySelector(`[data-edit=cell][data-row="${row}"][data-col="${col}"]`);
            if (cell)
                return cell;
        }
        return null;
    }
    /* ------------------------------------------------------------------------------------------------- reflow */
    rows(sheet, owner) { return Array.from(sheet.foot.children).filter((r) => r instanceof HTMLElement && r.dataset["owner"] === owner); }
    move(from, to, el, atStart) {
        const id = el.dataset["id"] ?? "";
        const notes = this.rows(from, id);
        from.blocks.splice(from.blocks.indexOf(el), 1);
        this.attach(to, el, atStart);
        if (atStart)
            to.blocks.unshift(el);
        else
            to.blocks.push(el);
        for (const row of notes) {
            if (atStart)
                to.foot.insertBefore(row, to.foot.firstChild);
            else
                to.foot.appendChild(row);
        }
        from.foot.toggleAttribute("data-has", from.foot.childElementCount > 0);
        to.foot.toggleAttribute("data-has", to.foot.childElementCount > 0);
        this.tidy(from);
        this.fitRegions(from);
        this.fitRegions(to);
    }
    overflows(sheet) { return sheet.body.scrollHeight > sheet.capacity + 1 || this.regionsOverflow(sheet); }
    /** Height still free on a sheet: capacity minus the bottom of its last block and its footnote strip. */
    freeSpace(sheet) {
        if (sheet.body.querySelector(":scope > .cols"))
            return Number.POSITIVE_INFINITY; // columns: the only way to know is to try (the caller checks for overflow afterwards)
        const last = sheet.blocks[sheet.blocks.length - 1];
        const bottom = last ? last.offsetTop + last.offsetHeight : 0;
        return sheet.capacity - bottom - (sheet.foot.childElementCount ? sheet.foot.offsetHeight : 0);
    }
    /** Cheap relayout after a text edit: push overflow forward, pull blocks back when they fit, drop empty sheets.
     *  Returns true when the number of sheets changed (the caller then redraws headers, footers and numbers). */
    reflow() {
        const input = this.last;
        if (!input || !this.sheets.length)
            return false;
        const before = this.sheets.length;
        this.mergeFragments();
        for (let i = 0; i < this.sheets.length; i += 1) {
            const sheet = this.sheets[i];
            let guard = 0;
            while (sheet.blocks.length > 0 && this.overflows(sheet) && guard++ < 500) {
                let next = this.sheets[i + 1];
                const el = sheet.blocks[sheet.blocks.length - 1];
                const rest = this.tableOf(el) ? this.splitTable(sheet, el, sheet.blocks.length === 1) : null;
                if (!rest && sheet.blocks.length <= 1)
                    break;
                if (!next || next.section !== sheet.section) {
                    next = this.newSheet(input, sheet.section, i + 2);
                    this.sheets.splice(i + 1, 0, next);
                    sheet.el.after(next.el);
                }
                if (rest) {
                    next.body.insertBefore(rest, next.blocks[0] ?? next.foot);
                    next.blocks.unshift(rest);
                }
                else
                    this.move(sheet, next, el, true);
            }
            const next = this.sheets[i + 1];
            guard = 0;
            while (next && next.section === sheet.section && next.blocks.length && guard++ < 500) {
                const first = next.blocks[0];
                if (first.dataset["break"] !== undefined)
                    break;
                const need = first.offsetHeight + this.rows(next, first.dataset["id"] ?? "").reduce((sum, r) => sum + r.offsetHeight, 0);
                if (need > this.freeSpace(sheet) - 1)
                    break;
                this.move(next, sheet, first, false);
                if (this.overflows(sheet)) {
                    this.move(sheet, next, first, true);
                    break;
                }
            }
        }
        for (let i = this.sheets.length - 1; i > 0; i -= 1) {
            const sheet = this.sheets[i];
            if (!sheet.blocks.length) {
                sheet.el.remove();
                this.sheets.splice(i, 1);
            }
        }
        this.sheets.forEach((sheet, i) => { sheet.number = i + 1; });
        this.applySides();
        const changed = this.sheets.length !== before;
        this.fit();
        this.placed();
        return changed;
    }
    /** A sheet that moved to the other side of a book (a page was added or taken away before it) gets the margins of its new side. The text area has the same
     *  width on both sides, so nothing has to be laid out again. */
    applySides() {
        for (const sheet of this.sheets) {
            const geometry = geometryFor(sheet.base, sheet.number);
            sheet.el.dataset["page"] = String(sheet.number);
            sheet.el.dataset["side"] = sheet.number % 2 === 1 ? "right" : "left";
            if (geometry.margins.left === sheet.geometry.margins.left && geometry.margins.right === sheet.geometry.margins.right)
                continue;
            sheet.geometry = geometry;
            const m = geometry.margins;
            sheet.body.style.setProperty("margin", `${m.top * MM_PX}px ${m.right * MM_PX}px ${m.bottom * MM_PX}px ${m.left * MM_PX}px`);
        }
    }
    /** Redraw headers, footers, page numbers, margin lines, guides and rulers without moving any block. */
    redecorate() {
        const input = this.last;
        if (!input)
            return;
        const keep = this.lineFocus();
        for (const sheet of this.sheets) {
            for (const extra of Array.from(sheet.el.children))
                if (extra !== sheet.body)
                    extra.remove();
        }
        this.decorate(input);
        this.placed();
        this.restoreLineFocus(keep);
    }
    /** Moving a line with the arrow keys redraws the page; the focus has to stay on the line (or ruler handle) being moved. */
    holdsLineFocus() { return this.pendingFocus !== null || (document.activeElement instanceof Element && document.activeElement.hasAttribute("data-kind")); }
    lineFocus() {
        if (this.pendingFocus)
            return this.pendingFocus;
        const active = document.activeElement;
        if (!(active instanceof Element) || !active.hasAttribute("data-kind"))
            return null;
        const kind = active.getAttribute("data-kind") ?? "";
        const sheetEl = active.closest(".sheet");
        if (sheetEl)
            return { where: "page", sheet: this.sheets.findIndex((x) => x.el === sheetEl), kind };
        if (this.hruler.contains(active))
            return { where: "h", sheet: 0, kind };
        const v = this.vrulers.findIndex((x) => x.wrap.contains(active));
        return v >= 0 ? { where: "v", sheet: v, kind } : null;
    }
    restoreLineFocus(keep) {
        this.pendingFocus = null;
        if (!keep || keep.sheet < 0)
            return;
        const root = keep.where === "page" ? this.sheets[keep.sheet]?.el : keep.where === "h" ? this.hruler : this.vrulers[keep.sheet]?.wrap;
        root?.querySelector(`[data-kind="${keep.kind}"]`)?.focus({ preventScroll: true });
    }
    /** Headers, footers, margin lines, guides and vertical rulers: all drawn per sheet once the page count is known. */
    decorate(input) {
        const pages = this.sheets.length;
        const labels = printedPageNumbers(this.sheets.map((sheet) => ({ section: sheet.section, ...this.headerFooter(sheet.section) })));
        this.sheets.forEach((sheet, i) => {
            const hf = this.headerFooter(sheet.section);
            const printed = labels[i] ?? null;
            sheet.el.dataset["printed"] = printed ?? "";
            const values = { page: printed ?? "", pages: String(pages), title: input.title };
            const m = sheet.geometry.margins;
            const band = (edge, ordinary) => {
                // A left-hand page may have its own text; in a book the outer edge is the left one, so the ordinary text is swapped there (see runningBand).
                const { spec, flipped } = runningBand(edge, ordinary, sheet.geometry.book, sheet.number);
                if (!spec || (!spec.left && !spec.center && !spec.right))
                    return null;
                const cell = (shown, cls) => {
                    const part = flipped && shown !== "center" ? (shown === "left" ? "right" : "left") : shown;
                    const node = h("span", { class: cls });
                    const paint = (target, format) => {
                        if (format?.font_family)
                            target.style.fontFamily = format.font_family;
                        if (format?.font_size_pt)
                            target.style.fontSize = `${format.font_size_pt}pt`;
                        if (format?.color)
                            target.style.color = format.color;
                        if (format?.bold !== undefined)
                            target.style.fontWeight = format.bold ? "bold" : "normal";
                        if (format?.italic !== undefined)
                            target.style.fontStyle = format.italic ? "italic" : "normal";
                        if (format?.underline !== undefined)
                            target.style.textDecoration = format.underline ? "underline" : "none";
                    };
                    paint(node, spec.formats?.[part]);
                    const fragments = spec.runs?.[part];
                    if (fragments?.length && fragments.map((x) => x.text).join("") === (spec[part] ?? "")) {
                        for (const fragment of fragments) {
                            const span = h("span", { text: fillTemplate(fragment.text, values) });
                            paint(span, fragment.format);
                            node.appendChild(span);
                        }
                    }
                    else
                        node.textContent = fillTemplate(spec[part] ?? "", values);
                    return node;
                };
                const row = h("div", { class: `hf ${edge}`, attrs: { contenteditable: "false", "data-edge": edge } }, cell("left", "l"), cell("center", "c"), cell("right", "r"));
                row.style.setProperty(edge === "header" ? "top" : "bottom", `${(edge === "header" ? sheet.geometry.headerMm : sheet.geometry.footerMm) * MM_PX}px`);
                row.style.setProperty("left", `${m.left * MM_PX}px`);
                row.style.setProperty("right", `${m.right * MM_PX}px`);
                return row;
            };
            // Hiding the printed number must not remove unrelated header/footer text.
            // The explicitly designated cover, however, starts with empty page bands.
            const extras = hf.role === "cover" ? [] : [band("header", hf.header), band("footer", hf.footer)];
            if (printed !== null)
                extras.push(h("div", { class: "page-no", attrs: { contenteditable: "false", "aria-hidden": "true" }, text: printed }));
            if (input.showMargins)
                extras.push(this.marginLines(sheet));
            if (input.showGuides)
                extras.push(this.guideLines(sheet, input.guides));
            const [behind, front] = this.bandLayers(sheet, i === 0 || this.sheets[i - 1]?.section !== sheet.section);
            if (behind)
                sheet.el.insertBefore(behind, sheet.el.firstChild); // under the body, whose blocks have a z-index of their own
            for (const e of extras)
                if (e)
                    sheet.el.appendChild(e);
            if (front)
                sheet.el.appendChild(front);
            sheet.el.setAttribute("aria-label", `Page ${i + 1} of ${pages}`);
        });
        this.onDecorated?.();
        this.vlayer.replaceChildren();
        const rowStarts = new Set(this.arrangement.rows.map((_, row) => pagesInRow(this.arrangement, row)[0])); // pages side by side share the scale at the left
        this.vrulers = input.showRulers ? this.sheets.flatMap((sheet, at) => (rowStarts.has(at) ? [{ wrap: this.verticalRuler(sheet), sheet }] : [])) : [];
        for (const v of this.vrulers)
            this.vlayer.appendChild(v.wrap);
        this.drawRuler(input);
        this.placeVRulers();
    }
    /** Each page's scale is placed at that page's current position on screen; the strip clips what is out of view. */
    placeVRulers() {
        if (!this.vrulers.length)
            return;
        const origin = this.vlayer.getBoundingClientRect();
        const z = this.zoom;
        for (const { wrap, sheet } of this.vrulers) {
            const r = sheet.el.getBoundingClientRect();
            wrap.style.setProperty("top", `${Math.round(r.top - origin.top)}px`);
            wrap.style.setProperty("transform", `scaleY(${z})`);
        }
    }
    /* ------------------------------------------------------------------------------------------------- movable lines */
    spec(sheet, kind) {
        const g = sheet.geometry;
        const m = g.margins;
        const W = g.widthMm;
        const H = g.heightMm;
        switch (kind) {
            case "left": return { kind, axis: "v", mm: m.left, name: lineNames(g.book, sheet.number).left, min: 0, max: W - m.right - MIN_BODY };
            case "right": return { kind, axis: "v", mm: W - m.right, name: lineNames(g.book, sheet.number).right, min: m.left + MIN_BODY, max: W };
            case "top": return { kind, axis: "h", mm: m.top, name: "Top margin", min: 0, max: H - m.bottom - MIN_BODY };
            case "bottom": return { kind, axis: "h", mm: H - m.bottom, name: "Bottom margin", min: m.top + MIN_BODY, max: H };
            case "header": return { kind, axis: "h", mm: g.headerMm, name: "Header", min: 0, max: H - g.footerMm - MIN_BODY };
            default: return { kind, axis: "h", mm: H - g.footerMm, name: "Footer", min: g.headerMm + MIN_BODY, max: H };
        }
    }
    commit(sheet, kind, mm) {
        const g = sheet.geometry;
        const value = Math.round(mm * 2) / 2;
        if (kind === "left")
            this.events.margin(sheet.section, "left", value, sheet.number);
        else if (kind === "top")
            this.events.margin(sheet.section, "top", value, sheet.number);
        else if (kind === "right")
            this.events.margin(sheet.section, "right", g.widthMm - value, sheet.number);
        else if (kind === "bottom")
            this.events.margin(sheet.section, "bottom", g.heightMm - value, sheet.number);
        else if (kind === "header")
            this.events.band(sheet.section, "header", value);
        else
            this.events.band(sheet.section, "footer", g.heightMm - value);
    }
    fmt(mm) { return this.unit === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${Number(mm.toFixed(1))} mm`; }
    /** The number beside the ruler: along the top ruler for a vertical line, along the left strip for a horizontal one. */
    showReadout(sheet, axis, mm, name) {
        const area = this.el.getBoundingClientRect();
        const r = sheet.el.getBoundingClientRect();
        const at = mm * MM_PX * this.zoom;
        const o = this.readout;
        o.textContent = `${name} ${this.fmt(mm)}`;
        o.hidden = false;
        o.dataset["axis"] = axis;
        if (axis === "v") {
            o.style.setProperty("left", `${Math.round(clampMm(r.left - area.left + at, 40, area.width - 40))}px`);
            o.style.setProperty("top", "38px");
        }
        else {
            o.style.setProperty("top", `${Math.round(clampMm(r.top - area.top + at, 50, area.height - 12))}px`);
            o.style.setProperty("left", "34px");
        }
    }
    hideReadout() { if (!this.dragging)
        this.readout.hidden = true; }
    /** Everything that shows one line follows it while it is dragged: the line on the page, its ruler handle, and the header or footer text. */
    preview(sheet, spec, mm) {
        const px = `${mm * MM_PX}px`;
        const line = sheet.el.querySelector(`.mline[data-kind="${spec.kind}"]`);
        line?.style.setProperty(spec.axis === "v" ? "left" : "top", px);
        line?.setAttribute("aria-valuenow", String(mm));
        if (spec.kind === "header")
            sheet.el.querySelector(".hf.header")?.style.setProperty("top", px);
        if (spec.kind === "footer")
            sheet.el.querySelector(".hf.footer")?.style.setProperty("bottom", `${(sheet.geometry.heightMm - mm) * MM_PX}px`);
        const root = spec.axis === "v" ? (sheet === this.sheets[0] ? this.hruler : null) : this.vrulers.find((x) => x.sheet === sheet)?.wrap ?? null;
        root?.querySelector(`.mhandle[data-kind="${spec.kind}"]`)?.setAttribute(spec.axis === "v" ? "x" : "y", String(mm * MM_PX - 3));
        this.showReadout(sheet, spec.axis, mm, spec.name);
    }
    startDrag(e, capture, sheet, kind) {
        if (e.button !== 0)
            return;
        e.preventDefault();
        e.stopPropagation();
        if (this.locked)
            return;
        const spec = this.spec(sheet, kind);
        capture.setPointerCapture(e.pointerId);
        const rect = sheet.el.getBoundingClientRect();
        const toMm = (ev) => clampMm(Math.round(((spec.axis === "v" ? ev.clientX - rect.left : ev.clientY - rect.top) / this.zoom / MM_PX) * 2) / 2, spec.min, spec.max);
        this.dragging = true;
        const move = (ev) => this.preview(sheet, spec, toMm(ev));
        const end = (ev, apply) => {
            capture.removeEventListener("pointermove", move);
            capture.removeEventListener("pointerup", up);
            capture.removeEventListener("pointercancel", cancel);
            this.dragging = false;
            this.hideReadout();
            const mm = apply ? toMm(ev) : spec.mm;
            if (mm === spec.mm) {
                this.preview(sheet, spec, spec.mm);
                this.hideReadout();
            }
            else
                this.commit(sheet, kind, mm);
        };
        const up = (ev) => end(ev, true);
        const cancel = (ev) => end(ev, false);
        capture.addEventListener("pointermove", move);
        capture.addEventListener("pointerup", up);
        capture.addEventListener("pointercancel", cancel);
        this.preview(sheet, spec, spec.mm);
    }
    /** Arrow keys move a line by half a millimetre (five with Shift), Home and End go to the limits. */
    nudge(e, sheet, kind) {
        const spec = this.spec(sheet, kind);
        const step = e.shiftKey ? 5 : 0.5;
        const back = spec.axis === "v" ? "ArrowLeft" : "ArrowUp";
        const forward = spec.axis === "v" ? "ArrowRight" : "ArrowDown";
        let mm = null;
        if (e.key === back)
            mm = spec.mm - step;
        else if (e.key === forward)
            mm = spec.mm + step;
        else if (e.key === "Home")
            mm = spec.min;
        else if (e.key === "End")
            mm = spec.max;
        if (mm === null)
            return;
        e.preventDefault();
        e.stopPropagation();
        if (this.locked)
            return;
        mm = clampMm(mm, spec.min, spec.max);
        if (mm === spec.mm)
            return;
        const on = e.currentTarget instanceof Element ? e.currentTarget : null;
        const where = on && this.hruler.contains(on) ? "h" : on && on.closest(".vruler") ? "v" : "page";
        this.pendingFocus = { where, sheet: where === "v" ? Math.max(0, this.vrulers.findIndex((x) => x.sheet === sheet)) : this.sheets.indexOf(sheet), kind };
        this.commit(sheet, kind, mm);
        window.setTimeout(() => { this.pendingFocus = null; }, 3000); // the step failed or changed nothing: do not keep claiming the focus
    }
    describe(spec) { return `${spec.name}, ${this.fmt(spec.mm)}. Arrow keys move it, Shift for larger steps.`; }
    marginLines(sheet) {
        const wrap = h("div", { class: "margins", attrs: { contenteditable: "false" } });
        for (const kind of ["left", "right", "top", "bottom", "header", "footer"]) {
            const spec = this.spec(sheet, kind);
            const l = h("div", {
                class: `mline drag ${LINE_CLASS[kind]} ${spec.axis}${this.locked ? " locked" : ""}`, data: { kind },
                attrs: { tabindex: "0", role: "slider", "aria-orientation": spec.axis === "v" ? "horizontal" : "vertical", "aria-label": spec.name, "aria-valuemin": spec.min, "aria-valuemax": spec.max, "aria-valuenow": spec.mm, "aria-valuetext": this.describe(spec) },
            });
            l.style.setProperty(spec.axis === "v" ? "left" : "top", `${spec.mm * MM_PX}px`);
            // Header/footer boundaries are contained within the writable horizontal
            // span. Margin guides themselves still reach the page edges for dragging.
            if (kind === "header" || kind === "footer") {
                l.style.setProperty("left", `${sheet.geometry.margins.left * MM_PX}px`);
                l.style.setProperty("right", `${sheet.geometry.margins.right * MM_PX}px`);
            }
            l.addEventListener("pointerdown", (e) => this.startDrag(e, l, sheet, kind));
            l.addEventListener("pointerenter", () => { if (!this.dragging)
                this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name); });
            l.addEventListener("pointerleave", () => this.hideReadout());
            l.addEventListener("focus", () => this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name));
            l.addEventListener("blur", () => this.hideReadout());
            l.addEventListener("keydown", (e) => this.nudge(e, sheet, kind));
            wrap.appendChild(l);
        }
        return wrap;
    }
    guideLines(sheet, guides) {
        const wrap = h("div", { class: "guides", attrs: { contenteditable: "false" } });
        const add = (axis, mm, index) => {
            const g = h("div", { class: `mline user ${axis}`, attrs: { role: "separator", tabindex: "0", "aria-label": `${axis === "v" ? "Vertical" : "Horizontal"} guide at ${mm.toFixed(1)} millimetres. Arrow keys move it, Delete removes it.`, title: "Drag to move, double-click or Delete to remove" } });
            g.style.setProperty(axis === "v" ? "left" : "top", `${mm * MM_PX}px`);
            g.addEventListener("pointerdown", (e) => this.dragGuide(e, g, sheet, axis, index));
            g.addEventListener("pointerenter", () => { if (!this.dragging)
                this.showReadout(sheet, axis, mm, "Guide"); });
            g.addEventListener("pointerleave", () => this.hideReadout());
            g.addEventListener("focus", () => this.showReadout(sheet, axis, mm, "Guide"));
            g.addEventListener("blur", () => this.hideReadout());
            g.addEventListener("dblclick", (e) => { e.stopPropagation(); this.events.guideMove(axis, index, null); });
            const context = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(g, [
                    { label: "Edit position…", disabled: this.locked, run: () => {
                            void (async () => {
                                const result = await promptDialog({ title: "Guide position", label: "Position (mm from page edge)", value: String(mm),
                                    validate: (value) => {
                                        const n = Number(value);
                                        const max = axis === "v" ? sheet.geometry.widthMm : sheet.geometry.heightMm;
                                        return value.trim() && Number.isFinite(n) && n >= 0 && n <= max ? null : `Choose a number from 0 to ${max} mm.`;
                                    } });
                                if (result !== null)
                                    this.events.guideMove(axis, index, Number(result));
                            })();
                        } },
                    { label: "Duplicate guide", disabled: this.locked, run: () => this.events.guideAdd(axis, mm) },
                    { label: "Remove guide", disabled: this.locked, run: () => this.events.guideMove(axis, index, null) },
                ], { label: "Page guide" });
            };
            g.addEventListener("contextmenu", context);
            g.addEventListener("keydown", (e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
                context(e); });
            g.addEventListener("keydown", (e) => {
                if (this.locked)
                    return;
                if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    this.events.guideMove(axis, index, null);
                }
                const step = e.shiftKey ? 5 : 1;
                const delta = axis === "v" ? (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0) : (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
                if (delta) {
                    e.preventDefault();
                    this.events.guideMove(axis, index, mm + delta);
                }
            });
            wrap.appendChild(g);
        };
        (guides.v ?? []).forEach((mm, i) => add("v", mm, i));
        (guides.h ?? []).forEach((mm, i) => add("h", mm, i));
        return wrap;
    }
    dragGuide(e, el, sheet, axis, index) {
        if (this.locked || e.button !== 0)
            return;
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const rect = sheet.el.getBoundingClientRect();
        const limit = axis === "v" ? sheet.geometry.widthMm : sheet.geometry.heightMm;
        const toMm = (ev) => ((axis === "v" ? ev.clientX - rect.left : ev.clientY - rect.top) / this.zoom) / MM_PX;
        this.dragging = true;
        const move = (ev) => { const at = Math.max(0, Math.min(limit, toMm(ev))); el.style.setProperty(axis === "v" ? "left" : "top", `${at * MM_PX}px`); this.showReadout(sheet, axis, Math.round(at * 2) / 2, "Guide"); };
        const finish = (ev, apply) => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", cancel);
            this.dragging = false;
            this.hideReadout();
            if (!apply) {
                el.style.setProperty(axis === "v" ? "left" : "top", `${(this.last?.guides[axis]?.[index] ?? 0) * MM_PX}px`);
                return;
            }
            const mm = toMm(ev);
            this.events.guideMove(axis, index, mm < 0 || mm > limit ? null : Math.round(mm * 2) / 2);
        };
        const up = (ev) => finish(ev, true);
        const cancel = (ev) => finish(ev, false);
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", cancel);
    }
    ticks(lengthMm, vertical, sheet, kinds, label) {
        const w = vertical ? RULER : lengthMm * MM_PX;
        const hgt = vertical ? lengthMm * MM_PX : RULER;
        const svg = s("svg", { class: `ruler-svg ${vertical ? "v" : "h"}`, attrs: { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: "group", "aria-label": label, focusable: "false" } });
        // The design draws the rulers as bar-code style tick marks without numbers: a short mark every millimetre, a longer one every 5, the longest every 10.
        for (let mm = 0; mm <= lengthMm; mm += 1) {
            const long = mm % 10 === 0 ? RULER : mm % 5 === 0 ? RULER * 0.62 : RULER * 0.36;
            const p = mm * MM_PX;
            svg.appendChild(vertical ? s("line", { class: "tick", attrs: { x1: RULER - long, x2: RULER, y1: p, y2: p } }) : s("line", { class: "tick", attrs: { x1: p, x2: p, y1: RULER - long, y2: RULER } }));
        }
        // The handles on the ruler are the same lines as the ones on the page: dragging either moves both, and hovering either shows its number.
        for (const kind of kinds) {
            const spec = this.spec(sheet, kind);
            const p = spec.mm * MM_PX;
            const handle = s("rect", { class: `mhandle ${LINE_CLASS[kind]}`, attrs: { tabindex: "0", role: "slider", "data-kind": kind, "aria-orientation": vertical ? "vertical" : "horizontal", "aria-label": spec.name, "aria-valuemin": spec.min, "aria-valuemax": spec.max, "aria-valuenow": spec.mm, "aria-valuetext": this.describe(spec), ...(vertical ? { x: 0, y: p - 3, width: RULER, height: 6 } : { x: p - 3, y: 0, width: 6, height: RULER }) } });
            handle.addEventListener("pointerdown", (e) => this.startDrag(e, handle, sheet, kind));
            handle.addEventListener("pointerenter", () => { if (!this.dragging)
                this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name); });
            handle.addEventListener("pointerleave", () => this.hideReadout());
            handle.addEventListener("focus", () => this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name));
            handle.addEventListener("blur", () => this.hideReadout());
            handle.addEventListener("keydown", (e) => this.nudge(e, sheet, kind));
            svg.appendChild(handle);
        }
        return svg;
    }
    verticalRuler(sheet) {
        const g = sheet.geometry;
        const wrap = h("div", { class: "vruler", attrs: { contenteditable: "false" } });
        wrap.appendChild(this.ticks(g.heightMm, true, sheet, ["top", "header", "footer", "bottom"], "Vertical ruler. Handles: top margin, header, footer and bottom margin"));
        wrap.addEventListener("dblclick", (e) => { e.stopPropagation(); this.events.rulerDouble(); });
        return wrap;
    }
    drawRuler(input) {
        this.hruler.replaceChildren();
        const multi = this.view.facing || this.view.perRow > 1; // one ruler cannot belong to several pages side by side
        this.hruler.toggleAttribute("hidden", !input.showRulers || multi);
        const first = this.sheets[0];
        if (!first || !input.showRulers || multi) {
            this.rulerSvg = null;
            return;
        }
        this.rulerSvg = this.ticks(first.geometry.widthMm, false, first, ["left", "right"], "Horizontal ruler. Handles: left and right margin");
        this.hruler.appendChild(h("div", { class: "hruler-inner" }, this.rulerSvg));
        this.placeRuler();
    }
    placeRuler() {
        const inner = this.hruler.firstElementChild;
        const first = this.sheets[0];
        if (!inner || !first)
            return;
        const hostRect = first.el.getBoundingClientRect();
        const barRect = this.hruler.getBoundingClientRect();
        inner.style.setProperty("transform", `translateX(${hostRect.left - barRect.left}px) scale(${this.zoom})`);
        inner.style.setProperty("transform-origin", "0 0");
    }
    /* ------------------------------------------------------------------------------------------------- zoom */
    setZoom(percent) {
        this.zoom = Math.max(0.1, Math.min(4, percent / 100));
        this.zoomer.style.setProperty("transform", `scale(${this.zoom})`);
        this.held = 0;
        this.fit();
        this.placeRuler();
        this.placed();
    }
    /** Change how far apart the pages are (``change`` sets the margins that do it) while the page ``pin`` stays where it is on the screen: the pages of its row make room
     *  by moving away from it, as far as the window allows (the window's edge keeps every tab and panel in view, so the page moves a little when it must). The pages of
     *  other rows are not moved sideways.
     *  The new layout is in place at once, so everything that is measured afterwards is final; the pages that moved glide from where they were (a transform, which
     *  changes no layout and so no pagination). The shift that keeps the pinned page in place is remembered in ``held`` until the zoom, the arrangement or the window changes. */
    holding(pin, change) {
        const sheet = pin === null ? undefined : this.sheets[pin];
        const was = this.sheets.map((s) => s.el.getBoundingClientRect().left);
        const before = pin === null ? undefined : was[pin];
        change();
        this.fit();
        if (sheet && before !== undefined) {
            const moved = sheet.el.getBoundingClientRect().left - before;
            if (Math.abs(moved) >= 0.5) {
                this.held -= moved;
                this.fit();
            } // what the window's edge does not allow is not forced: the page moves as little as it must
        }
        this.sheets.forEach((s, i) => {
            const d = (was[i] ?? 0) - s.el.getBoundingClientRect().left;
            if (Math.abs(d) < 0.5)
                return;
            const flight = new DOMMatrixReadOnly(getComputedStyle(s.el).transform === "none" ? undefined : getComputedStyle(s.el).transform).m41; // already gliding: carry on from where it is
            s.el.style.setProperty("transition", "none");
            s.el.style.setProperty("transform", `translateX(${flight + d / this.zoom}px)`);
            void s.el.offsetWidth;
            s.el.style.removeProperty("transition");
            s.el.style.removeProperty("transform");
        });
    }
    /** The left margins that keep the tabs and panels of pages side by side apart, in page units (0 for a page that needs none). */
    setSeams(margins) {
        this.seams = margins.map((m) => Math.max(0, Math.round(m)));
        this.applySeams();
    }
    applySeams() {
        this.sheets.forEach((sheet, i) => {
            const m = this.seams[i] ?? 0;
            if (m > 0)
                sheet.el.style.setProperty("margin-left", `${m}px`);
            else
                sheet.el.style.removeProperty("margin-left");
        });
    }
    /** Room, in unscaled page units, that the panels attached to a page need beside it, so that opening one never clips it or covers the text. */
    setRoom(left, right) {
        if (this.room.left === left && this.room.right === right)
            return;
        this.room = { left, right };
        this.fit();
        this.placeRuler();
    }
    /* ------------------------------------------------------------------------------------------------- arrangement */
    /** Put the sheets one, two, three or four to a row, or in the book view (page 1 alone on the right, then 2-3, 4-5). Only where the sheets sit changes. */
    setArrangement(perRow, facing) {
        if (this.view.perRow === perRow && this.view.facing === facing)
            return;
        const keep = this.anchor();
        this.view = { perRow, facing };
        this.held = 0;
        this.applyArrangement();
        if (this.last) {
            this.redecorate();
        }
        this.fit();
        this.placeRuler();
        this.placed();
        this.restoreAnchor(keep);
    }
    get arrangement() { return arrange(this.sheets.length, this.view.perRow, this.view.facing); }
    get arrangementMode() { return { ...this.view }; }
    applyArrangement() {
        const { perRow, facing } = this.view;
        const per = facing ? 2 : perRow;
        this.host.dataset["perRow"] = String(per);
        this.host.toggleAttribute("data-facing", facing && this.sheets.length > 0);
        this.host.style.setProperty("--per-row", String(per));
        this.slot?.remove();
        this.slot = null;
        const first = this.sheets[0];
        if (facing && first) { // the empty place beside page 1: a place on the desk, never a page of the document
            const slot = h("div", { class: "sheet-slot", attrs: { "aria-hidden": "true", contenteditable: "false" } });
            slot.style.setProperty("width", `${first.geometry.widthMm * MM_PX}px`);
            slot.style.setProperty("height", `${first.geometry.heightMm * MM_PX}px`);
            this.host.insertBefore(slot, this.host.firstChild);
            this.slot = slot;
        }
    }
    /** The page at the top of the window and how far into it the window is, so that changing the arrangement keeps the reader where they were. */
    anchor() {
        const view = this.scroller.getBoundingClientRect();
        const index = Math.max(0, this.sheets.findIndex((sh) => sh.el.getBoundingClientRect().bottom > view.top + 1));
        const sheet = this.sheets[index];
        if (!sheet)
            return { sheet: 0, fraction: 0 };
        const r = sheet.el.getBoundingClientRect();
        return { sheet: index, fraction: Math.max(0, Math.min(1, (view.top - r.top) / Math.max(1, r.height))) };
    }
    restoreAnchor(at) {
        const sheet = this.sheets[at.sheet];
        if (!sheet)
            return;
        const view = this.scroller.getBoundingClientRect();
        const r = sheet.el.getBoundingClientRect();
        this.scroller.scrollTop += r.top + at.fraction * r.height - view.top;
    }
    /** The zoom that makes the whole arrangement fit the window: its widest row across, its tallest page down, or both (`entire`). */
    fitZoom(mode) {
        if (!this.sheets.length)
            return 100;
        const pad = 56;
        const view = { width: Math.max(50, this.scroller.clientWidth - pad - 28), height: Math.max(50, this.scroller.clientHeight - pad) };
        const boxes = this.sheets.map((sheet) => ({ widthMm: sheet.geometry.widthMm, heightMm: sheet.geometry.heightMm }));
        // side by side the pages keep the room their two tabs need between them (see panel_layout.ts)
        const gap = this.view.facing ? 0 : this.view.perRow > 1 ? 2 * 20 + 6 : 28;
        return Math.round(fitFraction(mode, this.arrangement, boxes, view, MM_PX, gap) * 100);
    }
    /** Size the scrolling area to the scaled pages and centre them; panels open beside a page push the page away from the edge, never off it.
     *  ``held`` moves the pages by that many pixels from where centring puts them (see ``holding``). */
    fit() {
        const z = this.zoom;
        const pad = 28 * z;
        const w = this.host.offsetWidth * z + 2 * pad;
        const hgt = this.host.offsetHeight * z + 2 * pad;
        const view = this.scroller.clientWidth;
        const least = Math.max(this.room.left * z, 30);
        const centred = (view - w) / 2;
        const left = Math.max(least, centred + this.held);
        this.held = left - centred; // what was asked for, less what the window's edge refused
        this.zoomer.style.setProperty("margin-left", `${Math.round(left)}px`);
        this.sizer.style.setProperty("width", `${Math.max(view, Math.round(left + w + this.room.right * z))}px`);
        this.sizer.style.setProperty("height", `${Math.round(hgt)}px`);
    }
    /** Where an element is, in the page's own (unscaled) units, relative to the zoomed area. */
    rectOf(el) {
        const z = this.zoom;
        const origin = this.zoomer.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { left: (r.left - origin.left) / z, top: (r.top - origin.top) / z, width: r.width / z, height: r.height / z };
    }
    /** A pointer position in the page's own units. */
    toPage(clientX, clientY) {
        const origin = this.zoomer.getBoundingClientRect();
        return { x: (clientX - origin.left) / this.zoom, y: (clientY - origin.top) / this.zoom };
    }
    /** Where a sheet is, in unscaled page units relative to the zoomed area (the same coordinates the attachment layer uses). */
    sheetRect(index) {
        const sheet = this.sheets[index];
        if (!sheet)
            return null;
        const z = this.zoom;
        const origin = this.zoomer.getBoundingClientRect();
        const r = sheet.el.getBoundingClientRect();
        return { left: (r.left - origin.left) / z, top: (r.top - origin.top) / z, width: r.width / z, height: r.height / z };
    }
    /* ------------------------------------------------------------------------------------------------- queries */
    sheetOf(el) { const sheet = el?.closest(".sheet"); return this.sheets.find((x) => x.el === sheet); }
    pageIndexOf(el) { const sheet = this.sheetOf(el); return sheet ? this.sheets.indexOf(sheet) : 0; }
    scrollToSheet(index) { this.sheets[index]?.el.scrollIntoView({ block: "start", behavior: "auto" }); }
    onDouble(e) {
        const target = e.target;
        if (target.closest(".blk, .hf, .mline, .vruler, .foot"))
            return;
        const sheet = this.sheetOf(target);
        if (!sheet)
            return;
        const rect = sheet.el.getBoundingClientRect();
        this.events.pageDouble(this.sheets.indexOf(sheet), sheet.section, ((e.clientX - rect.left) / this.zoom) / MM_PX, ((e.clientY - rect.top) / this.zoom) / MM_PX);
    }
    get total() { return this.sheets.length; }
    get layoutInput() { return this.last; }
}
export function pageIcon() { return glyph("layout"); }
