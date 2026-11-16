/** Everything the Contents group of the References tab does: one server call each (the existing /contents routes), so it is one undo step, saved and exported. */
import type { Editor } from "./editor.js";
import { toast } from "./kit.js";
import { api, errorText } from "./net.js";
import { tocCoverAnchor } from "./toc_position.js";
import type { Block, DocState, Patch } from "./types.js";

export const TOC_KEY = "slai.sldc.toc";
export const TOC_STYLE_KEY = "slai.writer.toc_style";

export interface TocCore { id: string; role: "title" | "entry"; depth: number; preset?: string; show_page_numbers?: boolean; leader_dots?: boolean; refresh_mode?: "automatic" | "manual"; heading?: string; level?: number }
export interface TocLook { preset: string; leader: "dots" | "dashes" | "solid" | "none"; page_align: "right" | "inline" | "left"; hyperlinks: boolean; numbered: boolean }
export interface TocInfo { id: string; title: Block; entries: Block[]; core: TocCore; look: TocLook }
export interface TocLookRequest { preset?: string; leader?: string; page_align?: string; hyperlinks?: boolean; numbered?: boolean; levels?: Record<string, Record<string, unknown>>; title?: Record<string, unknown> }

/** The managed tables of contents of the document. */
export function allTocs(ed: Editor): TocInfo[] {
  const found = new Map<string, TocInfo>();
  for (const block of ed.model.list()) {
    const core = block.extensions?.[TOC_KEY] as TocCore | undefined;
    if (!core?.id) continue;
    let info = found.get(core.id);
    if (core.role === "title") {
      const stored = (block.extensions?.[TOC_STYLE_KEY] ?? {}) as Partial<TocLook>;
      const look: TocLook = {
        preset: stored.preset ?? "custom", leader: stored.leader ?? (core.leader_dots === false ? "none" : "dots"), page_align: stored.page_align ?? "right",
        hyperlinks: stored.hyperlinks ?? true, numbered: stored.numbered ?? false,
      };
      info = { id: core.id, title: block, entries: info?.entries ?? [], core, look };
      found.set(core.id, info);
    } else if (info) info.entries.push(block);
    else found.set(core.id, { id: core.id, title: block, entries: [block], core, look: { preset: "custom", leader: "dots", page_align: "right", hyperlinks: true, numbered: false } });
  }
  return [...found.values()].filter((t) => t.core.role === "title");
}

/** The table the caret is in, or the only table of the document. */
export function tocTarget(ed: Editor): TocInfo | null {
  const tocs = allTocs(ed);
  const caret = ed.recallSelection()?.start.block;
  const inside = caret ? ed.model.block(caret)?.extensions?.[TOC_KEY] as TocCore | undefined : undefined;
  return (inside ? tocs.find((t) => t.id === inside.id) : undefined) ?? (tocs.length === 1 ? tocs[0] ?? null : null);
}

interface Reply { patch?: Patch; tocId?: string; heading?: string }

async function call(ed: Editor, work: () => Promise<Reply>, done: string): Promise<Reply | null> {
  if (ed.readOnly) { toast("This document is read-only.", { kind: "info" }); return null; }
  try {
    const result = await ed.call(work, (r) => r.patch);
    toast(done, { kind: "ok" });
    return result;
  } catch (error) {
    if ((error as { details?: { kind?: string } }).details?.kind !== "stale_version") toast(errorText(error), { kind: "error" });
    return null;
  }
}

const base = (ed: Editor): string => `/docs/${encodeURIComponent(ed.sid)}/contents`;

export async function insertToc(ed: Editor, look: TocLookRequest, options: { title?: string; depth?: number } = {}): Promise<boolean> {
  const caret = ed.recallSelection()?.end.block ?? null;
  const after = caret ?? tocCoverAnchor(ed.model.list(), ed.model.meta.sections ?? []);
  const result = await call(ed, () => api.post<Reply>(base(ed), { after, title: options.title ?? "Contents", depth: options.depth ?? 3, look }), "Table of contents inserted.");
  if (result?.heading) ed.focusBlock(result.heading, 0);
  return result !== null;
}

/** Bring one table up to date; `look` changes how it looks (style, options, formatting) in the same step. */
export async function updateToc(ed: Editor, id: string, body: Record<string, unknown> = {}, done = "Table of contents updated."): Promise<boolean> {
  return (await call(ed, () => api.post<Reply>(`${base(ed)}/${encodeURIComponent(id)}/refresh`, body), done)) !== null;
}

/** Page numbers are measured from the exact layout, never stored: measuring again (and redrawing them) is all it takes. */
export function updatePageNumbers(ed: Editor): void {
  ed.schedulePrintLayout();
  toast("Page numbers are being measured again.", { kind: "info" });
}

export async function removeToc(ed: Editor, id: string): Promise<boolean> {
  if (ed.readOnly) { toast("This document is read-only.", { kind: "info" }); return false; }
  try {
    const result = await ed.call(() => api.post<{ state: DocState }>(`${base(ed)}/${encodeURIComponent(id)}/remove`, {}));
    await ed.resync(result.state);
    toast("Table of contents removed. Your headings are unchanged.", { kind: "ok" });
    return true;
  } catch (error) {
    if ((error as { details?: { kind?: string } }).details?.kind !== "stale_version") toast(errorText(error), { kind: "error" });
    return false;
  }
}
