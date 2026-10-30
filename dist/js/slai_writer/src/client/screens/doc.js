import * as A from "../actions.js";
import { COMMANDS, contextMenu, openPalette } from "../commands.js";
import { equationDialog, figureDialog, pageSetupDialog, pictureDialog, tableToolsDialog } from "../dialogs.js";
import { buildFormatBar, buildStatusBar, buildTopBar } from "../docbars.js";
import { PageAttachments } from "../attach.js";
import { createNavMenu } from "../navmenu.js";
import { createLeftSide, createRightSide } from "../sidepanels.js";
import { ImageTools } from "../imageedit.js";
import { externalDialog, saveAsDialog, saveDocument } from "../docsave.js";
import { Editor } from "../editor.js";
import { Find } from "../find.js";
import { installInput } from "../input.js";
import { announce, clear, h, toast } from "../kit.js";
import { api, errorText } from "../net.js";
import { createEmbedDrawer } from "../panels/embed.js";
import { createCommentsPanel, createNotesPanel, loadNotes, noteFromMatch, paintCommentMarks, paintNoteMarks } from "../panels/notes.js";
import { createProofPanel } from "../panels/proof.js";
import { createRightPanel } from "../panels/right.js";
import { createSourcesPanel } from "../panels/sources.js";
import { button, fill, notice } from "../widgets.js";
// A new ribbon is visible on documents by default, independently of the old optional-format-bar preference.
const BAR_KEY = "writer.documentRibbon";
function barPref() { try {
    return window.localStorage.getItem(BAR_KEY) !== "0";
}
catch {
    return true;
} }
function setBarPref(on) { try {
    window.localStorage.setItem(BAR_KEY, on ? "1" : "0");
}
catch { /* a per-viewer convenience only */ } }
export async function docScreen(app, route) {
    const sid = route.sid ?? "";
    const state = await api.get(`/docs/${encodeURIComponent(sid)}`);
    app.remember(state);
    await app.openDocs().catch(() => undefined);
    const cursors = await api.get("/cursors").catch(() => ({ custom: [] }));
    const ed = new Editor(state, { prefs: () => app.prefs });
    const uninstall = installInput(ed);
    ed.setCursors(app.prefs, cursors.custom);
    document.title = `${state.title} – SLAI Writer`;
    let ctx;
    const dockPanels = new Map();
    let noteCache = [];
    let staleBanner = false;
    let externalBanner = false;
    let hiddenMode = false;
    let zoomMode = app.prefs.zoom_mode;
    let zoomSave;
    /* ---------------------------------------------------------------------------------------------- the pieces */
    const find = new Find({ get app() { return app; }, get ed() { return ed; }, sid, get ui() { return ui; } });
    const root = h("div", { class: "doc" });
    const banners = h("div", { class: "banners", attrs: { "aria-live": "polite" } });
    let yellowTabName = "notes";
    let attachments;
    let quiet = false;
    let nav;
    const embedHost = { show: () => { if (!attachments.isOpen("embed")) {
            quiet = true;
            attachments.open("embed");
            quiet = false;
        } }, hide: () => attachments.close("embed"), isOpen: () => attachments.isOpen("embed") };
    const drawer = createEmbedDrawer({ get app() { return app; }, get ed() { return ed; }, sid, get ui() { return ui; } }, embedHost);
    /* ------------------------------------------------------------------------------------------------- the UI hooks */
    const ui = {
        openPanel(kind, tab) { openPanel(kind, tab); },
        focusFind() { top.search.focus(); top.search.select(); },
        save: () => saveDocument(ctx),
        saveAs: () => saveAsDialog(ctx),
        refreshStatus() { top.update(); status.update(); format.update(); document.title = `${ed.model.meta.title} – SLAI Writer`; },
        showEmbed(block) {
            if (block === null) {
                drawer.close();
                return;
            }
            const at = block === "new" ? -1 : ed.page.sheets.findIndex((s) => s.blocks.some((el) => el.dataset["id"] === block));
            quiet = true;
            attachments.open("embed", at >= 0 ? at : currentSheet());
            quiet = false;
            void drawer.open(block);
        },
        toggleRight() { rightSide.toggle(); },
        showLayers() { rightSide.set(true); rightPanel.openSection("layers"); },
        toggleLeft() { leftSide.toggle(); },
        toggleFormatBar() { format.el.hidden = !format.el.hidden; setBarPref(!format.el.hidden); window.setTimeout(() => { ed.page.redecorate(); }, 0); },
        palette(x, y) { const sel = ed.recallSelection(); openPalette(ctx, x, y, () => ed.refocus(sel)); },
        setZoom: (request) => setZoom(request),
        async reload(next) { await ed.resync(next); ui.refreshStatus(); },
        toggleHidden() { hiddenMode = !hiddenMode; if (hiddenMode)
            root.dataset["hidden"] = "";
        else
            delete root.dataset["hidden"]; status.el.querySelector("button[aria-pressed]")?.setAttribute("aria-pressed", String(hiddenMode)); const label = status.el.querySelector("button[aria-pressed] span"); if (label)
            label.textContent = hiddenMode ? "Reveal" : "Hide"; announce(hiddenMode ? "Everything except the page is hidden. Press Reveal or Escape to show it." : "Revealed."); },
    };
    ctx = { app, ed, sid, ui };
    const imageTools = new ImageTools(ed, { details: (block) => { void figureDialog(ctx, block); } });
    const top = buildTopBar(ctx, find, () => nav);
    nav = createNavMenu(ctx, () => top.menuButton, (open) => top.setMenuOpen(open));
    const format = buildFormatBar(ctx);
    format.el.hidden = !barPref();
    const status = buildStatusBar(ctx, (r) => setZoom(r));
    const currentSheet = () => Math.max(0, ed.currentPage() - 1);
    /* ------------------------------------------------------------------------------- panels attached to a page */
    const panelFor = (name) => {
        const have = dockPanels.get(name);
        if (have)
            return have;
        let panel;
        if (name === "proofing")
            panel = createProofPanel(ctx);
        else if (name === "notes")
            panel = createNotesPanel(ctx, (notes) => { noteCache = notes; paintNoteMarks(ctx, notes); });
        else if (name === "comments")
            panel = createCommentsPanel(ctx);
        else
            panel = createSourcesPanel(ctx);
        dockPanels.set(name, panel);
        return panel;
    };
    const yellowTabs = h("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Notes, comments and sources" } });
    const yellowBody = h("div", { class: "dock-body" });
    const yellowContent = h("div", { class: "pcontent" }, yellowTabs, yellowBody);
    const redContent = h("div", { class: "pcontent" });
    const paintYellow = () => {
        const hadFocus = yellowContent.contains(document.activeElement);
        clear(yellowTabs);
        for (const [id, label] of [["notes", "Notes"], ["comments", "Comments"], ["sources", "Sources"]]) {
            const b = h("button", { class: "tabbtn", type: "button", text: label, attrs: { role: "tab", "aria-selected": String(id === yellowTabName), tabindex: id === yellowTabName ? "0" : "-1" } });
            b.addEventListener("click", () => { yellowTabName = id; paintYellow(); });
            yellowTabs.appendChild(b);
        }
        clear(yellowBody);
        const panel = panelFor(yellowTabName);
        yellowBody.appendChild(panel.el);
        void panel.refresh();
        if (hadFocus)
            yellowTabs.querySelector("[aria-selected=true]")?.focus(); // rebuilding the tabs must not drop keyboard focus
    };
    yellowTabs.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft")
            return;
        const order = ["notes", "comments", "sources"];
        yellowTabName = order[(order.indexOf(yellowTabName) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
        paintYellow();
        yellowTabs.querySelector("[aria-selected=true]")?.focus();
    });
    attachments = new PageAttachments(ed.page, [
        { kind: "red", label: "Corrections: spelling, grammar and the AI Assistant", content: redContent },
        { kind: "yellow", label: "Notes, comments and sources", content: yellowContent },
        { kind: "embed", label: "EMBED component", content: drawer.el },
    ], currentSheet);
    attachments.onChange = (kind, open) => {
        if (!open) {
            window.setTimeout(() => ed.layout(), 0);
            return;
        }
        // one panel per side: Corrections replace the Tools panel, Notes replace the organisation panel (EMBED is below the page and is unaffected)
        if (kind === "red")
            leftSide.set(false);
        if (kind === "yellow")
            rightSide.set(false);
        if (kind === "red") {
            if (!redContent.firstChild)
                redContent.appendChild(panelFor("proofing").el);
            void panelFor("proofing").refresh();
        }
        if (kind === "yellow")
            paintYellow();
        if (kind === "embed" && !quiet)
            void drawer.openFromTab(); // opened from the page's own tab; opening for a component fills it itself
        window.setTimeout(() => ed.layout(), 0);
    };
    /** Open one of the page's panels; with a tab it opens (never toggles), without one the page's tab toggles it. */
    function openPanel(kind, tab) {
        const sheet = currentSheet();
        if (kind === "red") {
            if (tab)
                attachments.open("red", sheet);
            else
                attachments.toggle("red", sheet);
            if (tab === "ai" && attachments.isOpen("red"))
                window.setTimeout(() => Array.from(redContent.querySelectorAll("h2")).find((x) => x.textContent === "AI Assistant")?.scrollIntoView({ block: "start" }), 0);
        }
        else if (kind === "yellow") {
            if (tab && ["notes", "comments", "sources"].includes(tab)) {
                yellowTabName = tab;
                attachments.open("yellow", sheet);
                paintYellow();
            }
            else
                attachments.toggle("yellow", sheet);
        }
        else if (attachments.isOpen("embed") && !tab)
            attachments.close("embed");
        else {
            quiet = true;
            attachments.open("embed", sheet);
            quiet = false;
            void drawer.openFromTab();
        }
    }
    /* ------------------------------------------------------------------------------------------------ layout */
    const rightPanel = createRightPanel(ctx);
    const leftSide = createLeftSide(ctx);
    const rightSide = createRightSide(ctx, rightPanel);
    leftSide.onToggle = (open) => { if (open)
        attachments.close("red"); };
    rightSide.onToggle = (open) => { if (open)
        attachments.close("yellow"); };
    ed.page.cornerLeft.appendChild(leftSide.arrow);
    ed.page.cornerRight.appendChild(rightSide.arrow);
    const body = h("div", { class: "doc-body" }, leftSide.el, ed.page.el, rightSide.el);
    fill(root, top.el, format.el, top.replaceRow, banners, body, status.el, h("div", { class: "reveal-veil", attrs: { "aria-hidden": "true" } }));
    /* ---------------------------------------------------------------------------------------------- banners */
    let notesDismissed = false;
    const paintBanners = () => {
        clear(banners);
        if (ed.readOnly)
            banners.appendChild(notice(h("span", {}, state.access.readOnlyReason ?? ed.model.state.access.readOnlyReason ?? "This document is read-only.", " ", button("Save an editable copy…", () => { void saveAsDialog(ctx); }, "", "save")), "info", "Read-only."));
        if (staleBanner)
            banners.appendChild(notice(h("span", {}, "This document was changed somewhere else (another window or program) after your screen last updated. Your latest typing may not be saved. ", button("Load the latest version", async () => { await ed.resync(); staleBanner = false; paintBanners(); ui.refreshStatus(); }, "primary")), "danger", "Out of date."));
        if (externalBanner)
            banners.appendChild(notice(h("span", {}, "The file was changed by another program. Nothing was overwritten. ", button("Decide what to do…", async () => { if (await externalDialog(ctx)) {
                externalBanner = false;
                paintBanners();
            } }, "primary")), "warn", "File changed on disk."));
        const notes = ed.model.state.notices;
        if (notes.length && !notesDismissed) {
            const dismiss = h("button", { class: "linkbtn", type: "button", text: "Dismiss" });
            dismiss.addEventListener("click", () => { notesDismissed = true; paintBanners(); });
            banners.appendChild(notice(h("span", {}, h("ul", {}, notes.map((n) => h("li", { text: n }))), dismiss), "info", "About this document."));
        }
    };
    /* ------------------------------------------------------------------------------------------------- zoom */
    function setZoom(request) {
        let percent;
        if (request === "height" || request === "width") {
            zoomMode = request;
            percent = ed.page.fitZoom(request);
        }
        else {
            zoomMode = "custom";
            percent = Math.max(10, Math.min(400, Math.round(request)));
        }
        ed.setZoom(percent);
        status.setZoom(percent, zoomMode);
        window.clearTimeout(zoomSave);
        zoomSave = window.setTimeout(() => { void app.setPrefs({ zoom: percent, zoom_mode: zoomMode }).catch(() => undefined); }, 700);
    }
    /* ------------------------------------------------------------------------------------------------ events */
    let frame = 0;
    const refreshBars = () => {
        if (frame)
            return;
        frame = window.requestAnimationFrame(() => { frame = 0; top.update(); status.update(); format.update(); });
    };
    let marksTimer;
    let findTimer;
    const afterEdit = () => {
        window.clearTimeout(marksTimer);
        marksTimer = window.setTimeout(() => { paintNoteMarks(ctx, noteCache); paintCommentMarks(ctx); }, 250);
        if (find.active) {
            window.clearTimeout(findTimer);
            findTimer = window.setTimeout(() => { void find.search(find.query, true); }, 500);
        }
    };
    const files = async (list, after) => {
        let anchor = after;
        for (const file of list) {
            if (!file.type.startsWith("image/")) {
                toast(`“${file.name}” is not a picture. To bring in a document, use Import.`, { kind: "info" });
                continue;
            }
            await pictureDialog(ctx, file, anchor);
            anchor = null;
        }
    };
    const offEditor = ed.events.on((e) => {
        switch (e.type) {
            case "patch": {
                const summary = app.docs.get(sid);
                if (summary && summary.dirty !== e.patch.dirty)
                    app.docs.set(sid, { ...summary, dirty: e.patch.dirty });
                ed.model.state = { ...ed.model.state, lastEdit: Date.now() / 1000 };
                refreshBars();
                afterEdit();
                break;
            }
            case "selection":
            case "layout":
            case "comments":
                refreshBars();
                if (e.type === "layout")
                    afterEdit();
                break;
            case "reloaded":
                staleBanner = false;
                paintBanners();
                refreshBars();
                afterEdit();
                break;
            case "stale":
                staleBanner = true;
                paintBanners();
                break;
            case "slash":
                ui.palette(e.x, e.y);
                break;
            case "context": {
                const sel = ed.recallSelection();
                contextMenu(ctx, e.x, e.y, () => ed.refocus(sel));
                break;
            }
            case "files":
                void files(e.files, e.after);
                break;
            case "open-object": {
                const block = ed.model.block(e.block);
                if (!block)
                    break;
                if (e.kind === "embed")
                    ui.showEmbed(e.block);
                else if (e.kind === "equation")
                    void equationDialog(ctx, block);
                else if (e.kind === "figure")
                    void figureDialog(ctx, block);
                else
                    void tableToolsDialog(ctx, e.block);
                break;
            }
            case "note-from-match":
                void (async () => { try {
                    const id = await noteFromMatch(ctx, e.block, e.start, e.end);
                    if (id) {
                        openPanel("yellow", "notes");
                    }
                }
                catch (err) {
                    toast(errorText(err), { kind: "error" });
                } })();
                break;
            case "page-double":
                if (ed.readOnly)
                    toast("This document is read-only, so guides cannot be added.", { kind: "info" });
                else
                    void ed.addGuides(e.xMm, e.yMm);
                break;
            case "ruler-double":
                if (!ed.readOnly)
                    void pageSetupDialog(ctx);
                break;
            case "link":
                if (/^(https?:|mailto:)/i.test(e.href))
                    window.open(e.href, "_blank", "noopener,noreferrer");
                break;
            case "reference":
                openPanel("yellow", "sources");
                break;
            case "save":
                void saveDocument(ctx);
                break;
            case "find":
                ui.focusFind();
                break;
            case "command": {
                const c = COMMANDS.find((x) => x.id === e.name);
                if (c)
                    void Promise.resolve(c.run(ctx));
                break;
            }
            case "error": break;
            default: break;
        }
    });
    const offApp = app.events.on((e) => {
        if (e.type === "docs" || e.type === "offline")
            refreshBars();
        if (e.type === "prefs") {
            ed.setCursors(app.prefs, cursors.custom);
            ed.layout();
            refreshBars();
        }
    });
    /* screen-wide keys (the editor handles its own in input.ts) */
    /** Run a Writer command from a shortcut, saying why when it cannot run right now (read-only document, no cursor in the text). */
    const runCommand = (id) => {
        const command = COMMANDS.find((c) => c.id === id);
        if (!command)
            return;
        const why = command.unavailable?.(ctx) ?? null;
        if (why) {
            toast(why, { kind: "info" });
            return;
        }
        void command.run(ctx);
    };
    const onKey = (e) => {
        if (e.defaultPrevented)
            return;
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Escape" && hiddenMode) {
            e.preventDefault();
            ui.toggleHidden();
            return;
        }
        if (e.key === "Escape" && !e.target?.closest?.("dialog, [role=menu], .slash")) {
            // Escape closes a panel attached to a page when focus is on its tab; inside a panel the panel handles it, inside the page it keeps its other meanings.
            const tab = e.target?.closest?.(".ptab.open");
            const kind = ["red", "yellow", "embed"].find((k) => tab?.classList.contains(k));
            if (kind) {
                e.preventDefault();
                attachments.close(kind);
                ed.refocus();
                return;
            }
        }
        if (!mod)
            return;
        const inField = !!e.target?.closest?.("input, textarea, select");
        const inDialog = e.target?.closest?.("dialog");
        if (inDialog)
            return;
        const k = e.key.toLowerCase();
        if (k === "s" && !e.shiftKey) {
            e.preventDefault();
            void saveDocument(ctx);
        }
        else if (k === "f" && !e.shiftKey) {
            e.preventDefault();
            ui.focusFind();
        }
        else if (k === "h") {
            e.preventDefault();
            top.showReplace(true);
        }
        else if (e.altKey && e.code === "KeyM") {
            e.preventDefault();
            void COMMANDS.find((c) => c.id === "comment")?.run(ctx);
        }
        // New page, new section, new layer, add background, add illustration: the keys of Word, Canva and InDesign where they have one (see the shortcut list in Support)
        else if (inField)
            return; // in a text box elsewhere on the screen these keys keep their own meaning
        else if (e.key === "Enter" && e.altKey && !e.shiftKey) {
            e.preventDefault();
            runCommand("section-break");
        }
        else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            runCommand("page-break");
        }
        else if (e.code === "KeyN" && e.altKey && e.shiftKey) {
            e.preventDefault();
            runCommand("layer-new");
        }
        else if (e.code === "KeyB" && e.altKey && !e.shiftKey) {
            e.preventDefault();
            runCommand("background");
        }
        else if (k === "d" && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            runCommand("picture");
        }
        else if (k === "\\") {
            e.preventDefault();
            void A.clearFormatting(ed);
        }
        else if (k === "+" || k === "=") {
            e.preventDefault();
            setZoom(Math.round(ed.page.zoom * 100) + 10);
        }
        else if (k === "-") {
            e.preventDefault();
            setZoom(Math.round(ed.page.zoom * 100) - 10);
        }
        else if (k === "0" && !e.altKey) {
            e.preventDefault();
            setZoom(100);
        }
    };
    document.addEventListener("keydown", onKey);
    /* ------------------------------------------------------------------------------------------- polling */
    const poll = window.setInterval(() => {
        void app.openDocs().catch(() => undefined);
        const summary = app.docs.get(sid);
        if (summary?.path && !externalBanner)
            void api.get(`/docs/${encodeURIComponent(sid)}/external`).then((r) => { if (r.changed) {
                externalBanner = true;
                paintBanners();
            } }).catch(() => undefined);
    }, 10000);
    paintBanners();
    void loadNotes(ctx).then((n) => { noteCache = n; paintNoteMarks(ctx, n); }).catch(() => undefined);
    paintCommentMarks(ctx);
    return {
        el: root,
        focus() {
            // The page was built before it was on screen, so measure and lay it out again now, and again when fonts have loaded.
            window.requestAnimationFrame(() => {
                ed.layout();
                setZoom(zoomMode === "custom" ? app.prefs.zoom : zoomMode);
                status.update();
                const first = ed.model.order[0];
                if (first && !ed.readOnly && ed.model.order.length === 1 && ed.model.block(first)?.text === "")
                    ed.focusBlock(first, 0);
                else
                    ed.host.focus({ preventScroll: true });
            });
            void document.fonts?.ready.then(() => { ed.layout(); setZoom(zoomMode === "custom" ? app.prefs.zoom : zoomMode); });
        },
        destroy() {
            void ed.whenIdle().catch(() => undefined); // typing not yet sent goes out before the page is torn down
            window.clearInterval(poll);
            window.clearTimeout(marksTimer);
            window.clearTimeout(findTimer);
            window.clearTimeout(zoomSave);
            document.removeEventListener("keydown", onKey);
            offEditor();
            offApp();
            uninstall();
            imageTools.destroy();
            top.dispose();
            status.dispose();
            for (const p of dockPanels.values())
                p.destroy?.();
            nav.dispose();
            rightPanel.destroy?.();
            ed.page.onPlace = null;
            ed.destroy();
            delete document.body.dataset["hidden"];
            document.title = "SLAI Writer";
        },
    };
}
