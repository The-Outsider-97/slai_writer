import assert from "node:assert/strict";
import { test } from "node:test";
import { objectKind } from "../src/client/object_kind.js";

test("objects open their own editor", () => {
  for (const type of ["figure", "equation", "embed", "table"]) assert.equal(objectKind(type, false), type);
});

test("a shape opens like a picture, whatever block carries it", () => {
  assert.equal(objectKind("paragraph", true), "figure");
  assert.equal(objectKind(undefined, true), "figure");
});

test("ordinary text opens nothing", () => {
  for (const type of ["paragraph", "heading", "list_item", "quote", "code", undefined]) assert.equal(objectKind(type, false), null);
});

test("a double-click leaves tables to the cell under the pointer", () => {
  assert.equal(objectKind("table", false, false), null);
  assert.equal(objectKind("figure", false, false), "figure");
});
