/** The bars around the page: the top bar (menu, Save, Undo/Redo, open documents, file name, search), the formatting bar and the status bar. */
import { ApiError, announce, glyph, h, openDialog, openMenu, toast } from "./kit.js";
import { chevron, crossIcon, dico } from "./dico.js";
import * as A from "./actions.js";
import { COMMANDS, PaletteList } from "./commands.js";
import { autosaveMenu, confirmConflicts, saveAsDialog, saveDocument } from "./docsave.js";
import { closeDocument, needsPassword, withPassword } from "./fileops.js";
import { api, errorText, rawPost } from "./net.js";
import { statusDots, themeToggle } from "./shell.js";
import { signatureGraphicsDialog } from "./sigdialog.js";
import { ago, notice, pickFile } from "./widgets.js";
/** Keep the text selection in the page when a bar button is pressed. */
function keepSelection(button) { button.addEventListener("mousedown", (e) => e.preventDefault()); }
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/* ======================================================================================================= top bar */
/** The top bar of the design (page 11): sandwich menu, Save, Undo and Redo with their histories, the open-documents selector, the file
 *  name (the extension is not editable), the search button that opens into a pill, and the light/dark switch. */
export function buildTopBar(ctx, find, nav) {
    const { app, ed } = ctx;
    const off = [];
    const menu = h("button", { class: "tbtn menu", type: "button", attrs: { "aria-label": "Menu", "aria-haspopup": "menu", "aria-expanded": "false", title: "Menu" } }, dico("sandwich"));
    menu.addEventListener("click", () => nav().toggle());
    const setMenuOpen = (open) => { menu.setAttribute("aria-expanded", String(open)); menu.replaceChildren(open ? crossIcon() : dico("sandwich")); };
    const dirtyDot = h("span", { class: "dirty-dot", attrs: { "aria-hidden": "true" }, hidden: true });
    const save = h("button", { class: "tbtn save", type: "button", attrs: { title: "Save (Ctrl+S). Right-click for autosave options." } }, dico("save"), dirtyDot);
    save.addEventListener("click", () => { void saveDocument(ctx); });
    save.addEventListener("contextmenu", (e) => { e.preventDefault(); autosaveMenu(ctx, save); });
    save.addEventListener("keydown", (e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        autosaveMenu(ctx, save);
    } });
    /* undo / redo, each with its history */
    const history = (direction) => {
        const main = h("button", { class: `tbtn ${direction}`, type: "button", attrs: { "aria-label": direction === "undo" ? "Undo" : "Redo", title: direction === "undo" ? "Undo (Ctrl+Z)" : "Redo (Ctrl+Y)" } }, dico(direction));
        main.addEventListener("click", () => { void A.undoRedo(ed, direction); });
        const drop = h("button", { class: "tmore", type: "button", attrs: { "aria-label": `${direction === "undo" ? "Undo" : "Redo"} history`, "aria-haspopup": "menu", title: `${direction === "undo" ? "Undo" : "Redo"} history` } }, chevron("down"));
        drop.addEventListener("click", () => {
            void (async () => {
                try {
                    await ed.whenIdle();
                    const stack = await api.get(`/docs/${encodeURIComponent(ctx.sid)}/history-stack`);
                    const labels = stack[direction];
                    if (!labels.length) {
                        toast(`Nothing to ${direction}.`, { kind: "info" });
                        return;
                    }
                    openMenu(drop, labels.slice(0, 30).map((label, i) => ({ label: `${i + 1}. ${label}`, run: () => { void A.undoRedo(ed, direction, i + 1); } })), { label: `${direction === "undo" ? "Undo" : "Redo"} history` });
                }
                catch (e) {
                    toast(errorText(e), { kind: "error" });
                }
            })();
        });
        keepSelection(main);
        return { group: h("span", { class: "hist" }, main, drop), main, drop };
    };
    const undoPart = history("undo");
    const redoPart = history("redo");
    /* open documents */
    const docsBtn = h("button", { class: "docsel", type: "button", attrs: { "aria-haspopup": "true", "aria-expanded": "false", title: "Open documents" } });
    let pop = null;
    const closePop = () => { pop?.remove(); pop = null; docsBtn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", outside, true); };
    const outside = (e) => { if (pop && !pop.contains(e.target) && !docsBtn.contains(e.target))
        closePop(); };
    const docLabel = (i, title) => `${String(i + 1).padStart(2, "0")}: ${clip(title, 28)}`;
    docsBtn.addEventListener("click", () => {
        if (pop) {
            closePop();
            return;
        }
        const entries = [...app.docs.values()];
        const list = h("ul", { class: "docs-pop-list" }, entries.map((d, i) => {
            const go = h("button", { class: "btn plain", type: "button", attrs: { "aria-current": d.sid === ctx.sid ? "page" : null }, text: docLabel(i, d.title) + (d.dirty ? " •" : "") });
            go.addEventListener("click", () => { closePop(); if (d.sid !== ctx.sid)
                app.go({ name: "doc", sid: d.sid }); });
            const x = h("button", { class: "iconbtn small", type: "button", attrs: { "aria-label": `Close ${d.title}`, title: "Close this document" } }, glyph("close"));
            x.addEventListener("click", () => {
                void (async () => {
                    try {
                        if (d.sid === ctx.sid)
                            await ed.whenIdle();
                        const closed = await closeDocument(app, d.sid);
                        if (!closed)
                            return;
                        closePop();
                        if (d.sid === ctx.sid) {
                            const next = [...app.docs.values()][0];
                            app.go(next ? { name: "doc", sid: next.sid } : { name: "home" });
                        }
                    }
                    catch (err) {
                        toast(errorText(err), { kind: "error" });
                    }
                })();
            });
            return h("li", {}, go, x);
        }));
        pop = h("div", { class: "docs-pop", attrs: { role: "dialog", "aria-label": "Open documents" } }, list.children.length ? list : h("p", { class: "muted pad", text: "No other documents are open." }));
        document.body.appendChild(pop);
        const r = docsBtn.getBoundingClientRect();
        pop.style.setProperty("left", `${Math.max(8, Math.min(r.left, window.innerWidth - 340))}px`);
        pop.style.setProperty("top", `${r.bottom + 6}px`);
        docsBtn.setAttribute("aria-expanded", "true");
        document.addEventListener("mousedown", outside, true);
        pop.querySelector("button")?.focus();
    });
    pop = null;
    off.push(() => closePop());
    /* file name */
    const nameBtn = h("button", { class: "name", type: "button", attrs: { title: "Double-click (or press F2) to rename" } });
    const startRename = () => {
        if (ed.readOnly && !app.docs.get(ctx.sid)?.path) {
            void saveAsDialog(ctx);
            return;
        }
        const summary = app.docs.get(ctx.sid);
        if (!summary?.path) {
            void saveAsDialog(ctx);
            return;
        }
        const input = h("input", { class: "name-edit", type: "text", value: summary.name, maxLength: 120, attrs: { "aria-label": "File name (the .sldc extension cannot be changed)" } });
        nameBtn.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = async (commit) => {
            if (done)
                return;
            done = true;
            const value = input.value.trim();
            input.replaceWith(nameBtn);
            if (commit && value && value !== summary.name) {
                try {
                    await ed.whenIdle();
                    await api.post(`/docs/${encodeURIComponent(ctx.sid)}/rename`, { name: value });
                    await app.openDocs();
                    announce(`Renamed to ${value}.`);
                }
                catch (e) {
                    toast(errorText(e), { kind: "error" });
                }
            }
            update();
            nameBtn.focus();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") {
            e.preventDefault();
            void finish(true);
        }
        else if (e.key === "Escape") {
            e.preventDefault();
            void finish(false);
        } });
        input.addEventListener("blur", () => { void finish(true); });
    };
    nameBtn.addEventListener("dblclick", startRename);
    nameBtn.addEventListener("keydown", (e) => { if (e.key === "F2" || e.key === "Enter") {
        e.preventDefault();
        startRename();
    } });
    /* search: an icon that opens into a pill (design page 12). Starting with "/" searches Writer's functions instead of the text. */
    const search = h("input", { class: "search-input", type: "search", attrs: { "aria-label": "Search the document. Start with / to search Writer's functions.", placeholder: "Search · or / for functions", autocomplete: "off", spellcheck: "false" } });
    const count = h("button", { class: "count", type: "button", attrs: { title: "Next match", "aria-label": "Next match" } });
    const clearBtn = h("button", { class: "tmore close", type: "button", attrs: { "aria-label": "Clear and close the search", title: "Close search" } }, crossIcon());
    const searchBtn = h("button", { class: "tbtn searchbtn", type: "button", attrs: { "aria-label": "Search", "aria-expanded": "false", title: "Search (Ctrl+F). Start with / to search Writer's functions." } }, dico("search"));
    const pill = h("div", { class: "pill", hidden: true, attrs: { role: "search" } }, search, count, clearBtn);
    const findGroup = h("div", { class: "find", data: { open: "false" } }, searchBtn, pill);
    const prev = { disabled: true };
    const next = { disabled: true };
    const setFindOpen = (open) => {
        pill.hidden = !open;
        searchBtn.hidden = open;
        findGroup.dataset["open"] = String(open);
        searchBtn.setAttribute("aria-expanded", String(open));
    };
    const openFind = () => { setFindOpen(true); search.focus(); search.select(); };
    searchBtn.addEventListener("click", openFind);
    count.addEventListener("click", () => find.step(1));
    /* "/" mode: the search box finds Writer's functions */
    let paletteBox = null;
    const closePalette = () => { paletteBox?.remove(); paletteBox = null; };
    const closeAll = () => { search.value = ""; find.clear(); closePalette(); setFindOpen(false); count.textContent = ""; };
    const run = (c) => { closeAll(); ed.refocus(); void Promise.resolve(c.run(ctx)).catch((e) => toast(errorText(e), { kind: "error" })); };
    clearBtn.addEventListener("click", () => { closeAll(); ed.refocus(); });
    const palette = new PaletteList(ctx, run);
    let timer;
    const onInput = () => {
        if (search.value.startsWith("/")) {
            find.clear();
            if (!paletteBox) {
                paletteBox = h("div", { class: "slash find-palette", attrs: { role: "region", "aria-label": "Writer functions" } }, palette.el);
                findGroup.appendChild(paletteBox);
            }
            palette.setQuery(search.value);
            return;
        }
        closePalette();
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { void find.search(search.value); }, 180);
    };
    search.addEventListener("input", onInput);
    search.addEventListener("keydown", (e) => {
        if (paletteBox) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                palette.move(1);
            }
            else if (e.key === "ArrowUp") {
                e.preventDefault();
                palette.move(-1);
            }
            else if (e.key === "Enter") {
                e.preventDefault();
                palette.pick();
            }
            else if (e.key === "Escape") {
                e.preventDefault();
                closeAll();
                ed.refocus();
            }
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            find.step(e.shiftKey ? -1 : 1);
        }
        else if (e.key === "Escape") {
            e.preventDefault();
            closeAll();
            ed.refocus();
        }
    });
    search.addEventListener("blur", () => { window.setTimeout(() => { if (!search.value && !findGroup.contains(document.activeElement))
        setFindOpen(false); }, 120); });
    /* replace row (Ctrl+H) */
    const withText = h("input", { type: "text", maxLength: 2000, attrs: { "aria-label": "Replace with", placeholder: "Replace with" } });
    const caseBtn = h("button", { class: "btn small", type: "button", text: "Aa", attrs: { "aria-pressed": "false", title: "Match upper and lower case" } });
    const wholeBtn = h("button", { class: "btn small", type: "button", text: "Whole word", attrs: { "aria-pressed": "false" } });
    const toggleOpt = (btn, set) => btn.addEventListener("click", () => { const on = btn.getAttribute("aria-pressed") !== "true"; btn.setAttribute("aria-pressed", String(on)); set(on); void find.search(search.value, true); });
    toggleOpt(caseBtn, (v) => { find.caseSensitive = v; });
    toggleOpt(wholeBtn, (v) => { find.wholeWord = v; });
    const one = h("button", { class: "btn small", type: "button", text: "Replace" });
    one.addEventListener("click", () => { void find.replaceCurrent(withText.value); });
    const all = h("button", { class: "btn small", type: "button", text: "Replace all" });
    all.addEventListener("click", () => { void find.replaceAll(withText.value); });
    const replaceRow = h("div", { class: "replace-row", hidden: true }, withText, one, all, caseBtn, wholeBtn);
    const showReplace = (show = replaceRow.hidden) => { replaceRow.hidden = !show; if (show) {
        openFind();
        if (!ed.readOnly)
            withText.focus();
    } };
    find.bind(() => { count.textContent = find.label; count.setAttribute("aria-label", find.label ? `${find.label}. Next match` : "Next match"); prev.disabled = next.disabled = !find.matches.length; one.disabled = all.disabled = ed.readOnly || !find.matches.length; });
    const fileLine = h("span", { class: "fileline" }, dico("file"), nameBtn);
    const bar = h("header", { class: "etop" }, menu, save, undoPart.group, redoPart.group, docsBtn, fileLine, h("span", { class: "grow" }), findGroup, themeToggle(app));
    const update = () => {
        const summary = app.docs.get(ctx.sid);
        const state = ed.model.state;
        const dirty = summary?.dirty ?? state.dirty;
        dirtyDot.hidden = !dirty;
        save.setAttribute("aria-label", dirty ? "Save (there are unsaved changes)" : "Save");
        save.disabled = false;
        undoPart.main.disabled = !state.undo;
        redoPart.main.disabled = !state.redo;
        undoPart.drop.disabled = !state.undo;
        redoPart.drop.disabled = !state.redo;
        undoPart.main.title = state.undo ? `Undo ${state.undo} (Ctrl+Z)` : "Nothing to undo";
        redoPart.main.title = state.redo ? `Redo ${state.redo} (Ctrl+Y)` : "Nothing to redo";
        const index = [...app.docs.keys()].indexOf(ctx.sid);
        docsBtn.replaceChildren(h("span", { class: "label", text: docLabel(Math.max(0, index), summary?.title ?? state.title) }), chevron("down"));
        if (nameBtn.isConnected)
            nameBtn.replaceChildren(h("span", { text: summary?.name ?? state.title }), h("span", { class: "ext", text: ".sldc" }));
        nameBtn.setAttribute("aria-label", `File name ${summary?.name ?? state.title}.sldc. Double-click or press F2 to rename.`);
    };
    update();
    return { el: bar, replaceRow, search, update, showReplace, openFind, setMenuOpen, menuButton: menu, dispose: () => { off.forEach((f) => f()); window.clearTimeout(timer); closePalette(); } };
}
/* ====================================================================================================== format bar */
export function buildFormatBar(ctx) {
    const { ed } = ctx;
    const cmd = (id) => COMMANDS.find((c) => c.id === id);
    const fire = (id) => () => { ed.refocus(); void Promise.resolve(cmd(id).run(ctx)).catch((e) => toast(errorText(e), { kind: "error" })); };
    const toggles = new Map();
    const tool = (id, label, icon, pressable = false) => {
        const c = cmd(id);
        const b = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": label, title: c.shortcut ? `${label} (${c.shortcut})` : label, "aria-pressed": pressable ? "false" : null } }, glyph(icon));
        keepSelection(b);
        b.addEventListener("click", fire(id));
        if (pressable)
            toggles.set(id, b);
        return b;
    };
    const style = h("select", { attrs: { "aria-label": "Paragraph style" } }, [["paragraph", "Normal text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["quote", "Quote"], ["code-block", "Code block"], ["bullets", "Bulleted list"], ["numbered", "Numbered list"]].map(([v, t]) => h("option", { value: v, text: t })));
    style.addEventListener("change", () => { const id = style.value; ed.refocus(); void Promise.resolve(cmd(id).run(ctx)); });
    const colour = (key, label, value) => {
        const i = h("input", { type: "color", value, attrs: { "aria-label": label, title: label } });
        i.addEventListener("change", () => { ed.refocus(); void A.setColour(ed, key, i.value); });
        return i;
    };
    const sep = () => h("span", { class: "sep", attrs: { "aria-hidden": "true" } });
    const el = h("div", { class: "bar", attrs: { role: "toolbar", "aria-label": "Formatting" } }, style, sep(), tool("bold", "Bold", "bold", true), tool("italic", "Italic", "italic", true), tool("underline", "Underline", "underline", true), tool("strike", "Strikethrough", "strike", true), tool("link", "Link", "link"), sep(), colour("color", "Text colour", "#000000"), colour("background", "Highlight colour", "#fff200"), sep(), tool("align-left", "Align left", "align-left"), tool("align-center", "Align centre", "align-center"), tool("align-right", "Align right", "align-right"), tool("indent", "Indent", "indent"), tool("outdent", "Outdent", "outdent"), sep(), tool("table", "Insert table", "table"), tool("picture", "Insert picture", "image"), tool("equation", "Insert equation", "sigma"), tool("footnote", "Insert footnote", "footnote"), tool("citation", "Insert citation", "book"), tool("comment", "Add comment", "comment"), tool("page-break", "Page break", "page"));
    const flags = { bold: "bold", italic: "italic", underline: "underline", strike: "strike" };
    const update = () => {
        const sel = ed.readSelection();
        const block = sel ? ed.model.block(sel.start.block) : undefined;
        for (const [id, btn] of toggles) {
            const flag = flags[id];
            let on = ed.pendingFormat.has(flag);
            if (block && sel && !on) {
                const from = sel.start.offset, to = sel.end.offset;
                on = (block.spans ?? []).some((s) => s.type === "format" && s[flag] === true && (sel.collapsed ? s.start < from && s.end >= from : s.start <= from && s.end >= to));
            }
            btn.setAttribute("aria-pressed", String(on));
        }
        if (block) {
            const v = block.type === "heading" ? `h${Math.min(4, block.attributes?.level ?? 1)}` : block.type === "list_item" ? (block.attributes?.ordered ? "numbered" : "bullets") : block.type === "quote" ? "quote" : block.type === "code" ? "code-block" : "paragraph";
            if ([...style.options].some((o) => o.value === v))
                style.value = v;
        }
        const dis = ed.readOnly;
        el.querySelectorAll("button, select, input").forEach((c) => { c.disabled = dis; });
    };
    update();
    return { el, update };
}
/** The status bar of the design (page 11): page, words, version and last edit on the left; shared workspace, the pen for signing, Hide/Reveal
 *  and the status dots in the middle; the zoom to page height or width and the percentage slider on the right. */
export function buildStatusBar(ctx, onZoom) {
    const { app, ed } = ctx;
    const pageLine = h("span", { class: "page-line", attrs: { title: "Pages are laid out block by block here, so this count is approximate. Print preview shows the exact count." } });
    const words = h("span", {});
    const version = h("span", {});
    const last = h("span", {});
    const workspace = h("button", { class: "sbtn workspace", type: "button", attrs: { "aria-label": "Shared workspace: not connected", title: "Shared workspace" } }, dico("workspace"));
    workspace.addEventListener("click", () => { void workspaceDialog(ctx); });
    const pen = h("button", { class: "sbtn pen", type: "button", attrs: { "aria-label": "Document signing", "aria-haspopup": "menu", title: "Optional: sign this document" } }, dico("pen"));
    pen.addEventListener("click", () => openMenu(pen, [
        { label: "Signature graphics…", icon: "signature", disabled: ed.readOnly, run: () => { void signatureGraphicsDialog(ctx); } },
        { label: "Sign revision…", icon: "pen", run: () => app.go({ name: "sign", sid: ctx.sid }) },
        { label: "Verify Signature", icon: "shield", run: () => app.go({ name: "verify-signature", sid: ctx.sid }) },
    ], { label: "Document signing" }));
    const hide = h("button", { class: "sbtn hide", type: "button", attrs: { "aria-pressed": "false", "aria-label": "Hide everything except the page", title: "Hide / Reveal: dims and blurs everything except the page" } }, dico("eye"));
    hide.addEventListener("click", () => ctx.ui.toggleHidden());
    const dots = h("span", { class: "dots-slot" });
    const fitHeight = h("button", { class: "sbtn fit", type: "button", attrs: { "aria-label": "Zoom to page height", "aria-pressed": "false", title: "Fit page height" } }, dico("zoom-height"));
    const fitWidth = h("button", { class: "sbtn fit", type: "button", attrs: { "aria-label": "Zoom to page width", "aria-pressed": "false", title: "Fit page width" } }, dico("zoom-width"));
    fitHeight.addEventListener("click", () => onZoom("height"));
    fitWidth.addEventListener("click", () => onZoom("width"));
    const range = h("input", { class: "zoomrange", type: "range", min: 10, max: 400, step: 1, value: String(app.prefs.zoom), attrs: { "aria-label": "Zoom" } });
    const zoomText = h("output", { class: "zoom-text", attrs: { for: "" } });
    range.addEventListener("input", () => { onZoom(Number(range.value)); });
    const paintRange = () => { range.style.setProperty("--fill", `${((Number(range.value) - 10) / 390) * 100}%`); };
    const zoom = h("div", { class: "zoomctl" }, fitHeight, fitWidth, range, zoomText);
    const el = h("footer", { class: "estatus", attrs: { role: "contentinfo" } }, h("div", { class: "stats" }, pageLine, words, version, last), h("div", { class: "centre" }, workspace, pen, hide, dots), zoom);
    const update = () => {
        const state = ed.model.state;
        const total = Math.max(1, ed.page.total);
        const cur = Math.min(total, ed.currentPage());
        pageLine.textContent = `Page ${String(cur).padStart(2, "0")} of ${String(total).padStart(2, "0")} (approx.)`;
        words.textContent = `${ed.model.stats.words.toLocaleString()} words - ${ed.model.stats.characters.toLocaleString()} characters`;
        version.textContent = `Version: ${state.revision.number}`;
        version.title = `Revision ${state.revision.number}. Revision id ${state.revision.id.slice(0, 12)}…`;
        const edited = state.lastEdit ?? state.savedAt ?? state.opened;
        last.textContent = `last edit: ${ago(edited)}`;
        const summary = app.docs.get(ctx.sid);
        const saved = summary?.path ? (summary.dirty ? "unsaved" : "saved") : (summary?.dirty ? "unsaved" : "none");
        dots.replaceChildren(statusDots(app, { saved, autosave: app.prefs.autosave, signatures: state.signatures, signedState: undefined }, true));
        const ws = app.boot.capabilities.workspace;
        workspace.setAttribute("aria-label", ws.available ? "Shared workspace: connected" : "Shared workspace: not connected");
        workspace.title = ws.available ? "Shared workspace: connected" : "Shared workspace: not connected";
        workspace.classList.toggle("off", !ws.available);
    };
    const setZoom = (percent, m) => {
        range.value = String(Math.max(10, Math.min(400, percent)));
        paintRange();
        zoomText.textContent = `${Math.round(percent)}%`;
        fitHeight.setAttribute("aria-pressed", String(m === "height"));
        fitWidth.setAttribute("aria-pressed", String(m === "width"));
    };
    update();
    paintRange();
    const timer = window.setInterval(update, 30000);
    return { el, update, setZoom, dispose: () => window.clearInterval(timer) };
}
/* ======================================================================================================= workspace */
export async function workspaceDialog(ctx) {
    const { app, ed } = ctx;
    const ws = app.boot.capabilities.workspace;
    const merge = h("button", { class: "btn", type: "button", text: "Merge an edited copy…", disabled: ed.readOnly });
    merge.addEventListener("click", () => {
        void (async () => {
            const [file] = await pickFile(".sldc,application/octet-stream");
            if (!file)
                return;
            try {
                const attempt = async (accept) => withPassword("This copy is protected", (password) => rawPost(`/docs/${encodeURIComponent(ctx.sid)}/merge-copy`, file, "application/octet-stream", { acceptConflicts: accept ? "1" : undefined, password }));
                let out = await attempt(false);
                if (!out)
                    return;
                if (!out.applied) {
                    if (!await confirmConflicts(out))
                        return;
                    out = await attempt(true);
                }
                if (out?.state) {
                    await ed.whenIdle();
                    await ed.resync(out.state);
                    toast("Merged. Save when you are happy with the result.", { kind: "ok" });
                    ctx.ui.refreshStatus();
                }
            }
            catch (e) {
                toast(e instanceof ApiError ? e.friendly : errorText(e), { kind: "error", timeoutMs: 9000 });
            }
        })();
    });
    void needsPassword;
    await openDialog({
        title: "Shared workspace", cancelLabel: "Close",
        body: h("div", { class: "stack" }, notice(ws.reason, ws.available ? "ok" : "warn", ws.available ? "Connected." : "Not connected."), h("p", { text: ws.needs }), h("h3", { text: "What works without a workspace" }), h("ul", {}, h("li", { text: "Share a copy: Export, choose Writer document (.sldc). The other person opens it in their own Writer." }), h("li", { text: "Merge a copy back: combine an edited copy with this document. Places changed on both sides are shown to you, never decided silently." }), h("li", { text: "Comments travel inside the file." })), h("div", { class: "actions" }, merge)),
    }).result;
}
