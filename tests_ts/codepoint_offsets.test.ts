import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffText, toCodepointEdit } from "../src/client/textops.js";

/** What the server does with a `text` operation: Python string slicing, which counts code points. */
function serverApply(text: string, e: { start: number; end: number; insert: string }): string {
  const cps = Array.from(text);
  return cps.slice(0, e.start).join("") + e.insert + cps.slice(e.end).join("");
}
function sent(before: string, after: string, caret?: number): string {
  const edit = diffText(before, after, caret);
  assert.ok(edit);
  return serverApply(before, toCodepointEdit(before, edit));
}

describe("typing is sent in the server's offsets (code points, not UTF-16 units)", () => {
  it("lands where the person typed after an emoji", () => {
    assert.equal(sent("😀ab", "😀abc", 5), "😀abc");
    assert.equal(sent("😀ab", "😀Xab", 3), "😀Xab");
    assert.equal(sent("😀😀 end", "😀😀 ends", 9), "😀😀 ends");
  });
  it("deletes the right characters after astral letters", () => {
    assert.equal(sent("𐐨𐐯 test", "𐐨𐐯 tet", 7), "𐐨𐐯 tet");
    assert.equal(sent("a😀b", "ab", 1), "ab");
  });
  it("is unchanged for text without such characters", () => {
    assert.deepEqual(toCodepointEdit("hello", { start: 2, end: 3, insert: "L" }), { start: 2, end: 3, insert: "L" });
  });
  it("keeps the old (wrong) behaviour out: the offsets differ from UTF-16 once an emoji comes first", () => {
    const edit = diffText("😀ab", "😀abc", 5)!;
    assert.equal(edit.start, 4);
    assert.equal(toCodepointEdit("😀ab", edit).start, 3);
  });
});

import { segments } from "../src/client/textops.js";
import { dropMoveOps } from "../src/client/textops.js";

describe("paragraph spans (stored in code points) are drawn in the right place after an emoji", () => {
  it("bold on 'ab' in '😀ab c' covers 'ab', not the emoji's second half", () => {
    const out = segments({ text: "😀ab c", spans: [{ type: "format", start: 1, end: 3, bold: true }] } as never, "codepoints");
    assert.deepEqual(out.map((s) => [s.text, !!s.flags.bold]), [["😀", false], ["ab", true], [" c", false]]);
  });
  it("leaves text without such characters, and UTF-16 spans (shapes, text boxes), as they were", () => {
    const plain = segments({ text: "abcdef", spans: [{ type: "format", start: 1, end: 4, bold: true }] } as never, "codepoints");
    assert.deepEqual(plain.map((s) => s.text), ["a", "bcd", "ef"]);
    const utf16 = segments({ text: "😀ab", spans: [{ type: "format", start: 2, end: 4, bold: true }] } as never);
    assert.deepEqual(utf16.map((s) => s.text), ["😀", "ab"]);
  });
  it("moving text within a block shifts by code points", () => {
    const ops = dropMoveOps("b", 0, 1, "b", 5, "😀");
    assert.equal(ops?.[1]?.["start"], 0);
    const back = dropMoveOps("b", 3, 4, "b", 0, "😀");
    assert.equal(back?.[1]?.["start"], 4);
  });
});
