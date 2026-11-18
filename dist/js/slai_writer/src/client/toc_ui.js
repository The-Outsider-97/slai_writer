/** The Contents group of the References tab, the style gallery and the settings dialog of a table of contents. */
import { confirmDialog, glyph, h, openDialog, toast } from "./kit.js";
import { FONT_FAMILIES } from "./font_rules.js";
import { TOC_PRESETS } from "./toc_presets_data.js";
import * as T from "./toc_actions.js";
import { checkbox, notice, selectField } from "./widgets.js";
const keep = (el) => { el.addEventListener("mousedown", (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement))
    e.preventDefault(); }); };
const action = (label, run, icon, title = label) => {
    const b = h("button", { class: "ribbon-action", type: "button", attrs: { title, "aria-label": title } }, glyph(icon), h("span", { text: label }));
    keep(b);
    b.addEventListener("click", run);
    return b;
};
const LEADER_LABELS = [["dots", "Dots"], ["dashes", "Dashes"], ["solid", "Solid line"], ["custom", "Your own character"], ["none", "None"]];
const ALIGN_LABELS = [["right", "Right, at the edge"], ["inline", "Right after the title"], ["left", "Left, before the title"], ["custom", "At a tab stop of my own"], ["hidden", "Hidden"]];
const SIDE_LABELS = [["left", "Left"], ["center", "Centre"], ["right", "Right"]];
const LEVEL_SIDE_LABELS = [["", "As the text"], ...SIDE_LABELS, ["justify", "Justified"]];
const SAMPLE = [["Introduction", 1, "1"], ["Background", 2, "2"], ["Earlier work", 3, "3"], ["Method", 1, "7"]];
function levelCss(el, look, scale = 0.8) {
    if (!look)
        return;
    if (look.font_family)
        el.style.fontFamily = `"${look.font_family}", serif`;
    if (look.font_size_pt)
        el.style.fontSize = `${look.font_size_pt * scale}px`;
    el.style.fontWeight = look.bold ? "700" : "400";
    el.style.fontStyle = look.italic ? "italic" : "normal";
    el.style.fontVariant = look.small_caps ? "small-caps" : "normal";
    if (look.color)
        el.style.color = look.color;
}
/** A small picture of a look: the title and four entries at three levels, set the way the look says. */
export function tocPreview(preset, overrides = {}) {
    const leader = overrides.leader ?? preset.leader, align = overrides.page_align ?? preset.page_align, numbered = overrides.numbered ?? preset.numbered;
    const box = h("div", { class: "toc-preview", attrs: { "aria-hidden": "true" } });
    const title = h("div", { class: "toc-pv-title", text: "Contents" });
    levelCss(title, preset.title ?? { font_size_pt: 15, bold: true });
    title.style.textAlign = preset.title?.align ?? "left";
    box.appendChild(title);
    let n1 = 0;
    for (const [text, level, page] of SAMPLE) {
        if (level === 1)
            n1 += 1;
        const row = h("div", { class: "toc-pv-row" });
        const look = preset.levels?.[level - 1];
        levelCss(row, look ?? { font_size_pt: 11 - (level - 1) * 0.5, bold: level === 1 });
        row.style.paddingLeft = `${(look?.indent_mm ?? (level - 1) * 5) * 1.6}px`;
        const label = h("span", { class: "toc-pv-text", text: numbered ? `${level === 1 ? n1 : `${n1}.${level - 1}`} ${text}` : text });
        const fill = h("span", { class: "toc-pv-fill" });
        if (align === "right" && leader !== "none")
            fill.style.borderBottom = `1px ${leader === "dots" ? "dotted" : leader === "dashes" ? "dashed" : "solid"} currentColor`;
        const num = h("span", { class: "toc-pv-page", text: page });
        row.append(...(align === "left" ? [num, label] : align === "inline" ? [label, num] : [label, fill, num]));
        if (align === "inline")
            num.style.marginLeft = "0.6em";
        if (align === "left")
            num.style.marginRight = "0.6em";
        box.appendChild(row);
    }
    return box;
}
/** The gallery of the twelve looks. With `current` set it changes the style of that table; otherwise it inserts a new one. */
export async function tocGalleryDialog(ctx, current) {
    const { ed } = ctx;
    let chosen = current?.look.preset ?? "classic";
    const cards = new Map();
    const grid = h("div", { class: "toc-gallery", attrs: { role: "radiogroup", "aria-label": "Contents styles" } });
    const mark = () => cards.forEach((card, id) => card.setAttribute("aria-checked", String(id === chosen)));
    for (const id of TOC_PRESETS.order) {
        const preset = TOC_PRESETS.presets[id];
        const card = h("button", { type: "button", class: "toc-card", attrs: { role: "radio", "aria-checked": "false", title: preset.description } }, id === "custom" ? h("div", { class: "toc-preview toc-pv-custom", attrs: { "aria-hidden": "true" } }, h("span", { text: "Your own settings" }))
            : tocPreview(preset), h("strong", { text: preset.name }), h("span", { class: "muted", text: preset.description }));
        card.addEventListener("click", () => { chosen = id; mark(); });
        card.addEventListener("dblclick", () => { chosen = id; mark(); void go(); });
        cards.set(id, card);
        grid.appendChild(card);
    }
    mark();
    const depth = h("select", { attrs: { "aria-label": "Heading levels to show" } }, ...[1, 2, 3, 4, 5, 6].map((n) => h("option", { value: String(n), text: `${n} level${n > 1 ? "s" : ""}` })));
    depth.value = String(current?.core.depth ?? 3);
    const title = h("input", { type: "text", value: current?.title.text ?? "Contents", maxLength: 80, attrs: { "aria-label": "Title" } });
    let handleClose;
    const go = async () => {
        const ok = current
            ? await T.updateToc(ed, current.id, { look: { preset: chosen }, depth: Number(depth.value), title: title.value.trim() || "Contents" }, "Contents style changed.")
            : await T.insertToc(ed, { preset: chosen }, { depth: Number(depth.value), title: title.value.trim() || "Contents" });
        if (ok)
            handleClose?.();
    };
    const handle = openDialog({
        title: current ? "Change contents style" : "Table of contents", size: "wide",
        body: h("div", { class: "stack" }, grid, h("div", { class: "grid-2" }, h("label", {}, h("span", { text: "Title" }), title), h("label", {}, h("span", { text: "Levels to show" }), depth)), notice(current ? "Changing the style restyles this table of contents and keeps its entries, links and the headings of your document."
            : "The table lists the headings of your document and stays up to date as they change. Page numbers come from the exact page layout.", "info")),
        actions: [{ label: current ? "Apply style" : "Insert", kind: "primary", run: async () => {
                    const ok = current
                        ? await T.updateToc(ed, current.id, { look: { preset: chosen }, depth: Number(depth.value), title: title.value.trim() || "Contents" }, "Contents style changed.")
                        : await T.insertToc(ed, { preset: chosen }, { depth: Number(depth.value), title: title.value.trim() || "Contents" });
                    return ok ? true : undefined;
                } }],
    });
    handleClose = () => handle.close?.();
    await handle.result;
}
const num = (value, min, max, step, label) => h("input", { type: "number", min, max, step, value: value === undefined ? "" : String(value), attrs: { "aria-label": label, inputmode: "decimal" } });
/** Edit the options and the formatting of each level of one table of contents. */
export async function tocSettingsDialog(ctx, info) {
    const { ed } = ctx;
    const styles = ed.model.meta.styles?.paragraph ?? {};
    const title = h("input", { type: "text", value: info.title.text, maxLength: 80, attrs: { "aria-label": "Title" } });
    const depth = h("select", { attrs: { "aria-label": "Heading levels to show" } }, ...[1, 2, 3, 4, 5, 6].map((n) => h("option", { value: String(n), text: `${n} level${n > 1 ? "s" : ""}` })));
    depth.value = String(info.core.depth);
    const shown = info.core.show_page_numbers !== false;
    const stored = info.look.page_position;
    let lastPlace = stored === "hidden" ? "right" : stored;
    const leader = selectField("Leader", LEADER_LABELS, info.look.leader);
    const align = selectField("Page numbers", ALIGN_LABELS, shown ? stored : "hidden");
    const show = checkbox("Show page numbers", shown);
    const numberAlign = selectField("Page number alignment", SIDE_LABELS, info.look.number_align ?? (stored === "left" || stored === "inline" ? "left" : "right"));
    const textAlign = selectField("Entry text alignment", SIDE_LABELS, info.look.text_align ?? "left");
    const tab = num(info.look.custom_tab_mm ?? 120, 0, 600, 1, "Tab stop of the page numbers in millimetres from the left margin");
    const column = num(info.look.number_column_mm, 1, 100, 0.5, "Width of the page-number column in millimetres (empty: as wide as the widest number)");
    const leaderChar = h("input", { type: "text", value: info.look.leader_char ?? "·", maxLength: 3, attrs: { "aria-label": "Leader character" } });
    const leaderGap = num(info.look.leader_gap_pt, 0, 40, 0.5, "Space between the leader marks in points (empty: automatic)");
    const field = (label, control) => h("label", {}, h("span", { text: label }), control);
    const tabField = field("Tab stop (mm from the left margin)", tab), columnField = field("Number column width (mm, empty: automatic)", column);
    const charField = field("Leader character", leaderChar), gapField = field("Leader spacing (pt, empty: automatic)", leaderGap);
    const refreshControls = () => {
        const place = align.select.value, kind = leader.select.value;
        tabField.hidden = place !== "custom";
        const none = place === "hidden";
        for (const el of [numberAlign.root, columnField])
            el.hidden = none || place === "inline";
        charField.hidden = kind !== "custom";
        leader.root.hidden = none || place === "inline";
        gapField.hidden = none || place === "inline" || kind === "none" || kind === "solid";
    };
    align.select.addEventListener("change", () => {
        if (align.select.value === "hidden")
            show.input.checked = false;
        else {
            lastPlace = align.select.value;
            show.input.checked = true;
        }
        refreshControls();
    });
    show.input.addEventListener("change", () => {
        if (!show.input.checked) {
            if (align.select.value !== "hidden")
                lastPlace = align.select.value;
            align.select.value = "hidden";
        }
        else if (align.select.value === "hidden")
            align.select.value = lastPlace;
        refreshControls();
    });
    leader.select.addEventListener("change", refreshControls);
    refreshControls();
    const links = checkbox("Entries are links to their headings", info.look.hyperlinks);
    const numbered = checkbox("Number the entries like an outline (1, 1.1, 1.1.1)", info.look.numbered);
    const refresh = selectField("Update", [["automatic", "Automatically when headings change"], ["manual", "Only when I ask"]], info.core.refresh_mode ?? "automatic");
    const fontList = h("datalist", { attrs: { id: "toc-fonts" } }, FONT_FAMILIES.map((name) => h("option", { value: name })));
    const rows = [];
    const grid = h("div", { class: "toc-levels" });
    const header = h("div", { class: "toc-level-row toc-level-head" }, ...["", "Font", "Size", "B", "I", "Colour", "Indent", "Before", "After", "Line", "Align"].map((t) => h("span", { text: t })));
    grid.appendChild(header);
    const addRow = (key, label, props, isTitle) => {
        const font = h("input", { type: "text", value: String(props["font_family"] ?? ""), maxLength: 100, attrs: { list: "toc-fonts", "aria-label": `${label} font` } });
        const size = num(props["font_size_pt"], 4, 400, 0.5, `${label} size in points`);
        const bold = h("input", { type: "checkbox", checked: props["bold"] === true, attrs: { "aria-label": `${label} bold` } });
        const italic = h("input", { type: "checkbox", checked: props["italic"] === true, attrs: { "aria-label": `${label} italic` } });
        const colour = h("input", { type: "color", value: typeof props["color"] === "string" ? props["color"] : "#000000", attrs: { "aria-label": `${label} colour` } });
        colour.dataset["touched"] = "";
        colour.addEventListener("input", () => { colour.dataset["touched"] = "1"; });
        const indent = isTitle ? null : num(props["indent_mm"], 0, 200, 0.5, `${label} indent in millimetres`);
        const before = num(props["space_before_pt"], 0, 200, 0.5, `${label} space before in points`);
        const after = num(props["space_after_pt"], 0, 200, 0.5, `${label} space after in points`);
        const line = isTitle ? null : num(props["line_height"], 0.8, 4, 0.05, `${label} line spacing (1 = single)`);
        const choices = isTitle ? SIDE_LABELS : LEVEL_SIDE_LABELS;
        const alignSel = h("select", { attrs: { "aria-label": isTitle ? "Title alignment" : `${label} text alignment` } }, ...choices.map(([v, t]) => h("option", { value: v, text: t })));
        alignSel.value = String(props["align"] ?? (isTitle ? "left" : ""));
        const row = { key, line, font, size, bold, italic, colour, indent, before, after, align: alignSel, initial: "" };
        row.initial = JSON.stringify(read(row));
        rows.push(row);
        grid.appendChild(h("div", { class: "toc-level-row" }, h("span", { text: label }), font, size, bold, italic, colour, indent ?? h("span"), before, after, line ?? h("span"), alignSel));
    };
    const read = (row) => {
        const out = {};
        if (row.font.value.trim())
            out["font_family"] = row.font.value.trim();
        if (row.size.value !== "")
            out["font_size_pt"] = Number(row.size.value);
        out["bold"] = row.bold.checked || undefined;
        out["italic"] = row.italic.checked || undefined;
        if (row.colour.dataset["touched"])
            out["color"] = row.colour.value;
        if (row.indent && row.indent.value !== "")
            out["indent_mm"] = Number(row.indent.value);
        if (row.before && row.before.value !== "")
            out["space_before_pt"] = Number(row.before.value);
        if (row.after.value !== "")
            out["space_after_pt"] = Number(row.after.value);
        if (row.line && row.line.value !== "")
            out["line_height"] = Number(row.line.value);
        if (row.align && (row.key === "title" || row.align.value !== ""))
            out["align"] = row.align.value;
        return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
    };
    addRow("title", "Title", styles["TOC Title"] ?? {}, true);
    for (let level = 1; level <= info.core.depth; level += 1)
        addRow(String(level), `Level ${level}`, styles[`TOC Level ${level}`] ?? {}, false);
    const error = h("p", { class: "field-error", attrs: { role: "alert" } });
    error.hidden = true;
    const handle = openDialog({
        title: "Table of contents settings", size: "wide",
        body: h("div", { class: "stack" }, fontList, h("div", { class: "grid-2" }, h("label", {}, h("span", { text: "Title" }), title), h("label", {}, h("span", { text: "Levels to show" }), depth)), show.root, h("fieldset", { class: "toc-layout" }, h("legend", { text: "Page numbers" }), h("div", { class: "grid-2" }, align.root, numberAlign.root), h("div", { class: "grid-2" }, tabField, columnField)), h("fieldset", { class: "toc-layout" }, h("legend", { text: "Leader and text" }), h("div", { class: "grid-2" }, leader.root, textAlign.root), h("div", { class: "grid-2" }, charField, gapField)), links.root, numbered.root, refresh.root, h("details", { open: true }, h("summary", { text: "Formatting of the title and of each level" }), grid, h("p", { class: "muted", text: "These are the paragraph styles TOC Title and TOC Level 1 to 6, so the Style Manager shows the same settings. Colour changes only if you pick one." })), notice("To change how the whole table looks at once, use Change Style. Page numbers always come from the exact page layout.", "info"), error),
        actions: [{ label: "Apply", kind: "primary", run: async () => {
                    error.hidden = true;
                    const body = {};
                    const look = {};
                    const newTitle = title.value.trim();
                    if (!newTitle || newTitle.length > 80) {
                        error.textContent = "The title needs 1 to 80 characters.";
                        error.hidden = false;
                        return undefined;
                    }
                    if (newTitle !== info.title.text)
                        body["title"] = newTitle;
                    if (Number(depth.value) !== info.core.depth)
                        body["depth"] = Number(depth.value);
                    if (refresh.select.value !== (info.core.refresh_mode ?? "automatic"))
                        body["refreshMode"] = refresh.select.value;
                    if (leader.select.value !== info.look.leader)
                        look["leader"] = leader.select.value;
                    const place = align.select.value;
                    if (place !== "hidden" && place !== (shown ? info.look.page_position : "hidden"))
                        look["page_position"] = place;
                    if (place === "hidden" && shown)
                        body["showPageNumbers"] = false;
                    const side = (select, was, fallback, key) => {
                        if (select.value !== (was ?? fallback))
                            look[key] = select.value;
                    };
                    if (place !== "hidden") {
                        side(numberAlign.select, info.look.number_align, stored === "left" || stored === "inline" ? "left" : "right", "number_align");
                        if (place === "custom" && (tab.value !== "" && Number(tab.value) !== (info.look.custom_tab_mm ?? 120) || stored !== "custom")) {
                            if (tab.value === "" || !(Number(tab.value) >= 0 && Number(tab.value) <= 600)) {
                                error.textContent = "The tab stop is between 0 and 600 mm.";
                                error.hidden = false;
                                return undefined;
                            }
                            look["custom_tab_mm"] = Number(tab.value);
                        }
                        if (column.value !== String(info.look.number_column_mm ?? "")) {
                            if (column.value !== "" && !(Number(column.value) > 0 && Number(column.value) <= 100)) {
                                error.textContent = "The number column is between 0.5 and 100 mm wide.";
                                error.hidden = false;
                                return undefined;
                            }
                            look["number_column_mm"] = column.value === "" ? null : Number(column.value);
                        }
                    }
                    side(textAlign.select, info.look.text_align, "left", "text_align");
                    if (leader.select.value === "custom" && leaderChar.value !== (info.look.leader_char ?? "·")) {
                        if (!leaderChar.value || /^\s+$/.test(leaderChar.value)) {
                            error.textContent = "Type one to three visible characters for the leader.";
                            error.hidden = false;
                            return undefined;
                        }
                        look["leader_char"] = leaderChar.value;
                    }
                    else if (leader.select.value === "custom" && info.look.leader !== "custom")
                        look["leader_char"] = leaderChar.value;
                    if (leaderGap.value !== String(info.look.leader_gap_pt ?? "")) {
                        if (leaderGap.value !== "" && !(Number(leaderGap.value) >= 0 && Number(leaderGap.value) <= 40)) {
                            error.textContent = "The leader spacing is between 0 and 40 points.";
                            error.hidden = false;
                            return undefined;
                        }
                        look["leader_gap_pt"] = leaderGap.value === "" ? null : Number(leaderGap.value);
                    }
                    if (links.input.checked !== info.look.hyperlinks)
                        look["hyperlinks"] = links.input.checked;
                    if (numbered.input.checked !== info.look.numbered)
                        look["numbered"] = numbered.input.checked;
                    const levels = {};
                    let titleLook;
                    for (const row of rows) {
                        const now = read(row);
                        if (JSON.stringify(now) === row.initial)
                            continue;
                        if (row.key === "title")
                            titleLook = now;
                        else
                            levels[row.key] = now;
                    }
                    if (Object.keys(levels).length)
                        look["levels"] = levels;
                    if (titleLook)
                        look["title"] = titleLook;
                    if (Object.keys(look).length)
                        body["look"] = look;
                    if (!Object.keys(body).length)
                        return true;
                    return (await T.updateToc(ed, info.id, body, "Table of contents settings applied.")) ? true : undefined;
                } }],
    });
    await handle.result;
}
/** The Contents group: insert a table, bring it up to date, change its style or settings, remove it. */
export function buildContentsGroup(ctx) {
    const { ed } = ctx;
    const withTarget = (fn) => () => {
        const info = T.tocTarget(ed);
        if (info)
            fn(info);
        else
            toast(T.allTocs(ed).length ? "Place the cursor in the table of contents you mean." : "There is no table of contents yet. Use Table of Contents to insert one.", { kind: "info" });
    };
    const insert = action("Table of Contents", () => { void tocGalleryDialog(ctx); }, "list", "Table of contents: choose one of 12 styles and insert it");
    const pages = action("Update Page Numbers", withTarget(() => T.updatePageNumbers(ed)), "refresh", "Update page numbers only (measures the pages again, changes nothing in the document)");
    const entire = action("Update Table", withTarget((info) => { void T.updateToc(ed, info.id); }), "refresh", "Update the entire table from the headings");
    const style = action("Change Style", withTarget((info) => { void tocGalleryDialog(ctx, info); }), "layers", "Change the style of the table of contents");
    const settings = action("Edit Settings", withTarget((info) => { void tocSettingsDialog(ctx, info); }), "gear", "Edit settings: levels, leaders, page numbers, links, formatting");
    const remove = action("Remove", withTarget((info) => {
        void confirmDialog({ title: "Remove the table of contents?", message: "The headings of your document stay as they are.", confirmLabel: "Remove", danger: true }).then((ok) => { if (ok)
            void T.removeToc(ed, info.id); });
    }), "close", "Remove the table of contents");
    const group = h("div", { class: "ribbon-group" }, h("span", { class: "ribbon-controls" }, insert, pages, entire, style, settings, remove), h("span", { class: "ribbon-group-label", text: "Contents" }));
    const update = () => {
        const none = T.allTocs(ed).length === 0;
        for (const b of [pages, entire, style, settings, remove])
            b.disabled = none || ed.readOnly;
        insert.disabled = ed.readOnly;
    };
    return { el: group, update };
}
