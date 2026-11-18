/** Where the parts of a table-of-contents entry go: the text, the leader and the page number.
 *
 *  The same arithmetic as `Documaster/slai/docmodel/writers/toc_layout.py` (the exported pages): a golden file (`tests/fixtures/toc_layout_golden.json`) is
 *  produced by that engine and checked against this one, so the editing view and the PDF place an entry alike. Nothing here measures a font or reads the page:
 *  the caller gives the widths it measured and gets positions back, in the unit it used (points in the golden file, CSS pixels in the editor, where `unit` is the
 *  length of a point). */
export const TOC_POSITIONS = ["right", "left", "inline", "custom", "hidden"];
export const TOC_ALIGNS = ["left", "center", "right"];
export const TOC_LEADERS = ["none", "dots", "dashes", "solid", "custom"];
const LEGACY = { right: "right", inline: "inline", left: "left" };
export const MM_PT = 72 / 25.4;
/** The room kept clear between the text, the leader and the number, and the least room the text of an entry is given, in points. */
export const PAD_PT = 3;
export const MIN_TEXT_PT = 36;
export const INLINE_GAP_EM = 0.7;
const num = (value, low, high, openLow = false) => typeof value === "number" && Number.isFinite(value) && (openLow ? value > low : value >= low) && value <= high ? value : null;
/** The settings of an entry's layout, every one with a value (what the server and the exported pages call `resolve_look`). */
export function resolveLook(raw, showPageNumbers = true, leaderDots = true) {
    const r = raw && typeof raw === "object" ? raw : {};
    let position = TOC_POSITIONS.includes(r.page_position) ? r.page_position : (LEGACY[String(r.page_align)] ?? "right");
    if (!showPageNumbers)
        position = "hidden";
    const leader = TOC_LEADERS.includes(r.leader) ? r.leader : leaderDots ? "dots" : "none";
    const align = TOC_ALIGNS.includes(r.number_align) ? r.number_align : (position === "left" || position === "inline" ? "left" : "right");
    const c = r.leader_char;
    const char = typeof c === "string" && c.length > 0 && c.length <= 3 && !/^\s+$/.test(c) && /^[\P{C}]+$/u.test(c) ? c : ".";
    const gap = num(r.leader_gap_pt, 0, 40);
    const tab = num(r.custom_tab_mm, 0, 600);
    const column = num(r.number_column_mm, 0, 100, true);
    return {
        position, number_align: align, leader: position === "hidden" || position === "inline" ? "none" : leader, leader_char: char, leader_gap_pt: gap,
        custom_tab_pt: tab === null ? null : tab * MM_PT, number_column_pt: column === null ? null : column * MM_PT,
    };
}
/** The character a leader of dots, dashes or the person's own is made of (a solid leader is a rule). */
export function leaderMark(look) {
    return look.leader === "dots" ? "." : look.leader === "dashes" ? "-" : look.leader === "custom" ? look.leader_char : "";
}
/** The room between two marks of the leader: what the person set, or the look's own (dashes breathe, dots touch their advance). */
export function leaderGap(look, fontSize) {
    if (look.leader_gap_pt !== null)
        return look.leader_gap_pt;
    return look.leader === "dashes" ? 0.35 * fontSize : 0;
}
/** The room an entry's text has and where its number column is. `width` is the text frame, `indent` and `rightIndent` those of the paragraph, `columnW` the
 *  width of the number column (the widest page number), `inlineW` the width of the number that follows the text (position `inline`). */
export function planEntry(look, width, indent, rightIndent, columnW, inlineW = 0, inlineGap = 0, pad = PAD_PT, minText = MIN_TEXT_PT) {
    const edge = width - rightIndent;
    let column = null;
    let text;
    if (look.position === "hidden")
        text = [indent, edge];
    else if (look.position === "right") {
        column = [edge - columnW, edge];
        text = [indent, column[0] - pad];
    }
    else if (look.position === "left") {
        column = [0, columnW];
        text = [columnW + pad + indent, edge];
    }
    else if (look.position === "custom") {
        let tab = look.custom_tab_pt !== null ? look.custom_tab_pt : edge - columnW;
        tab = Math.min(Math.max(tab, 0), edge);
        let c0 = look.number_align === "right" ? tab - columnW : look.number_align === "left" ? tab : tab - columnW / 2;
        c0 = Math.max(0, Math.min(c0, edge - columnW));
        column = [c0, c0 + columnW];
        text = [indent, column[0] - pad];
    }
    else
        text = [indent, edge - inlineW - inlineGap];
    if (text[1] - text[0] < minText)
        text = [text[0], text[0] + minText];
    return { position: look.position, text, column };
}
/** Where this entry's page number and leader go, given where its text ended up: `first` and `last` are the left and right ends of its first and last line. */
export function placeEntry(look, plan, numberW, first, last, markW, gap, inlineGap = 0, pad = PAD_PT) {
    const out = { number_x: null, leader: null };
    if (plan.position === "hidden")
        return out;
    if (plan.position === "inline") {
        out.number_x = last[1] + inlineGap;
        return out;
    }
    const [c0, c1] = plan.column;
    const align = look.number_align;
    const numberX = align === "left" ? c0 : align === "center" ? c0 + (c1 - c0 - numberW) / 2 : c1 - numberW;
    out.number_x = numberX;
    if (look.leader === "none")
        return out;
    const left = plan.position === "left";
    const g0 = left ? numberX + numberW + pad : last[1] + pad;
    const g1 = left ? first[0] - pad : numberX - pad;
    if (g1 - g0 < 1)
        return out;
    if (look.leader === "solid") {
        out.leader = { kind: "solid", x0: g0, x1: g1 };
        return out;
    }
    const pitch = markW + gap;
    if (markW <= 0 || pitch <= 0)
        return out;
    let kMin, kMax, firstX;
    if (left) {
        kMin = Math.ceil((g0 - c0) / pitch - 1e-9);
        kMax = Math.floor((g1 - markW - c0) / pitch + 1e-9);
        firstX = c0 + kMin * pitch;
    }
    else {
        const anchor = c1 - pad;
        kMin = Math.ceil((anchor - g1) / pitch - 1e-9);
        kMax = Math.floor((anchor - markW - g0) / pitch + 1e-9);
        firstX = anchor - kMax * pitch - markW;
    }
    const count = kMax - kMin + 1;
    if (count >= 1)
        out.leader = { kind: look.leader, x0: firstX, count, pitch, mark_w: markW };
    return out;
}
