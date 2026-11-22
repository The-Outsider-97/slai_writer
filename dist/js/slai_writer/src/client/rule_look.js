export const RULE_KEY = "slai.writer.rule";
export const RULE_STYLES = ["solid", "dashed", "dotted", "double"];
/** Solid, 1 pt, dark gray, 6 pt above and below: what `___` + Enter makes. The server writes the same values. */
export const RULE_DEFAULTS = { style: "solid", width_pt: 1, color: "#404040", space_before_pt: 6, space_after_pt: 6 };
export const RULE_LIMITS = { width_pt: [0.25, 12], space_before_pt: [0, 72], space_after_pt: [0, 72] };
const num = (value, [low, high], fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
/** The rule a block holds, with every missing or out-of-range value replaced by its default; null when the block is not a rule. */
export function ruleOf(block) {
    const raw = block?.extensions?.[RULE_KEY];
    if (raw === undefined || raw === null || typeof raw !== "object")
        return null;
    const r = raw;
    return {
        style: RULE_STYLES.includes(r["style"]) ? r["style"] : RULE_DEFAULTS.style,
        width_pt: num(r["width_pt"], RULE_LIMITS.width_pt, RULE_DEFAULTS.width_pt),
        color: typeof r["color"] === "string" && /^#[0-9a-fA-F]{6}$/.test(r["color"]) ? r["color"] : RULE_DEFAULTS.color,
        space_before_pt: num(r["space_before_pt"], RULE_LIMITS.space_before_pt, RULE_DEFAULTS.space_before_pt),
        space_after_pt: num(r["space_after_pt"], RULE_LIMITS.space_after_pt, RULE_DEFAULTS.space_after_pt),
    };
}
const PX_PER_PT = 96 / 72;
/** The CSS of the line itself. A double rule is two lines of the given thickness with a gap of the same size, so it is three times as thick in all. */
export function ruleCss(look) {
    const px = look.width_pt * PX_PER_PT * (look.style === "double" ? 3 : 1);
    return {
        height: "0", "border-top": `${px}px ${look.style} ${look.color}`, "border-bottom": "0", "border-left": "0", "border-right": "0",
        margin: `${look.space_before_pt}pt 0 ${look.space_after_pt}pt`, width: "100%", "box-sizing": "content-box",
    };
}
/** What a screen reader says for the rule. */
export function ruleLabel(look) {
    return `Horizontal line, ${look.style}, ${look.width_pt} point${look.width_pt === 1 ? "" : "s"}`;
}
