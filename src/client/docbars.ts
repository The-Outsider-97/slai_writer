/** The bars around the page: the top bar (menu, Save, Undo/Redo, open documents, file name, search), the formatting bar and the status bar. */
import { ApiError, announce, glyph, h, openDialog, openMenu, toast, type MenuEntry } from "./kit.js";
import { chevron, crossIcon, dico } from "./dico.js";
import type { NavMenu } from "./navmenu.js";
import * as A from "./actions.js";
import { COMMANDS, PaletteList, type Command } from "./commands.js";
import type { DocCtx } from "./docctx.js";
import { autosaveMenu, confirmConflicts, saveAsDialog, saveDocument, type MergeResult } from "./docsave.js";
import type { Find } from "./find.js";
import { closeDocument, needsPassword, withPassword } from "./fileops.js";
import { api, errorText, rawPost } from "./net.js";
import { statusDots, themeToggle } from "./shell.js";
import { signatureGraphicsDialog } from "./sigdialog.js";
import { FONT_FAMILIES } from "./font_rules.js";
import { resolveStyle } from "./render.js";
import { segments } from "./textops.js";
import type { Block } from "./types.js";
import { ago, notice, pickFile } from "./widgets.js";

/** Keep the text selection in the page when a bar button is pressed. */
function keepSelection(button: HTMLElement): void { button.addEventListener("mousedown", (e) => e.preventDefault()); }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface TopBar { el: HTMLElement; replaceRow: HTMLElement; search: HTMLInputElement; update(): void; showReplace(show?: boolean): void; openFind(): void; setMenuOpen(open: boolean): void; menuButton: HTMLButtonElement; dispose(): void }

/* ======================================================================================================= top bar */
/** The top bar of the design (page 11): sandwich menu, Save, Undo and Redo with their histories, the open-documents selector, the file
 *  name (the extension is not editable), the search button that opens into a pill, and the light/dark switch. */
export function buildTopBar(ctx: DocCtx, find: Find, nav: () => NavMenu): TopBar {
  const { app, ed } = ctx;
  const off: Array<() => void> = [];

  const menu = h("button", { class: "tbtn menu", type: "button", attrs: { "aria-label": "Menu", "aria-haspopup": "menu", "aria-expanded": "false", title: "Menu" } }, dico("sandwich"));
  menu.addEventListener("click", () => nav().toggle());
  const setMenuOpen = (open: boolean): void => { menu.setAttribute("aria-expanded", String(open)); menu.replaceChildren(open ? crossIcon() : dico("sandwich")); };

  const dirtyDot = h("span", { class: "dirty-dot", attrs: { "aria-hidden": "true" }, hidden: true });
  const save = h("button", { class: "tbtn save", type: "button", attrs: { title: "Save (Ctrl+S). Right-click for autosave options." } }, dico("save"), dirtyDot);
  save.addEventListener("click", () => { void saveDocument(ctx); });
  save.addEventListener("contextmenu", (e) => { e.preventDefault(); autosaveMenu(ctx, save); });
  save.addEventListener("keydown", (e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); autosaveMenu(ctx, save); } });

  /* undo / redo, each with its history */
  const history = (direction: "undo" | "redo"): { group: HTMLElement; main: HTMLButtonElement; drop: HTMLButtonElement } => {
    const main = h("button", { class: `tbtn ${direction}`, type: "button", attrs: { "aria-label": direction === "undo" ? "Undo" : "Redo", title: direction === "undo" ? "Undo (Ctrl+Z)" : "Redo (Ctrl+Y)" } }, dico(direction));
    main.addEventListener("click", () => { void A.undoRedo(ed, direction); });
    const drop = h("button", { class: "tmore", type: "button", attrs: { "aria-label": `${direction === "undo" ? "Undo" : "Redo"} history`, "aria-haspopup": "menu", title: `${direction === "undo" ? "Undo" : "Redo"} history` } }, chevron("down"));
    drop.addEventListener("click", () => { void (async () => {
      try {
        await ed.whenIdle();
        const stack = await api.get<{ undo: string[]; redo: string[] }>(`/docs/${encodeURIComponent(ctx.sid)}/history-stack`);
        const labels = stack[direction];
        if (!labels.length) { toast(`Nothing to ${direction}.`, { kind: "info" }); return; }
        openMenu(drop, labels.slice(0, 30).map((label, i): MenuEntry => ({ label: `${i + 1}. ${label}`, run: () => { void A.undoRedo(ed, direction, i + 1); } })), { label: `${direction === "undo" ? "Undo" : "Redo"} history` });
      } catch (e) { toast(errorText(e), { kind: "error" }); }
    })(); });
    keepSelection(main);
    return { group: h("span", { class: "hist" }, main, drop), main, drop };
  };
  const undoPart = history("undo");
  const redoPart = history("redo");

  /* open documents */
  const docsBtn = h("button", { class: "docsel", type: "button", attrs: { "aria-haspopup": "true", "aria-expanded": "false", title: "Open documents" } });
  let pop: HTMLElement | null = null;
  const closePop = (): void => { pop?.remove(); pop = null; docsBtn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", outside, true); };
  const outside = (e: MouseEvent): void => { if (pop && !pop.contains(e.target as Node) && !docsBtn.contains(e.target as Node)) closePop(); };
  const docLabel = (i: number, title: string): string => `${String(i + 1).padStart(2, "0")}: ${clip(title, 28)}`;
  docsBtn.addEventListener("click", () => {
    if (pop) { closePop(); return; }
    const entries = [...app.docs.values()];
    const list = h("ul", { class: "docs-pop-list" }, entries.map((d, i) => {
      const go = h("button", { class: "btn plain", type: "button", attrs: { "aria-current": d.sid === ctx.sid ? "page" : null }, text: docLabel(i, d.title) + (d.dirty ? " •" : "") });
      go.addEventListener("click", () => { closePop(); if (d.sid !== ctx.sid) app.go({ name: "doc", sid: d.sid }); });
      const x = h("button", { class: "iconbtn small", type: "button", attrs: { "aria-label": `Close ${d.title}`, title: "Close this document" } }, glyph("close"));
      x.addEventListener("click", () => { void (async () => {
        try {
          if (d.sid === ctx.sid) await ed.whenIdle();
          const closed = await closeDocument(app, d.sid);
          if (!closed) return;
          closePop();
          if (d.sid === ctx.sid) { const next = [...app.docs.values()][0]; app.go(next ? { name: "doc", sid: next.sid } : { name: "home" }); }
        } catch (err) { toast(errorText(err), { kind: "error" }); }
      })(); });
      return h("li", {}, go, x);
    }));
    pop = h("div", { class: "docs-pop", attrs: { role: "dialog", "aria-label": "Open documents" } }, list.children.length ? list : h("p", { class: "muted pad", text: "No other documents are open." }));
    document.body.appendChild(pop);
    const r = docsBtn.getBoundingClientRect();
    pop.style.setProperty("left", `${Math.max(8, Math.min(r.left, window.innerWidth - 340))}px`);
    pop.style.setProperty("top", `${r.bottom + 6}px`);
    docsBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", outside, true);
    pop.querySelector<HTMLElement>("button")?.focus();
  });
  pop = null;
  off.push(() => closePop());

  /* file name */
  const nameBtn = h("button", { class: "name", type: "button", attrs: { title: "Double-click (or press F2) to rename" } });
  const startRename = (): void => {
    if (ed.readOnly && !app.docs.get(ctx.sid)?.path) { void saveAsDialog(ctx); return; }
    const summary = app.docs.get(ctx.sid);
    if (!summary?.path) { void saveAsDialog(ctx); return; }
    const input = h("input", { class: "name-edit", type: "text", value: summary.name, maxLength: 120, attrs: { "aria-label": "File name (the .sldc extension cannot be changed)" } });
    nameBtn.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(nameBtn);
      if (commit && value && value !== summary.name) {
        try { await ed.whenIdle(); await api.post(`/docs/${encodeURIComponent(ctx.sid)}/rename`, { name: value }); await app.openDocs(); announce(`Renamed to ${value}.`); }
        catch (e) { toast(errorText(e), { kind: "error" }); }
      }
      update();
      nameBtn.focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void finish(true); } else if (e.key === "Escape") { e.preventDefault(); void finish(false); } });
    input.addEventListener("blur", () => { void finish(true); });
  };
  nameBtn.addEventListener("dblclick", startRename);
  nameBtn.addEventListener("keydown", (e) => { if (e.key === "F2" || e.key === "Enter") { e.preventDefault(); startRename(); } });

  /* search: an icon that opens into a pill (design page 12). Starting with "/" searches Writer's functions instead of the text. */
  const search = h("input", { class: "search-input", type: "search", attrs: { "aria-label": "Search the document. Start with / to search Writer's functions.", placeholder: "Search · or / for functions", autocomplete: "off", spellcheck: "false" } });
  const count = h("button", { class: "count", type: "button", attrs: { title: "Next match", "aria-label": "Next match" } });
  const clearBtn = h("button", { class: "tmore close", type: "button", attrs: { "aria-label": "Clear and close the search", title: "Close search" } }, crossIcon());
  const searchBtn = h("button", { class: "tbtn searchbtn", type: "button", attrs: { "aria-label": "Search", "aria-expanded": "false", title: "Search (Ctrl+F). Start with / to search Writer's functions." } }, dico("search"));
  const pill = h("div", { class: "pill", hidden: true, attrs: { role: "search" } }, search, count, clearBtn);
  const findGroup = h("div", { class: "find", data: { open: "false" } }, searchBtn, pill);
  const prev = { disabled: true };
  const next = { disabled: true };
  const setFindOpen = (open: boolean): void => {
    pill.hidden = !open; searchBtn.hidden = open;
    findGroup.dataset["open"] = String(open);
    searchBtn.setAttribute("aria-expanded", String(open));
  };
  const openFind = (): void => { setFindOpen(true); search.focus(); search.select(); };
  searchBtn.addEventListener("click", openFind);
  count.addEventListener("click", () => find.step(1));

  /* "/" mode: the search box finds Writer's functions */
  let paletteBox: HTMLElement | null = null;
  const closePalette = (): void => { paletteBox?.remove(); paletteBox = null; };
  const closeAll = (): void => { search.value = ""; find.clear(); closePalette(); setFindOpen(false); count.textContent = ""; };
  const run = (c: Command): void => { closeAll(); ed.refocus(); void Promise.resolve(c.run(ctx)).catch((e: unknown) => toast(errorText(e), { kind: "error" })); };
  clearBtn.addEventListener("click", () => { closeAll(); ed.refocus(); });
  const palette = new PaletteList(ctx, run);
  let timer: number | undefined;
  const onInput = (): void => {
    if (search.value.startsWith("/")) {
      find.clear();
      if (!paletteBox) { paletteBox = h("div", { class: "slash find-palette", attrs: { role: "region", "aria-label": "Writer functions" } }, palette.el); findGroup.appendChild(paletteBox); }
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
      if (e.key === "ArrowDown") { e.preventDefault(); palette.move(1); } else if (e.key === "ArrowUp") { e.preventDefault(); palette.move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); palette.pick(); } else if (e.key === "Escape") { e.preventDefault(); closeAll(); ed.refocus(); }
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeAll(); ed.refocus(); }
  });
  search.addEventListener("blur", () => { window.setTimeout(() => { if (!search.value && !findGroup.contains(document.activeElement)) setFindOpen(false); }, 120); });

  /* replace row (Ctrl+H) */
  const withText = h("input", { type: "text", maxLength: 2000, attrs: { "aria-label": "Replace with", placeholder: "Replace with" } });
  const caseBtn = h("button", { class: "btn small", type: "button", text: "Aa", attrs: { "aria-pressed": "false", title: "Match upper and lower case" } });
  const wholeBtn = h("button", { class: "btn small", type: "button", text: "Whole word", attrs: { "aria-pressed": "false" } });
  const toggleOpt = (btn: HTMLElement, set: (v: boolean) => void): void => btn.addEventListener("click", () => { const on = btn.getAttribute("aria-pressed") !== "true"; btn.setAttribute("aria-pressed", String(on)); set(on); void find.search(search.value, true); });
  toggleOpt(caseBtn, (v) => { find.caseSensitive = v; });
  toggleOpt(wholeBtn, (v) => { find.wholeWord = v; });
  const one = h("button", { class: "btn small", type: "button", text: "Replace" });
  one.addEventListener("click", () => { void find.replaceCurrent(withText.value); });
  const all = h("button", { class: "btn small", type: "button", text: "Replace all" });
  all.addEventListener("click", () => { void find.replaceAll(withText.value); });
  const replaceRow = h("div", { class: "replace-row", hidden: true }, withText, one, all, caseBtn, wholeBtn);
  const showReplace = (show = replaceRow.hidden): void => { replaceRow.hidden = !show; if (show) { openFind(); if (!ed.readOnly) withText.focus(); } };

  find.bind(() => { count.textContent = find.label; count.setAttribute("aria-label", find.label ? `${find.label}. Next match` : "Next match"); prev.disabled = next.disabled = !find.matches.length; one.disabled = all.disabled = ed.readOnly || !find.matches.length; });

  const fileLine = h("span", { class: "fileline" }, dico("file"), nameBtn);
  const bar = h("header", { class: "etop" }, menu, save, undoPart.group, redoPart.group, docsBtn, fileLine, h("span", { class: "grow" }), findGroup, themeToggle(app));

  const update = (): void => {
    const summary = app.docs.get(ctx.sid);
    const state = ed.model.state;
    const dirty = summary?.dirty ?? state.dirty;
    dirtyDot.hidden = !dirty;
    save.setAttribute("aria-label", dirty ? "Save (there are unsaved changes)" : "Save");
    save.disabled = false;
    undoPart.main.disabled = !state.undo; redoPart.main.disabled = !state.redo;
    undoPart.drop.disabled = !state.undo; redoPart.drop.disabled = !state.redo;
    undoPart.main.title = state.undo ? `Undo ${state.undo} (Ctrl+Z)` : "Nothing to undo";
    redoPart.main.title = state.redo ? `Redo ${state.redo} (Ctrl+Y)` : "Nothing to redo";
    const index = [...app.docs.keys()].indexOf(ctx.sid);
    docsBtn.replaceChildren(h("span", { class: "label", text: docLabel(Math.max(0, index), summary?.title ?? state.title) }), chevron("down"));
    if (nameBtn.isConnected) nameBtn.replaceChildren(h("span", { text: summary?.name ?? state.title }), h("span", { class: "ext", text: ".sldc" }));
    nameBtn.setAttribute("aria-label", `File name ${summary?.name ?? state.title}.sldc. Double-click or press F2 to rename.`);
  };
  update();
  return { el: bar, replaceRow, search, update, showReplace, openFind, setMenuOpen, menuButton: menu, dispose: () => { off.forEach((f) => f()); window.clearTimeout(timer); closePalette(); } };
}

/* ====================================================================================================== format bar */
export function buildFormatBar(ctx: DocCtx): { el: HTMLElement; update(): void } {
  const { ed } = ctx;
  const cmd = (id: string): Command => COMMANDS.find((c) => c.id === id) as Command;
  const run = (task: () => Promise<unknown> | unknown): void => {
    ed.refocus();
    void Promise.resolve().then(task).catch((e: unknown) => toast(errorText(e), { kind: "error" }));
  };
  const fire = (id: string) => (): void => run(() => cmd(id).run(ctx));
  const toggles = new Map<string, HTMLButtonElement>();
  const tool = (id: string, label: string, icon: string, pressable = false): HTMLButtonElement => {
    const c = cmd(id);
    const b = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": label, title: c.shortcut ? `${label} (${c.shortcut})` : label, "aria-pressed": pressable ? "false" : null } }, glyph(icon));
    keepSelection(b);
    b.addEventListener("click", fire(id));
    if (pressable) toggles.set(id, b);
    return b;
  };
  const custom = (label: string, content: string | HTMLElement, action: () => void): HTMLButtonElement => {
    const b = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": label, title: label } }, content);
    keepSelection(b);
    b.addEventListener("click", action);
    return b;
  };
  const field = (label: string, node: HTMLElement): HTMLElement => h("label", { class: "ribbon-field" }, h("span", { class: "sr-only", text: label }), node);
  const family = h("input", { class: "ribbon-family", type: "text", maxLength: 100,
    attrs: { "aria-label": "Font family", list: "writer-font-families", autocomplete: "off", spellcheck: "false", placeholder: "Font family" } });
  const families = h("datalist", { attrs: { id: "writer-font-families" } }, FONT_FAMILIES.map((name) => h("option", { value: name })));
  const size = h("input", { class: "ribbon-size", type: "number", min: 4, max: 400, step: 0.5,
    attrs: { "aria-label": "Font size in points", title: "Font size (pt)" } });
  family.addEventListener("change", () => {
    const value = family.value.trim();
    // Keep font names as plain names, never CSS expressions or URL-bearing strings.
    if (!value || /[\x00-\x1f\x7f{};<>\\"'`]/.test(value)) { toast("Enter a valid font family name.", { kind: "error" }); update(); return; }
    run(() => A.setInlineProperty(ed, "font_family", value));
  });
  size.addEventListener("change", () => {
    const value = Number(size.value);
    if (!size.value || !Number.isFinite(value) || value < 4 || value > 400) { toast("Font size must be between 4 and 400 pt.", { kind: "error" }); update(); return; }
    run(() => A.setInlineProperty(ed, "font_size_pt", value));
  });
  const style = h("select", { attrs: { "aria-label": "Paragraph style" } },
    [["paragraph", "Normal text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["h5", "Heading 5"], ["h6", "Heading 6"], ["quote", "Quote"], ["code-block", "Code block"], ["bullets", "Bulleted list"], ["numbered", "Numbered list"]].map(([v, t]) => h("option", { value: v as string, text: t as string })));
  style.addEventListener("change", () => { const id = style.value; run(() => cmd(id).run(ctx)); });
  const colour = (key: "color" | "background", label: string, value: string): HTMLInputElement => {
    const i = h("input", { type: "color", value, attrs: { "aria-label": label, title: label } });
    i.addEventListener("change", () => run(() => A.setColour(ed, key, i.value)));
    return i;
  };
  const textColour = colour("color", "Font color", "#000000");
  const highlight = colour("background", "Highlight color", "#fff200");
  const reset = (key: "color" | "background", label: string): HTMLElement => custom(label, "×", () => run(() => A.setColour(ed, key, null)));
  const line = h("select", { class: "ribbon-line", attrs: { "aria-label": "Line spacing" } },
    [["1", "Single"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "Double"], ["2.5", "2.5"], ["3", "Triple"]].map(([v, t]) => h("option", { value: v, text: t })));
  line.addEventListener("change", () => run(() => A.setBlockAttribute(ed, { line_height: Number(line.value) }, "line spacing")));
  const spacing = (key: "space_before_pt" | "space_after_pt", label: string): HTMLInputElement => {
    const i = h("input", { class: "ribbon-spacing", type: "number", min: 0, max: 1000, step: 1,
      attrs: { "aria-label": label, title: `${label} (pt)` } });
    i.addEventListener("change", () => {
      const n = Number(i.value);
      if (!i.value || !Number.isFinite(n) || n < 0 || n > 1000) { toast(`${label} must be 0–1000 pt.`, { kind: "error" }); update(); return; }
      run(() => A.setBlockAttribute(ed, { [key]: n }, "paragraph spacing"));
    });
    return i;
  };
  const before = spacing("space_before_pt", "Space before paragraph");
  const after = spacing("space_after_pt", "Space after paragraph");
  const fontGroup = h("div", { class: "ribbon-group font", attrs: { role: "group", "aria-label": "Font" } },
    h("span", { class: "ribbon-controls" }, field("Font family", family), families, field("Font size", size),
      tool("bold", "Bold", "bold", true), tool("italic", "Italic", "italic", true),
      tool("underline", "Underline", "underline", true), tool("strike", "Strikethrough", "strike", true),
      custom("Uppercase selected text", "A↑", () => run(() => A.transformCase(ed, "upper"))),
      custom("Lowercase selected text", "a↓", () => run(() => A.transformCase(ed, "lower"))),
      h("span", { class: "ribbon-colour" }, textColour, reset("color", "Reset font color")),
      h("span", { class: "ribbon-colour" }, highlight, reset("background", "Remove highlight"))),
    h("span", { class: "ribbon-group-label", text: "Font" }));
  const paragraphGroup = h("div", { class: "ribbon-group paragraph", attrs: { role: "group", "aria-label": "Paragraph and alignment" } },
    h("span", { class: "ribbon-controls" }, style,
      tool("align-left", "Align left", "align-left", true), tool("align-center", "Align center", "align-center", true),
      tool("align-right", "Align right", "align-right", true), tool("align-justify", "Justify", "align-justify", true),
      tool("bullets", "Bulleted list", "list", true), tool("numbered", "Numbered list", "list-ordered", true),
      tool("outdent", "Decrease indentation", "outdent"), tool("indent", "Increase indentation", "indent"),
      field("Line spacing", line), h("span", { class: "ribbon-number", attrs: { title: "Space before paragraph (pt)" } }, h("span", { text: "↑" }), before),
      h("span", { class: "ribbon-number", attrs: { title: "Space after paragraph (pt)" } }, h("span", { text: "↓" }), after)),
    h("span", { class: "ribbon-group-label", text: "Paragraph / Alignment" }));
  const el = h("div", { class: "bar format-ribbon", attrs: { role: "toolbar", "aria-label": "Document formatting ribbon" } }, fontGroup, paragraphGroup);
  const mixed = Symbol("mixed");
  type InlineKey = "bold" | "italic" | "underline" | "strike" | "font_family" | "font_size_pt" | "color" | "background";
  const valueIn = (block: Block, part: ReturnType<typeof segments>[number] | null, key: InlineKey): string | number | boolean | undefined => {
    if (key === "bold" || key === "italic" || key === "underline" || key === "strike") {
      if (part?.flags[key]) return true;
    } else if (part?.[key] !== undefined) return part[key];
    const character = resolveStyle(ed.model.meta, "character", part?.style);
    const paragraph = resolveStyle(ed.model.meta, "paragraph", block.style ?? (block.type === "paragraph" || block.type === "list_item" ? "Body Text" : undefined));
    return (character[key] ?? paragraph[key]) as string | number | boolean | undefined;
  };
  const inlineValue = (key: InlineKey): string | number | boolean | typeof mixed | undefined => {
    const selection = ed.recallSelection();
    if (!selection) return undefined;
    if (selection.collapsed && ed.pendingInline.has(key)) return ed.pendingInline.get(key) ?? undefined;
    if (selection.collapsed && ed.pendingFormat.has(key)) return true;
    const ranges = A.textRanges(ed, selection);
    let found = false;
    let current: string | number | boolean | undefined;
    for (const range of ranges) {
      const parts = segments(range.block);
      const chosen = selection.collapsed ? parts.filter((p) => p.start < range.from && p.end >= range.from || range.from === 0 && p.start === 0) : parts.filter((p) => p.end > range.from && p.start < range.to);
      for (const part of chosen.length ? chosen : [null]) {
        const next = valueIn(range.block, part, key);
        if (found && !Object.is(current, next)) return mixed;
        current = next; found = true;
      }
    }
    return current;
  };
  const paragraphValue = (key: string): unknown | typeof mixed => {
    const selection = ed.recallSelection();
    if (!selection) return undefined;
    let current: unknown;
    let found = false;
    for (const { block } of A.textRanges(ed, selection)) {
      const inherited = resolveStyle(ed.model.meta, "paragraph", block.style ?? (block.type === "paragraph" || block.type === "list_item" ? "Body Text" : undefined));
      const next = block.attributes?.[key] ?? inherited[key];
      if (found && !Object.is(current, next)) return mixed;
      current = next; found = true;
    }
    return current;
  };
  const update = (): void => {
    const sel = ed.recallSelection();
    const block = sel ? ed.model.block(sel.start.block) : undefined;
    for (const [id, btn] of toggles) {
      let value: unknown;
      if (["bold", "italic", "underline", "strike"].includes(id)) value = inlineValue(id as InlineKey);
      else if (id === "bullets" || id === "numbered") {
        const ids = sel ? A.textRanges(ed, sel) : [];
        value = ids.length > 0 && ids.every(({ block: b }) => b.type === "list_item" && Boolean(b.attributes?.ordered) === (id === "numbered"));
      } else value = paragraphValue("align") === id.slice("align-".length);
      btn.setAttribute("aria-pressed", value === mixed ? "mixed" : String(value === true));
    }
    const font = inlineValue("font_family");
    if (font !== mixed && typeof font === "string") family.value = font;
    else { family.value = ""; family.placeholder = font === mixed ? "Mixed fonts" : "Font family"; }
    const pt = inlineValue("font_size_pt");
    size.value = typeof pt === "number" ? String(pt) : "";
    size.placeholder = pt === mixed ? "Mixed" : "pt";
    const text = inlineValue("color");
    if (typeof text === "string" && /^#[0-9a-fA-F]{6}$/.test(text)) textColour.value = text;
    const bg = inlineValue("background");
    if (typeof bg === "string" && /^#[0-9a-fA-F]{6}$/.test(bg)) highlight.value = bg;
    const leading = paragraphValue("line_height");
    line.value = typeof leading === "number" ? String(leading) : "1";
    if (![...line.options].some((o) => o.value === line.value)) line.selectedIndex = -1;
    const beforeValue = paragraphValue("space_before_pt");
    const afterValue = paragraphValue("space_after_pt");
    before.value = typeof beforeValue === "number" ? String(beforeValue) : beforeValue === mixed ? "" : "0";
    after.value = typeof afterValue === "number" ? String(afterValue) : afterValue === mixed ? "" : "0";
    if (block) {
      const v = block.type === "heading" ? `h${Math.min(6, block.attributes?.level ?? 1)}` : block.type === "list_item" ? (block.attributes?.ordered ? "numbered" : "bullets") : block.type === "quote" ? "quote" : block.type === "code" ? "code-block" : "paragraph";
      if ([...style.options].some((o) => o.value === v)) style.value = v;
    }
    const dis = ed.readOnly;
    el.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("button, select, input").forEach((c) => { c.disabled = dis; });
  };
  update();
  return { el, update };
}

/* ===================================================================================================== status bar */
export interface StatusBar { el: HTMLElement; update(): void; setZoom(percent: number, mode: "custom" | "height" | "width"): void; dispose(): void }

/** The status bar of the design (page 11): page, words, version and last edit on the left; shared workspace, the pen for signing, Hide/Reveal
 *  and the status dots in the middle; the zoom to page height or width and the percentage slider on the right. */
export function buildStatusBar(ctx: DocCtx, onZoom: (request: number | "height" | "width") => void): StatusBar {
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
  const paintRange = (): void => { range.style.setProperty("--fill", `${((Number(range.value) - 10) / 390) * 100}%`); };
  const zoom = h("div", { class: "zoomctl" }, fitHeight, fitWidth, range, zoomText);

  const el = h("footer", { class: "estatus", attrs: { role: "contentinfo" } },
    h("div", { class: "stats" }, pageLine, words, version, last),
    h("div", { class: "centre" }, workspace, pen, hide, dots),
    zoom);

  const update = (): void => {
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
  const setZoom = (percent: number, m: "custom" | "height" | "width"): void => {
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
export async function workspaceDialog(ctx: DocCtx): Promise<void> {
  const { app, ed } = ctx;
  const ws = app.boot.capabilities.workspace;
  const merge = h("button", { class: "btn", type: "button", text: "Merge an edited copy…", disabled: ed.readOnly });
  merge.addEventListener("click", () => { void (async () => {
    const [file] = await pickFile(".sldc,application/octet-stream");
    if (!file) return;
    try {
      const attempt = async (accept: boolean): Promise<MergeResult | null> => withPassword("This copy is protected", (password) => rawPost<MergeResult>(`/docs/${encodeURIComponent(ctx.sid)}/merge-copy`, file, "application/octet-stream", { acceptConflicts: accept ? "1" : undefined, password }));
      let out = await attempt(false);
      if (!out) return;
      if (!out.applied) { if (!await confirmConflicts(out)) return; out = await attempt(true); }
      if (out?.state) { await ed.whenIdle(); await ed.resync(out.state); toast("Merged. Save when you are happy with the result.", { kind: "ok" }); ctx.ui.refreshStatus(); }
    } catch (e) { toast(e instanceof ApiError ? e.friendly : errorText(e), { kind: "error", timeoutMs: 9000 }); }
  })(); });
  void needsPassword;
  await openDialog<true>({
    title: "Shared workspace", cancelLabel: "Close",
    body: h("div", { class: "stack" },
      notice(ws.reason, ws.available ? "ok" : "warn", ws.available ? "Connected." : "Not connected."),
      h("p", { text: ws.needs }),
      h("h3", { text: "What works without a workspace" }),
      h("ul", {}, h("li", { text: "Share a copy: Export, choose Writer document (.sldc). The other person opens it in their own Writer." }), h("li", { text: "Merge a copy back: combine an edited copy with this document. Places changed on both sides are shown to you, never decided silently." }), h("li", { text: "Comments travel inside the file." })),
      h("div", { class: "actions" }, merge)),
  }).result;
}
