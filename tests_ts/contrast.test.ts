import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** Contrast of the colour tokens Writer actually runs with (the shared kit's palette under data-skin="soft"), read from the stylesheet itself, so a changed token is checked
 *  without anyone remembering to update a list. WCAG 2.x: 4.5:1 for text, 3:1 for the focus ring and other non-text parts of the interface. */
const css = readFileSync(new URL("../../tools/web/slai-ui.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} is not in slai-ui.css`);
  return css.slice(start, css.indexOf("\n}", start));
}

const SOFT = block(':root[data-skin="soft"]');
function token(name: string): [string, string] {
  const found = new RegExp(`${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i").exec(SOFT) ?? new RegExp(`${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i").exec(block(":root"));
  assert.ok(found, `--${name.slice(2)} is not a light-dark pair of hex colours`);
  return [found[1] as string, found[2] as string];
}

const channel = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string): number => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
export function contrast(a: string, b: string): number { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); }

describe("colour contrast of the interface tokens", () => {
  it("measures the reference pairs correctly", () => {
    assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
    assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
  });

  const text: Array<[string, string]> = [["text", "bg"], ["text", "surface"], ["muted", "bg"], ["muted", "surface"], ["muted", "chrome"], ["accent-ink", "surface"], ["accent-ink", "bg"], ["danger", "surface"], ["danger", "bg"], ["ok", "surface"]];
  const parts: Array<[string, string]> = [["focus", "bg"], ["focus", "surface"]];
  const check = (pairs: Array<[string, string]>, least: number): void => {
    for (const [fg, bg] of pairs) for (const [i, mode] of ["light", "dark"].entries()) {
      it(`--${fg} on --${bg}, ${mode}: at least ${least}:1`, () => {
        const ratio = contrast(token(`--${fg}`)[i] as string, token(`--${bg}`)[i] as string);
        assert.ok(ratio >= least, `${ratio.toFixed(2)}:1`);
      });
    }
  };
  check(text, 4.5);
  check(parts, 3);

  for (const colour of ["blue", "violet", "green", "pink", "amber"]) for (const [i, mode] of ["light", "dark"].entries()) {
    it(`${colour} chip text on its fill, ${mode}`, () => {
      assert.ok(contrast(token(`--${colour}-fg`)[i] as string, token(`--${colour}-bg`)[i] as string) >= 4.5);
    });
  }
});
