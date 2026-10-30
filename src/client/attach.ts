/** Everything attached to a page: three coloured tabs per page (pink on the left for corrections, gold on the right for notes, grey below for
 *  EMBED) and the three panels they open. The panels belong to the page, not to the window: they grow out of the page's own edge, stay with
 *  it while the document scrolls and zooms, are never part of the printed page, and open and close independently of each other and of
 *  the two application panels. Design: SLAI Writer (main), pages 11 to 14.
 *
 *  All of it lives in PageView's layer, beside the editable text and never inside it, so no tab or panel can change the document. */
import { chevron } from "./dico.js";
import { h } from "./kit.js";
import type { PageView } from "./page.js";
import { MM_PX } from "./textops.js";

export type PanelKind = "red" | "yellow" | "embed";

export interface AttachSpec {
  kind: PanelKind;
  /** What the tab and the panel are called to a screen reader. */
  label: string;
  /** The panel's content. It is mounted when the panel first opens and kept (not rebuilt) afterwards. */
  content: HTMLElement;
}

const TAB_W = 20;            // page units (px at 100 %), how far a side tab sticks out of the page
const PANEL_MM = 72;         // the notes and corrections panels are at most 100 mm wide (design page 12); this is their working width
const PANEL_MAX_MM = 100;
const EMBED_TAB_H = 20;
const TUCK = 14;             // how far a panel reaches in behind its page, so it looks as if it comes out of the page
const MIN_TAB_PX = 14;       // on screen, so the tabs stay clickable when the page is zoomed far out
const SLIDE_MS = 380;        // the length of the slide; the layout follows it frame by frame

const COLOUR_NAME: Record<PanelKind, string> = { red: "Corrections", yellow: "Notes", embed: "EMBED" };

export class PageAttachments {
  /** The sheet (0-based) each panel is open on, or null when it is closed. */
  private openAt: Record<PanelKind, number | null> = { red: null, yellow: null, embed: null };
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<PanelKind, HTMLElement>();
  private readonly specs = new Map<PanelKind, AttachSpec>();
  private marginSheet: HTMLElement | null = null;
  /** Where each panel last was, so that a closing panel slides back into the page it came out of. */
  private lastAt: Record<PanelKind, number | null> = { red: null, yellow: null, embed: null };
  private busy = false;
  private pending = false;
  onChange: (kind: PanelKind, open: boolean, sheet: number) => void = () => undefined;

  constructor(private readonly page: PageView, specs: AttachSpec[], private readonly currentSheet: () => number) {
    for (const spec of specs) {
      this.specs.set(spec.kind, spec);
      const panel = h("aside", { class: `ppanel ${spec.kind}`, id: `panel-${spec.kind}`, attrs: { "aria-label": spec.label, tabindex: "-1", "aria-hidden": "true" } }, spec.content);
      panel.inert = true;
      panel.addEventListener("keydown", (e) => { if (e.key === "Escape" && !(e.target as Element).closest("dialog, [role=menu], .slash")) { e.preventDefault(); e.stopPropagation(); const at = this.openAt[spec.kind]; this.close(spec.kind); if (at !== null) this.tab(spec.kind, at)?.focus(); } });
      this.panels.set(spec.kind, panel);
      page.layer.appendChild(panel);
      // The EMBED panel pushes the pages after it down by its own height, so a change of its height re-places everything.
      if (spec.kind === "embed") new ResizeObserver(() => this.place()).observe(panel);
    }
    page.onPlace = () => this.place();
  }

  isOpen(kind: PanelKind): boolean { return this.openAt[kind] !== null; }
  sheetOf(kind: PanelKind): number | null { return this.openAt[kind]; }
  panel(kind: PanelKind): HTMLElement | undefined { return this.panels.get(kind); }

  open(kind: PanelKind, sheet = this.currentSheet(), focus = false): void {
    const index = Math.max(0, Math.min(this.page.sheets.length - 1, sheet));
    const was = this.openAt[kind];
    this.openAt[kind] = index;
    this.place();
    this.follow();
    if (was !== index) this.onChange(kind, true, index);
    if (focus) this.panels.get(kind)?.focus({ preventScroll: true });
    this.reveal(kind);
  }

  close(kind: PanelKind): void {
    const was = this.openAt[kind];
    if (was === null) return;
    this.openAt[kind] = null;
    this.place();
    this.follow();
    this.onChange(kind, false, was);
  }

  toggle(kind: PanelKind, sheet = this.currentSheet(), focus = false): void {
    if (this.openAt[kind] === sheet) this.close(kind); else this.open(kind, sheet, focus);
  }

  tab(kind: PanelKind, sheet: number): HTMLButtonElement | undefined { return this.tabs.get(`${kind}:${sheet}`); }

  /** Scroll so the panel is in view (it may be on a page that is not the one on screen). */
  private reveal(kind: PanelKind): void {
    const panel = this.panels.get(kind);
    if (panel && this.openAt[kind] !== null) panel.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /* ------------------------------------------------------------------------------------------------- placement */
  place(): void {
    if (this.busy) { this.pending = true; return; }
    this.busy = true;
    try {
      let rounds = 0;
      do { this.pending = false; this.placeOnce(); rounds += 1; } while (this.pending && rounds < 3);
    } finally { this.busy = false; }
  }

  /** While a panel slides, the pages below an EMBED panel move with it, so the placement is redone every frame for the length of the slide. */
  private follow(): void {
    const start = performance.now();
    const step = (): void => { this.place(); if (performance.now() - start < SLIDE_MS + 60) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  private panelWidth(): number { return Math.min(PANEL_MAX_MM, PANEL_MM) * MM_PX; }
  private embedWidth(pageWidth: number): number { return pageWidth * 0.89; }

  private placeOnce(): void {
    const { page } = this;
    const count = page.sheets.length;
    for (const kind of ["red", "yellow", "embed"] as PanelKind[]) { const at = this.openAt[kind]; if (at !== null && at >= count) this.openAt[kind] = count ? count - 1 : null; }
    const pw = this.panelWidth();
    const z = page.zoom;
    const tw = Math.max(TAB_W, MIN_TAB_PX / z);
    const th = Math.max(EMBED_TAB_H, MIN_TAB_PX / z);

    /* room beside the pages so nothing is clipped at the edge of the window */
    page.setRoom(tw + 6 + (this.openAt.red !== null ? pw : 0), tw + 6 + (this.openAt.yellow !== null ? pw : 0));

    /* the EMBED panel hangs below its page and pushes the next pages down by its own height */
    const embedAt = this.openAt.embed;
    const embedPanel = this.panels.get("embed");
    let margin: HTMLElement | null = null;
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
    } else if (embedPanel) embedPanel.style.removeProperty("margin-bottom");
    if (this.marginSheet && this.marginSheet !== margin) this.marginSheet.style.removeProperty("margin-bottom");
    this.marginSheet = margin;

    /* tabs and panels: one trio per page. A closed panel stays where it will open, tucked in behind the page; opening slides it out. */
    const wanted = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      const r = page.sheetRect(i);
      const sheet = page.sheets[i];
      if (!r || !sheet) continue;
      const m = sheet.geometry.margins;
      const tabTop = r.top + r.height * 0.37;
      const tabH = Math.max(90, r.height * 0.26);
      for (const kind of ["red", "yellow", "embed"] as PanelKind[]) {
        if (!this.specs.has(kind)) continue;
        const key = `${kind}:${i}`;
        wanted.add(key);
        const open = this.openAt[kind] === i;
        const tab = this.tabs.get(key) ?? this.makeTab(kind, i);
        tab.classList.toggle("open", open);
        tab.setAttribute("aria-expanded", String(open));
        const label = `${COLOUR_NAME[kind]} panel, page ${i + 1}`;
        tab.setAttribute("aria-label", label);
        tab.title = `${open ? "Hide" : "Show"} the ${COLOUR_NAME[kind].toLowerCase()} panel of page ${i + 1}`;
        const embedH = embedPanel?.offsetHeight ?? 0;
        let left: number; let top: number; let w: number; let hgt: number;
        if (kind === "red") { w = tw; hgt = tabH; top = tabTop; left = (open ? r.left - pw : r.left) - tw + 1; }
        else if (kind === "yellow") { w = tw; hgt = tabH; top = tabTop; left = (open ? r.left + r.width + pw : r.left + r.width) - 1; }
        else { w = Math.max(120, r.width * 0.39); hgt = th; left = r.left + (r.width - w) / 2; top = (open ? r.top + r.height - TUCK + embedH : r.top + r.height) - 1; }
        tab.style.setProperty("left", `${Math.round(left)}px`); tab.style.setProperty("top", `${Math.round(top)}px`);
        tab.style.setProperty("width", `${Math.round(w)}px`); tab.style.setProperty("height", `${Math.round(hgt)}px`);
        tab.replaceChildren(chevron(kind === "red" ? (open ? "right" : "left") : kind === "yellow" ? (open ? "left" : "right") : (open ? "up" : "down")));
      }
      /* the panels of this page (a panel is placed on the page it is open on, or on the first page while it is closed) */
      for (const kind of ["red", "yellow", "embed"] as PanelKind[]) {
        const panel = this.panels.get(kind);
        if (!panel) continue;
        const at = this.openAt[kind];
        if (at !== i && !(at === null && i === (this.lastAt[kind] ?? 0))) continue;
        if (kind === "embed") {
          const w = this.embedWidth(r.width);
          panel.style.setProperty("left", `${Math.round(r.left + (r.width - w) / 2)}px`);
          panel.style.setProperty("top", `${Math.round(r.top + r.height - TUCK)}px`);
        } else {
          panel.style.setProperty("left", `${Math.round(kind === "red" ? r.left - pw : r.left + r.width - TUCK)}px`);
          panel.style.setProperty("top", `${Math.round(r.top + m.top * MM_PX)}px`);
          panel.style.setProperty("width", `${Math.round(pw + TUCK)}px`);
          panel.style.setProperty("height", `${Math.round(Math.max(160, r.height - (m.top + m.bottom) * MM_PX))}px`);
        }
      }
    }
    for (const [key, tab] of this.tabs) if (!wanted.has(key)) { tab.remove(); this.tabs.delete(key); }
    for (const kind of ["red", "yellow", "embed"] as PanelKind[]) {
      const panel = this.panels.get(kind);
      if (!panel) continue;
      const open = this.openAt[kind] !== null;
      if (open) this.lastAt[kind] = this.openAt[kind];
      panel.classList.toggle("open", open);
      panel.setAttribute("aria-hidden", String(!open));
      panel.inert = !open;
    }
  }

  private makeTab(kind: PanelKind, sheet: number): HTMLButtonElement {
    const tab = h("button", { class: `ptab ${kind}`, type: "button", attrs: { "aria-controls": `panel-${kind}`, "aria-expanded": "false" } });
    tab.addEventListener("click", () => { const i = Number(tab.dataset["sheet"]); this.toggle(kind, i, this.openAt[kind] !== i); });
    tab.dataset["sheet"] = String(sheet);
    this.tabs.set(`${kind}:${sheet}`, tab);
    this.page.layer.appendChild(tab);
    return tab;
  }
}
