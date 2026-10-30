import { api, errorText, rawPost } from "../net.js";
import { buildShell } from "../shell.js";
import { appearanceControls, clear, confirmDialog, glyph, h, labelled, toast } from "../kit.js";
import { button, checkbox, notice, pickFile, run, section, selectField, statusBadge, fill } from "../widgets.js";
const BUILTIN_LABEL = { auto: "Automatic", default: "Arrow", pointer: "Hand", crosshair: "Crosshair", grab: "Open hand", move: "Move", text: "Text bar", cell: "Cell", copy: "Copy", alias: "Link" };
export async function settingsScreen(app) {
    const shell = buildShell(app, "settings");
    const save = async (patch) => { try {
        await app.setPrefs(patch);
    }
    catch (e) {
        toast(errorText(e), { kind: "error" });
    } };
    const p = app.prefs;
    const caps = app.boot.capabilities;
    /* appearance */
    const appearance = section("Appearance", appearanceControls({ theme: p.theme, scale: p.scale, motion: p.motion }, (next) => { void save({ theme: next.theme, scale: next.scale, motion: next.motion }); }));
    /* documents */
    const autosave = checkbox("Autosave documents that already have a file", p.autosave, (v) => { void save({ autosave: v }); });
    const interval = h("input", { type: "number", min: 10, max: 3600, step: 5, value: String(p.autosave_seconds) });
    interval.addEventListener("change", () => { const n = Math.max(10, Math.min(3600, Number(interval.value) || 60)); interval.value = String(n); void save({ autosave_seconds: n }); });
    const size = selectField("Default page size", ["A4", "A5", "A3", "B5", "Letter", "Legal"].map((s) => [s, s]), p.page_size, (v) => { void save({ page_size: v }); });
    const orient = selectField("Default orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], p.orientation, (v) => { void save({ orientation: v }); });
    const units = selectField("Ruler units", [["mm", "Millimetres"], ["in", "Inches"]], p.units, (v) => { void save({ units: v }); });
    const zoom = selectField("Open documents zoomed to", [["custom", `Last zoom (${p.zoom}%)`], ["height", "Page height"], ["width", "Page width"]], p.zoom_mode, (v) => { void save({ zoom_mode: v }); });
    const rulers = checkbox("Show rulers", p.show_rulers, (v) => { void save({ show_rulers: v }); });
    const guides = checkbox("Show margin and guide lines", p.show_guides, (v) => { void save({ show_guides: v }); });
    const docs = section("Documents", autosave.root, labelled("Autosave interval (seconds)", interval, { hint: "Applies when autosave is on. Right-click Save in the editor to change it for one document." }), h("div", { class: "grid-2" }, size.root, orient.root), h("div", { class: "grid-2" }, units.root, zoom.root), rulers.root, guides.root);
    /* pointers */
    const pointerHost = h("div", {});
    const paintPointers = async () => {
        const data = await api.get("/cursors");
        const prefs = app.prefs;
        clear(pointerHost);
        const options = [...data.builtin.map((b) => [b, BUILTIN_LABEL[b] ?? b]), ...data.custom.map((c) => [c.value, `${c.label} (imported)`])];
        const rows = [["cursor_default", "Default pointer"], ["cursor_drag", "Drag and drop"], ["cursor_draw", "Manual drawings"], ["cursor_text", "When typing in the page"]];
        const grid = h("div", { class: "grid-2" }, rows.map(([key, label]) => selectField(label, options, String(prefs[key]), (v) => { void save({ [key]: v }); }).root));
        const label = h("input", { type: "text", value: "My pointer", maxLength: 40 });
        const hx = h("input", { type: "number", min: 0, max: 127, value: "0" });
        const hy = h("input", { type: "number", min: 0, max: 127, value: "0" });
        const importer = button("Import a pointer picture…", async () => {
            const [file] = await pickFile("image/png");
            if (!file)
                return;
            await rawPost("/cursors", file, "image/png", { label: label.value, x: Number(hx.value) || 0, y: Number(hy.value) || 0 });
            toast("Pointer imported. Choose where it appears above.", { kind: "ok" });
            await paintPointers();
        }, "", "upload");
        const custom = data.custom.length ? h("ul", { class: "formats" }, data.custom.map((c) => {
            const del = h("button", { class: "btn small danger", type: "button" }, glyph("trash"), `Delete ${c.label}`);
            del.addEventListener("click", () => {
                void run(del, async () => {
                    if (!await confirmDialog({ title: `Delete the pointer “${c.label}”?`, message: "Places that use it go back to their default pointer.", confirmLabel: "Delete", danger: true }))
                        return;
                    const out = await api.del(`/cursors/${c.id}`);
                    void out;
                    await app.refresh();
                    await paintPointers();
                });
            });
            return h("li", {}, h("img", { class: "cursor-thumb", attrs: { src: `/api/cursors/${c.id}.png`, alt: "" } }), h("span", { class: "grow", text: `${c.label} · hot spot ${c.hotspot[0] ?? 0}, ${c.hotspot[1] ?? 0}` }), del);
        })) : null;
        fill(pointerHost, h("p", { class: "muted", text: "Choose which pointer appears in each situation. You can import your own PNG (up to 300 KiB, at most 128×128 pixels); the hot spot is the pixel that points." }), grid, custom, h("div", { class: "grid-3" }, labelled("Label", label), labelled("Hot spot x", hx), labelled("Hot spot y", hy)), importer);
    };
    /* proofing and AI */
    const spell = checkbox("Check spelling when I ask (and mark what it finds)", p.spell, (v) => { void save({ spell: v }); });
    const grammar = checkbox("Check grammar when I ask", p.grammar, (v) => { void save({ grammar: v }); });
    const online = checkbox("Verify DOIs online when I press Verify DOI", p.lookup_online, (v) => { void save({ lookup_online: v }); });
    const aiOn = checkbox("Allow the AI Assistant", p.ai_enabled, (v) => { void save({ ai_enabled: v }).then(() => repaintAi()); });
    const aiCloud = checkbox("Allow cloud processing (the selected text leaves this computer)", p.ai_cloud, (v) => { void save({ ai_cloud: v }); });
    const aiNotes = checkbox("Include my private notes in requests", p.ai_notes, (v) => { void save({ ai_notes: v }); });
    const budget = h("input", { type: "number", min: 0, max: 100000, step: 10, value: String(p.ai_budget) });
    budget.addEventListener("change", () => { void save({ ai_budget: Math.max(0, Math.min(100000, Number(budget.value) || 0)) }); });
    const aiState = h("div", {});
    const repaintAi = () => {
        clear(aiState);
        const ai = app.boot.capabilities.ai;
        for (const prov of ai.providers)
            aiState.appendChild(h("p", {}, statusBadge(prov.available ? "Available" : "Unavailable", prov.available ? "ok" : "warn"), ` ${prov.label}: ${prov.note}`));
        aiState.appendChild(h("p", { class: "fine", text: ai.privacy }));
    };
    const proof = section("Proofing and AI", notice("Writing, editing, undo and autosave work fully without any of this. Nothing is checked or sent anywhere unless you start it, and every suggestion is shown for review before it changes the text.", "info"), spell.root, grammar.root, online.root, h("hr"), aiOn.root, aiCloud.root, labelled("Cloud credit budget per request", budget, { hint: "Cloud processing needs your approval each time and stays within this budget. 0 means none." }), aiNotes.root, aiState);
    /* security links and components */
    const links = section("Account and signatures", h("div", { class: "actions" }, button(app.signedIn ? "Account security" : "Log in", () => { app.go({ name: app.signedIn ? "profile" : "startup" }); }, "", "shield"), button("Signature graphics", () => { app.go({ name: "signatures" }); }, "", "signature")));
    const comp = (name, ok, text) => h("li", {}, statusBadge(ok === null ? "Not set up" : ok ? "Available" : "Unavailable", ok ? "ok" : "warn"), h("strong", { text: ` ${name}: ` }), text);
    const components = section("Components on this computer", h("ul", { class: "formats" }, comp("Documaster (PDF, Word, import)", caps.documaster.available, caps.documaster.available ? `ready${caps.documaster.version ? ` (${caps.documaster.version})` : ""}` : caps.documaster.reason ?? "not found"), comp("Spell checker", caps.ai.spell.available, caps.ai.spell.note), comp("Grammar and AI", caps.ai.grammar.available, caps.ai.grammar.note), comp("E-mail (sign-up and password reset)", caps.email.configured, caps.email.configured ? "configured" : caps.email.reason ?? "not configured"), comp("QR codes for authenticators", caps.qr.available, caps.qr.available ? "ready" : caps.qr.reason ?? "unavailable"), comp("Billing", caps.billing.configured, caps.billing.configured ? "connected" : caps.billing.reason ?? "no payment provider is connected"), comp("Shared workspace", caps.workspace.available, caps.workspace.available ? "connected" : caps.workspace.reason), comp("Native file dialogs", caps.nativePicker, caps.nativePicker ? "available" : "not available; Writer uses its own chooser")));
    shell.main.append(h("h2", { class: "page-title", text: "Settings" }), appearance, docs, section("Pointers", pointerHost), proof, links, components);
    repaintAi();
    await paintPointers();
    return { el: shell.el, destroy: shell.dispose };
}
