/** The bars around the page: the top bar (menu, Save, Undo/Redo, open documents, file name, search), the formatting bar and the status bar. */
import { buildTextBoxRibbon, homeStyleToBox } from "./textbox_ribbon.js";
import { buildBandRibbon } from "./band_ribbon.js";
import { activeTextBoxId, applyTextBoxAction } from "./textbox_edit.js";
import { ApiError, announce, glyph, h, openDialog, openMenu, toast } from "./kit.js";
import { chevron, crossIcon, dico } from "./dico.js";
import * as A from "./actions.js";
import { COMMANDS, PaletteList } from "./commands.js";
import { autosaveMenu, confirmConflicts, saveAsDialog, saveDocument } from "./docsave.js";
import { closeDocument, needsPassword, withPassword } from "./fileops.js";
import { api, errorText, rawPost } from "./net.js";
import { statusDots, themeToggle } from "./shell.js";
import { signatureGraphicsDialog } from "./sigdialog.js";
import { FONT_FAMILIES, parseRibbonNumber } from "./font_rules.js";
import { bundledFonts, ensureBundledFont } from "./font_catalog.js";
import { resolveStyle } from "./render.js";
import { segments } from "./textops.js";
import { manageStyles } from "./style_manager.js";
import { shapeOf } from "./shape.js";
import { editShape } from "./shape_ui.js";
import { buildLayoutRibbon } from "./column_ui.js";
import { buildContentsGroup } from "./toc_ui.js";
import { buildTableRibbons } from "./table_ui.js";
import { bibliographyDialog, removeBibliography, sourceDialog } from "./panels/sources.js";
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
    const run = (task) => {
        // Editing a ribbon field takes browser focus away from the page. Restore
        // the actual selected text/caret before reading ranges for an operation.
        ed.refocus(ed.recallSelection());
        void Promise.resolve().then(task).catch((e) => toast(errorText(e), { kind: "error" }));
    };
    const fire = (id) => () => run(() => cmd(id).run(ctx));
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
    const custom = (label, content, action) => {
        const b = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": label, title: label } }, content);
        keepSelection(b);
        b.addEventListener("click", action);
        return b;
    };
    const field = (label, node) => h("label", { class: "ribbon-field" }, h("span", { class: "sr-only", text: label }), node);
    const scope = h("select", { class: "ribbon-scope", attrs: { "aria-label": "Formatting scope", title: "Apply character formatting to" } }, [["selection", "Selection"], ["character", "Character"], ["word", "Word"], ["sentence", "Sentence"], ["paragraph", "Paragraph"], ["section", "Section"], ["page", "Current page"], ["document", "Entire document"]]
        .map(([id, label]) => h("option", { value: id, text: label })));
    // A bare caret should format existing text immediately. Selection remains
    // available for precise character-level edits and next-typed-text styling.
    scope.value = "paragraph";
    const activeScope = () => scope.value;
    const family = h("input", { class: "ribbon-family", type: "text", maxLength: 100,
        attrs: { "aria-label": "Font family", list: "writer-font-families", autocomplete: "off", spellcheck: "false", placeholder: "Font family" } });
    const families = h("datalist", { attrs: { id: "writer-font-families" } }, FONT_FAMILIES.map((name) => h("option", { value: name })));
    const availableFamilies = new Set(FONT_FAMILIES);
    const size = h("input", { class: "ribbon-size", type: "number", min: 4, max: 400, step: 0.5,
        attrs: { "aria-label": "Font size in points", title: "Font size (pt)" } });
    const applyFamily = (value) => {
        // Keep font names as plain names, never CSS expressions or URL-bearing strings.
        if (!value || /[\x00-\x1f\x7f{};<>\\"'`]/.test(value)) {
            toast("Enter a valid font family name.", { kind: "error" });
            update();
            return;
        }
        const boxId = activeTextBoxId();
        if (boxId) {
            void applyTextBoxAction(ed, boxId, { kind: "format", props: { font_family: value } });
            void ensureBundledFont(value).then(() => ed.layout()).catch(() => undefined);
            return;
        }
        run(async () => {
            await A.setInlineProperty(ed, "font_family", value, activeScope());
            try {
                await ensureBundledFont(value);
                ed.layout();
            }
            catch {
                toast(`Could not load the bundled font ${value}. A system fallback may be shown.`, { kind: "error" });
            }
        });
    };
    family.addEventListener("change", () => applyFamily(family.value.trim()));
    const fontPicker = custom("Choose a bundled or system font", h("span", {}, chevron("down")), () => {
        openMenu(fontPicker, [...availableFamilies].sort((a, b) => a.localeCompare(b)).map((name) => ({
            label: name, run: () => { family.value = name; applyFamily(name); },
        })), { label: "Document fonts" });
    });
    fontPicker.classList.add("ribbon-font-picker");
    size.addEventListener("change", () => {
        const value = parseRibbonNumber(size.value, 4, 400);
        if (value === undefined) {
            toast("Font size must be between 4 and 400 pt.", { kind: "error" });
            update();
            return;
        }
        const boxId = activeTextBoxId();
        if (boxId) {
            void applyTextBoxAction(ed, boxId, { kind: "format", props: { font_size_pt: value ?? undefined } });
            return;
        }
        run(() => A.setInlineProperty(ed, "font_size_pt", value, activeScope()));
    });
    const style = h("select", { attrs: { "aria-label": "Paragraph style" } }, [["paragraph", "Normal text"], ["style-title", "Title"], ["style-subtitle", "Subtitle"], ["style-slogan", "Slogan"], ["style-author", "Author"], ["style-document-date", "Document Date"], ["style-toc-title", "TOC Title"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["scripture", "Scripture"], ["h4", "Heading 4"], ["h5", "Heading 5"], ["h6", "Heading 6"], ["quote", "Quote"], ["code-block", "Code block"], ["bullets", "Bulleted list"], ["numbered", "Numbered list"]].map(([v, t]) => h("option", { value: v, text: t })));
    style.addEventListener("change", () => {
        const id = style.value;
        const boxId = activeTextBoxId();
        if (boxId) {
            // Inside a text box the style list changes the box's paragraph (typography only: Scripture adds no columns there).
            const map = homeStyleToBox(id);
            if (!map) {
                toast("A text box holds Normal, Heading 1–3, Quote, lists and the named styles (including Scripture).", { kind: "info" });
                return;
            }
            const { list, ...rest } = map;
            void applyTextBoxAction(ed, boxId, { kind: "paragraph", attrs: { ...rest, ...(list !== undefined ? { list } : id === "paragraph" ? { list: null } : {}) } });
            return;
        }
        run(() => id.startsWith("user:") ? A.setParagraphStyle(ed, id.slice(5)) : cmd(id).run(ctx));
    });
    // Native <select> option popups do not expose portable per-option context
    // events. The keyboard/context-menu equivalent targets the selected style
    // and offers the full manager for other styles.
    const editSelectedStyle = () => {
        const selected = style.selectedOptions[0]?.textContent?.trim() ?? "Body Text";
        const name = selected === "Normal text" ? "Body Text" : selected;
        void manageStyles(ctx, name);
    };
    const styleContext = (e) => {
        e.preventDefault();
        openMenu(style, [
            { label: `Edit ${style.selectedOptions[0]?.textContent ?? "selected style"}…`, disabled: ed.readOnly, run: editSelectedStyle },
            { label: "Manage all named styles…", disabled: ed.readOnly, run: () => { void manageStyles(ctx); } },
        ], { label: "Paragraph style options" });
    };
    style.addEventListener("contextmenu", styleContext);
    style.addEventListener("keydown", (e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
            styleContext(e);
    });
    const manageStyle = custom("Manage named styles", "Aa", () => { void manageStyles(ctx); });
    const colour = (key, label, value) => {
        const i = h("input", { type: "color", value, attrs: { "aria-label": label, title: label } });
        i.addEventListener("change", () => {
            const boxId = activeTextBoxId();
            if (boxId) {
                void applyTextBoxAction(ed, boxId, { kind: "format", props: { [key]: i.value } });
                return;
            }
            run(() => A.setColour(ed, key, i.value, activeScope()));
        });
        return i;
    };
    const textColour = colour("color", "Font color", "#000000");
    const highlight = colour("background", "Highlight color", "#fff200");
    const reset = (key, label) => custom(label, "×", () => run(() => A.setColour(ed, key, null, activeScope())));
    const line = h("select", { class: "ribbon-line", attrs: { "aria-label": "Line spacing" } }, [["1", "Single"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "Double"], ["2.5", "2.5"], ["3", "Triple"]].map(([v, t]) => h("option", { value: v, text: t })));
    line.addEventListener("change", () => {
        const leading = Number(line.value);
        const boxId = activeTextBoxId();
        if (boxId) {
            void applyTextBoxAction(ed, boxId, { kind: "paragraph", attrs: { line_height: leading } });
            return;
        }
        run(() => A.setBlockAttribute(ed, { line_height: leading }, "line spacing"));
    });
    const spacing = (key, label) => {
        const i = h("input", { class: "ribbon-spacing", type: "number", min: 0, max: 1000, step: 1,
            attrs: { "aria-label": label, title: `${label} (pt)` } });
        i.addEventListener("change", () => {
            const n = parseRibbonNumber(i.value, 0, 1000);
            if (n === undefined) {
                toast(`${label} must be 0–1000 pt.`, { kind: "error" });
                update();
                return;
            }
            run(() => A.setBlockAttribute(ed, { [key]: n }, "paragraph spacing"));
        });
        return i;
    };
    const before = spacing("space_before_pt", "Space before paragraph");
    const after = spacing("space_after_pt", "Space after paragraph");
    const tracking = (key, label, min, max) => {
        const i = h("input", { class: "ribbon-tracking", type: "number", min, max, step: 0.1,
            attrs: { "aria-label": `${label} in points`, title: `${label} (pt)` } });
        i.addEventListener("change", () => {
            const value = parseRibbonNumber(i.value, min, max);
            if (value === undefined) {
                toast(`${label} must be between ${min} and ${max} pt.`, { kind: "error" });
                update();
                return;
            }
            run(() => A.setInlineProperty(ed, key, value, activeScope()));
        });
        const normal = custom(`Reset ${label.toLowerCase()} to inherited value`, "×", () => run(() => A.setInlineProperty(ed, key, null, activeScope())));
        const wrapper = h("span", { class: "ribbon-number ribbon-inline-spacing", attrs: { title: `${label} (pt)` } }, h("span", { text: key === "letter_spacing_pt" ? "Aa" : "↔" }), i, normal);
        trackingInputs.set(key, i);
        return wrapper;
    };
    const trackingInputs = new Map();
    const fontGroup = h("div", { class: "ribbon-group font", attrs: { role: "group", "aria-label": "Font" } }, h("span", { class: "ribbon-controls" }, field("Scope", scope), field("Font family", family), fontPicker, families, field("Font size", size), tool("bold", "Bold", "bold", true), tool("italic", "Italic", "italic", true), tool("underline", "Underline", "underline", true), tool("strike", "Strikethrough", "strike", true), custom("Uppercase selected text", "A↑", () => run(() => A.transformCase(ed, "upper"))), custom("Lowercase selected text", "a↓", () => run(() => A.transformCase(ed, "lower"))), h("span", { class: "ribbon-colour" }, textColour, reset("color", "Reset font color")), h("span", { class: "ribbon-colour" }, highlight, reset("background", "Remove highlight")), tracking("letter_spacing_pt", "Letter spacing", -5, 50), tracking("word_spacing_pt", "Word spacing", -20, 100)), h("span", { class: "ribbon-group-label", text: "Font" }));
    const paragraphGroup = h("div", { class: "ribbon-group paragraph", attrs: { role: "group", "aria-label": "Paragraph and alignment" } }, h("span", { class: "ribbon-controls" }, style, manageStyle, tool("align-left", "Align left", "align-left", true), tool("align-center", "Align center", "align-center", true), tool("align-right", "Align right", "align-right", true), tool("align-justify", "Justify", "align-justify", true), tool("bullets", "Bulleted list", "list", true), tool("numbered", "Numbered list", "list-ordered", true), tool("outdent", "Decrease indentation", "outdent"), tool("indent", "Increase indentation", "indent"), field("Line spacing", line), h("span", { class: "ribbon-number", attrs: { title: "Space before paragraph (pt)" } }, h("span", { text: "↑" }), before), h("span", { class: "ribbon-number", attrs: { title: "Space after paragraph (pt)" } }, h("span", { text: "↓" }), after)), h("span", { class: "ribbon-group-label", text: "Paragraph / Alignment" }));
    // Keep the familiar compact ribbon, with a dedicated References tab whose
    // actions use the existing citation/source services (no parallel engine).
    const ribbonButton = (label, action, icon) => {
        const b = h("button", { class: "ribbon-action", type: "button", attrs: { title: label } }, glyph(icon), h("span", { text: label }));
        keepSelection(b);
        b.addEventListener("click", action);
        return b;
    };
    const referenceGroup = (label, ...buttons) => h("div", { class: "ribbon-group" }, h("span", { class: "ribbon-controls" }, ...buttons), h("span", { class: "ribbon-group-label", text: label }));
    const contents = buildContentsGroup(ctx);
    const refs = h("div", { class: "format-ribbon references-ribbon", attrs: { role: "toolbar", "aria-label": "References ribbon" } }, contents.el, referenceGroup("Citations", ribbonButton("Insert citation", fire("citation"), "book")), referenceGroup("Sources", ribbonButton("Add source", () => run(() => sourceDialog(ctx)), "plus"), ribbonButton("Manage sources", fire("sources"), "book")), referenceGroup("Bibliography", ribbonButton("Insert / Update References", () => run(() => bibliographyDialog(ctx)), "book"), ribbonButton("Remove References", () => run(() => removeBibliography(ctx)), "close")), referenceGroup("Citation style", h("span", { class: "ribbon-style-label", text: "APA-style author–date" })));
    const illustrations = h("div", { class: "format-ribbon", attrs: { role: "toolbar", "aria-label": "Insert illustrations" } }, referenceGroup("Illustrations", ribbonButton("Insert Picture", fire("picture"), "image"), ribbonButton("Insert Shape", fire("shape"), "layers")), referenceGroup("Tables", ribbonButton("Table", fire("table"), "table"), ribbonButton("Markdown to table", fire("markdown-table"), "table")), referenceGroup("Text", ribbonButton("Text Box", fire("textbox"), "paragraph"), ribbonButton("Draw Text Box", fire("textbox-draw"), "pen")), referenceGroup("Header & Footer", ribbonButton("Header", fire("band-header"), "layers"), ribbonButton("Footer", fire("band-footer"), "layers")));
    // Contextual shape formatting uses the same canonical shape_set operation as
    // the full dialog; there is no separate undo, document store, or renderer.
    const selectedShape = () => {
        const id = ed.selectedBlock;
        const shape = shapeOf(id ? ed.model.block(id) : undefined);
        return id && shape ? { id, shape } : null;
    };
    const changeShape = (update) => {
        const pair = selectedShape();
        if (!pair)
            return;
        const shape = structuredClone(pair.shape);
        update(shape);
        void ed.op({ op: "shape_set", block: pair.id, shape, label: "shape formatting" })
            .catch((err) => toast(errorText(err), { kind: "error" }));
    };
    const fillPicker = h("input", { type: "color", value: "#f1d24b", attrs: { "aria-label": "Shape fill color" } });
    const outlinePicker = h("input", { type: "color", value: "#202020", attrs: { "aria-label": "Shape outline color" } });
    const fillAlpha = h("input", { type: "number", min: 0, max: 100, step: 5, value: "100", attrs: { "aria-label": "Fill opacity percent" } });
    const overallAlpha = h("input", { type: "number", min: 0, max: 100, step: 5, value: "100", attrs: { "aria-label": "Overall shape opacity percent" } });
    const outlineWidth = h("input", { type: "number", min: .1, max: 72, step: .5, value: "1.5", attrs: { "aria-label": "Shape outline width in points" } });
    const rotation = h("input", { type: "number", min: -360, max: 360, step: 1, value: "0", attrs: { "aria-label": "Shape rotation in degrees" } });
    const percent = (raw) => Math.max(0, Math.min(1, Number(raw) / 100));
    fillPicker.addEventListener("change", () => changeShape(s => { s.fill.color = fillPicker.value; s.fill.enabled = true; }));
    outlinePicker.addEventListener("change", () => changeShape(s => { s.outline.color = outlinePicker.value; s.outline.enabled = true; }));
    fillAlpha.addEventListener("change", () => changeShape(s => { s.fill.opacity = percent(fillAlpha.value); }));
    overallAlpha.addEventListener("change", () => changeShape(s => { s.opacity = percent(overallAlpha.value); }));
    outlineWidth.addEventListener("change", () => changeShape(s => { s.outline.width_pt = Math.max(.1, Math.min(72, Number(outlineWidth.value))); }));
    rotation.addEventListener("change", () => changeShape(s => { s.rotation_deg = Math.max(-360, Math.min(360, Number(rotation.value))); }));
    const fillOff = ribbonButton("No Fill", () => changeShape(s => { s.fill.enabled = false; }), "close");
    const borderOff = ribbonButton("No Outline", () => changeShape(s => { s.outline.enabled = false; }), "close");
    const openShape = () => { const pair = selectedShape(); if (pair)
        void editShape(ctx, pair.id); };
    const shapeRibbon = h("div", { class: "format-ribbon references-ribbon", attrs: { role: "toolbar", "aria-label": "Shape Format ribbon" } }, referenceGroup("Fill", fillPicker, fillOff, field("Fill opacity %", fillAlpha)), referenceGroup("Outline", outlinePicker, field("Width (pt)", outlineWidth), borderOff), referenceGroup("Transparency", field("Overall opacity %", overallAlpha)), referenceGroup("Geometry", field("Rotation (°)", rotation), ribbonButton("Size & Corners", openShape, "layers")), referenceGroup("Shape Text", ribbonButton("Edit Shape Text", openShape, "paragraph")), referenceGroup("Effects", ribbonButton("Shadows & Effects", openShape, "sparkle")), referenceGroup("Arrange", ribbonButton("Arrange & Group", openShape, "layers")));
    const bandRibbon = buildBandRibbon(ctx, referenceGroup, ribbonButton);
    bandRibbon.el.hidden = true;
    const textBoxRibbon = buildTextBoxRibbon(ctx, referenceGroup, ribbonButton);
    textBoxRibbon.el.hidden = true;
    const home = h("div", { class: "format-ribbon", attrs: { role: "toolbar", "aria-label": "Home formatting ribbon" } }, fontGroup, paragraphGroup);
    const homeTab = h("button", { type: "button", class: "ribbon-tab", text: "Home", attrs: { role: "tab", "aria-selected": "true" } });
    const insertTab = h("button", { type: "button", class: "ribbon-tab", text: "Insert", attrs: { role: "tab", "aria-selected": "false" } });
    const shapeTab = h("button", { type: "button", class: "ribbon-tab", text: "Shape Format", hidden: true, attrs: { role: "tab", "aria-selected": "false" } });
    const textTab = h("button", { type: "button", class: "ribbon-tab", text: "Text Box", hidden: true, attrs: { role: "tab", "aria-selected": "false" } });
    const bandTab = h("button", { type: "button", class: "ribbon-tab", text: "Header & Footer", hidden: true, attrs: { role: "tab", "aria-selected": "false" } });
    const refsTab = h("button", { type: "button", class: "ribbon-tab", text: "References", attrs: { role: "tab", "aria-selected": "false" } });
    const tableRibbons = buildTableRibbons(ctx);
    const layoutRibbon = buildLayoutRibbon(ctx);
    layoutRibbon.el.hidden = true;
    const layoutTab = h("button", { type: "button", class: "ribbon-tab", text: "Layout", attrs: { role: "tab", "aria-selected": "false" } });
    const designTab = h("button", { type: "button", class: "ribbon-tab", text: "Table Design", hidden: true, attrs: { role: "tab", "aria-selected": "false" } });
    const tableLayoutTab = h("button", { type: "button", class: "ribbon-tab", text: "Table Layout", hidden: true, attrs: { role: "tab", "aria-selected": "false" } });
    let activeTab = "home";
    let hadShape = false;
    let hadBox = false;
    let hadBand = false;
    let hadTable = false;
    const showTab = (which) => {
        activeTab = which;
        home.hidden = which !== "home";
        refs.hidden = which !== "references";
        illustrations.hidden = which !== "insert";
        shapeRibbon.hidden = which !== "shape";
        textTab.setAttribute("aria-selected", String(which === "textbox"));
        // The text box ribbon is only in the page while its tab is showing, so its controls never share a label with the Home controls they mirror.
        if (which === "textbox") {
            if (!textBoxRibbon.el.isConnected)
                shapeRibbon.after(textBoxRibbon.el);
            textBoxRibbon.el.hidden = false;
        }
        else
            textBoxRibbon.el.remove();
        // Like the text box ribbon, this one is in the page only while its tab shows.
        if (which === "band") {
            if (!bandRibbon.el.isConnected)
                shapeRibbon.after(bandRibbon.el);
            bandRibbon.el.hidden = false;
            bandRibbon.update();
        }
        else
            bandRibbon.el.remove();
        bandTab.setAttribute("aria-selected", String(which === "band"));
        tableRibbons.design.hidden = which !== "tdesign";
        tableRibbons.layout.hidden = which !== "tlayout";
        layoutRibbon.el.hidden = which !== "layout";
        layoutTab.setAttribute("aria-selected", String(which === "layout"));
        if (which === "layout")
            layoutRibbon.update();
        if (which === "references")
            contents.update();
        designTab.setAttribute("aria-selected", String(which === "tdesign"));
        tableLayoutTab.setAttribute("aria-selected", String(which === "tlayout"));
        homeTab.setAttribute("aria-selected", String(which === "home"));
        refsTab.setAttribute("aria-selected", String(which === "references"));
        insertTab.setAttribute("aria-selected", String(which === "insert"));
        shapeTab.setAttribute("aria-selected", String(which === "shape"));
    };
    homeTab.addEventListener("click", () => showTab("home"));
    refsTab.addEventListener("click", () => showTab("references"));
    insertTab.addEventListener("click", () => showTab("insert"));
    layoutTab.addEventListener("click", () => showTab("layout"));
    shapeTab.addEventListener("click", () => showTab("shape"));
    textTab.addEventListener("click", () => showTab("textbox"));
    bandTab.addEventListener("click", () => showTab("band"));
    designTab.addEventListener("click", () => showTab("tdesign"));
    tableLayoutTab.addEventListener("click", () => showTab("tlayout"));
    const el = h("div", { class: "bar writer-ribbon" }, h("div", { class: "ribbon-tabs", attrs: { role: "tablist", "aria-label": "Ribbon tabs" } }, homeTab, insertTab, layoutTab, refsTab, bandTab, shapeTab, textTab, designTab, tableLayoutTab), home, illustrations, layoutRibbon.el, refs, shapeRibbon, tableRibbons.design, tableRibbons.layout);
    showTab("home");
    const GROUPS_KEY = "writer.ribbonGroups.v1";
    const groupRows = [{ id: "font", label: "Font", element: fontGroup }, { id: "paragraph", label: "Paragraph / Alignment", element: paragraphGroup }];
    const readHidden = () => {
        try {
            const stored = JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? "[]");
            return new Set(Array.isArray(stored) ? stored.filter((s) => typeof s === "string" && groupRows.some((g) => g.id === s)) : []);
        }
        catch {
            return new Set();
        }
    };
    const hiddenGroups = readHidden();
    const applyGroups = () => { for (const row of groupRows)
        row.element.hidden = hiddenGroups.has(row.id); };
    const saveGroups = () => { try {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify([...hiddenGroups]));
    }
    catch { /* UI preference */ } applyGroups(); };
    const groupMenu = (ev) => {
        ev.preventDefault();
        openMenu(el, [
            ...groupRows.map((row) => ({ label: `${hiddenGroups.has(row.id) ? "☐" : "☑"} ${row.label}`, run: () => { if (hiddenGroups.has(row.id))
                    hiddenGroups.delete(row.id);
                else
                    hiddenGroups.add(row.id); saveGroups(); } })),
            { label: "Show all sections", run: () => { hiddenGroups.clear(); saveGroups(); } },
            { label: "Restore default ribbon layout", run: () => { hiddenGroups.clear(); saveGroups(); } },
            { label: "Hide ribbon", run: () => ctx.ui.toggleFormatBar() },
        ], { label: "Ribbon section visibility" });
    };
    el.addEventListener("contextmenu", groupMenu);
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        groupMenu(e); });
    applyGroups();
    const mixed = Symbol("mixed");
    const valueIn = (block, part, key) => {
        if (key === "bold" || key === "italic" || key === "underline" || key === "strike") {
            if (part?.flags[key])
                return true;
        }
        else if (part?.[key] !== undefined)
            return part[key];
        const character = resolveStyle(ed.model.meta, "character", part?.style);
        const paragraph = resolveStyle(ed.model.meta, "paragraph", block.style ?? (block.type === "paragraph" || block.type === "list_item" ? "Body Text" : undefined));
        return (character[key] ?? paragraph[key]);
    };
    const inlineValue = (key) => {
        const selection = ed.recallSelection();
        if (!selection)
            return undefined;
        if (selection.collapsed && ed.pendingInline.has(key))
            return ed.pendingInline.get(key) ?? undefined;
        if (selection.collapsed && ed.pendingFormat.has(key))
            return true;
        const ranges = A.textRanges(ed, selection);
        let found = false;
        let current;
        for (const range of ranges) {
            const parts = segments(range.block, "codepoints");
            const chosen = selection.collapsed ? parts.filter((p) => p.start < range.from && p.end >= range.from || range.from === 0 && p.start === 0) : parts.filter((p) => p.end > range.from && p.start < range.to);
            for (const part of chosen.length ? chosen : [null]) {
                const next = valueIn(range.block, part, key);
                if (found && !Object.is(current, next))
                    return mixed;
                current = next;
                found = true;
            }
        }
        return current;
    };
    const paragraphValue = (key) => {
        const selection = ed.recallSelection();
        if (!selection)
            return undefined;
        let current;
        let found = false;
        for (const { block } of A.textRanges(ed, selection)) {
            const inherited = resolveStyle(ed.model.meta, "paragraph", block.style ?? (block.type === "paragraph" || block.type === "list_item" ? "Body Text" : undefined));
            const next = block.attributes?.[key] ?? inherited[key];
            if (found && !Object.is(current, next))
                return mixed;
            current = next;
            found = true;
        }
        return current;
    };
    const update = () => {
        const bandOn = ed.bands.active !== null;
        bandTab.hidden = !bandOn;
        if (bandOn && !hadBand)
            showTab("band");
        else if (!bandOn && activeTab === "band")
            showTab("insert");
        hadBand = bandOn;
        if (bandOn)
            bandRibbon.update();
        const activeBox = bandOn ? null : textBoxRibbon.selected();
        const activeShape = activeBox || bandOn ? null : selectedShape();
        const hasShape = Boolean(activeShape) || Boolean(activeBox);
        shapeTab.hidden = !activeShape;
        textTab.hidden = !activeBox;
        if (activeBox && !hadBox)
            showTab("textbox");
        else if (!activeBox && activeTab === "textbox")
            showTab("home");
        if (activeShape && !hadShape)
            showTab("shape");
        else if (!activeShape && activeTab === "shape")
            showTab("home");
        hadShape = Boolean(activeShape);
        hadBox = Boolean(activeBox);
        if (activeBox)
            textBoxRibbon.update();
        if (activeTab === "layout")
            layoutRibbon.update();
        if (activeTab === "references")
            contents.update();
        const inTable = tableRibbons.update();
        designTab.hidden = tableLayoutTab.hidden = !inTable;
        if (inTable && !hadTable && !hasShape)
            showTab("tlayout");
        else if (!inTable && (activeTab === "tdesign" || activeTab === "tlayout"))
            showTab("home");
        hadTable = inTable;
        if (activeShape) {
            const s = activeShape.shape;
            if (document.activeElement !== fillPicker)
                fillPicker.value = s.fill.color;
            if (document.activeElement !== outlinePicker)
                outlinePicker.value = s.outline.color;
            if (document.activeElement !== fillAlpha)
                fillAlpha.value = String(Math.round(s.fill.opacity * 100));
            if (document.activeElement !== overallAlpha)
                overallAlpha.value = String(Math.round(s.opacity * 100));
            if (document.activeElement !== outlineWidth)
                outlineWidth.value = String(s.outline.width_pt);
            if (document.activeElement !== rotation)
                rotation.value = String(s.rotation_deg);
        }
        const sel = ed.recallSelection();
        const block = sel ? ed.model.block(sel.start.block) : undefined;
        for (const [id, btn] of toggles) {
            let value;
            if (["bold", "italic", "underline", "strike"].includes(id))
                value = inlineValue(id);
            else if (id === "bullets" || id === "numbered") {
                const ids = sel ? A.textRanges(ed, sel) : [];
                value = ids.length > 0 && ids.every(({ block: b }) => b.type === "list_item" && Boolean(b.attributes?.ordered) === (id === "numbered"));
            }
            else
                value = paragraphValue("align") === id.slice("align-".length);
            btn.setAttribute("aria-pressed", value === mixed ? "mixed" : String(value === true));
        }
        const font = inlineValue("font_family");
        if (document.activeElement !== family) {
            if (font !== mixed && typeof font === "string")
                family.value = font;
            else {
                family.value = "";
                family.placeholder = font === mixed ? "Mixed fonts" : "Font family";
            }
        }
        const pt = inlineValue("font_size_pt");
        if (document.activeElement !== size)
            size.value = typeof pt === "number" ? String(pt) : "";
        size.placeholder = pt === mixed ? "Mixed" : "pt";
        for (const [key, input] of trackingInputs) {
            const value = inlineValue(key);
            if (document.activeElement !== input)
                input.value = typeof value === "number" ? String(value) : "";
            input.placeholder = value === mixed ? "Mixed" : "0";
        }
        const text = inlineValue("color");
        if (typeof text === "string" && /^#[0-9a-fA-F]{6}$/.test(text))
            textColour.value = text;
        const bg = inlineValue("background");
        if (typeof bg === "string" && /^#[0-9a-fA-F]{6}$/.test(bg))
            highlight.value = bg;
        const leading = paragraphValue("line_height");
        if (document.activeElement !== line) {
            line.value = typeof leading === "number" ? String(leading) : "1";
            if (![...line.options].some((o) => o.value === line.value))
                line.selectedIndex = -1;
        }
        const beforeValue = paragraphValue("space_before_pt");
        const afterValue = paragraphValue("space_after_pt");
        if (document.activeElement !== before)
            before.value = typeof beforeValue === "number" ? String(beforeValue) : beforeValue === mixed ? "" : "0";
        if (document.activeElement !== after)
            after.value = typeof afterValue === "number" ? String(afterValue) : afterValue === mixed ? "" : "0";
        if (block) {
            for (const option of Array.from(style.options))
                if (option.dataset["customStyle"])
                    option.remove();
            for (const name of Object.keys(ed.model.meta.styles?.paragraph ?? {}).sort()) {
                if (["Title", "Subtitle", "Slogan", "Author", "Document Date", "TOC Title", "Scripture"].includes(name))
                    continue; // Scripture has its own entry above
                const option = h("option", { value: `user:${name}`, text: name });
                option.dataset["customStyle"] = "true";
                style.appendChild(option);
            }
            const v = block.type === "heading" ? `h${Math.min(6, block.attributes?.level ?? 1)}` : block.type === "list_item" ? (block.attributes?.ordered ? "numbered" : "bullets") : block.type === "quote" ? "quote" : block.type === "code" ? "code-block" : block.style === "Scripture" ? "scripture" : block.style && ["Title", "Subtitle", "Slogan", "Author", "Document Date", "TOC Title"].includes(block.style) ? `style-${block.style.toLowerCase().replaceAll(" ", "-")}` : block.style ? `user:${block.style}` : "paragraph";
            if ([...style.options].some((o) => o.value === v))
                style.value = v;
        }
        const dis = ed.readOnly;
        el.querySelectorAll("button, select, input").forEach((c) => {
            if (c.closest(".textbox-ribbon")) {
                if (dis)
                    c.disabled = true;
                return;
            } // the text box ribbon decides its own controls (pinned and locked boxes disable some)
            c.disabled = dis;
        });
    };
    void bundledFonts().then(async (data) => {
        data.families.forEach((name) => availableFamilies.add(name));
        families.replaceChildren(...[...new Set([...FONT_FAMILIES, ...data.families])].sort((a, b) => a.localeCompare(b)).map((name) => h("option", { value: name })));
        const used = new Set();
        for (const row of ed.model.list()) {
            if (typeof row.attributes?.["font_family"] === "string")
                used.add(row.attributes["font_family"]);
            for (const span of row.spans ?? [])
                if (typeof span.font_family === "string")
                    used.add(span.font_family);
        }
        for (const kind of [ed.model.meta.styles?.paragraph, ed.model.meta.styles?.character]) {
            for (const group of Object.values(kind ?? {}))
                if (typeof group["font_family"] === "string")
                    used.add(group["font_family"]);
        }
        await Promise.allSettled([...used].map((name) => ensureBundledFont(name)));
        ed.layout();
    }).catch(() => { });
    ed.bands.listen(() => update()); // entering or leaving a header or footer shows or hides its tab
    update();
    return { el, update };
}
/** The status bar of the design (page 11): page, words, version and last edit on the left; shared workspace, the pen for signing, Hide/Reveal
 *  and the status dots in the middle; the zoom to page height or width and the percentage slider on the right. */
export function buildStatusBar(ctx, onZoom) {
    const { app, ed } = ctx;
    const pageLine = h("span", { class: "page-line", attrs: { title: "The editor page count is an approximate block layout. The PDF page count and TOC references are measured by Documaster." } });
    const pagesButton = h("button", { class: "sbtn pages", type: "button", attrs: { "aria-haspopup": "menu", "aria-label": "Pages shown side by side", title: "Pages shown side by side: 1, 2, 3 or 4" } }, glyph("pages-1"), h("span", { class: "pages-n", text: "1" }));
    pagesButton.addEventListener("click", () => {
        const now = ctx.ui.viewState();
        const mark = (on) => (on ? "● " : "");
        const book = now.book;
        openMenu(pagesButton, [
            { label: `${mark(now.perRow === 1)}1 page`, icon: "pages-1", run: () => ctx.ui.setPages(1) },
            book ? { label: `${mark(now.perRow === 2 && now.facing)}2 pages: book view (page 1 on the right)`, icon: "pages-book", run: () => ctx.ui.setPages(2, { book: true }) }
                : { label: `${mark(now.perRow === 2)}2 pages`, icon: "pages-2", run: () => ctx.ui.setPages(2) },
            ...(book ? [{ label: `${mark(now.perRow === 2 && !now.facing)}2 pages side by side, not as a book`, icon: "pages-2", run: () => ctx.ui.setPages(2, { book: false }) }] : []),
            { label: `${mark(now.perRow === 3)}3 pages`, icon: "pages-3", run: () => ctx.ui.setPages(3) },
            { label: `${mark(now.perRow === 4)}4 pages`, icon: "pages-4", run: () => ctx.ui.setPages(4) },
        ], { label: "Pages shown side by side" });
    });
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
    const rendered = h("button", { class: "sbtn rendered-toggle", type: "button", attrs: { "aria-label": "Rendered view", "aria-pressed": "false", title: "Rendered view: the pages as they export, read only" } }, glyph("view-rendered"));
    rendered.addEventListener("click", () => { void ctx.ui.setRendered(!ctx.ui.viewState().rendered); });
    const fitEntire = h("button", { class: "sbtn fit", type: "button", attrs: { "aria-label": "Zoom to the entire page", "aria-pressed": "false", title: "Fit entire page" } }, glyph("zoom-entire"));
    fitEntire.addEventListener("click", () => onZoom("entire"));
    const fitHeight = h("button", { class: "sbtn fit", type: "button", attrs: { "aria-label": "Zoom to page height", "aria-pressed": "false", title: "Fit page height" } }, dico("zoom-height"));
    const fitWidth = h("button", { class: "sbtn fit", type: "button", attrs: { "aria-label": "Zoom to page width", "aria-pressed": "false", title: "Fit page width" } }, dico("zoom-width"));
    fitHeight.addEventListener("click", () => onZoom("height"));
    fitWidth.addEventListener("click", () => onZoom("width"));
    const range = h("input", { class: "zoomrange", type: "range", min: 10, max: 400, step: 1, value: String(app.prefs.zoom), attrs: { "aria-label": "Zoom" } });
    const zoomText = h("output", { class: "zoom-text", attrs: { for: "" } });
    range.addEventListener("input", () => { onZoom(Number(range.value)); });
    const paintRange = () => { range.style.setProperty("--fill", `${((Number(range.value) - 10) / 390) * 100}%`); };
    const zoom = h("div", { class: "zoomctl" }, rendered, fitHeight, fitWidth, fitEntire, range, zoomText);
    const el = h("footer", { class: "estatus", attrs: { role: "contentinfo" } }, h("div", { class: "stats" }, pagesButton, pageLine, words, version, last), h("div", { class: "centre" }, workspace, pen, hide, dots), zoom);
    const paintView = () => {
        const view = ctx.ui.viewState();
        const shown = view.facing ? 2 : view.perRow;
        pagesButton.querySelector(".pages-n").textContent = String(shown);
        pagesButton.querySelector("svg")?.replaceWith(glyph(view.facing ? "pages-book" : `pages-${shown}`));
        pagesButton.title = `Pages shown side by side: ${view.facing ? "2 (book view)" : shown}`;
        pagesButton.setAttribute("aria-label", `Pages shown side by side: ${view.facing ? "2, book view" : shown}. Change`);
        const off = !view.rendered && view.renderedUnavailable;
        rendered.setAttribute("aria-pressed", String(view.rendered));
        rendered.disabled = !!off;
        rendered.setAttribute("aria-label", view.rendered ? "Editing view: return to editing" : "Rendered view");
        rendered.title = off ? `Rendered view is not available: ${off}` : view.rendered ? "Editing view: return to editing (Esc)" : "Rendered view: the pages as they export, read only";
        const icon = rendered.querySelector("svg");
        if (icon && icon.dataset["name"] !== (view.rendered ? "view-editing" : "view-rendered")) {
            const next = glyph(view.rendered ? "view-editing" : "view-rendered");
            next.dataset["name"] = view.rendered ? "view-editing" : "view-rendered";
            icon.replaceWith(next);
        }
    };
    const update = () => {
        paintView();
        const view = ctx.ui.viewState();
        if (view.rendered && view.renderedPage) {
            const r = view.renderedPage;
            pageLine.textContent = `Rendered ${String(r.page).padStart(2, "0")}/${String(r.total).padStart(2, "0")} (exact, read only)${r.label ? ` · Printed: ${r.label}` : ""}`;
        }
        const state = ed.model.state;
        const total = Math.max(1, ed.page.total);
        const cur = Math.min(total, ed.currentPage());
        const layout = ed.printLayout;
        const active = ed.recallSelection()?.start.block;
        const physical = active ? layout?.blockPages[active] : undefined;
        const printed = physical ? layout?.printedLabels[physical - 1] : undefined;
        if (!(view.rendered && view.renderedPage))
            pageLine.textContent = `Editor ${String(cur).padStart(2, "0")}/${String(total).padStart(2, "0")} (approx.)` +
                (layout ? ` · PDF ${physical ? `${physical}/` : ""}${layout.pages} (exact)${printed ? ` · Printed: ${printed}` : ""}` : "");
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
        fitEntire.setAttribute("aria-pressed", String(m === "entire"));
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
