import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cropAfterDrag, figureMetrics, widthForBox } from "../src/client/figlayout.js";
import { DocModel, layerList, layerOf } from "../src/client/model.js";
import { MM_PX } from "../src/client/textops.js";

const fig = (extra: Record<string, unknown> = {}) => ({ asset: "img-1", alt: "x", width_mm: 100, ...extra }) as never;
const natural = { w: 400, h: 200 };
const close = (a: number, b: number, eps = 0.01): void => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

describe("picture layout from the .sldc properties", () => {
  it("a plain picture is as wide as width_mm and keeps its proportions", () => {
    const m = figureMetrics(fig(), natural, 0);
    close(m.frameW, 100 * MM_PX); close(m.frameH, 50 * MM_PX);
    close(m.boxW, m.frameW); close(m.boxH, m.frameH);
    close(m.imgLeft, 0);
  });
  it("width_mm and height_mm are a box the picture fits inside", () => {
    const m = figureMetrics(fig({ width_mm: 100, height_mm: 20 }), natural, 0);
    close(m.frameH, 20 * MM_PX); close(m.frameW, 40 * MM_PX);
  });
  it("a crop shows only that part and keeps the scale of the rest", () => {
    const m = figureMetrics(fig({ crop: { left: 0.25, top: 0, right: 0.75, bottom: 1 }, width_mm: 50 }), natural, 0);
    close(m.frameW, 50 * MM_PX);
    close(m.imgW, 100 * MM_PX);                     // the whole picture is twice the visible width
    close(m.imgLeft, -25 * MM_PX);                   // a quarter of it lies outside, on the left
  });
  it("a turn by 90 degrees swaps the space the picture takes; mirroring does not change the size", () => {
    const m = figureMetrics(fig({ rotation_deg: 90, flip_horizontal: true }), natural, 0);
    close(m.boxW, 50 * MM_PX, 0.05); close(m.boxH, 100 * MM_PX, 0.05);
    assert.equal(m.flipX, true);
  });
  it("a picture wider than the line is shrunk to fit, proportions kept", () => {
    const m = figureMetrics(fig({ width_mm: 300 }), natural, 400);
    close(m.boxW, 400); close(m.boxH, 200); close(m.shrink, 400 / (300 * MM_PX));
  });
  it("widthForBox finds the width that gives a wanted box, also when the picture is turned", () => {
    close(widthForBox(fig(), natural, 200 * MM_PX) * MM_PX, 200 * MM_PX, 2);
    const turned = widthForBox(fig({ rotation_deg: 90 }), natural, 40 * MM_PX);
    close(figureMetrics(fig({ rotation_deg: 90, width_mm: turned }), natural, 0).boxW, 40 * MM_PX, 2);
  });
  it("dragging the left edge to the right crops from the left; a mirrored picture crops its other side", () => {
    const plain = cropAfterDrag(fig(), natural, "left", 0.25 * 100 * MM_PX);
    close(plain.left, 0.25); assert.equal(plain.right, 1);
    const mirrored = cropAfterDrag(fig({ flip_horizontal: true }), natural, "left", 0.25 * 100 * MM_PX);
    close(mirrored.right, 0.75); assert.equal(mirrored.left, 0);
  });
  it("a crop never empties the picture and never goes beyond it", () => {
    const c = cropAfterDrag(fig(), natural, "right", -10_000);
    assert.ok(c.right > c.left && c.left === 0);
    const d = cropAfterDrag(fig(), natural, "left", -10_000);
    assert.equal(d.left, 0);
  });
});

describe("header and footer positions and layers", () => {
  const state = (page: Record<string, unknown>, ext: Record<string, unknown> = {}) => ({
    sid: "s", version: 1, dirty: false, readOnly: false, access: { canEdit: true },
    document: { title: "T", sections: [{ id: "s1", page: { size: "A4", margins_mm: { top: 25, right: 25, bottom: 25, left: 25 }, ...page } }], extensions: { "slai.writer": ext } },
    blocks: [], comments: [], stats: { words: 0, characters: 0, blocks: 0 }, undo: 0, redo: 0, revision: { number: 1 }, signatures: 0, notices: [],
  }) as never;
  it("the header and footer sit in the middle of their margin until the document says otherwise", () => {
    const g = new DocModel(state({})).geometry("s1");
    assert.equal(g.headerMm, 9.5); assert.equal(g.footerMm, 9.5);
  });
  it("header_mm and footer_mm from the page are used", () => {
    const g = new DocModel(state({ header_mm: 14, footer_mm: 6 })).geometry("s1");
    assert.equal(g.headerMm, 14); assert.equal(g.footerMm, 6);
  });
  it("a block is on the layer of its kind unless it was moved; a layer that no longer exists is ignored", () => {
    const ext = { layers: [{ id: "layer-1", name: "Layer 1", visible: true, custom: true }], layer_of: { a: "layer-1", b: "gone" } };
    assert.equal(layerOf({ id: "a", type: "paragraph", text: "" }, ext), "layer-1");
    assert.equal(layerOf({ id: "b", type: "paragraph", text: "" }, ext), "text");
    assert.equal(layerOf({ id: "c", type: "figure", text: "" }, ext), "illustrations");
    assert.deepEqual(layerList(ext).map((l) => l.id), ["text", "illustrations", "layer-1"]);
    assert.equal(layerList({ layers: [{ id: "text", name: "Text", visible: false }] }).find((l) => l.id === "text")?.visible, false);
  });
});
