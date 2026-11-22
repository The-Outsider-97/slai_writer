# Text boxes (SLAI Writer v2.4)

Request: "SLAI Writer v2.4 — Startup Modernization, Scripture Style Integration, Intelligent Proofreading, and Advanced Text Box System", part 4.

## What a text box is

A text box is the existing **rectangle shape** with a rich-text body. There is no second object type, no second export path and no new SLDC block type.

* **Carrier.** An ordinary SLDC `paragraph` block with empty text whose `extensions["slai.writer.shape"]` holds the shape (`kind: "rectangle"`) and a new optional
  `textbox` object. Its **stable id is the block id**; it is what undo, copy, export and the pin/lock rules all key on.
* **`textbox` (version 1).** `paragraphs[]` (each: `text`, `role` normal/heading1-3/quote, `style` = a named document paragraph style such as Scripture, `align`,
  `list` none/bullet/number, `spans[]` of the usual `format` spans, `line_height`, `space_after_pt`), `vertical_align`, `auto_expand`, `pinned`, `locked`, `name`.
  `text.content` must equal the paragraphs joined by a newline (a plain-text mirror so an older Writer, Reader or a text export still sees the words); the server
  refuses a box where they differ. `text.font_family` and the outline style `double` were added to the shape schema.
* **Versions.** A reader that does not know `textbox` shows an ordinary rectangle with the mirror text. A box written by a *newer* Writer (`textbox.version` > 1) is
  refused with a clear message, never half-read. Nothing changes SLDC core.

## Using it

Insert → **Text Box** (a gallery: Default, Callout, Sidebar, Pull quote, Dark note, Banner, with an option to draw the box on the page) and **Draw Text Box**
(crosshair: drag to size, click for the preset's size, Escape cancels). The box drops on the page in view, below the text already there, selected, with the cursor
inside; typing works at once. Escape, clicking outside, or selecting another object ends editing and saves **one** undoable edit.

* **Move.** The four-arrow handle at the top-left, or the border band. The grab offset is kept, the movement is zoom-aware, no text is selected by accident, the
  saved millimetres equal what was seen. Dragging to another page re-anchors the box to that page (auto-scrolls near the window edge; a drop at the top of a later page
  lands on that page); undo returns it.
* **Resize.** Corner handles (north/west corners keep the opposite corner fixed) and the hatched grip at the bottom-right: continuous, text reflows while dragging,
  minimum 10 x 6 mm, numeric Width/Height in the ribbon (below the minimum is refused with a message), padding shrinks with the box. Auto-expand grows the box to fit.
* **Text.** Font, size, colour, highlight, bold/italic/underline/strike/super/subscript, alignment (left/centre/right/justify and top/middle/bottom), headings,
  quote, bulleted and numbered lists, line spacing, space after, and any named paragraph style. Home controls (style list, size, family, colour, line spacing,
  B/I/U, alignment, lists) act on the box while the cursor is in it. **Scripture inside a box is typography only** (the same definition as the page's style): no columns are added.
* **Appearance.** Border none/solid/dashed/dotted/double, colour, thickness; fill none/colour/opacity; corner radius; object opacity; padding; Bring Forward/Back/to Front/to Back.
* **Wrapping.** In Front of text, Behind text, Top and Bottom, In Line. *Square* is shown as "not available" (see limits).
* **Pin** keeps the position (the box can still be edited and resized); **Lock** freezes the whole object (no editing, changes, move or delete; only Unlock works).
  Both are enforced **on the server**, also inside batches, not only in the interface. Copy, paste and duplicate make a new, free (unpinned, unlocked) box offset by 5 mm.
* **Tables, headings, columns.** Clicking a table or heading never selects or edits a box; Delete removes only the selected object; the box sits in the page's
  floating layer, so a multi-column section or a Scripture section lays out underneath it unchanged.
* **Chrome is never content.** The dashed outline, move handle, edge strips and corner handles live in the page overlay, not in the document: they are in no saved
  document and no export (checked on the saved JSON and on a rasterised exported PDF).

## Export

Any text box (or a double border) turns the native Documaster shape writers off and uses the existing PNG shape fallback, drawn by `shape_export.py` from the
box's real paragraphs (role sizes, named styles from the document, list markers, alignment, spacing, vertical alignment, word wrap). Preflight says so: "Text
boxes are exported as pictures of their text in this format, so the text there is not editable or searchable. Keep the SLDC source." txt/md/xml carry the text.

## Limits (stated, not hidden)

1. PDF/DOCX/RTF/ODT carry a text box as a picture of its text; the text in the exported file is not editable or searchable.
2. *Square* wrapping (text flowing beside the object) is not offered: the pagination engine cannot flow text around an object. Alignment guides are not provided (no existing infrastructure for them).
3. Dashed and dotted borders are drawn solid in the picture fallback (a limit of the existing raster shape path); borders are per box, not per edge.
4. Copy/paste to other programs carries the box's text only.
5. A late page re-layout (for example after fonts load) can briefly drop the box's keyboard focus; Writer restores the focus and caret. One browser test needed a longer settle after a reload before a corner drag (see TEST_REPORT).

## Tests

`tests/test_textbox.py` (18), `tests_ts/textbox.test.ts` (8), `tests_e2e/textbox.mjs` (19 browser scenarios). Details in `TEST_REPORT.md`.
