/** Every action the editor offers, in one list. The "/" palette, the search box ("/" prefix), the sandwich menu, the formatting bar and the
 *  context menu all draw from it, so a function exists once and is found the same way everywhere. A command that cannot run says why. */
import { announce, h, openMenu, toast, type MenuEntry } from "./kit.js";
import * as A from "./actions.js";
import { backgroundDialog, commentDialog, equationDialog, headerFooterDialog, linkDialog, pageSetupDialog, pictureDialog, tableDialog, tableToolsDialog } from "./dialogs.js";
import type { DocCtx } from "./docctx.js";
import { exportFlow, printFlow, importFlow, renameDialog } from "./fileops.js";
import { api, errorText } from "./net.js";
import { signatureGraphicsDialog } from "./sigdialog.js";
import { addNoteAtSelection } from "./notesapi.js";
import { citeDialog, footnoteDialog, xrefDialog } from "./panels/sources.js";
import { pickFile } from "./widgets.js";
import { paragraphFontDialog } from "./typography.js";

export interface Command {
  id: string; label: string; group: "Text" | "Paragraph" | "Insert" | "Document" | "View" | "Review" | "Sign and share";
  keywords?: string; icon?: string; shortcut?: string;
  /** Returns the reason the command cannot run right now, or null when it can. */
  unavailable?(ctx: DocCtx): string | null;
  run(ctx: DocCtx): void | Promise<void>;
}

const EDITING = (ctx: DocCtx): string | null => (ctx.ed.readOnly ? "This document is read-only." : null);
const needsCaret = (ctx: DocCtx): string | null => EDITING(ctx) ?? (ctx.ed.recallSelection() ? null : "Place the cursor in the text first.");
const AI_NOTE = "AI is off or unavailable; writing works without it.";

async function pickPicture(ctx: DocCtx): Promise<void> {
  const [file] = await pickFile("image/png,image/jpeg,image/gif,image/webp");
  if (file) await pictureDialog(ctx, file, A.anchorBlock(ctx.ed));
}

async function embedNew(ctx: DocCtx): Promise<void> {
  ctx.ui.showEmbed("new");
}

function toggleView(ctx: DocCtx, key: "show_rulers" | "show_guides"): void {
  void ctx.app.setPrefs({ [key]: !ctx.app.prefs[key] }).then(() => ctx.ed.layout()).catch((e) => toast(errorText(e), { kind: "error" }));
}

export const COMMANDS: Command[] = [
  /* text */
  { id: "bold", label: "Bold", group: "Text", icon: "bold", shortcut: "Ctrl+B", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "bold") },
  { id: "italic", label: "Italic", group: "Text", icon: "italic", shortcut: "Ctrl+I", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "italic") },
  { id: "underline", label: "Underline", group: "Text", icon: "underline", shortcut: "Ctrl+U", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "underline") },
  { id: "strike", label: "Strikethrough", group: "Text", icon: "strike", shortcut: "Ctrl+Shift+X", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "strike") },
  { id: "superscript", label: "Superscript", group: "Text", keywords: "exponent power", shortcut: "Ctrl+.", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "superscript") },
  { id: "subscript", label: "Subscript", group: "Text", keywords: "chemical", shortcut: "Ctrl+,", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "subscript") },
  { id: "inline-code", label: "Code (inline)", group: "Text", icon: "code", keywords: "monospace", unavailable: needsCaret, run: (c) => A.toggleFormat(c.ed, "code") },
  { id: "clear-format", label: "Clear formatting", group: "Text", shortcut: "Ctrl+\\", unavailable: needsCaret, run: (c) => A.clearFormatting(c.ed) },
  { id: "paragraph-font", label: "Paragraph font settings…", group: "Text", keywords: "font family size typography", unavailable: needsCaret, run: (c) => paragraphFontDialog(c) },
  { id: "link", label: "Link…", group: "Text", icon: "link", keywords: "url hyperlink", shortcut: "Ctrl+K", unavailable: needsCaret, run: (c) => linkDialog(c) },
  /* paragraph */
  { id: "h1", label: "Heading 1", group: "Paragraph", icon: "heading", keywords: "title chapter", shortcut: "Ctrl+Alt+1", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 1 }) },
  { id: "h2", label: "Heading 2", group: "Paragraph", icon: "heading", keywords: "section", shortcut: "Ctrl+Alt+2", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 2 }) },
  { id: "h3", label: "Heading 3", group: "Paragraph", icon: "heading", keywords: "subsection", shortcut: "Ctrl+Alt+3", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 3 }) },
  { id: "h4", label: "Heading 4", group: "Paragraph", icon: "heading", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 4 }) },
  { id: "h5", label: "Heading 5", group: "Paragraph", icon: "heading", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 5 }) },
  { id: "h6", label: "Heading 6", group: "Paragraph", icon: "heading", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "heading", { level: 6 }) },
  ...(["Title", "Subtitle", "Slogan", "Author", "Document Date", "TOC Title"] as const).map((name): Command => ({
    id: `style-${name.toLowerCase().replaceAll(" ", "-")}`, label: name, group: "Paragraph",
    keywords: "front matter document title cover style", unavailable: needsCaret,
    run: (c) => A.applyNamedStyle(c.ed, name),
  })),
  { id: "paragraph", label: "Normal text", group: "Paragraph", icon: "paragraph", keywords: "body plain", shortcut: "Ctrl+Alt+0", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "paragraph") },
  { id: "bullets", label: "Bulleted list", group: "Paragraph", icon: "list", keywords: "unordered", shortcut: "Ctrl+Shift+8", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "list_item", { ordered: false, depth: 0 }) },
  { id: "numbered", label: "Numbered list", group: "Paragraph", icon: "list-ordered", keywords: "ordered", shortcut: "Ctrl+Shift+7", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "list_item", { ordered: true, depth: 0 }) },
  { id: "quote", label: "Quote", group: "Paragraph", icon: "quote", keywords: "blockquote", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "quote") },
  { id: "code-block", label: "Code block", group: "Paragraph", icon: "code", keywords: "monospace listing", unavailable: needsCaret, run: (c) => A.setBlockType(c.ed, "code") },
  { id: "align-left", label: "Align left", group: "Paragraph", icon: "align-left", shortcut: "Ctrl+Shift+L", unavailable: needsCaret, run: (c) => A.setBlockAttribute(c.ed, { align: "left" }, "alignment") },
  { id: "align-center", label: "Align centre", group: "Paragraph", icon: "align-center", keywords: "center", shortcut: "Ctrl+Shift+E", unavailable: needsCaret, run: (c) => A.setBlockAttribute(c.ed, { align: "center" }, "alignment") },
  { id: "align-right", label: "Align right", group: "Paragraph", icon: "align-right", shortcut: "Ctrl+Shift+R", unavailable: needsCaret, run: (c) => A.setBlockAttribute(c.ed, { align: "right" }, "alignment") },
  { id: "align-justify", label: "Justify", group: "Paragraph", shortcut: "Ctrl+Shift+J", unavailable: needsCaret, run: (c) => A.setBlockAttribute(c.ed, { align: "justify" }, "alignment") },
  { id: "indent", label: "Indent list item", group: "Paragraph", icon: "indent", shortcut: "Tab", unavailable: needsCaret, run: async (c) => { await A.indent(c.ed, 1); } },
  { id: "outdent", label: "Outdent list item", group: "Paragraph", icon: "outdent", shortcut: "Shift+Tab", unavailable: needsCaret, run: async (c) => { await A.indent(c.ed, -1); } },
  { id: "move-up", label: "Move paragraph up", group: "Paragraph", icon: "arrow-up", shortcut: "Alt+Shift+Up", unavailable: needsCaret, run: (c) => A.moveBlocks(c.ed, -1) },
  { id: "move-down", label: "Move paragraph down", group: "Paragraph", icon: "arrow-down", shortcut: "Alt+Shift+Down", unavailable: needsCaret, run: (c) => A.moveBlocks(c.ed, 1) },
  /* insert */
  { id: "table", label: "Table…", group: "Insert", icon: "table", keywords: "grid rows columns", unavailable: EDITING, run: (c) => tableDialog(c) },
  { id: "table-tools", label: "Table tools: rows, columns, header rows…", group: "Insert", icon: "table", keywords: "add delete row column", unavailable: (c) => EDITING(c) ?? (tableAtCaret(c) ? null : "Place the cursor in a table first."), run: (c) => { const id = tableAtCaret(c); return id ? tableToolsDialog(c, id) : undefined; } },
  { id: "picture", label: "Add illustration (picture)…", group: "Insert", icon: "image", keywords: "image photo figure illustration place", shortcut: "Ctrl+D", unavailable: EDITING, run: (c) => pickPicture(c) },
  { id: "equation", label: "Equation (block)…", group: "Insert", icon: "sigma", keywords: "math formula latex", unavailable: EDITING, run: (c) => equationDialog(c) },
  { id: "equation-inline", label: "Equation (inline)…", group: "Insert", icon: "sigma", keywords: "math formula latex", unavailable: needsCaret, run: (c) => equationDialog(c, undefined, true) },
  { id: "footnote", label: "Footnote…", group: "Insert", icon: "footnote", keywords: "note reference", unavailable: needsCaret, run: (c) => footnoteDialog(c) },
  { id: "citation", label: "Citation…", group: "Insert", icon: "book", keywords: "cite source reference", unavailable: needsCaret, run: (c) => citeDialog(c) },
  { id: "xref", label: "Cross-reference to a heading…", group: "Insert", icon: "link", keywords: "refer link heading", unavailable: needsCaret, run: (c) => xrefDialog(c) },
  { id: "sources", label: "Sources and bibliography", group: "Insert", icon: "book", keywords: "references bibliography doi contents", run: (c) => c.ui.openPanel("yellow", "sources") },
  { id: "page-break", label: "New page (page break)", group: "Insert", icon: "page", keywords: "new page add page break", shortcut: "Ctrl+Enter", unavailable: needsCaret, run: (c) => A.newPage(c.ed) },
  { id: "section-break", label: "New section (section break)", group: "Insert", icon: "pages", keywords: "new section chapter add section break", shortcut: "Ctrl+Alt+Enter", unavailable: needsCaret, run: (c) => A.sectionBreak(c.ed) },
  { id: "cover-insert", label: "Insert cover page", group: "Insert", icon: "page", keywords: "cover title page front matter", unavailable: (c) => EDITING(c) ?? (c.ed.model.meta.sections?.some((s) => s.role === "cover") ? "This document already has a cover page." : null), run: (c) => A.insertCoverPage(c.ed) },
  { id: "cover-convert", label: "Convert first page into cover", group: "Document", icon: "page", keywords: "cover front page existing", unavailable: (c) => EDITING(c) ?? (c.ed.model.meta.sections?.some((s) => s.role === "cover") ? "This document already has a cover page." : null), run: (c) => A.convertFirstPageToCover(c.ed) },
  { id: "cover-remove", label: "Remove cover designation (keep content)", group: "Document", icon: "page", keywords: "unmark cover keep content", unavailable: (c) => EDITING(c) ?? (!c.ed.model.meta.sections?.some((s) => s.role === "cover") ? "There is no cover page." : null), run: (c) => A.removeCoverDesignation(c.ed) },
  { id: "comment", label: "Comment…", group: "Insert", icon: "comment", keywords: "review discuss", shortcut: "Ctrl+Alt+M", unavailable: needsCaret, run: (c) => addComment(c) },
  { id: "note", label: "Private note…", group: "Insert", icon: "sticky", keywords: "annotation", unavailable: (c) => (c.ed.recallSelection() ? null : "Place the cursor in the text first."), run: async (c) => { await addNoteAtSelection(c); } },
  { id: "embed", label: "EMBED component…", group: "Insert", icon: "layers", keywords: "declarative component calculation", unavailable: EDITING, run: (c) => embedNew(c) },
  { id: "signature-graphic", label: "Signature graphic…", group: "Sign and share", icon: "signature", keywords: "visual mark picture", unavailable: EDITING, run: (c) => signatureGraphicsDialog(c) },
  /* document */
  { id: "header-footer", label: "Header and footer…", group: "Document", icon: "layout", keywords: "page number running head", unavailable: EDITING, run: (c) => headerFooterDialog(c) },
  { id: "page-setup", label: "Page dimensions and margins…", group: "Document", icon: "ruler", keywords: "size paper a4 letter orientation margins", unavailable: EDITING, run: (c) => pageSetupDialog(c) },
  { id: "background", label: "Add background (page colour)…", group: "Document", icon: "background", keywords: "page colour color", shortcut: "Ctrl+Alt+B", unavailable: EDITING, run: (c) => backgroundDialog(c) },
  { id: "save", label: "Save", group: "Document", icon: "save", shortcut: "Ctrl+S", unavailable: EDITING, run: async (c) => { await c.ui.save(); } },
  { id: "save-as", label: "Save as…", group: "Document", icon: "save", run: async (c) => { await c.ui.saveAs(); } },
  { id: "rename", label: "Rename document…", group: "Document", icon: "edit", run: async (c) => { await renameCurrent(c); } },
  { id: "export", label: "Export…", group: "Document", icon: "download", keywords: "pdf word docx odt rtf html markdown", run: (c) => exportFlow(c.app, c.sid) },
  { id: "import", label: "Import…", group: "Document", icon: "archive", run: (c) => importFlow(c.app) },
  { id: "print", label: "Print and PDF preview…", group: "Document", icon: "print", run: (c) => printFlow(c.app, c.sid) },
  { id: "versions", label: "Version history", group: "Document", icon: "history", run: (c) => { c.app.go({ name: "versions", sid: c.sid }); } },
  /* view */
  { id: "find", label: "Find in document", group: "View", icon: "search", shortcut: "Ctrl+F", run: (c) => c.ui.focusFind() },
  { id: "zoom-height", label: "Zoom to page height", group: "View", icon: "zoom-height", run: (c) => c.ui.setZoom("height") },
  { id: "zoom-width", label: "Zoom to page width", group: "View", icon: "zoom-width", run: (c) => c.ui.setZoom("width") },
  { id: "zoom-100", label: "Zoom 100%", group: "View", shortcut: "Ctrl+0", run: (c) => c.ui.setZoom(100) },
  { id: "rulers", label: "Show or hide rulers", group: "View", icon: "ruler", run: (c) => toggleView(c, "show_rulers") },
  { id: "guides", label: "Show or hide margin and guide lines", group: "View", run: (c) => toggleView(c, "show_guides") },
  { id: "guide-vertical", label: "Add a vertical guide", group: "View", keywords: "page layout ruler guide vertical", unavailable: EDITING,
    run: (c) => { const g = c.ed.model.geometry(c.ed.model.block(c.ed.recallSelection()?.start.block ?? "")?.section);
      return c.ed.addGuide("v", (g.margins.left + g.widthMm - g.margins.right) / 2); } },
  { id: "guide-horizontal", label: "Add a horizontal guide", group: "View", keywords: "page layout ruler guide horizontal", unavailable: EDITING,
    run: (c) => { const g = c.ed.model.geometry(c.ed.model.block(c.ed.recallSelection()?.start.block ?? "")?.section);
      return c.ed.addGuide("h", (g.margins.top + g.heightMm - g.margins.bottom) / 2); } },
  { id: "clear-guides", label: "Remove all guides", group: "View", unavailable: (c) => EDITING(c) ?? ((c.ed.model.ext.guides?.v?.length ?? 0) + (c.ed.model.ext.guides?.h?.length ?? 0) ? null : "There are no guides."), run: async (c) => { await c.ed.op({ op: "ext_set", values: { guides: null }, label: "guides" }); } },
  { id: "hide", label: "Hide or reveal (dim everything except the page)", group: "View", icon: "eye", keywords: "privacy blur cover", run: (c) => c.ui.toggleHidden() },
  { id: "layer-new", label: "New layer", group: "Document", icon: "layers", keywords: "add layer", shortcut: "Ctrl+Alt+Shift+N", unavailable: EDITING, run: async (c) => { const id = await A.newLayer(c.ed); if (id) c.ui.showLayers(); } },
  { id: "right-panel", label: "Show or hide the pages, layers and illustrations panel", group: "View", icon: "layers", run: (c) => c.ui.toggleRight() },
  { id: "left-panel", label: "Show or hide the Tools panel", group: "View", icon: "layout", run: (c) => c.ui.toggleLeft() },
  { id: "embed-panel", label: "Show or hide the EMBED panel of this page", group: "View", icon: "code", keywords: "component declaration", run: (c) => c.ui.openPanel("embed") },
  { id: "format-bar", label: "Show or hide the formatting bar", group: "View", icon: "heading", keywords: "toolbar bold italic style", run: (c) => c.ui.toggleFormatBar() },
  /* review */
  { id: "proofing", label: "Spelling and grammar panel", group: "Review", icon: "spell", keywords: "autocorrect typos synonyms", run: (c) => c.ui.openPanel("red", "proofing") },
  { id: "ai", label: "AI Assistant panel", group: "Review", icon: "sparkle", keywords: "rewrite shorten simplify proofread", run: (c) => c.ui.openPanel("red", "ai") },
  { id: "notes", label: "Notes and comments panel", group: "Review", icon: "sticky", run: (c) => c.ui.openPanel("yellow", "notes") },
  /* sign and share */
  { id: "sign", label: "Sign this revision…", group: "Sign and share", icon: "pen", keywords: "cryptographic signature", run: (c) => { c.app.go({ name: "sign", sid: c.sid }); } },
  { id: "verify", label: "Verify signature", group: "Sign and share", icon: "shield", run: (c) => { c.app.go({ name: "verify-signature", sid: c.sid }); } },
  { id: "signatures", label: "Signature graphics library", group: "Sign and share", icon: "signature", run: (c) => { c.app.go({ name: "signatures" }); } },
  { id: "settings", label: "Settings", group: "Document", icon: "settings", run: (c) => { c.app.go({ name: "settings" }); } },
];

/* Keys typed just before a command was chosen may still be waiting for the server (see input.ts); a command runs after them, on the text the person sees. */
for (const command of COMMANDS) {
  const run = command.run;
  command.run = async (ctx: DocCtx): Promise<void> => { await ctx.ed.whenIdle(); await run(ctx); };
}

void AI_NOTE;

export function tableAtCaret(ctx: DocCtx): string | null {
  const sel = ctx.ed.recallSelection();
  const id = sel?.start.block ?? ctx.ed.selectedBlock;
  return id && ctx.ed.model.block(id)?.type === "table" ? id : null;
}

async function renameCurrent(ctx: DocCtx): Promise<void> {
  const summary = ctx.app.docs.get(ctx.sid);
  const name = await renameDialog(summary?.name ?? ctx.ed.model.meta.title);
  if (!name) return;
  const out = await api.post<{ name: string; title: string }>(`/docs/${encodeURIComponent(ctx.sid)}/rename`, { name });
  await ctx.app.openDocs();
  announce(`Renamed to ${out.name}.`);
  ctx.ui.refreshStatus();
}

async function addComment(ctx: DocCtx): Promise<void> {
  const input = await commentDialog(ctx);
  if (!input) return;
  const reply = await ctx.ed.call(() => api.post<{ version: number; dirty: boolean; comments: import("./types.js").CommentThread[] }>(`/docs/${encodeURIComponent(ctx.sid)}/comments`, input));
  ctx.ed.applyComments(reply);
  ctx.ui.openPanel("yellow", "comments");
  announce("Comment added.");
}

/* ------------------------------------------------------------------------------------------------------- search */
const norm = (s: string): string => s.toLowerCase();
export function matchCommands(ctx: DocCtx, query: string): Command[] {
  const q = norm(query.trim().replace(/^\//, ""));
  if (!q) return COMMANDS.filter((c) => c.group !== "Document" || ["header-footer", "page-setup", "save"].includes(c.id));
  const words = q.split(/\s+/);
  const scored = COMMANDS.map((c) => {
    const hay = norm(`${c.label} ${c.keywords ?? ""} ${c.group}`);
    if (!words.every((w) => hay.includes(w))) return null;
    const label = norm(c.label);
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    return { c, score };
  }).filter((x): x is { c: Command; score: number } => x !== null);
  scored.sort((a, b) => a.score - b.score);
  void ctx;
  return scored.map((x) => x.c).slice(0, 14);
}

/** The searchable list used by the "/" palette and by the search box. Arrow keys move, Enter runs, and a command that cannot run explains why. */
export class PaletteList {
  readonly el: HTMLElement;
  private items: Command[] = [];
  private index = 0;
  constructor(private readonly ctx: DocCtx, private readonly onPick: (command: Command) => void) {
    this.el = h("ul", { attrs: { role: "listbox", "aria-label": "Writer functions" } });
  }
  setQuery(query: string): void {
    this.items = matchCommands(this.ctx, query);
    this.index = 0;
    this.paint();
  }
  private paint(): void {
    this.el.replaceChildren();
    if (!this.items.length) { this.el.appendChild(h("li", { class: "muted pad", text: "No function matches. Try a word like “table”, “heading” or “footnote”." })); return; }
    this.items.forEach((command, i) => {
      const reason = command.unavailable?.(this.ctx) ?? null;
      const button = h("button", { type: "button", attrs: { role: "option", "aria-selected": String(i === this.index), "aria-disabled": reason ? "true" : null, tabindex: "-1", title: reason ?? undefined } },
        h("span", { text: command.label }),
        h("span", { class: "hint", text: reason ?? command.shortcut ?? command.group }));
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => { if (reason) { toast(reason, { kind: "info" }); return; } this.onPick(command); });
      this.el.appendChild(h("li", {}, button));
    });
  }
  move(delta: number): void {
    if (!this.items.length) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.paint();
    this.el.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }
  current(): Command | undefined { return this.items[this.index]; }
  pick(): void {
    const command = this.current();
    if (!command) return;
    const reason = command.unavailable?.(this.ctx) ?? null;
    if (reason) { toast(reason, { kind: "info" }); return; }
    this.onPick(command);
  }
}

/** The "/" palette: a small floating search box at the cursor. */
export function openPalette(ctx: DocCtx, x: number, y: number, restore: () => void): void {
  const input = h("input", { type: "search", attrs: { "aria-label": "Search Writer functions", placeholder: "Search Writer functions…", autocomplete: "off", spellcheck: "false" } });
  const box = h("div", { class: "slash", attrs: { role: "dialog", "aria-label": "Writer functions" } });
  const close = (): void => { document.removeEventListener("mousedown", outside, true); box.remove(); };
  const list = new PaletteList(ctx, (command) => { close(); restore(); void Promise.resolve(command.run(ctx)).catch((e: unknown) => toast(errorText(e), { kind: "error" })); });
  box.append(input, list.el);
  box.style.setProperty("left", `${Math.max(8, Math.min(x, window.innerWidth - 360))}px`);
  box.style.setProperty("top", `${Math.max(8, Math.min(y + 6, window.innerHeight - 320))}px`);
  const outside = (e: MouseEvent): void => { if (!box.contains(e.target as Node)) { close(); restore(); } };
  input.addEventListener("input", () => list.setQuery(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); list.move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list.move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); list.pick(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); restore(); }
  });
  document.body.appendChild(box);
  document.addEventListener("mousedown", outside, true);
  list.setQuery("");
  input.focus();
}

/* --------------------------------------------------------------------------------------------------- context menu */
export function menuAt(x: number, y: number, entries: MenuEntry[], label: string): void {
  const anchor = h("span", { class: "menu-anchor", css: { position: "fixed", left: `${x}px`, top: `${y}px`, width: "1px", height: "1px" }, attrs: { tabindex: "-1" } });
  document.body.appendChild(anchor);
  openMenu(anchor, entries, { label });
  window.setTimeout(() => anchor.remove(), 0);
}

export function contextMenu(ctx: DocCtx, x: number, y: number, restore: () => void): void {
  const run = (id: string) => (): void => {
    restore();
    const command = COMMANDS.find((c) => c.id === id);
    if (command) void Promise.resolve(command.run(ctx)).catch((e: unknown) => toast(errorText(e), { kind: "error" }));
  };
  const entry = (id: string, label?: string): MenuEntry => {
    const c = COMMANDS.find((k) => k.id === id) as Command;
    const reason = c.unavailable?.(ctx) ?? null;
    const item: MenuEntry = { label: label ?? c.label, disabled: reason !== null, run: run(id) };
    if (c.icon) (item as { icon?: string }).icon = c.icon;
    return item;
  };
  const hasText = !!ctx.ed.selectionText();
  const clip = (cmd: "copy" | "cut") => (): void => { restore(); document.execCommand(cmd); };
  const paste = (): void => {
    restore();
    if (!navigator.clipboard?.readText) { toast("Use Ctrl+V to paste in this browser.", { kind: "info" }); return; }
    void navigator.clipboard.readText().then((t) => A.insertText(ctx.ed, t)).catch(() => toast("The browser did not allow reading the clipboard. Use Ctrl+V to paste.", { kind: "info" }));
  };
  menuAt(x, y, [
    { label: "Cut", icon: "scissors", disabled: !hasText || ctx.ed.readOnly, run: clip("cut") },
    { label: "Copy", icon: "copy", disabled: !hasText, run: clip("copy") },
    { label: "Paste", disabled: ctx.ed.readOnly, run: paste },
    "separator",
    entry("bold"), entry("italic"), entry("link"),
    "separator",
    entry("comment"), entry("note"), entry("footnote"), entry("citation"),
    "separator",
    entry("table"), entry("picture"), entry("equation-inline"),
  ], "Text actions");
}
