/** The editor: a server-authoritative document view.
 *
 *  The browser never decides what the document says. Every change is sent as an operation (see ops.py) tagged with the version the
 *  browser last saw; the server applies it, remembers how to undo it and answers with a patch, which this class applies to its mirror
 *  (DocModel) and to the DOM. Typing is the one exception to "ask first": the browser edits the text natively (so IME, accents and
 *  speed behave) and the difference is sent right after, coalesced while an earlier request is still on its way.
 *
 *  All blocks live in ONE contenteditable root, so selections, arrow keys and drag-selection cross paragraphs and pages naturally. */
import { announce, Emitter, uid } from "./kit.js";
import { Decor } from "./decor.js";
import { blockIdOf, caretAt, editableOf, placeCaret, pointFor, serialise, type CaretPoint } from "./domtext.js";
import { DocModel, OpQueue, layerOf } from "./model.js";
import { api, errorText } from "./net.js";
import { PageView, type LayoutBlock, type PageEvents } from "./page.js";
import { EDIT_MODE, footnoteNumbers, listMarkers, refreshBlock, renderBlock, syncLayer, type RenderContext } from "./render.js";
import { cleanInsert, diffText, MM_PX, splitLines } from "./textops.js";
import { OBJECT_CHAR, TEXT_TYPES, type Block, type CommentThread, type DocState, type HeaderFooter, type Op, type Patch, type Prefs, type Reference } from "./types.js";

export type EditorEvent =
  | { type: "patch"; patch: Patch; local: boolean }
  | { type: "selection" }
  | { type: "block-selected"; id: string | null }
  | { type: "layout" }
  | { type: "stale" }
  | { type: "reloaded" }
  | { type: "error"; error: unknown }
  | { type: "open-object"; kind: "embed" | "equation" | "figure" | "table"; block: string }
  | { type: "slash"; block: string; x: number; y: number }
  | { type: "context"; x: number; y: number }
  | { type: "files"; files: File[]; after: string | null }
  | { type: "note-from-match"; block: string; start: number; end: number }
  | { type: "page-double"; section: string | undefined; xMm: number; yMm: number }
  | { type: "ruler-double" }
  | { type: "link"; href: string }
  | { type: "reference"; id: string }
  | { type: "save" }
  | { type: "find" }
  | { type: "command"; name: string }
  | { type: "comments" };

export interface Pt { block: string; offset: number; field: CaretPoint["field"]; row?: number; col?: number }
export interface Sel { start: Pt; end: Pt; collapsed: boolean }

export interface EditorHooks { prefs(): Prefs }

const NEW_ID = (): string => `b${uid().slice(0, 16)}`;

const SIG = (b: Block): string => JSON.stringify([b.type, b.style, b.attributes, b.spans, b.table, b.figure, b.equation, b.embed, b.type === "table" || b.type === "figure" ? b.text : 0]);

export class Editor {
  readonly model: DocModel;
  readonly queue: OpQueue;
  readonly page: PageView;
  readonly decor: Decor;
  readonly events = new Emitter<EditorEvent>();
  readonly els = new Map<string, HTMLElement>();
  readonly sent = new Map<string, string>();
  readonly dirty = new Set<string>();
  composing = false;
  selectedBlock: string | null = null;
  private sigs = new Map<string, string>();
  private deferred = new Set<string>();
  private ctxCache: RenderContext | null = null;
  private reflowTimer: number | undefined;
  private settleTimer: number | undefined;
  private flushTimer: number | undefined;
  private destroyed = false;
  stale = false;
  /** Formatting switched on with the caret in place (Ctrl+B with nothing selected): applied to the next text typed. */
  readonly pendingFormat = new Set<string>();
  /** Inline typing attributes for a collapsed selection (same operation stream as bold/italic). */
  readonly pendingInline = new Map<string, string | number | null>();

  constructor(state: DocState, readonly hooks: EditorHooks) {
    this.model = new DocModel(state);
    const pageEvents: PageEvents = {
      rulerDouble: () => this.events.emit({ type: "ruler-double" }),
      pageDouble: (section, xMm, yMm) => this.events.emit({ type: "page-double", section, xMm, yMm }),
      margin: (section, side, mm) => { void this.setMargin(section, side, mm); },
      band: (section, edge, mm) => { void this.setBand(section, edge, mm); },
      guideMove: (axis, index, mm) => { void this.moveGuide(axis, index, mm); },
    };
    this.page = new PageView(pageEvents, this.model.readOnly ? "false" : EDIT_MODE);
    this.decor = new Decor((id) => this.textEl(id));
    this.queue = new OpQueue(this.model, (patch, op) => this.afterPatch(patch, op, true), () => { this.stale = true; this.events.emit({ type: "stale" }); });
    this.page.setHeaderFooter((section) => {
      const sec = (this.model.meta.sections ?? []).find((x) => x.id === section) ?? (this.model.meta.sections ?? [])[0];
      const hf: { header?: HeaderFooter; footer?: HeaderFooter; numbering?: { start?: number; format?: string } } = {};
      if (sec?.header) hf.header = sec.header;
      if (sec?.footer) hf.footer = sec.footer;
      if (sec?.numbering) hf.numbering = sec.numbering as { start?: number; format?: string };
      return hf;
    });
    this.renderAll();
    document.addEventListener("selectionchange", this.onSelectionChange);
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.clearTimeout(this.reflowTimer);
    window.clearTimeout(this.settleTimer);
    window.clearTimeout(this.flushTimer);
    this.decor.clear();
  }

  /** The last place the caret was inside the page. Panels, menus and dialogs take focus away, and commands still need to know where to act. */
  lastSel: Sel | null = null;
  private onSelectionChange = (): void => {
    if (this.destroyed) return;
    const now = this.readSelection();
    if (now) this.lastSel = now;
    this.events.emit({ type: "selection" });
  };
  /** The caret if it is in the page now, otherwise where it last was. */
  recallSelection(): Sel | null { return this.readSelection() ?? this.lastSel; }
  /** Put focus and the caret back into the page (after a dialog, menu or panel). */
  refocus(sel: Sel | null = this.lastSel): void {
    if (this.destroyed) return;
    this.host.focus({ preventScroll: true });
    this.restoreSelection(sel);
  }

  get host(): HTMLElement { return this.page.host; }
  get readOnly(): boolean { return this.model.readOnly; }
  get sid(): string { return this.model.sid; }

  /* ---------------------------------------------------------------------------------------------- rendering */
  ctx(): RenderContext {
    if (this.ctxCache) return this.ctxCache;
    const blocks = this.model.list();
    const ext = this.model.ext;
    const hidden = new Set<string>();
    const locks = new Set<string>(Object.keys(ext.locks ?? {}));
    for (const layer of ext.layers ?? []) { if (!layer.visible) hidden.add(layer.id); if (layer.locked) locks.add(`layer:${layer.id}`); }
    this.ctxCache = {
      sid: this.model.sid, meta: this.model.meta, readOnly: this.model.readOnly, markers: listMarkers(blocks), footnotes: footnoteNumbers(blocks, this.model.meta),
      locked: (id) => locks.has(id), role: this.model.state.access.role, hidden, locks,
      layerOf: (block) => layerOf(block, ext),
      contentMm: (section) => { const g = this.model.geometry(section); return g.widthMm - g.margins.left - g.margins.right; },
      mediaLoaded: () => { if (!this.destroyed) this.scheduleReflow(); },
    };
    return this.ctxCache;
  }

  private invalidate(): void { this.ctxCache = null; }

  renderAll(): void {
    this.invalidate();
    this.els.clear();
    this.sigs.clear();
    const ctx = this.ctx();
    for (const block of this.model.list()) { this.els.set(block.id, renderBlock(block, ctx)); this.sigs.set(block.id, SIG(block)); this.sent.set(block.id, block.text); }
    this.layout();
  }

  textEl(id: string): HTMLElement | null { return this.els.get(id)?.querySelector<HTMLElement>("[data-edit=text]") ?? null; }
  fieldEl(key: string): HTMLElement | null {
    const [id, field] = key.split("#") as [string, string | undefined];
    const wrap = this.els.get(id);
    if (!wrap) return null;
    if (!field) return wrap.querySelector<HTMLElement>("[data-edit=text]");
    if (field === "cap") return wrap.querySelector<HTMLElement>("[data-edit=caption]");
    const [r, c] = field.split(",");
    return wrap.querySelector<HTMLElement>(`[data-edit=cell][data-row="${r}"][data-col="${c}"]`);
  }

  /** Full layout: distribute every block over the sheets. */
  layout(): void {
    const ctx = this.ctx();
    const prefs = this.hooks.prefs();
    const saved = this.saveSelection();
    const blocks: LayoutBlock[] = this.model.list().map((b) => {
      const el = this.els.get(b.id) as HTMLElement;
      el.toggleAttribute("data-break", b.attributes?.["page_break_before"] === true);
      return {
        id: b.id, el, section: b.section, pageBreak: b.attributes?.["page_break_before"] === true,
        footnotes: (b.spans ?? []).filter((s) => s.type === "ref" && s.ref && ctx.footnotes.has(s.ref)).map((s) => ({ n: ctx.footnotes.get(s.ref as string) as number, text: referenceText(this.model.meta.references, s.ref as string) })),
      };
    });
    const ext = this.model.ext;
    const onLine = this.page.holdsLineFocus();
    this.page.layout({
      blocks, geometry: (section) => this.model.geometry(section), title: this.model.meta.title,
      guides: ext.guides ?? {}, background: /^#[0-9a-fA-F]{6}$/.test(ext.background?.color ?? "") ? ext.background?.color : undefined,
      showMargins: true, showGuides: prefs.show_guides, showRulers: prefs.show_rulers, unit: prefs.units === "in" ? "in" : "mm",
    });
    // A margin, header or footer line (or its ruler handle) that has the focus keeps it: putting the caret back would take it away.
    if (!onLine) this.restoreSelection(saved);
    if (this.selectedBlock) this.els.get(this.selectedBlock)?.setAttribute("data-selected", "");   // the block was drawn again: keep showing that it is selected
    this.decor.refresh();
    this.events.emit({ type: "layout" });
  }

  scheduleReflow(): void {
    window.clearTimeout(this.reflowTimer);
    this.reflowTimer = window.setTimeout(() => {
      if (this.destroyed || this.composing) return;
      const saved = this.saveSelection();
      const changed = this.page.reflow();
      if (changed) this.page.redecorate();
      this.restoreSelection(saved);
      this.decor.refresh();
      this.events.emit({ type: "layout" });
    }, 120);
  }

  /* ---------------------------------------------------------------------------------------------- selection */
  private pointOf(node: Node | null, offset: number): Pt | null {
    if (!node) return null;
    const caret = caretAt(node, offset);
    if (caret) { const pt: Pt = { block: caret.block, offset: caret.offset, field: caret.field }; if (caret.row !== undefined) { pt.row = caret.row; pt.col = caret.col as number; } return pt; }
    const id = blockIdOf(node);
    return id ? { block: id, offset: 0, field: "text" } : null;
  }

  private before(a: Pt, b: Pt): boolean {
    const ia = this.model.indexOf(a.block);
    const ib = this.model.indexOf(b.block);
    if (ia !== ib) return ia < ib;
    if (a.field === "cell" && b.field === "cell" && (a.row !== b.row || a.col !== b.col)) return (a.row ?? 0) * 1000 + (a.col ?? 0) < (b.row ?? 0) * 1000 + (b.col ?? 0);
    return a.offset <= b.offset;
  }

  readSelection(): Sel | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.anchorNode || !s.focusNode) return null;
    if (!this.host.contains(s.anchorNode) || !this.host.contains(s.focusNode)) return null;
    const a = this.pointOf(s.anchorNode, s.anchorOffset);
    const f = this.pointOf(s.focusNode, s.focusOffset);
    if (!a || !f) return null;
    const [start, end] = this.before(a, f) ? [a, f] : [f, a];
    return { start, end, collapsed: s.isCollapsed };
  }

  saveSelection(): Sel | null { return this.readSelection(); }

  restoreSelection(sel: Sel | null): void {
    if (!sel) return;
    const a = this.setPoint(sel.start);
    const b = sel.collapsed ? a : this.setPoint(sel.end);
    if (!a || !b) return;
    const s = window.getSelection();
    if (!s) return;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    s.removeAllRanges();
    s.addRange(range);
  }

  private setPoint(pt: Pt): { node: Node; offset: number } | null {
    const key = pt.field === "text" ? pt.block : pt.field === "caption" ? `${pt.block}#cap` : `${pt.block}#${pt.row},${pt.col}`;
    const el = this.fieldEl(key);
    return el ? pointFor(el, pt.offset) : null;
  }

  focusBlock(id: string, offset?: number): void {
    const el = this.textEl(id) ?? this.els.get(id)?.querySelector<HTMLElement>("[data-edit], [tabindex]") ?? null;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.dataset["edit"] === "text") placeCaret(el, offset ?? serialise(el).length);
    this.els.get(id)?.scrollIntoView({ block: "nearest" });
  }

  scrollToBlock(id: string, offset?: number): void {
    const el = this.els.get(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (offset !== undefined) this.focusBlock(id, offset);
  }

  currentPage(): number {
    const s = this.readSelection();
    const el = s ? this.els.get(s.start.block) : null;
    if (el) return this.page.pageIndexOf(el) + 1;
    const rect = this.page.scroller.getBoundingClientRect();
    const mid = rect.top + rect.height / 3;
    const hit = this.page.sheets.findIndex((sh) => { const r = sh.el.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
    return hit >= 0 ? hit + 1 : 1;
  }

  selectionText(sel: Sel | null = this.readSelection()): string {
    if (!sel || sel.collapsed) return "";
    const i = this.model.indexOf(sel.start.block);
    const j = this.model.indexOf(sel.end.block);
    const parts: string[] = [];
    for (let k = i; k <= j; k += 1) {
      const b = this.model.block(this.model.order[k] as string);
      if (!b) continue;
      if (b.type === "table" || b.type === "figure" || b.type === "embed" || b.type === "equation") { parts.push(b.type === "equation" ? b.equation?.source ?? "" : b.text); continue; }
      const from = k === i ? sel.start.offset : 0;
      const to = k === j ? sel.end.offset : b.text.length;
      parts.push(this.plain(b, from, to));
    }
    return parts.join("\n");
  }

  /** Text of a range of a block with inline equations written out as their source (so copying never yields a bare placeholder). */
  plain(b: Block, from: number, to: number): string {
    let out = "";
    const spans = b.spans ?? [];
    for (let i = from; i < to; i += 1) {
      const ch = b.text[i];
      if (ch === OBJECT_CHAR) { const o = spans.find((s) => s.start === i && (s.type === "equation" || s.type === "image")); out += o?.equation?.source ?? o?.figure?.alt ?? ""; } else out += ch ?? "";
    }
    return out;
  }

  /* ---------------------------------------------------------------------------------------------- sending */
  /** Set by the keyboard layer: resolves when keys that were held while a structural edit was in flight have all been applied. */
  settleHook: (() => Promise<void>) | null = null;
  /** Wait for held keystrokes, then send everything typed. Use this before saving, exporting or searching; actions that run inside the held queue use flush(). */
  async whenIdle(): Promise<void> {
    await this.settleHook?.();
    await this.flush();
  }

  /** Send everything typed so far (text diffs), in order, then wait for the server. */
  async flush(): Promise<void> {
    window.clearTimeout(this.flushTimer);
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) {
      const el = this.fieldEl(key);
      if (!el) continue;
      const [id, field] = key.split("#") as [string, string | undefined];
      const now = serialise(el);
      const was = this.sent.get(key) ?? this.model.block(id)?.text ?? "";
      if (now === was) continue;
      this.sent.set(key, now);
      if (!field) {
        const caret = this.readSelection();
        const edit = diffText(was, now, caret && caret.start.block === id && caret.collapsed ? caret.start.offset : undefined);
        if (edit) {
          void this.queue.send({ op: "text", block: id, start: edit.start, end: edit.end, insert: edit.insert }).catch((e) => this.failed(e));
          if ((this.pendingFormat.size || this.pendingInline.size) && edit.insert) {
            const set: Record<string, boolean | number | string> = Object.fromEntries([...this.pendingFormat].map((f) => [f, true]));
            const unset: string[] = [];
            for (const [key, value] of this.pendingInline) {
              if (value === null) unset.push(key); else set[key] = value;
            }
            this.pendingFormat.clear();
            this.pendingInline.clear();
            void this.queue.send({ op: "format", block: id, start: edit.start, end: edit.start + edit.insert.length, set, unset }).catch((e) => this.failed(e));
          }
        }
      } else if (field === "cap") {
        void this.queue.send({ op: "caption", block: id, text: now }).catch((e) => this.failed(e));
      } else {
        const [r, c] = field.split(",").map(Number) as [number, number];
        void this.queue.send({ op: "table_cell", block: id, row: r, col: c, text: now }).catch((e) => this.failed(e));
      }
    }
    await this.queue.idle();
    this.settle();
  }

  /** The browser changed a field natively (typing); remember it and send soon. */
  touched(el: HTMLElement): void {
    const id = blockIdOf(el);
    if (!id) return;
    const field = el.dataset["edit"];
    const key = field === "caption" ? `${id}#cap` : field === "cell" ? `${id}#${el.dataset["row"]},${el.dataset["col"]}` : id;
    if (!this.sent.has(key)) this.sent.set(key, this.model.block(id)?.text ?? "");
    this.dirty.add(key);
    window.clearTimeout(this.flushTimer);
    if (!this.composing) this.flushTimer = window.setTimeout(() => { void this.flush(); }, 60);
  }

  /** An operation from a command (not typing). Typed text is sent first so the order of events is the order of the person's actions. */
  async op(op: Op): Promise<Patch> {
    await this.flush();
    return this.queue.send(op);
  }

  async batch(ops: Op[], label: string): Promise<Patch> { return this.op({ op: "batch", ops, label }); }

  /** Other server calls that change the document: ordered with the edits, and their patch (if any) applied to the view. */
  async call<T>(work: () => Promise<T>, patchOf?: (result: T) => Patch | undefined): Promise<T> {
    await this.flush();
    return this.queue.run(async () => {
      const result = await work();
      const patch = patchOf?.(result);
      if (patch) this.applyExternalPatch(patch);
      return result;
    });
  }

  failed(error: unknown): void {
    this.events.emit({ type: "error", error });
    announce(errorText(error), "assertive");
    // The mirror may be ahead of the server (a typed change was refused): fetch the truth.
    void this.resync();
  }

  /** Replace the mirror with the server's state (after a refused edit, a restore, a merge, an external change). */
  async resync(state?: DocState): Promise<void> {
    const fresh = state ?? (await api.get<DocState>(`/docs/${encodeURIComponent(this.model.sid)}`));
    const saved = this.saveSelection();
    this.dirty.clear();
    this.deferred.clear();
    this.model.load(fresh);
    this.stale = false;
    this.renderAll();
    this.restoreSelection(saved);
    this.events.emit({ type: "reloaded" });
  }

  /** Comment calls change the server's version without returning blocks: take the new version and thread list so the next edit is not seen as stale. */
  applyComments(reply: { version: number; dirty: boolean; comments: CommentThread[] }): void {
    this.model.version = reply.version;
    this.model.comments = reply.comments;
    this.model.state = { ...this.model.state, version: reply.version, dirty: reply.dirty, comments: reply.comments };
    this.events.emit({ type: "comments" });
  }

  /** Re-read the comment threads (their anchors move as the text is edited). Only applied when no edit happened in between. */
  async refreshComments(): Promise<void> {
    const fresh = await api.get<DocState>(`/docs/${encodeURIComponent(this.model.sid)}`);
    if (fresh.version !== this.model.version) return;
    this.model.comments = fresh.comments;
    this.model.state = { ...this.model.state, comments: fresh.comments, dirty: fresh.dirty, savedAt: fresh.savedAt, lastEdit: fresh.lastEdit };
    this.events.emit({ type: "comments" });
  }

  /** A patch the server produced outside of /ops (citations, EMBED apply, AI apply, signature graphic placement). */
  applyExternalPatch(patch: Patch): void { this.afterPatch(patch, { op: "external" }, false); }

  private afterPatch(patch: Patch, op: Op, local: boolean): void {
    const { changed, removed, reordered, documentChanged } = this.model.applyPatch(patch);
    this.invalidate();
    const ctx = this.ctx();
    let relayout = reordered || documentChanged;
    for (const id of removed) { this.els.get(id)?.remove(); this.els.delete(id); this.sigs.delete(id); this.sent.delete(id); relayout = true; }
    const active = this.readSelection()?.start.block;
    const pendingTyping = this.dirty.size > 0 || this.composing;
    for (const id of changed) {
      const block = this.model.block(id) as Block;
      const wrapper = this.els.get(id);
      if (!wrapper) { this.els.set(id, renderBlock(block, ctx)); this.sigs.set(id, SIG(block)); this.sent.set(id, block.text); relayout = true; continue; }
      const sig = SIG(block);
      if (wrapper.hasAttribute("data-break") !== (block.attributes?.["page_break_before"] === true)) relayout = true;   // a page break was added or removed: the pages are laid out again
      const textBlock = TEXT_TYPES.includes(block.type) && wrapper.dataset["type"] === block.type;
      if (textBlock) {
        const el = this.textEl(id);
        const domText = el ? serialise(el) : block.text;
        const same = domText === block.text && this.sigs.get(id) === sig;
        if (same) continue;
        if (domText === block.text && sig !== this.sigs.get(id)) {
          if (id === active && (pendingTyping || this.queue.pending > 1)) { this.deferred.add(id); this.sigs.set(id, sig); continue; }
          this.rerender(id, block, wrapper);
          relayout = relayout || false;
          continue;
        }
        if (id === active && (pendingTyping || this.queue.pending > 1)) { this.deferred.add(id); continue; }
        this.rerender(id, block, wrapper);
        this.scheduleReflow();
      } else {
        const fresh = renderBlock(block, ctx);
        wrapper.replaceWith(fresh);
        this.els.set(id, fresh);
        this.sigs.set(id, sig);
        this.sent.set(id, block.text);
        for (const key of [...this.dirty]) if (key.startsWith(`${id}#`)) this.dirty.delete(key);
        this.scheduleReflow();
      }
      this.sent.set(id, block.text);
    }
    if (documentChanged) for (const [id, block] of this.model.blocks) { const w = this.els.get(id); if (w && !changed.includes(id)) { this.rerender(id, block, w); } }
    if (relayout) {
      for (const [id, block] of this.model.blocks) if (listMarkersChanged(this.els.get(id), ctx, block)) { const w = this.els.get(id); if (w) this.rerender(id, block, w); }
      this.layout();
    } else this.scheduleReflow();
    if (documentChanged || relayout) this.decor.refresh();
    this.events.emit({ type: "patch", patch, local });
    void op;
  }

  /** Re-render one block in place and put the caret back where it was. */
  private rerender(id: string, block: Block, wrapper: HTMLElement): void {
    const saved = this.readSelection();
    const ctx = this.ctx();
    if (!refreshBlock(wrapper, block, ctx)) {
      const fresh = renderBlock(block, ctx);
      wrapper.replaceWith(fresh);
      this.els.set(id, fresh);
    } else syncLayer(wrapper, block, ctx);
    this.sigs.set(id, SIG(block));
    this.sent.set(id, block.text);
    if (saved && (saved.start.block === id || saved.end.block === id)) this.restoreSelection(saved);
    this.decor.refresh();
  }

  /** Called when typing has been sent and answered: bring deferred blocks in line with the server. */
  private settle(): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      if (this.destroyed || this.composing || this.dirty.size || this.queue.pending) return;
      for (const id of [...this.deferred]) {
        const block = this.model.block(id);
        const wrapper = this.els.get(id);
        if (block && wrapper) this.rerender(id, block, wrapper);
        this.deferred.delete(id);
      }
    }, 350);
  }

  /* ---------------------------------------------------------------------------------------------- document-level settings */
  async setMargin(section: string | undefined, side: "top" | "right" | "bottom" | "left", mm: number): Promise<void> {
    const g = this.model.geometry(section);
    const vertical = side === "top" || side === "bottom";
    const opposite = g.margins[side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left"];
    const clamped = Math.max(0, Math.min((vertical ? g.heightMm : g.widthMm) - opposite - 30, Math.round(mm * 2) / 2));
    try { await this.op({ op: "page_setup", section: section ?? undefined, page: { margins_mm: { [side]: clamped } }, label: "margins" }); } catch (e) { this.failed(e); }
  }

  /** Move where the header or footer text sits (the .sldc page's header_mm / footer_mm). */
  async setBand(section: string | undefined, edge: "header" | "footer", mm: number): Promise<void> {
    const g = this.model.geometry(section);
    const other = edge === "header" ? g.footerMm : g.headerMm;
    const clamped = Math.max(0, Math.min(g.heightMm - other - 30, Math.round(mm * 2) / 2));
    try { await this.op({ op: "page_setup", section: section ?? undefined, page: { [edge === "header" ? "header_mm" : "footer_mm"]: clamped }, label: edge === "header" ? "header position" : "footer position" }); } catch (e) { this.failed(e); }
  }

  private async moveGuide(axis: "v" | "h", index: number, mm: number | null): Promise<void> {
    const guides = { v: [...(this.model.ext.guides?.v ?? [])], h: [...(this.model.ext.guides?.h ?? [])] };
    const list = guides[axis];
    if (mm === null) list.splice(index, 1); else list[index] = Math.round(mm * 2) / 2;
    try { await this.op({ op: "ext_set", values: { guides: guides.v.length || guides.h.length ? guides : null }, label: "guides" }); } catch (e) { this.failed(e); }
  }

  async addGuides(xMm: number, yMm: number): Promise<void> {
    const guides = { v: [...(this.model.ext.guides?.v ?? []), Math.round(xMm * 2) / 2], h: [...(this.model.ext.guides?.h ?? []), Math.round(yMm * 2) / 2] };
    try { await this.op({ op: "ext_set", values: { guides }, label: "guides" }); } catch (e) { this.failed(e); }
  }

  setCursors(prefs: Prefs, custom: Array<{ id: string; hotspot: number[] }>): void {
    const css = (value: string, fallback: string): string => {
      if (value.startsWith("custom:")) {
        const c = custom.find((x) => `custom:${x.id}` === value);
        if (c) return `url("/api/cursors/${c.id}.png") ${c.hotspot[0] ?? 0} ${c.hotspot[1] ?? 0}, ${fallback}`;
        return fallback;
      }
      return value;
    };
    const root = this.page.el;
    root.style.setProperty("--cur-default", css(prefs.cursor_default, "default"));
    root.style.setProperty("--cur-drag", css(prefs.cursor_drag, "grab"));
    root.style.setProperty("--cur-draw", css(prefs.cursor_draw, "crosshair"));
    root.style.setProperty("--cur-text", css(prefs.cursor_text, "text"));
  }

  setZoom(percent: number): void { this.page.setZoom(percent); this.page.redecorate(); }

  /** Mean millimetre size of the current page, for dialogs. */
  get pageMm(): { w: number; h: number } { const g = this.model.geometry(this.model.list()[0]?.section); return { w: g.widthMm, h: g.heightMm }; }
  get pxPerMm(): number { return MM_PX; }

  newId(): string { return NEW_ID(); }
  isText(id: string): boolean { const b = this.model.block(id); return !!b && TEXT_TYPES.includes(b.type); }
  clean(text: string): string { return cleanInsert(text); }
  lines(text: string): string[] { return splitLines(text); }
  editable(node: Node | null): HTMLElement | null { return editableOf(node); }
}

function referenceText(refs: Reference[] | undefined, id: string): string { const r = refs?.find((x) => x.id === id); return r?.text ?? r?.title ?? ""; }

function listMarkersChanged(wrapper: HTMLElement | undefined, ctx: RenderContext, block: Block): boolean {
  if (!wrapper || block.type !== "list_item") return false;
  const marker = wrapper.querySelector(".marker");
  return !!marker && marker.textContent !== (ctx.markers.get(block.id) ?? "•");
}
