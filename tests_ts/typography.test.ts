import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paragraphFontProps, parseRibbonNumber } from "../src/client/font_rules.js";

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

describe("ribbon typography numbers", () => {
  it("accepts zero, negative tracking, decimals and the inclusive boundaries", () => {
    assert.equal(parseRibbonNumber("0", -5, 50), 0);
    assert.equal(parseRibbonNumber("-0.4", -5, 50), -0.4);
    assert.equal(parseRibbonNumber(" 1.15 ", 0, 10), 1.15);
    assert.equal(parseRibbonNumber("-5", -5, 50), -5);
    assert.equal(parseRibbonNumber("50", -5, 50), 50);
  });
  it("treats an empty completed input as inheritance, not an error toast", () => {
    assert.equal(parseRibbonNumber("", -5, 50), null);
    assert.equal(parseRibbonNumber("   ", 4, 400), null);
  });
  it("rejects non-finite, malformed and out-of-range entries", () => {
    for (const value of ["-6", "50.1", "NaN", "Infinity", "3x", "1; color:red"])
      assert.equal(parseRibbonNumber(value, -5, 50), undefined);
  });
});
