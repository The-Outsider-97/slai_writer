import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanInsert, countWords, diffText, mapOffset, roman, segments, splitLines, wordAt, PAGE_MM, clampNumber, parseMarkdownTable, analyzeMarkdownTable, TABLE_LIMITS, toCodepoints, typedTableStart } from "../src/client/textops.js";

describe("Markdown table recognition", () => {
  it("recognizes a complete pipe table and unescapes cell delimiters", () => {
    const table = parseMarkdownTable("| Name | Value |\n| :--- | ---: |\n| A\\|B | 123 |\n| C |  |");
    assert.equal(table?.columns, 2);
    assert.equal(table?.header_rows, 1);
    assert.deepEqual(table?.rows.map((row) => row.map((c) => c.text)), [["Name", "Value"], ["A|B", "123"], ["C", ""]]);
  });
  it("does not consume prose, incomplete tables, or fenced code", () => {
    for (const source of ["A | B", "A | B\n--- | nope", "```markdown\n| A | B |\n| --- | --- |\n```"]) assert.equal(parseMarkdownTable(source), null);
  });
});

describe("Markdown table limits and feedback", () => {
  const pipes = (n: number, cell: string): string => `| ${Array.from({ length: n }, () => cell).join(" | ")} |`;
  const grid = (columns: number, bodyRows = 1): string => [pipes(columns, "h"), pipes(columns, "---"), ...Array.from({ length: bodyRows }, () => pipes(columns, "x"))].join("\n");
  const rejection = (source: string): string | null => { const found = analyzeMarkdownTable(source); return found.kind === "rejected" ? found.reason : null; };

  it("accepts exactly 40 columns and says why 41 is left as text", () => {
    assert.equal(analyzeMarkdownTable(grid(TABLE_LIMITS.columns)).kind, "table");
    const over = analyzeMarkdownTable(grid(TABLE_LIMITS.columns + 1));
    assert.equal(over.kind, "rejected");
    assert.match(over.kind === "rejected" ? over.message : "", /41 columns.*up to 40/);
    assert.equal(parseMarkdownTable(grid(41)), null);
  });
  it("accepts exactly 200 lines and says why 201 is left as text", () => {
    assert.equal(analyzeMarkdownTable(grid(2, TABLE_LIMITS.lines - 2)).kind, "table");
    const over = analyzeMarkdownTable(grid(2, TABLE_LIMITS.lines - 1));
    assert.equal(over.kind, "rejected");
    assert.match(over.kind === "rejected" ? over.message : "", /201 lines.*up to 200/);
  });
  it("names the rule an attempt broke", () => {
    assert.equal(rejection("| A | B |\n| --- |"), "column-mismatch");
    assert.equal(rejection("| A | B |\n| -- | --- |"), "bad-delimiter");
    assert.equal(rejection("| A | B |\n| :-: | --- |"), "bad-delimiter");
    assert.equal(rejection("| A | B |\n| --- | --- |\n| 1 | 2 | 3 |"), "extra-cells");
    assert.equal(rejection("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |"), "blank-line");
    assert.equal(rejection("| A | B |\n| --- | --- |\n```\n| 1 | 2 |"), "code-fence");
    assert.equal(rejection("| A |\n| --- |"), "single-column");
  });
  it("says which line is at fault", () => {
    const found = analyzeMarkdownTable("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 |");
    assert.match(found.kind === "rejected" ? found.message : "", /Line 4 has 3 cells but the header has 2/);
  });
  it("stays quiet about text that never tried to be a table", () => {
    for (const source of ["just a sentence", "a | b", "a | b\nnot dashes", "a | b\n---", "one\ntwo", "```\n| A | B |\n| --- | --- |\n```", ""]) assert.equal(analyzeMarkdownTable(source).kind, "text", source);
  });
  it("treats an escaped pipe as part of a cell, in the header, the delimiter-free rows and at the end of a line", () => {
    const table = parseMarkdownTable("| a \\| b | c |\n| --- | --- |\n| x \\| y | z \\|");
    assert.deepEqual(table?.rows.map((r) => r.map((c) => c.text)), [["a | b", "c"], ["x | y", "z |"]]);
    assert.equal(table?.columns, 2);
  });
  it("accepts a table without outer pipes and a header-only table", () => {
    assert.equal(parseMarkdownTable("a | b\n--- | ---\n1 | 2")?.rows.length, 2);
    assert.equal(parseMarkdownTable("| a | b |\n| --- | --- |")?.rows.length, 1);
  });
  it("is the same recognizer as before for everything it accepted", () => {
    const cases = ["| Name | Value |\n| :--- | ---: |\n| A\\|B | 123 |\n| C |  |", "| A | B |\n| --- | --- |\n| 1 |", "A|B\n:---:|---\n1|2"];
    for (const source of cases) assert.equal(analyzeMarkdownTable(source).kind, "table", source);
  });
});

describe("diffText", () => {
  it("returns null when nothing changed", () => assert.equal(diffText("same", "same"), null));
  it("finds a single insertion", () => assert.deepEqual(diffText("helo", "hello", 4), { start: 3, end: 3, insert: "l" }));
  it("uses the caret to place a repeated character where it was typed", () => {
    assert.deepEqual(diffText("hello", "helllo", 4), { start: 3, end: 3, insert: "l" });
    assert.deepEqual(diffText("hello", "hhello", 1), { start: 0, end: 0, insert: "h" });
  });
  it("finds a deletion and a replacement", () => {
    assert.deepEqual(diffText("abcdef", "abef"), { start: 2, end: 4, insert: "" });
    assert.deepEqual(diffText("abcdef", "abXYef"), { start: 2, end: 4, insert: "XY" });
  });
  it("never splits a surrogate pair", () => {
    const edit = diffText("a😀b", "a😁b");
    assert.ok(edit);
    assert.equal("a😀b".slice(0, edit.start) + edit.insert + "a😀b".slice(edit.end), "a😁b");
    assert.equal(edit.start, 1);
    assert.equal(edit.end, 3);
  });
  it("is always reversible: applying the edit to the old text gives the new text", () => {
    const pairs: Array<[string, string]> = [["", "abc"], ["abc", ""], ["abc", "abc "], ["one two", "one  two"], ["aaa", "aaaa"], ["x", "y"], ["😀😀", "😀"]];
    for (const [a, b] of pairs) {
      const e = diffText(a, b);
      assert.ok(e, `${a}→${b}`);
      assert.equal(a.slice(0, e.start) + e.insert + a.slice(e.end), b);
    }
  });
});

describe("mapOffset", () => {
  const edit = { start: 5, end: 8, insert: "XY" };
  it("keeps offsets before the edit", () => assert.equal(mapOffset(3, edit), 3));
  it("moves offsets after the edit by the change in length", () => assert.equal(mapOffset(10, edit), 9));
  it("puts offsets inside a replaced range at the end of the insertion", () => assert.equal(mapOffset(6, edit), 7));
});

describe("small helpers", () => {
  it("counts words with apostrophes and hyphens, ignoring object characters", () => {
    assert.equal(countWords("It's a well-known thing"), 4);
    assert.equal(countWords(""), 0);
    assert.equal(countWords("a￼b"), 2);
    assert.equal(countWords("日本語 text"), 2);
  });
  it("splits and cleans pasted text", () => {
    assert.deepEqual(splitLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
    assert.equal(cleanInsert("a\u0000b\u0007c"), "abc");
  });
  it("finds the word at an offset", () => {
    assert.deepEqual(wordAt("hello world", 2), { start: 0, end: 5 });
    assert.deepEqual(wordAt("hello world", 8), { start: 6, end: 11 });
    assert.equal(wordAt("a  b", 2), null);
  });
  it("writes roman numerals", () => {
    assert.equal(roman(4), "iv"); assert.equal(roman(9), "ix"); assert.equal(roman(14), "xiv"); assert.equal(roman(1994), "mcmxciv"); assert.equal(roman(0), "i");
  });
  it("clamps numbers and knows the page sizes", () => {
    assert.equal(clampNumber(5, 1, 3), 3); assert.equal(clampNumber(-5, 1, 3), 1);
    assert.deepEqual(PAGE_MM["A4"], [210, 297]);
    assert.ok(PAGE_MM["Tabloid"]);
  });
});

describe("segments", () => {
  it("keeps inline font family and point size on exactly the selected text", () => {
    const out = segments({ text: "abcdef", spans: [{ type: "format", start: 1, end: 4, font_family: "Georgia", font_size_pt: 14.5, color: "#112233" }] });
    assert.deepEqual(out.map((s) => s.text), ["a", "bcd", "ef"]);
    assert.equal(out[0]?.font_family, undefined);
    assert.deepEqual([out[1]?.font_family, out[1]?.font_size_pt, out[1]?.color], ["Georgia", 14.5, "#112233"]);
    assert.equal(out[2]?.font_size_pt, undefined);
  });
  it("splits text at span boundaries and carries the flags", () => {
    const out = segments({ text: "abcdef", spans: [{ type: "format", start: 1, end: 3, bold: true }, { type: "format", start: 2, end: 5, italic: true }] } as never);
    assert.deepEqual(out.map((s) => s.text), ["a", "b", "c", "de", "f"]);
    assert.equal(out[1]?.flags.bold, true);
    assert.equal(out[2]?.flags.bold, true);
    assert.equal(out[2]?.flags.italic, true);
    assert.equal(out[3]?.flags.italic, true);
    assert.equal(out[4]?.flags.italic, undefined);
  });
  it("covers the whole text with no gaps or overlaps", () => {
    const text = "The quick brown fox";
    const out = segments({ text, spans: [{ type: "format", start: 4, end: 9, bold: true }] } as never);
    assert.equal(out.map((s) => s.text).join(""), text);
    for (let i = 1; i < out.length; i++) assert.equal(out[i]?.start, out[i - 1]?.end);
  });
});

describe("code-point offsets", () => {
  it("counts an astral character once, as the server does", () => {
    assert.equal(toCodepoints("😀ab", 2), 1);
    assert.equal(toCodepoints("😀ab", 3), 2);
    assert.equal(toCodepoints("plain", 3), 3);
    assert.equal(toCodepoints("", 0), 0);
  });
});

describe("typed Markdown table", () => {
  it("starts from a header line and a delimiter line, with one empty row to type in", () => {
    const table = typedTableStart("| Name | Qty |", "| :--- | ---: |");
    assert.equal(table?.columns, 2);
    assert.equal(table?.header_rows, 1);
    assert.deepEqual(table?.rows.map((row) => row.map((c) => c.text)), [["Name", "Qty"], ["", ""]]);
  });
  it("accepts lines without outer pipes, as GFM does", () => {
    assert.equal(typedTableStart("A | B | C", "--- | --- | ---")?.columns, 3);
  });
  it("rejects prose, mismatched columns, weak delimiters and inline objects", () => {
    const cases: Array<[string, string]> = [["Just a sentence", "| --- | --- |"], ["| A | B |", "| --- |"], ["| A | B |", "| -- | -- |"], ["| A | B |", "| a | b |"], ["| A | \uFFFC |", "| --- | --- |"]];
    for (const [header, delimiter] of cases) assert.equal(typedTableStart(header, delimiter), null, `${header} / ${delimiter}`);
  });
});
