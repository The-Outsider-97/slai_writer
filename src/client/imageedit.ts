/** Editing a picture after it is in the document: select it, then resize it by its corners, turn it by the round handle, crop it by its edges, mirror it, align
 *  it, move it (in the text order, or freely on the page), put it in front of or behind the text, or open its details. Everything the person does is written
 *  to the picture's own .sldc properties (width_mm, crop, rotation_deg, flip_*, placement, align) with the figure_set operation, so it is undoable, saved with the
 *  document and visible to any program that reads the format. The handles live in a layer in front of the pages that is scaled with them. */
import { glyph, announce } from "./kit.js";
import { h } from "./kit.js";
import type { Editor } from "./editor.js";
import * as A from "./actions.js";
import { cropAfterDrag, cropOf, figureMetrics, halfMm, paintFigure, widthForBox } from "./figlayout.js";
import { MM_PX } from "./textops.js";
import type { Block, FigureData, FigurePlacement } from "./types.js";

export interface ImageHooks { details(block: Block): void }

type Corner = "nw" | "ne" | "sw" | "se";
type Edge = "left" | "right" | "top" | "bottom";

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.max(lo, hi), n));
const normaliseTurn = (deg: number): number => { let d = ((deg + 180) % 360 + 360) % 360 - 180; if (Math.abs(d) < 0.5) d = 0; return Math.round(d * 10) / 10; };

export class ImageTools {
  private id: string | null = null;
  private cropping = false;
  private root: HTMLElement | null = null;
  private tip: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private cropBox: HTMLElement | null = null;
  private busy = false;
  private readonly off: Array<() => void> = [];

  constructor(private readonly ed: Editor, private readonly hooks: ImageHooks) {
    this.off.push(ed.events.on((e) => {
      if (e.type === "block-selected") this.select(e.id);
      else if (e.type === "layout" || e.type === "patch") this.refresh();
    }));
    ed.page.onPlaced(() => this.refresh());
    const key = (e: KeyboardEvent): void => this.onKey(e);
    ed.host.addEventListener("keydown", key);
    this.off.push(() => ed.host.removeEventListener("keydown", key));
  }

  destroy(): void { for (const fn of this.off) fn(); this.hide(); }

  /* ------------------------------------------------------------------------------------------------ what is selected */
  private block(): Block | undefined { const b = this.id ? this.ed.model.block(this.id) : undefined; return b?.type === "figure" && b.figure ? b : undefined; }
  private el<T extends Element>(selector: string): T | null { return this.id ? this.ed.els.get(this.id)?.querySelector<T>(selector) ?? null : null; }
  private natural(): { w: number; h: number } { const img = this.el<HTMLImageElement>(".fig-img"); return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 }; }
  private maxPx(block: Block): number { const g = this.ed.model.geometry(block.section); return (g.widthMm - g.margins.left - g.margins.right) * MM_PX; }

  private select(id: string | null): void {
    this.cropping = false;
    this.id = id;
    this.refresh();
  }

  private hide(): void { this.root?.remove(); this.root = null; this.bar = null; this.tip = null; this.cropBox = null; }

  /* ------------------------------------------------------------------------------------------------------- drawing */
  refresh(): void {
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    if (!block || !box || !box.isConnected || this.ed.readOnly) { this.hide(); return; }
    if (!this.root) this.build();
    const root = this.root as HTMLElement;
    const fig = block.figure as FigureData;
    const rect = this.ed.page.rectOf(box);
    const z = this.ed.page.zoom;
    root.style.setProperty("left", `${rect.left}px`);
    root.style.setProperty("top", `${rect.top}px`);
    root.style.setProperty("width", `${rect.width}px`);
    root.style.setProperty("height", `${rect.height}px`);
    root.style.setProperty("--s", String(1 / z));
    root.classList.toggle("below", rect.top < 56);
    root.classList.toggle("cropping", this.cropping);
    this.paintBar(fig);
    this.paintCropBox(block, box);
  }

  private paintCropBox(block: Block, box: HTMLElement): void {
    if (!this.cropBox) return;
    this.cropBox.hidden = !this.cropping;
    if (!this.cropping) return;
    const fig = block.figure as FigureData;
    const m = figureMetrics(fig, this.natural(), this.maxPx(block));
    const left = (m.boxW - m.frameW) / 2;
    const top = (m.boxH - m.frameH) / 2;
    const s = this.cropBox.style;
    s.setProperty("left", `${left}px`); s.setProperty("top", `${top}px`);
    s.setProperty("width", `${m.frameW}px`); s.setProperty("height", `${m.frameH}px`);
    s.setProperty("transform", m.rotation ? `rotate(${m.rotation}deg)` : "none");
    void box;
  }

  private build(): void {
    const handle = (cls: string, label: string, start: (e: PointerEvent) => void, step?: (e: KeyboardEvent) => void): HTMLElement => {
      const el = h("div", { class: `ih ${cls}`, attrs: { role: "button", tabindex: "0", "aria-label": label, title: label } });
      el.addEventListener("pointerdown", start);
      if (step) el.addEventListener("keydown", step);
      return el;
    };
    const root = h("div", { class: "imgsel", attrs: { role: "group", "aria-label": "Picture editing handles" } });
    const move = h("div", { class: "imgsel-move", attrs: { title: "Drag to move. Double-click for the picture's details." } });
    move.addEventListener("pointerdown", (e) => this.startMove(e, move));
    move.addEventListener("dblclick", () => { const b = this.block(); if (b) this.hooks.details(b); });
    root.appendChild(move);
    for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
      const names: Record<Corner, string> = { nw: "top left", ne: "top right", sw: "bottom left", se: "bottom right" };
      root.appendChild(handle(`corner ${corner}`, `Resize from the ${names[corner]} corner. Arrow keys change the size.`, (e) => this.startResize(e, corner), (e) => this.keyResize(e)));
    }
    root.appendChild(h("div", { class: "imgsel-stem" }));
    root.appendChild(handle("rot", "Turn the picture. Drag the handle, or use the arrow keys (Shift for larger steps).", (e) => this.startTurn(e), (e) => this.keyTurn(e)));
    const crop = h("div", { class: "imgsel-crop" });
    for (const edge of ["left", "right", "top", "bottom"] as Edge[]) {
      crop.appendChild(handle(`edge ${edge}`, `Crop the ${edge} edge. Arrow keys crop in small steps.`, (e) => this.startCrop(e, edge), (e) => this.keyCrop(e, edge)));
    }
    crop.hidden = true;
    root.appendChild(crop);
    this.tip = h("div", { class: "imgsel-tip", attrs: { "aria-hidden": "true" } });
    this.tip.hidden = true;
    root.appendChild(this.tip);
    this.bar = this.makeBar();
    root.appendChild(this.bar);
    this.ed.page.overlay.appendChild(root);
    this.root = root;
    this.cropBox = crop;
  }

  /* ------------------------------------------------------------------------------------------------------ toolbar */
  private makeBar(): HTMLElement {
    const bar = h("div", { class: "imgbar", attrs: { role: "toolbar", "aria-label": "Picture tools" } });
    const add = (id: string, icon: string, label: string, run: () => void): void => {
      const b = h("button", { type: "button", class: "ib", data: { tool: id }, attrs: { "aria-label": label, title: label } }, glyph(icon));
      b.addEventListener("click", () => run());
      bar.appendChild(b);
    };
    const gap = (): void => { bar.appendChild(h("span", { class: "ib-gap", attrs: { "aria-hidden": "true" } })); };
    add("turn-left", "rotate-left", "Turn 90° to the left", () => void this.turn(-90));
    add("turn-right", "rotate-right", "Turn 90° to the right", () => void this.turn(90));
    add("flip-h", "flip-h", "Mirror left to right", () => void this.flip("flip_horizontal"));
    add("flip-v", "flip-v", "Mirror top to bottom", () => void this.flip("flip_vertical"));
    add("crop", "crop", "Crop", () => { this.cropping = !this.cropping; announce(this.cropping ? "Crop: drag an edge of the picture." : "Crop finished."); this.refresh(); });
    add("reset", "undo", "Back to the original size and shape", () => void this.reset());
    gap();
    add("align-left", "align-left", "Align left", () => void this.align("left"));
    add("align-center", "align-center", "Centre", () => void this.align("center"));
    add("align-right", "align-right", "Align right", () => void this.align("right"));
    add("free", "move", "Move freely on the page", () => void this.toggleFree());
    add("layer", "bring-front", "In front of the text", () => void this.toggleLayer());
    gap();
    add("details", "image", "Description, caption, credit…", () => { const b = this.block(); if (b) this.hooks.details(b); });
    add("delete", "trash", "Delete the picture", () => { if (this.id) void A.deleteBlocks(this.ed, [this.id]); });
    return bar;
  }

  private paintBar(fig: FigureData): void {
    if (!this.bar) return;
    const floating = !!fig.placement;
    const set = (tool: string, on: boolean | null, hidden?: boolean, label?: string): void => {
      const b = this.bar?.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
      if (!b) return;
      b.hidden = hidden === true;
      if (on !== null) b.setAttribute("aria-pressed", String(on));
      if (label) { b.setAttribute("aria-label", label); b.setAttribute("title", label); }
    };
    set("flip-h", fig.flip_horizontal === true); set("flip-v", fig.flip_vertical === true); set("crop", this.cropping);
    const align = fig.align ?? "center";
    for (const a of ["left", "center", "right"]) set(`align-${a}`, align === a, floating);
    set("free", floating, false, floating ? "Put back in line with the text" : "Move freely on the page");
    const behind = fig.placement?.layer === "behind_text";
    set("layer", behind, !floating, behind ? "Bring in front of the text" : "Send behind the text");
    const icon = this.bar.querySelector<HTMLElement>('[data-tool="layer"]');
    icon?.replaceChildren(glyph(behind ? "bring-front" : "send-back"));
  }

  /* ------------------------------------------------------------------------------------------------------ changes */
  private async change(props: Record<string, unknown>, label: string): Promise<void> {
    const id = this.id;
    if (!id || this.busy) return;
    this.busy = true;
    try { await this.ed.op({ op: "figure_set", block: id, props, label }); } catch (e) { this.ed.failed(e); } finally { this.busy = false; this.refresh(); }
  }

  private async turn(by: number): Promise<void> {
    const fig = this.block()?.figure;
    if (!fig) return;
    const next = normaliseTurn((fig.rotation_deg ?? 0) + by);
    await this.change({ rotation_deg: next === 0 ? null : next }, "turn picture");
    announce(`Turned to ${next} degrees.`);
  }

  private async flip(key: "flip_horizontal" | "flip_vertical"): Promise<void> {
    const fig = this.block()?.figure;
    if (!fig) return;
    await this.change({ [key]: fig[key] ? null : true }, "mirror picture");
  }

  private async reset(): Promise<void> {
    await this.change({ crop: null, rotation_deg: null, flip_horizontal: null, flip_vertical: null, height_mm: null, width_mm: null }, "reset picture");
    announce("The picture is back to its original shape.");
  }

  private async align(side: "left" | "center" | "right"): Promise<void> { await this.change({ align: side }, "align picture"); }

  /** In line with the text <-> free on the page. A picture that becomes free stays exactly where it is on the page. */
  private async toggleFree(): Promise<void> {
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    const body = box?.closest<HTMLElement>(".body");
    if (!block || !box || !body) return;
    const fig = block.figure as FigureData;
    if (fig.placement) { await this.change({ placement: null, align: "center" }, "picture in line"); announce("The picture is in line with the text again."); return; }
    const b = this.ed.page.rectOf(body);
    const r = this.ed.page.rectOf(box);
    const placement: FigurePlacement = { mode: "floating", anchor: "page", x_mm: halfMm((r.left - b.left) / MM_PX), y_mm: halfMm((r.top - b.top) / MM_PX), wrap: "none", layer: "in_front_of_text" };
    await this.change({ placement, align: null }, "move picture freely");
    announce("The picture can be dragged anywhere on the page. The text no longer flows around it.");
  }

  private async toggleLayer(): Promise<void> {
    const place = this.block()?.figure?.placement;
    if (!place) return;
    const layer = place.layer === "behind_text" ? "in_front_of_text" : "behind_text";
    await this.change({ placement: { ...place, layer, wrap: "none" } }, "picture layer");
    announce(layer === "behind_text" ? "The picture is behind the text." : "The picture is in front of the text.");
  }

  /* ------------------------------------------------------------------------------------------------------ dragging */
  private showTip(text: string): void { if (this.tip) { this.tip.textContent = text; this.tip.hidden = false; } }
  private hideTip(): void { if (this.tip) this.tip.hidden = true; }

  private drag(e: PointerEvent, capture: Element, onMove: (ev: PointerEvent) => void, onEnd: (ev: PointerEvent, ok: boolean) => void): void {
    e.preventDefault();
    e.stopPropagation();
    capture.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => onMove(ev);
    const finish = (ev: PointerEvent, ok: boolean): void => {
      capture.removeEventListener("pointermove", move as EventListener);
      capture.removeEventListener("pointerup", up as EventListener);
      capture.removeEventListener("pointercancel", cancel as EventListener);
      this.hideTip();
      onEnd(ev, ok);
    };
    const up = (ev: PointerEvent): void => finish(ev, true);
    const cancel = (ev: PointerEvent): void => finish(ev, false);
    capture.addEventListener("pointermove", move as EventListener);
    capture.addEventListener("pointerup", up as EventListener);
    capture.addEventListener("pointercancel", cancel as EventListener);
  }

  /** Dragging the picture: in line with the text it moves to where the pointer drops it among the blocks; free on the page it goes where the pointer goes. */
  private startMove(e: PointerEvent, surface: Element): void {
    if (e.button !== 0) return;
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    const figEl = this.el<HTMLElement>("figure.fig");
    const body = box?.closest<HTMLElement>(".body");
    if (!block || !box || !figEl || !body) return;
    const fig = block.figure as FigureData;
    const place = fig.placement;
    const z = this.ed.page.zoom;
    const startX = e.clientX;
    const startY = e.clientY;
    const bodyRect = this.ed.page.rectOf(body);
    const boxRect = this.ed.page.rectOf(box);
    const x0 = place?.x_mm ?? 0;
    const y0 = place?.y_mm ?? 0;
    let moved = false;
    let nx = x0;
    let ny = y0;
    let target: { id: string; before: boolean } | null = null;
    const clearMarks = (): void => this.ed.host.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    this.drag(e, surface, (ev) => {
      const dx = (ev.clientX - startX) / z;
      const dy = (ev.clientY - startY) / z;
      if (!moved && Math.hypot(dx, dy) * z < 4) return;
      moved = true;
      if (place) {
        nx = clamp(x0 + dx / MM_PX, 0, (bodyRect.width - boxRect.width) / MM_PX);
        ny = clamp(y0 + dy / MM_PX, 0, (bodyRect.height - boxRect.height) / MM_PX);
        figEl.style.setProperty("left", `${nx * MM_PX}px`);
        figEl.style.setProperty("top", `${ny * MM_PX}px`);
        this.refresh();
        this.showTip(`${halfMm(nx)} mm from the left, ${halfMm(ny)} mm from the top`);
        return;
      }
      clearMarks();
      const hit = document.elementsFromPoint(ev.clientX, ev.clientY).find((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("blk") && n.dataset["id"] !== this.id && !n.hasAttribute("data-floating"));
      target = null;
      if (hit) {
        const r = hit.getBoundingClientRect();
        const before = ev.clientY < r.top + r.height / 2;
        hit.classList.add(before ? "drop-before" : "drop-after");
        target = { id: hit.dataset["id"] as string, before };
      }
    }, (ev, ok) => {
      clearMarks();
      if (!moved || !ok) { this.refresh(); return; }
      if (place) { void this.change({ placement: { ...place, x_mm: halfMm(nx), y_mm: halfMm(ny) } }, "move picture"); return; }
      this.refresh();
      if (!target || !this.id) return;
      const order = this.ed.model.order;
      const at = order.indexOf(target.id);
      const after = target.before ? (at > 0 ? (order[at - 1] as string) : null) : target.id;
      void A.moveBlocksTo(this.ed, [this.id], after);
      void ev;
    });
  }

  private startResize(e: PointerEvent, corner: Corner): void {
    if (e.button !== 0) return;
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    const frame = this.el<HTMLElement>(".fig-frame");
    const img = this.el<HTMLImageElement>(".fig-img");
    const figEl = this.el<HTMLElement>("figure.fig");
    const body = box?.closest<HTMLElement>(".body");
    if (!block || !box || !frame || !img || !figEl || !body) return;
    const fig = block.figure as FigureData;
    const natural = this.natural();
    const maxPx = this.maxPx(block);
    const r = this.ed.page.rectOf(box);
    const bodyRect = this.ed.page.rectOf(body);
    const anchor = { x: corner.includes("w") ? r.left + r.width : r.left, y: corner.includes("n") ? r.top + r.height : r.top };
    let width = fig.width_mm ?? figureMetrics(fig, natural, maxPx).frameW / MM_PX;
    let place = fig.placement;
    const el = e.currentTarget as Element;
    this.drag(e, el, (ev) => {
      const p = this.ed.page.toPage(ev.clientX, ev.clientY);
      const wanted = clamp(Math.abs(p.x - anchor.x), 24, maxPx);
      width = widthForBox(fig, natural, wanted);
      const preview: FigureData = { ...fig, width_mm: width };
      delete preview.height_mm;
      const m = paintFigure(box, frame, img, preview, maxPx);
      if (place) {
        const left = corner.includes("w") ? anchor.x - m.boxW : anchor.x;
        const top = corner.includes("n") ? anchor.y - m.boxH : anchor.y;
        place = { ...place, x_mm: halfMm((left - bodyRect.left) / MM_PX), y_mm: halfMm((top - bodyRect.top) / MM_PX) };
        figEl.style.setProperty("left", `${place.x_mm * MM_PX}px`);
        figEl.style.setProperty("top", `${place.y_mm * MM_PX}px`);
      }
      this.refresh();
      this.showTip(`${Math.round(width)} mm wide`);
    }, (_ev, ok) => {
      if (!ok) { paintFigure(box, frame, img, fig, maxPx); this.refresh(); return; }
      const props: Record<string, unknown> = { width_mm: width, height_mm: null };
      if (place) props["placement"] = place;
      void this.change(props, "resize picture");
    });
  }

  private keyResize(e: KeyboardEvent): void {
    const fig = this.block()?.figure;
    if (!fig) return;
    const step = e.shiftKey ? 10 : 1;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "+" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "-" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    const current = fig.width_mm ?? figureMetrics(fig, this.natural(), 0).frameW / MM_PX;
    void this.change({ width_mm: clamp(Math.round(current + delta), 5, 5000), height_mm: null }, "resize picture");
  }

  private startTurn(e: PointerEvent): void {
    if (e.button !== 0) return;
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    const frame = this.el<HTMLElement>(".fig-frame");
    const img = this.el<HTMLImageElement>(".fig-img");
    if (!block || !box || !frame || !img) return;
    const fig = block.figure as FigureData;
    const maxPx = this.maxPx(block);
    const r = this.ed.page.rectOf(box);
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const angle = (p: { x: number; y: number }): number => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
    const start = angle(this.ed.page.toPage(e.clientX, e.clientY));
    const base = fig.rotation_deg ?? 0;
    let turn = base;
    this.drag(e, e.currentTarget as Element, (ev) => {
      const raw = base + (angle(this.ed.page.toPage(ev.clientX, ev.clientY)) - start);
      turn = normaliseTurn(ev.shiftKey ? Math.round(raw / 15) * 15 : Math.round(raw));
      paintFigure(box, frame, img, { ...fig, rotation_deg: turn }, maxPx);
      this.refresh();
      this.showTip(`${turn}°`);
    }, (_ev, ok) => {
      if (!ok) { paintFigure(box, frame, img, fig, maxPx); this.refresh(); return; }
      void this.change({ rotation_deg: turn === 0 ? null : turn }, "turn picture");
    });
  }

  private keyTurn(e: KeyboardEvent): void {
    const step = e.shiftKey ? 15 : 1;
    const by = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!by) return;
    e.preventDefault();
    e.stopPropagation();
    void this.turn(by);
  }

  private startCrop(e: PointerEvent, edge: Edge): void {
    if (e.button !== 0) return;
    const block = this.block();
    const box = this.el<HTMLElement>(".fig-box");
    const frame = this.el<HTMLElement>(".fig-frame");
    const img = this.el<HTMLImageElement>(".fig-img");
    if (!block || !box || !frame || !img) return;
    const fig = block.figure as FigureData;
    const natural = this.natural();
    const maxPx = this.maxPx(block);
    const m0 = figureMetrics(fig, natural, maxPx);
    const crop0 = cropOf(fig);
    const rad = (m0.rotation * Math.PI) / 180;
    const start = this.ed.page.toPage(e.clientX, e.clientY);
    let next: FigureData = fig;
    this.drag(e, e.currentTarget as Element, (ev) => {
      const p = this.ed.page.toPage(ev.clientX, ev.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      // the pointer's movement along the picture's own (turned) axes
      const local = edge === "left" || edge === "right" ? dx * Math.cos(rad) + dy * Math.sin(rad) : -dx * Math.sin(rad) + dy * Math.cos(rad);
      const crop = cropAfterDrag(fig, natural, edge, local);
      const widthPx = m0.frameW * ((crop.right - crop.left) / (crop0.right - crop0.left));
      next = { ...fig, crop, width_mm: widthPx / MM_PX / m0.shrink };
      delete next.height_mm;
      paintFigure(box, frame, img, next, maxPx);
      this.refresh();
      this.showTip(`${Math.round((crop.right - crop.left) * 100)}% wide, ${Math.round((crop.bottom - crop.top) * 100)}% high`);
    }, (_ev, ok) => {
      if (!ok || next === fig) { paintFigure(box, frame, img, fig, maxPx); this.refresh(); return; }
      const whole = next.crop && next.crop.left === 0 && next.crop.top === 0 && next.crop.right === 1 && next.crop.bottom === 1;
      void this.change({ crop: whole ? null : next.crop ?? null, width_mm: Math.round((next.width_mm ?? 0) * 2) / 2, height_mm: null }, "crop picture");
    });
  }

  private keyCrop(e: KeyboardEvent, edge: Edge): void {
    const fig = this.block()?.figure;
    if (!fig) return;
    const inward = (edge === "left" && e.key === "ArrowRight") || (edge === "right" && e.key === "ArrowLeft") || (edge === "top" && e.key === "ArrowDown") || (edge === "bottom" && e.key === "ArrowUp");
    const outward = (edge === "left" && e.key === "ArrowLeft") || (edge === "right" && e.key === "ArrowRight") || (edge === "top" && e.key === "ArrowUp") || (edge === "bottom" && e.key === "ArrowDown");
    if (!inward && !outward) return;
    e.preventDefault();
    e.stopPropagation();
    const natural = this.natural();
    const m0 = figureMetrics(fig, natural, 0);
    const crop0 = cropOf(fig);
    const amount = (e.shiftKey ? 10 : 2) * (inward ? 1 : -1);
    const delta = edge === "right" || edge === "bottom" ? -amount : amount;
    const crop = cropAfterDrag(fig, natural, edge, delta);
    const widthPx = m0.frameW * ((crop.right - crop.left) / (crop0.right - crop0.left));
    void this.change({ crop, width_mm: Math.round((widthPx / MM_PX) * 2) / 2, height_mm: null }, "crop picture");
  }

  /* ------------------------------------------------------------------------------------------------------ keyboard */
  /** With a free picture selected, the arrow keys nudge it half a millimetre (five with Shift). */
  private onKey(e: KeyboardEvent): void {
    const block = this.block();
    const place = block?.figure?.placement;
    if (!block || !place) return;
    if ((e.target as Element).closest("[data-edit], input, textarea, [role=toolbar]")) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "]" || e.key === "[")) {      // Canva: forward / backward
      e.preventDefault();
      e.stopPropagation();
      const layer = e.key === "]" ? "in_front_of_text" : "behind_text";
      if (place.layer !== layer) void this.change({ placement: { ...place, layer, wrap: "none" } }, "picture layer");
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 5 : 0.5;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    e.stopPropagation();
    void this.change({ placement: { ...place, x_mm: halfMm(place.x_mm + dx), y_mm: halfMm(place.y_mm + dy) } }, "move picture");
  }
}
