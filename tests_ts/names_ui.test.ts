import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalName, linesOf, partsOf, replaceLine } from "../src/client/names_ui.js";

const text = (r: ReturnType<typeof canonicalName>): string => { assert.ok("text" in r, JSON.stringify(r)); return r.text; };

test("parts become the text the server reads exactly", () => {
  assert.equal(text(canonicalName({ family: "García Márquez", given: "Gabriel", suffix: "", literal: false })), "García Márquez, Gabriel");
  assert.equal(text(canonicalName({ family: "King", given: "Martin Luther", suffix: "Jr.", literal: false })), "King, Martin Luther, Jr.");
  assert.equal(text(canonicalName({ family: "  van   Beethoven ", given: "", suffix: "", literal: false })), "van Beethoven,", "a family name of several words alone needs its comma");
  assert.equal(text(canonicalName({ family: "Plato", given: "", suffix: "", literal: false })), "Plato");
  assert.equal(text(canonicalName({ family: "World Health Organization", given: "ignored", suffix: "Jr.", literal: true })), "{World Health Organization}");
});

test("text the server could not read back as typed is refused with a reason", () => {
  for (const parts of [
    { family: "", given: "A", suffix: "", literal: false }, { family: "", given: "", suffix: "", literal: true },
    { family: "Smith, J", given: "", suffix: "", literal: false }, { family: "Smith", given: "{J}", suffix: "", literal: false },
    { family: "Smith", given: "J", suffix: "Esq.", literal: false }, { family: "A}", given: "", suffix: "", literal: true },
  ]) assert.ok("error" in canonicalName(parts), JSON.stringify(parts));
});

test("a line is replaced alone and every other line is kept exactly", () => {
  const field = "Ana Rivera\n\n  Smith JA \nPlato";
  assert.equal(replaceLine(field, 2, "Smith, J. A."), "Ana Rivera\n\nSmith, J. A.\nPlato");
  assert.equal(replaceLine(field, 9, "x"), field);
  assert.equal(replaceLine(field, -1, "x"), field);
  assert.deepEqual(linesOf("a\r\nb"), ["a", "b"]);
});

test("a reading fills the correction form", () => {
  assert.deepEqual(partsOf({ typed: "x", family: "A", given: "B", suffix: "III", literal: false, stated: false, display: "", canonical: "", note: null }), { family: "A", given: "B", suffix: "III", literal: false });
});

test("the editor and the server write the same text for the same parts", () => {
  const cases = (JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "name_canonical.json"), "utf8")) as { cases: Array<{ family: string; given: string; suffix: string; literal: boolean; text: string }> }).cases;
  for (const c of cases) assert.equal(text(canonicalName({ family: c.family, given: c.given, suffix: c.suffix, literal: c.literal })), c.text);
});
