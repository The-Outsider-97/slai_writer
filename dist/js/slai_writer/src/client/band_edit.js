/** Editing the shapes of a header or footer.
 *
 *  A header or footer is a definition that every page using it repeats, so its shapes are part of the document (``slai.writer.band_shapes``, see ``bands.ts``) and are
 *  drawn by the page view on every page that uses it, in the editing view, in the Rendered View's PDF and in the exports. This class is only the *editing mode*:
 *
 *  * ``enter`` (a double click in the header or footer area of a page, or Insert → Header / Footer) makes the header or footer of that page the one being edited. The body
 *    is dimmed and takes no clicks, the pages that use this header or footer show a zone and a box round each of its shapes, and the Header & Footer ribbon tab appears;
 *  * a shape is selected, moved, resized, nudged, duplicated, deleted and formatted there; every change is one ordinary Writer operation (``band_shape_set`` and its
 *    siblings), so it is one undo step, saved with the document, and shown at once on every page that uses the same header or footer;
 *  * ``exit`` (Close, Escape, a double click in the body) gives the page back. The body selection is never touched: the editor remembers where the caret was.
 *
 *  What is edited is chosen by the page that was clicked (its first-page, odd or even variant) and kept as that page, so turning "different first page" or "odd and even"
 *  on or off moves the editing to the variant the page now shows. None of this is a temporary overlay: the overlay is only the handles; the shapes themselves are the
 *  ones the page view draws from the document. */
import { announce, h, toast } from "./kit.js";
import { errorText } from "./net.js";
import { MM_PX } from "./textops.js";
import { paintShape } from "./shape.js";
import { resizeShape } from "./shape_format.js";
import { paragraphStyler } from "./render.js";
import * as A from "./actions.js";
import { MAX_BAND_ITEMS, itemsOf, newBandId, ownerOf, placeBand, shapesForPage, storedFromBox, variantFor, } from "./bands.js";
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_MM = 2;
const NUDGE_MM = 1;
const VARIANT_NAMES = { default: "", even: "even pages", first: "first page" };
export class BandEditor {
    ed;
    anchor = null;
    selectedId = null;
    listeners = new Set();
    savedEditable = null;
    /** Until when the selected shape gets the keyboard focus back after the page is drawn again (a change is often drawn twice in a row). */
    focusUntil = 0;
    set refocus(on) { this.focusUntil = on ? performance.now() + 900 : 0; }
    get refocus() { return performance.now() < this.focusUntil; }
    dragging = false;
    constructor(ed) {
        this.ed = ed;
        ed.page.setBandShapes({
            shapes: (section, edge, physical, first) => {
                const id = section ?? this.firstSection();
                return id ? shapesForPage(this.ed.model.meta, id, edge, physical, first) : { items: [], variant: "default", mirrored: false };
            },
            paint: (item, width) => paintShape({ ...item.shape, width_mm: width, layout: undefined }, paragraphStyler(this.ed.model.meta)),
        });
        ed.page.onDecorated = () => this.paint();
        ed.page.host.addEventListener("dblclick", this.onDouble, true);
    }
    destroy() { this.ed.page.host.removeEventListener("dblclick", this.onDouble, true); this.listeners.clear(); }
    /* ------------------------------------------------------------------------------------------------ what is being edited */
    firstSection() { return this.ed.model.meta.sections?.[0]?.id; }
    sectionOf(sheet) { return sheet.section ?? this.firstSection(); }
    info(sheet, edge) {
        const section = this.sectionOf(sheet);
        if (!section)
            return null;
        const sheets = this.ed.page.sheets;
        const at = sheets.indexOf(sheet);
        const first = at <= 0 || sheets[at - 1]?.section !== sheet.section;
        const meta = this.ed.model.meta;
        const raw = variantFor(meta, section, sheet.number, first);
        const shown = shapesForPage(meta, section, edge, sheet.number, first);
        return { section, raw, owner: ownerOf(meta, section, edge), mirrored: raw === "even" ? false : shown.mirrored, first };
    }
    /** The header or footer being edited, or null. It is derived from the page that was chosen, every time, so it follows "different first page" and "odd and even". */
    get active() {
        const a = this.anchor;
        if (!a)
            return null;
        const sheets = this.ed.page.sheets;
        const sheet = sheets.find((s) => s.number === a.number && this.sectionOf(s) === a.section) ?? sheets.find((s) => this.sectionOf(s) === a.section);
        const info = sheet ? this.info(sheet, a.edge) : null;
        return info ? { section: info.section, edge: a.edge, variant: info.raw, owner: info.owner } : null;
    }
    uses(sheet, target) {
        const info = this.info(sheet, target.edge);
        return info && info.raw === target.variant && info.owner === target.owner ? { mirrored: info.mirrored } : null;
    }
    /** The pages (their numbers) that show the header or footer being edited. */
    pagesUsing() {
        const t = this.active;
        return t ? this.ed.page.sheets.filter((s) => this.uses(s, t)).map((s) => s.number) : [];
    }
    /** The shapes of the header or footer being edited, in drawing order. */
    list() {
        const t = this.active;
        return t ? itemsOf(this.ed.model.meta, t.section, t.edge, t.variant) : [];
    }
    get selected() { return this.list().find((i) => i.id === this.selectedId) ?? null; }
    /** "Header", "Footer · first page", "Header · odd pages" ... */
    label() {
        const t = this.active;
        if (!t)
            return "";
        const book = (this.ed.model.meta.extensions?.["slai.writer"] ?? {}).book_layouts?.[t.section];
        const variant = t.variant === "default" && book?.odd_even ? "odd pages" : VARIANT_NAMES[t.variant];
        const base = t.edge === "header" ? "Header" : "Footer";
        return variant ? `${base} · ${variant}` : base;
    }
    listen(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
    emit() { for (const fn of [...this.listeners])
        fn(); }
    /* ------------------------------------------------------------------------------------------------------- enter and exit */
    /** Make the header or footer of the sheet at ``sheetIndex`` the one being edited. */
    enter(edge, sheetIndex) {
        if (this.ed.readOnly) {
            toast("This document is read-only.", { kind: "info" });
            return false;
        }
        const sheet = this.ed.page.sheets[Math.max(0, Math.min(sheetIndex, this.ed.page.sheets.length - 1))];
        const section = sheet ? this.sectionOf(sheet) : undefined;
        if (!sheet || !section) {
            toast("This document has no pages to edit yet.", { kind: "info" });
            return false;
        }
        const wasActive = this.anchor !== null;
        this.anchor = { section, number: sheet.number, edge };
        this.selectedId = null;
        if (!wasActive) {
            this.savedEditable = this.ed.page.host.getAttribute("contenteditable");
            this.ed.page.host.setAttribute("contenteditable", "false");
        }
        this.ed.page.el.setAttribute("data-band-edit", edge);
        this.ed.page.redecorate();
        sheet.el.scrollIntoView({ block: "nearest" });
        announce(`Editing the ${this.label().toLowerCase()} of page ${sheet.number}. Press Escape to close.`);
        this.emit();
        return true;
    }
    exit() {
        if (!this.anchor)
            return;
        this.anchor = null;
        this.selectedId = null;
        this.ed.page.el.removeAttribute("data-band-edit");
        if (this.savedEditable !== null)
            this.ed.page.host.setAttribute("contenteditable", this.savedEditable);
        this.savedEditable = null;
        this.ed.page.redecorate();
        this.ed.refocus();
        announce("Header and footer closed");
        this.emit();
    }
    /** Escape: first let go of the shape, then close. Returns whether it did anything. */
    escape() {
        if (!this.anchor)
            return false;
        if (this.selectedId) {
            this.select(null);
            return true;
        }
        this.exit();
        return true;
    }
    /** The page a command (Insert → Header, Footer) opens the header or footer of: the page of the caret, else the page most in view. */
    pageInView() {
        const sheets = this.ed.page.sheets;
        const caret = this.ed.recallSelection();
        const holder = caret ? this.ed.els.get(caret.start.block)?.closest(".sheet") : null;
        const found = holder ? sheets.findIndex((s) => s.el === holder) : -1;
        if (found >= 0)
            return found;
        const view = this.ed.page.scroller.getBoundingClientRect();
        let best = 0, most = -1;
        sheets.forEach((sheet, i) => {
            const r = sheet.el.getBoundingClientRect();
            const overlap = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top));
            if (overlap > most) {
                best = i;
                most = overlap;
            }
        });
        return best;
    }
    /** A double click in the top or bottom margin of a page opens that header or footer; a double click in the body, while editing, closes it. */
    onDouble = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const sheetEl = target?.closest(".sheet");
        if (!sheetEl || target?.closest(".mline, .guide, .band-hit, .band-handle, button, input"))
            return;
        const index = this.ed.page.sheets.findIndex((s) => s.el === sheetEl);
        const sheet = this.ed.page.sheets[index];
        if (!sheet)
            return;
        const rect = sheetEl.getBoundingClientRect();
        const y = (event.clientY - rect.top) / this.ed.page.zoom / MM_PX;
        const g = sheet.geometry;
        const edge = y < g.margins.top ? "header" : y > g.heightMm - g.margins.bottom ? "footer" : null;
        if (this.anchor) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (edge)
                this.enter(edge, index);
            else
                this.exit();
            return;
        }
        if (!edge || this.ed.readOnly)
            return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.enter(edge, index);
    };
    /* -------------------------------------------------------------------------------------------------------------- selection */
    select(id, options = {}) {
        if (this.selectedId === id) {
            if (id && options.focus)
                this.focusHit();
            return;
        }
        this.selectedId = id;
        this.refocus = Boolean(id) && options.focus !== false;
        this.repaintOverlay();
        this.emit();
    }
    focusHit() {
        const id = this.selectedId;
        if (!id)
            return;
        for (const sheet of this.ed.page.sheets) {
            const hit = sheet.el.querySelector(`.band-hit[data-band-id="${CSS.escape(id)}"]`);
            if (hit) {
                hit.focus({ preventScroll: true });
                return;
            }
        }
    }
    /* --------------------------------------------------------------------------------------------------------------- drawing */
    /** The zones and the boxes of the editing mode, drawn after the page view drew the headers, footers and their shapes. */
    paint() {
        const t = this.active;
        for (const sheet of this.ed.page.sheets)
            sheet.el.querySelector(":scope > .band-edit-layer")?.remove();
        if (!t)
            return;
        for (const sheet of this.ed.page.sheets) {
            const use = this.uses(sheet, t);
            if (use)
                sheet.el.appendChild(this.layerFor(sheet, t, use.mirrored));
        }
        if (this.refocus)
            this.focusHit();
    }
    repaintOverlay() {
        const t = this.active;
        if (!t)
            return;
        for (const sheet of this.ed.page.sheets)
            sheet.el.querySelector(":scope > .band-edit-layer")?.remove();
        for (const sheet of this.ed.page.sheets) {
            const use = this.uses(sheet, t);
            if (use)
                sheet.el.appendChild(this.layerFor(sheet, t, use.mirrored));
        }
        if (this.refocus)
            this.focusHit();
    }
    layerFor(sheet, t, mirrored) {
        const g = sheet.geometry;
        const index = this.ed.page.sheets.indexOf(sheet);
        const layer = h("div", { class: "band-edit-layer", attrs: { "data-band-edit-layer": t.edge, "aria-label": `${this.label()}, page ${sheet.number}`, role: "group" } });
        const zone = h("div", { class: `band-zone ${t.edge}` });
        zone.style.setProperty(t.edge === "header" ? "top" : "bottom", "0");
        zone.style.setProperty("height", `${t.edge === "header" ? g.margins.top : g.margins.bottom}mm`);
        zone.appendChild(h("span", { class: "band-chip", text: `${this.label()} · page ${sheet.number}` }));
        zone.addEventListener("pointerdown", (event) => { if (event.button === 0)
            this.select(null); });
        layer.appendChild(zone);
        for (const item of this.list()) {
            const box = placeBand(item, t.edge, g.widthMm, g.heightMm, g.margins.left, g.margins.right, mirrored);
            const selected = item.id === this.selectedId;
            const hit = h("div", {
                class: "band-hit",
                attrs: {
                    role: "button", tabindex: selected || !this.selectedId ? "0" : "-1", "data-band-id": item.id, "aria-pressed": String(selected),
                    "aria-label": `${item.name ?? item.shape.kind}${item.locked ? " (locked)" : ""}, ${t.edge} shape`,
                },
            });
            if (selected)
                hit.setAttribute("data-selected", "true");
            if (item.locked)
                hit.setAttribute("data-locked", "true");
            this.place(hit, box, item.shape.rotation_deg);
            hit.addEventListener("pointerdown", (event) => this.beginDrag(event, index, item, "move"));
            hit.addEventListener("keydown", (event) => this.onKey(event, index, item));
            hit.addEventListener("focus", () => { if (this.selectedId !== item.id)
                this.select(item.id, { focus: false }); });
            hit.addEventListener("contextmenu", (event) => { event.preventDefault(); this.select(item.id); });
            if (selected && !item.locked && item.shape.rotation_deg % 360 === 0) {
                for (const handle of HANDLES) {
                    if (item.span && (handle.includes("e") || handle.includes("w")))
                        continue; // a shape that spans the margins is as wide as they are
                    const node = h("span", { class: `band-handle ${handle}`, attrs: { "data-handle": handle, "aria-hidden": "true" } });
                    node.addEventListener("pointerdown", (event) => this.beginDrag(event, index, item, handle));
                    hit.appendChild(node);
                }
            }
            layer.appendChild(hit);
        }
        return layer;
    }
    place(node, box, rotation) {
        node.style.setProperty("left", `${box.x}mm`);
        node.style.setProperty("top", `${box.y}mm`);
        node.style.setProperty("width", `${box.w}mm`);
        node.style.setProperty("height", `${box.h}mm`);
        node.style.setProperty("transform", rotation ? `rotate(${rotation}deg)` : "none");
    }
    /* ------------------------------------------------------------------------------------------------------- pointer: move, resize */
    beginDrag(event, sheetIndex, item, mode) {
        if (event.button !== 0 || this.dragging)
            return;
        const t = this.active;
        const sheet = this.ed.page.sheets[sheetIndex];
        if (!t || !sheet)
            return;
        event.preventDefault();
        event.stopPropagation();
        if (this.selectedId !== item.id) {
            this.selectedId = item.id;
            this.repaintOverlay();
            this.emit();
        }
        if (item.locked) {
            announce("This shape is locked. Unlock it to move or resize it.");
            return;
        }
        const use = this.uses(sheet, t);
        if (!use)
            return;
        const g = sheet.geometry;
        const box0 = placeBand(item, t.edge, g.widthMm, g.heightMm, g.margins.left, g.margins.right, use.mirrored);
        const startX = event.clientX, startY = event.clientY;
        const scale = this.ed.page.zoom * MM_PX;
        let current = { item, box: box0 };
        let moved = false;
        this.dragging = true;
        const compute = (move) => {
            let dx = (move.clientX - startX) / scale, dy = (move.clientY - startY) / scale;
            let { x, y, w, h: ht } = box0;
            if (mode === "move") {
                if (move.shiftKey) {
                    if (Math.abs(dx) > Math.abs(dy))
                        dy = 0;
                    else
                        dx = 0;
                }
                if (!item.span)
                    x = box0.x + dx;
                y = box0.y + dy;
            }
            else {
                if (item.span)
                    dx = 0;
                if (mode.includes("e"))
                    w = Math.max(MIN_MM, box0.w + dx);
                if (mode.includes("w")) {
                    w = Math.max(MIN_MM, box0.w - dx);
                    x = box0.x + box0.w - w;
                }
                if (mode.includes("s"))
                    ht = Math.max(MIN_MM, box0.h + dy);
                if (mode.includes("n")) {
                    ht = Math.max(MIN_MM, box0.h - dy);
                    y = box0.y + box0.h - ht;
                }
                if (move.shiftKey && mode.length === 2 && !item.span) { // a corner with Shift keeps the proportions
                    ht = Math.max(MIN_MM, w * box0.h / box0.w);
                    if (mode.includes("n"))
                        y = box0.y + box0.h - ht;
                }
                w = Math.min(1000, w);
                ht = Math.min(1000, ht);
            }
            const shape = mode === "move" ? item.shape : resizeShape(item.shape, item.span ? Number(item.shape.width_mm) : w, ht);
            const next = { ...item, shape };
            const stored = storedFromBox(next, t.edge, x, y, g.widthMm, g.heightMm, g.margins.left, g.margins.right, use.mirrored);
            return { item: { ...next, x_mm: item.span ? item.x_mm : stored.x_mm, y_mm: stored.y_mm }, box: { x, y, w: item.span ? box0.w : w, h: ht } };
        };
        const show = (state) => {
            for (const other of this.ed.page.sheets) {
                const u = this.uses(other, t);
                if (!u)
                    continue;
                const og = other.geometry;
                const at = placeBand(state.item, t.edge, og.widthMm, og.heightMm, og.margins.left, og.margins.right, u.mirrored);
                const rotation = state.item.shape.rotation_deg;
                const selector = `[data-band-id="${CSS.escape(item.id)}"]`;
                const drawn = other.el.querySelector(`.band-shape${selector}`);
                if (drawn) {
                    this.place(drawn, at, 0);
                    const inner = drawn.firstElementChild;
                    if (inner) {
                        inner.style.width = `${at.w}mm`;
                        inner.style.height = `${at.h}mm`;
                    }
                }
                const hit = other.el.querySelector(`.band-hit${selector}`);
                if (hit)
                    this.place(hit, at, rotation);
            }
        };
        const onMove = (move) => {
            if (move.pointerId !== event.pointerId)
                return;
            if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < 3)
                return;
            moved = true;
            move.preventDefault();
            current = compute(move);
            show(current);
        };
        const finish = (up, commit) => {
            if (up.pointerId !== event.pointerId)
                return;
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            this.dragging = false;
            if (!moved) {
                this.refocus = true;
                this.focusHit();
                return;
            }
            if (!commit) {
                show({ item, box: box0 });
                return;
            }
            const final = current.item;
            this.refocus = true;
            void this.queued(async () => {
                const live = this.list().find((i) => i.id === item.id) ?? item;
                const sent = { id: item.id, x_mm: final.x_mm, y_mm: final.y_mm };
                if (mode !== "move")
                    sent["shape"] = resizeShape(live.shape, Number(final.shape.width_mm), Number(final.shape.height_mm));
                return this.sendNow({ op: "band_shape_set", ...this.where(), item: sent, label: mode === "move" ? "move header or footer shape" : "resize header or footer shape" });
            });
        };
        const onUp = (up) => finish(up, true);
        const onCancel = (up) => finish(up, false);
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
    }
    /* ----------------------------------------------------------------------------------------------------------------- keyboard */
    onKey(event, sheetIndex, item) {
        const mod = event.ctrlKey || event.metaKey;
        const stop = () => { event.preventDefault(); event.stopPropagation(); };
        if (mod && event.key.toLowerCase() === "z") {
            stop();
            void A.undoRedo(this.ed, event.shiftKey ? "redo" : "undo");
            return;
        }
        if (mod && event.key.toLowerCase() === "y") {
            stop();
            void A.undoRedo(this.ed, "redo");
            return;
        }
        if (mod && event.key.toLowerCase() === "d") {
            stop();
            void this.duplicate();
            return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
            stop();
            void this.remove();
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            stop();
            this.select(item.id);
            return;
        }
        const step = event.shiftKey ? 5 * NUDGE_MM : event.altKey ? 0.1 : NUDGE_MM;
        const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        const move = arrows[event.key];
        if (!move)
            return;
        stop();
        if (item.locked) {
            toast("This shape is locked. Unlock it to move it.", { kind: "info" });
            return;
        }
        this.refocus = true;
        // Each press starts from the shape the previous one left (they are sent one after the other), so quick presses add up.
        void this.queued(async () => {
            const t = this.active, sheet = this.ed.page.sheets[sheetIndex];
            const live = this.list().find((i) => i.id === item.id);
            const use = t && sheet ? this.uses(sheet, t) : null;
            if (!t || !sheet || !use || !live || live.locked)
                return false;
            const g = sheet.geometry;
            const box = placeBand(live, t.edge, g.widthMm, g.heightMm, g.margins.left, g.margins.right, use.mirrored);
            const stored = storedFromBox(live, t.edge, box.x + (live.span ? 0 : move[0]), box.y + move[1], g.widthMm, g.heightMm, g.margins.left, g.margins.right, use.mirrored);
            return this.sendNow({ op: "band_shape_set", ...this.where(), item: { id: live.id, ...(live.span ? {} : { x_mm: stored.x_mm }), y_mm: stored.y_mm }, label: "move header or footer shape" });
        });
    }
    /* ----------------------------------------------------------------------------------------------------------------- changes */
    where() {
        const t = this.active;
        if (!t)
            throw new Error("No header or footer is being edited.");
        return { section: t.section, edge: t.edge, variant: t.variant };
    }
    /** One change after the other: a change that rewrites the shape starts from the shape the previous change left, not from one the page has not heard of yet. */
    tail = Promise.resolve();
    queued(task) {
        const run = this.tail.then(task, task);
        this.tail = run.catch(() => undefined);
        return run;
    }
    async sendNow(op) {
        try {
            await this.ed.op(op);
            return true;
        }
        catch (error) {
            toast(errorText(error), { kind: "error" });
            this.repaintOverlay();
            return false;
        }
    }
    send(op) { return this.queued(() => this.sendNow(op)); }
    /** Change fields of the selected shape (the position, the layer, locked, span, its name) in one operation. */
    async change(fields, label = "header or footer shape") {
        const item = this.selected;
        if (!item || !this.active)
            return false;
        this.refocus = false;
        return this.send({ op: "band_shape_set", ...this.where(), item: { id: item.id, ...fields }, label });
    }
    /** Change the shape itself (fill, outline, size, text ...): ``mutate`` is given a copy. */
    changeShape(mutate, label = "header or footer shape formatting") {
        const id = this.selectedId;
        return this.queued(async () => {
            const item = this.list().find((i) => i.id === id);
            if (!item || !this.active)
                return false;
            const shape = structuredClone(item.shape);
            mutate(shape);
            return this.sendNow({ op: "band_shape_set", ...this.where(), item: { id: item.id, shape }, label });
        });
    }
    async order(to) {
        const item = this.selected;
        if (!item || !this.active)
            return false;
        return this.send({ op: "band_shape_order", ...this.where(), id: item.id, to, label: "arrange header or footer shape" });
    }
    async duplicate() {
        const item = this.selected;
        if (!item || !this.active)
            return false;
        const id = newBandId(this.ed.model.meta);
        this.selectedId = id;
        this.refocus = true;
        const ok = await this.send({ op: "band_shape_duplicate", ...this.where(), id: item.id, new_id: id, dx_mm: 5, dy_mm: 5 });
        if (!ok)
            this.selectedId = item.id;
        return ok;
    }
    async remove() {
        const item = this.selected;
        if (!item || !this.active)
            return false;
        if (item.locked) {
            toast("This shape is locked. Unlock it to delete it.", { kind: "info" });
            return false;
        }
        this.selectedId = null;
        const ok = await this.send({ op: "band_shape_delete", ...this.where(), ids: [item.id] });
        if (!ok)
            this.selectedId = item.id;
        else {
            this.emit();
            announce("Shape deleted");
        }
        return ok;
    }
    /** Put a new shape in the header or footer being edited. ``at`` is where its top-left corner goes, in millimetres on the sheet at ``sheetIndex``; without it the
     *  shape is centred in the band of the first page that shows it. */
    async add(shape, at) {
        const t = this.active;
        if (!t)
            return false;
        if (this.list().length >= MAX_BAND_ITEMS) {
            toast(`A header or footer holds at most ${MAX_BAND_ITEMS} shapes.`, { kind: "info" });
            return false;
        }
        const sheets = this.ed.page.sheets;
        let sheet = at ? sheets[at.sheetIndex] : undefined;
        let use = sheet ? this.uses(sheet, t) : null;
        if (!sheet || !use) {
            if (at) {
                toast("That page shows a different header or footer. Place the shape on a highlighted page.", { kind: "info" });
                return false;
            }
            sheet = sheets.find((s) => this.uses(s, t));
            use = sheet ? this.uses(sheet, t) : null;
            if (!sheet || !use)
                return false;
        }
        const g = sheet.geometry;
        const frame = g.widthMm - g.margins.left - g.margins.right;
        const sized = structuredClone(shape);
        const clean = resizeShape(sized, Math.min(sized.width_mm, Math.max(MIN_MM, frame)), sized.height_mm); // padding and corners keep to the size the shape got
        delete clean.layout;
        delete clean.group_id;
        const x = at ? at.xMm : g.margins.left + (frame - clean.width_mm) / 2;
        const bandTop = t.edge === "header" ? Math.max(0, g.headerMm) : g.heightMm - Math.max(0, g.footerMm) - clean.height_mm;
        const y = at ? at.yMm : bandTop;
        const id = newBandId(this.ed.model.meta);
        const stored = storedFromBox({ shape: clean, span: false }, t.edge, x, y, g.widthMm, g.heightMm, g.margins.left, g.margins.right, use.mirrored);
        this.selectedId = id;
        this.refocus = true;
        const ok = await this.send({ op: "band_shape_set", ...this.where(), item: { id, shape: clean, x_mm: stored.x_mm, y_mm: stored.y_mm, layer: "front", locked: false, span: false }, label: "insert header or footer shape" });
        if (!ok)
            this.selectedId = null;
        else
            announce(`${clean.kind} added to the ${this.label().toLowerCase()}`);
        return ok;
    }
    /** "Different first page", and linking this section's header or footer shapes to the previous section's. */
    async config(fields) {
        const t = this.active;
        if (!t)
            return false;
        const op = { op: "band_config", section: t.section, label: "header and footer shapes" };
        if (fields.first_page !== undefined)
            op["first_page"] = fields.first_page;
        if (fields.link !== undefined)
            op["link"] = { [t.edge]: fields.link };
        return this.send(op);
    }
    /** Different odd and even pages for this section (the setting the Header and footer dialog has). */
    async oddEven(on) {
        const t = this.active;
        if (!t)
            return false;
        return this.send(on
            ? { op: "page_layout", scope: "sections", sections: [t.section], odd_even: true, label: "odd and even header and footer" }
            : { op: "page_layout", scope: "sections", sections: [t.section], odd_even: null, header_even: null, footer_even: null, label: "odd and even header and footer" });
    }
    /** Whether this section's shapes are the previous section's, whether its first page has its own, and whether it has odd and even pages. */
    options() {
        const t = this.active;
        const meta = this.ed.model.meta;
        if (!t)
            return { first_page: false, linked: false, canLink: false, odd_even: false };
        const ext = (meta.extensions?.["slai.writer"] ?? {});
        const entry = ext.band_shapes?.[t.section];
        const ids = (meta.sections ?? []).map((s) => s.id);
        return { first_page: entry?.first_page === true, linked: entry?.link?.[t.edge] === true, canLink: ids.indexOf(t.section) > 0, odd_even: ext.book_layouts?.[t.section]?.odd_even === true };
    }
}
