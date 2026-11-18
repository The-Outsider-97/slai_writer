/** Draws the page numbers and leaders of a table of contents in the editing view, with the same engine as the exported pages (`toc_layout.ts`).
 *
 *  An entry is the block's wrapper with its editable `.txt`. The page number and the leader are CSS pseudo-elements of the wrapper (so they are never text, never
 *  selected, never saved); this module measures the entry and sets the custom properties they are drawn from. Three passes keep it to two reflows however many
 *  entries there are: read the frame, the font and the labels; give the text the room the number column takes (so it wraps where the exported page wraps); read where
 *  the first and the last line of the text ended up and place the number and the leader against them. Every length is in the wrapper's own CSS pixels (the zoom
 *  of the page is divided out), so the picture does not depend on the zoom. */
import { leaderGap, leaderMark, MIN_TEXT_PT, PAD_PT, INLINE_GAP_EM, placeEntry, planEntry, type TocLook } from "./toc_layout.js";

const PX_PER_PT = 96 / 72;
let canvas: CanvasRenderingContext2D | null | undefined;

export interface TocEntryInput {
  wrapper: HTMLElement;
  /** The editable text of the entry. */
  text: HTMLElement;
  /** The page number as it is written ("" for none). */
  label: string;
  /** The table the entry belongs to: the numbers of one table share a column. */
  group: string;
  look: TocLook;
}

const PROPS = ["--toc-pl", "--toc-pr", "--toc-nx", "--toc-ny", "--toc-nh", "--toc-lx", "--toc-lw", "--toc-lc", "--toc-ls", "--toc-fs", "--toc-ff", "--toc-fw", "--toc-fst",
  "--toc-color"];

function measurer(): CanvasRenderingContext2D | null {
  if (canvas === undefined) canvas = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  return canvas ?? null;
}

/** Removes everything this module set on an entry. */
export function clearTocEntry(wrapper: HTMLElement): void {
  for (const name of PROPS) wrapper.style.removeProperty(name);
  for (const name of ["tocPainted", "tocLeaderKind", "tocPage"]) delete wrapper.dataset[name];
}

interface Measured {
  item: TocEntryInput; k: number; width: number; indent: number; rightIndent: number; padLeft: number; fontPx: number; font: string; style: CSSStyleDeclaration;
  numberW: number; markW: number;
}

function lineEnds(text: HTMLElement, k: number, left0: number, top0: number): { first: [number, number]; last: [number, number]; firstTop: number; firstH: number; lastTop: number; lastH: number } | null {
  const range = document.createRange();
  range.selectNodeContents(text);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const topOf = (r: DOMRect): number => r.top;
  const minTop = Math.min(...rects.map(topOf)), maxTop = Math.max(...rects.map(topOf));
  const tolerance = 2 * k;
  const on = (top: number): DOMRect[] => rects.filter((r) => Math.abs(r.top - top) <= tolerance);
  const first = on(minTop), last = on(maxTop);
  const span = (rs: DOMRect[]): [number, number] => [(Math.min(...rs.map((r) => r.left)) - left0) / k, (Math.max(...rs.map((r) => r.right)) - left0) / k];
  const tall = (rs: DOMRect[]): number => Math.max(...rs.map((r) => r.height)) / k;
  return { first: span(first), last: span(last), firstTop: (minTop - top0) / k, firstH: tall(first), lastTop: (maxTop - top0) / k, lastH: tall(last) };
}

/** Lays out the page numbers and leaders of these entries. */
export function paintTocEntries(items: TocEntryInput[]): void {
  const ctx = measurer();
  const live: Measured[] = [];
  for (const item of items) {
    // the entry as it would be with nothing reserved for the number: that is the frame the engine plans against
    item.wrapper.style.removeProperty("--toc-pl");
    item.wrapper.style.removeProperty("--toc-pr");
  }
  // pass 1: read
  const widest = new Map<string, number>();
  for (const item of items) {
    if (!item.label || item.look.position === "hidden" || !ctx || !item.text.isConnected) continue;
    const style = getComputedStyle(item.text);
    const rect = item.wrapper.getBoundingClientRect();
    const k = item.wrapper.offsetWidth > 0 && rect.width > 0 ? rect.width / item.wrapper.offsetWidth : 1;
    const wrapperStyle = getComputedStyle(item.wrapper);
    const padLeft = parseFloat(wrapperStyle.paddingLeft) || 0;
    const padRight = parseFloat(wrapperStyle.paddingRight) || 0;
    const width = item.wrapper.clientWidth - padLeft - padRight;
    const textRect = item.text.getBoundingClientRect();
    const border = parseFloat(wrapperStyle.borderLeftWidth) || 0;
    // where the paragraph's own text begins and ends inside the frame (its indent is the padding the renderer gives the text, so it counts)
    const indent = (textRect.left - rect.left) / k + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0) - padLeft - border;
    const rightIndent = Math.max(0, width - ((textRect.right - rect.left) / k - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0) - padLeft - border));
    const fontPx = parseFloat(style.fontSize) || 16;
    const font = `${style.fontStyle} ${style.fontWeight} ${fontPx}px ${style.fontFamily}`;
    ctx.font = font;
    const numberW = ctx.measureText(item.label).width;
    const mark = leaderMark(item.look);
    const markW = mark ? ctx.measureText(mark).width : 0;
    widest.set(item.group, Math.max(widest.get(item.group) ?? 0, numberW));
    live.push({ item, k, width, indent: Math.max(0, indent), rightIndent, padLeft, fontPx, font, style, numberW, markW });
  }
  for (const item of items) if (!live.some((m) => m.item === item)) {
    clearTocEntry(item.wrapper);
    if (item.label && item.look.position !== "hidden") item.wrapper.dataset["tocPage"] = item.label;
  }
  // pass 2: the text gives up the room the column takes, so it wraps where the exported page wraps
  const planned = live.map((m) => {
    const look: TocLook = { ...m.item.look, custom_tab_pt: m.item.look.custom_tab_pt === null ? null : m.item.look.custom_tab_pt * PX_PER_PT,
      number_column_pt: m.item.look.number_column_pt === null ? null : m.item.look.number_column_pt * PX_PER_PT };
    const columnW = look.number_column_pt ?? widest.get(m.item.group) ?? m.numberW;
    const inlineGap = INLINE_GAP_EM * m.fontPx;
    const plan = planEntry(look, m.width, m.indent, m.rightIndent, columnW, m.numberW, inlineGap, PAD_PT * PX_PER_PT, MIN_TEXT_PT * PX_PER_PT);
    return { m, look, plan, inlineGap };
  });
  for (const { m, plan } of planned) {
    const { wrapper } = m.item;
    wrapper.dataset["tocPainted"] = "";
    wrapper.dataset["tocPage"] = m.item.label;
    wrapper.style.setProperty("--toc-pl", `${Math.max(0, plan.text[0] - m.indent)}px`);
    wrapper.style.setProperty("--toc-pr", `${Math.max(0, m.width - m.rightIndent - plan.text[1])}px`);
    wrapper.style.setProperty("--toc-fs", `${m.fontPx}px`);
    wrapper.style.setProperty("--toc-ff", m.style.fontFamily);
    wrapper.style.setProperty("--toc-fw", m.style.fontWeight);
    wrapper.style.setProperty("--toc-fst", m.style.fontStyle);
    wrapper.style.setProperty("--toc-color", m.style.color);
  }
  // pass 3: place the number and the leader against where the lines ended up
  const placed = planned.map(({ m, look, plan, inlineGap }) => {
    const rect = m.item.wrapper.getBoundingClientRect();
    const wrapperStyle = getComputedStyle(m.item.wrapper);
    const border = parseFloat(wrapperStyle.borderLeftWidth) || 0, borderTop = parseFloat(wrapperStyle.borderTopWidth) || 0;
    const left0 = rect.left + (border + m.padLeft) * m.k, top0 = rect.top + borderTop * m.k;
    return { m, look, plan, inlineGap, lines: lineEnds(m.item.text, m.k, left0, top0) };
  });
  for (const { m, look, plan, inlineGap, lines } of placed) {
    const { wrapper } = m.item;
    if (!lines) { clearTocEntry(wrapper); continue; }
    const numberOnFirstLine = look.position === "left";
    const where = placeEntry(look, plan, m.numberW, lines.first, lines.last, m.markW, leaderGap(m.item.look, m.fontPx / PX_PER_PT) * PX_PER_PT, inlineGap, PAD_PT * PX_PER_PT);
    const top = numberOnFirstLine ? lines.firstTop : lines.lastTop, height = numberOnFirstLine ? lines.firstH : lines.lastH;
    wrapper.style.setProperty("--toc-ny", `${top}px`);
    wrapper.style.setProperty("--toc-nh", `${height}px`);
    wrapper.style.setProperty("--toc-nx", `${(where.number_x ?? 0) + m.padLeft}px`);
    const leader = where.leader;
    if (!leader) {
      wrapper.dataset["tocLeaderKind"] = "none";
      for (const name of ["--toc-lx", "--toc-lw", "--toc-lc", "--toc-ls"]) wrapper.style.removeProperty(name);
      continue;
    }
    wrapper.dataset["tocLeaderKind"] = leader.kind;
    wrapper.style.setProperty("--toc-lx", `${leader.x0 + m.padLeft}px`);
    if ("count" in leader) {
      const mark = leaderMark(look);
      wrapper.style.setProperty("--toc-lc", `"${mark.replace(/["\\]/g, "\\$&").repeat(leader.count)}"`);
      wrapper.style.setProperty("--toc-ls", `${leader.pitch - leader.mark_w}px`);
      wrapper.style.setProperty("--toc-lw", `${leader.count * leader.pitch}px`);
    } else {
      wrapper.style.removeProperty("--toc-lc");
      wrapper.style.removeProperty("--toc-ls");
      wrapper.style.setProperty("--toc-lw", `${leader.x1 - leader.x0}px`);
    }
  }
}
