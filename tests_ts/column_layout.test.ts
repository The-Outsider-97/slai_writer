import assert from "node:assert/strict";
import test from "node:test";
import { columnSpec, groupMembers, pageGroups, regionCss } from "../src/client/column_layout.js";
import type { DocMeta } from "../src/client/types.js";

const page = { size: "A4", margins_mm: { top: 25, right: 25, bottom: 25, left: 25 } };
const meta = (sections: DocMeta["sections"], layouts: Record<string, unknown> = {}): DocMeta =>
  ({ schema: "slai.sldc/1", id: "d", title: "t", language: "en", sections, extensions: { "slai.writer": { column_layouts: layouts } } }) as DocMeta;

test("a section of one column has no column spec", () => {
  assert.equal(columnSpec(meta([{ id: "s1", page }]), "s1"), null);
  assert.equal(columnSpec(meta([{ id: "s1", page }]), undefined), null);
});

test("columns, gap, rule, balance, flow and widths are read from section and layout", () => {
  const m = meta([{ id: "s1", page, columns: 3, column_gap_mm: 6 }], { s1: { rule: { color: "#112233", width_pt: 1, style: "dashed" }, widths_mm: [30, 60, 40], balance: true, flow: "rtl" } });
  const spec = columnSpec(m, "s1");
  assert.deepEqual(spec, { key: "s1", count: 3, gapMm: 6, widthsMm: [30, 60, 40], rule: { color: "#112233", width_pt: 1, style: "dashed" }, balance: true, rtl: true });
});

test("widths that do not match the column count are ignored", () => {
  const m = meta([{ id: "s1", page, columns: 2 }], { s1: { widths_mm: [30, 60, 40] } });
  assert.equal(columnSpec(m, "s1")?.widthsMm, undefined);
  assert.equal(columnSpec(m, "s1")?.gapMm, 10);
});

test("a continuous section with the same page joins the page group of the section before it", () => {
  const m = meta([{ id: "s1", page }, { id: "s2", page, columns: 2 }, { id: "s3", page }, { id: "s4", page: { size: "A5" } }, { id: "s5", page: { size: "A5" } }],
    { s2: { continuous: true }, s3: { continuous: true }, s4: { continuous: true }, s5: {} });
  const groups = pageGroups(m);
  assert.deepEqual([...groups], [["s1", "s1"], ["s2", "s1"], ["s3", "s1"], ["s4", "s4"], ["s5", "s5"]]);
  assert.deepEqual(groupMembers(m, "s2"), ["s1", "s2", "s3"]);
  assert.deepEqual(groupMembers(m, "s5"), ["s5"]);
});

test("page setups are compared by content, not by key order", () => {
  const m = meta([{ id: "s1", page: { size: "A4", orientation: "portrait" } }, { id: "s2", page: { orientation: "portrait", size: "A4" } }], { s2: { continuous: true } });
  assert.equal(pageGroups(m).get("s2"), "s1");
});

test("region CSS carries count, gap, fill and the line", () => {
  const css = regionCss({ key: "s1", count: 2, gapMm: 10, balance: false, rtl: false, rule: { color: "#000000", width_pt: 0.75, style: "solid" } }, 4);
  assert.equal(css["column-count"], "2");
  assert.equal(css["column-gap"], "40px");
  assert.equal(css["column-fill"], "auto");
  assert.match(css["column-rule"] ?? "", /solid #000000$/);
});
