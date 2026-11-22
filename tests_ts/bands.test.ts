import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ownerOf, placeBand, shapesForPage, storedFromBox, type BandDoc, type BandItem } from "../src/client/bands.js";

interface Golden {
  docs: Array<{ label: string; doc: BandDoc }>;
  cases: Array<{ doc: string; section: string; edge: "header" | "footer"; physical: number; first: boolean; ids: string[]; variant: string; mirrored: boolean; owner: string }>;
  places: Array<{ item: BandItem; edge: "header" | "footer"; page: [number, number, number, number]; mirrored: boolean; box: { x: number; y: number; w: number; h: number } }>;
}
const golden = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "band_shapes_golden.json"), "utf8")) as Golden;

describe("the header and footer shapes of the editor are the ones the exported pages have", () => {
  it("shows the same shapes on the same pages", () => {
    assert.ok(golden.cases.length > 200);
    for (const c of golden.cases) {
      const doc = golden.docs.find((d) => d.label === c.doc)!.doc;
      const got = shapesForPage(doc, c.section, c.edge, c.physical, c.first);
      const label = JSON.stringify({ ...c, ids: undefined });
      assert.deepEqual(got.items.map((i) => i.id), c.ids, label);
      assert.equal(got.variant, c.variant, label);
      assert.equal(got.mirrored, c.mirrored, label);
      assert.equal(ownerOf(doc, c.section, c.edge), c.owner, label);
    }
  });
  it("puts a shape in the same place", () => {
    assert.ok(golden.places.length >= 30);
    for (const p of golden.places) {
      const box = placeBand(p.item, p.edge, p.page[0], p.page[1], p.page[2], p.page[3], p.mirrored);
      for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(box[k] - p.box[k]) < 1e-9, `${k} of ${JSON.stringify(p)}`);
    }
  });
  it("turns a position on the page back into what is stored", () => {
    for (const p of golden.places) {
      if (p.item.span) continue;
      const stored = storedFromBox(p.item, p.edge, p.box.x, p.box.y, p.page[0], p.page[1], p.page[2], p.page[3], p.mirrored);
      assert.ok(Math.abs(stored.x_mm - p.item.x_mm) < 0.006 && Math.abs(stored.y_mm - p.item.y_mm) < 0.006, JSON.stringify([stored, p.item.x_mm, p.item.y_mm]));
    }
  });
});
