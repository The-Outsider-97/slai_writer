/** Author names in the source editor: how Writer read each name, and the controls to confirm or correct a reading.
 *
 *  The server decides how a name is read (names.py). This module only asks it, shows the answer, and writes the person's correction back as text that is read exactly
 *  ("Family, Given[, Suffix]" or "{Organisation}"). Nothing is stored here: the corrected text is saved with the source when the person saves it. */
import { h, labelled } from "./kit.js";
import { api } from "./net.js";
import { button, checkbox, selectField, statusBadge } from "./widgets.js";
export const SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];
/** The text that says exactly what the parts say (the same text names.py's `Name.canonical` gives), or the reason it cannot be written. */
export function canonicalName(parts) {
    const family = parts.family.trim().replace(/\s+/g, " ");
    const given = parts.given.trim().replace(/\s+/g, " ");
    if (!family)
        return { error: parts.literal ? "Enter the name of the organisation." : "Enter the family name." };
    if (parts.literal)
        return /[{}]/.test(family) ? { error: "An organisation name cannot contain { or }." } : { text: `{${family}}` };
    if (/[,{}]/.test(family) || /[,{}]/.test(given))
        return { error: "Leave out commas and braces: they are how Writer tells the parts apart." };
    const suffix = parts.suffix.trim();
    if (suffix && !SUFFIXES.includes(suffix))
        return { error: "Choose a suffix from the list, or leave it empty." };
    let text = family + (given ? `, ${given}` : "");
    if (!given && !suffix && family.includes(" "))
        text += ","; // "van Beethoven,": the comma says the whole of it is the family name
    return { text: text + (suffix ? `, ${suffix}` : "") };
}
/** The lines of a one-name-per-line field, split the way the source is saved (the editor sends them as typed). */
export const linesOf = (value) => value.split(/\r?\n/);
/** The field's text with line `index` replaced; every other line is kept exactly as typed. */
export function replaceLine(value, index, text) {
    const lines = linesOf(value);
    if (index < 0 || index >= lines.length)
        return value;
    lines[index] = text;
    return lines.join("\n");
}
/** The parts of a reading, for filling the correction form. */
export const partsOf = (r) => ({ family: r.family, given: r.given, suffix: r.suffix, literal: r.literal });
export async function readNames(lines) {
    const reply = await api.post("/names/read", { names: lines });
    return reply.names;
}
/** The panel under a names field: each name as Writer reads it, whether that was the person's own wording or a guess, and Confirm / Change / Keep as one name.
 *  A name that was written as `Family, Given` or `{Organisation}` is shown as stated; a guess is marked and explained. */
export function nameReview(field, what) {
    const root = h("div", { class: "name-review", attrs: { "aria-live": "polite", "aria-label": `How Writer reads the ${what}` } });
    let seq = 0;
    let timer;
    /** Write the corrected line, but only if the line is still the one the reading was made from (the person may have kept typing). */
    const apply = (index, text, from) => {
        if (linesOf(field.value)[index] !== from)
            return false;
        field.value = replaceLine(field.value, index, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    };
    const form = (index, reading, row) => {
        const family = h("input", { type: "text", maxLength: 100, value: reading.family, attrs: { autocomplete: "off", "aria-label": "Family name" } });
        const given = h("input", { type: "text", maxLength: 100, value: reading.literal ? "" : reading.given, attrs: { autocomplete: "off", "aria-label": "Given names" } });
        const suffix = selectField("Suffix", [["", "none"], ...SUFFIXES.map((s) => [s, s])], reading.suffix);
        const org = checkbox("This is an organisation: keep it as one name", reading.literal);
        const message = h("p", { class: "form-error", attrs: { role: "alert" }, hidden: true });
        const sync = () => { given.disabled = suffix.select.disabled = org.input.checked; };
        org.input.addEventListener("change", sync);
        sync();
        const form = h("div", { class: "name-form" }, h("div", { class: "grid-3" }, labelled("Family name", family), labelled("Given names", given), suffix.root), org.root, message, h("div", { class: "actions" }, button("Use this reading", () => {
            const made = canonicalName({ family: family.value, given: given.value, suffix: suffix.select.value, literal: org.input.checked });
            if ("error" in made) {
                message.textContent = made.error;
                message.hidden = false;
                return;
            }
            form.remove();
            if (!apply(index, made.text, reading.typed))
                refresh(); // the line changed meanwhile: show the new readings, change nothing
        }, "primary"), button("Cancel", () => { form.remove(); refresh(); })));
        row.appendChild(form);
        family.focus();
    };
    const paint = (rows) => {
        root.replaceChildren();
        const shown = rows.map((r, index) => ({ r, index })).filter((x) => x.r !== null);
        if (!shown.length)
            return;
        for (const { r, index } of shown) {
            const row = h("div", { class: `name-row${r.stated ? " stated" : " guessed"}` }, h("div", { class: "name-head" }, h("strong", { text: r.typed.trim() }), " → ", h("span", { text: r.literal ? `${r.family} (one name)` : `family name ${r.family}${r.given ? `, given ${r.given}` : ""}${r.suffix ? `, ${r.suffix}` : ""}` }), " ", statusBadge(r.stated ? "Your wording" : "Writer's reading", r.stated ? "ok" : "warn")), h("div", { class: "fine", text: `In the reference list: ${r.display}` }));
            if (r.note)
                row.appendChild(h("p", { class: "fine", text: r.note }));
            const actions = h("div", { class: "actions" });
            const write = (text) => { if (!apply(index, text, r.typed))
                refresh(); };
            if (!r.stated)
                actions.appendChild(button("Confirm this reading", () => write(r.canonical)));
            if (!r.stated && !r.literal)
                actions.appendChild(button("Keep as one name", () => write(`{${r.typed.trim().replace(/[{}]/g, "")}}`)));
            actions.appendChild(button("Change…", () => { if (!row.querySelector(".name-form"))
                form(index, r, row); }));
            row.appendChild(actions);
            root.appendChild(row);
        }
    };
    const refresh = () => {
        if (root.querySelector(".name-form"))
            return; // a correction is being entered: never repaint it away (Cancel and Use refresh afterwards)
        const mine = ++seq;
        const lines = linesOf(field.value);
        if (!lines.some((l) => l.trim())) {
            root.replaceChildren();
            return;
        }
        void readNames(lines).then((rows) => { if (mine === seq && !root.querySelector(".name-form"))
            paint(rows); }).catch(() => { if (mine === seq)
            root.replaceChildren(); });
    };
    field.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 350); });
    return { root, refresh };
}
