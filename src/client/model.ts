/** The browser's copy of one open document. The server owns the truth; this mirrors it and applies the patches the server returns. */
import { api } from "./net.js";
import { PAGE_MM } from "./textops.js";
import type { Block, CommentThread, DocMeta, DocState, Margins, Op, Patch, Section, Stats, WriterExt } from "./types.js";

/** `headerMm` and `footerMm` are where the header and footer text sit, measured from the top and from the bottom edge of the page. */
export interface PageGeometry { widthMm: number; heightMm: number; margins: Margins; columns: number; section: Section; headerMm: number; footerMm: number }

/** Where header and footer text sit when the document says nothing: in the middle of the margin. */
export const defaultBand = (marginMm: number): number => Math.max(2, marginMm / 2 - 3);

const DEFAULT_MARGIN = 25;

/** The two layers every document has. A block is on the layer of its kind unless the person moved it to one of their own. */
export const BUILT_IN_LAYERS: Array<{ id: string; name: string; what: string }> = [
  { id: "text", name: "Text", what: "paragraphs, headings, lists, tables and equations" },
  { id: "illustrations", name: "Illustrations", what: "pictures" },
];

export interface LayerRow { id: string; name: string; visible: boolean; locked: boolean; custom: boolean; what?: string }

/** Every layer of the document in order: the built-in ones, then the person's own. */
export function layerList(ext: WriterExt): LayerRow[] {
  const saved = ext.layers ?? [];
  const rows: LayerRow[] = BUILT_IN_LAYERS.map((l) => { const s = saved.find((x) => x.id === l.id); return { id: l.id, name: l.name, what: l.what, visible: s?.visible ?? true, locked: s?.locked ?? false, custom: false }; });
  for (const s of saved) if (s.custom && !rows.some((r) => r.id === s.id)) rows.push({ id: s.id, name: s.name, visible: s.visible, locked: s.locked ?? false, custom: true });
  return rows;
}

export function layerOf(block: Block, ext: WriterExt): string {
  const own = ext.layer_of?.[block.id];
  if (own && (BUILT_IN_LAYERS.some((l) => l.id === own) || (ext.layers ?? []).some((l) => l.id === own))) return own;
  return block.type === "figure" ? "illustrations" : "text";
}

export class DocModel {
  sid: string;
  version = 0;
  meta!: DocMeta;
  blocks = new Map<string, Block>();
  order: string[] = [];
  state!: DocState;
  comments: CommentThread[] = [];
  stats!: Stats;

  constructor(state: DocState) { this.sid = state.sid; this.load(state); }

  /** Replace everything with a fresh state from the server (open, reload, restore, merge). */
  load(state: DocState): void {
    this.state = state;
    this.sid = state.sid;
    this.version = state.version;
    this.meta = state.document;
    this.blocks = new Map(state.blocks.map((b) => [b.id, b]));
    this.order = state.blocks.map((b) => b.id);
    this.comments = state.comments;
    this.stats = state.stats;
  }

  list(): Block[] { return this.order.map((id) => this.blocks.get(id)).filter((b): b is Block => b !== undefined); }
  block(id: string): Block | undefined { return this.blocks.get(id); }
  indexOf(id: string): number { return this.order.indexOf(id); }
  get ext(): WriterExt { return ((this.meta.extensions ?? {})["slai.writer"] ?? {}) as WriterExt; }
  get readOnly(): boolean { return this.state.readOnly || !this.state.access.canEdit; }

  /** Merge a server patch. Returns what changed so the view can update only that. */
  applyPatch(patch: Patch): { changed: string[]; removed: string[]; reordered: boolean; documentChanged: boolean } {
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, block] of Object.entries(patch.blocks)) {
      if (block === null) { if (this.blocks.delete(id)) removed.push(id); } else { this.blocks.set(id, block); changed.push(id); }
    }
    let reordered = false;
    if (patch.order) { this.order = patch.order.filter((id) => this.blocks.has(id)); reordered = true; }
    else if (removed.length) this.order = this.order.filter((id) => this.blocks.has(id));
    let documentChanged = false;
    if (patch.document) { this.meta = { ...this.meta, ...patch.document } as DocMeta; documentChanged = true; }
    this.version = patch.version;
    this.stats = patch.stats;
    this.state = { ...this.state, version: patch.version, dirty: patch.dirty, undo: patch.undo, redo: patch.redo, revision: patch.revision, signatures: patch.signatures, notices: patch.notices, stats: patch.stats, document: this.meta };
    return { changed, removed, reordered, documentChanged };
  }

  /** Geometry of the section a block belongs to (or the first section), in millimetres. */
  geometry(sectionId?: string | null): PageGeometry {
    const sections = this.meta.sections ?? [];
    const section = sections.find((s) => s.id === sectionId) ?? sections[0] ?? { id: "s1" };
    const page = section.page ?? {};
    const size = PAGE_MM[page.size ?? "A4"] ?? PAGE_MM["A4"] as [number, number];
    let [w, h] = size;
    if (page.width_mm && page.height_mm) { w = page.width_mm; h = page.height_mm; }
    if (page.orientation === "landscape" && w < h) [w, h] = [h, w];
    const m = page.margins_mm ?? {};
    const margins = { top: m.top ?? DEFAULT_MARGIN, right: m.right ?? DEFAULT_MARGIN, bottom: m.bottom ?? DEFAULT_MARGIN, left: m.left ?? DEFAULT_MARGIN };
    return {
      widthMm: w, heightMm: h, columns: section.columns ?? 1, section, margins,
      headerMm: page.header_mm ?? defaultBand(margins.top), footerMm: page.footer_mm ?? defaultBand(margins.bottom),
    };
  }

  plainText(): string { return this.list().map((b) => b.type === "table" ? (b.table?.rows ?? []).map((r) => r.map((c) => c.text).join("\t")).join("\n") : b.text).join("\n"); }
  headings(): Array<{ id: string; level: number; text: string }> {
    return this.list().filter((b) => b.type === "heading").map((b) => ({ id: b.id, level: b.attributes?.level ?? 1, text: b.text }));
  }
}

/* ------------------------------------------------------------------------------------------ the operation queue */
export class StaleVersion extends Error { constructor() { super("This document changed since your screen last updated."); this.name = "StaleVersion"; } }

export type Sender = <T>(path: string, body: unknown) => Promise<T>;

/** Sends operations one at a time, each tagged with the version the browser last saw, and applies the patch that comes back. */
export class OpQueue {
  private chain: Promise<unknown> = Promise.resolve();
  pending = 0;
  constructor(private readonly model: DocModel, private readonly onPatch: (patch: Patch, op: Op) => void, private readonly onStale: () => void,
              private readonly post: Sender = (path, body) => api.post(path, body)) {}

  send(op: Op): Promise<Patch> {
    this.pending += 1;
    const run = async (): Promise<Patch> => {
      try {
        const patch = await this.post<Patch>(`/docs/${encodeURIComponent(this.model.sid)}/ops`, { op, base: this.model.version });
        this.onPatch(patch, op);
        return patch;
      } catch (error) {
        const details = (error as { details?: { kind?: string } }).details;
        if (details?.kind === "stale_version") this.onStale();
        throw error;
      } finally { this.pending -= 1; }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Run other server work (citations, EMBED apply, AI apply...) in the same order as the edits, so versions never cross. */
  run<T>(work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const go = async (): Promise<T> => { try { return await work(); } finally { this.pending -= 1; } };
    const next = this.chain.then(go, go);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Resolves when everything queued so far has been sent. */
  async idle(): Promise<void> { await this.chain; }
}
