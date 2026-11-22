import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOCORRECT_DEFAULTS, AppliedLog, RULES, Suppressions, allowedIn, autoCorrectSettings, caretAfter, capitalizeBeforeEnter, correctTyping, finishesWord,
  isAutoCorrectLabel, isRuleTrigger, ruleOnEnter, startsSentence, transformPasted, type AutoCorrectSettings, type Correction,
} from "../src/client/autocorrect.js";

interface Typing { initial?: string; lang?: string; settings?: Partial<AutoCorrectSettings>; code?: boolean; suppress?: Suppressions; made?: Correction[]; protectedAt?: (o: number) => boolean }

/** Type `chars` one key at a time into a field, correcting exactly as the editor does after each keystroke. Returns the text and the caret. */
function type(chars: string, o: Typing = {}): { text: string; caret: number } {
  const settings = { ...AUTOCORRECT_DEFAULTS, ...o.settings };
  let text = o.initial ?? "";
  let caret = text.length;
  for (const ch of chars) {
    text = text.slice(0, caret) + ch + text.slice(caret);
    caret += ch.length;
    const hit = correctTyping({ text, caret, typed: ch, lang: o.lang ?? "en", ...(o.code ? { code: true } : {}), ...(o.protectedAt ? { protectedAt: o.protectedAt } : {}) }, settings,
      o.suppress ? (c) => o.suppress!.has("b1", c) : undefined);
    if (hit) { o.made?.push(hit); text = text.slice(0, hit.start) + hit.insert + text.slice(hit.end); caret = caretAfter(caret, hit); }
  }
  return { text, caret };
}
const typed = (chars: string, o?: Typing): string => type(chars, o).text;

describe("sentence capitalisation: the examples in the specification", () => {
  it("capitalises the first letter of a paragraph", () => assert.equal(typed("hello world."), "Hello world."));
  it("capitalises after a full stop, an exclamation mark and a question mark", () => {
    assert.equal(typed("hello. how are you?"), "Hello. How are you?");
    assert.equal(typed("hello! welcome back."), "Hello! Welcome back.");
    assert.equal(typed("really? yes. fine! ok "), "Really? Yes. Fine! Ok ");
  });
  it("capitalises the name after a title abbreviation", () => assert.equal(typed("dr. smith arrived."), "Dr. Smith arrived."));
  it("does not mistake a decimal number for the end of a sentence", () => assert.equal(typed("the value is 3.14."), "The value is 3.14."));
  it("leaves an address alone", () => assert.equal(typed("visit example.com"), "Visit example.com"));
  it("does capitalise after a number that ends a sentence", () => assert.equal(typed("the value is 3.14. then we stop"), "The value is 3.14. Then we stop"));
});

describe("sentence capitalisation: what it must not touch", () => {
  it("keeps the case after abbreviations", () => {
    assert.equal(typed("we sell apples, pears, etc. and more"), "We sell apples, pears, etc. and more");
    assert.equal(typed("use a tool, e.g. a hammer, or i.e. this one"), "Use a tool, e.g. a hammer, or i.e. this one");
    assert.equal(typed("see fig. two and vs. the rest"), "See fig. two and vs. the rest");
    assert.equal(typed("john smith jr. lives here"), "John smith jr. lives here");
  });
  it("keeps the case after an initial or a dotted acronym", () => {
    assert.equal(typed("j. smith and the u.s. government"), "J. smith and the u.s. government");
    assert.equal(typed("the u.s. government"), "The u.s. government");
  });
  it("treats \"I.\" as the end of a sentence", () => assert.equal(typed("so did I. then we left"), "So did I. Then we left"));
  it("does not end a sentence at an ellipsis", () => assert.equal(typed("wait... what is that"), "Wait... what is that"));
  it("leaves identifiers, numbers, paths, addresses and mixed case words as they are", () => {
    for (const word of ["example.com", "www.example.org/page", "user@example.com", "C:\\temp\\file.txt", "/usr/bin/env", "snake_case", "iPhone", "eBay", "3rd", "v1.2.3", "#tag", "@name", "a=b", "<tag>"]) {
      assert.equal(typed(`${word} is here`), `${word} is here`, word);
    }
  });
  it("never changes a word inside a sentence, nor the rest of a word", () => assert.equal(typed("this is fine and so is that"), "This is fine and so is that"));
  it("leaves text that is already capitalised alone, and text with no case", () => {
    assert.equal(typed("Hello. World. NASA launched. 日本語 です。"), "Hello. World. NASA launched. 日本語 です。");
  });
  it("does nothing inside a code block or inline code", () => {
    assert.equal(typed("hello. world ", { code: true }), "hello. world ");
    assert.equal(typed("hello world ", { protectedAt: () => true }), "hello world ");
  });
  it("does not capitalise in the middle of a line that continues a sentence", () => assert.equal(typed("she said, \"hello\", then left"), "She said, \"hello\", then left"));
});

describe("sentence capitalisation: boundaries, quotes, brackets and line breaks", () => {
  it("handles closing quotes and brackets after the end of a sentence", () => {
    assert.equal(typed("he left. \"come back.\" \"never!\" (maybe.) ok "), "He left. \"Come back.\" \"Never!\" (Maybe.) Ok ");
  });
  it("handles an opening quote or bracket at the start of a sentence", () => assert.equal(typed("(see below) \"quoted\" text"), "(See below) \"quoted\" text"));
  it("handles several spaces and mixed punctuation between sentences", () => assert.equal(typed("one.  two?! three.\tfour "), "One.  Two?! Three.\tFour "));
  it("treats a line break inside a paragraph as a boundary", () => assert.equal(typed("first line\nsecond line"), "First line\nSecond line"));
  it("treats the start of a field as a boundary even after blanks", () => assert.equal(typed("  hello there"), "  Hello there"));
  it("capitalises the last word of a paragraph when Enter is pressed", () => {
    assert.equal(capitalizeBeforeEnter("hello.", 6, "en")?.insert, "H");
    assert.equal(capitalizeBeforeEnter("hello world.", 12, "en"), null);
    assert.equal(capitalizeBeforeEnter("Hello.", 6, "en"), null);
    assert.equal(capitalizeBeforeEnter("hello.", 6, "en", true), null);
  });
  it("does not run at the full stop itself (it may belong to an address or a number)", () => {
    assert.equal(finishesWord("."), false);
    assert.equal(typed("hello."), "hello.");
    assert.equal(typed("example.com"), "example.com");
  });
  it("startsSentence answers for the field's first word either way", () => {
    assert.equal(startsSentence("hello", 0), true);
    assert.equal(startsSentence("hello", 0, false), false);
  });
});

describe("sentence capitalisation: Unicode and language", () => {
  it("capitalises accented and non-Latin letters", () => {
    assert.equal(typed("école. élan vital. ärger! öl? ñandú "), "École. Élan vital. Ärger! Öl? Ñandú ");
    assert.equal(typed("привет. мир "), "Привет. Мир ");
    assert.equal(typed("ελλάδα. αθήνα "), "Ελλάδα. Αθήνα ");
  });
  it("uses the document language for the dotted and dotless i", () => {
    assert.equal(typed("istanbul. ılık ", { lang: "tr" }), "İstanbul. Ilık ");
    assert.equal(typed("istanbul. ılık ", { lang: "en" }), "Istanbul. Ilık ");
  });
  it("writes the Dutch IJ as two capitals", () => {
    assert.equal(typed("ijs is koud. ijsselmeer ", { lang: "nl-NL" }), "IJs is koud. IJsselmeer ");
    assert.equal(typed("ijs is koud.", { lang: "en" }), "Ijs is koud.");
  });
  it("skips a letter that has no one-letter capital (the length of the text never changes)", () => assert.equal(typed("ßa is odd"), "ßa is odd"));
  it("handles letters outside the Basic Multilingual Plane", () => assert.equal(typed("𐐨𐐯 test. 𐐨𐐯 again"), "𐐀𐐯 test. 𐐀𐐯 again".replace("𐐀𐐯 test", "𐐀𐐯 test")));
  it("works after an emoji without moving anything else", () => assert.equal(typed("😀 hello. world "), "😀 hello. World "));
});

describe("em dash", () => {
  it("converts two hyphens the moment the second is typed", () => {
    assert.equal(typed("Hello--world"), "Hello—world");
    assert.equal(typed("Wait--what?"), "Wait—what?");
    assert.equal(typed("2025--2026"), "2025—2026");
    assert.equal(typed("--"), "—");
  });
  it("converts as soon as the second hyphen is typed and keeps the caret after the dash", () => {
    const r = type("a--");
    assert.equal(r.text, "a—");
    assert.equal(r.caret, 2);
    const m = type("--", { initial: "ab" });
    assert.equal(m.text, "ab—");
  });
  it("inserts no spaces", () => assert.equal(typed("a--b"), "a—b"));
  it("leaves a single hyphen, a spaced hyphen, a range and a longer run alone", () => {
    assert.equal(typed("well-known - yes"), "Well-known - yes");
    assert.equal(typed("a - b"), "A - b");
    assert.equal(typed("1-2"), "1-2");
    assert.equal(typed("a-b-c"), "a-b-c");
    assert.equal(typed("---"), "—-", "converted the moment the second hyphen was typed; a third one is just a hyphen");
  });
  it("leaves code, paths, addresses, options and comments alone", () => {
    assert.equal(typed("--help", { code: true }), "--help");
    assert.equal(typed("--", { protectedAt: () => true }), "--");
    assert.equal(typed("http://example.com/a--b"), "http://example.com/a--b");
    assert.equal(typed("C:\\dir\\a--b"), "C:\\dir\\a--b");
    assert.equal(typed("--key=value"), "—key=value", "the option's hyphens come first: the dash is made before '=' is known");
    assert.equal(typed("run a--b=c"), "Run a—b=c");
    assert.equal(typed("<!--"), "<!--");
    assert.equal(typed("user@host--x"), "user@host--x");
  });
  it("is not applied when the hyphens are inserted before an existing hyphen", () => {
    const r = correctTyping({ text: "---", caret: 2, typed: "-", lang: "en" }, AUTOCORRECT_DEFAULTS);
    assert.equal(r, null);
  });
  it("can be switched off on its own", () => {
    assert.equal(typed("a--b. c ", { settings: { dash: false } }), "A--b. C ");
    assert.equal(typed("a--b. c ", { settings: { capitalize: false } }), "a—b. c ");
  });
});

describe("rules, priorities and settings", () => {
  it("lists the rules in explicit priority order, the em dash first", () => assert.deepEqual(RULES.map((r) => r.id), ["dash", "capitalize"]));
  it("switches every rule off with its own setting", () => {
    assert.equal(typed("hello. world--x", { settings: { capitalize: false, dash: false } }), "hello. world--x");
  });
  it("makes a change only for a single typed character that is really before the caret", () => {
    assert.equal(correctTyping({ text: "hello ", caret: 6, typed: "  ", lang: "en" }, AUTOCORRECT_DEFAULTS), null);
    assert.equal(correctTyping({ text: "hello x", caret: 7, typed: " ", lang: "en" }, AUTOCORRECT_DEFAULTS), null, "the typed character is not where the caret says");
    assert.equal(correctTyping({ text: " ", caret: 0, typed: " ", lang: "en" }, AUTOCORRECT_DEFAULTS), null);
  });
  it("is idempotent: typing the same thing again changes nothing more", () => {
    const once = typed("hello. world--x. ok ");
    assert.equal(once, "Hello. World—x. Ok ");
    for (let i = 0; i < once.length; i += 1) {
      const hit = correctTyping({ text: once, caret: i + 1, typed: once[i] as string, lang: "en" }, AUTOCORRECT_DEFAULTS);
      assert.equal(hit, null, `position ${i}`);
    }
  });
  it("applies several corrections in a row without disturbing the caret", () => {
    const r = type("one--two. three--four. five ");
    assert.equal(r.text, "One—two. Three—four. Five ");
    assert.equal(r.caret, r.text.length);
  });
  it("reads the settings from the preferences, with defaults for an older preferences file", () => {
    assert.deepEqual(autoCorrectSettings(undefined), AUTOCORRECT_DEFAULTS);
    assert.deepEqual(autoCorrectSettings({}), AUTOCORRECT_DEFAULTS);
    assert.equal(autoCorrectSettings({ autocorrect_capitalize: false } as never).capitalize, false);
    assert.equal(autoCorrectSettings({ autocorrect_paste: "yes" } as never).paste, false, "only a real boolean counts");
  });
  it("corrects cells and text boxes only when that is on, and never captions", () => {
    assert.equal(allowedIn("text", { ...AUTOCORRECT_DEFAULTS, regions: false }), true);
    assert.equal(allowedIn("cell", AUTOCORRECT_DEFAULTS), true);
    assert.equal(allowedIn("textbox", { ...AUTOCORRECT_DEFAULTS, regions: false }), false);
    assert.equal(allowedIn("caption", AUTOCORRECT_DEFAULTS), false);
  });
});

describe("undo: a correction that was taken back is not made again", () => {
  it("does not repeat the same correction at the same place", () => {
    const sup = new Suppressions();
    const made: Correction[] = [];
    assert.equal(typed("hello world", { made, suppress: sup }), "Hello world");
    sup.add("b1", made[0] as Correction);                                  // the person pressed Undo
    assert.equal(typed("hello world", { suppress: sup }), "hello world");
    const dash: Correction[] = [];
    typed("a--", { made: dash, suppress: sup });
    sup.add("b1", dash[0] as Correction);
    assert.equal(typed("a--", { suppress: sup }), "a--");
    assert.equal(typed("a--b--", { suppress: sup }), "a--b--".replace("b--", "b—"), "another place is still corrected");
  });
  it("keeps a log so Undo knows which correction it took back", () => {
    const log = new AppliedLog();
    const a: Correction = { rule: "dash", start: 1, end: 3, insert: "—", original: "--" };
    const b: Correction = { rule: "capitalize", start: 0, end: 1, insert: "H", original: "h" };
    log.push("x", a); log.push("y", b);
    assert.equal(log.pop()?.correction, b);
    assert.equal(log.pop()?.block, "x");
    assert.equal(log.pop(), undefined);
  });
  it("recognises its own undo steps by their label", () => {
    assert.equal(isAutoCorrectLabel("AutoCorrect: em dash"), true);
    assert.equal(isAutoCorrectLabel("typing"), false);
    assert.equal(isAutoCorrectLabel(null), false);
  });
});

describe("the horizontal rule trigger", () => {
  it("accepts exactly three underscores with blanks around them", () => {
    for (const t of ["___", " ___", "___ ", "\t___\t", "\u00a0___"]) assert.equal(isRuleTrigger(t), true, JSON.stringify(t));
  });
  it("refuses anything else, so ordinary underscores still work", () => {
    for (const t of ["", "_", "__", "____", "_____", "a___", "___a", "_ _ _", "___ x", "- - -", "___\n___", "snake___case"]) assert.equal(isRuleTrigger(t), false, JSON.stringify(t));
  });
  it("needs the caret after the underscores, a plain paragraph and the setting", () => {
    assert.equal(ruleOnEnter("___", 3, "paragraph", AUTOCORRECT_DEFAULTS), true);
    assert.equal(ruleOnEnter("  ___  ", 7, "paragraph", AUTOCORRECT_DEFAULTS), true);
    assert.equal(ruleOnEnter("___", 1, "paragraph", AUTOCORRECT_DEFAULTS), false, "the caret is inside the three underscores");
    assert.equal(ruleOnEnter("___", 3, "code", AUTOCORRECT_DEFAULTS), false);
    assert.equal(ruleOnEnter("___", 3, "heading", AUTOCORRECT_DEFAULTS), false);
    assert.equal(ruleOnEnter("___", 3, "paragraph", { ...AUTOCORRECT_DEFAULTS, rule: false }), false);
  });
});

describe("pasted text", () => {
  const on = { ...AUTOCORRECT_DEFAULTS, paste: true };
  it("is never changed unless the setting is on", () => assert.equal(transformPasted("hello--world. next", AUTOCORRECT_DEFAULTS, { startsSentence: true, lang: "en" }), "hello--world. next"));
  it("is corrected with the same rules when it is on", () => {
    assert.equal(transformPasted("hello--world. next one", on, { startsSentence: true, lang: "en" }), "Hello—world. Next one");
    assert.equal(transformPasted("hello. next", on, { startsSentence: false, lang: "en" }), "hello. Next");
  });
  it("leaves code, tables, long passages and addresses alone", () => {
    for (const t of ["a\tb\nc\td", "```\nx--y\n```", "| a | b |\n| - | - |", "$ ls --all", "x".repeat(6000), "see http://a.com/x--y now"]) {
      const out = transformPasted(t, on, { startsSentence: true, lang: "en" });
      if (t.startsWith("see http")) assert.equal(out, "See http://a.com/x--y now");
      else assert.equal(out, t);
    }
  });
});

describe("speed", () => {
  it("does not slow down in a very large field (it only reads around the caret)", () => {
    const big = "lorem ipsum dolor sit amet. ".repeat(40000);
    const start = process.hrtime.bigint();
    let text = big;
    let caret = text.length;
    for (const ch of "hello. world--x ") {
      text = text.slice(0, caret) + ch + text.slice(caret);
      caret += 1;
      correctTyping({ text, caret, typed: ch, lang: "en" }, AUTOCORRECT_DEFAULTS);
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 400, `16 keystrokes in a ${big.length}-character field took ${ms.toFixed(1)} ms`);
  });
});
