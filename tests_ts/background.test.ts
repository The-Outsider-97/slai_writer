import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePageColour } from "../src/client/dialogs.js";

describe("page background colour input", () => {
  it("normalizes supported RGB values", () => {
    assert.equal(parsePageColour("#ABCDEF"), "#abcdef");
    assert.equal(parsePageColour(" #102030 "), "#102030");
    assert.equal(parsePageColour("#ffffff"), "#ffffff");
  });

  it("rejects CSS declarations, unsupported units and malformed values", () => {
    for (const invalid of ["red", "#fff", "#12345678", "#fffffg", "transparent", "url(https://example.test/x)",
      "#123456; color: red", "linear-gradient(red, blue)", ""]) {
      assert.equal(parsePageColour(invalid), null, invalid);
    }
  });
});
