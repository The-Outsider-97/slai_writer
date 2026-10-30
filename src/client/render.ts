/** Turns blocks into DOM. Everything is built with createElement/textContent (no innerHTML); styles go through the CSSOM, which the CSP allows. */
import { h, glyph } from "./kit.js";
import { assetUrl } from "./net.js";
import { plaintextOnlySupported } from "./domtext.js";
import { segments, MM_PX, type Segment } from "./textops.js";
import { paintFigure } from "./figlayout.js";
import type { Block, DocMeta, EmbedDecl, Reference } from "./types.js";

export const EDIT_MODE = plaintextOnlySupported() ? "plaintext-only" : "true";

export interface RenderContext {
  sid: string;
  meta: DocMeta;
  readOnly: boolean;
  /** Marker text for list items, keyed by block id (computed once per render pass). */
  markers: Map<string, string>;
  /** Footnote numbers by reference id. */
  footnotes: Map<string, number>;
  locked: (embedId: string) => boolean;
  role: string;
  /** Layers that are switched off or locked in the view. */
  hidden: Set<string>;
  locks: Set<string>;
  /** The layer a block is on. */
  layerOf: (block: Block) => string;
  /** Width of the writing area for a section, in millimetres: a picture is never wider than that. */
  contentMm?: (section: string | undefined) => number;
  /** A picture finished loading: its real proportions are known, so the page may need laying out again. */
  mediaLoaded?: () => void;
}

type StyleProps = Record<string, unknown>;

/** A style with its `based_on` chain folded in (parent first). */
export function resolveStyle(meta: DocMeta, kind: "paragraph" | "character", name: string | undefined): StyleProps {
  const group = meta.styles?.[kind] ?? {};
  const chain: StyleProps[] = [];
  let current = name;
  const seen = new Set<string>();
  while (current && group[current] && !seen.has(current)) {
    seen.add(current);
    chain.unshift(group[current] as StyleProps);
    current = (group[current] as StyleProps)["based_on"] as string | undefined;
  }
  return Object.assign({}, ...chain) as StyleProps;
}

const FONT_SAFE = /^[^\x00-\x1f\x7f{};<>\\"'`]{1,100}$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

export function applyStyle(el: HTMLElement, props: StyleProps, paragraph: boolean): void {
  const set = (k: string, v: string): void => el.style.setProperty(k, v);
  if (typeof props["font_family"] === "string" && FONT_SAFE.test(props["font_family"])) set("font-family", `"${props["font_family"]}", serif`);
  if (typeof props["font_size_pt"] === "number") set("font-size", `${props["font_size_pt"]}pt`);
  if (props["bold"]) set("font-weight", "700");
  if (props["italic"]) set("font-style", "italic");
  const deco = [props["underline"] ? "underline" : "", props["strike"] ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) set("text-decoration", deco);
  if (props["small_caps"]) set("font-variant", "small-caps");
  if (typeof props["color"] === "string" && COLOUR.test(props["color"])) set("color", props["color"]);
  if (typeof props["background"] === "string" && COLOUR.test(props["background"])) set("background-color", props["background"]);
  if (!paragraph) return;
  if (typeof props["align"] === "string") set("text-align", props["align"]);
  if (typeof props["line_height"] === "number") set("line-height", String(props["line_height"]));
  if (typeof props["space_before_pt"] === "number") set("margin-top", `${props["space_before_pt"]}pt`);
  if (typeof props["space_after_pt"] === "number") set("margin-bottom", `${props["space_after_pt"]}pt`);
  if (typeof props["indent_mm"] === "number") set("padding-left", `${props["indent_mm"]}mm`);
  if (typeof props["first_line_indent_mm"] === "number") set("text-indent", `${props["first_line_indent_mm"]}mm`);
}

const SAFE_LINK = /^(https?:|mailto:)/i;

function pieceFor(seg: Segment, ctx: RenderContext, block: Block): Node {
  if (seg.object) return objectNode(seg, ctx);
  let node: Node = document.createTextNode(seg.text);
  const wrap = (el: HTMLElement): HTMLElement => { el.appendChild(node); node = el; return el; };
  const f = seg.flags;
  if (f.code) wrap(h("code", { class: "i-code" }));
  if (f.bold) wrap(h("strong"));
  if (f.italic) wrap(h("em"));
  if (f.underline) wrap(h("u"));
  if (f.strike) wrap(h("s"));
  if (f.superscript) wrap(h("sup"));
  if (f.subscript) wrap(h("sub"));
  if (seg.color || seg.background || seg.style) {
    const el = wrap(h("span", { class: "i-fmt" }));
    if (seg.color && /^#[0-9a-fA-F]{6}$/.test(seg.color)) el.style.setProperty("color", seg.color);
    if (seg.background && /^#[0-9a-fA-F]{6}$/.test(seg.background)) el.style.setProperty("background-color", seg.background);
    if (seg.style) applyStyle(el, resolveStyle(ctx.meta, "character", seg.style), false);
  }
  if (seg.href) {
    const safe = SAFE_LINK.test(seg.href);
    wrap(h("a", { class: "i-link", attrs: { href: safe ? seg.href : null, "data-href": seg.href, title: `${seg.href} (Ctrl+click to open)`, rel: "noopener noreferrer" } }));
  }
  if (seg.ref) {
    const footnote = ctx.footnotes.get(seg.ref);
    const ref = ctx.meta.references?.find((r) => r.id === seg.ref);
    wrap(h("span", { class: footnote ? "i-fn" : "i-cite", data: { ref: seg.ref, n: footnote ? String(footnote) : undefined },
      attrs: { title: referenceTitle(ref), role: "doc-noteref" } }));
  }
  if (seg.target) wrap(h("a", { class: "i-xref", data: { target: seg.target }, attrs: { href: `#${seg.target}`, title: "Cross-reference (Ctrl+click to go there)" } }));
  void block;
  return node;
}

function referenceTitle(ref: Reference | undefined): string {
  if (!ref) return "Reference not found";
  if (ref.kind === "footnote") return `Footnote: ${ref.text ?? ""}`;
  return [ref.authors?.join(", "), ref.year ? `(${ref.year})` : "", ref.title].filter(Boolean).join(" ");
}

function objectNode(seg: Segment, ctx: RenderContext): HTMLElement {
  const span = seg.object;
  if (span?.type === "equation" && span.equation) {
    return h("span", { class: "i-eq", data: { obj: "equation" }, attrs: { "data-obj": "", contenteditable: "false", role: "math", "aria-label": `Equation: ${span.equation.source}`, title: "Equation (double-click to edit)" } },
      h("code", { text: span.equation.source }));
  }
  const figure = span?.figure;
  return h("span", { class: "i-img", attrs: { "data-obj": "", contenteditable: "false", "data-kind": "image" } },
    figure ? h("img", { attrs: { src: assetUrl(ctx.sid, figure.asset), alt: figure.decorative ? "" : figure.alt ?? "" }, css: { "max-height": "1.6em" } }) : "");
}

/** Replace the contents of a text element with the block's formatted text. */
export function fillText(el: HTMLElement, ctx: RenderContext, block: Block): void {
  const kids: Node[] = segments(block).map((seg) => pieceFor(seg, ctx, block));
  el.replaceChildren(...kids);
}

function textElement(block: Block, ctx: RenderContext): HTMLElement {
  const tag = block.type === "heading" ? (`h${Math.min(6, Math.max(1, block.attributes?.level ?? 1))}` as "h1") : block.type === "quote" ? "blockquote" : block.type === "code" ? "pre" : block.type === "list_item" ? "div" : "p";
  const el = h(tag, { class: `txt t-${block.type}`, attrs: { "data-edit": "text", contenteditable: ctx.readOnly ? "false" : EDIT_MODE, spellcheck: "false", "aria-multiline": "true", tabindex: "0" } });
  if (block.type === "list_item") el.setAttribute("role", "listitem");
  if (block.type === "code") el.setAttribute("data-lang", String(block.attributes?.language ?? ""));
  if (block.type === "heading") el.setAttribute("aria-level", String(block.attributes?.level ?? 1));
  applyStyle(el, resolveStyle(ctx.meta, "paragraph", block.style ?? defaultStyle(block)), true);
  if (block.type === "list_item") el.style.setProperty("margin-left", `${(block.attributes?.depth ?? 0) * 8 + 8}mm`);
  if (typeof block.attributes?.align === "string" && ["left", "center", "right", "justify"].includes(block.attributes.align)) el.style.setProperty("text-align", block.attributes.align);
  fillText(el, ctx, block);
  return el;
}

function defaultStyle(block: Block): string | undefined {
  return block.type === "paragraph" || block.type === "list_item" ? "Body Text" : undefined;
}

function tableElement(block: Block, ctx: RenderContext): HTMLElement {
  const data = block.table;
  const table = h("table", { class: "tbl", attrs: { role: "table" } });
  if (block.text) table.appendChild(h("caption", { text: block.text }));
  const headerRows = data?.header_rows ?? 0;
  (data?.rows ?? []).forEach((row, r) => {
    const tr = h("tr");
    row.forEach((cell, c) => {
      const isHeader = r < headerRows;
      const td = h(isHeader ? "th" : "td", { class: "cell", attrs: { "data-edit": "cell", "data-row": r, "data-col": c, contenteditable: ctx.readOnly ? "false" : EDIT_MODE, colspan: cell.colspan && cell.colspan > 1 ? cell.colspan : null, rowspan: cell.rowspan && cell.rowspan > 1 ? cell.rowspan : null, scope: isHeader ? "col" : null, "aria-label": `Row ${r + 1}, column ${c + 1}`, tabindex: "0" }, text: cell.text });
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function figureElement(block: Block, ctx: RenderContext): HTMLElement {
  const fig = block.figure;
  const img = h("img", { class: "fig-img", attrs: { src: fig ? assetUrl(ctx.sid, fig.asset) : null, alt: fig?.decorative ? "" : fig?.alt ?? "", draggable: "false" } });
  const frame = h("div", { class: "fig-frame" }, img);
  const box = h("div", { class: "fig-box" }, frame);
  const cap = h("figcaption", { class: "cap", attrs: { "data-edit": "caption", contenteditable: ctx.readOnly ? "false" : EDIT_MODE, "aria-label": "Caption", tabindex: "0", "data-placeholder": "Add a caption" }, text: block.text });
  const figure = h("figure", { class: `fig align-${fig?.align ?? "center"}` }, box, cap);
  if (fig) {
    const maxPx = (ctx.contentMm?.(block.section) ?? 0) * MM_PX;
    paintFigure(box, frame, img, fig, maxPx);
    // Until the picture has loaded its proportions are a guess; once it has, the layout is redone with the real ones.
    img.addEventListener("load", () => { paintFigure(box, frame, img, fig, maxPx); ctx.mediaLoaded?.(); }, { once: true });
    const place = fig.placement;
    if (place) {
      figure.setAttribute("data-floating", place.layer ?? "content");
      figure.style.setProperty("left", `${place.x_mm * MM_PX}px`);
      figure.style.setProperty("top", `${place.y_mm * MM_PX}px`);
    }
  }
  if (fig?.decorative) figure.setAttribute("data-decorative", "");
  else if (!fig?.alt) figure.setAttribute("data-missing-alt", "");
  return figure;
}

function equationElement(block: Block): HTMLElement {
  const eq = block.equation;
  return h("div", { class: `eqn align-${eq?.align ?? "center"}`, attrs: { role: "math", tabindex: "0", "aria-label": `Equation: ${eq?.source ?? ""}`, "data-equation": "" } },
    h("code", { class: "eqn-src", text: eq?.source ?? "" }),
    eq?.numbered ? h("span", { class: "eqn-no", text: "(#)" }) : null,
    h("span", { class: "eqn-note muted", text: `${eq?.syntax ?? "latex"} source; typeset preview is not available offline` }));
}

function embedDecl(ctx: RenderContext, block: Block): EmbedDecl | undefined { return ctx.meta.embeds?.find((e) => e.id === block.embed); }

function embedElement(block: Block, ctx: RenderContext): HTMLElement {
  const decl = embedDecl(ctx, block);
  const locked = block.embed ? ctx.locks.has(block.embed) : false;
  const restricted = locked && ctx.role !== "owner";
  const card = h("div", { class: `embed${restricted ? " locked" : ""}`, attrs: { tabindex: "0", role: "group", "aria-label": restricted ? "EMBED component, locked" : `EMBED component ${decl?.kind ?? ""}`, "data-embed": block.embed ?? "" } },
    h("div", { class: "embed-head" }, glyph(restricted ? "lock" : "layout"), h("strong", { text: restricted ? "EMBED / Locked" : "EMBED" }), h("span", { class: "muted", text: decl?.kind ?? "" })),
    h("p", { class: "embed-out", text: block.text || "(no output yet)" }),
    h("p", { class: "embed-note muted", text: restricted ? "Locked. The public summary above stays readable; open the panel to see access options." : "Inert declaration: it shows its last valid output and never runs code." }));
  return card;
}

/** The marker (bullet or number) of every list item, restarting after any other block. */
export function listMarkers(blocks: Block[]): Map<string, string> {
  const out = new Map<string, string>();
  const counters: number[] = [];
  for (const b of blocks) {
    if (b.type !== "list_item") { counters.length = 0; continue; }
    const depth = Math.min(b.attributes?.depth ?? 0, 8);
    counters.length = depth + 1;
    for (let i = 0; i <= depth; i += 1) counters[i] = counters[i] ?? 0;
    counters[depth] = (counters[depth] ?? 0) + 1;
    out.set(b.id, b.attributes?.ordered ? `${counters[depth]}.` : depth % 2 ? "◦" : "•");
  }
  return out;
}

/** Numbers of footnotes in reading order. */
export function footnoteNumbers(blocks: Block[], meta: DocMeta): Map<string, number> {
  const kind = new Map((meta.references ?? []).map((r) => [r.id, r.kind]));
  const out = new Map<string, number>();
  for (const b of blocks) for (const s of b.spans ?? []) {
    if (s.type === "ref" && s.ref && kind.get(s.ref) === "footnote" && !out.has(s.ref)) out.set(s.ref, out.size + 1);
  }
  return out;
}

export function renderBlock(block: Block, ctx: RenderContext): HTMLElement {
  const wrap = h("div", { class: `blk b-${block.type}`, data: { id: block.id, type: block.type } });
  if (block.type === "list_item") wrap.appendChild(h("span", { class: "marker", text: ctx.markers.get(block.id) ?? "•", attrs: { "aria-hidden": "true", contenteditable: "false" } }));
  if (!ctx.readOnly) wrap.appendChild(h("button", { class: "grip", type: "button", attrs: { "aria-label": "Move block (or Alt+Shift+arrow keys)", title: "Drag to move", draggable: "true", tabindex: "-1" }, data: { grip: "" } }, glyph("drag")));
  switch (block.type) {
    case "table": wrap.appendChild(tableElement(block, ctx)); break;
    case "figure": wrap.appendChild(figureElement(block, ctx)); break;
    case "equation": wrap.appendChild(equationElement(block)); break;
    case "embed": wrap.appendChild(embedElement(block, ctx)); break;
    default: wrap.appendChild(textElement(block, ctx));
  }
  if (block.type === "figure" && block.figure?.placement) wrap.setAttribute("data-floating", block.figure.placement.layer ?? "content");
  syncLayer(wrap, block, ctx);
  return wrap;
}

/** Show whether the block's layer is hidden or locked. Called when a block is drawn and again when only the layers changed. */
export function syncLayer(wrap: HTMLElement, block: Block, ctx: RenderContext): void {
  const layer = ctx.layerOf(block);
  wrap.toggleAttribute("data-layer-hidden", ctx.hidden.has(layer));
  wrap.toggleAttribute("data-layer-locked", ctx.locks.has(`layer:${layer}`));
}

/** Re-render one block in place when only its text or spans changed (keeps the wrapper, so focus handling stays simple). */
export function refreshBlock(wrapper: HTMLElement, block: Block, ctx: RenderContext): boolean {
  if (wrapper.dataset["type"] !== block.type) return false;
  if (block.type === "heading") {
    const el = wrapper.querySelector<HTMLElement>("[data-edit=text]");
    if (!el || el.tagName !== `H${block.attributes?.level ?? 1}`) return false;
  }
  if (block.type === "list_item" || block.type === "table" || block.type === "figure" || block.type === "equation" || block.type === "embed") return false;
  const el = wrapper.querySelector<HTMLElement>("[data-edit=text]");
  if (!el) return false;
  el.removeAttribute("style");
  applyStyle(el, resolveStyle(ctx.meta, "paragraph", block.style ?? defaultStyle(block)), true);
  if (typeof block.attributes?.align === "string" && ["left", "center", "right", "justify"].includes(block.attributes.align)) el.style.setProperty("text-align", block.attributes.align);
  fillText(el, ctx, block);
  return true;
}
