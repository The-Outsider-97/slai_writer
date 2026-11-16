/** The "Text Box" ribbon tab: it appears when a text box is selected and reuses the shape controls (fill, outline, corners, size, position, arrange)
 *  through the same `shape_set` operation, plus text and paragraph formatting for the text inside. */
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { glyph, h, toast } from "./kit.js";
import { errorText } from "./net.js";
import { shapeOf, type ShapeData } from "./shape.js";
import { readShapeNumber, shapeNumberInput, showShapeNumber } from "./shape_format.js";
import { TEXTBOX_MIN_MM, textBoxOf, type TextBoxAlign, type TextBoxRole } from "./textbox.js";
import { activeTextBoxId, applyTextBoxAction, changeTextBox, closeTextBoxEditor, openTextBoxEditor, textBoxFormatState, type ToggleKey } from "./textbox_edit.js";

type Group = (label: string, ...items: HTMLElement[]) => HTMLElement;

export const WRAPPING: ReadonlyArray<readonly [string, string, string]> = [
  ["inline", "In Line with Text", "The box sits in the text flow like a paragraph."],
  ["front", "In Front of Text", "The box floats over the text."],
  ["behind", "Behind Text", "The box floats behind the text."],
  ["top_bottom", "Top and Bottom", "Text stops above the box and continues below it."],
];

/** Which wrapping a shape has now. */
export function wrappingOf(shape: ShapeData): string {
  const layout = shape.layout;
  if (!layout || layout.mode === "inline") return "inline";
  if (layout.wrap === "top_bottom") return "top_bottom";
  return layout.layer === "behind_text" ? "behind" : "front";
}

/** The block a floating text box is anchored to: the first ordinary block on the box's own page. */
function anchorOnPage(ctx: DocCtx, id: string): string | null {
  const sheet = ctx.ed.els.get(id)?.closest<HTMLElement>(".sheet");
  const found = sheet?.querySelector<HTMLElement>(".blk[data-id]:not([data-floating])")?.dataset["id"];
  return found && found !== id ? found : ctx.ed.model.order.find((other) => other !== id) ?? null;
}

export function buildTextBoxRibbon(ctx: DocCtx, group: Group, button: (label: string, action: () => void, icon: string) => HTMLButtonElement): { el: HTMLElement; update(): void; selected(): { id: string; shape: ShapeData } | null } {
  const { ed } = ctx;
  const selected = (): { id: string; shape: ShapeData } | null => {
    const id = ed.selectedBlock;
    const shape = shapeOf(id ? ed.model.block(id) : undefined);
    return id && shape && textBoxOf(shape) ? { id, shape } : null;
  };
  const guard = (task: () => Promise<unknown> | unknown): void => { void Promise.resolve().then(task).catch((error: unknown) => toast(errorText(error), { kind: "error" })); };
  const change = (mutate: (shape: ShapeData) => void, label: string): void => {
    const id = selected()?.id;
    if (id) guard(() => changeTextBox(ed, id, mutate, label));
  };
  const act = (action: Parameters<typeof applyTextBoxAction>[2]): void => {
    const id = selected()?.id;
    if (id) guard(() => applyTextBoxAction(ed, id, action));
  };
  const keep = (node: HTMLElement): void => { node.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) e.preventDefault(); }); };
  const number = (label: string, min: number, max: number, step: number, apply: (value: number) => void): HTMLInputElement => {
    const node = shapeNumberInput(label, min, min, max, step);
    node.classList.add("ribbon-number");
    node.addEventListener("change", () => {
      try { apply(readShapeNumber(node, min, max)); } catch (error) { toast(errorText(error), { kind: "error" }); update(); node.addEventListener("blur", () => update(), { once: true }); }   // the field shows the real value again once it is left
    });
    return node;
  };
  const field = (label: string, node: HTMLElement): HTMLElement => h("label", { class: "ribbon-field" }, h("span", { class: "ribbon-field-label", text: label }), node);
  const toggle = (label: string, content: string | Element, onClick: () => void): HTMLButtonElement => {
    const b = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": label, title: label, "aria-pressed": "false" } }, content);
    keep(b); b.addEventListener("click", onClick); return b;
  };
  const select = (label: string, options: ReadonlyArray<readonly [string, string]>, onChange: (value: string) => void): HTMLSelectElement => {
    const s = h("select", { attrs: { "aria-label": label, title: label } }, options.map(([value, text]) => h("option", { value, text })));
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  /* ---- text ---- */
  const style = select("Paragraph style in the text box", [], (value) => styleChoice(value));
  const family = h("input", { class: "ribbon-family", type: "text", maxLength: 100, attrs: { "aria-label": "Text box font family", list: "writer-font-families", autocomplete: "off", spellcheck: "false", placeholder: "Font" } });
  family.addEventListener("change", () => { const v = family.value.trim(); if (v) act({ kind: "format", props: { font_family: v } }); });
  const size = number("Text box font size (pt)", 5, 144, 0.5, (v) => act({ kind: "format", props: { font_size_pt: v } }));
  const flags: Array<[ToggleKey, string, string, string]> = [["bold", "Bold", "B", "bold"], ["italic", "Italic", "I", "italic"], ["underline", "Underline", "U", "underline"],
    ["strike", "Strikethrough", "S", "strike"], ["superscript", "Superscript", "x²", "sup"], ["subscript", "Subscript", "x₂", "sub"]];
  const flagButtons = new Map<ToggleKey, HTMLButtonElement>();
  for (const [key, label, text] of flags) {
    const b = toggle(label, text, () => act({ kind: "toggle", key }));
    b.dataset["flag"] = key; b.style.fontWeight = key === "bold" ? "700" : ""; b.style.fontStyle = key === "italic" ? "italic" : "";
    flagButtons.set(key, b);
  }
  const ink = h("input", { type: "color", value: "#171717", attrs: { "aria-label": "Text box text color", title: "Text color" } });
  ink.addEventListener("change", () => act({ kind: "format", props: { color: ink.value } }));
  const marker = h("input", { type: "color", value: "#ffff00", attrs: { "aria-label": "Text box highlight color", title: "Highlight" } });
  marker.addEventListener("change", () => act({ kind: "format", props: { background: marker.value } }));
  const clear = button("Clear Formatting", () => act({ kind: "clear-format" }), "close");

  /* ---- paragraph ---- */
  const aligns: Array<[TextBoxAlign, string, string]> = [["left", "Align left", "align-left"], ["center", "Align center", "align-center"], ["right", "Align right", "align-right"], ["justify", "Justify", "align-justify"]];
  const alignButtons = new Map<string, HTMLButtonElement>();
  for (const [value, label, icon] of aligns) {
    const b = toggle(label, glyph(icon), () => act({ kind: "paragraph", attrs: { align: value } }));
    alignButtons.set(value, b);
  }
  const bullets = toggle("Bulleted list", glyph("list"), () => act({ kind: "paragraph", attrs: { list: textBoxStateAttrs().list === "bullet" ? null : "bullet" } }));
  const numbered = toggle("Numbered list", glyph("list-ordered"), () => act({ kind: "paragraph", attrs: { list: textBoxStateAttrs().list === "number" ? null : "number" } }));
  const valign = select("Vertical alignment in the text box", [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]], (v) => change((s) => { (s.textbox as NonNullable<ShapeData["textbox"]>).vertical_align = v as "top" | "middle" | "bottom"; }, "text box alignment"));
  const lineHeight = select("Line spacing in the text box", [["1", "Single"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "Double"]], (v) => act({ kind: "paragraph", attrs: { line_height: Number(v) } }));
  const spaceAfter = number("Space after paragraph in the text box (pt)", 0, 72, 1, (v) => act({ kind: "paragraph", attrs: { space_after_pt: v } }));
  const padding = number("Padding inside the text box (mm)", 0, 100, 0.5, (v) => change((s) => { s.text.padding_mm = Math.min(v, s.width_mm / 4, s.height_mm / 4); }, "text box padding"));

  /* ---- fill and outline (the shape controls) ---- */
  const fillColor = h("input", { type: "color", value: "#ffffff", attrs: { "aria-label": "Text box fill color", title: "Fill color" } });
  fillColor.addEventListener("change", () => { const v = fillColor.value; change((s) => { s.fill.color = v; s.fill.enabled = true; }, "text box fill"); });
  const fillOpacity = number("Fill opacity (%)", 0, 100, 5, (v) => change((s) => { s.fill.opacity = v / 100; }, "text box fill"));
  const noFill = button("No Fill", () => change((s) => { s.fill.enabled = false; }, "text box fill"), "close");
  const outlineColor = h("input", { type: "color", value: "#202020", attrs: { "aria-label": "Text box border color", title: "Border color" } });
  outlineColor.addEventListener("change", () => { const v = outlineColor.value; change((s) => { s.outline.color = v; s.outline.enabled = true; }, "text box border"); });
  const outlineWidth = number("Border thickness (pt)", 0.1, 72, 0.5, (v) => change((s) => { s.outline.width_pt = v; s.outline.enabled = true; }, "text box border"));
  const outlineStyle = select("Border style", [["none", "No border"], ["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]], (v) =>
    change((s) => { if (v === "none") s.outline.enabled = false; else { s.outline.enabled = true; s.outline.style = v as ShapeData["outline"]["style"]; } }, "text box border"));
  const opacity = number("Text box opacity (%)", 0, 100, 5, (v) => change((s) => { s.opacity = v / 100; }, "text box opacity"));
  const radius = number("Corner radius (mm)", 0, 500, 0.5, (v) => change((s) => { const r = Math.min(v, s.width_mm / 2, s.height_mm / 2); s.corners_mm = [r, r, r, r]; }, "text box corners"));
  const square = button("Square Corners", () => change((s) => { s.corners_mm = [0, 0, 0, 0]; }, "text box corners"), "layers");
  const rounded = button("Rounded Corners", () => change((s) => { const r = Math.min(4, s.width_mm / 2, s.height_mm / 2); s.corners_mm = [r, r, r, r]; }, "text box corners"), "layers");

  /* ---- size and position ---- */
  const width = number("Width (mm)", TEXTBOX_MIN_MM.width, 1000, 1, (v) => change((s) => { s.width_mm = v; s.corners_mm = s.corners_mm.map((c) => Math.min(c, v / 2, s.height_mm / 2)); s.text.padding_mm = Math.min(s.text.padding_mm, v / 4, s.height_mm / 4); }, "text box size"));
  const height = number("Height (mm)", TEXTBOX_MIN_MM.height, 1000, 1, (v) => change((s) => { s.height_mm = v; s.corners_mm = s.corners_mm.map((c) => Math.min(c, s.width_mm / 2, v / 2)); s.text.padding_mm = Math.min(s.text.padding_mm, s.width_mm / 4, v / 4); }, "text box size"));
  const autoExpand = h("input", { type: "checkbox", attrs: { "aria-label": "Auto-expand: the box grows to fit its text" } });
  autoExpand.addEventListener("change", () => { const v = autoExpand.checked; change((s) => { (s.textbox as NonNullable<ShapeData["textbox"]>).auto_expand = v; }, "text box auto-expand"); });
  const posX = number("Horizontal position (mm)", -5000, 5000, 1, (v) => change((s) => { if (s.layout?.mode === "floating") s.layout.x_mm = v; }, "text box position"));
  const posY = number("Vertical position (mm)", -5000, 5000, 1, (v) => change((s) => { if (s.layout?.mode === "floating") s.layout.y_mm = v; }, "text box position"));
  const wrapping = select("Text wrapping", WRAPPING.map(([v, t]) => [v, t] as const), (value) => {
    const id = selected()?.id;
    if (!id) return;
    change((s) => {
      const keep = s.layout?.mode === "floating" ? s.layout : undefined;
      if (value === "inline") { s.layout = { mode: "inline" }; return; }
      const target = keep?.anchor === "block" ? keep.target : anchorOnPage(ctx, id);
      s.layout = { mode: "floating", anchor: target ? "block" : "page", ...(target ? { target } : {}), x_mm: keep?.x_mm ?? 0, y_mm: keep?.y_mm ?? 0,
        wrap: value === "top_bottom" ? "top_bottom" : "none", layer: value === "behind" ? "behind_text" : value === "front" ? "in_front_of_text" : "content" };
    }, "text box wrapping");
  });
  const square_wrap = h("option", { value: "square", text: "Square (not available)", attrs: { disabled: "", title: "Writer's page layout cannot flow text beside an object yet. Use Top and Bottom." } });
  wrapping.appendChild(square_wrap);
  const anchor = select("Anchor", [["block", "To paragraph"], ["page", "To page"]], (value) => change((s) => {
    const l = s.layout;
    if (!l || l.mode !== "floating") return;
    if (value === "page") { s.layout = { mode: "floating", anchor: "page", x_mm: l.x_mm ?? 0, y_mm: l.y_mm ?? 0, wrap: "none", layer: l.layer === "behind_text" ? "behind_text" : "in_front_of_text" }; }
    else { const target = anchorOnPage(ctx, selected()?.id ?? ""); if (target) s.layout = { ...l, anchor: "block", target }; }
  }, "text box anchor"));

  /* ---- arrange, pin, lock ---- */
  const zRange = (): { lo: number; hi: number } => {
    let lo = 0, hi = 0;
    for (const block of ed.model.list()) { const z = shapeOf(block)?.z_index; if (typeof z === "number") { lo = Math.min(lo, z); hi = Math.max(hi, z); } }
    return { lo, hi };
  };
  const forward = button("Bring Forward", () => change((s) => { s.z_index = Math.min(1000, (s.z_index ?? 0) + 1); }, "text box order"), "arrow-up");
  const backward = button("Send Backward", () => change((s) => { s.z_index = Math.max(-1000, (s.z_index ?? 0) - 1); }, "text box order"), "arrow-down");
  const front = button("Bring to Front", () => change((s) => { s.z_index = Math.min(1000, zRange().hi + 1); }, "text box order"), "arrow-up");
  const back = button("Send to Back", () => change((s) => { s.z_index = Math.max(-1000, zRange().lo - 1); }, "text box order"), "arrow-down");
  const duplicate = button("Duplicate", () => {
    const pair = selected();
    if (!pair) return;
    const next = structuredClone(pair.shape);
    delete next.group_id;
    const box = next.textbox as NonNullable<ShapeData["textbox"]>;
    box.pinned = false; box.locked = false;
    if (next.layout?.mode === "floating") { next.layout.x_mm = (next.layout.x_mm ?? 0) + 6; next.layout.y_mm = (next.layout.y_mm ?? 0) + 6; }
    guard(async () => { const id = await A.insertBlock(ed, { type: "paragraph", text: "", extensions: { "slai.writer.shape": next } }, pair.id); if (id) A.selectBlock(ed, id); });
  }, "copy");
  const remove = button("Delete", () => { const id = selected()?.id; if (id) guard(async () => { await closeTextBoxEditor(false); await A.deleteBlocks(ed, [id]); }); }, "trash");
  const pin = toggle("Pin Position", glyph("pin"), () => change((s) => { const b = s.textbox as NonNullable<ShapeData["textbox"]>; b.pinned = !b.pinned; }, "pin text box"));
  pin.classList.remove("iconbtn"); pin.classList.add("ribbon-action"); pin.replaceChildren(glyph("pin"), h("span", { text: "Pin Position" }));
  const lock = toggle("Lock Object", glyph("lock"), () => change((s) => { const b = s.textbox as NonNullable<ShapeData["textbox"]>; b.locked = !b.locked; }, "lock text box"));
  lock.classList.remove("iconbtn"); lock.classList.add("ribbon-action"); lock.replaceChildren(glyph("lock"), h("span", { text: "Lock Object" }));
  const name = h("input", { type: "text", maxLength: 80, attrs: { "aria-label": "Text box name", placeholder: "Name" } });
  name.addEventListener("change", () => { const v = name.value.trim(); change((s) => { const b = s.textbox as NonNullable<ShapeData["textbox"]>; if (v) b.name = v; else delete b.name; }, "name text box"); });
  const edit = button("Edit Text", () => { const id = selected()?.id; if (id) openTextBoxEditor(ed, id); }, "paragraph");

  const el = h("div", { class: "format-ribbon references-ribbon textbox-ribbon", attrs: { role: "toolbar", "aria-label": "Text Box ribbon" } },
    group("Text", style, family, size, ...flagButtons.values(), ink, marker, clear),
    group("Paragraph", ...alignButtons.values(), bullets, numbered, lineHeight, spaceAfter, valign, edit),
    group("Shape Fill", fillColor, noFill, field("Opacity %", fillOpacity)),
    group("Shape Outline", outlineColor, field("Thickness (pt)", outlineWidth), outlineStyle),
    group("Corners", field("Radius (mm)", radius), square, rounded),
    group("Size", field("Width", width), field("Height", height), field("Padding", padding), field("Auto-expand", autoExpand)),
    group("Position", field("X (mm)", posX), field("Y (mm)", posY), wrapping, anchor),
    group("Arrange", forward, backward, front, back, field("Opacity %", opacity)),
    group("Pin / Lock", pin, lock, field("Name", name), duplicate, remove));

  function textBoxStateAttrs(): { list?: string } {
    const id = selected()?.id;
    return (id ? textBoxFormatState(ed, id)?.attrs : undefined) ?? {};
  }
  function styleChoice(value: string): void {
    const id = selected()?.id;
    if (id) guard(() => applyStyleChoice(ed, id, value));
  }

  const refreshStyles = (): void => {
    const names = Object.keys(ed.model.meta.styles?.paragraph ?? {}).filter((n) => !["Body Text", "Scripture", "Title", "Subtitle", "Slogan", "Author", "Document Date", "TOC Title"].includes(n));
    const options: Array<[string, string]> = [["role:normal", "Normal text"], ["role:heading1", "Heading 1"], ["role:heading2", "Heading 2"], ["role:heading3", "Heading 3"], ["role:quote", "Quote"],
      ["style:Title", "Title"], ["style:Subtitle", "Subtitle"], ["style:Slogan", "Slogan"], ["style:Author", "Author"], ["style:Scripture", "Scripture"], ...names.map((n) => [`style:${n}`, n] as [string, string])];
    const have = [...style.options].map((o) => o.value).join("|");
    if (have !== options.map(([v]) => v).join("|")) style.replaceChildren(...options.map(([value, text]) => h("option", { value, text })));
  };

  const update = (): void => {
    const pair = selected();
    if (!pair) return;
    refreshStyles();
    const { shape } = pair;
    const box = shape.textbox as NonNullable<ShapeData["textbox"]>;
    const locked = Boolean(box.locked), pinned = Boolean(box.pinned);
    const idle = (n: Element): boolean => document.activeElement !== n;
    if (idle(width)) width.value = showShapeNumber(shape.width_mm, 1);
    if (idle(height)) height.value = showShapeNumber(shape.height_mm, 1);
    if (idle(padding)) padding.value = showShapeNumber(shape.text.padding_mm, 1);
    if (idle(fillOpacity)) fillOpacity.value = showShapeNumber(shape.fill.opacity * 100, 0);
    if (idle(opacity)) opacity.value = showShapeNumber(shape.opacity * 100, 0);
    if (idle(outlineWidth)) outlineWidth.value = showShapeNumber(shape.outline.width_pt, 1);
    if (idle(radius)) radius.value = showShapeNumber(Math.max(...shape.corners_mm), 1);
    const floating = shape.layout?.mode === "floating";
    if (idle(posX)) posX.value = showShapeNumber(floating ? shape.layout?.x_mm ?? 0 : 0, 1);
    if (idle(posY)) posY.value = showShapeNumber(floating ? shape.layout?.y_mm ?? 0 : 0, 1);
    fillColor.value = shape.fill.color; outlineColor.value = shape.outline.color; ink.value = shape.text.color;
    outlineStyle.value = shape.outline.enabled ? shape.outline.style : "none";
    wrapping.value = wrappingOf(shape);
    anchor.value = shape.layout?.mode === "floating" && shape.layout.anchor === "page" ? "page" : "block";
    valign.value = box.vertical_align ?? "top";
    autoExpand.checked = Boolean(box.auto_expand);
    if (idle(name)) name.value = box.name ?? "";
    // The label says what pressing does, so it is the state too (no separate "pressed" to read as the opposite).
    const pinText = pinned ? "Unpin Position" : "Pin Position", lockText = locked ? "Unlock Object" : "Lock Object";
    pin.removeAttribute("aria-pressed"); lock.removeAttribute("aria-pressed");
    pin.querySelector("span")!.textContent = pinText; pin.setAttribute("aria-label", pinText); pin.title = pinText;
    lock.querySelector("span")!.textContent = lockText; lock.setAttribute("aria-label", lockText); lock.title = lockText;
    const state = textBoxFormatState(ed, pair.id);
    if (state) {
      for (const [key, b] of flagButtons) b.setAttribute("aria-pressed", String(state.toggles[key]));
      for (const [value, b] of alignButtons) b.setAttribute("aria-pressed", String((state.attrs.align ?? shape.text.align) === value));
      bullets.setAttribute("aria-pressed", String(state.attrs.list === "bullet")); numbered.setAttribute("aria-pressed", String(state.attrs.list === "number"));
      const pt = state.fmt.font_size_pt;
      if (idle(size)) size.value = typeof pt === "number" ? showShapeNumber(pt, 1) : showShapeNumber(shape.text.font_size_pt, 1);
      if (idle(family)) family.value = typeof state.fmt.font_family === "string" ? state.fmt.font_family : shape.text.font_family ?? "";
      const current = state.attrs.style ? `style:${state.attrs.style}` : `role:${state.attrs.role ?? "normal"}`;
      if (idle(style)) { if (![...style.options].some((o) => o.value === current) && state.attrs.style) style.appendChild(h("option", { value: current, text: state.attrs.style })); style.value = current; }
    }
    // Pinned: position is fixed (the box can still be edited and resized). Locked: nothing but the lock itself changes.
    const frozen = [width, height, padding, fillColor, fillOpacity, noFill, outlineColor, outlineWidth, outlineStyle, opacity, radius, square, rounded, autoExpand, valign,
      style, family, size, ink, marker, clear, ...flagButtons.values(), ...alignButtons.values(), bullets, numbered, lineHeight, spaceAfter, forward, backward, front, back, name, edit, remove, wrapping, anchor, posX, posY];
    for (const control of frozen) (control as HTMLButtonElement).disabled = locked;
    for (const control of [posX, posY, wrapping, anchor]) (control as HTMLInputElement).disabled = locked || pinned || (!floating && control !== wrapping);
    duplicate.disabled = false;
  };
  return { el, update, selected };
}

/** Home → Paragraph Styles (and this ribbon) applied inside a text box: typography only. The Scripture style does not add columns inside a box. */
export async function applyStyleChoice(ed: DocCtx["ed"], id: string, value: string): Promise<void> {
  const [kind, name] = value.split(":", 2) as [string, string];
  if (kind === "role") await applyTextBoxAction(ed, id, { kind: "paragraph", attrs: { role: name as TextBoxRole, style: null } });
  else await applyTextBoxAction(ed, id, { kind: "paragraph", attrs: { style: name, role: null } });
}

/** The Home tab's style list, mapped to what a text box can hold. Returns false for a style that cannot live in a box. */
export function homeStyleToBox(choice: string): { role?: TextBoxRole | null; style?: string | null; list?: "bullet" | "number" | null } | null {
  if (choice === "paragraph") return { role: null, style: null, list: null };
  if (choice === "h1" || choice === "h2" || choice === "h3") return { role: `heading${choice.slice(1)}` as TextBoxRole, style: null };
  if (choice === "quote") return { role: "quote", style: null };
  if (choice === "bullets") return { list: "bullet" };
  if (choice === "numbered") return { list: "number" };
  if (choice === "scripture") return { style: "Scripture", role: null };
  const named: Record<string, string> = { "style-title": "Title", "style-subtitle": "Subtitle", "style-slogan": "Slogan", "style-author": "Author", "style-document-date": "Document Date", "style-toc-title": "TOC Title" };
  if (named[choice]) return { style: named[choice] as string, role: null };
  if (choice.startsWith("user:")) return { style: choice.slice(5), role: null };
  return null;
}
export { activeTextBoxId };
