/** The table tabs of the ribbon (Table Design, Table Layout), the style gallery and the table dialogs.
 *
 *  Both tabs appear while the caret is in a table. Everything here calls table_actions.ts, which sends the server's table operations. */
import { glyph, h, openDialog, openMenu, promptDialog } from "./kit.js";
import * as T from "./table_actions.js";
import { customTableStyles } from "./render.js";
import { GALLERY, OPTION_KEYS, STYLE_KEY, resolveTable, styleOptions, borderCss } from "./table_style.js";
import { checkbox, selectField } from "./widgets.js";
const keep = (el) => { el.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement))
    e.preventDefault(); }); };
const OPTION_LABELS = { header_row: "Header Row", first_column: "First Column", banded_rows: "Banded Rows", banded_columns: "Banded Columns" };
const BORDER_LABELS = [["all", "All borders"], ["outside", "Outside borders"], ["inside", "Inside borders"], ["inside_h", "Inside horizontal"],
    ["inside_v", "Inside vertical"], ["top", "Top border"], ["bottom", "Bottom border"], ["left", "Left border"], ["right", "Right border"], ["none", "No border"]];
const num = (value, min, max, step, label) => h("input", { type: "number", min, max, step, value: String(value), attrs: { "aria-label": label, inputmode: "decimal" } });
const field = (label, node) => h("label", { class: "ribbon-field", attrs: { title: label } }, h("span", { class: "ribbon-field-label", text: label }), node);
const group = (label, ...nodes) => h("div", { class: "ribbon-group" }, h("span", { class: "ribbon-controls" }, ...nodes), h("span", { class: "ribbon-group-label", text: label }));
const action = (label, run, icon = "table", title = label) => {
    const b = h("button", { class: "ribbon-action", type: "button", attrs: { title, "aria-label": title } }, glyph(icon), h("span", { text: label }));
    keep(b);
    b.addEventListener("click", run);
    return b;
};
/** A small live preview of a style: the same resolver the page uses, on a 4 x 3 sample. */
export function stylePreview(preset, accent) {
    const table = { columns: 4, header_rows: 1, rows: Array.from({ length: 4 }, (_, r) => Array.from({ length: 4 }, (_, c) => ({ text: r === 0 ? "▬▬" : c === 0 ? "▬" : "·" }))) };
    const looks = resolveTable({ table, extensions: { [STYLE_KEY]: { preset, accent } } }, {});
    const el = h("table", { class: "tbl-preview", attrs: { "aria-hidden": "true" } });
    table.rows.forEach((row, r) => {
        const tr = h("tr");
        row.forEach((cell, c) => {
            const look = looks.get(`${r},${c}`);
            const td = h("td", { text: cell.text });
            if (look) {
                td.style.background = look.fill ?? "transparent";
                td.style.color = look.color ?? "#555";
                td.style.fontWeight = look.bold ? "700" : "400";
                td.style.borderTop = borderCss(look.borders.top);
                td.style.borderBottom = borderCss(look.borders.bottom);
                td.style.borderLeft = borderCss(look.borders.left);
                td.style.borderRight = borderCss(look.borders.right);
            }
            tr.appendChild(td);
        });
        el.appendChild(tr);
    });
    return el;
}
export function buildTableRibbons(ctx) {
    const { ed } = ctx;
    const panel = (label) => h("div", { class: "format-ribbon references-ribbon", hidden: true, attrs: { role: "toolbar", "aria-label": label } });
    const design = panel("Table Design ribbon"), layout = panel("Table Layout ribbon");
    /* ---------------------------------------------------------------- design: options, gallery, shading, borders */
    const options = new Map();
    const optionBox = h("span", { class: "ribbon-options" });
    for (const key of OPTION_KEYS) {
        const box = checkbox(OPTION_LABELS[key], false, (value) => { void T.setOption(ed, key, value); });
        keep(box.root);
        options.set(key, box.input);
        optionBox.appendChild(box.root);
    }
    const accent = h("input", { type: "color", value: "#2f5597", attrs: { "aria-label": "Table accent colour" } });
    accent.addEventListener("change", () => { void T.setStyle(ed, { accent: accent.value }); });
    const current = h("span", { class: "gallery-current", text: "Default" });
    const gallery = h("div", { class: "table-gallery", hidden: true, attrs: { role: "dialog", "aria-label": "Table styles" } });
    const galleryButton = h("button", { class: "ribbon-action", type: "button", attrs: { "aria-haspopup": "dialog", "aria-expanded": "false", title: "Table styles" } }, glyph("table"), current);
    keep(galleryButton);
    const closeGallery = () => { gallery.hidden = true; gallery.remove(); galleryButton.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", outside, true); };
    const outside = (e) => { if (!(e.target instanceof Node) || (!gallery.contains(e.target) && !galleryButton.contains(e.target)))
        closeGallery(); };
    const fillGallery = () => {
        const target = T.tableTarget(ed);
        const now = styleOptions(target ? T.styleOf(target.block) : undefined, customTableStyles(ed.model.meta));
        const tiles = GALLERY.map((entry) => {
            const tile = h("button", { class: "gallery-tile", type: "button", attrs: { "aria-pressed": String(T.styleOf(target?.block ?? {}).preset === entry.id), title: `${entry.label}: ${entry.description}` } }, stylePreview(entry.id, now.accent), h("span", { text: entry.label }));
            keep(tile);
            tile.addEventListener("click", () => { closeGallery(); void T.setStyle(ed, { preset: entry.id }); });
            return tile;
        });
        const saved = Object.keys(customTableStyles(ed.model.meta)).map((name) => {
            const tile = h("button", { class: "gallery-tile", type: "button", attrs: { title: `Saved style ${name}` } }, stylePreview(styleOptions({ preset: `custom:${name}` }, customTableStyles(ed.model.meta)).preset, now.accent), h("span", { text: name }));
            keep(tile);
            tile.addEventListener("click", () => { closeGallery(); void T.setStyle(ed, { preset: `custom:${name}` }); });
            const remove = h("button", { class: "gallery-remove", type: "button", attrs: { "aria-label": `Delete saved style ${name}`, title: "Delete this saved style" }, text: "×" });
            keep(remove);
            remove.addEventListener("click", (e) => { e.stopPropagation(); closeGallery(); void T.deleteCustomStyle(ed, name); });
            return h("span", { class: "gallery-saved" }, tile, remove);
        });
        const restore = h("button", { class: "ribbon-action", type: "button", text: "Restore default formatting" });
        keep(restore);
        restore.addEventListener("click", () => { closeGallery(); void T.restoreDefaultStyle(ed); });
        const save = h("button", { class: "ribbon-action", type: "button", text: "Save as custom style…" });
        keep(save);
        save.addEventListener("click", () => {
            closeGallery();
            void promptDialog({ title: "Save table style", label: "Name", confirmLabel: "Save", validate: (v) => /^[A-Za-z][A-Za-z0-9 _.-]{0,47}$/.test(v.trim()) ? null : "Start with a letter; letters, digits, spaces, dots, dashes and underscores." })
                .then((name) => { if (name)
                void T.saveCustomStyle(ed, name.trim()); });
        });
        gallery.replaceChildren(h("div", { class: "gallery-grid" }, ...tiles), saved.length ? h("div", { class: "gallery-grid saved" }, ...saved) : h("span"), h("div", { class: "gallery-actions" }, restore, save));
    };
    galleryButton.addEventListener("click", () => {
        if (!gallery.hidden) {
            closeGallery();
            return;
        }
        fillGallery();
        gallery.hidden = false;
        galleryButton.setAttribute("aria-expanded", "true");
        document.addEventListener("mousedown", outside, true);
        const box = galleryButton.getBoundingClientRect(); // outside the ribbon, which scrolls sideways and would clip it
        document.body.appendChild(gallery);
        gallery.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - gallery.offsetWidth - 8))}px`;
        gallery.style.top = `${box.bottom + 2}px`;
    });
    const shading = h("input", { type: "color", value: "#ffffff", attrs: { "aria-label": "Cell shading colour" } });
    shading.addEventListener("change", () => { void T.setShading(ed, shading.value); });
    const penColor = h("input", { type: "color", value: T.pen.color, attrs: { "aria-label": "Border colour" } });
    const penWidth = h("select", { attrs: { "aria-label": "Border thickness" } }, ...[0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => h("option", { value: String(w), text: `${w} pt` })));
    penWidth.value = String(T.pen.width_pt);
    const penStyle = h("select", { attrs: { "aria-label": "Border line style" } }, ...[["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]].map(([v, t]) => h("option", { value: v, text: t })));
    penStyle.value = T.pen.style;
    const readPen = () => { T.pen.color = penColor.value; T.pen.width_pt = Number(penWidth.value); T.pen.style = penStyle.value; };
    for (const el of [penColor, penWidth, penStyle])
        el.addEventListener("change", readPen);
    const bordersMenu = action("Borders", () => {
        readPen();
        openMenu(bordersButton, [
            ...BORDER_LABELS.map(([target, label]) => ({ label, run: () => { void T.setBorders(ed, target, { ...T.pen }); } })),
            "separator",
            { label: "Use the table style's borders", run: () => { void T.setBorders(ed, "all", null); } },
            { label: "Borders and shading…", run: () => { void tableBordersDialog(ctx); } },
        ], { label: "Borders" });
    }, "table", "Borders");
    const bordersButton = bordersMenu;
    design.append(group("Table Style Options", optionBox), group("Table Styles", galleryButton, field("Accent colour", accent)), group("Shading", field("Shading colour", shading), action("No Shading", () => { void T.setShading(ed, null); }, "close")), group("Borders", bordersButton, field("Line style", penStyle), field("Thickness", penWidth), field("Pen colour", penColor)));
    /* ---------------------------------------------------------------- layout */
    const height = num(7, 4, 1000, 0.5, "Row height in millimetres");
    const rule = h("select", { attrs: { "aria-label": "Row height rule" } }, h("option", { value: "min", text: "At least" }), h("option", { value: "exact", text: "Exactly" }));
    const width = num(30, 4, 2000, 0.5, "Column width in millimetres");
    const commitHeight = () => { void T.setRowHeight(ed, Math.max(4, Number(height.value) || 7), rule.value); };
    height.addEventListener("change", commitHeight);
    rule.addEventListener("change", commitHeight);
    width.addEventListener("change", () => { void T.setColumnWidth(ed, Math.max(4, Number(width.value) || 30)); });
    const padding = num(1.2, 0, 50, 0.1, "Cell padding in millimetres");
    padding.addEventListener("change", () => { void T.alignCells(ed, { padding_mm: Math.max(0, Number(padding.value) || 0) }); });
    const tableAlign = h("select", { attrs: { "aria-label": "Table alignment" } }, h("option", { value: "left", text: "Table left" }), h("option", { value: "center", text: "Table centre" }), h("option", { value: "right", text: "Table right" }));
    tableAlign.addEventListener("change", () => { void T.setLayout(ed, { align: tableAlign.value }); });
    const indent = num(0, 0, 500, 1, "Table indent in millimetres");
    indent.addEventListener("change", () => { void T.setLayout(ed, { indent_mm: Math.max(0, Number(indent.value) || 0) || null }); });
    const alignButtons = [["left", "align-left", "Align cell text left"], ["center", "align-center", "Centre cell text"], ["right", "align-right", "Align cell text right"], ["justify", "align-justify", "Justify cell text"]];
    const aligns = alignButtons.map(([value, icon, title]) => { const b = h("button", { class: "iconbtn", type: "button", attrs: { title, "aria-label": title } }, glyph(icon)); keep(b); b.addEventListener("click", () => { void T.alignCells(ed, { align: value }); }); return b; });
    const valigns = [["top", "Align top"], ["middle", "Align middle"], ["bottom", "Align bottom"]].map(([value, title]) => { const b = h("button", { class: "ribbon-action", type: "button", text: title.replace("Align ", ""), attrs: { title: title } }); keep(b); b.addEventListener("click", () => { void T.alignCells(ed, { valign: value }); }); return b; });
    const deleteButton = action("Delete", () => {
        const t = T.tableTarget(ed);
        openMenu(deleteButton, [{ label: "Delete rows", run: () => { void T.deleteRows(ed); } }, { label: "Delete columns", run: () => { void T.deleteColumns(ed); } },
            { label: "Delete table", danger: true, run: () => { void T.deleteTable(ed); } }], { label: t ? "Delete" : "Delete" });
    }, "trash", "Delete rows, columns or the table");
    const fitButton = action("AutoFit", () => openMenu(fitButton, [
        { label: "AutoFit to contents", run: () => { void T.autoFit(ed, "content"); } }, { label: "AutoFit to window", run: () => { void T.autoFit(ed, "window"); } },
        { label: "Fixed column width", run: () => { void T.autoFit(ed, "fixed"); } }
    ], { label: "AutoFit" }), "layout", "AutoFit the table");
    layout.append(group("Rows & Columns", action("Insert Above", () => { void T.insertRows(ed, "above"); }, "plus", "Insert row above"), action("Insert Below", () => { void T.insertRows(ed, "below"); }, "plus", "Insert row below"), action("Insert Left", () => { void T.insertColumns(ed, "left"); }, "plus", "Insert column left"), action("Insert Right", () => { void T.insertColumns(ed, "right"); }, "plus", "Insert column right"), action("Insert Multiple…", () => { void insertMultipleDialog(ctx); }, "plus", "Insert several rows or columns"), deleteButton), group("Merge", action("Merge Cells", () => { void T.mergeCells(ed); }, "table"), action("Split Cells…", () => { void splitCellDialog(ctx); }, "table")), group("Cell Size", field("Row height", height), rule, field("Column width", width), fitButton, action("Distribute Rows", () => { void T.distribute(ed, "rows"); }, "layout"), action("Distribute Columns", () => { void T.distribute(ed, "columns"); }, "layout")), group("Alignment", ...aligns, ...valigns, field("Padding", padding)), group("Table", tableAlign, field("Indent", indent), action("Properties…", () => { void tablePropertiesDialog(ctx); }, "table", "Table properties")));
    const update = () => {
        const t = T.tableTarget(ed);
        if (!t) {
            closeGallery();
            return false;
        }
        const custom = customTableStyles(ed.model.meta);
        const style = T.styleOf(t.block);
        const now = styleOptions(style, custom);
        for (const key of OPTION_KEYS) {
            const box = options.get(key);
            if (box && document.activeElement !== box)
                box.checked = now[key];
        }
        const name = style.preset?.startsWith("custom:") ? style.preset.slice(7) : GALLERY.find((g) => g.id === now.preset)?.label ?? "Default";
        current.textContent = name;
        if (document.activeElement !== accent)
            accent.value = now.accent.toLowerCase();
        const lay = T.layoutOf(t.block);
        if (document.activeElement !== width) {
            const w = lay.column_widths_mm?.[t.rect.c0];
            if (w !== undefined)
                width.value = String(Math.round(w * 10) / 10);
        }
        if (document.activeElement !== height) {
            const v = lay.row_heights_mm?.[t.rect.r0];
            if (v !== undefined)
                height.value = String(Math.round(v * 10) / 10);
        }
        rule.value = lay.row_height_rule ?? "min";
        tableAlign.value = lay.align ?? "left";
        if (document.activeElement !== indent)
            indent.value = String(lay.indent_mm ?? 0);
        if (document.activeElement !== padding)
            padding.value = String(lay.cell_padding_mm ?? 1.2);
        return true;
    };
    return { design, layout, update, closeGallery };
}
/* ------------------------------------------------------------------------------------------------------ dialogs */
export async function insertMultipleDialog(ctx) {
    const { ed } = ctx;
    const t = T.tableTarget(ed);
    if (!t)
        return;
    const what = selectField("Insert", [["row-below", "Rows below"], ["row-above", "Rows above"], ["col-right", "Columns to the right"], ["col-left", "Columns to the left"]], "row-below");
    const count = num(2, 1, 100, 1, "How many");
    const handle = openDialog({
        title: "Insert several rows or columns", size: "narrow", body: h("div", { class: "stack" }, what.root, h("label", {}, h("span", { text: "How many" }), count)),
        actions: [{ label: "Insert", kind: "primary", run: async () => {
                    const n = Math.max(1, Math.min(100, Math.round(Number(count.value) || 1)));
                    const [kind, where] = what.select.value.split("-");
                    if (kind === "row")
                        await T.insertRows(ed, where, n);
                    else
                        await T.insertColumns(ed, where, n);
                    return true;
                } }],
    });
    await handle.result;
}
export async function splitCellDialog(ctx) {
    const { ed } = ctx;
    const t = T.tableTarget(ed);
    if (!t)
        return;
    const cell = t.model.byAddress(t.anchor.row, t.anchor.col);
    const cols = num(cell?.cs ?? 1, 1, 64, 1, "Columns"), rows = num(cell?.rs ?? 1, 1, 64, 1, "Rows");
    const handle = openDialog({
        title: "Split cell", size: "narrow",
        body: h("div", { class: "stack" }, h("p", { class: "muted", text: "Split the cell into this many columns and rows. A merged cell split into as many parts as it spans returns to single cells." }), h("label", {}, h("span", { text: "Columns" }), cols), h("label", {}, h("span", { text: "Rows" }), rows)),
        actions: [{ label: "Split", kind: "primary", run: async () => {
                    await T.splitCell(ed, Math.max(1, Math.round(Number(cols.value) || 1)), Math.max(1, Math.round(Number(rows.value) || 1)));
                    return true;
                } }],
    });
    await handle.result;
}
export async function tableBordersDialog(ctx) {
    const { ed } = ctx;
    if (!T.tableTarget(ed))
        return;
    const target = selectField("Apply to", BORDER_LABELS.map(([v, t]) => [v, t]), "all");
    const scope = selectField("Where", [["selection", "Selected cells"], ["table", "Whole table"]], T.tableTarget(ed)?.whole ? "table" : "selection");
    const colour = h("input", { type: "color", value: T.pen.color, attrs: { "aria-label": "Border colour" } });
    const widthSel = h("select", { attrs: { "aria-label": "Border thickness" } }, ...[0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map((w) => h("option", { value: String(w), text: `${w} pt` })));
    widthSel.value = String(T.pen.width_pt);
    const styleSel = selectField("Line style", [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]], T.pen.style);
    const shade = h("input", { type: "color", value: "#ffffff", attrs: { "aria-label": "Shading colour" } });
    const read = () => ({ color: colour.value, width_pt: Number(widthSel.value), style: styleSel.select.value });
    const handle = openDialog({
        title: "Borders and shading", size: "narrow",
        body: h("div", { class: "stack" }, target.root, scope.root, styleSel.root, h("div", { class: "grid-2" }, h("label", {}, h("span", { text: "Colour" }), colour), h("label", {}, h("span", { text: "Thickness" }), widthSel)), h("p", { class: "muted", text: "Two cells that share an edge share one border: the most recent choice is the one used." }), h("label", {}, h("span", { text: "Shading for the selected cells" }), shade)),
        actions: [
            { label: "Apply border", kind: "primary", run: async () => { const pen = read(); Object.assign(T.pen, pen); await T.setBorders(ed, target.select.value, pen, scope.select.value); return true; } },
            { label: "Use style's border", run: async () => { await T.setBorders(ed, target.select.value === "none" ? "all" : target.select.value, null, scope.select.value); return true; } },
            { label: "Apply shading", run: async () => { await T.setShading(ed, shade.value); return true; } }
        ],
        cancelLabel: "Close",
    });
    await handle.result;
}
export async function tablePropertiesDialog(ctx) {
    const { ed } = ctx;
    const t = T.tableTarget(ed);
    if (!t)
        return;
    const lay = T.layoutOf(t.block);
    const width = h("input", { type: "number", min: 10, max: 2000, step: 1, value: lay.width_mm ? String(lay.width_mm) : "", attrs: { placeholder: "Automatic", "aria-label": "Table width in millimetres" } });
    const fit = selectField("Column sizing", [["auto", "Automatic"], ["content", "Fit to contents"], ["window", "Fit to window"], ["fixed", "Fixed column widths"]], lay.fit ?? "auto");
    const align = selectField("Table alignment", [["left", "Left"], ["center", "Centre"], ["right", "Right"]], lay.align ?? "left");
    const indent = num(lay.indent_mm ?? 0, 0, 500, 1, "Indent");
    const padding = num(lay.cell_padding_mm ?? 1.2, 0, 50, 0.1, "Cell padding");
    const header = num(t.table.header_rows ?? 0, 0, t.model.rows, 1, "Header rows");
    const keepTogether = checkbox("Keep all rows on one page when they fit", lay.keep_rows_together === true);
    const allowSplit = checkbox("Allow a row to break across pages", lay.allow_row_split !== false);
    const handle = openDialog({
        title: "Table properties", size: "narrow",
        body: h("div", { class: "stack" }, h("label", {}, h("span", { text: "Preferred width (mm)" }), width), fit.root, align.root, h("div", { class: "grid-2" }, h("label", {}, h("span", { text: "Indent (mm)" }), indent), h("label", {}, h("span", { text: "Cell padding (mm)" }), padding)), h("label", {}, h("span", { text: "Header rows (repeat on every page)" }), header), keepTogether.root, allowSplit.root),
        actions: [{ label: "Apply", kind: "primary", run: async () => {
                    await T.setLayout(ed, { width_mm: width.value ? Number(width.value) : null, fit: fit.select.value, align: align.select.value, indent_mm: Number(indent.value) || null,
                        cell_padding_mm: Number(padding.value), keep_rows_together: keepTogether.input.checked || null, allow_row_split: allowSplit.input.checked ? null : false });
                    await T.setHeaderRows(ed, Math.max(0, Math.min(t.model.rows, Math.round(Number(header.value) || 0))));
                    return true;
                } }],
    });
    await handle.result;
}
