import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TEXTBOX_MIN_MM, TEXTBOX_PRESETS, comparePos, fmtAt, fromLines, isLocked, isPinned, lineText, rangeHas, rangeValue, replaceRange, formatRange, textBoxOf, textBoxText, toLines, withParagraphs } from "../src/client/textbox.js";
import type { TextBoxParagraph } from "../src/client/textbox.js";

const lines = (paragraphs: TextBoxParagraph[]) => toLines(paragraphs);

describe("the text box's rich text model", () => {
  test("paragraphs round-trip through the editing model unchanged", () => {
    const source: TextBoxParagraph[] = [
      { text: "Title", role: "heading1", align: "center" },
      { text: "Hello bold world", spans: [{ type: "format", start: 6, end: 10, bold: true }] },
      { text: "item", list: "bullet" },
      { text: "Word", style: "Scripture" },
    ];
    assert.deepEqual(fromLines(lines(source)), source);
  });

  test("typing inside a bold word stays bold and a split paragraph keeps its attributes", () => {
    const start = lines([{ text: "ab cd", role: "heading2", spans: [{ type: "format", start: 0, end: 2, bold: true }] }]);
    const typed = replaceRange(start, { p: 0, o: 1 }, { p: 0, o: 1 }, "X");
    assert.equal(lineText(typed.lines[0]!), "aXb cd");
    assert.equal(fmtAt(typed.lines[0]!, 2).bold, true);
    const split = replaceRange(typed.lines, typed.caret, typed.caret, "\n");
    assert.equal(split.lines.length, 2);
    assert.equal(split.lines[1]!.attrs.role, "heading2");
    assert.deepEqual(split.caret, { p: 1, o: 0 });
  });

  test("replacing a selection across paragraphs joins them", () => {
    const start = lines([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const result = replaceRange(start, { p: 0, o: 2 }, { p: 2, o: 2 }, "");
    assert.deepEqual(result.lines.map(lineText), ["onree"]);
    assert.deepEqual(result.caret, { p: 0, o: 2 });
  });

  test("formatting a range toggles only that range, and the state queries agree", () => {
    const start = lines([{ text: "abcdef" }]);
    const bold = formatRange(start, { p: 0, o: 1 }, { p: 0, o: 4 }, (f) => ({ ...f, bold: true }));
    assert.equal(rangeHas(bold, { p: 0, o: 1 }, { p: 0, o: 4 }, "bold"), true);
    assert.equal(rangeHas(bold, { p: 0, o: 0 }, { p: 0, o: 4 }, "bold"), false);
    assert.equal(rangeValue(bold, { p: 0, o: 0 }, { p: 0, o: 6 }, "bold"), "mixed");
    assert.deepEqual(fromLines(bold)[0]!.spans, [{ type: "format", start: 1, end: 4, bold: true }]);
    const colour = formatRange(bold, { p: 0, o: 2 }, { p: 0, o: 6 }, (f) => ({ ...f, color: "#336699" }));
    assert.equal(rangeValue(colour, { p: 0, o: 2 }, { p: 0, o: 6 }, "color"), "#336699");
  });

  test("positions compare in reading order", () => {
    assert.ok(comparePos({ p: 0, o: 9 }, { p: 1, o: 0 }) < 0);
    assert.ok(comparePos({ p: 2, o: 3 }, { p: 2, o: 3 }) === 0);
  });

  test("the plain-text mirror equals the paragraphs joined by a newline, and saving keeps it in step", () => {
    const shape = TEXTBOX_PRESETS[0]!.build();
    const next = withParagraphs(shape, [{ text: "a" }, { text: "b", list: "number" }]);
    assert.equal(next.text.content, "a\nb");
    assert.equal(textBoxText(textBoxOf(next)!.paragraphs), "a\nb");
  });
});

describe("text box presets", () => {
  test("every preset is a valid rectangle text box that is neither pinned nor locked and is larger than the minimum", () => {
    assert.ok(TEXTBOX_PRESETS.length >= 5);
    for (const preset of TEXTBOX_PRESETS) {
      const shape = preset.build();
      assert.equal(shape.kind, "rectangle");
      assert.ok(textBoxOf(shape), preset.id);
      assert.equal(isPinned(shape), false);
      assert.equal(isLocked(shape), false);
      assert.ok(shape.width_mm >= TEXTBOX_MIN_MM.width && shape.height_mm >= TEXTBOX_MIN_MM.height, preset.id);
      assert.ok(shape.text.padding_mm <= Math.min(shape.width_mm, shape.height_mm) / 4, `${preset.id}: padding fits the server rule`);
    }
  });

  test("a preset builds a fresh object each time", () => {
    const a = TEXTBOX_PRESETS[0]!.build(), b = TEXTBOX_PRESETS[0]!.build();
    a.textbox!.paragraphs[0]!.text = "changed";
    assert.notEqual(b.textbox!.paragraphs[0]!.text, "changed");
  });
});
