/** How a picture is laid out from its .sldc properties: the part of the picture that shows (crop), its size, its turn and mirroring. Pure arithmetic, so it can be tested
 *  without a browser. Units are CSS pixels at 100 % (the page's own units). Meaning of the properties, from the format:
 *  - crop is a rectangle of the original picture, each side 0 to 1;
 *  - width_mm and height_mm are a display box; the picture keeps its proportions inside it;
 *  - rotation_deg turns clockwise about the centre; mirroring happens before the turn. */
import { MM_PX } from "./textops.js";
import type { FigureCrop, FigureData } from "./types.js";

export const DEFAULT_WIDTH_MM = 120;
export const WHOLE: FigureCrop = { left: 0, top: 0, right: 1, bottom: 1 };

export interface FigureMetrics {
  /** The visible part of the picture, before it is turned. */
  frameW: number; frameH: number;
  /** The space the picture takes in the text: the frame's bounding box once turned. */
  boxW: number; boxH: number;
  /** The whole original picture, scaled, and where it sits inside the frame (negative: the cropped part lies outside). */
  imgW: number; imgH: number; imgLeft: number; imgTop: number;
  rotation: number; flipX: boolean; flipY: boolean;
  /** Below 1 when the picture had to be shrunk to fit the line. */
  shrink: number;
}

export function cropOf(fig: FigureData): FigureCrop { return fig.crop ?? WHOLE; }

export function figureMetrics(fig: FigureData, natural: { w: number; h: number }, maxPx: number): FigureMetrics {
  const crop = cropOf(fig);
  const cw = Math.max(0.001, crop.right - crop.left);
  const ch = Math.max(0.001, crop.bottom - crop.top);
  const nw = natural.w > 0 ? natural.w : 4;                    // until the picture has loaded, assume 4:3
  const nh = natural.h > 0 ? natural.h : 3;
  const aspect = (cw * nw) / (ch * nh);
  const wReq = fig.width_mm !== undefined ? fig.width_mm * MM_PX : undefined;
  const hReq = fig.height_mm !== undefined ? fig.height_mm * MM_PX : undefined;
  let frameW = wReq !== undefined && hReq !== undefined ? Math.min(wReq, hReq * aspect) : wReq ?? (hReq !== undefined ? hReq * aspect : DEFAULT_WIDTH_MM * MM_PX);
  let frameH = frameW / aspect;
  const rad = ((fig.rotation_deg ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  let boxW = frameW * cos + frameH * sin;
  let boxH = frameW * sin + frameH * cos;
  let shrink = 1;
  if (maxPx > 0 && boxW > maxPx) { shrink = maxPx / boxW; frameW *= shrink; frameH *= shrink; boxW *= shrink; boxH *= shrink; }
  const imgW = frameW / cw;
  const imgH = frameH / ch;
  return { frameW, frameH, boxW, boxH, imgW, imgH, imgLeft: -crop.left * imgW, imgTop: -crop.top * imgH, rotation: fig.rotation_deg ?? 0, flipX: fig.flip_horizontal === true, flipY: fig.flip_vertical === true, shrink };
}

/** Which width in millimetres makes the turned bounding box `boxPx` wide. */
export function widthForBox(fig: FigureData, natural: { w: number; h: number }, boxPx: number): number {
  const base = figureMetrics({ ...fig, width_mm: 100, height_mm: undefined }, natural, 0);
  return Math.max(5, Math.min(5000, Math.round(((100 * boxPx) / base.boxW) * 2) / 2));
}

/** Round to the half millimetre the page uses everywhere. */
export const halfMm = (mm: number): number => Math.round(mm * 2) / 2;

/** The crop after the edge `side` of the visible frame moved by `dx` pixels along the frame's own x axis (`dy` for the top and bottom edges). */
export function cropAfterDrag(fig: FigureData, natural: { w: number; h: number }, side: "left" | "right" | "top" | "bottom", delta: number): FigureCrop {
  const m = figureMetrics(fig, natural, 0);
  const crop = { ...cropOf(fig) };
  const flipped = side === "left" || side === "right" ? m.flipX : m.flipY;
  const source: "left" | "right" | "top" | "bottom" = flipped ? ({ left: "right", right: "left", top: "bottom", bottom: "top" } as const)[side] : side;
  const unit = source === "left" || source === "right" ? m.imgW : m.imgH;
  const sign = flipped ? -1 : 1;
  const move = (sign * delta) / unit;
  const gap = 0.05;
  if (source === "left") crop.left = Math.max(0, Math.min(crop.right - gap, crop.left + move));
  else if (source === "right") crop.right = Math.min(1, Math.max(crop.left + gap, crop.right + move));
  else if (source === "top") crop.top = Math.max(0, Math.min(crop.bottom - gap, crop.top + move));
  else crop.bottom = Math.min(1, Math.max(crop.top + gap, crop.bottom + move));
  return { left: round4(crop.left), top: round4(crop.top), right: round4(crop.right), bottom: round4(crop.bottom) };
}
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Put the picture's elements in place. `box` takes the space in the text, `frame` is the visible part (turned and mirrored), `img` the whole picture inside it. */
export function paintFigure(box: HTMLElement, frame: HTMLElement, img: HTMLImageElement, fig: FigureData, maxPx: number): FigureMetrics {
  const m = figureMetrics(fig, { w: img.naturalWidth, h: img.naturalHeight }, maxPx);
  const px = (n: number): string => `${Math.round(n * 100) / 100}px`;
  box.style.setProperty("width", px(m.boxW));
  box.style.setProperty("height", px(m.boxH));
  frame.style.setProperty("width", px(m.frameW));
  frame.style.setProperty("height", px(m.frameH));
  frame.style.setProperty("left", px((m.boxW - m.frameW) / 2));
  frame.style.setProperty("top", px((m.boxH - m.frameH) / 2));
  const turn = [m.rotation ? `rotate(${m.rotation}deg)` : "", m.flipX || m.flipY ? `scale(${m.flipX ? -1 : 1}, ${m.flipY ? -1 : 1})` : ""].filter(Boolean).join(" ");
  if (turn) frame.style.setProperty("transform", turn); else frame.style.removeProperty("transform");
  img.style.setProperty("width", px(m.imgW));
  img.style.setProperty("height", px(m.imgH));
  img.style.setProperty("left", px(m.imgLeft));
  img.style.setProperty("top", px(m.imgTop));
  return m;
}
