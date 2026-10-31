import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scopedTextRanges } from "../src/client/actions.js";
import type { Editor, Sel } from "../src/client/editor.js";
import type { Block } from "../src/client/types.js";

const blocks: Block[] = [
  { id: "one", type: "paragraph", text: "Café 👩‍🚀 lives.", section: "s1" },
  { id: "two", type: "paragraph", text: "Second paragraph", section: "s1" },
  { id: "three", type: "paragraph", text: "Another section", section: "s2" },
];
const model = { list: () => blocks, meta: { sections: [{ id: "s1" }, { id: "s2" }] },
  order: blocks.map((b) => b.id), indexOf: (id: string) => blocks.findIndex((b) => b.id === id),
  block: (id: string) => blocks.find((b) => b.id === id) };
const ed = { model, page: { sheets: [{ blocks: [{ dataset: { id: "one" } }] }, { blocks: [{ dataset: { id: "two" } }] }] } } as unknown as Editor;
const sel = (offset: number): Sel => {
  const pt = { block: "one", offset, field: "text" as const };
  return { start: pt, end: pt, collapsed: true };
};

describe("formatting scopes", () => {
  it("expands Unicode grapheme clusters without splitting the emoji", () => {
    const range = scopedTextRanges(ed, sel(6), "character")[0];
    assert.equal(range?.block.id, "one");
    assert.equal(range?.block.text.slice(range.from, range.to), "👩‍🚀");
  });
  it("resolves a word and sentence at the actual caret position", () => {
    assert.equal(scopedTextRanges(ed, sel(2), "word")[0]?.block.text.slice(0, 4), "Café");
    assert.equal(scopedTextRanges(ed, sel(2), "sentence")[0]?.to, blocks[0]?.text.length);
  });
  it("uses stable block IDs for page, section, and document scope", () => {
    assert.deepEqual(scopedTextRanges(ed, sel(0), "page").map((r) => r.block.id), ["one"]);
    assert.deepEqual(scopedTextRanges(ed, sel(0), "section").map((r) => r.block.id), ["one", "two"]);
    assert.deepEqual(scopedTextRanges(ed, sel(0), "document").map((r) => r.block.id), ["one", "two", "three"]);
  });
});
