/** Small building blocks the screens share (buttons with a busy state, text fields, notices, status lines). Everything is built with the kit's `h`. */
import { announce, glyph, h, labelled, nextId, toast } from "./kit.js";
import { errorText } from "./net.js";
export function button(label, onClick, kind = "", icon) {
    const el = h("button", { class: `btn${kind ? ` ${kind}` : ""}`, type: "button" }, icon ? glyph(icon) : null, label);
    el.addEventListener("click", () => { void run(el, onClick); });
    return el;
}
/** Disable a control while its work runs, so a double click cannot send a request twice, and show failures in a toast. */
export async function run(el, work) {
    if (el.getAttribute("aria-busy") === "true")
        return;
    el.setAttribute("aria-busy", "true");
    if (el instanceof HTMLButtonElement)
        el.disabled = true;
    try {
        await work();
    }
    catch (error) {
        toast(errorText(error), { kind: "error" });
    }
    finally {
        el.removeAttribute("aria-busy");
        if (el instanceof HTMLButtonElement)
            el.disabled = false;
    }
}
export function iconButton(icon, label, onClick, extra = "") {
    const el = h("button", { class: `iconbtn${extra ? ` ${extra}` : ""}`, type: "button", attrs: { "aria-label": label, title: label } }, glyph(icon));
    el.addEventListener("click", () => { void run(el, onClick); });
    return el;
}
export function textField(label, options = {}) {
    const input = h("input", {
        type: options.type ?? "text", value: options.value ?? "", maxLength: options.maxLength ?? 300,
        attrs: { placeholder: options.placeholder, autocomplete: options.autocomplete ?? "off", required: options.required, name: options.name, spellcheck: "false", autocapitalize: "off" },
    });
    return { root: labelled(label, input, options.hint ? { hint: options.hint } : {}), input };
}
export function checkbox(label, checked, onChange) {
    const id = nextId("chk");
    const input = h("input", { type: "checkbox", id, checked });
    if (onChange)
        input.addEventListener("change", () => onChange(input.checked));
    return { root: h("div", { class: "check" }, input, h("label", { attrs: { for: id }, text: label })), input };
}
export function selectField(label, options, value, onChange) {
    const select = h("select", {}, options.map(([v, text]) => h("option", { value: v, text, selected: v === value })));
    select.value = value;
    if (onChange)
        select.addEventListener("change", () => onChange(select.value));
    return { root: labelled(label, select), select };
}
export function notice(message, tone = "info", title) {
    return h("div", { class: `notice ${tone}`, attrs: { role: tone === "danger" ? "alert" : "note" } }, glyph(tone === "ok" ? "check-circle" : tone === "info" ? "info" : "alert"), h("div", {}, title ? h("strong", { text: title }) : null, title ? " " : null, message));
}
/** An inline error line that screen readers read out when it appears. */
export function errorLine() {
    const el = h("p", { class: "form-error", attrs: { role: "alert" }, hidden: true });
    return { el, show(message) { el.hidden = !message; el.textContent = message ?? ""; if (message)
            announce(message, "assertive"); } };
}
/** Text status next to a coloured dot, so colour is never the only signal. */
export function statusBadge(text, tone = "idle") {
    return h("span", { class: `status ${tone}` }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), text);
}
export function when(iso) {
    if (iso === null || iso === undefined || iso === "")
        return "";
    const date = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
    if (Number.isNaN(date.getTime()))
        return String(iso);
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export function ago(epochSeconds, now = Date.now() / 1000) {
    if (!epochSeconds)
        return "not yet";
    const s = Math.max(0, Math.round(now - epochSeconds));
    if (s < 45)
        return "just now";
    if (s < 3600)
        return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400)
        return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}
export function mmss(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
/** A countdown that updates every second until `until` (epoch ms) and calls `done` at zero. Returns a stop function. */
export function countdown(target, until, done) {
    const tick = () => { const left = Math.round((until - Date.now()) / 1000); target.textContent = mmss(left); if (left <= 0) {
        stop();
        done?.();
    } };
    const timer = window.setInterval(tick, 1000);
    const stop = () => window.clearInterval(timer);
    tick();
    return stop;
}
export function pickFile(accept, multiple = false) {
    return new Promise((resolve) => {
        const input = h("input", { type: "file", multiple, hidden: true, attrs: { accept } });
        input.addEventListener("change", () => { resolve([...(input.files ?? [])]); input.remove(); });
        input.addEventListener("cancel", () => { resolve([]); input.remove(); });
        document.body.appendChild(input);
        input.click();
    });
}
export function section(title, ...children) {
    return h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: title })), ...children);
}
export function emptyState(title, message) {
    return h("div", { class: "empty" }, h("strong", { text: title }), h("p", { class: "muted", text: message }));
}
/** Append children, skipping null / undefined / false (Node.append would print them). */
export function fill(parent, ...children) {
    const walk = (c) => {
        if (c === null || c === undefined || c === false)
            return;
        if (Array.isArray(c)) {
            c.forEach(walk);
            return;
        }
        parent.append(typeof c === "object" ? c : String(c));
    };
    children.forEach(walk);
}
