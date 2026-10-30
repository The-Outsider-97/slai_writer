import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DocModel, OpQueue } from "../src/client/model.js";

const block = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, type: "paragraph", text, spans: [], ...extra });
const state = (blocks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  sid: "s1", version: 3, dirty: false, readOnly: false, access: { canEdit: true },
  document: { title: "T", sections: [{ id: "s1", page: { size: "A4", margins_mm: { top: 25, right: 25, bottom: 25, left: 25 } } }] },
  blocks, comments: [], stats: { words: 0, characters: 0, blocks: blocks.length }, undo: 0, redo: 0, revision: { number: 1 }, signatures: 0, notices: [], ...extra,
}) as never;
const patch = (version: number, blocks: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version, result: null, blocks, dirty: true, stats: { words: 1, characters: 1, blocks: 1 }, undo: 1, redo: 0, revision: { number: 1 }, signatures: 0, notices: [], ...extra }) as never;

describe("DocModel", () => {
  it("loads a state and lists blocks in order", () => {
    const m = new DocModel(state([block("a", "one"), block("b", "two")]));
    assert.deepEqual(m.order, ["a", "b"]);
    assert.equal(m.plainText(), "one\ntwo");
    assert.equal(m.indexOf("b"), 1);
  });
  it("applies a patch: changed, removed and reordered blocks", () => {
    const m = new DocModel(state([block("a", "one"), block("b", "two")]));
    const out = m.applyPatch(patch(4, { a: block("a", "ONE"), b: null, c: block("c", "three") }, { order: ["a", "c"] }));
    assert.deepEqual(out.changed.sort(), ["a", "c"]);
    assert.deepEqual(out.removed, ["b"]);
    assert.equal(out.reordered, true);
    assert.deepEqual(m.order, ["a", "c"]);
    assert.equal(m.version, 4);
    assert.equal(m.block("a")?.text, "ONE");
    assert.equal(m.state.dirty, true);
  });
  it("drops removed blocks from the order even when the server sends no order", () => {
    const m = new DocModel(state([block("a", "x"), block("b", "y")]));
    m.applyPatch(patch(4, { a: null }));
    assert.deepEqual(m.order, ["b"]);
  });
  it("merges document-level changes", () => {
    const m = new DocModel(state([block("a", "x")]));
    const out = m.applyPatch(patch(4, {}, { document: { title: "New" } }));
    assert.equal(out.documentChanged, true);
    assert.equal(m.meta.title, "New");
    assert.ok(m.meta.sections);
  });
  it("computes page geometry, orientation and custom sizes", () => {
    const m = new DocModel(state([block("a", "x")]));
    assert.deepEqual([m.geometry().widthMm, m.geometry().heightMm], [210, 297]);
    assert.equal(m.geometry().margins.left, 25);
    m.meta = { ...m.meta, sections: [{ id: "s1", page: { size: "A4", orientation: "landscape" } }] } as never;
    assert.deepEqual([m.geometry().widthMm, m.geometry().heightMm], [297, 210]);
    m.meta = { ...m.meta, sections: [{ id: "s1", page: { width_mm: 100, height_mm: 150 } }] } as never;
    assert.deepEqual([m.geometry().widthMm, m.geometry().heightMm], [100, 150]);
  });
  it("lists headings with their level", () => {
    const m = new DocModel(state([block("a", "Intro", { type: "heading", attributes: { level: 2 } }), block("b", "text")]));
    assert.deepEqual(m.headings(), [{ id: "a", level: 2, text: "Intro" }]);
  });
  it("is read-only when the server says so, whatever the access object says", () => {
    assert.equal(new DocModel(state([], { readOnly: true })).readOnly, true);
    assert.equal(new DocModel(state([], { access: { canEdit: false } })).readOnly, true);
    assert.equal(new DocModel(state([])).readOnly, false);
  });
});

describe("OpQueue", () => {
  const setup = (post: (path: string, body: unknown) => Promise<unknown>) => {
    const m = new DocModel(state([block("a", "x")]));
    const applied: number[] = [];
    let stale = 0;
    const q = new OpQueue(m, (p) => { m.applyPatch(p); applied.push(p.version); }, () => { stale += 1; }, post as never);
    return { m, q, applied, stale: () => stale };
  };
  it("sends operations one at a time, each tagged with the version the previous reply produced", async () => {
    const bases: unknown[] = [];
    let n = 3;
    const { q, applied } = setup(async (_path, body) => { bases.push((body as { base: number }).base); await new Promise((r) => setTimeout(r, 5)); n += 1; return patch(n, {}); });
    await Promise.all([q.send({ op: "meta" } as never), q.send({ op: "meta" } as never), q.send({ op: "meta" } as never)]);
    assert.deepEqual(bases, [3, 4, 5]);
    assert.deepEqual(applied, [4, 5, 6]);
    assert.equal(q.pending, 0);
  });
  it("reports a stale version and keeps working afterwards", async () => {
    let call = 0;
    const { q, stale } = setup(async () => { call += 1; if (call === 1) throw Object.assign(new Error("stale"), { details: { kind: "stale_version" } }); return patch(4, {}); });
    await assert.rejects(async () => q.send({ op: "meta" } as never));
    assert.equal(stale(), 1);
    await q.send({ op: "meta" } as never);
    assert.equal(q.pending, 0);
  });
  it("runs other server work in the same order as edits", async () => {
    const order: string[] = [];
    const { q } = setup(async () => { await new Promise((r) => setTimeout(r, 10)); order.push("op"); return patch(4, {}); });
    const first = q.send({ op: "meta" } as never);
    const second = q.run(async () => { order.push("work"); });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["op", "work"]);
  });
  it("idle resolves after everything queued has been sent", async () => {
    const { q, applied } = setup(async () => { await new Promise((r) => setTimeout(r, 5)); return patch(4, {}); });
    void q.send({ op: "meta" } as never);
    await q.idle();
    assert.equal(applied.length, 1);
  });
});
