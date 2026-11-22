/** Shapes in headers and footers: which shapes a page shows and where they are drawn. Nothing here touches the DOM.
 *
 *  A header or footer is a definition that every page using it repeats; its shapes belong to that definition (stored in ``slai.writer.band_shapes``, see
 *  ``applications/slai_writer/bands.py``). The arithmetic below is a port of that module, tied to it by ``tests/fixtures/band_shapes_golden.json``: the editor puts a
 *  shape where the PDF and Word writers of Documaster put it. */
import type { ShapeData } from "./shape.js";
import type { BookLayout, DocMeta, WriterExt } from "./types.js";

export const BAND_KEY = "band_shapes";
export type BandEdge = "header" | "footer";
export type BandVariant = "default" | "even" | "first";
export const BAND_EDGES: readonly BandEdge[] = ["header", "footer"];
export const BAND_VARIANTS: readonly BandVariant[] = ["default", "even", "first"];
export type BandLayer = "behind" | "front";
export const MAX_BAND_ITEMS = 40;

export interface BandItem { id: string; shape: ShapeData; x_mm: number; y_mm: number; layer: BandLayer; locked: boolean; span: boolean; name?: string }
export interface BandEntry {
  header?: Partial<Record<BandVariant, BandItem[]>>; footer?: Partial<Record<BandVariant, BandItem[]>>;
  first_page?: boolean; link?: Partial<Record<BandEdge, boolean>>;
}
export type BandStore = Record<string, BandEntry>;

/** The part of a document these functions read: its sections (in order) and Writer's extension. */
export interface BandDoc { sections?: Array<{ id: string }>; extensions?: Record<string, unknown> }

const ext = (doc: BandDoc | DocMeta): WriterExt & { band_shapes?: BandStore } => (((doc.extensions ?? {})["slai.writer"]) ?? {}) as WriterExt & { band_shapes?: BandStore };
export const storeOf = (doc: BandDoc | DocMeta): BandStore => ext(doc).band_shapes ?? {};
const bookOf = (doc: BandDoc | DocMeta, section: string): BookLayout => ext(doc).book_layouts?.[section] ?? {};

/** The section whose definition of ``edge`` this section shows: itself, or, while it is linked to the previous one, whoever that one shows. */
export function ownerOf(doc: BandDoc | DocMeta, section: string, edge: BandEdge): string {
  const ids = (doc.sections ?? []).map((s) => s.id);
  const store = storeOf(doc);
  let at = ids.includes(section) ? ids.indexOf(section) : 0;
  while (at > 0 && store[ids[at] as string]?.link?.[edge]) at -= 1;
  return ids[at] ?? section;
}

export function itemsOf(doc: BandDoc | DocMeta, section: string, edge: BandEdge, variant: BandVariant): BandItem[] {
  return [...(storeOf(doc)[ownerOf(doc, section, edge)]?.[edge]?.[variant] ?? [])];
}

/** Which list a page shows: the section's first page its own (when asked for), a left-hand page its own when the section has odd and even pages. */
export function variantFor(doc: BandDoc | DocMeta, section: string, physical: number, firstOfSection: boolean): BandVariant {
  if (storeOf(doc)[section]?.first_page && firstOfSection) return "first";
  if (physical % 2 === 0 && bookOf(doc, section).odd_even === true) return "even";
  return "default";
}

export interface PageShapes { items: BandItem[]; variant: BandVariant; mirrored: boolean }
/** The shapes a page shows in its header or footer, the variant they come from and whether the page draws them from the other side (a left-hand page of a book
 *  whose edges are swapped shows the ordinary list mirrored). */
export function shapesForPage(doc: BandDoc | DocMeta, section: string, edge: BandEdge, physical: number, firstOfSection: boolean): PageShapes {
  let variant = variantFor(doc, section, physical, firstOfSection);
  let items = itemsOf(doc, section, edge, variant);
  const book = bookOf(doc, section);
  let mirrored = false;
  if (variant === "even" && !items.length) { variant = "default"; items = itemsOf(doc, section, edge, "default"); }
  if (physical % 2 === 0 && variant === "default" && book.mirror === true && book.mirror_edges !== false) mirrored = true;
  return { items, variant, mirrored };
}

/** Where a shape's box is on its page, in millimetres from the top-left corner (the box before it is turned; the shape turns about its centre). */
export function placeBand(item: BandItem, edge: BandEdge, pageW: number, pageH: number, left: number, right: number, mirrored = false): { x: number; y: number; w: number; h: number } {
  const frame = pageW - left - right;
  const h = Number(item.shape.height_mm);
  let w: number;
  let x: number;
  if (item.span) { w = frame; x = left; }
  else {
    w = Number(item.shape.width_mm);
    x = mirrored ? left + frame - Number(item.x_mm) - w : left + Number(item.x_mm);
  }
  const y = edge === "header" ? Number(item.y_mm) : pageH - Number(item.y_mm) - h;
  return { x, y, w, h };
}

/** The inverse of ``placeBand`` for one shape: the stored ``x_mm`` and ``y_mm`` that put the shape's box at (``x``, ``y``) of the page. */
export function storedFromBox(item: Pick<BandItem, "shape" | "span">, edge: BandEdge, x: number, y: number, pageW: number, pageH: number, left: number, right: number, mirrored = false): { x_mm: number; y_mm: number } {
  const frame = pageW - left - right;
  const w = item.span ? frame : Number(item.shape.width_mm);
  const h = Number(item.shape.height_mm);
  const x_mm = mirrored ? left + frame - x - w : x - left;
  const y_mm = edge === "header" ? y : pageH - y - h;
  return { x_mm: Math.round(x_mm * 100) / 100, y_mm: Math.round(y_mm * 100) / 100 };
}

/** The ``section`` and ``variant`` the editor must send in an operation to change what a page shows (the op layer resolves linked sections to their owner). */
export function targetOf(doc: BandDoc | DocMeta, section: string, edge: BandEdge, physical: number, firstOfSection: boolean): { section: string; edge: BandEdge; variant: BandVariant } {
  const { variant } = shapesForPage(doc, section, edge, physical, firstOfSection);
  return { section, edge, variant };
}

/** A new id for a shape of a header or footer: unique across the whole document. */
export function newBandId(doc: BandDoc | DocMeta): string {
  const used = new Set<string>();
  for (const entry of Object.values(storeOf(doc))) for (const edge of BAND_EDGES) for (const list of Object.values(entry[edge] ?? {})) for (const item of list ?? []) used.add(item.id);
  for (;;) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const id = "bs_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    if (!used.has(id)) return id;
  }
}
