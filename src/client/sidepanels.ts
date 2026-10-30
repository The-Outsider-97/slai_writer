/** The two application panels of the design (page 11): Tools on the left, Pages / Layers / Page Background / Illustrations on the right.
 *  Both start collapsed to a slim rail of icons with an arrow at the end of the ruler row; the arrow opens and closes the panel. They work
 *  independently of each other and of the three panels attached to a page. */
import { chevron, dico, type DesignIcon } from "./dico.js";
import type { DocCtx } from "./docctx.js";
import { h } from "./kit.js";
import type { RightPanel } from "./panels/right.js";
import { RIGHT_SECTIONS } from "./panels/right.js";
import { footerEntries, toolEntries } from "./panels/tools.js";

export interface SidePanel { el: HTMLElement; arrow: HTMLButtonElement; readonly isOpen: boolean; set(open: boolean): void; toggle(): void; refresh(): void;
  /** Called whenever the panel opens or closes, so the screen can keep one panel per side open at a time. */
  onToggle: ((open: boolean) => void) | null }

function railButton(label: string, icon: DesignIcon, run: () => void): HTMLButtonElement {
  const b = h("button", { class: "ri", type: "button", attrs: { "aria-label": label, title: label } }, dico(icon));
  b.addEventListener("click", run);
  return b;
}
const dot = (): HTMLElement => h("i", { class: "rdot", attrs: { "aria-hidden": "true" } });

function build(kind: "left" | "right", label: string, rail: HTMLElement, full: HTMLElement, after: (open: boolean) => void): SidePanel {
  const el = h("aside", { class: `eside ${kind}`, data: { open: "false" }, attrs: { "aria-label": label } }, rail, full);
  full.hidden = true;
  const arrow = h("button", { class: `earrow ${kind}`, type: "button", attrs: { "aria-expanded": "false", "aria-label": `Show the ${label.toLowerCase()} panel`, title: `Show the ${label.toLowerCase()} panel` } });
  const state = { open: false };
  const self: { onToggle: ((open: boolean) => void) | null } = { onToggle: null };
  const set = (open: boolean): void => {
    const changed = state.open !== open;
    state.open = open;
    el.dataset["open"] = String(open);
    rail.hidden = open; full.hidden = !open;
    arrow.setAttribute("aria-expanded", String(open));
    arrow.setAttribute("aria-label", `${open ? "Hide" : "Show"} the ${label.toLowerCase()} panel`);
    arrow.title = arrow.getAttribute("aria-label") ?? "";
    // The arrows are drawn as in the design: collapsed, the left one points left and the right one right; open, they turn round.
    arrow.replaceChildren(chevron(kind === "left" ? (open ? "right" : "left") : (open ? "left" : "right"), "big"));
    after(open);
    if (changed) self.onToggle?.(open);
  };
  arrow.addEventListener("click", () => set(!state.open));
  set(false);
  return { el, arrow, get isOpen() { return state.open; }, set, toggle: () => set(!state.open), refresh: () => undefined, get onToggle() { return self.onToggle; }, set onToggle(fn) { self.onToggle = fn; } };
}

export function createLeftSide(ctx: DocCtx): SidePanel {
  const entries = toolEntries(ctx);
  const footer = footerEntries(ctx);
  const rail = h("nav", { class: "rail", attrs: { "aria-label": "Tools" } },
    entries.flatMap((e, i) => [railButton(`${e.label}${e.state ? ` (${e.state})` : ""}`, e.icon, e.run), i < entries.length - 1 ? dot() : null]),
    h("span", { class: "grow" }), footer.flatMap((e, i) => [railButton(e.label, e.icon, e.run), i < footer.length - 1 ? dot() : null]));
  const row = (e: { label: string; icon: DesignIcon; state: string; run(): void }): HTMLButtonElement => {
    const b = h("button", { class: "fi", type: "button" }, dico(e.icon), h("span", { class: "fname" }, e.label, e.state ? h("small", { text: e.state }) : null));
    b.addEventListener("click", e.run);
    return b;
  };
  const full = h("nav", { class: "full", attrs: { "aria-label": "Tools" } }, h("h2", { class: "ptitle", text: "Tools" }), h("hr", { class: "prule" }), h("div", { class: "flist" }, entries.map(row)), h("span", { class: "grow" }), h("hr", { class: "prule" }), h("div", { class: "flist" }, footer.map(row)));
  return build("left", "Tools", rail, full, () => undefined);
}

export function createRightSide(ctx: DocCtx, panel: RightPanel): SidePanel & { openSection(id: (typeof RIGHT_SECTIONS)[number]["id"]): void } {
  void ctx;
  let side!: SidePanel;
  const rail = h("nav", { class: "rail", attrs: { "aria-label": "Document organisation" } },
    RIGHT_SECTIONS.flatMap((s, i) => [railButton(s.label, s.icon, () => { side.set(true); void panel.refresh(); panel.openSection(s.id); }), i < RIGHT_SECTIONS.length - 1 ? dot() : null]));
  const full = h("div", { class: "full", attrs: { role: "region", "aria-label": "Pages, layers, page background and illustrations" } }, panel.el);
  side = build("right", "Document organisation", rail, full, (open) => { if (open) void panel.refresh(); });
  return Object.assign(side, { openSection: (id: (typeof RIGHT_SECTIONS)[number]["id"]) => { side.set(true); panel.openSection(id); } });
}
