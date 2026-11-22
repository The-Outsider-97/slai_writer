import { h, labelled, openDialog, toast } from "./kit.js";
import { RULE_LIMITS, RULE_STYLES, ruleCss, ruleLabel, ruleOf } from "./rule_look.js";
import { errorText } from "./net.js";
/** A real element, not text: it spans the whole width of its column (so it follows margins, columns and sections), is not editable, and is a separator for assistive technology. */
export function ruleElement(look) {
    const el = h("div", { class: "rule-line", attrs: { role: "separator", "aria-orientation": "horizontal", "aria-label": ruleLabel(look), contenteditable: "false" }, data: { rule: "" } });
    for (const [name, value] of Object.entries(ruleCss(look)))
        el.style.setProperty(name, value);
    return el;
}
/** The dialog for thickness, colour, style and spacing. Applies one `rule_set` operation, which is one undo step. */
export async function editRule(ed, id) {
    const look = ruleOf(ed.model.block(id));
    if (!look || ed.readOnly)
        return;
    const number = (value, [min, max], step) => h("input", { type: "number", min: String(min), max: String(max), step: String(step), value: String(value) });
    const width = number(look.width_pt, RULE_LIMITS.width_pt, 0.25);
    const before = number(look.space_before_pt, RULE_LIMITS.space_before_pt, 1);
    const after = number(look.space_after_pt, RULE_LIMITS.space_after_pt, 1);
    const color = h("input", { type: "color", value: look.color });
    const style = h("select", {}, RULE_STYLES.map((s) => h("option", { value: s, text: s[0]?.toUpperCase() + s.slice(1), selected: s === look.style })));
    style.value = look.style;
    const read = (input, [min, max]) => {
        const value = Number(input.value);
        return input.value.trim() !== "" && Number.isFinite(value) && value >= min && value <= max ? value : null;
    };
    const handle = openDialog({
        title: "Horizontal line", size: "narrow",
        body: h("div", { class: "grid-2" }, labelled("Thickness (points)", width), labelled("Color", color), labelled("Style", style), labelled("Space above (points)", before), labelled("Space below (points)", after)),
        actions: [{ label: "Apply", kind: "primary", run: async () => {
                    const next = { width_pt: read(width, RULE_LIMITS.width_pt), space_before_pt: read(before, RULE_LIMITS.space_before_pt), space_after_pt: read(after, RULE_LIMITS.space_after_pt) };
                    if (next.width_pt === null || next.space_before_pt === null || next.space_after_pt === null) {
                        toast("Thickness is 0.25 to 12 points; spacing is 0 to 72 points.", { kind: "error" });
                        return undefined;
                    }
                    try {
                        await ed.op({ op: "rule_set", block: id, rule: { ...next, color: color.value, style: style.value } });
                    }
                    catch (error) {
                        toast(errorText(error), { kind: "error" });
                        return undefined;
                    }
                    return true;
                } }],
    });
    await handle.result;
}
