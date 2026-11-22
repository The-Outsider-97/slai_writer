# Change summary

## Advanced ToC, table fidelity, header/footer shapes, multi-page panels (2026-11-17)

Full report, root causes, verification and limits: `ADVANCED_TOC_TABLES_BANDS_PANELS.md`.

* **Table of contents:** twelve looks and an entry layout engine shared by editor and PDF (`toc_presets.py`, `src/client/toc_*.ts`, `Documaster/.../toc_layout.py`).
* **Tables:** the editor's resolved look reaches the Rendered View, PDF, Word, ODT and RTF (`export.py::_table_looks`, `table_styles.export_look`).
* **Header/footer shapes:** `bands.py`, `slai.writer.band_shapes`, `src/client/bands.ts`, `band_edit.ts`, `band_ribbon.ts` (Insert → Header & Footer), Documaster PDF/DOCX writers
  (`band_shapes.py`). Tests: `tests/test_band_shapes*.py`, `tests/test_page_bands.py`, `tests_ts/bands.test.ts`, `tests_e2e/band_shapes.mjs`.
* **Side panels:** seam model in `src/client/panel_layout.ts`, `attach.ts`, `page.ts` (`setSeams`, `holding`); one panel per seam. Tests: `tests_ts/panel_layout.test.ts`, `tests_e2e/side_panels.mjs`
  (screenshots in `tests_e2e/evidence/`).
* **Test fixes:** `test_print_layout.py` (leader dots are drawn one at a time), `band_shapes.mjs` (waits for the redraw).

## v2.4 final weekly upgrade (2026-11-17)

Rendered View, 1–4 pages side by side, book layouts and margins, writing-experience fixes, app/api consolidation (`opcore.py`, `tablegrid.py`,
`preferences.py`, `dependencies.py`, `app/runtime.py`; empty `app/ports`, `app/utils`, `api/middleware`, `api/utils` removed), proofing recovery, the
integration gate, APA 7 author reading (`names.py`), version-checked cross-references and the Insert → Tables ribbon group. Full report, matrix,
measurements and what is unverified: `FINAL_WEEKLY_UPGRADE.md`. Deleted files to remove from an existing copy: `app.py` (now `app/runtime.py`), `app/ports/`,
`app/utils/`, `api/middleware/`, `api/utils/`.

### Follow-up of 2026-11-17

* **Odd/even headers and footers:** separate header and footer text for odd and even pages, per section; Header and footer dialog, on-page drawing, PDF, DOCX,
  ODT and RTF (Documaster writers `common.py`, `write_pdf.py`, `write_docx.py`, `write_odt.py`, `write_rtf.py`). `book.py`, `src/client/book_layout.ts`
  (`runningBand`), `page.ts`, `dialogs.ts`, `types.ts`. Tests: `tests/test_odd_even.py`, `tests_ts/book_layout.test.ts`, `tests_e2e/odd_even.mjs`.
* **Author-name correction controls:** `names.py` (`Name.describe`, `read_all`, canonical text), `POST /api/names/read`, `src/client/names_ui.ts`, the source
  editor. Tests: `test_names.py`, `test_api_tools.py`, `tests_ts/names_ui.test.ts`, `tests_e2e/author_names.mjs`, `tests/fixtures/name_canonical.json`, and
  `tests/test_names_csl.py` (through the real APA CSL; needs citeproc-py).
* **CI gate:** `ci/writer-integration-gate.yml` (Linux and Windows; copy to `.github/workflows/`), `docs/INTEGRATION_GATE.md`.
* Files outside `applications/slai_writer/`: `applications/Documaster/slai/docmodel/writers/{common,write_pdf,write_docx,write_odt,write_rtf}.py`.

## New: `applications/slai_writer/` (SLAI Writer 1.0.0)

A complete, tested application, not a mock-up:

* **Server (Python, 30 modules, 126 HTTP routes, see `API.md`).** Accounts and security; document sessions with server-authoritative versioned
  operations, undo/redo, snapshots, autosave, crash recovery, conflict handling and merge; academic sources and citations; proofing and AI Assistant
  orchestration; EMBED; signatures and signing; import/export/print; library, templates, plans; honest workspace boundary.
* **Browser client (strict TypeScript, no framework, no bundler, 47 files).** Startup/signup/login/2FA/recovery, Home, New document, Settings, Plans, Help,
  Profile, Signature graphics, Sign/Verify, Version history, and the editor: top bar, rulers, guides, two collapsed application panels, three page-attached panels (corrections, notes/comments/sources, EMBED)
  opened from their coloured tabs, find/replace, `/` function search, status bar and Hide/Reveal.
* **Tests.** 159 Python, 38 TypeScript unit, 36 browser end-to-end scenarios (`TEST_REPORT.md`).
* **Docs.** `ARCHITECTURE.md`, `REQUIREMENTS_MATRIX.md` (with PDF page references and 22 recorded discrepancies), `TEST_REPORT.md`, `OPERATIONS.md`,
  `API.md` (generated), this file.
* **Configuration.** `configs/config.yaml`, `configs/plans.yaml` (values from the main specification; Workspace €30), `requirements.txt`.

### UI rebuilt to follow SLAI Writer (main) pages 11–14

* All five panels are collapsed when a document opens; the arrows and the pink / gold / grey page tabs stay visible; every panel opens independently.
* 38 icons cut from the design (`assets/ico-*.png`, 180 KB), colours sampled from the design, new top bar, sandwich menu, rail + arrows, rulers with
  ticks only, status bar with eye / pen / workspace / zoom icons, light and dark.
* New files: `attach.ts`, `sidepanels.ts`, `navmenu.ts`, `dico.ts`, `editor.css`. Removed: the old docks, handles and the old sandwich entries.
* Defaults changed: `zoom_mode: height`, `side_panel: false`. Deviations: `REQUIREMENTS_MATRIX.md`, section B+.

### Reused, not rebuilt

Server, storage, database, configuration, errors, validation, SLAI locator and web kit from `applications/tools`; `applications/assets`; SLDC in
`src/utils/sldc.py` (no second parser, serializer, encryption format, signing scheme or revision engine); Documaster's converters through a read-only link.

## Changed: shared code (the only edits outside `applications/slai_writer`)

All additive; no existing behaviour changes; covered by new tests in `applications/tools/tests/test_server.py`.

| File | Change | Why |
|---|---|---|
| `applications/tools/server/router.py` | `Request.bytes(limit)`: reads a raw upload body once, refuses larger than `limit` with 413, refuses a truncated body | pictures, cursors and merge-a-copy are uploaded as raw bodies |
| `applications/tools/server/http.py` | `Response.cookies`: a response may emit several `Set-Cookie` headers (new field in `router.py`) | account login sets a session cookie and a device-trust cookie together |
| `applications/tools/tests/test_server.py` | `test_raw_uploads_are_read_once_and_capped`, `test_a_response_can_set_several_cookies` | tests for the above |
| `applications/tools/README.md` | documents the two additions; test count 44 → 46 | accuracy |

No sibling application (Documaster, Reader, SciCal, SPlanner, AIDAP, GangUP, bimap) was modified. Your uncommitted changes elsewhere in the repository were
not touched.

## Defects found by testing and fixed during final verification

See `TEST_REPORT.md` ("Defects the tests found"): typing right after Enter; text typed outside any paragraph; server 500 after adding an equation (SLDC 1.1
upgrade); suggested-name conflicts; commands acting before held keys; caret rule in the text diff; focus loss when dock tabs rebuild.

## Decisions to be aware of

* `.sldc` is canonical. `.sdoc` is import/migration only and is never renamed or reinterpreted silently.
* A package is upgraded from SLDC 1.0 to 1.1 once, when its content needs it, and the person is told.
* Page counts are approximate; the print preview is exact.
* Workspace, cloud, billing, SReader/SPlanner/SciCal links, the spell checker and the AI model are **not simulated**: each shows what is missing.
* The compact formatting toolbar is an addition to the mock-ups (it can be hidden).
* The two documents conflict in places; Document A was followed (`REQUIREMENTS_MATRIX.md`, "Discrepancies").

## Known gaps (not hidden)

* Not tested here: real SMTP, the real spell checker / language agent / LANTRA, Documaster conversion fidelity, screen readers, Firefox/Safari, Windows,
  very large documents (`TEST_REPORT.md`, "What was NOT run").
* Not implemented: multi-column layout, picture page backgrounds, offline equation typesetting, live shared editing, a payment provider.
* The original "25 scenarios" list was not available to this session; please send it so each item can be mapped.
* Keys typed within one server round trip after a "/" that opens the function search are inserted as text instead of going into the search box.
  (Typing normally, one key at a time, is unaffected.)

## Last round (14 requests)

* **Core, additive: SLDC 1.1 `page-bands`.** `src/utils/sldc.py` accepts `header_mm` and `footer_mm` (0–500 mm, together smaller than the page height) in a
  section's `page`; a package that uses them needs format 1.1.0 (Writer upgrades 1.0.0 once and says so). Existing files and the other applications are unaffected.
* **Start-up and logo.** `applications/assets/slai_writer.png` is used; start-up screen restyled after the page-1 design. Smoother theme switch and panel slides.
* **Panels.** On each side only one of the two panels is open (Tools or Corrections on the left, organisation or Notes on the right); EMBED is independent.
  Page panels sit behind the page and scale with the zoom; EMBED hangs from behind the page the same way.
* **Rulers and lines.** Numbers on hover over the margin, header and footer lines and their ruler handles. The lines are movable by mouse and keyboard
  (arrows 0.5 mm, Shift 5 mm, Home/End); header and footer are saved in the document. "Tab" was read as the ruler's margin handles: Writer has no tab stops.
* **Pictures.** Select, move (in line: reorder; free: place on the page), resize, turn, mirror, crop, reset, align, front/behind text, details, delete;
  all as undoable server operations stored in the `.sldc` figure. Pasting or dropping a PNG, JPEG, GIF or WebP asks for the required description and inserts it.
  Limits: page-anchored free pictures only (no text wrapping options), a free picture is clipped to the writing area, behind-text pictures cannot be clicked.
* **Layers.** New, rename, delete, hide, lock, move selection (stored in Writer's own extension data, not in SLDC blocks).
* **Shortcuts.** New page Ctrl+Enter (Word/Canva), new section Ctrl+Alt+Enter, new layer Ctrl+Alt+Shift+N (Photoshop's Ctrl+Shift+N is reserved by browsers),
  add background Ctrl+Alt+B, add illustration Ctrl+D (InDesign "Place"). New section, layer and background keys are Writer's own where the other programs have none; the Support page says which.
* **Return to document** button on Settings, Plans, Support and the other pages opened from a document.
* **Fix.** `SLDCValidationError: Assets that no figure or cover uses` after deleting a picture.

## v2.4 round: tables, page columns, Scripture style, table of contents

Request: "SLAI Writer v2.4: Advanced Table Editing, Page Columns, Scripture Paragraph Style, and Table of Contents Enhancements".
Nothing here changes the SLDC core schema. Everything new is stored in sections' existing `columns` / `column_gap_mm`, in blocks' and the document's
namespaced `slai.writer.*` extensions, and in ordinary paragraph styles, so older files open unchanged and other SLAI programs ignore what they do not know.

* **Tables (`tableops.py`, `table_styles.py`, `table_*.ts`).** Insert/delete rows and columns (one or several, above/below/left/right, from the ribbon, the context
  menu and the keyboard), with merged cells kept valid; header rows; 12 table styles with previews and a "restore default"; accent colour, banded rows/columns,
  first column; borders per edge or region; cell colour, alignment, padding; column widths, row heights, AutoFit, table alignment; a table longer than a page is
  cut between rows with its header repeated. Stored in `slai.writer.table_layout/table_cell_styles/table_borders/table_style` (and the document's `table_styles`).
* **Page columns (`columns.py`, `column_*.ts`).** 1 to 4 columns for the document, a section or a selection (a selection becomes its own *continuous* section
  and merges back when nothing tells it apart); equal or unequal widths, gap, separator line, balance, left-to-right or right-to-left flow, column break.
  Layout tab: Columns (One, Two, Three, Four, Left, Right, More Columns…) and Breaks. The editor lays out real CSS columns.
* **Scripture style.** One action sets Times New Roman 11 pt italic, left aligned, in two columns, as a paragraph style plus a two-column selection section;
  repeating it changes nothing; one undo reverses it; it is exported like any paragraph style.
* **Table of contents (`toc_presets.py`, `academic.py`, `toc_*.ts`).** Twelve looks (Classic, Modern, Minimalist, Academic, Professional Report, Formal, Compact,
  Elegant, Technical Documentation, Book/Manuscript, Numbered Outline, Custom) with per-level and title formatting, leader (dots, dashes, line, none), page-number
  placement (right, after the title, before the title), hyperlinks, numbering. Update Page Numbers Only, Update Entire Table, Change Style, Edit Settings, Remove.
  Entry and title blocks keep their ids when the table is refreshed. A table made by an earlier Writer keeps its look until it is restyled.
* **Export (Documaster writers; new optional reads of the `slai.writer` data, nothing else changed).**
  PDF: whole-page columns (unequal widths, separator line, column breaks); a selection in its own columns is *balanced* across equal columns on the same
  page; contents leaders and number placement. Word: continuous sections, unequal widths, separator (Word's own thin line), right-to-left flow, column breaks;
  contents entries with a leader tab and a page-reference field to a bookmark on each heading. RTF: the same. ODT, HTML, Markdown: columns are not written
  (the export dialog says so). Documaster fix: a one-line default for `TrackedParagraph.block_id`.
* **Known limits.** See `TEST_REPORT.md`, "v2.4 round".


## v2.4 round 2: start-up, Scripture in Paragraph Styles, proofreading, text boxes

Request: "SLAI Writer v2.4 — Startup Modernization, Scripture Style Integration, Intelligent Proofreading, and Advanced Text Box System". Nothing here changes the
SLDC core schema; everything new is in `slai.writer.*` extensions, ordinary paragraph styles and Writer's own code.

* **Start-up.** The shared branded loader (`applications/tools/web/startup/loader.js`, `loader.css`, published into `dist/startup/` by the build; shown before the application's first request) with real stage progress, a fade-out into an
  interactive first screen, three tries with a clear error and a Reload button instead of an endless spinner, reduced-motion support, and a missing optional SLAI
  service (Documaster) no longer stops start. Tests: `tests_e2e/startup.mjs` (10), `tests_ts/startup_loader.test.ts`.
* **Scripture in Home → Paragraph Styles.** One style definition (`Scripture`: Times New Roman 11 pt italic, left aligned); typography and section columns are separate
  actions. Choosing the style no longer forces two columns; the Layout tab's columns work on any text.
* **Proofreading.** See `PROOFING_V24.md`: a verified, local spelling/grammar/style layer with explanations, ranked suggestions, ignore/dictionary controls, per-document
  language, and a reproducible before/after corpus (19 false positives -> 0).
* **Text boxes.** See `TEXTBOX_V24.md`: Insert → Text Box / Draw Text Box, rich text, a move handle and resize handles, pin and lock enforced by the server,
  appearance and wrapping controls, a contextual Text Box ribbon tab, canonical SLDC persistence (a rectangle shape carrier with a versioned `textbox` object), and export
  as a picture of the text with a preflight notice.
* **Defects found by the browser tests while building this round and fixed** (each has a test): page re-layout dropped the focus of a box being edited; the Home ribbon
  silently re-enabled text-box controls that pinned/locked boxes disable; two quick ribbon edits could overwrite each other; shrinking a box to the minimum was refused by the
  server because its padding did not shrink; a wide ribbon widened the whole application; a box dropped at the top of page 2 stayed on page 1; the text-box ribbon's labels
  collided with the Home ribbon's (it is now only in the page while its tab shows).
* **Tests stale before this round, now corrected:** `run.mjs` ("bold and heading") used the formatting-bar command, which now hides the ribbon, and picked the first
  select, which is now the formatting scope; `table_editor.mjs` typed before the page had taken the focus.
