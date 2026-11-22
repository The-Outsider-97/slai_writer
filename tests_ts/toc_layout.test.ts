import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { leaderGap, leaderMark, placeEntry, planEntry, resolveLook, type TocLook } from "../src/client/toc_layout.js";

interface Golden {
  looks: Array<{ raw: Record<string, unknown> | null; show: boolean; dots: boolean; look: TocLook }>;
  entries: Array<{
    look: TocLook; width: number; indent: number; right_indent: number; column_w: number; inline_w: number; inline_gap: number;
    plan: { position: string; text: [number, number]; column: [number, number] | null };
    places: Array<{ number_w: number; first: [number, number]; last: [number, number]; mark_w: number; gap: number; result: Record<string, unknown> }>;
  }>;
}
const golden = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "toc_layout_golden.json"), "utf8")) as Golden;
const close = (a: unknown, b: unknown, label: string): void => {
  if (typeof a === "number" && typeof b === "number") assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} != ${b}`);
  else if (a && b && typeof a === "object" && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), label);
    for (const key of Object.keys(a)) close((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${label}.${key}`);
  } else assert.equal(a, b, label);
};

describe("the contents entry engine of the editor says what the exported pages' engine says", () => {
  it("resolves the same settings", () => {
    assert.ok(golden.looks.length > 100);
    golden.looks.forEach((item, n) => close(resolveLook(item.raw as never, item.show, item.dots), item.look, `look ${n} ${JSON.stringify(item.raw)}`));
  });
  it("plans the same room for the text and the number column", () => {
    assert.ok(golden.entries.length > 20);
    golden.entries.forEach((e, n) => {
      const plan = planEntry(e.look, e.width, e.indent, e.right_indent, e.column_w, e.inline_w, e.inline_gap);
      close({ position: plan.position, text: plan.text, column: plan.column }, e.plan, `plan ${n}`);
    });
  });
  it("places the same number and leader", () => {
    let leaders = 0;
    golden.entries.forEach((e, n) => {
      const plan = planEntry(e.look, e.width, e.indent, e.right_indent, e.column_w, e.inline_w, e.inline_gap);
      e.places.forEach((p, m) => {
        const got = placeEntry(e.look, plan, p.number_w, p.first, p.last, p.mark_w, p.gap, e.inline_gap);
        if (got.leader) leaders++;
        close(got, p.result, `place ${n}.${m}`);
      });
    });
    assert.ok(leaders > 50, "the cases include many leaders");
  });
  it("knows the marks and their spacing", () => {
    assert.equal(leaderMark(resolveLook({ leader: "dashes" })), "-");
    assert.equal(leaderMark(resolveLook({ leader: "custom", leader_char: "·" })), "·");
    assert.equal(leaderMark(resolveLook({ leader: "solid" })), "");
    assert.equal(leaderGap(resolveLook({ leader: "dashes" }), 10), 3.5);
    assert.equal(leaderGap(resolveLook({ leader: "dashes", leader_gap_pt: 1 }), 10), 1);
  });
});
