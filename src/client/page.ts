/** The page view: sheets laid out at physical size, rulers, margin lines, guides, headers and footers, zoom and pagination.
 *
 *  Pagination is deliberately block-granular: a block moves to the next sheet when it does not fit, and a paragraph is never split in
 *  the middle. The exact page count of a printed or exported document comes from the PDF preview (Documaster's own layout), so the
 *  page count shown here is an approximation, and the status bar says so. */
import { h, s, glyph } from "./kit.js";
import { MM_PX, roman } from "./textops.js";
import type { PageGeometry } from "./model.js";
import type { GuideSet, HeaderFooter, Margins } from "./types.js";

export interface LayoutBlock { id: string; el: HTMLElement; section: string | undefined; pageBreak?: boolean; footnotes: Array<{ n: number; text: string }> }

export interface LayoutInput {
  blocks: LayoutBlock[];
  geometry(section?: string): PageGeometry;
  title: string;
  guides: GuideSet;
  background: string | undefined;
  showMargins: boolean;
  showGuides: boolean;
  showRulers: boolean;
  /** The unit the ruler readouts use. */
  unit?: "mm" | "in";
}

export interface PageEvents {
  rulerDouble(): void;
  pageDouble(section: string | undefined, xMm: number, yMm: number): void;
  margin(section: string | undefined, side: keyof Margins, mm: number): void;
  /** Where the header or the footer text sits: millimetres from the top edge (header) or the bottom edge (footer) of the page. */
  band(section: string | undefined, edge: "header" | "footer", mm: number): void;
  guideMove(axis: "v" | "h", index: number, mm: number | null): void;
}

export interface Sheet {
  el: HTMLElement; body: HTMLElement; foot: HTMLElement; geometry: PageGeometry; capacity: number; blocks: HTMLElement[]; section: string | undefined; number: number;
}

const NUMBER_FORMATS: Record<string, (n: number) => string> = {
  decimal: (n) => String(n), "lower-roman": (n) => roman(n), "upper-roman": (n) => roman(n).toUpperCase(),
  "lower-alpha": (n) => alpha(n), "upper-alpha": (n) => alpha(n).toUpperCase(),
};
function alpha(n: number): string { let out = ""; let v = Math.max(1, n); while (v > 0) { v -= 1; out = String.fromCharCode(97 + (v % 26)) + out; v = Math.floor(v / 26); } return out; }

export function formatPageNumber(n: number, format: string | undefined): string { return (NUMBER_FORMATS[format ?? "decimal"] ?? NUMBER_FORMATS["decimal"] as (n: number) => string)(n); }

export interface NumberedSheet { section?: string; role?: string; numbering?: { start?: number; format?: string; show?: boolean } }

/** Printed numbers are distinct from physical pages and derived from section semantics. */
export function printedPageNumbers(sheets: NumberedSheet[]): Array<string | null> {
  let current = 0;
  let previousSection: string | undefined;
  return sheets.map((sheet) => {
    const config = sheet.numbering ?? {};
    if (sheet.role === "cover" || config.show === false) {
      previousSection = sheet.section;
      return null;
    }
    if (sheet.section !== previousSection && config.start !== undefined) current = config.start - 1;
    previousSection = sheet.section;
    current += 1;
    return formatPageNumber(current, config.format);
  });
}

export function fillTemplate(text: string, values: { page: string; pages: string; title: string }): string {
  return text.replace(/\{\{|\}\}|\{page\}|\{pages\}|\{title\}/g, (m) => m === "{{" ? "{" : m === "}}" ? "}" : m === "{page}" ? values.page : m === "{pages}" ? values.pages : values.title);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
}

const RULER = 18;
/** A margin may never squeeze the writing area below this (the .sldc format needs at least 20 mm; this leaves room to type). */
const MIN_BODY = 30;
/** The lines the user can move: the four margins and where the header and footer text sit. */
type LineKind = "left" | "right" | "top" | "bottom" | "header" | "footer";
interface LineSpec { kind: LineKind; axis: "v" | "h"; mm: number; name: string; min: number; max: number }
const LINE_CLASS: Record<LineKind, string> = { left: "outer", right: "outer", top: "outer", bottom: "outer", header: "hf", footer: "hf" };
const clampMm = (mm: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.max(lo, hi), mm));

export class PageView {
  readonly el: HTMLElement;
  readonly scroller: HTMLElement;
  /** The single editable root: every sheet, and every block in it, lives inside this element. */
  readonly host: HTMLElement;
  private readonly zoomer: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly hruler: HTMLElement;
  /** Behind the pages and scaled with them: the layer for everything attached to a page (its tabs and panels grow out from behind the page). Coordinates are in unscaled page units. */
  readonly layer: HTMLElement;
  /** In front of the pages and scaled with them (page units): the handles and toolbar of the picture being edited. */
  readonly overlay: HTMLElement;
  private readonly placeListeners: Array<() => void> = [];
  /** The two corner cells at the ends of the ruler row: the application panels' arrows live there. */
  readonly cornerLeft: HTMLElement;
  readonly cornerRight: HTMLElement;
  /** Called after sheets were laid out, reflowed, decorated or zoomed: the attachments reposition themselves. */
  onPlace: (() => void) | null = null;
  /** The vertical ruler strip, as in Word and Canva: a bar along the left edge of the page area (right next to the left application panel, so it moves with that panel) that always stays visible; the scale of each page slides along it as the pages scroll and rescales with the zoom. */
  private readonly vlayer: HTMLElement;
  private vrulers: Array<{ wrap: HTMLElement; sheet: Sheet }> = [];
  private placed(): void { this.placeVRulers(); this.onPlace?.(); for (const fn of this.placeListeners) fn(); }
  /** Called whenever the sheets are laid out, redrawn or zoomed (the picture tools follow the picture). */
  onPlaced(fn: () => void): void { this.placeListeners.push(fn); }
  private room = { left: 0, right: 0 };
  /** The number that shows beside a ruler while a margin, header, footer or guide line is hovered, focused or dragged. */
  private readonly readout: HTMLElement;
  private readonly locked: boolean;
  private unit: "mm" | "in" = "mm";
  private dragging = false;
  /** Set while a line is moved with the keyboard, so the redraw that follows each step gives the focus back to it. */
  private pendingFocus: { where: "page" | "h" | "v"; sheet: number; kind: string } | null = null;
  private rulerSvg: SVGSVGElement | null = null;
  sheets: Sheet[] = [];
  zoom = 1;
  private last: LayoutInput | null = null;
  private headerFooter: (section: string | undefined) => { header?: HeaderFooter; footer?: HeaderFooter; role?: string; numbering?: { start?: number; format?: string; show?: boolean } } = () => ({});

  constructor(private readonly events: PageEvents, editable: string) {
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
    new ResizeObserver(() => { this.fit(); this.placeRuler(); this.placed(); }).observe(this.scroller);
    this.hruler.addEventListener("dblclick", () => events.rulerDouble());
    this.host.addEventListener("dblclick", (e) => this.onDouble(e));
  }

  setHeaderFooter(fn: typeof this.headerFooter): void { this.headerFooter = fn; }

  /* ------------------------------------------------------------------------------------------------- layout */
  layout(input: LayoutInput): void {
    const keep = this.lineFocus();
    this.last = input;
    this.unit = input.unit ?? "mm";
    this.host.replaceChildren();
    this.sheets = [];
    let current: Sheet | null = null;
    let section: string | undefined;
    const open = (sec: string | undefined): Sheet => {
      const sheet = this.newSheet(input, sec, this.sheets.length + 1);
      this.sheets.push(sheet);
      this.host.appendChild(sheet.el);
      section = sec;
      return sheet;
    };
    for (const block of input.blocks) {
      if (!current || block.section !== section || (block.pageBreak && current.blocks.length > 0)) current = open(block.section);
      this.place(current, block);
      const sheet: Sheet = current;
      if (sheet.blocks.length > 1 && sheet.body.scrollHeight > sheet.capacity + 1) {
        this.unplace(sheet, block);
        current = open(block.section);
        this.place(current, block);
      }
    }
    if (!this.sheets.length) open(undefined);
    this.decorate(input);
    this.fit();
    this.placed();
    this.restoreLineFocus(keep);
  }

  private newSheet(input: LayoutInput, section: string | undefined, number: number): Sheet {
    const geometry = input.geometry(section);
    const wPx = geometry.widthMm * MM_PX;
    const hPx = geometry.heightMm * MM_PX;
    const m = geometry.margins;
    const capacity = (geometry.heightMm - m.top - m.bottom) * MM_PX;
    const body = h("div", { class: "body" });
    body.style.setProperty("height", `${capacity}px`);
    body.style.setProperty("margin", `${m.top * MM_PX}px ${m.right * MM_PX}px ${m.bottom * MM_PX}px ${m.left * MM_PX}px`);
    const foot = h("div", { class: "foot", attrs: { contenteditable: "false", role: "doc-endnotes", "aria-label": "Footnotes" } });
    body.appendChild(foot);
    const el = h("section", { class: "sheet", data: { page: String(number), section: section ?? "" }, attrs: { "aria-label": `Page ${number}` } });
    el.style.setProperty("width", `${wPx}px`);
    el.style.setProperty("height", `${hPx}px`);
    if (input.background) {
      el.style.setProperty("background-color", input.background);
      el.style.setProperty("--page-ink", luminance(input.background) < 0.35 ? "#f4f4f4" : "#1b1b1b");
    }
    el.appendChild(body);
    return { el, body, foot, geometry, capacity, blocks: [], section, number };
  }

  private place(sheet: Sheet, block: LayoutBlock): void {
    sheet.body.insertBefore(block.el, sheet.foot);
    sheet.blocks.push(block.el);
    for (const note of block.footnotes) {
      const row = h("p", { class: "fn-row", data: { n: String(note.n), owner: block.id } }, h("sup", { text: String(note.n) }), " ", note.text);
      sheet.foot.appendChild(row);
    }
    sheet.foot.toggleAttribute("data-has", sheet.foot.childElementCount > 0);
  }

  private unplace(sheet: Sheet, block: LayoutBlock): void {
    sheet.body.removeChild(block.el);
    sheet.blocks.pop();
    for (let i = 0; i < block.footnotes.length; i += 1) sheet.foot.lastElementChild?.remove();
    sheet.foot.toggleAttribute("data-has", sheet.foot.childElementCount > 0);
  }

  /* ------------------------------------------------------------------------------------------------- reflow */
  private rows(sheet: Sheet, owner: string): HTMLElement[] { return Array.from(sheet.foot.children).filter((r): r is HTMLElement => r instanceof HTMLElement && r.dataset["owner"] === owner); }

  private move(from: Sheet, to: Sheet, el: HTMLElement, atStart: boolean): void {
    const id = el.dataset["id"] ?? "";
    const notes = this.rows(from, id);
    from.blocks.splice(from.blocks.indexOf(el), 1);
    if (atStart) { to.body.insertBefore(el, to.blocks[0] ?? to.foot); to.blocks.unshift(el); } else { to.body.insertBefore(el, to.foot); to.blocks.push(el); }
    for (const row of notes) { if (atStart) to.foot.insertBefore(row, to.foot.firstChild); else to.foot.appendChild(row); }
    from.foot.toggleAttribute("data-has", from.foot.childElementCount > 0);
    to.foot.toggleAttribute("data-has", to.foot.childElementCount > 0);
  }

  private overflows(sheet: Sheet): boolean { return sheet.body.scrollHeight > sheet.capacity + 1; }

  /** Height still free on a sheet: capacity minus the bottom of its last block and its footnote strip. */
  private freeSpace(sheet: Sheet): number {
    const last = sheet.blocks[sheet.blocks.length - 1];
    const bottom = last ? last.offsetTop + last.offsetHeight : 0;
    return sheet.capacity - bottom - (sheet.foot.childElementCount ? sheet.foot.offsetHeight : 0);
  }

  /** Cheap relayout after a text edit: push overflow forward, pull blocks back when they fit, drop empty sheets.
   *  Returns true when the number of sheets changed (the caller then redraws headers, footers and numbers). */
  reflow(): boolean {
    const input = this.last;
    if (!input || !this.sheets.length) return false;
    const before = this.sheets.length;
    for (let i = 0; i < this.sheets.length; i += 1) {
      const sheet = this.sheets[i] as Sheet;
      let guard = 0;
      while (sheet.blocks.length > 1 && this.overflows(sheet) && guard++ < 500) {
        let next = this.sheets[i + 1];
        const el = sheet.blocks[sheet.blocks.length - 1] as HTMLElement;
        if (!next || next.section !== sheet.section) {
          next = this.newSheet(input, sheet.section, i + 2);
          this.sheets.splice(i + 1, 0, next);
          sheet.el.after(next.el);
        }
        this.move(sheet, next, el, true);
      }
      const next = this.sheets[i + 1];
      guard = 0;
      while (next && next.section === sheet.section && next.blocks.length && guard++ < 500) {
        const first = next.blocks[0] as HTMLElement;
        if (first.dataset["break"] !== undefined) break;
        const need = first.offsetHeight + this.rows(next, first.dataset["id"] ?? "").reduce((sum, r) => sum + r.offsetHeight, 0);
        if (need > this.freeSpace(sheet) - 1) break;
        this.move(next, sheet, first, false);
        if (this.overflows(sheet)) { this.move(sheet, next, first, true); break; }
      }
    }
    for (let i = this.sheets.length - 1; i > 0; i -= 1) {
      const sheet = this.sheets[i] as Sheet;
      if (!sheet.blocks.length) { sheet.el.remove(); this.sheets.splice(i, 1); }
    }
    this.sheets.forEach((sheet, i) => { sheet.number = i + 1; });
    const changed = this.sheets.length !== before;
    this.fit();
    this.placed();
    return changed;
  }

  /** Redraw headers, footers, page numbers, margin lines, guides and rulers without moving any block. */
  redecorate(): void {
    const input = this.last;
    if (!input) return;
    const keep = this.lineFocus();
    for (const sheet of this.sheets) {
      for (const extra of Array.from(sheet.el.children)) if (extra !== sheet.body) extra.remove();
    }
    this.decorate(input);
    this.placed();
    this.restoreLineFocus(keep);
  }

  /** Moving a line with the arrow keys redraws the page; the focus has to stay on the line (or ruler handle) being moved. */
  holdsLineFocus(): boolean { return this.pendingFocus !== null || (document.activeElement instanceof Element && document.activeElement.hasAttribute("data-kind")); }

  private lineFocus(): { where: "page" | "h" | "v"; sheet: number; kind: string } | null {
    if (this.pendingFocus) return this.pendingFocus;
    const active = document.activeElement;
    if (!(active instanceof Element) || !active.hasAttribute("data-kind")) return null;
    const kind = active.getAttribute("data-kind") ?? "";
    const sheetEl = active.closest(".sheet");
    if (sheetEl) return { where: "page", sheet: this.sheets.findIndex((x) => x.el === sheetEl), kind };
    if (this.hruler.contains(active)) return { where: "h", sheet: 0, kind };
    const v = this.vrulers.findIndex((x) => x.wrap.contains(active));
    return v >= 0 ? { where: "v", sheet: v, kind } : null;
  }

  private restoreLineFocus(keep: { where: "page" | "h" | "v"; sheet: number; kind: string } | null): void {
    this.pendingFocus = null;
    if (!keep || keep.sheet < 0) return;
    const root = keep.where === "page" ? this.sheets[keep.sheet]?.el : keep.where === "h" ? this.hruler : this.vrulers[keep.sheet]?.wrap;
    root?.querySelector<HTMLElement | SVGElement>(`[data-kind="${keep.kind}"]`)?.focus({ preventScroll: true });
  }

  /** Headers, footers, margin lines, guides and vertical rulers: all drawn per sheet once the page count is known. */
  private decorate(input: LayoutInput): void {
    const pages = this.sheets.length;
    const labels = printedPageNumbers(this.sheets.map((sheet) => ({ section: sheet.section, ...this.headerFooter(sheet.section) })));
    this.sheets.forEach((sheet, i) => {
      const hf = this.headerFooter(sheet.section);
      const printed = labels[i] ?? null;
      sheet.el.dataset["printed"] = printed ?? "";
      const values = { page: printed ?? "", pages: String(pages), title: input.title };
      const m = sheet.geometry.margins;
      const band = (edge: "header" | "footer", spec: HeaderFooter | undefined): HTMLElement | null => {
        if (!spec || (!spec.left && !spec.center && !spec.right)) return null;
        const row = h("div", { class: `hf ${edge}`, attrs: { contenteditable: "false", "data-edge": edge } },
          h("span", { class: "l", text: fillTemplate(spec.left ?? "", values) }), h("span", { class: "c", text: fillTemplate(spec.center ?? "", values) }), h("span", { class: "r", text: fillTemplate(spec.right ?? "", values) }));
        row.style.setProperty(edge === "header" ? "top" : "bottom", `${(edge === "header" ? sheet.geometry.headerMm : sheet.geometry.footerMm) * MM_PX}px`);
        row.style.setProperty("left", `${m.left * MM_PX}px`);
        row.style.setProperty("right", `${m.right * MM_PX}px`);
        return row;
      };
      // Hiding the printed number must not remove unrelated header/footer text.
      // The explicitly designated cover, however, starts with empty page bands.
      const extras: Array<HTMLElement | null> = hf.role === "cover" ? [] : [band("header", hf.header), band("footer", hf.footer)];
      if (printed !== null) extras.push(h("div", { class: "page-no", attrs: { contenteditable: "false", "aria-hidden": "true" }, text: printed }));
      if (input.showMargins) extras.push(this.marginLines(sheet));
      if (input.showGuides) extras.push(this.guideLines(sheet, input.guides));
      for (const e of extras) if (e) sheet.el.appendChild(e);
      sheet.el.setAttribute("aria-label", `Page ${i + 1} of ${pages}`);
    });
    this.vlayer.replaceChildren();
    this.vrulers = input.showRulers ? this.sheets.map((sheet) => ({ wrap: this.verticalRuler(sheet), sheet })) : [];
    for (const v of this.vrulers) this.vlayer.appendChild(v.wrap);
    this.drawRuler(input);
    this.placeVRulers();
  }

  /** Each page's scale is placed at that page's current position on screen; the strip clips what is out of view. */
  private placeVRulers(): void {
    if (!this.vrulers.length) return;
    const origin = this.vlayer.getBoundingClientRect();
    const z = this.zoom;
    for (const { wrap, sheet } of this.vrulers) {
      const r = sheet.el.getBoundingClientRect();
      wrap.style.setProperty("top", `${Math.round(r.top - origin.top)}px`);
      wrap.style.setProperty("transform", `scaleY(${z})`);
    }
  }

  /* ------------------------------------------------------------------------------------------------- movable lines */
  private spec(sheet: Sheet, kind: LineKind): LineSpec {
    const g = sheet.geometry;
    const m = g.margins;
    const W = g.widthMm;
    const H = g.heightMm;
    switch (kind) {
      case "left": return { kind, axis: "v", mm: m.left, name: "Left margin", min: 0, max: W - m.right - MIN_BODY };
      case "right": return { kind, axis: "v", mm: W - m.right, name: "Right margin", min: m.left + MIN_BODY, max: W };
      case "top": return { kind, axis: "h", mm: m.top, name: "Top margin", min: 0, max: H - m.bottom - MIN_BODY };
      case "bottom": return { kind, axis: "h", mm: H - m.bottom, name: "Bottom margin", min: m.top + MIN_BODY, max: H };
      case "header": return { kind, axis: "h", mm: g.headerMm, name: "Header", min: 0, max: H - g.footerMm - MIN_BODY };
      default: return { kind, axis: "h", mm: H - g.footerMm, name: "Footer", min: g.headerMm + MIN_BODY, max: H };
    }
  }

  private commit(sheet: Sheet, kind: LineKind, mm: number): void {
    const g = sheet.geometry;
    const value = Math.round(mm * 2) / 2;
    if (kind === "left" || kind === "top") this.events.margin(sheet.section, kind, value);
    else if (kind === "right") this.events.margin(sheet.section, "right", g.widthMm - value);
    else if (kind === "bottom") this.events.margin(sheet.section, "bottom", g.heightMm - value);
    else if (kind === "header") this.events.band(sheet.section, "header", value);
    else this.events.band(sheet.section, "footer", g.heightMm - value);
  }

  private fmt(mm: number): string { return this.unit === "in" ? `${(mm / 25.4).toFixed(2)} in` : `${Number(mm.toFixed(1))} mm`; }

  /** The number beside the ruler: along the top ruler for a vertical line, along the left strip for a horizontal one. */
  private showReadout(sheet: Sheet, axis: "v" | "h", mm: number, name: string): void {
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
    } else {
      o.style.setProperty("top", `${Math.round(clampMm(r.top - area.top + at, 50, area.height - 12))}px`);
      o.style.setProperty("left", "34px");
    }
  }

  private hideReadout(): void { if (!this.dragging) this.readout.hidden = true; }

  /** Everything that shows one line follows it while it is dragged: the line on the page, its ruler handle, and the header or footer text. */
  private preview(sheet: Sheet, spec: LineSpec, mm: number): void {
    const px = `${mm * MM_PX}px`;
    const line = sheet.el.querySelector<HTMLElement>(`.mline[data-kind="${spec.kind}"]`);
    line?.style.setProperty(spec.axis === "v" ? "left" : "top", px);
    line?.setAttribute("aria-valuenow", String(mm));
    if (spec.kind === "header") sheet.el.querySelector<HTMLElement>(".hf.header")?.style.setProperty("top", px);
    if (spec.kind === "footer") sheet.el.querySelector<HTMLElement>(".hf.footer")?.style.setProperty("bottom", `${(sheet.geometry.heightMm - mm) * MM_PX}px`);
    const root = spec.axis === "v" ? (sheet === this.sheets[0] ? this.hruler : null) : this.vrulers.find((x) => x.sheet === sheet)?.wrap ?? null;
    root?.querySelector(`.mhandle[data-kind="${spec.kind}"]`)?.setAttribute(spec.axis === "v" ? "x" : "y", String(mm * MM_PX - 3));
    this.showReadout(sheet, spec.axis, mm, spec.name);
  }

  private startDrag(e: PointerEvent, capture: Element, sheet: Sheet, kind: LineKind): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.locked) return;
    const spec = this.spec(sheet, kind);
    capture.setPointerCapture(e.pointerId);
    const rect = sheet.el.getBoundingClientRect();
    const toMm = (ev: PointerEvent): number => clampMm(Math.round(((spec.axis === "v" ? ev.clientX - rect.left : ev.clientY - rect.top) / this.zoom / MM_PX) * 2) / 2, spec.min, spec.max);
    this.dragging = true;
    const move = (ev: PointerEvent): void => this.preview(sheet, spec, toMm(ev));
    const end = (ev: PointerEvent, apply: boolean): void => {
      capture.removeEventListener("pointermove", move as EventListener);
      capture.removeEventListener("pointerup", up as EventListener);
      capture.removeEventListener("pointercancel", cancel as EventListener);
      this.dragging = false;
      this.hideReadout();
      const mm = apply ? toMm(ev) : spec.mm;
      if (mm === spec.mm) { this.preview(sheet, spec, spec.mm); this.hideReadout(); } else this.commit(sheet, kind, mm);
    };
    const up = (ev: PointerEvent): void => end(ev, true);
    const cancel = (ev: PointerEvent): void => end(ev, false);
    capture.addEventListener("pointermove", move as EventListener);
    capture.addEventListener("pointerup", up as EventListener);
    capture.addEventListener("pointercancel", cancel as EventListener);
    this.preview(sheet, spec, spec.mm);
  }

  /** Arrow keys move a line by half a millimetre (five with Shift), Home and End go to the limits. */
  private nudge(e: KeyboardEvent, sheet: Sheet, kind: LineKind): void {
    const spec = this.spec(sheet, kind);
    const step = e.shiftKey ? 5 : 0.5;
    const back = spec.axis === "v" ? "ArrowLeft" : "ArrowUp";
    const forward = spec.axis === "v" ? "ArrowRight" : "ArrowDown";
    let mm: number | null = null;
    if (e.key === back) mm = spec.mm - step; else if (e.key === forward) mm = spec.mm + step; else if (e.key === "Home") mm = spec.min; else if (e.key === "End") mm = spec.max;
    if (mm === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.locked) return;
    mm = clampMm(mm, spec.min, spec.max);
    if (mm === spec.mm) return;
    const on = e.currentTarget instanceof Element ? e.currentTarget : null;
    const where = on && this.hruler.contains(on) ? "h" : on && on.closest(".vruler") ? "v" : "page";
    this.pendingFocus = { where, sheet: where === "v" ? Math.max(0, this.vrulers.findIndex((x) => x.sheet === sheet)) : this.sheets.indexOf(sheet), kind };
    this.commit(sheet, kind, mm);
    window.setTimeout(() => { this.pendingFocus = null; }, 3000);   // the step failed or changed nothing: do not keep claiming the focus
  }

  private describe(spec: LineSpec): string { return `${spec.name}, ${this.fmt(spec.mm)}. Arrow keys move it, Shift for larger steps.`; }

  private marginLines(sheet: Sheet): HTMLElement {
    const wrap = h("div", { class: "margins", attrs: { contenteditable: "false" } });
    for (const kind of ["left", "right", "top", "bottom", "header", "footer"] as LineKind[]) {
      const spec = this.spec(sheet, kind);
      const l = h("div", {
        class: `mline drag ${LINE_CLASS[kind]} ${spec.axis}${this.locked ? " locked" : ""}`, data: { kind },
        attrs: { tabindex: "0", role: "slider", "aria-orientation": spec.axis === "v" ? "horizontal" : "vertical", "aria-label": spec.name, "aria-valuemin": spec.min, "aria-valuemax": spec.max, "aria-valuenow": spec.mm, "aria-valuetext": this.describe(spec) },
      });
      l.style.setProperty(spec.axis === "v" ? "left" : "top", `${spec.mm * MM_PX}px`);
      l.addEventListener("pointerdown", (e) => this.startDrag(e, l, sheet, kind));
      l.addEventListener("pointerenter", () => { if (!this.dragging) this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name); });
      l.addEventListener("pointerleave", () => this.hideReadout());
      l.addEventListener("focus", () => this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name));
      l.addEventListener("blur", () => this.hideReadout());
      l.addEventListener("keydown", (e) => this.nudge(e, sheet, kind));
      wrap.appendChild(l);
    }
    return wrap;
  }

  private guideLines(sheet: Sheet, guides: GuideSet): HTMLElement {
    const wrap = h("div", { class: "guides", attrs: { contenteditable: "false" } });
    const add = (axis: "v" | "h", mm: number, index: number): void => {
      const g = h("div", { class: `mline user ${axis}`, attrs: { role: "separator", tabindex: "0", "aria-label": `${axis === "v" ? "Vertical" : "Horizontal"} guide at ${mm.toFixed(1)} millimetres. Arrow keys move it, Delete removes it.`, title: "Drag to move, double-click or Delete to remove" } });
      g.style.setProperty(axis === "v" ? "left" : "top", `${mm * MM_PX}px`);
      g.addEventListener("pointerdown", (e) => this.dragGuide(e, g, sheet, axis, index));
      g.addEventListener("pointerenter", () => { if (!this.dragging) this.showReadout(sheet, axis, mm, "Guide"); });
      g.addEventListener("pointerleave", () => this.hideReadout());
      g.addEventListener("focus", () => this.showReadout(sheet, axis, mm, "Guide"));
      g.addEventListener("blur", () => this.hideReadout());
      g.addEventListener("dblclick", (e) => { e.stopPropagation(); this.events.guideMove(axis, index, null); });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.events.guideMove(axis, index, null); }
        const step = e.shiftKey ? 5 : 1;
        const delta = axis === "v" ? (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0) : (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
        if (delta) { e.preventDefault(); this.events.guideMove(axis, index, mm + delta); }
      });
      wrap.appendChild(g);
    };
    (guides.v ?? []).forEach((mm, i) => add("v", mm, i));
    (guides.h ?? []).forEach((mm, i) => add("h", mm, i));
    return wrap;
  }

  private dragGuide(e: PointerEvent, el: HTMLElement, sheet: Sheet, axis: "v" | "h", index: number): void {
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const rect = sheet.el.getBoundingClientRect();
    const limit = axis === "v" ? sheet.geometry.widthMm : sheet.geometry.heightMm;
    const toMm = (ev: PointerEvent): number => ((axis === "v" ? ev.clientX - rect.left : ev.clientY - rect.top) / this.zoom) / MM_PX;
    this.dragging = true;
    const move = (ev: PointerEvent): void => { const at = Math.max(0, Math.min(limit, toMm(ev))); el.style.setProperty(axis === "v" ? "left" : "top", `${at * MM_PX}px`); this.showReadout(sheet, axis, Math.round(at * 2) / 2, "Guide"); };
    const up = (ev: PointerEvent): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      this.dragging = false;
      this.hideReadout();
      const mm = toMm(ev);
      this.events.guideMove(axis, index, mm < 0 || mm > limit ? null : Math.round(mm * 2) / 2);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  private ticks(lengthMm: number, vertical: boolean, sheet: Sheet, kinds: LineKind[], label: string): SVGSVGElement {
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
      handle.addEventListener("pointerdown", (e) => this.startDrag(e, handle as unknown as Element, sheet, kind));
      handle.addEventListener("pointerenter", () => { if (!this.dragging) this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name); });
      handle.addEventListener("pointerleave", () => this.hideReadout());
      handle.addEventListener("focus", () => this.showReadout(sheet, spec.axis, this.spec(sheet, kind).mm, spec.name));
      handle.addEventListener("blur", () => this.hideReadout());
      handle.addEventListener("keydown", (e) => this.nudge(e, sheet, kind));
      svg.appendChild(handle);
    }
    return svg;
  }

  private verticalRuler(sheet: Sheet): HTMLElement {
    const g = sheet.geometry;
    const wrap = h("div", { class: "vruler", attrs: { contenteditable: "false" } });
    wrap.appendChild(this.ticks(g.heightMm, true, sheet, ["top", "header", "footer", "bottom"], "Vertical ruler. Handles: top margin, header, footer and bottom margin"));
    wrap.addEventListener("dblclick", (e) => { e.stopPropagation(); this.events.rulerDouble(); });
    return wrap;
  }

  private drawRuler(input: LayoutInput): void {
    this.hruler.replaceChildren();
    this.hruler.toggleAttribute("hidden", !input.showRulers);
    const first = this.sheets[0];
    if (!first || !input.showRulers) { this.rulerSvg = null; return; }
    this.rulerSvg = this.ticks(first.geometry.widthMm, false, first, ["left", "right"], "Horizontal ruler. Handles: left and right margin");
    this.hruler.appendChild(h("div", { class: "hruler-inner" }, this.rulerSvg));
    this.placeRuler();
  }

  private placeRuler(): void {
    const inner = this.hruler.firstElementChild as HTMLElement | null;
    const first = this.sheets[0];
    if (!inner || !first) return;
    const hostRect = first.el.getBoundingClientRect();
    const barRect = this.hruler.getBoundingClientRect();
    inner.style.setProperty("transform", `translateX(${hostRect.left - barRect.left}px) scale(${this.zoom})`);
    inner.style.setProperty("transform-origin", "0 0");
  }

  /* ------------------------------------------------------------------------------------------------- zoom */
  setZoom(percent: number): void {
    this.zoom = Math.max(0.1, Math.min(4, percent / 100));
    this.zoomer.style.setProperty("transform", `scale(${this.zoom})`);
    this.fit();
    this.placeRuler();
    this.placed();
  }

  /** Room, in unscaled page units, that the panels attached to a page need beside it, so that opening one never clips it or covers the text. */
  setRoom(left: number, right: number): void {
    if (this.room.left === left && this.room.right === right) return;
    this.room = { left, right };
    this.fit();
    this.placeRuler();
  }

  /** The zoom that makes a whole page fit the window by height or by width. */
  fitZoom(mode: "height" | "width"): number {
    const first = this.sheets[0];
    if (!first) return 100;
    const pad = 56;
    const availW = this.scroller.clientWidth - pad - 28;
    const availH = this.scroller.clientHeight - pad;
    const w = first.geometry.widthMm * MM_PX;
    const hh = first.geometry.heightMm * MM_PX;
    return Math.round(Math.max(10, Math.min(400, ((mode === "width" ? availW / w : availH / hh) * 100))));
  }

  /** Size the scrolling area to the scaled pages and centre them; panels open beside a page push the page away from the edge, never off it. */
  private fit(): void {
    const z = this.zoom;
    const pad = 28 * z;
    const w = this.host.offsetWidth * z + 2 * pad;
    const hgt = this.host.offsetHeight * z + 2 * pad;
    const view = this.scroller.clientWidth;
    const left = Math.max(this.room.left * z, 30, (view - w) / 2);
    this.zoomer.style.setProperty("margin-left", `${Math.round(left)}px`);
    this.sizer.style.setProperty("width", `${Math.max(view, Math.round(left + w + this.room.right * z))}px`);
    this.sizer.style.setProperty("height", `${Math.round(hgt)}px`);
  }

  /** Where an element is, in the page's own (unscaled) units, relative to the zoomed area. */
  rectOf(el: Element): { left: number; top: number; width: number; height: number } {
    const z = this.zoom;
    const origin = this.zoomer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { left: (r.left - origin.left) / z, top: (r.top - origin.top) / z, width: r.width / z, height: r.height / z };
  }

  /** A pointer position in the page's own units. */
  toPage(clientX: number, clientY: number): { x: number; y: number } {
    const origin = this.zoomer.getBoundingClientRect();
    return { x: (clientX - origin.left) / this.zoom, y: (clientY - origin.top) / this.zoom };
  }

  /** Where a sheet is, in unscaled page units relative to the zoomed area (the same coordinates the attachment layer uses). */
  sheetRect(index: number): { left: number; top: number; width: number; height: number } | null {
    const sheet = this.sheets[index];
    if (!sheet) return null;
    const z = this.zoom;
    const origin = this.zoomer.getBoundingClientRect();
    const r = sheet.el.getBoundingClientRect();
    return { left: (r.left - origin.left) / z, top: (r.top - origin.top) / z, width: r.width / z, height: r.height / z };
  }

  /* ------------------------------------------------------------------------------------------------- queries */
  sheetOf(el: Element | null): Sheet | undefined { const sheet = el?.closest<HTMLElement>(".sheet"); return this.sheets.find((x) => x.el === sheet); }
  pageIndexOf(el: Element | null): number { const sheet = this.sheetOf(el); return sheet ? this.sheets.indexOf(sheet) : 0; }
  scrollToSheet(index: number): void { this.sheets[index]?.el.scrollIntoView({ block: "start", behavior: "auto" }); }

  private onDouble(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest(".blk, .hf, .mline, .vruler, .foot")) return;
    const sheet = this.sheetOf(target);
    if (!sheet) return;
    const rect = sheet.el.getBoundingClientRect();
    this.events.pageDouble(sheet.section, ((e.clientX - rect.left) / this.zoom) / MM_PX, ((e.clientY - rect.top) / this.zoom) / MM_PX);
  }

  get total(): number { return this.sheets.length; }
  get layoutInput(): LayoutInput | null { return this.last; }
}

export function pageIcon(): SVGSVGElement { return glyph("layout"); }
