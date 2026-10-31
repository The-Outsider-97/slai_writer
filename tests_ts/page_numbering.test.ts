import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { printedPageNumbers } from "../src/client/page.js";

describe("printed page numbering", () => {
  it("omits covers but includes all physical pages", () => {
    assert.deepEqual(printedPageNumbers([
      { section: "cover", role: "cover", numbering: { show: false } },
      { section: "main" }, { section: "main" }, { section: "main" },
    ]), [null, "1", "2", "3"]);
  });
  it("handles front-matter Roman and main-text restarts", () => {
    assert.deepEqual(printedPageNumbers([
      { section: "cover", role: "cover" },
      { section: "front", numbering: { start: 1, format: "lower-roman" } },
      { section: "front", numbering: { start: 1, format: "lower-roman" } },
      { section: "body", numbering: { start: 1, format: "decimal" } },
      { section: "body", numbering: { start: 1, format: "decimal" } },
    ]), [null, "i", "ii", "1", "2"]);
  });
  it("continues across ordinary sections without an explicit restart", () => {
    assert.deepEqual(printedPageNumbers([{ section: "a" }, { section: "b" }, { section: "c" }]), ["1", "2", "3"]);
  });
});
