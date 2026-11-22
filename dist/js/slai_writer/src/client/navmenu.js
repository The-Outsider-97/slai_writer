/** The sandwich menu of the design (page 13): a white rounded panel under the top bar with Home, New Page, Open, Upload, Export, Import,
 *  Favorite, Version history, Header, Footer and Print, and Profile / Login and Settings at the bottom. While it is open the sandwich
 *  shows a cross. The entries are the same ones the navigation of Home uses (shell.ts), so a command exists once. */
import { COMMANDS } from "./commands.js";
import { dico } from "./dico.js";
import { h, toast } from "./kit.js";
import { errorText } from "./net.js";
import { sidebarItems } from "./shell.js";
export function createNavMenu(ctx, anchor, onChange) {
    const { app } = ctx;
    let panel = null;
    const entries = () => {
        const { top, bottom } = sidebarItems(app);
        const hf = COMMANDS.find((c) => c.id === "header-footer");
        const header = (id, label, icon) => ({ id, label, icon, disabled: ctx.ed.readOnly, run: () => hf.run(ctx) });
        const out = [];
        for (const item of top) {
            if (item.id === "print") {
                out.push(header("header", "Header", "n-header"), header("footer", "Footer", "n-footer"));
            }
            out.push({ id: item.id, label: item.label, icon: item.design, run: item.run });
        }
        return { top: out, bottom: bottom.filter((b) => b.id === "profile" || b.id === "settings").map((b) => ({ id: b.id, label: b.label, icon: b.design, run: b.run })) };
    };
    const close = (restoreFocus = true) => {
        if (!panel)
            return;
        panel.remove();
        panel = null;
        document.removeEventListener("mousedown", outside, true);
        document.removeEventListener("keydown", onKey, true);
        onChange(false);
        if (restoreFocus)
            anchor().focus();
    };
    const outside = (e) => { if (panel && !panel.contains(e.target) && !anchor().contains(e.target))
        close(false); };
    const items = () => (panel ? Array.from(panel.querySelectorAll("button[role=menuitem]:not(:disabled)")) : []);
    const onKey = (e) => {
        if (!panel)
            return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (e.key === "Tab") {
            close(false);
            return;
        }
        const list = items();
        const at = list.indexOf(document.activeElement);
        const go = (i) => { e.preventDefault(); e.stopPropagation(); list[(i + list.length) % list.length]?.focus(); };
        if (e.key === "ArrowDown")
            go(at + 1);
        else if (e.key === "ArrowUp")
            go(at < 0 ? list.length - 1 : at - 1);
        else if (e.key === "Home")
            go(0);
        else if (e.key === "End")
            go(list.length - 1);
    };
    const open = () => {
        if (panel)
            return;
        const { top, bottom } = entries();
        const make = (entry) => {
            const b = h("button", { class: "navitem", type: "button", disabled: entry.disabled === true, attrs: { role: "menuitem", "data-id": entry.id } }, dico(entry.icon), h("span", { text: entry.label }));
            b.addEventListener("click", () => { close(false); void Promise.resolve(entry.run()).catch((err) => toast(errorText(err), { kind: "error" })); });
            return b;
        };
        panel = h("nav", { class: "navmenu", attrs: { role: "menu", "aria-label": "Menu" } }, h("div", { class: "navgroup" }, top.map(make)), h("div", { class: "navgroup bottom" }, bottom.map(make)));
        const r = anchor().closest("header")?.getBoundingClientRect();
        panel.style.setProperty("top", `${(r?.bottom ?? 52) + 3}px`);
        document.body.appendChild(panel);
        document.addEventListener("mousedown", outside, true);
        document.addEventListener("keydown", onKey, true);
        onChange(true);
        items()[0]?.focus();
    };
    return { toggle: () => (panel ? close() : open()), open, close: () => close(), get isOpen() { return panel !== null; }, dispose: () => close(false) };
}
