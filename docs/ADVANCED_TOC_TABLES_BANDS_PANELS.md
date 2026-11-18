# SLAI Writer — Advanced Table of Contents, table fidelity, header/footer shapes, multi-page panels

Date of this report: 2026-11-17. Everything below was run in this environment (Linux, Chromium via Playwright, LibreOffice, pdfplumber, python-docx, pdftoppm).
Nothing has been pushed or merged. Windows, Microsoft Word and SLAI Reader were not available (see §9).

## 1. Status of the four parts

| Part | Status |
|---|---|
| 1. Advanced Table of Contents | **Completed** (twelve looks; entry layout: page-number position, alignment, leader, text alignment, hidden numbers; follows the document) |
| 2. Table style loss in Rendered View / PDF / DOCX | **Completed** (one resolver feeds the editor and every writer) |
| 3. Shapes in headers and footers | **Completed** for editor, Rendered View, PDF, DOCX; **partial by design** for ODT/RTF/HTML/Markdown/TXT/XML (§9) |
| 4. Multi-page side-panel overlap | **Completed** (layout, not z-index; both directions; 1–4 pages, book view, Rendered View) |

## 2. Root causes (Phase 0)

### Tables lost their style in the Rendered View, the PDF and Word
The editor draws a table from `table_styles.resolve` (style + hand-made formatting). The file writers (Documaster) never received that result: they drew a plain
grid from the block's raw cells, so a chosen style, banding, header fill, borders and widths existed only in the browser. The Rendered View is the exported PDF,
so it inherited the loss. Fix: `export.py::_table_looks` hands `table_styles.export_look(block, custom)` to the writers on the export copy (the document is not
changed); Documaster's writers draw that look. A golden file ties the browser's resolver to the Python one (`tests/test_table_styles.py`, `tests_ts/table_styles.test.ts`).

### Table-of-contents entries were laid out by two unrelated rules
The editor positioned the page number, leader and text with CSS; the PDF writer with its own tab arithmetic. Wrapping, alignment and leader length therefore
differed, and options such as "page numbers hidden" or a custom tab stop could only be honoured in one place. Fix: one placement engine
(`Documaster/slai/docmodel/writers/toc_layout.py`) with a TypeScript port (`src/client/toc_layout.ts`) tied to it by `tests/fixtures/toc_layout_golden.json`.

### Header and footer shapes did not exist as a concept
A header or footer is a *definition* that many pages repeat; shapes could only be placed in the body, belonging to a page. Fix: the shapes belong to the
definition (`slai.writer.band_shapes`, keyed by section, with variants default/even/first and an explicit link to the previous section), are placed from the
text frame of each page that uses it (so margins, page size and mirrored books move them), and are drawn from the same arithmetic in the editor
(`src/client/bands.ts`) and in the PDF/DOCX writers (`bands.py`, golden file `tests/fixtures/band_shapes_golden.json`).

### Notes and Proofing tabs overlapped when pages were side by side
Every page has a Corrections/Proofing tab on its left and a Notes tab on its right. The page grid left 28 px between two pages, so the Notes tab of the left page
and the Proofing tab of the right page occupied the same place, and so did their panels when open. They were absolutely positioned layers stacked by z-index; the
room between pages was never reserved. Fix (`src/client/panel_layout.ts`, `attach.ts`, `page.ts`): a *seam model*. The seam between two neighbouring pages is given
the width its tabs (and an open panel) need by a left margin on the right page of the seam; the page that owns the panel being opened stays where it is and the
others make room; a seam holds one panel (opening Notes closes the neighbouring Proofing and the reverse). No z-index is used to hide an overlap.

## 3. Table of contents — verification
* Python: `tests/test_toc_layout.py` (engine on plain numbers, then the whole path settings → document → PDF read back with pdfplumber), `test_toc_settings.py`, `test_toc_styles.py`.
* TypeScript: `tests_ts/toc_layout.test.ts`, `tests_ts/toc_position.test.ts` (golden file `tests/fixtures/toc_layout_golden.json` shared with Python).
* Browser: `tests_e2e/toc_features.mjs` 7/7 (gallery of twelve, page numbers from layout and "Update Page Numbers" changes nothing in the document, restyle keeps entry ids and one
  undo reverts, leader/placement/numbering/links settings, automatic pickup of new headings, remove, save and reopen, hidden numbers absent from editor/PDF/DOM text,
  page number never in the entry's text) and `toc_layout.mjs` 14/14 (editor against exported PDF for position/alignment/leader combinations, wrapping inside the number column, the table following the document).

## 4. Table fidelity — verification (editor vs Rendered View vs PDF)
`tests_e2e/table_fidelity.mjs` 4/4: the editor's table is photographed (Chromium pixels) and judged against Writer's own resolution of the style; the exported PDF (poppler)
and the Rendered View (screenshot) are judged against the same expectation; a style chosen after insertion reaches all three, undo restores the old look, and the
look survives save and reopen. `tests/test_table_fidelity.py` (11 tests) reads PDF with pdfplumber, Word with python-docx, and Word/ODT/RTF rendered by LibreOffice.

## 5. Header and footer shapes — verification
* Insertion: Insert ribbon, **Header & Footer** group, while a header or footer is being edited (double-click in the margin, or the Insert commands). The existing shape
  gallery and placement tool are reused (`shape_placement.ts` band mode); text boxes too (`textbox_ui.ts`).
* Editing: select, move (drag or arrows, 1 mm), resize (handles), format (fill, outline, transparency, corner radius, text), order (Behind text / In front of text, Bring to front, Send to back, Forward, Backward), duplicate (Ctrl+D), delete, lock. A locked shape is refused by the server as well as the UI. The body is inert while a band is edited
  (`pointer-events:none`, host `contenteditable` restored on exit) so nothing in the body is selected or changed.
* Anchoring: shapes belong to the header/footer definition for the page's variant (default, odd/even, first page); linked sections share their owner's shapes; new
  sections start unlinked with their own empty band shapes. The editing target is derived from (section, physical page, edge) each time, so toggling first-page or
  odd/even retargets correctly. Changes go through one serialized queue and one undo step each.
* Page geometry: `x_mm` is frame-relative (mirrored from the right edge on left-hand pages of a book whose edges are swapped); `y_mm` from the top for a header and from
  the bottom for a footer; survive margin, page-size (A4 → A5) and mirroring changes.
* Output: PDF (pdfplumber fill rectangles against stored millimetres), Word (python-docx / LibreOffice), Rendered View (pixel check of the pink fill on pages 2–4 when the first-page variant is used).
* Tests: `tests/test_band_shapes.py` (13, incl. golden), `test_band_shapes_export.py`, `test_page_bands.py`, `tests_ts/bands.test.ts`, `tests_e2e/band_shapes.mjs` 11/11 (eight consecutive full runs passed after two test races were fixed; see §8).

## 6. Side panels — verification
Browser scenarios (`tests_e2e/side_panels.mjs`, 14/14) and unit tests (`tests_ts/panel_layout.test.ts`, 19/19):

| Check | Result |
|---|---|
| Collapsed tabs never overlap in 1, 2, 3 and 4 pages across at 25/50/64/100/150 % | pass; the two tabs of a seam sit side by side with a gap |
| Page size, text, page breaks identical in every arrangement with a panel open | pass (no change to geometry, pagination or export) |
| Left page's **Notes** opened: left page stays, right page moves right, no overlap, closes again to the same positions | pass |
| Right page's **Proofing** opened from collapsed: right page stays, left page moves left, no overlap | pass |
| A seam holds one panel (either order); panels on different seams stay open together | pass |
| 3 and 4 pages across, panel on a middle page: only the neighbours move | pass |
| Window too narrow to keep the owner in place: the page moves as little as it must, nothing cut off, the rest reachable by scrolling | pass |
| Edge of a row: panel not cut by the window's edge | pass |
| Zoom 30–150 % and window 1100–1800 px wide with a panel open; landscape pages | pass |
| Vertical scroll position unchanged while a panel slides, closes or moves seam | pass |
| Keyboard: Tab to a tab, Enter/Space toggles, Escape closes and returns focus; names say which page and panel | pass |
| Book view: spread pages touch, spine tabs not drawn (and out of the tab order) until a panel opens there, outer tabs always present | pass |
| Rendered View: no side tabs, no overlapping pages; returning restores panel state | pass |
| Opening and closing panels makes no document edit (version unchanged, nothing to undo) | pass |

Screenshots of both directions and the other states are in `tests_e2e/evidence/`: `notes-left-page-opens.png`, `proofing-right-page-opens.png`,
`notes-middle-of-3.png`, `notes-middle-of-4.png`, `proofing-narrow-window.png`, `book-view-closed.png`, `rendered-view.png`. (They are still frames, not recordings.)

Implementation notes: the seam margins live in `PageView` (`setSeams`) because a new layout creates new sheets; the shift that keeps the owner in place (`held`) is reset when the
zoom, arrangement or window *width* changes; pages glide with a transform (no layout change) while the tabs follow per frame; the panel `reveal` scrolls only vertically.

## 7. Test and build results (this environment)

| Suite | Result |
|---|---|
| Writer Python (`python -m unittest discover -s applications/slai_writer/tests -t .`) | **570 tests, OK, 11 skipped** (3 SLAI Reader import tests; 8 `test_names_csl.py` tests that need citeproc-py) |
| Writer TypeScript unit (`npx tsx --test tests_ts/*.test.ts`) | 228/228 |
| `tsc -p` on `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json` | clean |
| `npm run build` | builds `dist/` |
| Browser | run 38/38, startup 10/10, page_views 8/8, book_layout 8/8, odd_even 4/4, band_shapes 11/11, side_panels 14/14, table_editor (no failures), table_features 10/10, table_fidelity 4/4, table_insertion 7/7, textbox 19/19, toc_features 7/7, toc_layout 14/14, column_features 11/11, proofing 14/14, author_names 4/4, writing_audit 17/17 |

## 8. Defects found while verifying and how they were settled
* Panel tabs stayed at pre-animation positions when the seam margin changed for a reason other than a panel (the arrangement): tabs now follow the page's glide.
* Re-layout rebuilt the sheets mid-slide and dropped the seam margins (flicker): margins and the held shift are kept in `PageView` and re-applied to new sheets.
* The scroll fallback used to keep a page in place also scrolled a panel at the window's edge out of view: removed; the window's edge may nudge the page instead.
* `reveal()` scrolled sideways, throwing away the reader's place: vertical only, and only when the panel is out of sight.
* `band_shapes.mjs`: three steps read the page right after Escape / Ctrl+D / adding a shape, before the server's answer had redrawn it (a test race, seen in about half of the full runs once Phase 4 changed timing); they now wait for the redraw. Eight consecutive full runs passed afterwards.
* `test_print_layout.py` asserted a literal `...` in extracted PDF text; the leader is now drawn one dot at a time on the leader grid, so the assertion matches a run of leader dots.

## 9. Compatibility and limits
* **SLDC:** existing documents open unchanged. New data is in Writer's own namespaced extensions (`slai.writer.band_shapes`, `slai.writer.toc_style`, `slai.writer.table_styles`
  etc.); readers that do not know them keep them and show the text of bands and entries as before. Header/footer shapes and panel layout add nothing to the document that
  a reader must understand.
* **Header/footer shapes in other formats:** drawn in PDF and DOCX; **not carried** by ODT, RTF, HTML, Markdown, TXT, XML (the export warns).
* The first-page variant is shapes-only (the text of the first page's band is not a separate definition in this round).
* A new section starts with its own empty band shapes; linking to the previous section is an explicit "Link to previous section".
* In the book view the spine tabs are not drawn while closed (the pages touch); opening a panel there pushes the spread apart.
* The tab of the EMBED panel hangs in the gap below its page; at very low zoom it can overlap the top of the next row (pre-existing, outside this change).
* PDF does not embed per-style fonts for ToC entries; Word/RTF ToC leaders are limited to what those formats offer.
* **Unverified here:** Windows; Microsoft Word's own pagination of the exported DOCX; SLAI Reader import; the CI workflow; screen recordings (still frames only).
* **Not done from an earlier request:** `.sldc` forward-compatibility in SLAI Reader, SPlanner and Documaster.
