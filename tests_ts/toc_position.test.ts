import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { tocCoverAnchor } from "../src/client/toc_position.js";
import type { Block, Section } from "../src/client/types.js";

describe("cover-aware TOC insertion default", () => {
  const sections: Section[] = [{ id: "cover-a", role: "cover" }, { id: "cover-b", role: "cover" }, { id: "body", role: "body" }];
  const blocks = (rows: Array<[string, string]>): Block[] => rows.map(([id, section]) => ({ id, section, type: "paragraph", text: id }));

  it("anchors after the complete cover, including multiple cover sections", () => {
    assert.equal(tocCoverAnchor(blocks([["a", "cover-a"], ["b", "cover-a"], ["c", "cover-b"], ["d", "body"]]), sections), "c");
  });
  it("returns document start without an initial cover", () => {
    assert.equal(tocCoverAnchor(blocks([["a", "body"], ["b", "cover-a"]]), sections), null);
    assert.equal(tocCoverAnchor([], sections), null);
    assert.equal(tocCoverAnchor(blocks([["x", "s1"]]), [{ id: "s1", role: "body" }]), null);
  });
});
