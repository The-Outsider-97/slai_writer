/** The look of a table: the style gallery's rules plus what the person set by hand, resolved to the fill, text and borders of each cell.
 *
 *  This is the browser half of table_styles.py; tests/test_table_styles.py and tests_ts/table_styles.test.ts check both against one golden file.
 *  Borders live on the edges of the grid (one entry per edge, never per cell), so two cells that share an edge cannot disagree about it:
 *  an edge the person set wins, otherwise the style's rule, otherwise nothing. */
import { TABLE_STYLES } from "./table_styles_data.js";
import { gridOf } from "./table_geometry.js";
export const STYLE_KEY = "slai.writer.table_style";
export const BORDERS_KEY = "slai.writer.table_borders";
export const CELLS_KEY = "slai.writer.table_cell_styles";
export const LAYOUT_KEY = "slai.writer.table_layout";
export const OPTION_KEYS = ["header_row", "first_column", "banded_rows", "banded_columns"];
export const GALLERY = TABLE_STYLES.order.map((id) => ({ id, label: TABLE_STYLES.presets[id]?.label ?? id, description: TABLE_STYLES.presets[id]?.description ?? "" }));
/** Half-up rounding so the browser and the server compute the same colour. */
const half = (x) => Math.floor(x + 0.5);
export function mix(colour, other, amount) {
    const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    return "#" + rgb.map((a, i) => half(a + (other[i] - a) * amount).toString(16).toUpperCase().padStart(2, "0")).join("");
}
export function resolveColour(spec, accent) {
    if (spec === null || spec === undefined)
        return null;
    if (spec === "accent")
        return accent.toUpperCase();
    if (spec === "accent_light")
        return mix(accent, [255, 255, 255], 0.85);
    if (spec === "accent_dark")
        return mix(accent, [0, 0, 0], 0.35);
    return spec.toUpperCase();
}
export function styleOptions(style, custom = {}) {
    let preset = style?.preset ?? "default";
    let base = {};
    if (preset.startsWith("custom:")) {
        base = custom[preset.slice(7)] ?? {};
        preset = base.preset ?? "default";
    }
    if (!(preset in TABLE_STYLES.presets))
        preset = "default";
    const flags = { ...TABLE_STYLES.presets[preset].defaults };
    for (const source of [base, style ?? {}])
        for (const key of OPTION_KEYS)
            if (typeof source[key] === "boolean")
                flags[key] = source[key];
    return { preset, accent: style?.accent ?? base.accent ?? TABLE_STYLES.accent, ...flags };
}
const derived = (rule, accent) => rule ? { color: resolveColour(rule.color, accent), width_pt: rule.width_pt, style: rule.style } : null;
export function resolveTable(block, custom = {}) {
    const table = block.table;
    const ext = block.extensions ?? {};
    const opt = styleOptions(ext[STYLE_KEY], custom);
    const preset = TABLE_STYLES.presets[opt.preset];
    const grid = gridOf(table);
    const rows = grid.rows, cols = grid.columns;
    const header = opt.header_row ? Math.min(table.header_rows ?? 0, rows) : 0;
    const explicit = (ext[BORDERS_KEY] ?? {});
    const ownH = explicit.h ?? {}, ownV = explicit.v ?? {};
    const rules = preset.borders;
    const hEdge = (line, column) => {
        const key = `${line},${column}`;
        if (key in ownH)
            return ownH[key] ?? null;
        const rule = line === 0 ? rules.top : line === rows ? rules.bottom : header && line === header ? (rules.header_bottom ?? rules.inside_h) : rules.inside_h;
        return derived(rule, opt.accent);
    };
    const vEdge = (row, line) => {
        const key = `${row},${line}`;
        if (key in ownV)
            return ownV[key] ?? null;
        return derived(line === 0 ? rules.left : line === cols ? rules.right : rules.inside_v, opt.accent);
    };
    const own = (ext[CELLS_KEY] ?? {});
    const out = new Map();
    for (const cell of grid.cells) {
        let role = {};
        let hasRole = false;
        if (cell.r < header) {
            role = preset.header;
            hasRole = true;
        }
        else if (opt.first_column && cell.c === 0) {
            role = preset.first_column;
            hasRole = true;
        }
        let fill = resolveColour(role.fill, opt.accent);
        const color = resolveColour(role.color, opt.accent);
        if (!hasRole) {
            const bodyRow = cell.r - header, bodyCol = cell.c - (opt.first_column ? 1 : 0);
            if (opt.banded_rows && bodyRow % 2 === 1)
                fill = resolveColour(preset.band_rows.fill, opt.accent);
            else if (opt.banded_columns && bodyCol >= 0 && bodyCol % 2 === 1)
                fill = resolveColour(preset.band_columns.fill, opt.accent);
        }
        const key = `${cell.row},${cell.idx}`;
        const background = own[key]?.background;
        if (background)
            fill = background.toUpperCase();
        out.set(key, { fill, color, bold: Boolean(role.bold),
            borders: { top: hEdge(cell.r, cell.c), bottom: hEdge(cell.r + cell.rs, cell.c), left: vEdge(cell.r, cell.c), right: vEdge(cell.r, cell.c + cell.cs) } });
    }
    return out;
}
export const borderCss = (b) => b && b.width_pt > 0 ? `${b.width_pt}pt ${b.style} ${b.color}` : "none";
