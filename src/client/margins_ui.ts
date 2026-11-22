/** Layout → Page Setup → Margins: the presets (each drawn, so the choice is seen before it is made) and the Custom Margins dialog.
 *
 *  Everything goes through the one `page_layout` operation, so a change is a single undo step and the server checks it (nothing here is trusted to
 *  be right, it only asks early). The arithmetic of inside, outside and gutter is `book_layout.ts`, the same as in the server and the export writers. */
import { announce, h, labelled, openDialog, s, toast } from "./kit.js";
import type { DocCtx } from "./docctx.js";
import { documentIsBook, effectiveMargins, problem } from "./book_layout.js";
import { errorText } from "./net.js";
import type { BookLayout, Margins } from "./types.js";
import { checkbox, errorLine, notice, selectField } from "./widgets.js";

export interface MarginPreset {
  id: string;
  label: string;
  /** Top, bottom, and the two sides: for a mirrored preset `left` is the inside margin and `right` the outside one. */
  margins: Margins;
  mirror: boolean;
  gutterMm: number;
  detail: string;
}

const m = (top: number, bottom: number, left: number, right: number): Margins => ({ top, bottom, left, right });

/** The existing presets keep their values (Normal 25, Narrow 15, Wide 35); the book presets are added. */
export const MARGIN_PRESETS: MarginPreset[] = [
  { id: "normal", label: "Normal", margins: m(25, 25, 25, 25), mirror: false, gutterMm: 0, detail: "25 mm on every side" },
  { id: "narrow", label: "Narrow", margins: m(15, 15, 15, 15), mirror: false, gutterMm: 0, detail: "15 mm on every side" },
  { id: "moderate", label: "Moderate", margins: m(25.4, 25.4, 19.1, 19.1), mirror: false, gutterMm: 0, detail: "Top and bottom 25.4 mm, sides 19.1 mm" },
  { id: "wide", label: "Wide", margins: m(35, 35, 35, 35), mirror: false, gutterMm: 0, detail: "35 mm on every side" },
  { id: "mirrored", label: "Mirrored", margins: m(25.4, 25.4, 31.8, 25.4), mirror: true, gutterMm: 0, detail: "Inside 31.8 mm, outside 25.4 mm, alternating by page" },
  { id: "gutter", label: "Gutter / Binding", margins: m(25, 25, 25, 25), mirror: false, gutterMm: 10, detail: "25 mm plus a 10 mm binding gutter on the left" },
];

const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.05;
const sameMargins = (a: Margins, b: Margins): boolean => same(a.top, b.top) && same(a.bottom, b.bottom) && same(a.left, b.left) && same(a.right, b.right);

/** Which preset the section is at, or null (it is custom). */
export function presetOf(stored: Margins, book: BookLayout | undefined): MarginPreset | null {
  const mirror = book?.mirror === true, gutter = book?.gutter_mm ?? 0;
  if (book?.gutter_position === "top" || book?.gutter_position === "right") return null;
  return MARGIN_PRESETS.find((p) => p.mirror === mirror && same(p.gutterMm, gutter) && sameMargins(p.margins, stored)) ?? null;
}

/** A small picture of what a preset does to a page: the page, the text area, and for a book two pages with the spine between them. */
export function presetPreview(p: MarginPreset): SVGSVGElement {
  const W = 40, H = 56, sc = 0.18;                                   // a page of 40 x 56 units stands for about 210 x 297 mm
  const svg = s("svg", { class: "margin-preview", attrs: { viewBox: p.mirror ? "0 0 84 60" : "0 0 44 60", width: p.mirror ? 54 : 30, height: 40, "aria-hidden": "true", focusable: "false" } });
  const page = (x: number, left: number, right: number): void => {
    svg.appendChild(s("rect", { attrs: { x, y: 2, width: W, height: H, fill: "var(--paper, #fff)", stroke: "currentColor", "stroke-width": 1 } }));
    const top = p.margins.top * sc, bottom = p.margins.bottom * sc;
    svg.appendChild(s("rect", { attrs: { x: x + left * sc, y: 2 + top, width: W - (left + right) * sc, height: H - top - bottom, fill: "none", stroke: "currentColor", "stroke-width": 0.8, "stroke-dasharray": "2 1.5", opacity: 0.8 } }));
  };
  if (p.mirror) {
    page(2, p.margins.right, p.margins.left + p.gutterMm);           // a left-hand page: outside on its left, inside (and gutter) beside the spine
    page(42, p.margins.left + p.gutterMm, p.margins.right);          // a right-hand page: inside beside the spine
    svg.appendChild(s("line", { attrs: { x1: 42, y1: 0, x2: 42, y2: 60, stroke: "currentColor", "stroke-width": 0.8, opacity: 0.5 } }));
  } else {
    page(2, p.margins.left + p.gutterMm, p.margins.right);
    if (p.gutterMm > 0) svg.appendChild(s("rect", { attrs: { x: 2, y: 2, width: p.gutterMm * sc, height: H, fill: "currentColor", opacity: 0.18 } }));
  }
  return svg;
}

/** What the section being edited is, and which blocks it holds. Presets and the dialog start from this. */
function target(ctx: DocCtx): { sectionId: string; sections: number; stored: Margins; book: BookLayout | undefined; widthMm: number; heightMm: number; orientation: string } {
  const { ed } = ctx;
  const sel = ed.recallSelection();
  const id = sel?.start.block ?? ed.model.order[0];
  const sectionId = (id ? ed.model.block(id)?.section : undefined) ?? ed.model.meta.sections?.[0]?.id ?? "s1";
  const g = ed.model.geometry(sectionId);
  return { sectionId, sections: ed.model.meta.sections?.length ?? 1, stored: g.stored, book: g.book, widthMm: g.widthMm, heightMm: g.heightMm, orientation: g.heightMm >= g.widthMm ? "portrait" : "landscape" };
}

type Scope = "document" | "section" | "sections" | "from_here";

interface Change { scope: Scope; sectionIds?: string[]; margins: Margins; mirror: boolean; gutterMm: number; gutterPosition: "left" | "right" | "top"; mirrorEdges: boolean; orientation?: string }

/** One `page_layout` operation for a change. Mirrored margins are sent as inside and outside, the others as left and right. */
function opFor(ctx: DocCtx, change: Change): { op: string; [k: string]: unknown } {
  const { ed } = ctx;
  const caret = ed.recallSelection()?.start.block ?? ed.model.order[0];
  const mirrored = change.mirror;
  const margins = mirrored
    ? { top: change.margins.top, bottom: change.margins.bottom, inside: change.margins.left, outside: change.margins.right }
    : { top: change.margins.top, bottom: change.margins.bottom, left: change.margins.left, right: change.margins.right };
  const out: { op: string; [k: string]: unknown } = {
    op: "page_layout", scope: change.scope, margins_mm: margins,
    mirror: mirrored ? true : null,
    gutter_mm: change.gutterMm > 0 ? change.gutterMm : null,
    gutter_position: change.gutterMm > 0 && (change.gutterPosition !== "left" || mirrored) ? change.gutterPosition : null,
    mirror_edges: mirrored && !change.mirrorEdges ? false : null,
    label: "margins",
  };
  if (change.orientation) out["orientation"] = change.orientation;
  if (change.scope === "section") out["section"] = target(ctx).sectionId;
  if (change.scope === "sections") out["sections"] = change.sectionIds ?? [];
  if (change.scope === "from_here") out["block"] = caret;
  return out;
}

async function apply(ctx: DocCtx, change: Change, what: string): Promise<boolean> {
  try {
    await ctx.ed.op(opFor(ctx, change));
    ctx.ui.refreshStatus();
    announce(`${what}.`);
    return true;
  } catch (error) {
    const stale = (error as { details?: { kind?: string } }).details?.kind === "stale_version";
    if (!stale) toast(errorText(error), { kind: "error" });
    ctx.ed.events.emit({ type: "error", error });
    return false;
  }
}

/** The scope a preset is applied to: the whole document when it is one section, otherwise the section the caret is in. */
function presetScope(ctx: DocCtx): { scope: Scope; where: string } {
  const t = target(ctx);
  return t.sections > 1 ? { scope: "section", where: `the section the cursor is in (${t.sections} sections; Custom Margins… can choose others)` } : { scope: "document", where: "the whole document" };
}

export function applyPreset(ctx: DocCtx, preset: MarginPreset): Promise<boolean> {
  const t = target(ctx);
  const gutterPosition = "left" as const;
  const why = problem(t.widthMm, t.heightMm, preset.margins, preset.mirror || preset.gutterMm ? { mirror: preset.mirror, gutter_mm: preset.gutterMm, gutter_position: gutterPosition } : undefined);
  if (why) { toast(`${preset.label} does not fit this page. ${why}`, { kind: "error" }); return Promise.resolve(false); }
  const { scope } = presetScope(ctx);
  return apply(ctx, { scope, margins: preset.margins, mirror: preset.mirror, gutterMm: preset.gutterMm, gutterPosition, mirrorEdges: true }, `${preset.label} margins applied`);
}

/* --------------------------------------------------------------------------------------------------------- the menu */
let closeMenu: (() => void) | null = null;

/** The drop-down under the Margins button: each preset with its picture, the one in use marked, then Custom Margins… */
export function openMarginsMenu(ctx: DocCtx, anchor: HTMLElement): void {
  closeMenu?.();
  const t = target(ctx);
  const current = presetOf(t.stored, t.book);
  const readOnly = ctx.ed.readOnly;
  const menu = h("div", { class: "menu margins-menu", attrs: { role: "menu", "aria-label": "Margins" } });
  menu.appendChild(h("div", { class: "margins-where", text: `Applies to ${presetScope(ctx).where}.` }));
  const items: HTMLButtonElement[] = [];
  for (const p of MARGIN_PRESETS) {
    const item = h("button", { class: "menu-item margin-item", type: "button", disabled: readOnly, attrs: { role: "menuitemradio", "aria-checked": String(current?.id === p.id), tabindex: "-1", "data-preset": p.id, title: p.detail } },
      presetPreview(p), h("span", { class: "margin-item-text" }, h("strong", { text: `${current?.id === p.id ? "● " : ""}${p.label}` }), h("span", { class: "muted", text: p.detail })));
    item.addEventListener("click", () => { close(); void applyPreset(ctx, p); });
    items.push(item); menu.appendChild(item);
  }
  menu.appendChild(h("div", { class: "menu-sep", attrs: { role: "separator" } }));
  const custom = h("button", { class: "menu-item", type: "button", disabled: readOnly, attrs: { role: "menuitem", tabindex: "-1", "data-preset": "custom" } },
    h("span", { class: "margin-item-text" }, h("strong", { text: `${current ? "" : "● "}Custom Margins…` }), h("span", { class: "muted", text: "Inside, outside, gutter, scope" })));
  custom.addEventListener("click", () => { close(); void customMarginsDialog(ctx); });
  items.push(custom); menu.appendChild(custom);
  const rect = anchor.getBoundingClientRect();
  menu.style.setProperty("position", "fixed");
  menu.style.setProperty("left", `${Math.max(8, Math.min(window.innerWidth - 340, rect.left))}px`);
  menu.style.setProperty("top", `${rect.bottom + 4}px`);
  menu.style.setProperty("z-index", "60");
  document.body.appendChild(menu);
  const enabled = (): HTMLButtonElement[] => items.filter((i) => !i.disabled);
  (enabled().find((i) => i.getAttribute("aria-checked") === "true") ?? enabled()[0])?.focus();
  const keys = (e: KeyboardEvent): void => {
    const list = enabled(); const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list.at(-1)?.focus(); }
    else if (e.key === "Tab") close();
  };
  const outside = (e: MouseEvent): void => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  function close(): void {
    document.removeEventListener("keydown", keys, true); document.removeEventListener("mousedown", outside, true); window.removeEventListener("resize", close);
    menu.remove(); if (closeMenu === close) closeMenu = null;
    if (anchor.isConnected) anchor.focus();
  }
  document.addEventListener("keydown", keys, true); document.addEventListener("mousedown", outside, true); window.addEventListener("resize", close);
  closeMenu = close;
}

/* ------------------------------------------------------------------------------------------------------- the dialog */
const num = (value: number): HTMLInputElement => h("input", { type: "number", min: 0, max: 200, step: 0.1, value: String(Math.round(value * 10) / 10), attrs: { inputmode: "decimal" } });

export async function customMarginsDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const t = target(ctx);
  const book = t.book;
  const top = num(t.stored.top), bottom = num(t.stored.bottom), left = num(t.stored.left), right = num(t.stored.right);
  const gutter = num(book?.gutter_mm ?? 0);
  const mirror = checkbox("Mirrored margins (a book: inside and outside, alternating page by page)", book?.mirror === true);
  const swap = checkbox("Page numbers, headers and footers stay on the outer edge of left-hand pages", book?.mirror_edges !== false);
  const position = selectField("Gutter position", [["left", "Left"], ["right", "Right"], ["top", "Top"]], book?.gutter_position ?? "left");
  const orientation = selectField("Orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], t.orientation);
  const leftField = labelled("Left (mm)", left), rightField = labelled("Right (mm)", right);
  const sections = ed.model.meta.sections ?? [];
  const scopeNames: Array<[Scope, string]> = [["document", "Entire document"], ["section", "Current section"], ["from_here", "From here forward"]];
  if (sections.length > 1) scopeNames.splice(2, 0, ["sections", "Selected sections"]);
  const scope = selectField("Apply to", scopeNames, sections.length > 1 ? "section" : "document");
  const picked = h("fieldset", { class: "sections-pick" }, h("legend", { text: "Sections" }),
    ...sections.map((sec, i) => { const c = checkbox(`Section ${i + 1}`, sec.id === t.sectionId); c.input.dataset["section"] = sec.id; return c.root; }));
  const error = errorLine();
  const preview = h("div", { class: "margins-preview-row", attrs: { "aria-hidden": "true" } });
  const preset = selectField("Preset", [["custom", "Custom"], ...MARGIN_PRESETS.map((p): [string, string] => [p.id, p.label])], presetOf(t.stored, book)?.id ?? "custom");

  const read = (): Change | null => {
    const v = (i: HTMLInputElement): number => (i.value.trim() === "" ? NaN : Number(i.value));
    const margins = { top: v(top), bottom: v(bottom), left: v(left), right: v(right) };
    const mirrored = mirror.input.checked;
    const g = v(gutter);
    if (![...Object.values(margins), g].every((x) => Number.isFinite(x) && x >= 0)) return null;
    return { scope: scope.select.value as Scope, sectionIds: [...picked.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.dataset["section"] ?? ""), margins, mirror: mirrored, gutterMm: g,
      gutterPosition: (mirrored && position.select.value === "right" ? "left" : position.select.value) as "left" | "right" | "top", mirrorEdges: swap.input.checked, orientation: orientation.select.value !== t.orientation ? orientation.select.value : undefined };
  };
  const dims = (): { w: number; h: number } => { const land = orientation.select.value === "landscape"; return { w: land ? Math.max(t.widthMm, t.heightMm) : Math.min(t.widthMm, t.heightMm), h: land ? Math.min(t.widthMm, t.heightMm) : Math.max(t.widthMm, t.heightMm) }; };
  const check = (): string | null => {
    const c = read();
    if (!c) return "Enter valid, non-negative numbers.";
    const d = dims();
    if (c.scope === "sections" && !c.sectionIds?.length) return "Choose at least one section.";
    return problem(d.w, d.h, c.margins, c.mirror || c.gutterMm ? { mirror: c.mirror, gutter_mm: c.gutterMm, gutter_position: c.gutterPosition } : undefined);
  };
  const paint = (): void => {
    const mirrored = mirror.input.checked;
    leftField.querySelector("label")!.textContent = mirrored ? "Inside (mm)" : "Left (mm)";
    rightField.querySelector("label")!.textContent = mirrored ? "Outside (mm)" : "Right (mm)";
    swap.root.hidden = !mirrored;
    position.root.querySelector<HTMLOptionElement>("option[value=right]")!.disabled = mirrored;
    if (mirrored && position.select.value === "right") position.select.value = "left";
    position.select.querySelector<HTMLOptionElement>("option[value=left]")!.textContent = mirrored ? "Inside" : "Left";
    picked.hidden = scope.select.value !== "sections";
    const c = read();
    preview.replaceChildren();
    if (c) {
      const d = dims();
      const pseudo: MarginPreset = { id: "custom", label: "Custom", margins: c.margins, mirror: c.mirror, gutterMm: c.gutterMm, detail: "" };
      const a = effectiveMargins(c.margins, { mirror: c.mirror, gutter_mm: c.gutterMm, gutter_position: c.gutterPosition }, 1);
      void a; void d;
      preview.appendChild(presetPreview(pseudo));
      const text = c.mirror
        ? `Right-hand pages: inside ${c.margins.left + (c.gutterPosition === "top" ? 0 : c.gutterMm)} mm, outside ${c.margins.right} mm. Left-hand pages: the other way round.`
        : `Left ${c.margins.left + (c.gutterPosition === "left" ? c.gutterMm : 0)} mm, right ${c.margins.right + (c.gutterPosition === "right" ? c.gutterMm : 0)} mm.`;
      preview.appendChild(h("span", { class: "muted", text: `${text} Gutter ${c.gutterMm} mm${c.gutterMm ? `, added once to the ${c.mirror ? "inside" : c.gutterPosition} margin` : ""}.` }));
    }
    const why = check();
    error.show(why);
  };
  preset.select.addEventListener("change", () => {
    const p = MARGIN_PRESETS.find((x) => x.id === preset.select.value);
    if (!p) return;
    top.value = String(p.margins.top); bottom.value = String(p.margins.bottom); left.value = String(p.margins.left); right.value = String(p.margins.right);
    gutter.value = String(p.gutterMm); mirror.input.checked = p.mirror; position.select.value = "left";
    paint();
  });
  for (const el of [top, bottom, left, right, gutter, mirror.input, swap.input, position.select, scope.select, orientation.select]) el.addEventListener("input", () => { preset.select.value = "custom"; paint(); });
  picked.addEventListener("change", paint);
  const body = h("div", { class: "stack margins-dialog" },
    notice("Inside is the margin beside the spine. Page 1 is a right-hand page, page 2 a left-hand page, and so on, whatever number is printed on them. The gutter is extra binding space added to the inside margin once.", "info"),
    h("div", { class: "grid-2" }, preset.root, orientation.root),
    h("div", { class: "grid-2" }, labelled("Top (mm)", top), labelled("Bottom (mm)", bottom)),
    h("div", { class: "grid-2" }, leftField, rightField),
    mirror.root,
    h("div", { class: "grid-2" }, labelled("Gutter width (mm)", gutter), position.root),
    swap.root,
    preview,
    scope.root, picked, error.el);
  paint();
  const handle = openDialog<true>({
    title: "Custom Margins", body, size: "wide",
    actions: [{ label: "Apply", kind: "primary", run: async () => {
      const why = check();
      if (why) { error.show(why); return undefined; }
      const c = read();
      if (!c) return undefined;
      const ok = await apply(ctx, c, "Margins applied");
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}

export const bookActive = (ctx: DocCtx): boolean => documentIsBook(ctx.ed.model.meta);
