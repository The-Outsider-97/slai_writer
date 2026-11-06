import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { captureInsertPoint, convertMarkdownToTable, enter, insertTable, type InsertPoint } from "../src/client/actions.js";
import type { Editor, Sel } from "../src/client/editor.js";
import type { Block, Op } from "../src/client/types.js";

/* toast() and announce() draw into the page. In Node they only need something that swallows every call. */
const sink: unknown = new Proxy(function () { /* callable */ }, {
  get: (_t, key) => (key === Symbol.toPrimitive ? () => "" : key === "isConnected" ? true : sink), apply: () => sink, set: () => true,
});
Object.assign(globalThis, { document: sink, window: { setTimeout: () => 0, clearTimeout: () => undefined } });

interface Caret { block: string; offset: number; field?: "text" | "cell"; row?: number; col?: number }
interface Scenario {
  name: string; action: "insertTable" | "enter"; blocks: Block[]; rows?: number; columns?: number; point?: InsertPoint;
  caret?: Caret; newIds: string[]; ops: Op[]; order: string[];
}
const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/table_insert_contract.json"), "utf8")) as { scenarios: Scenario[] };

/** An editor that only records what it is asked to send. The server half of the contract lives in tests/test_table_insert_contract.py. */
function fakeEditor(blocks: Block[], newIds: string[], sel: Sel | null, sent: Op[], extra: Record<string, unknown> = {}): Editor {
  const list = blocks.map((b) => ({ ...b }));
  const model = { order: list.map((b) => b.id), list: () => list, indexOf: (id: string) => list.findIndex((b) => b.id === id), block: (id: string) => list.find((b) => b.id === id) };
  const ids = [...newIds];
  return {
    model, readOnly: false, els: new Map(), selectedBlock: null, lastSel: null, readSelection: () => sel,
    newId: () => { const id = ids.shift(); if (!id) throw new Error("more ids requested than the scenario provides"); return id; },
    flush: async () => undefined, op: async (op: Op) => { sent.push(op); return {}; },
    scrollToBlock: () => undefined, focusBlock: () => undefined, events: { emit: () => undefined }, ...extra,
  } as unknown as Editor;
}
const caretSel = (c: Caret): Sel => { const pt = { block: c.block, offset: c.offset, field: c.field ?? "text" as const, ...(c.row !== undefined ? { row: c.row } : {}), ...(c.col !== undefined ? { col: c.col } : {}) }; return { start: pt, end: pt, collapsed: true }; };

describe("table insertion contract", () => {
  for (const scenario of fixture.scenarios) {
    it(scenario.name, async () => {
      const sent: Op[] = [];
      if (scenario.action === "insertTable") {
        const where = scenario.point as InsertPoint;
        const ed = fakeEditor(scenario.blocks, scenario.newIds, null, sent);
        assert.equal(await insertTable(ed, scenario.rows ?? 2, scenario.columns ?? 2, where), true);
      } else {
        const caret = scenario.caret as Caret;
        await enter(fakeEditor(scenario.blocks, scenario.newIds, caretSel(caret), sent));
      }
      assert.deepEqual(sent, scenario.ops);
    });
  }
});

describe("table insertion edge cases", () => {
  const two: Block[] = [{ id: "p1", type: "paragraph", text: "One" }, { id: "p2", type: "paragraph", text: "Two" }];

  it("refuses a caret whose block has gone instead of putting the table somewhere else", async () => {
    const sent: Op[] = [];
    const ed = fakeEditor(two, ["tbl"], null, sent);
    const gone: InsertPoint = { selection: caretSel({ block: "vanished", offset: 0 }), object: null };
    assert.equal(await insertTable(ed, 2, 2, gone), false);
    assert.deepEqual(sent, []);
  });

  it("refuses a selected object that has gone", async () => {
    const sent: Op[] = [];
    assert.equal(await insertTable(fakeEditor(two, ["tbl"], null, sent), 2, 2, { selection: null, object: "vanished" }), false);
    assert.deepEqual(sent, []);
  });

  it("does nothing in a read-only document", async () => {
    const sent: Op[] = [];
    const ed = fakeEditor(two, ["tbl"], null, sent, { readOnly: true });
    assert.equal(await insertTable(ed, 2, 2, { selection: null, object: null }), false);
    assert.deepEqual(sent, []);
  });

  it("keeps a formatted header line as typed instead of dropping its formatting", async () => {
    const sent: Op[] = [];
    const blocks: Block[] = [
      { id: "p1", type: "paragraph", text: "| A | B |", spans: [{ type: "format", start: 0, end: 3, bold: true }] as Block["spans"] },
      { id: "p2", type: "paragraph", text: "| --- | --- |" },
    ];
    await enter(fakeEditor(blocks, ["tail"], caretSel({ block: "p2", offset: 13 }), sent));
    assert.deepEqual(sent, [{ op: "split", block: "p2", at: 13, new_id: "tail" }]);
  });

  it("does not turn a delimiter under a heading into a table", async () => {
    const sent: Op[] = [];
    const blocks: Block[] = [{ id: "h", type: "heading", text: "| A | B |", attributes: { level: 1 } }, { id: "p2", type: "paragraph", text: "| --- | --- |" }];
    await enter(fakeEditor(blocks, ["tail"], caretSel({ block: "p2", offset: 13 }), sent));
    assert.deepEqual(sent, [{ op: "split", block: "p2", at: 13, new_id: "tail" }]);
  });
});

describe("where a table goes", () => {
  const at = (block: string, offset = 0): Sel => caretSel({ block, offset });
  const editor = (live: Sel | null, object: string | null, last: Sel | null): Editor => ({ readSelection: () => live, selectedBlock: object, lastSel: last }) as unknown as Editor;

  it("prefers the caret in the page over everything else", () => {
    assert.deepEqual(captureInsertPoint(editor(at("a"), "obj", at("old"))), { selection: at("a"), object: null });
  });
  it("then the selected object, which is newer than the last caret", () => {
    assert.deepEqual(captureInsertPoint(editor(null, "obj", at("old"))), { selection: null, object: "obj" });
  });
  it("then where the caret last was", () => {
    assert.deepEqual(captureInsertPoint(editor(null, null, at("old"))), { selection: at("old"), object: null });
  });
  it("and nothing when there has been no caret at all", () => {
    assert.deepEqual(captureInsertPoint(editor(null, null, null)), { selection: null, object: null });
  });
});

describe("Convert Markdown text to table", () => {
  const para = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, type: "paragraph", text, ...extra });
  const lines: Block[] = [para("intro", "Results | so far"), para("h", "| A | B |"), para("d", "| --- | --- |"), para("r1", "| 1 | 2 |"), para("r2", "| 3 | 4 |"), para("outro", "After")];
  const run = async (blocks: Block[], sel: Sel | null): Promise<Op[]> => { const sent: Op[] = []; await convertMarkdownToTable(fakeEditor(blocks, ["tbl"], sel, sent)); return sent; };
  const range = (from: string, to: string): Sel => ({ start: { block: from, offset: 0, field: "text" }, end: { block: to, offset: 3, field: "text" }, collapsed: false });
  const spec = (rows: string[][]): Record<string, unknown> => ({ id: "tbl", type: "table", text: "", rows: rows.length, columns: 2, table: { columns: 2, header_rows: 1, rows: rows.map((r) => r.map((text) => ({ text }))) } });

  it("turns the selected lines into one table in their place, in a single batch", async () => {
    assert.deepEqual(await run(lines, range("h", "r2")), [{ op: "batch", label: "insert table", ops: [
      { op: "block_insert", after: "intro", block: spec([["A", "B"], ["1", "2"], ["3", "4"]]) }, { op: "block_delete", blocks: ["h", "d", "r1", "r2"] }] }]);
  });
  it("finds the table round a bare caret and leaves the prose line above it alone", async () => {
    const sent = await run(lines, caretSel({ block: "r1", offset: 2 }));
    assert.deepEqual(sent, [{ op: "batch", label: "insert table", ops: [
      { op: "block_insert", after: "intro", block: spec([["A", "B"], ["1", "2"], ["3", "4"]]) }, { op: "block_delete", blocks: ["h", "d", "r1", "r2"] }] }]);
  });
  it("changes nothing for a table that is too wide", async () => {
    const cells = (n: number, c: string): string => `| ${Array.from({ length: n }, () => c).join(" | ")} |`;
    assert.deepEqual(await run([para("h", cells(41, "h")), para("d", cells(41, "---"))], range("h", "d")), []);
  });
  it("changes nothing when a line carries formatting, so nothing the person made is lost", async () => {
    const bold = [para("h", "| A | B |", { spans: [{ type: "format", start: 0, end: 3, bold: true }] as Block["spans"] }), para("d", "| --- | --- |")];
    assert.deepEqual(await run(bold, range("h", "d")), []);
  });
  it("changes nothing for lines that are not a table, or a caret that is not on one", async () => {
    assert.deepEqual(await run([para("a", "x | y"), para("b", "no dashes")], range("a", "b")), []);
    assert.deepEqual(await run(lines, caretSel({ block: "outro", offset: 1 })), []);
    assert.deepEqual(await run(lines, null), []);
  });
  it("does nothing in a read-only document", async () => {
    const sent: Op[] = [];
    await convertMarkdownToTable(fakeEditor(lines, ["tbl"], range("h", "r2"), sent, { readOnly: true }));
    assert.deepEqual(sent, []);
  });
});
