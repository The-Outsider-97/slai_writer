/** AutoCorrect and AutoFormat in the editor: the glue between the pure rules (`autocorrect.ts`) and the DOM, the operation queue and the undo history.
 *
 *  The flow for one keystroke: the browser has already inserted the character (typing stays native, so the caret, IME and spell-check behave as usual), `input`
 *  fires, and `afterInput` asks the rules whether the line around the caret needs a correction. If it does:
 *   1. the typed text is flushed first, so the server has the keystroke as its own step;
 *   2. the DOM text node is edited in place (no re-render) and the caret is put back where the person expects it;
 *   3. the correction is sent as a *labelled batch*, which the server keeps as one separate undo step. Undo therefore takes back the correction and
 *      leaves the typed characters, and the correction is remembered (`Suppressions`) so it is not made again at that place.
 *  Nothing here scans the document: a keystroke reads the one field the caret is in. */
import {
  AUTOCORRECT_LABEL, AppliedLog, Suppressions, allowedIn, autoCorrectSettings, capitalizeBeforeEnter, caretAfter, correctTyping, isAutoCorrectLabel,
  ruleOnEnter, startsSentence, transformPasted, type AutoCorrectSettings, type Correction, type FieldKind,
} from "./autocorrect.js";
import { caretAt, offsetOf, pointFor, rangeFor, serialise, placeCaret } from "./domtext.js";
import type { Editor } from "./editor.js";
import { toCodepoints } from "./textops.js";
import type { Op } from "./types.js";

const RULE_NAMES: Record<Correction["rule"], string> = { dash: "em dash", capitalize: "capital letter" };

export class AutoCorrect {
  /** Corrections the person took back with Undo: they are not made again at the same place. */
  readonly suppressed = new Suppressions();
  /** Corrections made, newest last, so Undo knows which one it just took back. */
  readonly applied = new AppliedLog();

  constructor(private readonly ed: Editor) {}

  settings(): AutoCorrectSettings { return autoCorrectSettings(this.ed.hooks.prefs()); }

  private language(): string { return this.ed.model.meta.language || this.ed.hooks.prefs().language || "en"; }

  private kindOf(field: HTMLElement): FieldKind {
    const kind = field.dataset["edit"];
    return kind === "cell" ? "cell" : kind === "caption" ? "caption" : "text";
  }

  private keyOf(field: HTMLElement, id: string): string {
    return field.dataset["edit"] === "cell" ? `${id}#${field.dataset["row"]},${field.dataset["col"]}` : field.dataset["edit"] === "caption" ? `${id}#cap` : id;
  }

  /** True when text in this block is code: a code block, where nothing is ever corrected. */
  private isCode(id: string): boolean { return this.ed.model.block(id)?.type === "code"; }

  /** Whether the character at `offset` of the field is formatted as inline code. */
  private inlineCode(field: HTMLElement): (offset: number) => boolean {
    return (offset) => {
      const at = pointFor(field, offset + 1).node;
      return !!(at.nodeType === Node.TEXT_NODE ? at.parentElement : (at as Element))?.closest("code.i-code");
    };
  }

  /** Called from the `input` event, after the editor has recorded the keystroke. Returns true when it made a correction. */
  afterInput(field: HTMLElement, e: InputEvent): boolean {
    const ed = this.ed;
    if (ed.readOnly || ed.composing || e.isComposing || e.inputType !== "insertText" || typeof e.data !== "string" || e.data.length !== 1) return false;
    const settings = this.settings();
    if (!(settings.capitalize || settings.dash) || !allowedIn(this.kindOf(field), settings)) return false;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || !selection.anchorNode || !field.contains(selection.anchorNode)) return false;
    const point = caretAt(selection.anchorNode, selection.anchorOffset);
    if (!point) return false;
    const id = point.block;
    const text = serialise(field);
    const hit = correctTyping({ text, caret: point.offset, typed: e.data, lang: this.language(), code: this.isCode(id), protectedAt: this.inlineCode(field) }, settings,
      (c) => this.suppressed.has(id, c));
    if (!hit) return false;
    return this.apply(field, id, text, point.offset, hit);
  }

  /** Typing in a text box: its paragraphs live in the DOM only and are saved when editing ends, so the correction is a DOM edit with no operation of its own.
   *  (The browser's own history is what Undo uses in there.) Returns true when it made a correction. */
  afterBoxInput(paragraph: HTMLElement, e: InputEvent): boolean {
    const ed = this.ed;
    if (ed.readOnly || ed.composing || e.isComposing || e.inputType !== "insertText" || typeof e.data !== "string" || e.data.length !== 1) return false;
    const settings = this.settings();
    if (!(settings.capitalize || settings.dash) || !allowedIn("textbox", settings)) return false;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || !selection.anchorNode || !paragraph.contains(selection.anchorNode)) return false;
    const caret = offsetOf(paragraph, selection.anchorNode, selection.anchorOffset);
    const text = serialise(paragraph);
    const hit = correctTyping({ text, caret, typed: e.data, lang: this.language(), protectedAt: this.inlineCode(paragraph) }, settings);
    if (!hit) return false;
    const range = rangeFor(paragraph, hit.start, hit.end);
    const node = range.startContainer;
    if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return false;
    const textNode = node as Text;
    if (textNode.data.slice(range.startOffset, range.endOffset) !== hit.original) return false;
    textNode.replaceData(range.startOffset, range.endOffset - range.startOffset, hit.insert);
    placeCaret(paragraph, caretAfter(caret, hit));
    return true;
  }

  /** Make a correction in the DOM and on the server as its own undo step. */
  private apply(field: HTMLElement, id: string, text: string, caret: number, c: Correction): boolean {
    const ed = this.ed;
    const range = rangeFor(field, c.start, c.end);
    const node = range.startContainer;
    if (node !== range.endContainer || node.nodeType !== Node.TEXT_NODE) return false;      // the span crosses formatting: leave the text alone rather than risk it
    const textNode = node as Text;
    if (textNode.data.slice(range.startOffset, range.endOffset) !== c.original) return false;
    void ed.flush();                                                                         // the keystroke itself goes first, as its own step (its operation is queued before this returns)
    textNode.replaceData(range.startOffset, range.endOffset - range.startOffset, c.insert);
    placeCaret(field, caretAfter(caret, c));
    const key = this.keyOf(field, id);
    ed.sent.set(key, serialise(field));                                                      // what the server will hold once the correction is in, so the next diff starts there
    this.applied.push(id, c);
    const start = toCodepoints(text, c.start);
    const end = toCodepoints(text, c.end);
    const inner: Op = field.dataset["edit"] === "cell"
      ? { op: "table_cell_text", block: id, row: Number(field.dataset["row"]), col: Number(field.dataset["col"]), start, end, insert: c.insert }
      : { op: "text", block: id, start, end, insert: c.insert };
    void ed.queue.send({ op: "batch", ops: [inner], label: `${AUTOCORRECT_LABEL}: ${RULE_NAMES[c.rule]}` }).catch((error) => ed.failed(error));
    return true;
  }

  /** Enter in a paragraph: `___` becomes a rule. True when it did (the caller must not split the paragraph). */
  async ruleOnEnter(blockId: string, offset: number): Promise<boolean> {
    const ed = this.ed;
    await ed.flush();
    const block = ed.model.block(blockId);
    if (!block || !ruleOnEnter(block.text, offset, block.type, this.settings())) return false;
    const id = ed.newId();
    await ed.op({ op: "rule_insert", block: blockId, new_id: id });
    ed.focusBlock(id, 0);
    return true;
  }

  /** Enter: the word the caret ends may still need its capital (`hello.` + Enter). Returns the caret offset after the correction. */
  async beforeEnter(blockId: string, offset: number): Promise<number> {
    const ed = this.ed;
    const settings = this.settings();
    const block = ed.model.block(blockId);
    if (!settings.capitalize || !block || (block.type !== "paragraph" && block.type !== "heading" && block.type !== "quote" && block.type !== "list_item")) return offset;
    const c = capitalizeBeforeEnter(block.text, offset, this.language(), false);
    if (!c || this.suppressed.has(blockId, c)) return offset;
    await ed.queue.send({ op: "batch", label: `${AUTOCORRECT_LABEL}: ${RULE_NAMES[c.rule]}`,
      ops: [{ op: "text", block: blockId, start: toCodepoints(block.text, c.start), end: toCodepoints(block.text, c.end), insert: c.insert }] });
    this.applied.push(blockId, c);
    return caretAfter(offset, c);
  }

  /** Called before an Undo: when the step about to be undone is one of ours, remember it so the same correction is not made again. */
  beforeUndo(): void {
    const label = this.ed.model.state.undo;
    if (!isAutoCorrectLabel(label)) return;
    const last = this.applied.pop();
    if (last) this.suppressed.add(last.block, last.correction);
  }

  /** Pasted text, corrected only when the person turned that on. */
  pasted(text: string, blockId: string | null, offset: number): string {
    const settings = this.settings();
    if (!settings.paste) return text;
    const block = blockId ? this.ed.model.block(blockId) : undefined;
    const startsNew = !block || !block.text || startsSentence(block.text, offset);
    return transformPasted(text, settings, { startsSentence: startsNew, lang: this.language() });
  }

  /** Forget what depends on the text staying as it was (a document was reloaded or replaced). */
  reset(): void { this.suppressed.clear(); this.applied.clear(); }
}
