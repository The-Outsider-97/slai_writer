/** AutoCorrect and AutoFormat: the pure rules. Nothing here touches the DOM, the server or the editor, so every rule can be tested with plain strings.
 *
 *  One pipeline serves the whole editor (see `autocorrect_dom.ts` for the glue). A rule looks at what was just typed and the text around the caret and answers
 *  with at most one `Correction`: a single replacement of a range of the field's text. Rules have explicit priorities (the first rule that applies wins), each
 *  is switched on and off by its own setting, and none of them ever looks at more than the line around the caret, so the cost of a keystroke does not grow with
 *  the size of the document. Offsets are UTF-16 code units, the same as the text the editor holds.
 *
 *  - `dash`: two hyphens become an em dash the moment the second one is typed.
 *  - `capitalize`: the first letter of a sentence is capitalised when its word is finished (a space, a comma, Enter ...).
 *  - `___` + Enter (the horizontal rule) is a paragraph-level format, decided by `isRuleTrigger`; it runs on Enter, in `actions.ts`. */
import { mapOffset } from "./textops.js";
export const AUTOCORRECT_DEFAULTS = { capitalize: true, dash: true, rule: true, regions: true, paste: false };
/** The settings as the preferences hold them (`autocorrect_*`); anything missing (an older preferences file) takes its default. */
export function autoCorrectSettings(prefs) {
    const p = (prefs ?? {});
    const flag = (key, fallback) => (typeof p[key] === "boolean" ? p[key] : fallback);
    return {
        capitalize: flag("autocorrect_capitalize", AUTOCORRECT_DEFAULTS.capitalize), dash: flag("autocorrect_dash", AUTOCORRECT_DEFAULTS.dash),
        rule: flag("autocorrect_rule", AUTOCORRECT_DEFAULTS.rule), regions: flag("autocorrect_regions", AUTOCORRECT_DEFAULTS.regions),
        paste: flag("autocorrect_paste", AUTOCORRECT_DEFAULTS.paste),
    };
}
/** The ordinary text of a page is always corrected; table cells and text boxes only when the person left that on. */
export function allowedIn(kind, settings) {
    if (kind === "text")
        return true;
    if (kind === "caption")
        return false;
    return settings.regions;
}
const SPACE = /[\s\u00a0]/u;
const isSpace = (c) => c !== undefined && SPACE.test(c);
const CLOSERS = "\"'”’)]}»›";
const OPENERS = /^[("'“‘[{¿¡«‹]*/u;
const TRAILING = /[.,;:!?)\]}"”’»›…—–-]+$/u;
/** Characters inside a word that mark it as something other than prose: a number, an address, a path, a command, an identifier. */
const STRUCTURED = /[\d@\\/_=<>{}[\]|~^*+%&#$`]/u;
/** Titles that are always followed by a name: the word after "Dr." starts with a capital although "Dr." is not the end of a sentence. */
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "rev", "hon", "gen", "col", "lt", "capt", "sgt", "fr", "messrs", "mme", "mlle", "drs", "ir", "dhr", "mevr"]);
/** Abbreviations that do not end a sentence: what follows them keeps its case. */
const ABBREVIATIONS = new Set([
    "etc", "vs", "cf", "approx", "esp", "fig", "figs", "eq", "eqs", "vol", "vols", "pp", "p", "ch", "sec", "al", "inc", "ltd", "co", "corp", "dept", "est", "avg",
    "ca", "viz", "ibid", "op", "cit", "resp", "incl", "excl", "jr", "sr", "st", "ave", "blvd", "rd", "mt", "ft", "ed", "eds", "trans", "repr",
    "bijv", "enz", "evt", "bv", "nr", "blz",
]);
// ------------------------------------------------------------------------------------------------------------- sentence boundaries
/** True when the word that begins at `start` begins a sentence: the start of the field, the start of a line, or the word after a full stop, question mark or
 *  exclamation mark (and any closing quotes or brackets) that really ends a sentence. A full stop that belongs to an abbreviation ("etc."), an initial ("J."),
 *  a dotted acronym ("e.g.") or an ellipsis does not end one; a title ("Dr.") does not end one either but is always followed by a name, so the answer is true. */
export function startsSentence(text, start, atStart = true) {
    let i = start;
    let crossedSpace = false;
    let crossedBreak = false;
    while (i > 0 && isSpace(text[i - 1])) {
        if (text[i - 1] === "\n")
            crossedBreak = true;
        crossedSpace = true;
        i -= 1;
    }
    if (i === 0)
        return atStart;
    if (crossedBreak)
        return true;
    if (!crossedSpace)
        return false;
    let j = i;
    while (j > 0 && CLOSERS.includes(text[j - 1]))
        j -= 1;
    const mark = text[j - 1];
    if (mark === "?" || mark === "!")
        return true;
    if (mark !== ".")
        return false;
    let k = j - 1;
    while (k > 0 && text[k - 1] === ".")
        k -= 1;
    if (j - k >= 2)
        return false; // an ellipsis: the sentence goes on
    let p = k;
    while (p > 0 && !isSpace(text[p - 1]))
        p -= 1;
    const word = text.slice(p, k).replace(OPENERS, "");
    if (!word)
        return false;
    const lower = word.toLowerCase();
    if (TITLES.has(lower))
        return true;
    if (ABBREVIATIONS.has(lower))
        return false;
    if (/^(?:\p{L}\.)+\p{L}$/u.test(word))
        return false; // e.g. i.e. U.S. a.m.
    if (/^\p{L}$/u.test(word))
        return word === "I"; // an initial ("J. Smith"), but "so did I." ends a sentence
    return true;
}
function upperOf(ch, lang) {
    try {
        return ch.toLocaleUpperCase(lang || undefined);
    }
    catch {
        return ch.toUpperCase();
    }
}
/** The capital for the word `rest` (it starts with a lowercase letter), or null when there is none of the same length (ß, ǆ ...): a correction never changes the length of the text. */
function capitalFor(rest, lang) {
    if (/^nl(?:[-_]|$)/i.test(lang) && rest.startsWith("ij"))
        return { length: 2, insert: "IJ" }; // Dutch: IJsselmeer, IJs
    const first = String.fromCodePoint(rest.codePointAt(0));
    const upper = upperOf(first, lang);
    if (upper === first || upper.length !== first.length)
        return null;
    return { length: first.length, insert: upper };
}
/** The correction for the word `token` that begins at `start` (opening quotes and brackets belong to the token), or null. `protectedAt` marks inline code. */
function capitalizeToken(text, start, token, lang, atStart, protectedAt) {
    const lead = (OPENERS.exec(token) ?? [""])[0].length;
    const rest = token.slice(lead);
    if (!rest || !/^\p{Ll}/u.test(rest))
        return null;
    const core = rest.replace(TRAILING, "");
    if (!core || STRUCTURED.test(core) || core.includes("."))
        return null; // example.com, e.g, 3rd, user@host, a_b, C:\path, #tag ...
    if (/\p{Lu}/u.test(core.slice(1)))
        return null; // iPhone, eBay, macOS: intentionally mixed case
    const at = start + lead;
    if (protectedAt?.(at))
        return null;
    if (!startsSentence(text, start, atStart))
        return null;
    const cap = capitalFor(rest, lang);
    if (!cap)
        return null;
    return { rule: "capitalize", start: at, end: at + cap.length, insert: cap.insert, original: text.slice(at, at + cap.length) };
}
const TRIGGERS = ",;!?)]"; // no ":": "http:" must not be capitalised before "//" is typed;
/** The characters that finish a word: a space of any kind, or one of these marks. A full stop is not one: it may belong to an abbreviation, a number or an address. */
export function finishesWord(typed) {
    return typed.length === 1 && (isSpace(typed) || TRIGGERS.includes(typed));
}
function capitalizeRule(ctx) {
    if (ctx.code || !finishesWord(ctx.typed))
        return null;
    const end = isSpace(ctx.typed) ? ctx.caret - 1 : ctx.caret;
    let start = end;
    while (start > 0 && !isSpace(ctx.text[start - 1]))
        start -= 1;
    if (end <= start)
        return null;
    return capitalizeToken(ctx.text, start, ctx.text.slice(start, end), ctx.lang, true, ctx.protectedAt);
}
/** The word just before the caret when Enter is pressed (nothing was typed after it): it may end a one-word sentence ("hello.") and still needs its capital. */
export function capitalizeBeforeEnter(text, caret, lang, code = false) {
    if (code)
        return null;
    return capitalizeRule({ text, caret: caret + 1, typed: "\n", lang });
}
// ------------------------------------------------------------------------------------------------------------- em dash
function dashRule(ctx) {
    const { text, caret } = ctx;
    if (ctx.code || ctx.typed !== "-" || caret < 2 || text[caret - 1] !== "-" || text[caret - 2] !== "-")
        return null;
    if (text[caret - 3] === "-" || text[caret] === "-")
        return null; // three or more hyphens: a ruler line or Markdown rule, left alone
    if (ctx.protectedAt?.(caret - 1) || ctx.protectedAt?.(caret - 2))
        return null;
    if (text.slice(caret - 4, caret - 2) === "<!")
        return null; // <!-- an HTML comment
    let s = caret - 2;
    while (s > 0 && !isSpace(text[s - 1]))
        s -= 1;
    if (/[:/\\@=]/.test(text.slice(s, caret - 2)))
        return null; // inside an address, a path or an assignment (--key=value, C:\a--b)
    return { rule: "dash", start: caret - 2, end: caret, insert: "—", original: "--" };
}
/** Every rule, in the order they are tried: the first that applies wins. The triggers differ, so at most one can apply to a keystroke, but the order is explicit. */
const ALL_RULES = [
    { id: "capitalize", priority: 20, label: "capital letter", enabled: (s) => s.capitalize, apply: capitalizeRule },
    { id: "dash", priority: 10, label: "em dash", enabled: (s) => s.dash, apply: dashRule },
];
export const RULES = ALL_RULES.sort((a, b) => a.priority - b.priority);
/** What to do about one keystroke: the correction, or null. `typed` must be exactly one character that now sits just before the caret. */
export function correctTyping(ctx, settings, suppressed) {
    if (ctx.typed.length !== 1 || ctx.caret < 1 || ctx.text[ctx.caret - 1] !== ctx.typed)
        return null;
    for (const rule of RULES) {
        if (!rule.enabled(settings))
            continue;
        const found = rule.apply(ctx);
        if (found && !suppressed?.(found))
            return found;
    }
    return null;
}
/** The edit as the editor's text arithmetic knows it, and where a caret ends up after it. */
export const asEdit = (c) => ({ start: c.start, end: c.end, insert: c.insert });
export const caretAfter = (caret, c) => mapOffset(caret, asEdit(c));
// ------------------------------------------------------------------------------------------------------------- the horizontal rule
/** A paragraph that holds only three underscores (blanks around them do not count) and nothing else. Four are an ordinary line of underscores. */
export function isRuleTrigger(text) { return /^[ \t\u00a0]*___[ \t\u00a0]*$/.test(text); }
/** True when Enter with the caret at `offset` in this paragraph should make a rule: the caret is after the three underscores, not in the middle of them. */
export function ruleOnEnter(text, offset, blockType, settings) {
    if (!settings.rule || blockType !== "paragraph" || !isRuleTrigger(text))
        return false;
    return offset >= text.indexOf("___") + 3;
}
// ------------------------------------------------------------------------------------------------------------- undo and "do not do it again"
/** Corrections the person took back with Undo. The same correction is not made again at the same place, so Undo is not fought with. */
export class Suppressions {
    items = [];
    key(block, c) { return `${block}\u0000${c.rule}\u0000${c.start}\u0000${c.original}`; }
    add(block, c) { this.items.push(this.key(block, c)); if (this.items.length > 200)
        this.items.shift(); }
    has(block, c) { return this.items.includes(this.key(block, c)); }
    clear() { this.items.length = 0; }
}
/** The corrections made, newest last, so Undo can tell which one it just took back. */
export class AppliedLog {
    items = [];
    push(block, correction) { this.items.push({ block, correction }); if (this.items.length > 100)
        this.items.shift(); }
    /** The newest correction (it is the one the server's Undo takes back first). */
    pop() { return this.items.pop(); }
    clear() { this.items.length = 0; }
    get size() { return this.items.length; }
}
/** The label of the undo step an AutoCorrect change makes (the server shows it as "Undo AutoCorrect: ..."). */
export const AUTOCORRECT_LABEL = "AutoCorrect";
export const isAutoCorrectLabel = (label) => typeof label === "string" && label.startsWith(AUTOCORRECT_LABEL);
// ------------------------------------------------------------------------------------------------------------- pasted text
/** Pasted text is only touched when the person asked for it, never when it looks like code, a table or a long document, and the same rules as typing apply. */
export const PASTE_LIMIT = 5000;
export function transformPasted(text, settings, opts) {
    if (!settings.paste || !(settings.dash || settings.capitalize) || text.length === 0 || text.length > PASTE_LIMIT)
        return text;
    if (text.includes("\t") || text.includes("```") || /^\s*(?:[|]|[$>#]\s)/m.test(text))
        return text; // a table, a code fence, a prompt or a Markdown table
    const edits = [];
    const parts = text.split(/(\s+)/);
    let offset = 0;
    for (const part of parts) {
        if (part && !isSpace(part[0])) {
            if (settings.dash && part.includes("--") && !/[:/\\@=]/.test(part)) {
                for (const m of part.matchAll(/(?<!-)--(?!-)/g))
                    edits.push({ rule: "dash", start: offset + m.index, end: offset + m.index + 2, insert: "—", original: "--" });
            }
            if (settings.capitalize) {
                const c = capitalizeToken(text, offset, part, opts.lang, opts.startsSentence);
                if (c)
                    edits.push(c);
            }
        }
        offset += part.length;
    }
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start))
        out = out.slice(0, e.start) + e.insert + out.slice(e.end);
    return out;
}
