/** Highlights drawn over the text without touching the DOM (CSS Custom Highlight API): search results (green), typos (transparent red),
 *  grammar (transparent orange), the person's own notes (pastel blue) and comment anchors. Ranges are kept in model offsets and
 *  re-resolved after every re-render, so they follow edits. Browsers without the API simply show no highlight; the lists still work. */
import { rangeFor } from "./domtext.js";

export type HighlightKind = "search" | "search-current" | "typo" | "grammar" | "note" | "comment";
export interface Mark { block: string; start: number; end: number; id?: string }

interface Registry { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): Registry | null { return (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights ?? null; }
function ctor(): HighlightCtor | null { return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null; }

export function highlightsSupported(): boolean { return registry() !== null && ctor() !== null; }

export class Decor {
  private marks = new Map<HighlightKind, Mark[]>();
  constructor(private readonly textOf: (block: string) => HTMLElement | null) {}

  set(kind: HighlightKind, marks: Mark[]): void { this.marks.set(kind, marks); this.paint(kind); }
  get(kind: HighlightKind): Mark[] { return this.marks.get(kind) ?? []; }
  clear(kind?: HighlightKind): void {
    if (kind) { this.marks.delete(kind); registry()?.delete(`w-${kind}`); return; }
    for (const k of [...this.marks.keys()]) this.clear(k);
  }

  /** Re-resolve every range against the current DOM (after a render or a pagination pass). */
  refresh(): void { for (const kind of this.marks.keys()) this.paint(kind); }

  /** The mark touching a text position (for hovering a typo or a note). */
  at(kind: HighlightKind, block: string, offset: number): Mark | undefined {
    return this.get(kind).find((m) => m.block === block && offset >= m.start && offset <= m.end);
  }

  private paint(kind: HighlightKind): void {
    const reg = registry();
    const Highlight = ctor();
    if (!reg || !Highlight) return;
    const ranges: Range[] = [];
    for (const m of this.marks.get(kind) ?? []) {
      const el = this.textOf(m.block);
      if (!el) continue;
      try { ranges.push(rangeFor(el, m.start, m.end)); } catch { /* the text moved on; the next refresh drops it */ }
    }
    if (ranges.length) reg.set(`w-${kind}`, new Highlight(...ranges)); else reg.delete(`w-${kind}`);
  }
}
