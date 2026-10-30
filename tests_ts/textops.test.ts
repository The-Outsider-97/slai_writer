import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanInsert, countWords, diffText, mapOffset, roman, segments, splitLines, wordAt, PAGE_MM, clampNumber } from "../src/client/textops.js";

describe("diffText", () => {
  it("returns null when nothing changed", () => assert.equal(diffText("same", "same"), null));
  it("finds a single insertion", () => assert.deepEqual(diffText("helo", "hello", 4), { start: 3, end: 3, insert: "l" }));
  it("uses the caret to place a repeated character where it was typed", () => {
    assert.deepEqual(diffText("hello", "helllo", 4), { start: 3, end: 3, insert: "l" });
    assert.deepEqual(diffText("hello", "hhello", 1), { start: 0, end: 0, insert: "h" });
  });
  it("finds a deletion and a replacement", () => {
    assert.deepEqual(diffText("abcdef", "abef"), { start: 2, end: 4, insert: "" });
    assert.deepEqual(diffText("abcdef", "abXYef"), { start: 2, end: 4, insert: "XY" });
  });
  it("never splits a surrogate pair", () => {
    const edit = diffText("a😀b", "a😁b");
    assert.ok(edit);
    assert.equal("a😀b".slice(0, edit.start) + edit.insert + "a😀b".slice(edit.end), "a😁b");
    assert.equal(edit.start, 1);
    assert.equal(edit.end, 3);
  });
  it("is always reversible: applying the edit to the old text gives the new text", () => {
    const pairs: Array<[string, string]> = [["", "abc"], ["abc", ""], ["abc", "abc "], ["one two", "one  two"], ["aaa", "aaaa"], ["x", "y"], ["😀😀", "😀"]];
    for (const [a, b] of pairs) {
      const e = diffText(a, b);
      assert.ok(e, `${a}→${b}`);
      assert.equal(a.slice(0, e.start) + e.insert + a.slice(e.end), b);
    }
  });
});

describe("mapOffset", () => {
  const edit = { start: 5, end: 8, insert: "XY" };
  it("keeps offsets before the edit", () => assert.equal(mapOffset(3, edit), 3));
  it("moves offsets after the edit by the change in length", () => assert.equal(mapOffset(10, edit), 9));
  it("puts offsets inside a replaced range at the end of the insertion", () => assert.equal(mapOffset(6, edit), 7));
});

describe("small helpers", () => {
  it("counts words with apostrophes and hyphens, ignoring object characters", () => {
    assert.equal(countWords("It's a well-known thing"), 4);
    assert.equal(countWords(""), 0);
    assert.equal(countWords("a￼b"), 2);
    assert.equal(countWords("日本語 text"), 2);
  });
  it("splits and cleans pasted text", () => {
    assert.deepEqual(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
    assert.equal(cleanInsert("a\u0000b\u0007c"), "abc");
  });
  it("finds the word at an offset", () => {
    assert.deepEqual(wordAt("hello world", 2), { start: 0, end: 5 });
    assert.deepEqual(wordAt("hello world", 8), { start: 6, end: 11 });
    assert.equal(wordAt("a  b", 2), null);
  });
  it("writes roman numerals", () => {
    assert.equal(roman(4), "iv"); assert.equal(roman(9), "ix"); assert.equal(roman(14), "xiv"); assert.equal(roman(1994), "mcmxciv"); assert.equal(roman(0), "i");
  });
  it("clamps numbers and knows the page sizes", () => {
    assert.equal(clampNumber(5, 1, 3), 3); assert.equal(clampNumber(-5, 1, 3), 1);
    assert.deepEqual(PAGE_MM["A4"], [210, 297]);
    assert.ok(PAGE_MM["Tabloid"]);
  });
});

describe("segments", () => {
  it("splits text at span boundaries and carries the flags", () => {
    const out = segments({ text: "abcdef", spans: [{ type: "format", start: 1, end: 3, bold: true }, { type: "format", start: 2, end: 5, italic: true }] } as never);
    assert.deepEqual(out.map((s) => s.text), ["a", "b", "c", "de", "f"]);
    assert.equal(out[1]?.flags.bold, true);
    assert.equal(out[2]?.flags.bold, true);
    assert.equal(out[2]?.flags.italic, true);
    assert.equal(out[3]?.flags.italic, true);
    assert.equal(out[4]?.flags.italic, undefined);
  });
  it("covers the whole text with no gaps or overlaps", () => {
    const text = "The quick brown fox";
    const out = segments({ text, spans: [{ type: "format", start: 4, end: 9, bold: true }] } as never);
    assert.equal(out.map((s) => s.text).join(""), text);
    for (let i = 1; i < out.length; i++) assert.equal(out[i]?.start, out[i - 1]?.end);
  });
});
