/** Insert → Text Box: a gallery of starting styles, drawing the box on the page, or dropping a default-sized one on the page you are looking at.
 *  Every route ends in one `block_insert` of a shape carrier (the same object the shape tools move, resize and export), then puts the cursor in it. */
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { announce, h, openDialog, toast } from "./kit.js";
import { errorText } from "./net.js";
import { SHAPE_KEY, type ShapeData } from "./shape.js";
import { beginShapePlacement } from "./shape_placement.js";
import { TEXTBOX_PRESETS, type TextBoxPreset } from "./textbox.js";
import { openTextBoxEditor } from "./textbox_edit.js";
import { MM_PX } from "./textops.js";
import { checkbox } from "./widgets.js";

/** The sheet that shows most of the visible area. */
function visibleSheet(ctx: DocCtx): HTMLElement | null {
  const view = ctx.ed.page.scroller.getBoundingClientRect();
  let best: HTMLElement | null = null, bestOverlap = 0;
  for (const sheet of ctx.ed.page.sheets) {
    const r = sheet.el.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top));
    if (overlap > bestOverlap) { best = sheet.el; bestOverlap = overlap; }
  }
  return best;
}

/** Put a text box of the preset's size on the page in view, near its top, without covering a box already there. */
export async function addTextBox(ctx: DocCtx, preset: TextBoxPreset = TEXTBOX_PRESETS[0] as TextBoxPreset): Promise<string | undefined> {
  const { ed } = ctx;
  if (ed.readOnly) return undefined;
  if (ed.bands.active) { drawTextBox(ctx, preset); return undefined; }           // in a header or footer a text box is drawn onto the page (it goes into that header or footer)
  const shape: ShapeData = preset.build();
  const sheet = visibleSheet(ctx);
  const body = sheet?.querySelector<HTMLElement>(".body") ?? null;
  const view = ed.page.scroller.getBoundingClientRect();
  const zoom = ed.page.zoom || 1;
  const bodyW = body ? body.clientWidth / MM_PX : 170;
  const bodyH = body ? body.clientHeight / MM_PX : 250;
  const top = body ? Math.max(0, (Math.max(view.top, body.getBoundingClientRect().top) + 40 - body.getBoundingClientRect().top) / zoom / MM_PX) : 20;
  const existing = sheet ? sheet.querySelectorAll(".writer-shape[data-textbox]").length : 0;
  const x = Math.max(0, Math.min(bodyW - shape.width_mm, (bodyW - shape.width_mm) / 2 + existing * 6));
  // Below the text already on the page when there is room (so a new box does not cover what is written), else near the top of the view.
  const lastBlock = sheet ? Array.from(sheet.querySelectorAll<HTMLElement>(".blk[data-id]:not([data-floating])")).pop() : undefined;
  const below = body && lastBlock ? (lastBlock.getBoundingClientRect().bottom - body.getBoundingClientRect().top) / zoom / MM_PX + 6 : null;
  const wanted = below !== null && below + shape.height_mm <= bodyH ? below : top;
  const y = Math.max(0, Math.min(bodyH - shape.height_mm, wanted + existing * 6));
  const anchor = sheet?.querySelector<HTMLElement>(".blk[data-id]:not([data-floating])")?.dataset["id"] ?? ed.model.order[ed.model.order.length - 1] ?? null;
  shape.layout = { mode: "floating", anchor: anchor ? "block" : "page", ...(anchor ? { target: anchor } : {}), x_mm: Math.round(x * 10) / 10, y_mm: Math.round(y * 10) / 10, wrap: "none", layer: "in_front_of_text" };
  try {
    const id = await A.insertBlock(ed, { type: "paragraph", text: "", extensions: { [SHAPE_KEY]: shape } }, anchor);
    if (id) {
      A.selectBlock(ed, id);
      announce(`${preset.label} inserted`);
      window.setTimeout(() => openTextBoxEditor(ed, id), 0);
    }
    return id;
  } catch (error) { toast(errorText(error), { kind: "error" }); return undefined; }
}

/** Crosshair mode: drag to draw the box, click for the preset's own size. Escape cancels. */
export function drawTextBox(ctx: DocCtx, preset: TextBoxPreset = TEXTBOX_PRESETS[0] as TextBoxPreset): void {
  beginShapePlacement(ctx, "rectangle", { template: preset.build(), label: "Text box", edit: true });
}

function previewTile(preset: TextBoxPreset): HTMLElement {
  const s = preset.build();
  const sample = h("div", { class: "tb-gallery-sample", text: "Abc" });
  sample.style.background = s.fill.enabled ? s.fill.color : "transparent";
  sample.style.color = s.text.color;
  sample.style.border = s.outline.enabled ? `${Math.max(1, s.outline.width_pt)}px ${s.outline.style === "double" ? "double" : s.outline.style} ${s.outline.color}` : "1px dashed rgba(128,128,128,.35)";
  sample.style.borderRadius = `${Math.min(14, (s.corners_mm[0] ?? 0) * 2.5)}px`;
  sample.style.fontWeight = s.text.bold ? "700" : "400";
  sample.style.fontStyle = s.textbox?.paragraphs[0]?.role === "quote" ? "italic" : "normal";
  sample.style.textAlign = s.text.align;
  if (s.text.font_family) sample.style.fontFamily = `"${s.text.font_family}", serif`;
  return sample;
}

/** The Insert → Text Box dialog. */
export async function insertTextBox(ctx: DocCtx): Promise<void> {
  if (ctx.ed.readOnly) return;
  const draw = checkbox("Draw the box on the page (drag to size it)", false);
  const grid = h("div", { class: "tb-gallery", attrs: { role: "group", "aria-label": "Text box styles" } });
  const handle = openDialog<true>({ title: "Insert Text Box", body: h("div", {}, grid, draw.root), cancelLabel: "Cancel" });
  for (const preset of TEXTBOX_PRESETS) {
    const tile = h("button", { type: "button", class: "tb-gallery-item", attrs: { "aria-label": `Insert ${preset.label}: ${preset.hint}`, "data-preset": preset.id } },
      previewTile(preset), h("span", { class: "tb-gallery-name", text: preset.label }), h("span", { class: "tb-gallery-hint", text: preset.hint }));
    tile.addEventListener("click", () => {
      const drawn = draw.input.checked;
      handle.close();
      if (drawn) drawTextBox(ctx, preset); else void addTextBox(ctx, preset);
    });
    grid.appendChild(tile);
  }
  await handle.result;
}
