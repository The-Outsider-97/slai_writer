/** Text boxes: a rectangle shape whose text is a list of styled paragraphs (SLDC extension `slai.writer.shape`, field `textbox`, version 1).
 *
 * This file holds everything that does not need the live editor: the data types, painting the paragraphs, the small rich-text model that
 * editing and the ribbon work on (lines of formatted runs), converting between that model and the DOM, and the presets.
 * No HTML from a document is ever interpreted: paragraphs are built with createElement/textContent and styled through the CSSOM.
 */
import type { Span } from "./types.js";
import type { ShapeData } from "./shape.js";
import { segments, MM_PX } from "./textops.js";

export type TextBoxRole = "normal" | "heading1" | "heading2" | "heading3" | "quote";
export type TextBoxAlign = "left" | "center" | "right" | "justify";
export interface TextBoxParagraph {
  text: string; role?: TextBoxRole; style?: string; align?: TextBoxAlign; list?: "none" | "bullet" | "number";
  spans?: Span[]; line_height?: number; space_after_pt?: number;
}
export interface TextBoxData {
  version: 1; paragraphs: TextBoxParagraph[]; vertical_align?: "top" | "middle" | "bottom";
  auto_expand?: boolean; pinned?: boolean; locked?: boolean; name?: string;
}
/** Applies a named document paragraph style (the same definitions the page uses) to an element. */
export type ParagraphStyler = (el: HTMLElement, name: string) => void;

/** Heading sizes relative to the box's text size; the export painter (shape_export.ROLE_SCALE) uses the same ratios. */
export const TEXTBOX_ROLE_SCALE: Record<string, number> = { heading1: 1.8, heading2: 1.45, heading3: 1.2 };
export const TEXTBOX_MIN_MM = { width: 10, height: 6 } as const;
export const TEXTBOX_ROLES: ReadonlyArray<readonly [TextBoxRole, string]> = [
  ["normal", "Normal"], ["heading1", "Heading 1"], ["heading2", "Heading 2"], ["heading3", "Heading 3"], ["quote", "Quote"],
];

export function textBoxOf(shape: ShapeData | null | undefined): TextBoxData | null {
  const box = shape?.textbox;
  return box && box.version === 1 && Array.isArray(box.paragraphs) && box.paragraphs.length > 0 ? box : null;
}
export const isLocked = (shape: ShapeData | null | undefined): boolean => Boolean(textBoxOf(shape)?.locked);
export const isPinned = (shape: ShapeData | null | undefined): boolean => Boolean(textBoxOf(shape)?.pinned);

/* ----------------------------------------------------------------------------------------------------------- painting */

const FONT_SAFE = /^[^\x00-\x1f\x7f{};<>\\"'`]{1,100}$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

function runNode(text: string, seg: ReturnType<typeof segments>[number]): Node {
  let node: Node = document.createTextNode(text);
  const wrap = (el: HTMLElement): HTMLElement => { el.appendChild(node); node = el; return el; };
  const f = seg.flags;
  if (f.bold) wrap(document.createElement("strong"));
  if (f.italic) wrap(document.createElement("em"));
  if (f.underline) wrap(document.createElement("u"));
  if (f.strike) wrap(document.createElement("s"));
  if (f.superscript) wrap(document.createElement("sup"));
  if (f.subscript) wrap(document.createElement("sub"));
  if (seg.color || seg.background || seg.font_family || seg.font_size_pt || seg.letter_spacing_pt !== undefined || seg.word_spacing_pt !== undefined) {
    const el = wrap(document.createElement("span"));
    if (seg.color && COLOUR.test(seg.color)) el.style.color = seg.color;
    if (seg.background && COLOUR.test(seg.background)) el.style.backgroundColor = seg.background;
    if (seg.font_family && FONT_SAFE.test(seg.font_family)) el.style.fontFamily = `"${seg.font_family}", serif`;
    if (typeof seg.font_size_pt === "number" && seg.font_size_pt >= 4 && seg.font_size_pt <= 400) el.style.fontSize = `${seg.font_size_pt}pt`;
    if (typeof seg.letter_spacing_pt === "number") el.style.letterSpacing = `${seg.letter_spacing_pt}pt`;
    if (typeof seg.word_spacing_pt === "number") el.style.wordSpacing = `${seg.word_spacing_pt}pt`;
  }
  return node;
}

/** One paragraph as an element; `base` is the box's text size, which headings scale. */
export function paragraphElement(para: TextBoxParagraph, shape: ShapeData, styler?: ParagraphStyler): HTMLElement {
  const p = document.createElement("p");
  p.className = "tb-para";
  const role = para.role ?? "normal";
  p.dataset["role"] = role;
  if (para.style) p.dataset["style"] = para.style;
  if (para.align) p.dataset["align"] = para.align;
  if (para.list && para.list !== "none") p.dataset["list"] = para.list;
  if (para.line_height !== undefined) p.dataset["lineHeight"] = String(para.line_height);
  if (para.space_after_pt !== undefined) p.dataset["spaceAfter"] = String(para.space_after_pt);
  const scale = TEXTBOX_ROLE_SCALE[role];
  if (scale) { p.style.fontSize = `${shape.text.font_size_pt * scale}pt`; p.style.fontWeight = "700"; p.style.marginBottom = "0.3em"; }
  if (role === "quote") { p.style.fontStyle = "italic"; p.style.paddingLeft = "4mm"; p.style.borderLeft = "0.7mm solid currentColor"; }
  if (para.style && styler) styler(p, para.style);
  if (para.align) p.style.textAlign = para.align;
  if (para.line_height !== undefined) p.style.lineHeight = String(para.line_height);
  if (para.space_after_pt !== undefined) p.style.marginBottom = `${para.space_after_pt}pt`;
  const segs = segments({ text: para.text, spans: para.spans ?? [] });
  if (!segs.length) p.appendChild(document.createElement("br"));
  for (const seg of segs) p.appendChild(runNode(seg.text, seg));
  return p;
}

/** The text area of a text box: padding, vertical alignment and the paragraphs. It never carries selection chrome. */
export function paintTextBoxBody(shape: ShapeData, box: TextBoxData, styler?: ParagraphStyler): HTMLElement {
  const body = document.createElement("div");
  body.className = "tb-body";
  body.style.padding = `${shape.text.padding_mm}mm`;
  body.style.fontSize = `${shape.text.font_size_pt}pt`;
  body.style.color = shape.text.color;
  if (shape.text.bold) body.style.fontWeight = "700";
  if (shape.text.italic) body.style.fontStyle = "italic";
  body.style.textAlign = shape.text.align;
  if (shape.text.font_family && FONT_SAFE.test(shape.text.font_family)) body.style.fontFamily = `"${shape.text.font_family}", serif`;
  body.style.justifyContent = box.vertical_align === "bottom" ? "flex-end" : box.vertical_align === "middle" ? "center" : "flex-start";
  body.dataset["empty"] = String(box.paragraphs.length === 1 && !box.paragraphs[0]?.text);
  for (const para of box.paragraphs) body.appendChild(paragraphElement(para, shape, styler));
  return body;
}

/** Height the text needs, in millimetres, or null when it cannot be measured (the box is not on screen). */
export function neededHeightMm(host: HTMLElement): number | null {
  const body = host.querySelector<HTMLElement>(".tb-body");
  if (!body || !body.isConnected || body.clientHeight === 0) return null;
  const saved = body.style.justifyContent;
  const need = Array.from(body.children).reduce((sum, child) => sum + (child as HTMLElement).offsetHeight
    + parseFloat(getComputedStyle(child).marginBottom || "0") + parseFloat(getComputedStyle(child).marginTop || "0"), 0);
  body.style.justifyContent = saved;
  const cs = getComputedStyle(body);
  return (need + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) / MM_PX;
}

/* ------------------------------------------------------------------------------------------------ the rich-text model */

export interface Fmt {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; superscript?: boolean; subscript?: boolean;
  color?: string; background?: string; font_family?: string; font_size_pt?: number; letter_spacing_pt?: number; word_spacing_pt?: number;
}
export interface Run { text: string; fmt: Fmt }
export interface Attrs { role?: TextBoxRole; style?: string; align?: TextBoxAlign; list?: "none" | "bullet" | "number"; line_height?: number; space_after_pt?: number }
export interface Line { attrs: Attrs; runs: Run[] }
export interface Pos { p: number; o: number }

const FMT_KEYS = ["bold", "italic", "underline", "strike", "superscript", "subscript", "color", "background", "font_family", "font_size_pt", "letter_spacing_pt", "word_spacing_pt"] as const;
const sameFmt = (a: Fmt, b: Fmt): boolean => FMT_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined));
const clean = (fmt: Fmt): Fmt => { const out: Fmt = {}; for (const k of FMT_KEYS) if (fmt[k] !== undefined && fmt[k] !== false) (out as Record<string, unknown>)[k] = fmt[k]; return out; };

export function lineText(line: Line): string { return line.runs.map((r) => r.text).join(""); }
export function lineLength(line: Line): number { return line.runs.reduce((n, r) => n + r.text.length, 0); }

export function toLines(paragraphs: readonly TextBoxParagraph[]): Line[] {
  return paragraphs.map((para) => {
    const attrs: Attrs = {};
    if (para.role && para.role !== "normal") attrs.role = para.role;
    if (para.style) attrs.style = para.style;
    if (para.align) attrs.align = para.align;
    if (para.list && para.list !== "none") attrs.list = para.list;
    if (para.line_height !== undefined) attrs.line_height = para.line_height;
    if (para.space_after_pt !== undefined) attrs.space_after_pt = para.space_after_pt;
    const runs: Run[] = [];
    for (const seg of segments({ text: para.text, spans: para.spans ?? [] })) {
      const fmt: Fmt = clean({ ...seg.flags, color: seg.color, background: seg.background, font_family: seg.font_family, font_size_pt: seg.font_size_pt,
        letter_spacing_pt: seg.letter_spacing_pt, word_spacing_pt: seg.word_spacing_pt } as Fmt);
      delete (fmt as Record<string, unknown>)["code"];
      runs.push({ text: seg.text, fmt });
    }
    return { attrs, runs };
  });
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameFmt(last.fmt, run.fmt)) last.text += run.text; else out.push({ text: run.text, fmt: { ...run.fmt } });
  }
  return out;
}

export function fromLines(lines: readonly Line[]): TextBoxParagraph[] {
  const out = lines.map((line) => {
    const runs = mergeRuns(line.runs);
    const spans: Span[] = [];
    let at = 0;
    for (const run of runs) {
      const fmt = clean(run.fmt);
      if (Object.keys(fmt).length) spans.push({ type: "format", start: at, end: at + run.text.length, ...fmt } as Span);
      at += run.text.length;
    }
    const para: TextBoxParagraph = { text: runs.map((r) => r.text).join("") };
    if (line.attrs.role && line.attrs.role !== "normal") para.role = line.attrs.role;
    if (line.attrs.style) para.style = line.attrs.style;
    if (line.attrs.align) para.align = line.attrs.align;
    if (line.attrs.list && line.attrs.list !== "none") para.list = line.attrs.list;
    if (line.attrs.line_height !== undefined) para.line_height = line.attrs.line_height;
    if (line.attrs.space_after_pt !== undefined) para.space_after_pt = line.attrs.space_after_pt;
    if (spans.length) para.spans = spans.slice(0, 300);
    return para;
  });
  return out.length ? out : [{ text: "" }];
}

export function sliceRuns(runs: readonly Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const a = Math.max(from, at), b = Math.min(to, at + run.text.length);
    if (b > a) out.push({ text: run.text.slice(a - at, b - at), fmt: { ...run.fmt } });
    at += run.text.length;
  }
  return out;
}

/** The formatting that text typed at `offset` inherits: that of the character before it, else the one after. */
export function fmtAt(line: Line, offset: number): Fmt {
  let at = 0;
  let after: Fmt | undefined;
  for (const run of line.runs) {
    if (offset > at && offset <= at + run.text.length) return { ...run.fmt };
    if (offset <= at && !after) after = run.fmt;
    at += run.text.length;
  }
  return { ...(after ?? line.runs[line.runs.length - 1]?.fmt ?? {}) };
}

export const comparePos = (a: Pos, b: Pos): number => a.p - b.p || a.o - b.o;

/** What a new paragraph made by Enter starts as: a heading or quote is followed by body text; a list continues. */
export function continuation(attrs: Attrs): Attrs {
  const next: Attrs = {};
  if (attrs.list && attrs.list !== "none") next.list = attrs.list;
  if (attrs.style) next.style = attrs.style;
  if (attrs.align) next.align = attrs.align;
  if (attrs.line_height !== undefined) next.line_height = attrs.line_height;
  if (attrs.space_after_pt !== undefined) next.space_after_pt = attrs.space_after_pt;
  return next;
}

/** Replace [start, end) with `insert` (newlines split paragraphs). Returns the new lines and where the caret goes. */
export function replaceRange(lines: readonly Line[], start: Pos, end: Pos, insert: string, newAttrs: (a: Attrs) => Attrs = (a) => ({ ...a })): { lines: Line[]; caret: Pos } {
  if (comparePos(start, end) > 0) [start, end] = [end, start];
  const first = lines[start.p] ?? { attrs: {}, runs: [] };
  const last = lines[end.p] ?? first;
  const head = sliceRuns(first.runs, 0, start.o);
  const tail = sliceRuns(last.runs, end.o, lineLength(last));
  const inherited = fmtAt(first, start.o);
  const pieces = insert.replace(/\r\n?/g, "\n").split("\n");
  const made: Line[] = [];
  pieces.forEach((piece, index) => {
    const runs: Run[] = piece ? [{ text: piece, fmt: { ...inherited } }] : [];
    if (index === 0) made.push({ attrs: { ...first.attrs }, runs: [...head, ...runs] });
    else made.push({ attrs: index === 1 ? newAttrs(first.attrs) : newAttrs(made[made.length - 1]!.attrs), runs });
  });
  const lastMade = made[made.length - 1]!;
  const caret: Pos = { p: start.p + made.length - 1, o: lineLength(lastMade) };
  lastMade.runs = [...lastMade.runs, ...tail];
  return { lines: [...lines.slice(0, start.p), ...made, ...lines.slice(end.p + 1)], caret };
}

/** Apply `change` to the formatting of the characters in [start, end). */
export function formatRange(lines: readonly Line[], start: Pos, end: Pos, change: (fmt: Fmt) => Fmt): Line[] {
  if (comparePos(start, end) > 0) [start, end] = [end, start];
  return lines.map((line, index) => {
    if (index < start.p || index > end.p) return line;
    const from = index === start.p ? start.o : 0;
    const to = index === end.p ? end.o : lineLength(line);
    if (to <= from) return line;
    const runs = [...sliceRuns(line.runs, 0, from), ...sliceRuns(line.runs, from, to).map((r) => ({ text: r.text, fmt: change(r.fmt) })), ...sliceRuns(line.runs, to, lineLength(line))];
    return { attrs: line.attrs, runs };
  });
}

/** True when every character in the range already has the flag. */
export function rangeHas(lines: readonly Line[], start: Pos, end: Pos, key: "bold" | "italic" | "underline" | "strike" | "superscript" | "subscript"): boolean {
  if (comparePos(start, end) > 0) [start, end] = [end, start];
  let any = false;
  for (let i = start.p; i <= end.p; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const from = i === start.p ? start.o : 0, to = i === end.p ? end.o : lineLength(line);
    for (const run of sliceRuns(line.runs, from, to)) { any = true; if (!run.fmt[key]) return false; }
  }
  return any;
}

/** One value of a formatting key across the range: the value, "mixed", or undefined when none of the text has one. */
export function rangeValue<K extends keyof Fmt>(lines: readonly Line[], start: Pos, end: Pos, key: K): Fmt[K] | "mixed" | undefined {
  if (comparePos(start, end) > 0) [start, end] = [end, start];
  let value: Fmt[K] | undefined, seen = false;
  for (let i = start.p; i <= end.p; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const from = i === start.p ? start.o : 0, to = i === end.p ? end.o : lineLength(line);
    for (const run of sliceRuns(line.runs, from, Math.max(to, from))) {
      const here = run.fmt[key];
      if (seen && here !== value) return "mixed";
      value = here; seen = true;
    }
  }
  return value;
}

/* ------------------------------------------------------------------------------------------------ DOM <-> model */

const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "LI", "UL", "OL", "PRE"]);
const px2pt = (v: number): number => Math.round(v * 7.5) / 10;

function attrsOf(el: HTMLElement): Attrs {
  const d = el.dataset;
  const attrs: Attrs = {};
  const role = d["role"];
  if (role === "heading1" || role === "heading2" || role === "heading3" || role === "quote") attrs.role = role;
  if (d["style"]) attrs.style = d["style"];
  const align = d["align"];
  if (align === "left" || align === "center" || align === "right" || align === "justify") attrs.align = align;
  if (d["list"] === "bullet" || d["list"] === "number") attrs.list = d["list"];
  if (d["lineHeight"] && Number.isFinite(Number(d["lineHeight"]))) attrs.line_height = Number(d["lineHeight"]);
  if (d["spaceAfter"] && Number.isFinite(Number(d["spaceAfter"]))) attrs.space_after_pt = Number(d["spaceAfter"]);
  return attrs;
}

function fmtOf(el: HTMLElement, inherited: Fmt): Fmt {
  const fmt: Fmt = { ...inherited };
  switch (el.tagName) {
    case "B": case "STRONG": fmt.bold = true; break;
    case "I": case "EM": fmt.italic = true; break;
    case "U": fmt.underline = true; break;
    case "S": case "STRIKE": case "DEL": fmt.strike = true; break;
    case "SUP": fmt.superscript = true; delete fmt.subscript; break;
    case "SUB": fmt.subscript = true; delete fmt.superscript; break;
    default: break;
  }
  const st = el.style;
  if (st.color && el.tagName === "SPAN") { const c = cssColour(st.color); if (c) fmt.color = c; }
  if (st.backgroundColor && el.tagName === "SPAN") { const c = cssColour(st.backgroundColor); if (c) fmt.background = c; }
  if (st.fontFamily) { const f = st.fontFamily.split(",")[0]?.replace(/["']/g, "").trim(); if (f && FONT_SAFE.test(f)) fmt.font_family = f; }
  if (st.fontSize) {
    const n = parseFloat(st.fontSize);
    if (Number.isFinite(n)) { const pt = st.fontSize.endsWith("pt") ? n : st.fontSize.endsWith("px") ? px2pt(n) : NaN; if (pt >= 5 && pt <= 144) fmt.font_size_pt = Math.round(pt * 10) / 10; }
  }
  if (st.letterSpacing && st.letterSpacing.endsWith("pt")) { const n = parseFloat(st.letterSpacing); if (Number.isFinite(n)) fmt.letter_spacing_pt = n; }
  if (st.wordSpacing && st.wordSpacing.endsWith("pt")) { const n = parseFloat(st.wordSpacing); if (Number.isFinite(n)) fmt.word_spacing_pt = n; }
  if (st.fontWeight === "700" || st.fontWeight === "bold") fmt.bold = true;
  if (st.fontStyle === "italic") fmt.italic = true;
  return fmt;
}

function cssColour(value: string): string | undefined {
  if (COLOUR.test(value)) return value.toLowerCase();
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(value);
  if (!m) return undefined;
  return `#${[m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0")).join("")}`;
}

/** Read whatever the browser made of the user's typing back into lines. Unknown markup is flattened to its text. */
export function parseTextBox(root: ParentNode): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  let attrs: Attrs = {};
  const start = (a: Attrs): void => { current = { attrs: { ...a }, runs: [] }; };
  const end = (): void => { if (current) lines.push(current); current = null; };
  const add = (text: string, fmt: Fmt): void => {
    if (!text) return;
    if (!current) start(attrs);
    current!.runs.push({ text, fmt: clean(fmt) });
  };
  const walk = (node: Node, fmt: Fmt): void => {
    if (node.nodeType === Node.TEXT_NODE) { add((node.nodeValue ?? "").replace(/ /g, " ").replace(/[\r\n​]/g, ""), fmt); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      if (node.nextSibling === null && node.parentElement && BLOCK.has(node.parentElement.tagName)) return;
      if (!current) start(attrs);
      const keep = current!.attrs; end(); start(keep);
      return;
    }
    if (node.dataset["tbIgnore"] !== undefined) return;
    if (BLOCK.has(node.tagName)) {
      end();
      attrs = node.tagName === "H1" ? { role: "heading1" } : node.tagName === "H2" ? { role: "heading2" } : node.tagName === "H3" ? { role: "heading3" } : node.tagName === "BLOCKQUOTE" ? { role: "quote" } : attrsOf(node);
      if (node.tagName === "LI") attrs = { ...attrs, list: node.parentElement?.tagName === "OL" ? "number" : "bullet" };
      if (node.tagName === "UL" || node.tagName === "OL") { for (const child of Array.from(node.childNodes)) walk(child, fmt); end(); return; }
      start(attrs);
      for (const child of Array.from(node.childNodes)) walk(child, fmtOf(node, fmt));
      end();
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child, fmtOf(node, fmt));
  };
  for (const child of Array.from(root.childNodes)) walk(child, {});
  end();
  return lines.length ? lines : [{ attrs: {}, runs: [] }];
}

/** Where a DOM point is, in paragraphs and characters. Works on whatever structure the browser left behind. */
export function posOfPoint(root: HTMLElement, node: Node, offset: number): Pos {
  const range = document.createRange();
  range.setStart(root, 0);
  try { range.setEnd(node, offset); } catch { return { p: 0, o: 0 }; }
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  const lines = parseTextBox(holder);
  return { p: lines.length - 1, o: lineLength(lines[lines.length - 1]!) };
}

/** The DOM point for a model position in a freshly rendered text area. */
export function pointOfPos(root: HTMLElement, pos: Pos): { node: Node; offset: number } {
  const para = root.children[Math.max(0, Math.min(root.children.length - 1, pos.p))];
  if (!para) return { node: root, offset: 0 };
  let remaining = pos.o;
  const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
  let text: Text | null;
  let lastText: Text | null = null;
  while ((text = walker.nextNode() as Text | null)) {
    lastText = text;
    if (remaining <= text.length) return { node: text, offset: remaining };
    remaining -= text.length;
  }
  return lastText ? { node: lastText, offset: lastText.length } : { node: para, offset: 0 };
}

/* ------------------------------------------------------------------------------------------------------------ presets */

export interface TextBoxPreset { id: string; label: string; hint: string; build: () => ShapeData }

const baseBox = (): ShapeData => ({
  version: 1, kind: "rectangle", width_mm: 70, height_mm: 30, rotation_deg: 0, opacity: 1,
  fill: { enabled: true, color: "#ffffff", opacity: 1 },
  outline: { enabled: true, color: "#8a8a8a", opacity: 1, width_pt: 1, style: "solid" },
  corners_mm: [0, 0, 0, 0],
  text: { content: "", color: "#171717", font_size_pt: 12, bold: false, italic: false, align: "left", padding_mm: 3, spans: [], fit: "keep" },
  shadows: [], layout: { mode: "inline" }, z_index: 0, flip_horizontal: false, flip_vertical: false,
  textbox: { version: 1, paragraphs: [{ text: "" }], vertical_align: "top", auto_expand: true, pinned: false, locked: false },
});

/** The shape the Insert → Text Box menu starts from. Every preset is an ordinary shape that the shape controls can change. */
export const TEXTBOX_PRESETS: readonly TextBoxPreset[] = [
  { id: "default", label: "Text Box", hint: "Plain box with a thin outline", build: baseBox },
  { id: "callout", label: "Callout", hint: "Soft yellow note with rounded corners", build: () => {
    const s = baseBox(); s.fill = { enabled: true, color: "#fff4c2", opacity: 1 }; s.outline = { enabled: true, color: "#d9a400", opacity: 1, width_pt: 1.5, style: "solid" };
    s.corners_mm = [3, 3, 3, 3]; return s; } },
  { id: "sidebar", label: "Sidebar", hint: "Grey panel for side notes", build: () => {
    const s = baseBox(); s.width_mm = 55; s.height_mm = 60; s.fill = { enabled: true, color: "#eef2f7", opacity: 1 }; s.outline.enabled = false;
    s.text.font_size_pt = 10.5; s.corners_mm = [2, 2, 2, 2]; return s; } },
  { id: "pull-quote", label: "Pull Quote", hint: "Large centred italic quote", build: () => {
    const s = baseBox(); s.width_mm = 80; s.height_mm = 28; s.fill.enabled = false; s.outline.enabled = false; s.text.font_size_pt = 16; s.text.align = "center";
    s.textbox = { ...s.textbox!, paragraphs: [{ text: "", role: "quote" }], vertical_align: "middle" }; return s; } },
  { id: "dark-note", label: "Dark Note", hint: "Dark panel with warm serif text", build: () => {
    const s = baseBox(); s.fill = { enabled: true, color: "#1f1f1f", opacity: 1 }; s.outline = { enabled: true, color: "#ffffff", opacity: 1, width_pt: 1, style: "dashed" };
    s.text.color = "#f0b43c"; s.text.font_family = "Georgia"; s.text.font_size_pt = 14; return s; } },
  { id: "banner", label: "Title Banner", hint: "Bold white text on a deep blue band", build: () => {
    const s = baseBox(); s.width_mm = 120; s.height_mm = 18; s.fill = { enabled: true, color: "#1f3a5f", opacity: 1 }; s.outline.enabled = false;
    s.text.color = "#ffffff"; s.text.font_size_pt = 20; s.text.bold = true; s.text.align = "center";
    s.textbox = { ...s.textbox!, vertical_align: "middle" }; return s; } },
];

export const textBoxText = (paragraphs: readonly TextBoxParagraph[]): string => paragraphs.map((p) => p.text).join("\n");

/** A copy of `shape` with these paragraphs, the plain-text mirror kept in step (the server rejects a text box whose two copies differ). */
export function withParagraphs(shape: ShapeData, paragraphs: TextBoxParagraph[]): ShapeData {
  const next = structuredClone(shape);
  next.textbox = { ...(next.textbox as TextBoxData), paragraphs };
  next.text = { ...next.text, content: textBoxText(paragraphs), spans: [] };
  return next;
}
