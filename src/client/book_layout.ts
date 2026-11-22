/** Mirrored margins and the binding gutter, as the editor needs them. Nothing here touches the DOM.
 *
 *  The same arithmetic is in the server (book.py) and in the export writers (Documaster); applications/slai_writer/tests/fixtures/margin_cases.json holds the
 *  cases all three are tested against.
 *
 *  A page's side is decided by its position in the document (the first page, and every odd one, is a right-hand page), never by the number printed on it. */
import type { BookLayout, DocMeta, HeaderFooter, Margins, WriterExt } from "./types.js";

export const DEFAULT_MARGIN = 25;
/** The least room a page must keep for text, in millimetres, in each direction. */
export const MIN_CONTENT = 25;

export function bookOf(meta: DocMeta, sectionId: string | undefined): BookLayout | undefined {
  const ext = ((meta.extensions ?? {})["slai.writer"] ?? {}) as WriterExt;
  return sectionId ? ext.book_layouts?.[sectionId] : undefined;
}

export const isMirrored = (book: BookLayout | undefined): boolean => book?.mirror === true;

/** The header or footer a page shows. A right-hand (odd) page shows the ordinary one. A left-hand (even) page shows its own text when the section has odd and
 *  even pages with text for that band (in the typography of the same position on the ordinary band); otherwise the ordinary one, with its left and right
 *  swapped in a mirrored section so the page number stays on the outer edge. Same rule as Documaster's `even_page_template`. */
export function runningBand(edge: "header" | "footer", ordinary: HeaderFooter | undefined, book: BookLayout | undefined, physical: number): { spec: HeaderFooter | undefined; flipped: boolean } {
  if (physical % 2 === 1) return { spec: ordinary, flipped: false };
  const own = book?.odd_even === true ? book[edge === "header" ? "header_even" : "footer_even"] : undefined;
  if (own && (own.left || own.center || own.right)) {
    const spec: HeaderFooter = {};
    for (const position of ["left", "center", "right"] as const) if (own[position]) spec[position] = own[position]!;
    if (ordinary?.formats) spec.formats = ordinary.formats;
    return { spec, flipped: false };
  }
  return { spec: ordinary, flipped: isMirrored(book) && book?.mirror_edges !== false };
}

/** Does any section of the document mirror its margins? Then the pages are a book: the first one is a lone right-hand page. */
export function documentIsBook(meta: DocMeta): boolean {
  const ext = ((meta.extensions ?? {})["slai.writer"] ?? {}) as WriterExt;
  return Object.values(ext.book_layouts ?? {}).some((b) => b?.mirror === true);
}

export const sideOfPage = (physical: number): "right" | "left" => (physical % 2 === 1 ? "right" : "left");

/** The margins a page really has: ``left`` and ``right`` are the physical sides of that page, the gutter included once. `physical` is 1-based. */
export function effectiveMargins(stored: Margins, book: BookLayout | undefined, physical: number): Margins {
  const gutter = Math.max(0, book?.gutter_mm ?? 0);
  const position = book?.gutter_position ?? "left";
  let { top, bottom, left, right } = stored;
  if (isMirrored(book)) {
    const inside = left + (position === "top" ? 0 : gutter);
    const outside = right;
    if (physical % 2 === 1) { left = inside; right = outside; } else { left = outside; right = inside; }
  } else if (position === "right") right += gutter;
  else if (position === "left") left += gutter;
  if (position === "top") top += gutter;
  return { top, bottom, left, right };
}

/** The setting that a dragged margin line stands for: which stored margin changes, and to what value, when the line of the page at `physical` is put at `mm`. */
export function storedFromLine(stored: Margins, book: BookLayout | undefined, physical: number, side: "left" | "right", mm: number): { key: "left" | "right"; value: number } {
  const gutter = Math.max(0, book?.gutter_mm ?? 0);
  const position = book?.gutter_position ?? "left";
  if (isMirrored(book)) {
    const rightHand = physical % 2 === 1;
    const insideSide = rightHand ? "left" : "right";
    if (side === insideSide) return { key: "left", value: Math.max(0, mm - (position === "top" ? 0 : gutter)) };    // the inside is stored as the left margin
    return { key: "right", value: Math.max(0, mm) };
  }
  const extra = side === "left" ? (position === "left" ? gutter : 0) : (position === "right" ? gutter : 0);
  void stored;
  return { key: side, value: Math.max(0, mm - extra) };
}

/** What the two vertical margin lines of a page are called. */
export function lineNames(book: BookLayout | undefined, physical: number): { left: string; right: string } {
  if (!isMirrored(book)) return { left: "Left margin", right: "Right margin" };
  return physical % 2 === 1 ? { left: "Inside margin", right: "Outside margin" } : { left: "Outside margin", right: "Inside margin" };
}

/** The width and height left for text. They are the same on every page of a section, whichever side the page is on. */
export function contentSize(widthMm: number, heightMm: number, stored: Margins, book: BookLayout | undefined): { width: number; height: number } {
  const m = effectiveMargins(stored, book, 1);
  return { width: widthMm - m.left - m.right, height: heightMm - m.top - m.bottom };
}

/** A reason a layout cannot be used, or null. */
export function problem(widthMm: number, heightMm: number, stored: Margins, book: BookLayout | undefined): string | null {
  const values = [widthMm, heightMm, ...Object.values(stored), book?.gutter_mm ?? 0];
  if (!values.every((v) => Number.isFinite(v) && v >= 0)) return "Enter valid, non-negative numbers.";
  if ((book?.gutter_mm ?? 0) > 100) return "The gutter is at most 100 mm.";
  const c = contentSize(widthMm, heightMm, stored, book);
  if (c.width < MIN_CONTENT || c.height < MIN_CONTENT) return `The margins and the gutter leave less than ${MIN_CONTENT} mm for text. Make them smaller.`;
  return null;
}
