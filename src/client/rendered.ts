/** The Rendered View: the document as the PDF export draws it, read only.
 *
 *  Nothing here lays a page out. The server renders the pages of the very PDF that Export produces (the canonical layout of Documaster) and this view
 *  shows those pictures, so margins (mirrored, gutter), breaks, columns, tables, text boxes, images, headers and footers, page numbers, footnotes and
 *  the table of contents are the exported ones and not an approximation. There is no caret, no selection, no ruler, no guide and no object outline,
 *  because there is no editable content: a picture of a page cannot be changed. How the pages are arranged (one to four across, or the two-page book
 *  view) and how they are fitted to the window come from `arrangement.ts`, the same code the editing view uses. */
import { api } from "./net.js";
import { arrange, fitFraction, groupTarget, rowOf, type Arrangement, type FitMode, type PageBox, type PerRow } from "./arrangement.js";
import { h } from "./kit.js";

interface PageInfo { n: number; widthPt: number; heightPt: number; label: string | null; section: string | null }
interface PageList { version: number; total: number; pages: PageInfo[] }

export interface RenderedEvents {
  /** The page in the middle of the window changed (1-based), or the zoom did. */
  changed(): void;
  /** Leave for the editing view (Escape). */
  leave(): void;
  /** Zoom asked for with Ctrl and the wheel, as a percentage. */
  zoom(percent: number): void;
  /** The document moved on while this view was open; the pictures no longer match it. */
  stale(): void;
}

const PX_PER_PT = 96 / 72;
const MM_PER_PT = 25.4 / 72;
const GAP = 28;
const SIDE_PAD = 28;

/** The width to ask the server for: the shown width at the screen's density, rounded up to a bucket so zooming does not ask for a new picture at every step. */
export function pictureWidth(shownPx: number, density: number): number {
  const wanted = Math.max(1, shownPx) * Math.max(1, density);
  return Math.max(200, Math.min(3200, Math.ceil(wanted / 200) * 200));
}

export class RenderedView {
  readonly el: HTMLElement;
  readonly scroller: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly status: HTMLElement;
  private info: PageList | null = null;
  private figures: HTMLElement[] = [];
  private view = { perRow: 1 as PerRow, facing: false };
  private percent = 100;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pictureTimer: number | undefined;
  private staleSaid = false;
  private slot: HTMLElement | null = null;
  private readonly onKeyDown = (e: KeyboardEvent): void => this.keys(e);
  private readonly onWheel = (e: WheelEvent): void => this.wheel(e);
  private readonly onScroll = (): void => { this.events.changed(); };

  constructor(private readonly sid: string, private readonly events: RenderedEvents) {
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
  async load(): Promise<void> {
    const list = await api.get<PageList>(`/docs/${encodeURIComponent(this.sid)}/pages`);
    this.info = list;
    this.staleSaid = false;
    this.build();
  }

  get total(): number { return this.info?.total ?? 0; }
  get version(): number { return this.info?.version ?? 0; }
  get zoom(): number { return this.percent; }
  get arrangementMode(): { perRow: PerRow; facing: boolean } { return { ...this.view }; }
  get arrangement(): Arrangement { return arrange(this.total, this.view.perRow, this.view.facing); }
  /** The printed label of a page, as the export draws it ("iv", "12"), or null. */
  labelOf(page: number): string | null { return this.info?.pages[page - 1]?.label ?? null; }

  private boxes(): PageBox[] {
    return (this.info?.pages ?? []).map((p) => ({ widthMm: p.widthPt * MM_PER_PT, heightMm: p.heightPt * MM_PER_PT }));
  }

  private build(): void {
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    this.grid.replaceChildren();
    this.figures = [];
    this.slot = null;
    const pages = this.info?.pages ?? [];
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) this.load1(entry.target as HTMLElement);
    }, { root: this.scroller, rootMargin: "150% 0px 150% 0px" });
    for (const page of pages) {
      const img = h("img", { class: "rv-img", attrs: { alt: `Page ${page.label ?? page.n} of ${pages.length}`, draggable: "false", decoding: "async" } });
      img.addEventListener("error", () => this.failed());
      const figure = h("figure", { class: "rv-page", attrs: { "data-page": String(page.n), "data-side": page.n % 2 === 1 ? "right" : "left" } },
        img, h("figcaption", { class: "rv-no", text: page.label ? `${page.label}${String(page.n) !== page.label ? ` (page ${page.n})` : ""}` : String(page.n) }));
      this.figures.push(figure);
      this.grid.appendChild(figure);
      this.observer.observe(figure);
    }
    this.resizeObserver = new ResizeObserver(() => { this.layout(); });
    this.resizeObserver.observe(this.scroller);
    this.layout();
  }

  /** Size and place the pages again (the view was attached, or the window changed). */
  refresh(): void { this.layout(); }

  /** Size the pages and place them in rows. Only sizes and places change; the pictures are asked for again only when the width bucket changes. */
  private layout(): void {
    const pages = this.info?.pages ?? [];
    if (!pages.length) return;
    const z = this.percent / 100;
    const { perRow, facing } = this.view;
    const per = facing ? 2 : perRow;
    this.grid.dataset["perRow"] = String(per);
    this.grid.toggleAttribute("data-facing", facing);
    this.grid.style.setProperty("--rv-per-row", String(per));
    this.grid.style.setProperty("--rv-gap", `${GAP * z}px`);
    pages.forEach((page, at) => {
      const figure = this.figures[at];
      const img = figure?.firstElementChild as HTMLImageElement | undefined;
      if (!figure || !img) return;
      const w = page.widthPt * PX_PER_PT * z, hgt = page.heightPt * PX_PER_PT * z;
      figure.style.setProperty("width", `${w}px`);
      figure.style.setProperty("height", `${hgt}px`);
      img.dataset["want"] = String(pictureWidth(w, window.devicePixelRatio || 1));
    });
    this.slot?.remove();
    this.slot = null;
    const first = this.figures[0];
    if (facing && first) {                                                   // the empty place beside page 1: a place on the desk, never a page
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
    this.pictureTimer = window.setTimeout(() => { for (const f of this.figures) this.load1(f); }, 120);
  }

  /** Give a page its picture when it is near the window, and draw it again when the width bucket grew. A picture that is already wide enough stays. */
  private load1(figure: HTMLElement): void {
    const img = figure.firstElementChild as HTMLImageElement | null;
    if (!img || !this.info) return;
    const want = Number(img.dataset["want"] ?? 900), have = Number(img.dataset["have"] ?? 0);
    if (have >= want) return;
    if (!have && !this.near(figure)) return;
    img.dataset["have"] = String(want);
    img.src = `/api/docs/${encodeURIComponent(this.sid)}/pages/${figure.dataset["page"]}.png?w=${want}&v=${this.info.version}`;
  }

  private near(figure: HTMLElement): boolean {
    const view = this.scroller.getBoundingClientRect();
    const r = figure.getBoundingClientRect();
    return r.bottom > view.top - view.height * 1.5 && r.top < view.bottom + view.height * 1.5;
  }

  private failed(): void {
    if (this.staleSaid) return;
    this.staleSaid = true;
    this.events.stale();
  }

  /* ------------------------------------------------------------------------------------------------ arrangement and zoom */
  setArrangement(perRow: PerRow, facing: boolean): void {
    if (this.view.perRow === perRow && this.view.facing === facing) return;
    const keep = this.anchor();
    this.view = { perRow, facing };
    this.layout();
    this.restore(keep);
    this.events.changed();
  }

  setZoom(percent: number): void {
    const next = Math.max(10, Math.min(400, Math.round(percent)));
    if (next === this.percent) return;
    const keep = this.anchor();
    this.percent = next;
    this.layout();
    this.restore(keep);
    this.events.changed();
  }

  /** The zoom at which the arrangement fits the window across, down or both. */
  fitZoom(mode: FitMode): number {
    if (!this.info?.pages.length) return 100;
    const view = { width: Math.max(50, this.scroller.clientWidth - 2 * SIDE_PAD - 14), height: Math.max(50, this.scroller.clientHeight - 2 * SIDE_PAD) };
    return Math.round(fitFraction(mode, this.arrangement, this.boxes(), view, PX_PER_PT * (72 / 25.4), GAP) * 100);
  }

  /** The row at the top of the window and how far into it the window is, so a change of zoom or arrangement keeps the reader in the same place. */
  private anchor(): { page: number; fraction: number } {
    const view = this.scroller.getBoundingClientRect();
    const at = Math.max(0, this.figures.findIndex((f) => f.getBoundingClientRect().bottom > view.top + 1));
    const figure = this.figures[at];
    if (!figure) return { page: 1, fraction: 0 };
    const r = figure.getBoundingClientRect();
    return { page: at + 1, fraction: Math.max(0, Math.min(1, (view.top - r.top) / Math.max(1, r.height))) };
  }

  private restore(at: { page: number; fraction: number }): void {
    const figure = this.figures[at.page - 1];
    if (!figure) return;
    const view = this.scroller.getBoundingClientRect();
    const r = figure.getBoundingClientRect();
    this.scroller.scrollTop += r.top + at.fraction * r.height - view.top;
  }

  /* ------------------------------------------------------------------------------------------------ position */
  /** The page that holds the middle of the window (1-based). */
  currentPage(): number {
    const view = this.scroller.getBoundingClientRect();
    const mid = view.top + view.height / 3;
    const hit = this.figures.findIndex((f) => { const r = f.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
    if (hit >= 0) return hit + 1;
    const after = this.figures.findIndex((f) => f.getBoundingClientRect().top > mid);
    return after < 0 ? Math.max(1, this.figures.length) : Math.max(1, after);
  }

  /** How far into the current page the top of the window is (0..1), to come back to the same place. */
  fractionInPage(): number { return this.anchor().fraction; }

  goTo(page: number, fraction = 0): void {
    const figure = this.figures[Math.max(1, Math.min(this.figures.length, page)) - 1];
    if (!figure) return;
    const view = this.scroller.getBoundingClientRect();
    const r = figure.getBoundingClientRect();
    this.scroller.scrollTop += r.top + fraction * r.height - view.top - SIDE_PAD * (this.percent / 100) / 2;
    this.events.changed();
  }

  /** Previous or next group of pages (a row of the arrangement); `by` is -1 or 1. */
  group(by: number): void {
    const target = groupTarget(this.arrangement, this.currentPage() - 1, by);
    this.goTo(target + 1);
  }

  /** The pages shown on the row of the current page, for the status line ("pages 4–5 of 12"). */
  rowPages(): number[] {
    const a = this.arrangement;
    const row = a.rows[rowOf(a, this.currentPage() - 1)] ?? [];
    return row.flatMap((slot) => (slot.page === null ? [] : [slot.page + 1]));
  }

  focus(): void { this.scroller.focus({ preventScroll: true }); }

  say(text: string): void { this.status.textContent = text; }

  /* ------------------------------------------------------------------------------------------------ keys and wheel */
  private keys(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const line = 56, screen = Math.max(80, this.scroller.clientHeight * 0.9);
    switch (e.key) {
      case "Escape": e.preventDefault(); this.events.leave(); return;
      case "PageDown": e.preventDefault(); this.group(1); return;
      case "PageUp": e.preventDefault(); this.group(-1); return;
      case " ": e.preventDefault(); this.scroller.scrollBy({ top: e.shiftKey ? -screen : screen }); return;
      case "ArrowDown": e.preventDefault(); this.scroller.scrollBy({ top: line }); return;
      case "ArrowUp": e.preventDefault(); this.scroller.scrollBy({ top: -line }); return;
      case "ArrowRight": e.preventDefault(); this.scroller.scrollBy({ left: line }); return;
      case "ArrowLeft": e.preventDefault(); this.scroller.scrollBy({ left: -line }); return;
      case "Home": e.preventDefault(); this.goTo(1); return;
      case "End": e.preventDefault(); this.goTo(this.total); return;
      default: break;
    }
    // everything else that would edit (typing, Delete, Enter, paste) does nothing here: there is nothing to edit. Zoom keys belong to the screen.
    if (!mod && e.key.length === 1) e.preventDefault();
  }

  private wheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    this.events.zoom(this.percent + (e.deltaY < 0 ? 10 : -10));
  }

  destroy(): void {
    window.clearTimeout(this.pictureTimer);
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    this.scroller.removeEventListener("keydown", this.onKeyDown);
    this.scroller.removeEventListener("wheel", this.onWheel);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.el.remove();
  }
}
