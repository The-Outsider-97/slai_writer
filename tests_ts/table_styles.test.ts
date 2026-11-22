import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gridOf, rectOf, selectedRect, cornersOf } from "../src/client/table_geometry.js";
import { GALLERY, resolveTable, styleOptions } from "../src/client/table_style.js";
import type { TableData } from "../src/client/types.js";

const golden = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "table_style_golden.json"), "utf8")) as Record<string, {
  block: { table: TableData; extensions?: Record<string, unknown> }; expected: Record<string, unknown> }>;

test("the browser resolves every table look exactly as the server does", () => {
  const names = Object.keys(golden);
  assert.ok(names.length >= 18);
  for (const name of names) {
    const { block, expected } = golden[name] as (typeof golden)[string];
    const got = Object.fromEntries(resolveTable(block));
    assert.deepEqual(got, expected, name);
  }
});

test("the gallery has the twelve looks", () => {
  assert.deepEqual(GALLERY.map((g) => g.id), ["plain", "simple_grid", "minimal_borders", "horizontal_rules", "header_emphasis", "alternating_rows",
    "alternating_columns", "professional_report", "academic", "financial", "modern_accent", "dark_header"]);
  assert.equal(styleOptions(undefined).preset, "default");
  assert.equal(styleOptions({ preset: "nope" }).preset, "default");
  assert.equal(styleOptions({ preset: "custom:Mine" }, { Mine: { preset: "academic", banded_rows: true } }).banded_rows, true);
});

const merged = (): TableData => ({ columns: 4, header_rows: 1, rows: [
  [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
  [{ text: "e" }, { text: "m", colspan: 2, rowspan: 2 }, { text: "f" }],
  [{ text: "g" }, { text: "h" }],
  [{ text: "i" }, { text: "j" }, { text: "k" }, { text: "l" }]] });

test("grid positions follow merged cells", () => {
  const model = gridOf(merged());
  assert.equal(model.at(2, 1)?.cell.text, "m");
  assert.equal(model.at(2, 2)?.cell.text, "m");
  assert.deepEqual([model.at(2, 3)?.cell.text, model.at(2, 0)?.cell.text], ["h", "g"]);
  assert.deepEqual(model.byAddress(2, 1) && { c: model.byAddress(2, 1)?.c }, { c: 3 });
});

test("a selection grows to whole cells and gives back operation addresses", () => {
  const table = merged();
  const rect = selectedRect(table, { row: 0, col: 1 }, { row: 1, col: 1 });   // b down to the merged cell
  assert.deepEqual(rect, { r0: 0, c0: 1, r1: 3, c1: 3 });
  const model = gridOf(table);
  assert.deepEqual(cornersOf(model, rect as NonNullable<typeof rect>), { from: { row: 0, col: 1 }, to: { row: 1, col: 1 } });
  const a = model.at(0, 0), b = model.at(1, 2);
  assert.ok(a && b);
  assert.deepEqual(rectOf(model, a, b), { r0: 0, c0: 0, r1: 3, c1: 3 });
});
