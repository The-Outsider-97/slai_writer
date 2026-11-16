# Test report

Run on the build environment (Linux, Python 3.13, Node 22, Chromium via Playwright) against the working tree in `applications/slai_writer`.
Every number below is from an actual run at the end of development; nothing is estimated.

| Suite | Command (from the SLAI root unless noted) | Result |
|---|---|---|
| Writer, Python | `python3 -m unittest discover -s applications/slai_writer/tests -t .` | **159 tests, OK** |
| Shared tools, Python | `python3 -m unittest discover -s applications/tools/tests -t .` | **46 tests, OK** |
| Shared tools, TypeScript | `cd applications/tools && npx tsx --test tests_ts/*.test.ts` | **13 tests, OK** |
| Writer, TypeScript unit | `cd applications/slai_writer && npx tsx --test tests_ts/*.test.ts` | **38 tests, OK** |
| Writer, browser end-to-end | `cd applications/slai_writer && node tests_e2e/run.mjs` | **36 of 36 scenarios passed** (two consecutive runs; one earlier run of the same tree had a one-off timeout in the "comment" scenario that did not repeat, so treat that scenario as possibly flaky) (real server, real Chromium) |
| Type check, client | `npx tsc -p tsconfig.json --noEmit` | clean (strict, `noUncheckedIndexedAccess`, `noUnusedLocals`) |
| Type check, tests | `npx tsc -p tsconfig.test.json --noEmit` | clean |
| Type check, shared web kit | `cd applications/tools && npx tsc -p tsconfig.json --noEmit` | clean |
| Build | `node ../tools/build/build-static.mjs` (in `applications/slai_writer`) | builds `dist/` without errors |

## What each suite covers

* **Python (159).** Accounts and security (`test_accounts`, `test_api_accounts`: signup code expiry/resend/throttle, TOTP incl. replay, recovery
  codes, trusted devices, lockout, password reset, secure recovery); documents over HTTP (`test_api_documents`: create/open/save/save-as,
  never-overwrite, name validation, ops, undo/redo, stale versions, external change, snapshots and restore-as-new-revision, merge-a-copy, images,
  cursors, equation upgrade, suggested names); tools and plans (`test_api_tools`); sources/citations (`test_academic`); proofing and AI
  (`test_assist`: AI off/forbidden, scoped proposals, stale text refused, apply/reject, unverified additions need confirmation); EMBED
  (`test_embeds`: catalogue, validation, locked view, preview, revision-bound apply, stale input); import/export/print (`test_export`); signing and
  verification (`test_signing`); SLDC page bands, orphan pictures and picture settings (`test_page_bands`); workspace boundary (`test_workspace`); an HTTP smoke test (`test_api_smoke`).
* **TypeScript unit (38).** Text diffing (repeated characters, surrogate pairs, reversibility), offset mapping, word counts, roman numerals,
  inline segments, the document model (patches, geometry, headings, read-only), the serial operation queue (ordering, base versions, stale
  versions, interleaved server work, idle), and (`figure.test.ts`) the picture layout arithmetic (width/height box, crop, rotation, shrink-to-fit,
  crop-by-drag with mirroring), header/footer defaults and `header_mm`/`footer_mm`, and which layer a block is on.
* **End-to-end (36).** Each scenario drives the real UI against a real server with its own data folder and library (documents are closed after each
  scenario because the server allows 24 open documents):
  1. startup offers guest use; 2. a guest creates a document and typed text reaches the server; 3. typing straight after Enter lands in the new
  paragraph; 4. text typed with the caret outside any paragraph is not lost; 5. bold and Heading 1 are stored; 6. save → leave → reopen from Home keeps
  the text; 7. the written file is a real SLDC (zip) container that a second open reads back; 8. find + replace-all is one undo step (and redo);
  9. `/` search inserts a table and cell typing/Tab works; 10. a comment is anchored, listed and stored; 11. double-clicking a green search match
  creates a linked note outside the document file; 12. an equation is stored, the package upgrades to SLDC 1.1 and a notice says so; 13. page panels
  open from their tabs, switch tabs, close with Esc; 14. **a new document shows all five panels collapsed, with the three coloured tabs and the two
  arrows visible and the tabs on the left, right and under the page**; 15. **a side never shows its application panel and its page panel together (Tools/Corrections on the left, organisation/Notes on the right) while EMBED is independent**; 16. **opening panels
  changes neither the document nor the page, and EMBED does not unlock or create anything**; 17. **panels stay at their page edge when zooming, are
  not inside the page content, and a print rule isolates the printed pages**; 18. AI/spelling/grammar do nothing until asked and explain honestly when
  unavailable; 19. Hide/Reveal; 20. zoom slider and Ctrl+0; 21. page setup from the ruler changes the page size on the server; 22. EMBED panel opens and
  the server rejects an unknown parameter; 23. version history opens after two saves; 24. Settings, Plans (Workspace €30) and Help render; 25. a paid
  plan cannot be bought; 26. Tab moves focus to a control; 27. the app survives a reload; 28. a stale edit gets 409 `stale_version`; 29. API calls
  without the marker header or from another origin are refused; 30. no console errors or CSP violations while editing; 31. the server's own output
  never contains document text. Added in the last round: 32. **Return to document** is on Settings, Plans and Support when a document is open, returns to it, and
  is absent on Home; 33. the two signature-graphics fields sit on the same level; 34. **the header and footer lines can be dragged and nudged with the
  keyboard (focus kept), a number shows on hover, `header_mm`/`footer_mm` appear in the document and survive save and reopen**; 35. **a pasted PNG can be
  selected, turned, set free, dragged, and its rotation and position survive save and reopen**; 36. **Ctrl+Enter new page, Ctrl+Alt+Enter new section,
  Ctrl+Alt+Shift+N new layer, Ctrl+Alt+B background dialog, Ctrl+D picture chooser**.

## Last round: what else was exercised by hand in Chromium (scripted, not part of the suite)

Hover numbers on the ruler and on the margin/header/footer lines, dragging the left margin and the footer, line clamping (writing area stays at least
30 mm), picture resize/rotate/mirror/crop/reorder by drag, BMP paste refused with a message, layer move/hide/rename/delete, new page/section from the
keyboard. The scripts live outside the repository (`/tmp` of the build environment) and are not shipped.

## Visual comparison with pages 11–14

Done by eye, with screenshots of the running editor next to the PDF pages (light and dark, all panels collapsed, application panels open, each page
panel open, everything open, Hide/Reveal, sandwich menu). It is not a pixel diff. Remaining deviations are listed in `REQUIREMENTS_MATRIX.md` (section B+).

## Defects the tests found and that were fixed

* (last round) Saving or reading the revision crashed with `Assets that no figure or cover uses` after a picture's block was deleted; the session now
  keeps the picture for undo and drops unused pictures only when writing the file (`test_page_bands.OrphanPictures`).
* (last round) Keyboard moves of a margin line lost focus because the editor re-laid the page out and restored the text caret; the line now keeps focus.
* (last round) The ruler handles were impossible to grab at low zoom (about 4 px tall); they now have a transparent 10 px grab area.
* (last round) Hiding a layer did nothing for blocks already drawn; layer visibility is now re-applied on every re-render.
* (last round) Ctrl+Enter produced no new page because the page layout was not recomputed when only the page-break flag changed.

* Typing immediately after Enter landed in the old paragraph (Enter waits on the server). Keystrokes are now held and replayed in order.
* Text typed with the caret outside any paragraph appeared on screen but was never sent. It is now routed into a real paragraph.
* Adding an equation (any SLDC 1.1 content) to a 1.0 package made every later request return 500. The package is now upgraded once, with a notice.
* The suggested name "Untitled document" caused a conflict error the second time; it now gets a free variant, while a typed name never does.
* Toolbar and menu commands could act on a paragraph before the last typed characters were applied; commands now wait for held keys.
* `diffText` placed an inserted repeated character after the caret rather than ending at it (found by a unit test).
* Rebuilding the notes/comments/sources tabs dropped keyboard focus, so Esc did not close the panel.
* (UI rebuild) At 100 % zoom the page plus both side panels overflowed and clipped the red panel; the default is now "fit page height" and the page area adds room for open panels.
* (UI rebuild) The EMBED panel showed a stray inner box and a pill-shaped chip; fixed in `editor.css`.
* (UI rebuild) Panels inside the scaled page area shrank their text to unreadable size when zoomed out; they now live beside the scaled pages.

## What was NOT run, or is a test double

Stated plainly so the numbers above are not over-read:

1. **The original list of 25 scenarios** from the task statement was not available to this working session after context was compacted. The suite
   above is mapped to the requirements in `REQUIREMENTS_MATRIX.md` instead. If you send the exact list, each item can be mapped or added.
2. **Sibling applications** (Documaster, Reader, SciCal, SPlanner, AIDAP, GangUP, bimap) are not in the build environment. On your computer (Windows, Python with an old `colorama` 0.4.4) a partial run gave: Writer 148 of 151 OK, the 3 failures being `dependency_missing` because of that `colorama` version (the app correctly answers 503); SPlanner 94 OK; SciCal, AIDAP and bimap reported errors that were **not** investigated (not checked whether they pre-exist); Reader, Documaster and GangUP test paths were not found. That run was of the earlier UI. The only shared code changed is
   `applications/tools/server/{router,http}.py` (two additive features, see `CHANGES.md`). Run their suites on your machine after copying the files
   (`OPERATIONS.md`, "Regression check on your machine"). Results of that run are not part of this report unless added below.
3. **E-mail.** Signup, resend and reset use an in-memory `Outbox` in tests. Real SMTP delivery was not exercised (no server or credentials exist here).
4. **Spell checker, language agent and LANTRA** are not installed in the build environment. The tests prove the honest states (spelling 503
   `dependency_missing`; grammar/AI refused until AI is switched on; no change without a request) and the proposal/apply/reject/undo mechanics with a
   recording double for the agent. A real model's suggestions, and the real spell checker, were **not** tested.
5. **Documaster converters and PDF libraries.** Export/import tests use whatever Documaster provides in the mirror; DOCX/ODT/RTF fidelity against real
   Word/LibreOffice was not measured. The PDF preview and preflight were tested with the installed libraries only.
6. **Workspace / shared editing / cloud / billing** do not exist here and are not simulated; tests assert that they say "not connected".
7. **Pagination** is approximate by design; no test compares it with a printed page count.
8. **Accessibility** was checked with keyboard-only runs, accessible names, live regions and contrast tokens; it was **not** tested with a screen
   reader (NVDA/JAWS/VoiceOver) or an automated audit tool.
9. **Browsers.** End-to-end ran in Chromium only. Firefox and Safari were not run. The CSS Custom Highlight API (search, typo, note highlights) needs a
   current browser; without it highlights are not drawn (the text and counts still work).
10. **Load and long documents.** No soak test with very large documents (hundreds of pages) was run.
11. **UI.** The editor was compared with the PDF by eye in Chromium at 1389×868 and 1440×900 only; narrow (phone) widths, high-contrast mode and very large text were not re-checked after the rebuild.
12. **Windows.** The user's environment is Windows; the suites above ran on Linux. Path handling is written with `pathlib`, but a Windows run is still pending.

## Reproducing

```
cd <SLAI root>
python3 -m unittest discover -s applications/slai_writer/tests -t .
python3 -m unittest discover -s applications/tools/tests -t .
cd applications/slai_writer
npm install            # typescript, tsx, @types/node
npm run typecheck && npm test
npm run build
npm install playwright && npx playwright install chromium   # once
npm run test:e2e
```

## Last-round limits (not tested or not done)

* The browser scenarios cover Chromium only. The Profile page's Return button shares code with Settings/Plans/Support but was not driven (a guest has no profile).
* Pasting copies from other applications was exercised with synthetic clipboard events carrying a real PNG file, not with a real OS clipboard.
* The spell-checker warnings on your computer (`RESOURCE.MISSING structured_wordlist_en.json`, `wordlist_en.txt`, "initialized with 7 words") come from word
  lists and the `metaphone` module missing from your SLAI tree (`src/agents/language/library`); Writer reports spelling as unavailable and does not fix this.
* `tests/test_sldc.py` in the SLAI core tests was not edited; the page-bands rules are tested in `applications/slai_writer/tests/test_page_bands.py`.

## v2.4 round: tables, page columns, Scripture, table of contents, export

Run at the end of the round, Linux, Python 3.13, Node 22, Chromium (Playwright), LibreOffice (as an independent reader of exported files).

| Suite | Result |
|---|---|
| Writer, Python (`python3 -m unittest discover -s applications/slai_writer/tests -t .`) | **331 tests, 328 pass.** The 3 failures are the Reader-import tests (`test_import_text_markdown_html`, `test_sdoc_is_never_silently_reinterpreted`, `test_import_markdown_upload_and_rejections`): the Reader parser engine cannot be loaded in this environment (missing `src.agents` here, a `colorama` error on the Windows machine). They do not touch this round's code. |
| …of which new this round | 81: tables 26 (`test_table_ops_grid`, `test_table_styles`), columns and Scripture 18, contents looks 10, export layout 21, all features together and old documents 6 |
| Writer, TypeScript unit (`npx tsx --test tests_ts/*.test.ts`) | **175 tests, all pass** |
| Browser, tables / columns / contents (`node tests_e2e/{table,column,toc}_features.mjs`) | **10/10, 9/9, 7/7 scenarios pass** (real server, real Chromium) |
| Browser, the earlier suite (`node tests_e2e/run.mjs`) | **36 of 38 pass.** One failure is a stale scenario: it presses "/formatting bar" to *show* the bar, but the ribbon is now visible by default, so that toggles it off (`screens/doc.ts`, not changed here). The other (first typed letter lost right after creating a document) passed on two single re-runs and failed in two full runs: a timing flake in the first typing scenario. |
| Type check (`tsc -p tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`) | clean, on both the build machine and the Windows folder |
| Build | `node ../tools/build/build-static.mjs` builds `dist/` |
| Documaster's own tests (`applications/Documaster/tests_py`) | 184 tests; the same 3 fail with and without this round's writer changes (checked by swapping the original writers back in) |

What the new tests check (and how):

* **Tables.** Row/column insert and delete on plain, merged and header tables, split/merge, a seeded randomized sequence of operations that must keep every
  invariant (rectangular grid, merged-cell spans, extension keys pointing at cells that exist), undo to the starting document, save and reopen, the 12 styles
  against a golden file, borders, the layout tab, a table cut across pages (browser).
* **Columns.** Each scope, selection splitting and merging back, idempotence, column breaks (also in one column: a page break), Scripture (properties, two
  columns, idempotent, one undo, export), right-to-left, unequal widths, rejected values; in the browser the columns really are laid out (positions of typed
  text), typing inside the second column, balance, the dialog keeps its values.
* **Contents.** All 12 looks make a valid document that survives save and reopen; changing the look restyles the same entries (same ids); leader, placement,
  hyperlinks, numbering, per-level and title formatting; undo; "Update Page Numbers Only" changes nothing in the document; the drawn numbers equal the
  numbers of the PDF layout; an old table keeps working.
* **Export (positions read back from the exported files, not from the model).** PDF: words of a selection sit in two or three column bands inside the margins,
  the text before and after is full width and below/above the region, the separator line is in its colour between the columns, balanced columns end at about the same
  height, a column break starts the next column, a 60-row table inside the columns is split across them, unequal widths of whole-page columns,
  leaders and number placement per look, measured pages for headings inside columns. Word and RTF: the section, column, separator, bidi and break
  markup; LibreOffice (not our code) is then asked to lay the same files out and its column positions, unequal widths and contents leaders are compared with what was written.

### What was NOT done or not verified (this round)

1. **Word itself, Google Docs, Apple Pages and other word processors were not run.** Only LibreOffice read the Word and RTF files back. Word may paginate
   differently: the page numbers cached in contents entries come from Writer's own PDF layout, and on one test document LibreOffice placed a heading one
   page earlier (the test accepts a difference of one page and the export says to update the fields). Exact cross-format fidelity is **not** claimed.
2. **Unequal column widths are stored and exported (PDF whole-page layouts, Word, RTF) but the editor shows equal columns**, and a *selection* in the middle of a
   PDF page is written with equal columns. The separator's colour, thickness and dashed/dotted style are drawn by the editor and the PDF (solid); Word and RTF draw a thin line.
3. **A column break inside a selection that shares a page with other text is not written to the PDF** (the region is balanced instead); the export warns.
   If a page already has several columns, columns of a different count in the middle of it start a new page in the PDF (warned).
4. **ODT, HTML, Markdown, text and XML** do not carry columns, leaders or page references (ODT states this; the others are not layout formats).
5. **Tables.** The browser cannot enforce an exact row height by clipping editable cells; a row is never split in the middle; tables inside column regions are
   not split across pages in the editor (the PDF does split them).
6. **Windows, Firefox, Safari, screen readers** were not run for these features. The Windows folder received the same files and ran the Python suite and the
   three type checks (see above); the production build and the browser suites were not run there because this session cannot execute `npm.cmd`.
7. **Reader / SPlanner / Documaster `.sldc` forward-compatibility** (an earlier request) is not part of this round and was not delivered.
