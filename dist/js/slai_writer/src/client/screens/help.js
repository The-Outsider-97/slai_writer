import { buildShell } from "../shell.js";
import { copyText, h, toast } from "../kit.js";
import { button, notice, section } from "../widgets.js";
export const SHORTCUTS = [
    ["Ctrl+S", "Save"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["Ctrl+B / I / U", "Bold / italic / underline"], ["Ctrl+K", "Link"], ["Ctrl+F", "Find in the document"],
    ["/ (empty line) or Ctrl+/", "Search Writer's commands"], ["Ctrl+Alt+1…3", "Heading 1–3"], ["Ctrl+Alt+0", "Normal text"],
    ["Ctrl+Enter", "New page: a page break (the key of Word and Canva)"],
    ["Ctrl+Alt+Enter", "New section: a section break with its own page setup (Writer's own key; Word, InDesign and Canva have none)"],
    ["Ctrl+Alt+Shift+N", "New layer (Photoshop's key for a new layer; Ctrl+Shift+N belongs to the browser's private window). A selected object goes onto it"],
    ["Ctrl+D", "Add an illustration: choose a picture to place (InDesign's Place)"],
    ["Ctrl+Alt+B", "Add a page background colour (Writer's own key)"],
    ["Ctrl+] / Ctrl+[", "Selected free picture: in front of the text / behind the text (Canva's forward and backward)"],
    ["Arrow keys", "Selected free picture: move 0.5 mm (Shift: 5 mm)"],
    ["Tab / Shift+Tab", "Indent / outdent a list item; next / previous table cell"],
    ["Ctrl+Shift+8 / 7", "Bulleted / numbered list"], ["Ctrl+Alt+M", "Add a comment"], ["Ctrl+\\", "Clear formatting"], ["Ctrl+Plus / Minus / 0", "Zoom in / out / 100%"], ["Esc", "Close a panel or dialog"],
];
export function helpScreen(app) {
    const shell = buildShell(app, "help");
    const caps = app.boot.capabilities;
    const diagnostics = () => [
        `SLAI Writer ${app.boot.app.version}`, `Plan: ${app.plan}`, `Signed in: ${app.signedIn ? "yes" : "no (guest)"}`,
        `Documaster: ${caps.documaster.available ? "ready" : `unavailable (${caps.documaster.reason ?? "unknown"})`}`, `Spell checker: ${caps.ai.spell.available ? "ready" : "unavailable"}`,
        `AI providers: ${caps.ai.providers.map((p) => `${p.id}=${p.available ? "yes" : "no"}`).join(", ") || "none"}`, `E-mail configured: ${caps.email.configured ? "yes" : "no"}`, `Billing connected: ${caps.billing.configured ? "yes" : "no"}`,
        `Workspace: ${caps.workspace.available ? "connected" : "not connected"}`, `Open documents: ${app.docs.size}`, `Browser: ${navigator.userAgent}`,
    ].join("\n");
    shell.main.append(h("h2", { class: "page-title", text: "Support SLAI Writer" }), section("Keyboard shortcuts", h("table", { class: "docs" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Keys" }), h("th", { scope: "col", text: "Does" }))), h("tbody", {}, SHORTCUTS.map(([k, d]) => h("tr", {}, h("th", { scope: "row" }, h("kbd", { text: k })), h("td", { text: d })))))), section("How Writer works", h("p", { text: "Documents are SLDC files (.sldc) saved on this computer. Writer works fully offline and without an account or AI." }), h("p", { text: "Page numbers in the editor are an estimate. The exact count comes from the PDF rendering used for Print and Export." }), h("p", { text: "Spelling, grammar and the AI Assistant only run when you start them, only on the text you choose, and show you every change before it is applied. Each can be undone." }), h("p", { text: "A signature graphic is a picture. Only cryptographic signing proves a revision is unchanged; neither proves the content is true." })), section("Diagnostics", notice("This summary contains no document text, passwords or keys. Copy it when you ask for help.", "info"), h("pre", { class: "diagnostics", text: diagnostics() }), h("div", { class: "actions" }, button("Copy diagnostics", async () => { toast((await copyText(diagnostics())) ? "Copied." : "Could not copy; select the text and copy it by hand."); }, "", "copy"))), section("Contact", h("p", { text: "No support address or chat is configured in this installation. See docs/OPERATIONS.md for where to report problems for your deployment." })));
    return { el: shell.el, destroy: shell.dispose };
}
