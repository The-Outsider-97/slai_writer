/** Dialogs opened from the editor: header and footer, page setup, pictures, tables, equations, links, guides, comments. Each one reads the
 *  current document state, asks only for what the operation needs, and sends one undoable operation through the editor. */
import { announce, h, labelled, openDialog, toast } from "./kit.js";
import * as A from "./actions.js";
import { errorText, rawPost } from "./net.js";
import { PAGE_MM } from "./textops.js";
import { FONT_FAMILIES } from "./font_rules.js";
import { checkbox, errorLine, notice, selectField } from "./widgets.js";
/* ------------------------------------------------------------------------------------------------------ helpers */
function numberInput(value, min, max, step = 1) {
    return h("input", { type: "number", min, max, step, value: String(value), attrs: { inputmode: "decimal" } });
}
function sectionOfCaret(ctx) {
    const sel = ctx.ed.recallSelection();
    const id = sel?.start.block ?? ctx.ed.model.order[0];
    return (id ? ctx.ed.model.block(id)?.section : undefined) ?? ctx.ed.model.meta.sections?.[0]?.id;
}
function sectionLabel(sections, id) { const n = sections.findIndex((s) => s.id === id); return `Section ${n + 1}`; }
async function guarded(ctx, work) {
    try {
        await work();
        return true;
    }
    catch (error) {
        const stale = error.details?.kind === "stale_version";
        if (!stale)
            toast(errorText(error), { kind: "error" });
        ctx.ed.events.emit({ type: "error", error });
        return false;
    }
}
/* ------------------------------------------------------------------------------------------------ header and footer */
export async function headerFooterDialog(ctx) {
    const { ed } = ctx;
    const sections = ed.model.meta.sections ?? [];
    const sectionId = sectionOfCaret(ctx) ?? "s1";
    const target = sections.find((s) => s.id === sectionId) ?? { id: sectionId };
    const field = (value, label) => { const i = h("input", { type: "text", value: value ?? "", maxLength: 200, attrs: { "aria-label": label } }); return i; };
    const hl = field(target.header?.left, "Header, left"), hc = field(target.header?.center, "Header, centre"), hr = field(target.header?.right, "Header, right");
    const fl = field(target.footer?.left, "Footer, left"), fc = field(target.footer?.center, "Footer, centre"), fr = field(target.footer?.right, "Footer, right");
    // Each header/footer position owns its own typography. The six saved
    // positions are edited through one compact set of the standard font fields.
    const positions = ["left", "center", "right"];
    const formats = {
        header: structuredClone(target.header?.formats ?? {}), footer: structuredClone(target.footer?.formats ?? {}),
    };
    const runs = {
        header: structuredClone(target.header?.runs ?? {}), footer: structuredClone(target.footer?.runs ?? {}),
    };
    const fields = {
        header: { left: hl, center: hc, right: hr }, footer: { left: fl, center: fc, right: fr },
    };
    for (const edge of ["header", "footer"])
        for (const pos of positions) {
            fields[edge][pos].addEventListener("input", () => { delete runs[edge][pos]; });
        }
    const choice = selectField("Format text in", [["header:left", "Header — left"], ["header:center", "Header — centre"], ["header:right", "Header — right"],
        ["footer:left", "Footer — left"], ["footer:center", "Footer — centre"], ["footer:right", "Footer — right"]], "header:left");
    const fontFamily = h("input", { type: "text", maxLength: 100, attrs: { list: "writer-font-families", "aria-label": "Header or footer font family", placeholder: "Default font" } });
    const fonts = h("datalist", { attrs: { id: "writer-header-footer-fonts" } }, FONT_FAMILIES.map((name) => h("option", { value: name })));
    fontFamily.setAttribute("list", "writer-header-footer-fonts");
    const fontSize = h("input", { type: "number", min: 4, max: 400, step: 0.5, attrs: { "aria-label": "Header or footer font size", placeholder: "Default" } });
    const fontColor = h("input", { type: "color", value: "#000000", attrs: { "aria-label": "Header or footer font color" } });
    const useColor = checkbox("Custom font color", false);
    const isBold = checkbox("Bold", false), isItalic = checkbox("Italic", false), isUnderlined = checkbox("Underline", false);
    let selected = ["header", "left"];
    const storeFormat = () => {
        const [band, position] = selected;
        const out = {};
        const family = fontFamily.value.trim();
        if (family)
            out.font_family = family;
        if (fontSize.value)
            out.font_size_pt = Number(fontSize.value);
        if (useColor.input.checked)
            out.color = fontColor.value;
        if (isBold.input.checked)
            out.bold = true;
        if (isItalic.input.checked)
            out.italic = true;
        if (isUnderlined.input.checked)
            out.underline = true;
        if (Object.keys(out).length)
            formats[band][position] = out;
        else
            delete formats[band][position];
    };
    const selectedFormat = () => {
        const style = {};
        if (fontFamily.value.trim())
            style.font_family = fontFamily.value.trim();
        if (fontSize.value)
            style.font_size_pt = Number(fontSize.value);
        if (useColor.input.checked)
            style.color = fontColor.value;
        if (isBold.input.checked)
            style.bold = true;
        if (isItalic.input.checked)
            style.italic = true;
        if (isUnderlined.input.checked)
            style.underline = true;
        return style;
    };
    const applySelected = h("button", { type: "button", class: "btn", text: "Apply font to selected characters" });
    applySelected.addEventListener("click", () => {
        const [edge, pos] = selected;
        const input = fields[edge][pos];
        const start = input.selectionStart ?? 0, end = input.selectionEnd ?? 0;
        if (start >= end) {
            toast("First select characters inside the chosen header/footer text field.", { kind: "info" });
            input.focus();
            return;
        }
        const content = input.value;
        const existing = runs[edge][pos]?.map((r) => ({ text: r.text, format: r.format })) ?? [{ text: content }];
        const base = existing.map((r) => r.text).join("") === content ? existing : [{ text: content }];
        const changed = [];
        let cursor = 0;
        for (const item of base) {
            const stop = cursor + item.text.length;
            const a = Math.max(start, cursor), b = Math.min(end, stop);
            if (a > cursor)
                changed.push({ text: item.text.slice(0, a - cursor), ...(item.format ? { format: item.format } : {}) });
            if (b > a)
                changed.push({ text: item.text.slice(a - cursor, b - cursor), format: { ...item.format, ...selectedFormat() } });
            if (stop > Math.max(b, cursor))
                changed.push({ text: item.text.slice(Math.max(b, cursor) - cursor), ...(item.format ? { format: item.format } : {}) });
            cursor = stop;
        }
        if (changed.length > 200) {
            toast("Too many separately formatted ranges in this field.", { kind: "error" });
            return;
        }
        runs[edge][pos] = changed.filter((r) => r.text);
        toast("Character formatting will be saved when you click Apply.", { kind: "ok" });
    });
    const loadFormat = () => {
        const stored = formats[selected[0]][selected[1]] ?? {};
        fontFamily.value = stored.font_family ?? "";
        fontSize.value = stored.font_size_pt?.toString() ?? "";
        useColor.input.checked = !!stored.color;
        fontColor.value = /^#[0-9a-fA-F]{6}$/.test(stored.color ?? "") ? stored.color : "#000000";
        fontColor.disabled = !useColor.input.checked;
        isBold.input.checked = !!stored.bold;
        isItalic.input.checked = !!stored.italic;
        isUnderlined.input.checked = !!stored.underline;
    };
    choice.select.addEventListener("change", () => { storeFormat(); selected = choice.select.value.split(":"); loadFormat(); });
    useColor.input.addEventListener("change", () => { fontColor.disabled = !useColor.input.checked; });
    loadFormat();
    const start = numberInput(target.numbering?.start ?? 1, 1, 99999);
    const restart = checkbox("Restart numbering in this section", target.numbering?.start !== undefined);
    const visible = checkbox("Show printed page numbers", target.role !== "cover" && target.numbering?.show !== false);
    restart.input.addEventListener("change", () => { start.disabled = !restart.input.checked; });
    start.disabled = !restart.input.checked;
    const format = selectField("Page number style", [["decimal", "1, 2, 3"], ["lower-roman", "i, ii, iii"], ["upper-roman", "I, II, III"], ["lower-alpha", "a, b, c"], ["upper-alpha", "A, B, C"]], String(target.numbering?.format ?? "decimal"));
    const all = sections.length > 1 ? checkbox("Apply to every section", false) : null;
    const row = (title, a, b, c) => h("fieldset", { class: "hf-row" }, h("legend", { text: title }), h("div", { class: "grid-3" }, labelled("Left", a), labelled("Centre", b), labelled("Right", c)));
    const body = h("div", { class: "stack" }, sections.length > 1 ? h("p", { class: "muted", text: `Editing ${sectionLabel(sections, sectionId)}.` }) : null, notice("Use {page} for the page number, {pages} for the page count and {title} for the document title. These are filled in when the document is printed or exported; the on-screen page count is approximate.", "info"), row("Header", hl, hc, hr), row("Footer", fl, fc, fr), h("fieldset", { class: "hf-row" }, h("legend", { text: "Header and footer typography" }), h("p", { class: "fine", text: "Each left, centre and right field can have its own font, size, colour and emphasis. Leave font fields blank to keep the default." }), choice.root, fonts, h("div", { class: "grid-3" }, labelled("Font family", fontFamily), labelled("Size (pt)", fontSize), labelled("Color", fontColor)), h("div", { class: "actions" }, useColor.root, isBold.root, isItalic.root, isUnderlined.root), h("p", { class: "fine", text: "To mix fonts in one field, select characters in the matching Header/Footer input above, choose formatting, then press the button below." }), applySelected), h("div", { class: "grid-2" }, labelled("First page number", start), format.root), restart.root, visible.root, all?.root ?? null);
    const handle = openDialog({
        title: "Header and footer", size: "wide", body,
        actions: [{ label: "Apply", kind: "primary", run: async () => {
                    storeFormat();
                    if (fontFamily.value && /[\x00-\x1f\x7f{};<>\\"'`]/.test(fontFamily.value)) {
                        toast("Enter a valid font family.", { kind: "error" });
                        return undefined;
                    }
                    if (fontSize.value && (!Number.isFinite(Number(fontSize.value)) || Number(fontSize.value) < 4 || Number(fontSize.value) > 400)) {
                        toast("Font size must be 4–400 pt.", { kind: "error" });
                        return undefined;
                    }
                    const pack = (edge, l, c, r) => {
                        const out = {};
                        if (l.value)
                            out["left"] = l.value;
                        if (c.value)
                            out["center"] = c.value;
                        if (r.value)
                            out["right"] = r.value;
                        if (Object.keys(formats[edge]).length)
                            out.formats = formats[edge];
                        const rich = Object.fromEntries(positions.filter((pos) => runs[edge][pos]?.length &&
                            runs[edge][pos].map((x) => x.text).join("") === fields[edge][pos].value)
                            .map((pos) => [pos, runs[edge][pos]]));
                        if (Object.keys(rich).length)
                            out.runs = rich;
                        return l.value || c.value || r.value ? out : null;
                    };
                    const ids = all?.input.checked ? sections.map((s) => s.id) : [sectionId];
                    const numbering = { ...(restart.input.checked ? { start: Math.max(1, Math.round(Number(start.value) || 1)) } : {}),
                        format: format.select.value, show: visible.input.checked };
                    const ops = ids.map((id) => ({ op: "page_setup", section: id, header: pack("header", hl, hc, hr), footer: pack("footer", fl, fc, fr), numbering }));
                    const ok = await guarded(ctx, () => ed.op(ops.length === 1 ? ops[0] : { op: "batch", ops, label: "header and footer" }));
                    return ok ? true : undefined;
                } }],
    });
    await handle.result;
}
/* ------------------------------------------------------------------------------------------------------ page setup */
const SIZES = ["A3", "A4", "A5", "B5", "Letter", "Legal", "Tabloid"];
export async function pageSetupDialog(ctx) {
    const { ed } = ctx;
    const sections = ed.model.meta.sections ?? [];
    const sectionId = sectionOfCaret(ctx) ?? "s1";
    const g = ed.model.geometry(sectionId);
    const page = g.section.page ?? {};
    const current = page.width_mm && page.height_mm ? "custom" : page.size ?? "A4";
    const size = selectField("Paper size", [...SIZES.map((s) => [s, s]), ["custom", "Custom size…"]], SIZES.includes(current) || current === "custom" ? current : "A4");
    const orientation = selectField("Orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], page.orientation === "landscape" ? "landscape" : "portrait");
    const width = numberInput(Math.round(g.widthMm * 10) / 10, 50, 1000, 0.5), height = numberInput(Math.round(g.heightMm * 10) / 10, 50, 1000, 0.5);
    const margin = (v) => numberInput(v, 0, 200, 0.5);
    const top = margin(g.margins.top), right = margin(g.margins.right), bottom = margin(g.margins.bottom), left = margin(g.margins.left);
    const preset = selectField("Margin preset", [["custom", "Custom"], ["normal", "Normal (25 mm)"], ["narrow", "Narrow (15 mm)"], ["wide", "Wide (35 mm)"]], "custom");
    preset.select.addEventListener("change", () => {
        const value = { normal: 25, narrow: 15, wide: 35 }[preset.select.value];
        if (value === undefined)
            return;
        for (const input of [top, right, bottom, left])
            input.value = String(value);
    });
    const header = numberInput(g.headerMm, 0, 500, 0.5), footer = numberInput(g.footerMm, 0, 500, 0.5);
    const defaultHeader = checkbox("Automatic header position", page.header_mm === undefined);
    const defaultFooter = checkbox("Automatic footer position", page.footer_mm === undefined);
    const syncBand = () => { header.disabled = defaultHeader.input.checked; footer.disabled = defaultFooter.input.checked; };
    defaultHeader.input.addEventListener("change", syncBand);
    defaultFooter.input.addEventListener("change", syncBand);
    syncBand();
    const showRulers = checkbox("Show rulers", ctx.app.prefs.show_rulers);
    const showGuides = checkbox("Show editing guides", ctx.app.prefs.show_guides);
    const units = selectField("Ruler units", [["mm", "Millimetres"], ["in", "Inches"]], ctx.app.prefs.units);
    const custom = h("div", { class: "grid-2" }, labelled("Width (mm)", width), labelled("Height (mm)", height));
    const all = sections.length > 1 ? checkbox("Apply to every section", false) : null;
    const error = errorLine();
    const sync = () => { custom.hidden = size.select.value !== "custom"; };
    size.select.addEventListener("change", sync);
    sync();
    const body = h("div", { class: "stack" }, sections.length > 1 ? h("p", { class: "muted", text: `Editing ${sectionLabel(sections, sectionId)}.` }) : null, h("div", { class: "grid-2" }, size.root, orientation.root), custom, h("fieldset", {}, h("legend", { text: "Margins (mm)" }), preset.root, h("div", { class: "grid-4" }, labelled("Top", top), labelled("Right", right), labelled("Bottom", bottom), labelled("Left", left))), h("details", {}, h("summary", { text: "Header and footer positions" }), h("div", { class: "grid-2" }, labelled("Header distance from top (mm)", header), labelled("Footer distance from bottom (mm)", footer), defaultHeader.root, defaultFooter.root)), h("details", {}, h("summary", { text: "Ruler and guide preferences" }), h("div", { class: "stack" }, showRulers.root, showGuides.root, units.root)), notice("Pages on screen are laid out block by block, so the page count here is approximate. The exact count comes from Print preview, which uses the same layout as the exported PDF.", "info"), all?.root ?? null, error.el);
    const handle = openDialog({
        title: "Page dimensions", body,
        actions: [{ label: "Apply", kind: "primary", run: async () => {
                    error.show(null);
                    const mm = (i) => i.value.trim() ? Math.round(Number(i.value) * 2) / 2 : NaN;
                    const wMm = size.select.value === "custom" ? mm(width) : (PAGE_MM[size.select.value]?.[0] ?? 210);
                    const hMm = size.select.value === "custom" ? mm(height) : (PAGE_MM[size.select.value]?.[1] ?? 297);
                    const pageWidth = orientation.select.value === "landscape" ? Math.max(wMm, hMm) : Math.min(wMm, hMm);
                    const pageHeight = orientation.select.value === "landscape" ? Math.min(wMm, hMm) : Math.max(wMm, hMm);
                    const m = { top: mm(top), right: mm(right), bottom: mm(bottom), left: mm(left) };
                    if (![pageWidth, pageHeight, ...Object.values(m)].every((v) => Number.isFinite(v) && v >= 0)) {
                        error.show("Enter valid finite page dimensions and margins.");
                        return undefined;
                    }
                    if (m.left + m.right > pageWidth - 25 || m.top + m.bottom > pageHeight - 25) {
                        error.show("The margins leave less than 25 mm for text. Make them smaller.");
                        return undefined;
                    }
                    const headerMm = defaultHeader.input.checked ? null : mm(header);
                    const footerMm = defaultFooter.input.checked ? null : mm(footer);
                    if ((headerMm !== null && (!Number.isFinite(headerMm) || headerMm < 0)) ||
                        (footerMm !== null && (!Number.isFinite(footerMm) || footerMm < 0)) ||
                        (headerMm ?? 0) + (footerMm ?? 0) > pageHeight - 25) {
                        error.show("Header and footer positions must leave at least 25 mm between them.");
                        return undefined;
                    }
                    const pageProps = size.select.value === "custom" ? { width_mm: pageWidth, height_mm: pageHeight, orientation: orientation.select.value, margins_mm: m, header_mm: headerMm, footer_mm: footerMm } : { size: size.select.value, orientation: orientation.select.value, margins_mm: m, header_mm: headerMm, footer_mm: footerMm };
                    const ids = all?.input.checked ? sections.map((s) => s.id) : [sectionId];
                    const ops = ids.map((id) => ({ op: "page_setup", section: id, page: pageProps }));
                    const ok = await guarded(ctx, () => ed.op(ops.length === 1 ? ops[0] : { op: "batch", ops, label: "page setup" }));
                    if (ok) {
                        try {
                            await ctx.app.setPrefs({ show_rulers: showRulers.input.checked, show_guides: showGuides.input.checked, units: units.select.value });
                            ed.layout();
                        }
                        catch (e) {
                            toast(errorText(e), { kind: "error" });
                        }
                    }
                    return ok ? true : undefined;
                } }],
    });
    await handle.result;
}
/* ------------------------------------------------------------------------------------------------------- pictures */
const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Insert a picture. Describing it (alt text) is required unless it is marked decorative, so the document stays accessible. */
export async function pictureDialog(ctx, file, after) {
    const { ed } = ctx;
    if (!PICTURE_TYPES.includes(file.type)) {
        toast("Use a PNG, JPEG, GIF or WebP picture.", { kind: "error" });
        return;
    }
    const preview = URL.createObjectURL(file);
    const alt = h("textarea", { rows: 3, maxLength: 500, attrs: { placeholder: "For example: A bar chart showing sales rising from 2020 to 2024" } });
    const decorative = checkbox("This picture is decoration only (screen readers skip it)", false);
    const caption = h("input", { type: "text", maxLength: 500 });
    const width = numberInput(Math.min(120, Math.round(ed.pageMm.w - 50)), 10, 400, 1);
    const error = errorLine();
    decorative.input.addEventListener("change", () => { alt.disabled = decorative.input.checked; });
    const body = h("div", { class: "stack" }, h("img", { class: "picture-preview", attrs: { src: preview, alt: "Preview of the picture you chose" } }), labelled("Describe the picture", alt, { hint: "Say what the picture shows, for people who cannot see it." }), decorative.root, labelled("Caption (optional)", caption), labelled("Width (mm)", width), error.el);
    const handle = openDialog({
        title: `Insert picture: ${file.name}`, body,
        actions: [{ label: "Insert picture", kind: "primary", run: async () => {
                    error.show(null);
                    if (!decorative.input.checked && !alt.value.trim()) {
                        error.show("Describe the picture, or mark it as decoration.");
                        alt.focus();
                        return undefined;
                    }
                    const ok = await guarded(ctx, () => ed.call(() => rawPost(`/docs/${encodeURIComponent(ctx.sid)}/images`, file, file.type, { alt: alt.value.trim(), decorative: decorative.input.checked ? "1" : undefined, width: Math.round(Number(width.value) || 120), after: after ?? undefined, caption: caption.value.trim() || undefined }), (r) => r.patch));
                    if (ok)
                        announce("Picture inserted.");
                    return ok ? true : undefined;
                } }],
    });
    await handle.result;
    URL.revokeObjectURL(preview);
}
/** Edit the details of a picture that is already in the document. */
export async function figureDialog(ctx, block) {
    const fig = block.figure;
    if (!fig)
        return;
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
    const handle = openDialog({
        title: "Picture details", body: h("div", { class: "stack" }, labelled("Description (alt text)", alt), decorative.root, labelled("Caption", caption), h("div", { class: "grid-2" }, labelled("Width (mm)", width), align.root), labelled("Credit or source", credit, { hint: "Who made the picture, or where it came from. Only what you enter is shown." }), labelled("Rights or licence", rights), error.el),
        actions: [{ label: "Save details", kind: "primary", run: async () => {
                    error.show(null);
                    if (!decorative.input.checked && !alt.value.trim()) {
                        error.show("Describe the picture, or mark it as decoration.");
                        return undefined;
                    }
                    const props = { alt: decorative.input.checked ? "" : alt.value.trim(), decorative: decorative.input.checked ? true : null, width_mm: Math.round(Number(width.value) || 120), align: align.select.value, credit: credit.value.trim() || null, rights: rights.value.trim() || null };
                    const ops = [{ op: "figure_set", block: block.id, props }];
                    if (caption.value !== block.text)
                        ops.push({ op: "caption", block: block.id, text: caption.value });
                    const ok = await guarded(ctx, () => ctx.ed.op({ op: "batch", ops, label: "picture details" }));
                    return ok ? true : undefined;
                } }],
    });
    await handle.result;
}
/* -------------------------------------------------------------------------------------------------------- tables */
export async function tableDialog(ctx) {
    // Remember the caret before the modal steals focus. Never infer an insertion
    // anchor from an inactive browser selection when the user confirms.
    const selection = ctx.ed.recallSelection();
    const rows = numberInput(3, 1, 200), cols = numberInput(3, 1, 40);
    const handle = openDialog({
        title: "Insert table", size: "narrow", body: h("div", { class: "grid-2" }, labelled("Rows", rows), labelled("Columns", cols)),
        actions: [{ label: "Insert table", kind: "primary", run: async () => {
                    const r = Math.max(1, Math.min(200, Math.round(Number(rows.value) || 3))), c = Math.max(1, Math.min(40, Math.round(Number(cols.value) || 3)));
                    return await A.insertTable(ctx.ed, r, c, selection) ? true : undefined;
                } }],
    });
    await handle.result;
}
/** Row, column and header-row tools for the table that holds the caret (or the selected table block). */
export async function tableToolsDialog(ctx, blockId) {
    const { ed } = ctx;
    const block = ed.model.block(blockId);
    if (!block?.table)
        return;
    const sel = ed.recallSelection();
    const row = sel?.start.block === blockId && sel.start.field === "cell" ? sel.start.row ?? 0 : 0;
    const col = sel?.start.block === blockId && sel.start.field === "cell" ? sel.start.col ?? 0 : 0;
    const t = block.table;
    const action = async (name, index, count) => { await A.tableEdit(ed, blockId, name, index, count); };
    const header = numberInput(t.header_rows ?? 0, 0, t.rows.length);
    const btn = (label, run) => { const b = h("button", { class: "btn", type: "button", text: label }); b.addEventListener("click", () => { void run(); handle.close(); }); return b; };
    const handle = openDialog({
        title: "Table tools", size: "narrow",
        body: h("div", { class: "stack" }, h("p", { class: "muted", text: `Row ${row + 1} of ${t.rows.length}, column ${col + 1} of ${t.columns}.` }), h("div", { class: "actions" }, btn("Insert row above", () => action("insert_row", row)), btn("Insert row below", () => action("insert_row", row + 1)), btn("Delete this row", () => action("delete_row", row))), h("div", { class: "actions" }, btn("Insert column left", () => action("insert_col", col)), btn("Insert column right", () => action("insert_col", col + 1)), btn("Delete this column", () => action("delete_col", col))), labelled("Header rows", header, { hint: "Header rows are marked for screen readers and repeat in exported files." })),
        actions: [{ label: "Set header rows", run: async () => { await action("header_rows", 0, Math.max(0, Math.min(t.rows.length, Math.round(Number(header.value) || 0)))); return true; } }],
        cancelLabel: "Close",
    });
    await handle.result;
}
/* ------------------------------------------------------------------------------------------------------ equations */
const SYNTAXES = [["latex", "LaTeX (mathematics)"], ["mhchem", "Chemistry (mhchem)"], ["sequence", "Sequence (biology)"]];
/** Create or edit an equation. The source is stored exactly as typed; this screen shows it as text because Writer has no offline typesetter. */
export async function equationDialog(ctx, existing, inline = false) {
    const { ed } = ctx;
    const eq = existing?.equation;
    const syntax = selectField("Notation", SYNTAXES, eq?.syntax ?? "latex");
    const source = h("textarea", { rows: 4, maxLength: 2000, value: eq?.source ?? "", attrs: { spellcheck: "false", placeholder: "E = mc^2" } });
    const numbered = checkbox("Number this equation", eq?.numbered === true);
    const sel = ed.recallSelection();
    const handle = openDialog({
        title: existing ? "Edit equation" : inline ? "Insert inline equation" : "Insert equation",
        body: h("div", { class: "stack" }, syntax.root, labelled("Equation source", source, { hint: "Writer keeps the source exactly as you type it and shows it as text. Typeset output appears in exported files only where the target format supports it." }), inline ? null : numbered.root),
        actions: [{ label: existing ? "Save equation" : "Insert", kind: "primary", run: async () => {
                    const text = source.value.trim();
                    if (!text) {
                        toast("Type the equation first.", { kind: "info" });
                        return undefined;
                    }
                    const domain = syntax.select.value === "mhchem" ? "chemistry" : syntax.select.value === "sequence" ? "biology" : "mathematics";
                    ed.refocus(sel);
                    const ok = await guarded(ctx, async () => {
                        if (existing)
                            await ed.op({ op: "equation_set", block: existing.id, props: { syntax: syntax.select.value, source: text, domain, numbered: numbered.input.checked ? true : null } });
                        else if (inline)
                            await A.insertInlineEquation(ed, text, syntax.select.value);
                        else
                            await A.insertEquationBlock(ed, text, syntax.select.value);
                    });
                    return ok ? true : undefined;
                } }],
    });
    await handle.result;
}
/* ---------------------------------------------------------------------------------------------------------- links */
export async function linkDialog(ctx) {
    const { ed } = ctx;
    const sel = ed.recallSelection();
    if (!sel) {
        toast("Select the text to link first.", { kind: "info" });
        return;
    }
    const block = ed.model.block(sel.start.block);
    const existing = block?.spans?.find((s) => s.type === "link" && s.start <= sel.start.offset && s.end >= sel.start.offset)?.href ?? "";
    const url = h("input", { type: "url", value: existing, attrs: { placeholder: "https://example.org/", autocomplete: "off", spellcheck: "false" }, maxLength: 2000 });
    const error = errorLine();
    const handle = openDialog({
        title: "Link", size: "narrow", body: h("div", { class: "stack" }, labelled("Address", url, { hint: "Links open only when you hold Ctrl (or Cmd) and click them, in a new tab." }), error.el),
        actions: [
            ...(existing ? [{ label: "Remove link", kind: "danger", run: () => "remove" }] : []),
            { label: "Apply", kind: "primary", run: () => {
                    error.show(null);
                    const v = url.value.trim();
                    if (!/^(https?:|mailto:)/i.test(v)) {
                        error.show("Use an address that starts with https://, http:// or mailto:.");
                        return undefined;
                    }
                    return "set";
                } },
        ],
    });
    const choice = await handle.result;
    if (!choice)
        return;
    ed.refocus(sel);
    await A.setLink(ed, choice === "set" ? url.value.trim() : null);
}
/* ------------------------------------------------------------------------------------------------------ page colour */
/** A page colour is precisely one opaque six-digit RGB value, never a CSS expression. */
export function parsePageColour(value) {
    if (typeof value !== "string")
        return null;
    const candidate = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toLowerCase() : null;
}
export async function backgroundDialog(ctx) {
    const { ed } = ctx;
    const current = ed.model.ext.background?.color ?? "#ffffff";
    const colour = h("input", { type: "color", value: /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#ffffff", attrs: { "aria-label": "Page colour" } });
    const handle = openDialog({
        title: "Page background", size: "narrow",
        body: h("div", { class: "stack" }, labelled("Colour", colour), notice("Only a plain colour is supported. A background picture is not, because exported formats cannot reproduce it faithfully. Text colours are not changed, so check that the text stays readable.", "info")),
        actions: [{ label: "Use white", run: () => "clear" }, { label: "Apply", kind: "primary", run: () => "set" }],
    });
    const choice = await handle.result;
    if (!choice)
        return;
    const selected = parsePageColour(colour.value);
    if (choice === "set" && selected === null) {
        toast("Choose an RGB colour in #rrggbb format.", { kind: "error" });
        return;
    }
    await guarded(ctx, () => ed.op({ op: "ext_set", values: { background: choice === "set" ? { color: selected } : null }, label: "page background" }));
}
/* ----------------------------------------------------------------------------------------------------- comments */
export async function commentDialog(ctx) {
    const sel = ctx.ed.recallSelection();
    const id = sel?.start.block;
    if (!sel || !id || sel.start.field !== "text") {
        toast("Place the cursor in a paragraph (or select some text) to add a comment.", { kind: "info" });
        return null;
    }
    const quote = sel.collapsed ? "" : ctx.ed.selectionText(sel).slice(0, 200);
    const text = h("textarea", { rows: 4, maxLength: 4000 });
    const handle = openDialog({
        title: "Add a comment", body: h("div", { class: "stack" }, quote ? h("blockquote", { class: "quote-preview", text: quote }) : h("p", { class: "muted", text: "The comment is attached to this paragraph." }), labelled("Comment", text)),
        actions: [{ label: "Add comment", kind: "primary", run: () => (text.value.trim() ? text.value.trim() : undefined) }],
    });
    const value = await handle.result;
    if (!value)
        return null;
    const out = { block: id, text: value };
    if (!sel.collapsed && sel.end.block === id) {
        out.start = sel.start.offset;
        out.end = sel.end.offset;
    }
    return out;
}
