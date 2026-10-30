import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paragraphFontProps } from "../src/client/font_rules.js";

describe("paragraph font settings", () => {
  it("preserves paragraph properties while overriding font and dropping inheritance", () => {
    assert.deepEqual(paragraphFontProps({ based_on: "Normal", line_height: 1.5, italic: true }, "Georgia", 11),
      { line_height: 1.5, italic: true, font_family: "Georgia", font_size_pt: 11 });
  });
  it("rejects invalid family and sizes before constructing an SLDC operation", () => {
    assert.throws(() => paragraphFontProps({}, "evil; font-size: 1px", 12), RangeError);
    for (const value of [0, 401, Number.NaN, Number.POSITIVE_INFINITY])
      assert.throws(() => paragraphFontProps({}, "Arial", value), RangeError);
  });
});
