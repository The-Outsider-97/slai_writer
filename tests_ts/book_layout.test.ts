import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { arrange, clampPerRow, extent, fitFraction, groupTarget, pagesInRow, rowOf, sideOf } from "../src/client/arrangement.js";
import { bookOf, contentSize, documentIsBook, effectiveMargins, lineNames, problem, runningBand, storedFromLine } from "../src/client/book_layout.js";
import { geometryFor, DocModel } from "../src/client/model.js";
import type { BookLayout, DocMeta, Margins } from "../src/client/types.js";

interface Case { name: string; page: { size?: string; orientation?: string; margins_mm?: Partial<Margins> }; book?: BookLayout; expect: Record<string, Margins> }
const cases = (JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "margin_cases.json"), "utf8")) as { cases: Case[] }).cases;

test("the editor, the server and the writers share one margin table", () => {
  for (const c of cases) {
    const m = c.page.margins_mm ?? {};
    const stored: Margins = { top: m.top ?? 25, bottom: m.bottom ?? 25, left: m.left ?? 25, right: m.right ?? 25 };
    for (const [physical, expected] of Object.entries(c.expect)) {
      assert.deepEqual(effectiveMargins(stored, c.book, Number(physical)), expected, `${c.name}, page ${physical}`);
    }
  }
});

test("the gutter is counted once and the text area is the same on every page", () => {
  const stored = { top: 25, bottom: 25, left: 20, right: 15 };
  const book: BookLayout = { mirror: true, gutter_mm: 5 };
  const a = contentSize(210, 297, stored, book);
  assert.equal(a.width, 210 - 20 - 15 - 5);
  for (const page of [1, 2, 3, 4]) {
    const m = effectiveMargins(stored, book, page);
    assert.equal(210 - m.left - m.right, a.width);
  }
  assert.deepEqual(stored, { top: 25, bottom: 25, left: 20, right: 15 });
});

test("a dragged margin line changes the setting it stands for, not the gutter", () => {
  const stored = { top: 25, bottom: 25, left: 20, right: 15 };
  const book: BookLayout = { mirror: true, gutter_mm: 5 };
  // page 1 (right-hand): its left line is the inside margin plus the gutter
  assert.deepEqual(storedFromLine(stored, book, 1, "left", 30), { key: "left", value: 25 });
  assert.deepEqual(storedFromLine(stored, book, 1, "right", 18), { key: "right", value: 18 });
  // page 2 (left-hand): its right line is the inside margin plus the gutter, its left line the outside margin
  assert.deepEqual(storedFromLine(stored, book, 2, "right", 30), { key: "left", value: 25 });
  assert.deepEqual(storedFromLine(stored, book, 2, "left", 12), { key: "right", value: 12 });
  assert.deepEqual(storedFromLine(stored, { gutter_mm: 10 }, 1, "left", 30), { key: "left", value: 20 });
  assert.deepEqual(lineNames(book, 2), { left: "Outside margin", right: "Inside margin" });
  assert.deepEqual(lineNames(undefined, 2), { left: "Left margin", right: "Right margin" });
});

test("a layout that leaves no room for text is refused with a reason", () => {
  assert.equal(problem(210, 297, { top: 25, bottom: 25, left: 20, right: 15 }, { mirror: true, gutter_mm: 5 }), null);
  assert.match(problem(210, 297, { top: 25, bottom: 25, left: 90, right: 90 }, { gutter_mm: 10 }) ?? "", /less than 25 mm/);
  assert.match(problem(210, 297, { top: 25, bottom: 25, left: 20, right: -1 }, undefined) ?? "", /valid/);
  assert.match(problem(210, 297, { top: 25, bottom: 25, left: 20, right: 20 }, { gutter_mm: 150 }) ?? "", /at most 100/);
});

test("the geometry of a section reads the book layout, and a sheet gets the margins of its side", () => {
  const meta = { schema: "s", id: "d", title: "t", language: "en",
    sections: [{ id: "s1", page: { size: "A4", margins_mm: { top: 25, bottom: 25, left: 20, right: 15 } } }, { id: "s2", page: { size: "A4" } }],
    extensions: { "slai.writer": { book_layouts: { s1: { mirror: true, gutter_mm: 5 } } } } } as unknown as DocMeta;
  assert.equal(documentIsBook(meta), true);
  assert.equal(bookOf(meta, "s2"), undefined);
  const model = new DocModel({ sid: "s", version: 1, document: meta, access: { role: "owner" }, blocks: [], comments: [], stats: { words: 0, characters: 0, blocks: 0 }, undo: 0, redo: 0, revision: { number: 1 }, signatures: 0, notices: [] } as never);
  const g = model.geometry("s1");
  assert.deepEqual(g.stored, { top: 25, bottom: 25, left: 20, right: 15 });
  assert.equal(g.margins.left, 25);
  assert.equal(geometryFor(g, 2).margins.left, 15);
  assert.equal(geometryFor(g, 2).margins.right, 25);
  assert.equal(model.geometry("s2").margins.left, 25);
});

/* ----------------------------------------------------------------------------------------------------- arrangement */
test("pages are grouped in order; an incomplete last group is not padded or repeated", () => {
  const a = arrange(7, 3, false);
  assert.deepEqual(a.rows.map((r) => r.map((s) => s.page)), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(arrange(5, 4, false).rows.map((r) => r.map((s) => s.page)), [[0, 1, 2, 3], [4]]);
  assert.deepEqual(arrange(3, 1, false).rows.map((r) => r.map((s) => s.page)), [[0], [1], [2]]);
  assert.deepEqual(arrange(0, 2, false).rows, []);
  const seen = arrange(11, 4, false).rows.flat().map((s) => s.page);
  assert.equal(new Set(seen).size, 11);
});

test("the book view starts with an empty slot, then 2-3, 4-5; the slot is not a page", () => {
  const a = arrange(6, 2, true);
  assert.equal(a.facing, true);
  assert.deepEqual(a.rows.map((r) => r.map((s) => s.page)), [[null, 0], [1, 2], [3, 4], [5]]);
  assert.deepEqual(pagesInRow(a, 0), [0]);
  assert.equal(a.rows.flat().filter((s) => s.page !== null).length, 6);
  // physical page numbers (1-based) of a spread: left-hand pages are even
  assert.equal(sideOf(1), "right");
  assert.equal(sideOf(2), "left");
  assert.equal(sideOf(3), "right");
  assert.equal(arrange(0, 2, true).facing, false);
  assert.equal(arrange(1, 2, true).rows.length, 1);
});

test("group navigation moves by rows and stays inside the document", () => {
  const a = arrange(9, 3, false);
  assert.equal(rowOf(a, 4), 1);
  assert.equal(groupTarget(a, 4, 1), 6);
  assert.equal(groupTarget(a, 4, -1), 0);
  assert.equal(groupTarget(a, 0, -1), 0);
  assert.equal(groupTarget(a, 8, 5), 6);
  const book = arrange(6, 2, true);
  assert.equal(groupTarget(book, 0, 1), 1);
  assert.equal(groupTarget(book, 2, 1), 3);
});

test("fit-to-window uses the widest row and the tallest page, and clamps to the zoom range", () => {
  const boxes = Array.from({ length: 4 }, () => ({ widthMm: 210, heightMm: 297 }));
  const one = arrange(4, 1, false), two = arrange(4, 2, false);
  const view = { width: 1000, height: 800 };
  const px = 96 / 25.4;
  assert.ok(Math.abs(fitFraction("width", one, boxes, view, px) - 1000 / (210 * px)) < 1e-9);
  assert.ok(Math.abs(fitFraction("width", two, boxes, view, px) - 1000 / (420 * px)) < 1e-9);
  assert.ok(Math.abs(fitFraction("height", two, boxes, view, px) - 800 / (297 * px)) < 1e-9);
  assert.equal(fitFraction("entire", two, boxes, view, px), Math.min(fitFraction("width", two, boxes, view, px), fitFraction("height", two, boxes, view, px)));
  assert.equal(fitFraction("width", one, boxes, { width: 1e9, height: 1e9 }, px), 4);
  assert.equal(fitFraction("width", arrange(0, 1, false), [], view, px), 1);
  const mixed = [{ widthMm: 210, heightMm: 297 }, { widthMm: 297, heightMm: 210 }];                           // original sizes are kept
  assert.equal(extent(arrange(2, 2, false), mixed, 0, 0).width, 507);
  assert.equal(extent(arrange(2, 2, false), mixed, 0, 0).tallest, 297);
  assert.equal(clampPerRow(9), 4);
  assert.equal(clampPerRow(0), 1);
  assert.equal(clampPerRow("x"), 1);
});

test("odd and even pages: a left-hand page shows its own text, a band without any falls back to the ordinary one, swapped in a mirrored section", () => {
  const ordinary = { left: "Title", right: "{page}", formats: { left: { bold: true } } } as never;
  const on: BookLayout = { odd_even: true, header_even: { left: "Even" } };
  assert.deepEqual(runningBand("header", ordinary, on, 1), { spec: ordinary, flipped: false }, "a right-hand page keeps the ordinary header");
  const even = runningBand("header", ordinary, on, 2);
  assert.deepEqual(even.spec, { left: "Even", formats: { left: { bold: true } } });
  assert.equal(even.flipped, false);
  assert.deepEqual(runningBand("footer", ordinary, on, 2), { spec: ordinary, flipped: false }, "no even footer: the ordinary one, not swapped without mirroring");
  assert.deepEqual(runningBand("footer", ordinary, { ...on, mirror: true }, 2), { spec: ordinary, flipped: true }, "mirrored: swapped");
  assert.deepEqual(runningBand("footer", ordinary, { ...on, mirror: true, mirror_edges: false }, 2), { spec: ordinary, flipped: false });
  assert.equal(runningBand("header", ordinary, { header_even: { left: "Even" } }, 2).spec, ordinary, "even text is ignored while the setting is off");
  assert.equal(runningBand("header", ordinary, { odd_even: true, header_even: {} }, 4).spec, ordinary, "an empty even band is no band");
  assert.equal(runningBand("header", undefined, on, 3).spec, undefined);
  for (const page of [1, 3, 5, 7]) assert.equal(runningBand("header", ordinary, on, page).spec, ordinary);
  for (const page of [2, 4, 6, 8]) assert.equal(runningBand("header", ordinary, on, page).spec?.left, "Even");
});
