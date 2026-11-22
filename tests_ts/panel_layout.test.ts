import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { arrange, pagesInRow } from "../src/client/arrangement.js";
import { conflicts, layoutSeams, SEAM_PAD, seamWidth, type OpenPanels, type SeamOptions } from "../src/client/panel_layout.js";

const none: OpenPanels = { red: null, yellow: null, embed: null };
const opts: SeamOptions = { tab: 20, panel: 300, gap: 28, facing: false };
const rowsOf = (count: number, perRow: 1 | 2 | 3 | 4, facing = false): number[][] => {
  const a = arrange(count, perRow, facing);
  return a.rows.map((_, row) => pagesInRow(a, row));
};

describe("which panels share a seam", () => {
  const rows = rowsOf(4, 2);
  it("Notes opening on the left page closes the Corrections of the page after it", () => {
    assert.deepEqual(conflicts(rows, { ...none, red: 1 }, "yellow", 0), ["red"]);
  });
  it("Corrections opening on the right page closes the Notes of the page before it", () => {
    assert.deepEqual(conflicts(rows, { ...none, yellow: 0 }, "red", 1), ["yellow"]);
  });
  it("panels on different seams do not conflict", () => {
    assert.deepEqual(conflicts(rows, { ...none, red: 3 }, "yellow", 0), []);
    assert.deepEqual(conflicts(rows, { ...none, yellow: 1 }, "red", 2), []);   // 1 is the end of row 1, 2 the start of row 2: no seam between them
  });
  it("the same kind never conflicts with itself, and the embed panel never conflicts", () => {
    assert.deepEqual(conflicts(rows, { ...none, yellow: 0 }, "yellow", 1), []);
    assert.deepEqual(conflicts(rows, { ...none, yellow: 0, red: 1 }, "embed", 0), []);
  });
  it("is symmetric: whichever opens second closes the other", () => {
    for (const [left, right] of [[0, 1], [2, 3]] as const) {
      assert.deepEqual(conflicts(rows, { ...none, red: right }, "yellow", left), ["red"]);
      assert.deepEqual(conflicts(rows, { ...none, yellow: left }, "red", right), ["yellow"]);
    }
  });
  it("works for three and four pages in a row", () => {
    const four = rowsOf(4, 4);
    assert.deepEqual(conflicts(four, { ...none, red: 2 }, "yellow", 1), ["red"]);
    assert.deepEqual(conflicts(four, { ...none, yellow: 2 }, "red", 3), ["yellow"]);
    assert.deepEqual(conflicts(four, { ...none, yellow: 0 }, "red", 3), []);
  });
  it("a single page in a row has no seam", () => {
    const one = rowsOf(3, 1);
    assert.deepEqual(conflicts(one, { ...none, red: 1 }, "yellow", 0), []);
  });
});

describe("seam widths", () => {
  it("closed tabs: both tabs and a gap fit between the pages, whatever the grid gap already gives", () => {
    assert.equal(seamWidth(none, 0, 1, opts), 2 * 20 + SEAM_PAD);
    const l = layoutSeams(rowsOf(4, 2), 4, none, opts);
    assert.deepEqual(l.margins, [0, 2 * 20 + SEAM_PAD - 28, 0, 2 * 20 + SEAM_PAD - 28]);
  });
  it("a grid gap that is already wide enough needs no margin", () => {
    const l = layoutSeams(rowsOf(2, 2), 2, none, { ...opts, tab: 6, gap: 28 });
    assert.deepEqual(l.margins, [0, 0]);
  });
  it("an open panel widens only its own seam, and by the width of the panel", () => {
    const base = layoutSeams(rowsOf(4, 2), 4, none, opts).margins;
    const left = layoutSeams(rowsOf(4, 2), 4, { ...none, yellow: 0 }, opts).margins;
    const right = layoutSeams(rowsOf(4, 2), 4, { ...none, red: 1 }, opts).margins;
    assert.deepEqual(left, [0, (base[1] as number) + 300, 0, base[3]]);
    assert.deepEqual(right, left);                                      // the same room, however it was asked for
  });
  it("three and four pages in a row: every seam has its tabs, only the seam of the open panel grows", () => {
    const l = layoutSeams(rowsOf(4, 4), 4, { ...none, yellow: 1 }, opts);
    const base = 2 * 20 + SEAM_PAD - 28;
    assert.deepEqual(l.margins, [0, base, base + 300, base]);
  });
  it("a panel beside the first or the last page of a row asks the window for room, not another page", () => {
    const rows = rowsOf(4, 2);
    assert.deepEqual(layoutSeams(rows, 4, { ...none, red: 0 }, opts).room, { left: 20 + SEAM_PAD + 300, right: 20 + SEAM_PAD });
    assert.deepEqual(layoutSeams(rows, 4, { ...none, yellow: 1 }, opts).room, { left: 20 + SEAM_PAD, right: 20 + SEAM_PAD + 300 });
    assert.deepEqual(layoutSeams(rows, 4, { ...none, red: 0, yellow: 3 }, opts).margins, layoutSeams(rows, 4, none, opts).margins);
  });
  it("the embed panel needs no room at the side", () => {
    const l = layoutSeams(rowsOf(4, 2), 4, { ...none, embed: 0 }, opts);
    assert.deepEqual(l.margins, layoutSeams(rowsOf(4, 2), 4, none, opts).margins);
    assert.deepEqual(l.room, { left: 26, right: 26 });
  });
  it("tabs that keep their size on screen make the seam wider when the page is zoomed out", () => {
    const at = (z: number) => layoutSeams(rowsOf(2, 2), 2, none, { ...opts, tab: Math.max(14, 15 / z) }).margins[1] as number;
    assert.ok(at(0.25) > at(0.5) && at(0.5) > at(1));
  });
});

describe("book view", () => {
  const rows = rowsOf(5, 2, true);                                          // [1], [2 3], [4 5]
  const book: SeamOptions = { ...opts, gap: 0, facing: true };
  it("closed: the pages of a spread touch and the tabs at the spine are not drawn", () => {
    const l = layoutSeams(rows, 5, none, book);
    assert.deepEqual(l.margins, [0, 0, 0, 0, 0]);
    assert.deepEqual([...l.hidden].sort(), ["red:2", "red:4", "yellow:1", "yellow:3"]);
  });
  it("opening a spine panel pushes the spread apart and brings its tab back", () => {
    const l = layoutSeams(rows, 5, { ...none, yellow: 1 }, book);
    assert.equal(l.margins[2], 300 + 20 + SEAM_PAD);
    assert.equal(l.margins[4], 0);
    assert.ok(!l.hidden.has("yellow:1") && l.hidden.has("red:2") && l.hidden.has("yellow:3"));
    const r = layoutSeams(rows, 5, { ...none, red: 4 }, book);
    assert.equal(r.margins[4], 300 + 20 + SEAM_PAD);
    assert.ok(!r.hidden.has("red:4") && r.hidden.has("yellow:3"));
  });
  it("outer tabs of a book are never hidden", () => {
    const l = layoutSeams(rows, 5, none, book);
    for (const key of ["red:0", "yellow:0", "red:1", "yellow:2", "red:3", "yellow:4"]) assert.ok(!l.hidden.has(key), key);
  });
});

describe("outside the seams", () => {
  it("no margins and no hidden tabs in a single column", () => {
    const l = layoutSeams(rowsOf(3, 1), 3, { ...none, yellow: 1 }, opts);
    assert.deepEqual(l.margins, [0, 0, 0]);
    assert.equal(l.hidden.size, 0);
    assert.deepEqual(l.room, { left: 26, right: 326 });
  });
  it("an empty document", () => {
    const l = layoutSeams([], 0, none, opts);
    assert.deepEqual(l.margins, []);
  });
});
