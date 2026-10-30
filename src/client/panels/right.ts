/** The right panel: Pages / Chapters / Sections, Layers, Page Background and Illustrations. */
import { chevron, dico, type DesignIcon } from "../dico.js";
import { confirmDialog, glyph, h, promptDialog, toast } from "../kit.js";
import * as A from "../actions.js";
import { backgroundDialog, figureDialog, pageSetupDialog, pictureDialog } from "../dialogs.js";
import type { DocCtx, Panel } from "../docctx.js";
import { errorText } from "../net.js";
import { layerList, layerOf, type LayerRow } from "../model.js";
import type { Block } from "../types.js";
import { button, fill, pickFile, statusBadge } from "../widgets.js";

export interface RightPanel extends Panel { openSection(id: "sections" | "layers" | "background" | "illustrations"): void }

export const RIGHT_SECTIONS: Array<{ id: "sections" | "layers" | "background" | "illustrations"; label: string; icon: DesignIcon }> = [
  { id: "sections", label: "Pages / Chapters / Sections", icon: "r-sections" },
  { id: "layers", label: "Layers", icon: "r-layers" },
  { id: "background", label: "Page Background", icon: "r-background" },
  { id: "illustrations", label: "Illustrations", icon: "r-illustrations" },
];

export function createRightPanel(ctx: DocCtx): RightPanel {
  const { ed } = ctx;
  const root = h("div", { class: "side-right-inner" });
  /* Each section is a native disclosure: the icon, the name and a chevron as in the design, closed until the person opens it. */
  const section = (id: string, label: string, icon: DesignIcon): HTMLElement => h("details", { class: "rsec", data: { id } }, h("summary", {}, dico(icon), h("span", { class: "rname", text: label }), chevron("down", "rchev")));
  const [sectionBox, layerBox, bgBox, figBox] = RIGHT_SECTIONS.map((x) => section(x.id, x.label, x.icon)) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
  fill(root, sectionBox, layerBox, bgBox, figBox);
  const fresh = (box: HTMLElement, ...children: Array<HTMLElement | null>): void => { while (box.children.length > 1) box.removeChild(box.lastChild as Node); fill(box, children); };

  const paint = (): void => {
    /* pages, chapters and sections */
    const pages = h("ul", {}, ed.page.sheets.map((sheet, i) => {
      const b = h("button", { type: "button", class: ed.currentPage() === i + 1 ? "current" : "", text: `Page ${i + 1}`, attrs: { "aria-current": ed.currentPage() === i + 1 ? "page" : null } });
      b.addEventListener("click", () => sheet.el.scrollIntoView({ block: "start" }));
      return h("li", {}, b);
    }));
    const heads = ed.model.headings();
    const chapters = h("ul", {}, heads.length ? heads.map((x) => {
      const b = h("button", { type: "button", text: x.text || "(empty heading)", css: { "padding-left": `${0.4 + (x.level - 1) * 0.8}rem` } });
      b.addEventListener("click", () => ed.scrollToBlock(x.id, 0));
      return h("li", {}, b);
    }) : [h("li", { class: "muted pad", text: "No headings yet. Use Heading 1–3 to make chapters." })]);
    const sections = ed.model.meta.sections ?? [];
    const sectionList = h("ul", {}, sections.length ? sections.map((s, i) => {
      const first = ed.model.list().find((b) => b.section === s.id);
      const b = h("button", { type: "button", text: `Section ${i + 1}${first ? `: ${first.text.slice(0, 28) || (first.type === "paragraph" ? "(empty)" : first.type)}` : ""}` });
      b.addEventListener("click", () => { if (first) ed.scrollToBlock(first.id, 0); });
      const setup = h("button", { class: "linkbtn", type: "button", text: "Page setup", disabled: ed.readOnly });
      setup.addEventListener("click", () => { if (first) ed.focusBlock(first.id, 0); void pageSetupDialog(ctx); });
      return h("li", {}, b, setup);
    }) : [h("li", { class: "muted pad", text: "One section for the whole document. Use “Section break” to start another with its own page setup." })]);
    fresh(sectionBox, h("h3", { text: `Pages (${ed.page.total}, approximate)` }), pages, h("h3", { text: "Chapters" }), chapters, h("h3", { text: "Sections" }), sectionList);

    /* layers */
    const rows = layerList(ed.model.ext);
    const toggle = async (id: string, patch: { visible?: boolean; locked?: boolean }): Promise<void> => {
      try { await A.writeLayers(ed, rows.map((r) => (r.id === id ? { ...r, ...patch } : r)), ed.model.ext.layer_of ?? {}); } catch (e) { toast(errorText(e), { kind: "error" }); }
    };
    const count = (id: string): number => ed.model.list().filter((b) => layerOf(b, ed.model.ext) === id).length;
    const rename = async (row: LayerRow): Promise<void> => {
      const name = await promptDialog({ title: "Rename layer", label: "Layer name", value: row.name, confirmLabel: "Rename", maxLength: 80 });
      if (name) await A.renameLayer(ed, row.id, name);
    };
    const remove = async (row: LayerRow): Promise<void> => {
      if (await confirmDialog({ title: `Delete ${row.name}?`, message: `What is on ${row.name} goes back to its own layer. Nothing in the document is deleted.`, confirmLabel: "Delete layer", danger: true })) await A.deleteLayer(ed, row.id);
    };
    const newLayerButton = button("New layer", () => { void A.newLayer(ed); }, "", "layers");
    newLayerButton.disabled = ed.readOnly;
    newLayerButton.title = "New layer (Ctrl+Alt+Shift+N)";
    fresh(layerBox, h("ul", {}, rows.map((l) => {
      const vis = h("button", { class: "iconbtn small", type: "button", attrs: { "aria-pressed": String(l.visible), "aria-label": `${l.visible ? "Hide" : "Show"} the ${l.name} layer`, title: `${l.visible ? "Hide" : "Show"} ${l.name}` } }, glyphOf(l.visible ? "eye" : "eye-off"));
      vis.addEventListener("click", () => { void toggle(l.id, { visible: !l.visible }); });
      const lock = h("button", { class: "iconbtn small", type: "button", disabled: ed.readOnly, attrs: { "aria-pressed": String(l.locked), "aria-label": `${l.locked ? "Unlock" : "Lock"} the ${l.name} layer`, title: `${l.locked ? "Unlock" : "Lock"} ${l.name}` } }, glyphOf(l.locked ? "lock" : "unlock"));
      lock.addEventListener("click", () => { void toggle(l.id, { locked: !l.locked }); });
      const here = h("button", { class: "linkbtn", type: "button", text: "Move selection here", disabled: ed.readOnly, attrs: { "aria-label": `Move the selected text or object onto the ${l.name} layer` } });
      here.addEventListener("click", () => { const ids = A.selectedBlockIds(ed); if (!ids.length) { toast("Place the cursor in the text, or select an object, first.", { kind: "info" }); return; } void A.moveToLayer(ed, l.id, ids); });
      const extra: HTMLElement[] = [];
      if (l.custom) {
        const ren = h("button", { class: "linkbtn", type: "button", text: "Rename", disabled: ed.readOnly });
        ren.addEventListener("click", () => { void rename(l); });
        const del = h("button", { class: "linkbtn", type: "button", text: "Delete", disabled: ed.readOnly });
        del.addEventListener("click", () => { void remove(l); });
        extra.push(ren, del);
      }
      const what = l.what ?? `${count(l.id)} item${count(l.id) === 1 ? "" : "s"}`;
      return h("li", { class: "layer-row" }, h("span", { class: "grow" }, h("strong", { text: l.name }), h("small", { class: "muted", text: ` ${what}` })), l.visible ? null : statusBadge("Hidden", "idle"), l.locked ? statusBadge("Locked", "warn") : null, vis, lock, here, ...extra);
    })), newLayerButton, h("p", { class: "fine", text: "A hidden layer is hidden on screen only. It is still in the file and in exports. A locked layer cannot be edited here. A new layer starts empty; use Move selection here to put text or objects on it." }));

    /* background */
    const colour = ed.model.ext.background?.color;
    fresh(bgBox, h("p", {}, h("span", { class: "swatch", css: { background: colour ?? "#ffffff" }, attrs: { "aria-hidden": "true" } }), ` ${colour ? colour.toUpperCase() : "White (default)"}`),
      button("Change colour…", () => backgroundDialog(ctx), "", "palette"));

    /* illustrations */
    const figures = ed.model.list().filter((b) => b.type === "figure");
    const add = button("Insert picture…", async () => {
      const [file] = await pickFile("image/png,image/jpeg,image/gif,image/webp");
      if (file) await pictureDialog(ctx, file, A.anchorBlock(ed));
    }, "", "image");
    add.disabled = ed.readOnly;
    fresh(figBox, h("ul", {}, figures.length ? figures.map((f, i) => figureRow(f, i)) : [h("li", { class: "muted pad", text: "No pictures yet." })]), add);
  };

  const figureRow = (f: Block, i: number): HTMLElement => {
    const go = h("button", { type: "button", text: f.text || `Picture ${i + 1}` });
    go.addEventListener("click", () => ed.scrollToBlock(f.id));
    const edit = h("button", { class: "linkbtn", type: "button", text: "Details", disabled: ed.readOnly });
    edit.addEventListener("click", () => { void figureDialog(ctx, f); });
    const missing = !f.figure?.decorative && !f.figure?.alt;
    return h("li", {}, go, missing ? statusBadge("No description", "warn") : f.figure?.decorative ? statusBadge("Decorative", "idle") : null, edit);
  };

  const off = ed.events.on((e) => { if (e.type === "layout" || e.type === "reloaded") schedule(); });
  let timer: number | undefined;
  const schedule = (): void => { window.clearTimeout(timer); timer = window.setTimeout(paint, 150); };
  paint();
  const boxes = { sections: sectionBox, layers: layerBox, background: bgBox, illustrations: figBox } as const;
  const openSection = (id: keyof typeof boxes): void => { const box = boxes[id] as HTMLDetailsElement; box.open = true; box.querySelector<HTMLElement>("summary")?.focus(); };
  return { el: root, refresh: paint, openSection, destroy: () => { off(); window.clearTimeout(timer); } };
}

function glyphOf(name: string): SVGSVGElement { return glyph(name); }
