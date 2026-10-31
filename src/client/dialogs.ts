/** Dialogs opened from the editor: header and footer, page setup, pictures, tables, equations, links, guides, comments. Each one reads the
 *  current document state, asks only for what the operation needs, and sends one undoable operation through the editor. */
import { announce, h, labelled, openDialog, toast } from "./kit.js";
import * as A from "./actions.js";
import type { DocCtx } from "./docctx.js";
import { errorText, rawPost } from "./net.js";
import { PAGE_MM } from "./textops.js";
import type { Block, Patch, Section } from "./types.js";
import { checkbox, errorLine, notice, selectField } from "./widgets.js";

/* ------------------------------------------------------------------------------------------------------ helpers */
function numberInput(value: number, min: number, max: number, step = 1): HTMLInputElement {
  return h("input", { type: "number", min, max, step, value: String(value), attrs: { inputmode: "decimal" } });
}
function sectionOfCaret(ctx: DocCtx): string | undefined {
  const sel = ctx.ed.recallSelection();
  const id = sel?.start.block ?? ctx.ed.model.order[0];
  return (id ? ctx.ed.model.block(id)?.section : undefined) ?? ctx.ed.model.meta.sections?.[0]?.id;
}
function sectionLabel(sections: Section[], id: string): string { const n = sections.findIndex((s) => s.id === id); return `Section ${n + 1}`; }

async function guarded(ctx: DocCtx, work: () => Promise<unknown>): Promise<boolean> {
  try { await work(); return true; } catch (error) {
    const stale = (error as { details?: { kind?: string } }).details?.kind === "stale_version";
    if (!stale) toast(errorText(error), { kind: "error" });
    ctx.ed.events.emit({ type: "error", error });
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------ header and footer */
export async function headerFooterDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const sections = ed.model.meta.sections ?? [];
  const sectionId = sectionOfCaret(ctx) ?? "s1";
  const target = sections.find((s) => s.id === sectionId) ?? ({ id: sectionId } as Section);
  const field = (value: string | undefined, label: string): HTMLInputElement => { const i = h("input", { type: "text", value: value ?? "", maxLength: 200, attrs: { "aria-label": label } }); return i; };
  const hl = field(target.header?.left, "Header, left"), hc = field(target.header?.center, "Header, centre"), hr = field(target.header?.right, "Header, right");
  const fl = field(target.footer?.left, "Footer, left"), fc = field(target.footer?.center, "Footer, centre"), fr = field(target.footer?.right, "Footer, right");
  const start = numberInput(target.numbering?.start ?? 1, 1, 99999);
  const restart = checkbox("Restart numbering in this section", target.numbering?.start !== undefined);
  const visible = checkbox("Show printed page numbers", target.role !== "cover" && target.numbering?.show !== false);
  restart.input.addEventListener("change", () => { start.disabled = !restart.input.checked; });
  start.disabled = !restart.input.checked;
  const format = selectField("Page number style", [["decimal", "1, 2, 3"], ["lower-roman", "i, ii, iii"], ["upper-roman", "I, II, III"], ["lower-alpha", "a, b, c"], ["upper-alpha", "A, B, C"]],
    String((target.numbering as { format?: string } | undefined)?.format ?? "decimal"));
  const all = sections.length > 1 ? checkbox("Apply to every section", false) : null;
  const row = (title: string, a: HTMLInputElement, b: HTMLInputElement, c: HTMLInputElement): HTMLElement =>
    h("fieldset", { class: "hf-row" }, h("legend", { text: title }), h("div", { class: "grid-3" }, labelled("Left", a), labelled("Centre", b), labelled("Right", c)));
  const body = h("div", { class: "stack" },
    sections.length > 1 ? h("p", { class: "muted", text: `Editing ${sectionLabel(sections, sectionId)}.` }) : null,
    notice("Use {page} for the page number, {pages} for the page count and {title} for the document title. These are filled in when the document is printed or exported; the on-screen page count is approximate.", "info"),
    row("Header", hl, hc, hr), row("Footer", fl, fc, fr),
    h("div", { class: "grid-2" }, labelled("First page number", start), format.root), restart.root, visible.root, all?.root ?? null);
  const handle = openDialog<true>({
    title: "Header and footer", size: "wide", body,
    actions: [{ label: "Apply", kind: "primary", run: async () => {
      const pack = (l: HTMLInputElement, c: HTMLInputElement, r: HTMLInputElement): Record<string, string> | null => {
        const out: Record<string, string> = {};
        if (l.value) out["left"] = l.value; if (c.value) out["center"] = c.value; if (r.value) out["right"] = r.value;
        return Object.keys(out).length ? out : null;
      };
      const ids = all?.input.checked ? sections.map((s) => s.id) : [sectionId];
      const numbering = { ...(restart.input.checked ? { start: Math.max(1, Math.round(Number(start.value) || 1)) } : {}),
        format: format.select.value, show: visible.input.checked };
      const ops = ids.map((id) => ({ op: "page_setup", section: id, header: pack(hl, hc, hr), footer: pack(fl, fc, fr), numbering }));
      const ok = await guarded(ctx, () => ed.op(ops.length === 1 ? (ops[0] as { op: string }) : { op: "batch", ops, label: "header and footer" }));
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}

/* ------------------------------------------------------------------------------------------------------ page setup */
const SIZES = ["A3", "A4", "A5", "B5", "Letter", "Legal", "Tabloid"];

export async function pageSetupDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const sections = ed.model.meta.sections ?? [];
  const sectionId = sectionOfCaret(ctx) ?? "s1";
  const g = ed.model.geometry(sectionId);
  const page = g.section.page ?? {};
  const current = page.width_mm && page.height_mm ? "custom" : page.size ?? "A4";
  const size = selectField("Paper size", [...SIZES.map((s) => [s, s] as [string, string]), ["custom", "Custom size…"]], SIZES.includes(current) || current === "custom" ? current : "A4");
  const orientation = selectField("Orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], page.orientation === "landscape" ? "landscape" : "portrait");
  const width = numberInput(Math.round(g.widthMm * 10) / 10, 50, 1000, 0.5), height = numberInput(Math.round(g.heightMm * 10) / 10, 50, 1000, 0.5);
  const margin = (v: number): HTMLInputElement => numberInput(v, 0, 200, 0.5);
  const top = margin(g.margins.top), right = margin(g.margins.right), bottom = margin(g.margins.bottom), left = margin(g.margins.left);
  const custom = h("div", { class: "grid-2" }, labelled("Width (mm)", width), labelled("Height (mm)", height));
  const all = sections.length > 1 ? checkbox("Apply to every section", false) : null;
  const error = errorLine();
  const sync = (): void => { custom.hidden = size.select.value !== "custom"; };
  size.select.addEventListener("change", sync);
  sync();
  const body = h("div", { class: "stack" },
    sections.length > 1 ? h("p", { class: "muted", text: `Editing ${sectionLabel(sections, sectionId)}.` }) : null,
    h("div", { class: "grid-2" }, size.root, orientation.root), custom,
    h("fieldset", {}, h("legend", { text: "Margins (mm)" }), h("div", { class: "grid-4" }, labelled("Top", top), labelled("Right", right), labelled("Bottom", bottom), labelled("Left", left))),
    notice("Pages on screen are laid out block by block, so the page count here is approximate. The exact count comes from Print preview, which uses the same layout as the exported PDF.", "info"),
    all?.root ?? null, error.el);
  const handle = openDialog<true>({
    title: "Page dimensions", body,
    actions: [{ label: "Apply", kind: "primary", run: async () => {
      error.show(null);
      const mm = (i: HTMLInputElement): number => Math.round((Number(i.value) || 0) * 2) / 2;
      const wMm = size.select.value === "custom" ? mm(width) : (PAGE_MM[size.select.value]?.[0] ?? 210);
      const hMm = size.select.value === "custom" ? mm(height) : (PAGE_MM[size.select.value]?.[1] ?? 297);
      const pageWidth = orientation.select.value === "landscape" ? Math.max(wMm, hMm) : Math.min(wMm, hMm);
      const pageHeight = orientation.select.value === "landscape" ? Math.min(wMm, hMm) : Math.max(wMm, hMm);
      const m = { top: mm(top), right: mm(right), bottom: mm(bottom), left: mm(left) };
      if (m.left + m.right > pageWidth - 25 || m.top + m.bottom > pageHeight - 25) { error.show("The margins leave less than 25 mm for text. Make them smaller."); return undefined; }
      const pageProps: Record<string, unknown> = size.select.value === "custom" ? { width_mm: pageWidth, height_mm: pageHeight, orientation: orientation.select.value, margins_mm: m } : { size: size.select.value, orientation: orientation.select.value, margins_mm: m };
      const ids = all?.input.checked ? sections.map((s) => s.id) : [sectionId];
      const ops = ids.map((id) => ({ op: "page_setup", section: id, page: pageProps }));
      const ok = await guarded(ctx, () => ed.op(ops.length === 1 ? (ops[0] as { op: string }) : { op: "batch", ops, label: "page setup" }));
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}

/* ------------------------------------------------------------------------------------------------------- pictures */
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Insert a picture. Describing it (alt text) is required unless it is marked decorative, so the document stays accessible. */
export async function pictureDialog(ctx: DocCtx, file: File, after: string | null): Promise<void> {
  const { ed } = ctx;
  if (!PICTURE_TYPES.includes(file.type)) { toast("Use a PNG, JPEG, GIF or WebP picture.", { kind: "error" }); return; }
  const preview = URL.createObjectURL(file);
  const alt = h("textarea", { rows: 3, maxLength: 500, attrs: { placeholder: "For example: A bar chart showing sales rising from 2020 to 2024" } });
  const decorative = checkbox("This picture is decoration only (screen readers skip it)", false);
  const caption = h("input", { type: "text", maxLength: 500 });
  const width = numberInput(Math.min(120, Math.round(ed.pageMm.w - 50)), 10, 400, 1);
  const error = errorLine();
  decorative.input.addEventListener("change", () => { alt.disabled = decorative.input.checked; });
  const body = h("div", { class: "stack" },
    h("img", { class: "picture-preview", attrs: { src: preview, alt: "Preview of the picture you chose" } }),
    labelled("Describe the picture", alt, { hint: "Say what the picture shows, for people who cannot see it." }),
    decorative.root, labelled("Caption (optional)", caption), labelled("Width (mm)", width), error.el);
  const handle = openDialog<true>({
    title: `Insert picture: ${file.name}`, body,
    actions: [{ label: "Insert picture", kind: "primary", run: async () => {
      error.show(null);
      if (!decorative.input.checked && !alt.value.trim()) { error.show("Describe the picture, or mark it as decoration."); alt.focus(); return undefined; }
      const ok = await guarded(ctx, () => ed.call(
        () => rawPost<{ patch: Patch }>(`/docs/${encodeURIComponent(ctx.sid)}/images`, file, file.type, { alt: alt.value.trim(), decorative: decorative.input.checked ? "1" : undefined, width: Math.round(Number(width.value) || 120), after: after ?? undefined, caption: caption.value.trim() || undefined }),
        (r) => r.patch));
      if (ok) announce("Picture inserted.");
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
  URL.revokeObjectURL(preview);
}

/** Edit the details of a picture that is already in the document. */
export async function figureDialog(ctx: DocCtx, block: Block): Promise<void> {
  const fig = block.figure;
  if (!fig) return;
  const alt = h("textarea", { rows: 3, maxLength: 500, value: fig.alt ?? "" });
  alt.disabled = fig.decorative === true;
  const decorative = checkbox("Decoration only", fig.decorative === true);
  decorative.input.addEventListener("change", () => { alt.disabled = decorative.input.checked; });
  const width = numberInput(Math.round(fig.width_mm ?? 120), 10, 400, 1);
  const align = selectField("Alignment", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], fig.align ?? "center");
  const credit = h("input", { type: "text", maxLength: 300, value: fig.credit ?? "" });
  const rights = h("input", { type: "text", maxLength: 300, value: fig.rights ?? "" });
  const caption = h("input", { type: "text", maxLength: 500, value: block.text });
  const error = errorLine();
  const handle = openDialog<true>({
    title: "Picture details", body: h("div", { class: "stack" }, labelled("Description (alt text)", alt), decorative.root, labelled("Caption", caption),
      h("div", { class: "grid-2" }, labelled("Width (mm)", width), align.root), labelled("Credit or source", credit, { hint: "Who made the picture, or where it came from. Only what you enter is shown." }), labelled("Rights or licence", rights), error.el),
    actions: [{ label: "Save details", kind: "primary", run: async () => {
      error.show(null);
      if (!decorative.input.checked && !alt.value.trim()) { error.show("Describe the picture, or mark it as decoration."); return undefined; }
      const props = { alt: decorative.input.checked ? "" : alt.value.trim(), decorative: decorative.input.checked ? true : null, width_mm: Math.round(Number(width.value) || 120), align: align.select.value, credit: credit.value.trim() || null, rights: rights.value.trim() || null };
      const ops: Array<{ op: string; [k: string]: unknown }> = [{ op: "figure_set", block: block.id, props }];
      if (caption.value !== block.text) ops.push({ op: "caption", block: block.id, text: caption.value });
      const ok = await guarded(ctx, () => ctx.ed.op({ op: "batch", ops, label: "picture details" }));
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}

/* -------------------------------------------------------------------------------------------------------- tables */
export async function tableDialog(ctx: DocCtx): Promise<void> {
  const rows = numberInput(3, 1, 200), cols = numberInput(3, 1, 40);
  const handle = openDialog<true>({
    title: "Insert table", size: "narrow", body: h("div", { class: "grid-2" }, labelled("Rows", rows), labelled("Columns", cols)),
    actions: [{ label: "Insert table", kind: "primary", run: async () => {
      const r = Math.max(1, Math.min(200, Math.round(Number(rows.value) || 3))), c = Math.max(1, Math.min(40, Math.round(Number(cols.value) || 3)));
      return (await guarded(ctx, () => A.insertTable(ctx.ed, r, c))) ? true : undefined;
    } }],
  });
  await handle.result;
}

/** Row, column and header-row tools for the table that holds the caret (or the selected table block). */
export async function tableToolsDialog(ctx: DocCtx, blockId: string): Promise<void> {
  const { ed } = ctx;
  const block = ed.model.block(blockId);
  if (!block?.table) return;
  const sel = ed.recallSelection();
  const row = sel?.start.block === blockId && sel.start.field === "cell" ? sel.start.row ?? 0 : 0;
  const col = sel?.start.block === blockId && sel.start.field === "cell" ? sel.start.col ?? 0 : 0;
  const t = block.table;
  const action = async (name: string, index: number, count?: number): Promise<void> => { await A.tableEdit(ed, blockId, name, index, count); };
  const header = numberInput(t.header_rows ?? 0, 0, t.rows.length);
  const btn = (label: string, run: () => Promise<unknown>): HTMLButtonElement => { const b = h("button", { class: "btn", type: "button", text: label }); b.addEventListener("click", () => { void run(); handle.close(); }); return b; };
  const handle = openDialog<true>({
    title: "Table tools", size: "narrow",
    body: h("div", { class: "stack" }, h("p", { class: "muted", text: `Row ${row + 1} of ${t.rows.length}, column ${col + 1} of ${t.columns}.` }),
      h("div", { class: "actions" }, btn("Insert row above", () => action("insert_row", row)), btn("Insert row below", () => action("insert_row", row + 1)), btn("Delete this row", () => action("delete_row", row))),
      h("div", { class: "actions" }, btn("Insert column left", () => action("insert_col", col)), btn("Insert column right", () => action("insert_col", col + 1)), btn("Delete this column", () => action("delete_col", col))),
      labelled("Header rows", header, { hint: "Header rows are marked for screen readers and repeat in exported files." })),
    actions: [{ label: "Set header rows", run: async (): Promise<true> => { await action("header_rows", 0, Math.max(0, Math.min(t.rows.length, Math.round(Number(header.value) || 0)))); return true as const; } }],
    cancelLabel: "Close",
  });
  await handle.result;
}

/* ------------------------------------------------------------------------------------------------------ equations */
const SYNTAXES: Array<[string, string]> = [["latex", "LaTeX (mathematics)"], ["mhchem", "Chemistry (mhchem)"], ["sequence", "Sequence (biology)"]];

/** Create or edit an equation. The source is stored exactly as typed; this screen shows it as text because Writer has no offline typesetter. */
export async function equationDialog(ctx: DocCtx, existing?: Block, inline = false): Promise<void> {
  const { ed } = ctx;
  const eq = existing?.equation;
  const syntax = selectField("Notation", SYNTAXES, eq?.syntax ?? "latex");
  const source = h("textarea", { rows: 4, maxLength: 2000, value: eq?.source ?? "", attrs: { spellcheck: "false", placeholder: "E = mc^2" } });
  const numbered = checkbox("Number this equation", eq?.numbered === true);
  const sel = ed.recallSelection();
  const handle = openDialog<true>({
    title: existing ? "Edit equation" : inline ? "Insert inline equation" : "Insert equation",
    body: h("div", { class: "stack" }, syntax.root, labelled("Equation source", source, { hint: "Writer keeps the source exactly as you type it and shows it as text. Typeset output appears in exported files only where the target format supports it." }), inline ? null : numbered.root),
    actions: [{ label: existing ? "Save equation" : "Insert", kind: "primary", run: async () => {
      const text = source.value.trim();
      if (!text) { toast("Type the equation first.", { kind: "info" }); return undefined; }
      const domain = syntax.select.value === "mhchem" ? "chemistry" : syntax.select.value === "sequence" ? "biology" : "mathematics";
      ed.refocus(sel);
      const ok = await guarded(ctx, async () => {
        if (existing) await ed.op({ op: "equation_set", block: existing.id, props: { syntax: syntax.select.value, source: text, domain, numbered: numbered.input.checked ? true : null } });
        else if (inline) await A.insertInlineEquation(ed, text, syntax.select.value);
        else await A.insertEquationBlock(ed, text, syntax.select.value);
      });
      return ok ? true : undefined;
    } }],
  });
  await handle.result;
}

/* ---------------------------------------------------------------------------------------------------------- links */
export async function linkDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const sel = ed.recallSelection();
  if (!sel) { toast("Select the text to link first.", { kind: "info" }); return; }
  const block = ed.model.block(sel.start.block);
  const existing = block?.spans?.find((s) => s.type === "link" && s.start <= sel.start.offset && s.end >= sel.start.offset)?.href ?? "";
  const url = h("input", { type: "url", value: existing, attrs: { placeholder: "https://example.org/", autocomplete: "off", spellcheck: "false" }, maxLength: 2000 });
  const error = errorLine();
  const handle = openDialog<"set" | "remove">({
    title: "Link", size: "narrow", body: h("div", { class: "stack" }, labelled("Address", url, { hint: "Links open only when you hold Ctrl (or Cmd) and click them, in a new tab." }), error.el),
    actions: [
      ...(existing ? [{ label: "Remove link", kind: "danger" as const, run: () => "remove" as const }] : []),
      { label: "Apply", kind: "primary", run: () => {
        error.show(null);
        const v = url.value.trim();
        if (!/^(https?:|mailto:)/i.test(v)) { error.show("Use an address that starts with https://, http:// or mailto:."); return undefined; }
        return "set" as const;
      } },
    ],
  });
  const choice = await handle.result;
  if (!choice) return;
  ed.refocus(sel);
  await A.setLink(ed, choice === "set" ? url.value.trim() : null);
}

/* ------------------------------------------------------------------------------------------------------ page colour */
export async function backgroundDialog(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  const current = ed.model.ext.background?.color ?? "#ffffff";
  const colour = h("input", { type: "color", value: /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#ffffff", attrs: { "aria-label": "Page colour" } });
  const handle = openDialog<"set" | "clear">({
    title: "Page background", size: "narrow",
    body: h("div", { class: "stack" }, labelled("Colour", colour), notice("Only a plain colour is supported. A background picture is not, because exported formats cannot reproduce it faithfully. Text colours are not changed, so check that the text stays readable.", "info")),
    actions: [{ label: "Use white", run: () => "clear" as const }, { label: "Apply", kind: "primary", run: () => "set" as const }],
  });
  const choice = await handle.result;
  if (!choice) return;
  await guarded(ctx, () => ed.op({ op: "ext_set", values: { background: choice === "set" ? { color: colour.value } : null }, label: "page background" }));
}

/* ----------------------------------------------------------------------------------------------------- comments */
export async function commentDialog(ctx: DocCtx): Promise<{ block: string; text: string; start?: number; end?: number } | null> {
  const sel = ctx.ed.recallSelection();
  const id = sel?.start.block;
  if (!sel || !id || sel.start.field !== "text") { toast("Place the cursor in a paragraph (or select some text) to add a comment.", { kind: "info" }); return null; }
  const quote = sel.collapsed ? "" : ctx.ed.selectionText(sel).slice(0, 200);
  const text = h("textarea", { rows: 4, maxLength: 4000 });
  const handle = openDialog<string>({
    title: "Add a comment", body: h("div", { class: "stack" }, quote ? h("blockquote", { class: "quote-preview", text: quote }) : h("p", { class: "muted", text: "The comment is attached to this paragraph." }), labelled("Comment", text)),
    actions: [{ label: "Add comment", kind: "primary", run: () => (text.value.trim() ? text.value.trim() : undefined) }],
  });
  const value = await handle.result;
  if (!value) return null;
  const out: { block: string; text: string; start?: number; end?: number } = { block: id, text: value };
  if (!sel.collapsed && sel.end.block === id) { out.start = sel.start.offset; out.end = sel.end.offset; }
  return out;
}
