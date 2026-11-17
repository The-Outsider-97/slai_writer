/** The Layout tab of the ribbon (Columns, Breaks, Page setup). Scripture is a paragraph style and lives in the Home tab's style list and the More Columns dialog. */
import { glyph, h, openDialog, openMenu, type MenuEntry } from "./kit.js";
import * as C from "./column_actions.js";
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { MAX_COLUMNS } from "./column_layout.js";
import { pageSetupDialog } from "./dialogs.js";
import { openMarginsMenu } from "./margins_ui.js";
import { checkbox, notice, selectField } from "./widgets.js";

const keep = (el: HTMLElement): void => { el.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) e.preventDefault(); }); };
const group = (label: string, ...nodes: HTMLElement[]): HTMLElement => h("div", { class: "ribbon-group" }, h("span", { class: "ribbon-controls" }, ...nodes), h("span", { class: "ribbon-group-label", text: label }));
const action = (label: string, run: () => void, icon: string, title = label): HTMLButtonElement => {
  const b = h("button", { class: "ribbon-action", type: "button", attrs: { title, "aria-label": title } }, glyph(icon), h("span", { text: label }));
  keep(b); b.addEventListener("click", run); return b;
};
const menuButton = (label: string, icon: string, entries: () => MenuEntry[], title = label): HTMLButtonElement => {
  const b = h("button", { class: "ribbon-action", type: "button", attrs: { title, "aria-label": title, "aria-haspopup": "menu" } }, glyph(icon), h("span", { text: `${label} ▾` }));
  keep(b); b.addEventListener("click", () => openMenu(b, entries(), { label })); return b;
};

const PRESETS: Array<{ label: string; columns: number; ratio?: number[] }> = [
  { label: "One", columns: 1 }, { label: "Two", columns: 2 }, { label: "Three", columns: 3 }, { label: "Four", columns: 4 },
  { label: "Left (narrow column on the left)", columns: 2, ratio: [1, 2] }, { label: "Right (narrow column on the right)", columns: 2, ratio: [2, 1] },
];

export function buildLayoutRibbon(ctx: DocCtx): { el: HTMLElement; update(): void } {
  const { ed } = ctx;
  const readOnly = (): boolean => ed.readOnly;
  const preset = (p: typeof PRESETS[number]): void => {
    const scope = C.defaultScope(ed);
    const at = C.columnsAtCaret(ed);
    const patch: C.ColumnPatch = { columns: p.columns };
    if (p.ratio) {
      const gap = at.gapMm, total = C.textWidthMm(ed, at.section) - gap * (p.columns - 1), sum = p.ratio.reduce((a, b) => a + b, 0);
      patch.widths_mm = p.ratio.map((r) => Math.round((total * r / sum) * 10) / 10);
    } else patch.widths_mm = null;
    void C.setColumns(ed, scope, patch);
  };
  const columns = menuButton("Columns", "layout", () => {
    const now = C.columnsAtCaret(ed);
    return [
      ...PRESETS.map((p): MenuEntry => ({ label: `${now.spec ? (now.spec.count === p.columns && !p.ratio && !now.spec.widthsMm ? "● " : "") : (p.columns === 1 && !p.ratio ? "● " : "")}${p.label}`, disabled: readOnly(), run: () => preset(p) })),
      "separator",
      { label: "More Columns…", disabled: readOnly(), run: () => { void columnsDialog(ctx); } },
    ];
  }, "Columns: how many columns the text is set in");
  const breaks = menuButton("Breaks", "page", () => [
    { label: "Page break", disabled: readOnly(), run: () => { void A.insertPageBreak(ed); } },
    { label: "Column break", disabled: readOnly(), run: () => { void C.insertColumnBreak(ed); } },
    { label: "Remove column break", disabled: readOnly(), run: () => { void C.removeColumnBreak(ed); } },
    "separator",
    { label: "Section break (new section from here)", disabled: readOnly(), run: () => { void A.sectionBreak(ed); } },
  ], "Breaks: page, column and section breaks");
  const marginsButton = h("button", { class: "ribbon-action margins-button", type: "button", attrs: { title: "Margins: presets, mirrored margins and the binding gutter", "aria-label": "Margins", "aria-haspopup": "menu" } }, glyph("book"), h("span", { text: "Margins ▾" }));
  keep(marginsButton); marginsButton.addEventListener("click", () => openMarginsMenu(ctx, marginsButton));
  const status = h("span", { class: "ribbon-style-label", attrs: { "aria-live": "polite" } });
  const el = h("div", { class: "format-ribbon layout-ribbon", attrs: { role: "toolbar", "aria-label": "Layout ribbon" } },
    group("Page Setup", marginsButton, action("Page setup", () => { void pageSetupDialog(ctx); }, "ruler", "Page size, orientation and margins")),
    group("Columns", columns, action("Column break", () => { void C.insertColumnBreak(ed); }, "page", "Column break: start the next column here"), status),
    group("Breaks", breaks));
  const update = (): void => {
    const now = C.columnsAtCaret(ed);
    status.textContent = now.spec ? `${now.spec.count} columns${now.spec.widthsMm ? " (unequal)" : ""}` : "One column";
  };
  return { el, update };
}

export async function columnsDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const now = C.columnsAtCaret(ed);
  const spec = now.spec;
  const count = h("select", { attrs: { "aria-label": "Number of columns" } }, ...Array.from({ length: MAX_COLUMNS }, (_, i) => h("option", { value: String(i + 1), text: String(i + 1) })));
  count.value = String(spec?.count ?? 1);
  const gap = h("input", { type: "number", min: 0, max: 50, step: 0.5, value: String(now.gapMm), attrs: { "aria-label": "Space between columns in millimetres" } });
  const equal = checkbox("Columns of equal width", !spec?.widthsMm);
  const widths = h("div", { class: "grid-4" });
  const widthInputs: HTMLInputElement[] = [];
  const total = C.textWidthMm(ed, now.section);
  const drawWidths = (): void => {
    const n = Number(count.value);
    widthInputs.length = 0;
    widths.replaceChildren();
    const g = Number(gap.value) || 0, each = Math.round(((total - g * (n - 1)) / n) * 10) / 10;
    for (let i = 0; i < n; i += 1) {
      const input = h("input", { type: "number", min: 10, max: 500, step: 0.5, value: String(spec?.widthsMm?.length === n ? spec.widthsMm[i] : each), attrs: { "aria-label": `Width of column ${i + 1} in millimetres` } });
      widthInputs.push(input);
      widths.appendChild(h("label", {}, h("span", { text: `Column ${i + 1} (mm)` }), input));
    }
  };
  const rule = checkbox("Line between columns", !!spec?.rule);
  const ruleColour = h("input", { type: "color", value: spec?.rule?.color ?? "#000000", attrs: { "aria-label": "Line colour" } });
  const ruleWidth = h("input", { type: "number", min: 0.25, max: 6, step: 0.25, value: String(spec?.rule?.width_pt ?? 0.75), attrs: { "aria-label": "Line thickness in points" } });
  const ruleStyle = selectField("Line style", [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]], spec?.rule?.style ?? "solid");
  const balance = checkbox("Balance column heights", !!spec?.balance);
  const flow = selectField("Flow order", [["ltr", "Left to right"], ["rtl", "Right to left"]], spec?.rtl ? "rtl" : "ltr");
  const selection = C.selectedBlocks(ed);
  const scopes: Array<[string, string]> = [["section", "This section"], ["document", "Whole document"], ["selection", "Selected text"]];
  const scope = selectField("Apply to", scopes, selection && !selection.collapsed ? "selection" : "section");
  const unequalNote = h("p", { class: "muted", text: "The page view shows equal columns while you type; the widths you set here are saved in the document and used when it is exported." });
  const sync = (): void => {
    const many = Number(count.value) > 1;
    equal.input.disabled = !many;
    widths.hidden = !many || equal.input.checked;
    unequalNote.hidden = widths.hidden;
    for (const control of [gap, rule.input, balance.input, flow.select]) control.disabled = !many;
    const line = !many || !rule.input.checked;
    ruleColour.disabled = ruleWidth.disabled = ruleStyle.select.disabled = line;
  };
  count.addEventListener("change", () => { drawWidths(); sync(); });
  equal.input.addEventListener("change", () => { drawWidths(); sync(); });
  gap.addEventListener("change", () => { if (!equal.input.checked) return; });
  rule.input.addEventListener("change", sync);
  drawWidths(); sync();
  const error = h("p", { class: "field-error", attrs: { role: "alert" } });
  error.hidden = true;
  const presetRow = h("div", { class: "preset-row" }, ...PRESETS.map((p) => {
    const b = h("button", { type: "button", class: "btn", text: p.label.split(" ")[0] ?? p.label, attrs: { title: p.label } });
    b.addEventListener("click", () => {
      count.value = String(p.columns); equal.input.checked = !p.ratio; drawWidths();
      if (p.ratio) { const g = Number(gap.value) || 0, sum = p.ratio.reduce((a, c) => a + c, 0); widthInputs.forEach((input, i) => { input.value = String(Math.round(((total - g * (p.columns - 1)) * (p.ratio?.[i] ?? 1) / sum) * 10) / 10); }); }
      sync();
    });
    return b;
  }));
  const handle = openDialog<true>({
    title: "Columns", size: "narrow",
    body: h("div", { class: "stack" }, h("div", { class: "field" }, h("span", { class: "muted", text: "Presets" }), presetRow),
      h("div", { class: "grid-2" }, h("label", {}, h("span", { text: "Number of columns" }), count), h("label", {}, h("span", { text: "Space between (mm)" }), gap)),
      equal.root, widths, unequalNote,
      rule.root, h("div", { class: "grid-3" }, h("label", {}, h("span", { text: "Colour" }), ruleColour), h("label", {}, h("span", { text: "Thickness (pt)" }), ruleWidth), ruleStyle.root),
      balance.root, flow.root, scope.root,
      notice("Columns are saved in the document's sections, so they come back when you reopen it and carry into the PDF, Word, RTF and OpenDocument exports.", "info"),
      error),
    actions: [{ label: "Apply", kind: "primary", run: async () => {
      error.hidden = true;
      const n = Number(count.value);
      const g = Number(gap.value);
      if (!Number.isFinite(g) || g < 0 || g > 50) { error.textContent = "The space between columns is 0 to 50 mm."; error.hidden = false; return undefined; }
      const patch: C.ColumnPatch = { columns: n };
      if (n > 1) {
        patch.gap_mm = g;
        patch.balance = balance.input.checked;
        patch.flow = flow.select.value as "ltr" | "rtl";
        patch.rule = rule.input.checked ? { color: ruleColour.value, width_pt: Number(ruleWidth.value) || 0.75, style: ruleStyle.select.value } : null;
        if (equal.input.checked) patch.widths_mm = null;
        else {
          const values = widthInputs.map((i) => Number(i.value));
          if (values.some((v) => !Number.isFinite(v) || v < 10)) { error.textContent = "Each column needs a width of at least 10 mm."; error.hidden = false; return undefined; }
          if (values.reduce((a, b) => a + b, 0) + g * (n - 1) > total + 0.5) { error.textContent = `The columns and the space between them are wider than the text area (${Math.round(total)} mm).`; error.hidden = false; return undefined; }
          patch.widths_mm = values;
        }
      }
      const ok = await C.setColumns(ed, scope.select.value as C.ColumnScope, patch);
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}
