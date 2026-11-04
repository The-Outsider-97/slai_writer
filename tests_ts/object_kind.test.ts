import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { objectKind } from "../src/client/object_kind.js";

describe("object editor event kinds", () => {
  it("opens the four supported object blocks from keyboard selection", () => {
    for (const kind of ["figure", "equation", "embed", "table"] as const) {
      assert.equal(objectKind(kind, false), kind);
    }
  });

  it("routes shape paragraphs to the shape-aware figure handler", () => {
    assert.equal(objectKind("paragraph", true), "figure");
  });

  it("does not emit open-object events for ordinary text or missing DOM types", () => {
    for (const type of [undefined, "paragraph", "code", "quote", "heading", "list_item", "unknown"]) {
      assert.equal(objectKind(type, false), null);
    }
  });

  it("preserves table double-click editing rather than opening the table dialog", () => {
    assert.equal(objectKind("table", false, false), null);
    assert.equal(objectKind("figure", false, false), "figure");
    assert.equal(objectKind("paragraph", true, false), "figure");
  });
});
