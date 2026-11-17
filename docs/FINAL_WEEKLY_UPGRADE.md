# SLAI Writer v2.4 — Final weekly upgrade: report

Build of 2026-11-16/17 (follow-up of 2026-11-17: odd/even headers and footers, the audit's four Writer findings), Linux (Python 3.13, Node 22, Chromium 153 via Playwright). Nothing was committed, pushed or merged. Every figure below is from a run
in this environment. Where something could not be run here it is marked **unverified** or **blocked**, not passing.

## 1. Status of the six requirements

| # | Requirement | Status |
|---|---|---|
| 1 | Rendered View (button beside Fit page height; PDF-backed, read-only, zoom / fit / navigation, position kept) | **Completed.** `tests_e2e/page_views.mjs` 8/8, `tests/test_rendered_view_api.py`; the page pictures are compared with an independent rasterisation of the exported PDF (`test_manuscript_scenario.py`, within 2 mm per page) |
| 2 | 1 / 2 / 3 / 4 pages side by side | **Completed.** Right order, one row per group, whole pages, no duplicated last group, persisted across Editing and Rendered (`page_views.mjs`) |
| 3 | Margins and book layout | **Completed.** Presets, custom inside/outside/gutter, four scopes, mirrored parity, additive gutter with stored margins untouched, facing view with page 1 alone on the right, single-page override remembered, PDF/DOCX/ODT/RTF keep alternating margins (`book_layout.mjs`, `test_book_layout.py`, `test_manuscript_scenario.py`). **Odd/even headers and footers (added 2026-11-17):** separate header and footer text for odd and for even pages, per section, in the Header and footer dialog, drawn on the page, and written to PDF, DOCX, ODT and RTF (section 4b). |
| 3b | Writing-experience audit | **Completed** (section 3): 17 browser checks, fixes, measured before/after |
| 4 | app/ and api/ consolidation | **Completed** (section 4) |
| 5 | Technical audit remediation A–F, and the four Writer findings of the 12 November audit | **Completed, with the limits in section 5** (CSL rendering and Windows unverified; the audit's Writer text was supplied on 2026-11-17 and is mapped in section 5) |
| 6 | Phases 0–6 and the mandatory manuscript scenario | **Completed** at export level (one automated test, section 6) and in the browser by the suites above |

## 2. Page viewing and book layout, evidence

* Browser (real server, real Chromium): `page_views.mjs` — status-bar menu and Rendered toggle beside Fit page height; 1–4 pages with equal gaps and no
  duplicate pages; typing and selection in every arrangement; Fit entire page follows a resize; Rendered view has none of the editing chrome and lands on
  the caret's page; edits show up in the pictures the next time. `book_layout.mjs` — the seven presets with pictures; one undoable step; mirrored book
  view; custom margins (inside 20, outside 15, gutter 5 gives 25 once and 15); refusal when no room is left; the four scopes; parity after inserting and
  removing content and after a reload; the Rendered view of a book.
* Server: `test_book_layout.py` measures the exported PDF and the DOCX/ODT/RTF as printed by LibreOffice: inside + gutter on one side, outside on the
  other, alternating, identical text width.
* Export vs preview: `test_manuscript_scenario.py` takes pages 1, 2, 5 and the last page as served by `/pages/{n}.png`, rasterises the same PDF with
  poppler, and compares the box containing the ink: equal within 2 mm. This compares Writer's own picture with another renderer's picture of the same
  PDF; it does not compare with how Microsoft Word would paginate the DOCX (not available here).

## 3. Writing-experience report

Audit `tests_e2e/writing_audit.mjs`, 17/17: caret and hit-testing (also at 2x pixel density), selection across pages, keyboard navigation, Backspace/Delete
across a page boundary, Enter / Shift+Enter, clipboard (outside markup and scripts never run), undo/redo, find and replace with one Undo, styles and ribbon
state, scroll stability while typing across a page, proofreading that does not interrupt typing, dirty indicator and shortcuts, accessibility (names,
unique ids, labelled regions), keyboard-only use, narrow window, server away and back.

Fixed in this round: the ribbon wrapped and made the page scroll sideways in a narrow window; PageDown/PageUp left the caret off-screen when the hit
missed an editable; whole-document operations re-read the selection for every block (now once); `fitRegions` repeated work when nothing changed; the
Insert ribbon had no Table or Markdown-to-table button.

Measured, `tests_e2e/writing_perf.mjs`, fixed content, 1500×950 (`docs/perf/`): milliseconds.

| | 2 pages | 15 pages | 60 pages before | 60 pages after (3 runs) |
|---|---|---|---|---|
| Key to next painted frame, p50 / p95 | 24 / 32 | 24 / 31 | 25 / 33 | 25 / 31–32 |
| Enter (split) | 41 | 134 | 1103 | 355, 359, 363 |
| Backspace (merge) | 116 | 160 | 721 | 396, 447, 346 |
| Redo | 8 | 4 | 694 | 144, 174, 174 |
| Paste 5 paragraphs | 11 | 10 | 37 | 26, 23, 19 |
| Paragraph style change | 130 | 40 | 96 | 65, 159, 56 |
| Scroll, frame p95 | 16.7 | 16.7 | 16.8 | 16.7 (0 frames over 50 ms) |
| Open | 1.1 s | 1.8 s | 3.8 s | 3.9 s |

`baseline-after.json` holds a first run in which Enter was 644 ms and paste 528 ms; the three repeats in `after-600-repeats.json` did not reproduce that, so
the spread between runs on this machine is large and single figures should not be over-read. **Remaining limit:** structural edits still re-lay out
every page after the edit point, so Enter in a 60-page document takes about 0.35 s; typing itself is flat (25 ms) at every size. That is not fixed here.

## 4. app/ and api/ assessment

Audited with an import-graph scan (module and function level); the result is now enforced by `tests/test_architecture.py` (4 tests).

* **Circular dependencies:** none at module or function level. The earlier cycle `ops ↔ tableops/columns/book` was removed by extracting
  `opcore.py` (shared kernel) and `tablegrid.py`; the `api.routes.core → app` dependency by extracting `preferences.py`.
* **Public imports preserved:** `ops.py` re-exports every kernel name; `applications.slai_writer.app` re-exports the runtime in any import order
  (`test_app_package_re_exports_the_runtime_and_any_import_order_works` imports each module first in a fresh interpreter).
* **Dead code removed:** `app/ports/`, `app/utils/`, `api/middleware/`, `api/utils/` (empty placeholders); unused imports in `session.py`.
* **Optional dependencies:** `dependencies.installed()/require()` replace the try/except-around-import probes in `export`, `protect`, `plans`,
  `cursors`, `signing`, `citation_engine`; one message shape, "X needs the 'pkg' package (pip install pkg)". Imports that were deferred only to avoid a
  cycle were hoisted.
* **Conflicting mutation paths:** the cross-reference route edited by offset with no version and could overwrite text another tab had moved. It now
  carries the base version like footnote and citation (`test_api_revisions.py`, 4 tests). The AI "apply" path is guarded by the original text of every hunk
  (`expect`), and the whole batch is refused if one hunk is stale (`test_v24_integration.py`).
* **Hard-coded paths:** none found in the application; `table_editor.mjs` had a hard-coded Chromium path and now uses `WRITER_CHROMIUM` or Playwright's own.
* **Validation and errors:** proofing and export report a missing service with the same error type and a hint; a bibliography that fails half-way
  leaves the document untouched (tested).
* **Left untouched, outside this scope:** `domain/`, `utils/` (empty placeholder modules), `configs/sw_config.yaml`, `configs/slai_profile.yaml`,
  `version.py` (empty). They are not Writer behaviour and are not referenced.
* **Not verifiable here:** SLAI integration beyond Documaster (the Reader agent, `src/agents/reader`, is absent from this checkout).

## 4b. Odd and even headers and footers

* **Data:** `slai.writer.book_layouts[section]` gets `odd_even` (bool), `header_even` and `footer_even` (`left`/`center`/`right`, the same `{page}`, `{pages}`, `{title}`
  fields and limits as the ordinary band). The core SLDC `header`/`footer` stay untouched, so every other SLAI reader still understands the document. Validated by
  `book.py` (unknown keys, fields, length, unmatched braces; even text while the setting is off is refused, not dropped), undoable, inherited by new sections,
  saved and reopened (`tests/test_odd_even.py` 14).
* **Rule (one rule, three implementations: `book.py`/Documaster `even_page_template`, client `runningBand`):** an odd (right-hand) page uses the ordinary
  band. An even (left-hand) page uses its own text when the band has any; otherwise the ordinary band, with left and right swapped in a mirrored section.
  Typography (font, size, colour, emphasis) is the ordinary band's, position by position. Sides are by position in the document, never by the printed number.
* **Editor:** Header and footer dialog: "Different header and footer on odd and even pages", six even-page fields, one undo step; on the page, the sheets show
  the even text (`tests_ts/book_layout.test.ts`, `tests_e2e/odd_even.mjs` 4/4).
* **Exports, read back page by page by independent software:** PDF (pdfplumber), DOCX (python-docx: `evenAndOddHeaders`, even-page header/footer parts; and
  LibreOffice's print), ODT and RTF (LibreOffice's print). Even pages carry the even text and not the ordinary one, odd pages the reverse; `{page}`/`{pages}`
  are filled on even pages; a section that did not ask for it keeps its ordinary band; a mirrored book with no even text swaps edges.
* **Limits:** (1) ODF only honours a left-hand header in a mirrored page layout, which turns the margins over; Writer uses it only when the left and right
  margins are equal and otherwise says so in the export warnings and keeps the ordinary band. (2) Microsoft Word decides even/odd by the *printed* page number, so a
  section that restarts numbering at an even number swaps which pages get the even text in Word; the PDF and the editor follow the position. Both were already the
  case for mirrored margins. Word itself was not available to check.

## 5. Audit remediation matrix

The 12 November 2026 audit's Writer section was supplied on 2026-11-17 (the link itself was not readable). It names **four Writer findings** (table insertion and
Markdown conversion; proofreading failure visibility; P1 export-fidelity tests conditional on Documaster; P2 APA 7 name parsing). **All four are Writer-only.** The
audit text assigns nothing else to Writer; whatever it says about SPADRA is not in the text supplied and nothing below is a SPADRA change. Rows E and F are
Writer's own follow-through from the request, not audit findings.

| Finding | Priority | Current state | Root cause | Implementation | Tests | Result |
|---|---|---|---|---|---|---|
| A. Table insertion and Markdown→table: "improved, browser-to-server placement still needs execution" | — | Insert ribbon had no Table or Markdown-to-table control; the server operation existed | Feature reachable only by shortcut/API | Ribbon "Tables" group; insertion splits the block at the cursor, keeps order, spans and undo; refused (with a message, nothing changed) without a text caret or in a read-only document | `test_ribbon_formatting.py`, `test_table_insert_contract.py`, `tests_ts/table_insert.test.ts`, **`tests_e2e/table_insertion.mjs` — the browser-to-server execution the audit asks for** (real Chromium, real server, placement read back from the saved document), `table_features.mjs`, `table_editor.mjs` | **Completed** |
| B. Proofreading failure visibility: "verify recovered or newly installed services are detected without misleading the user" | — | A checker that failed to load was reported and then never tried again until the page was reloaded | Failure was remembered for the session | Server `Failure` pause (15 s doubling to 300 s), `retryAfter` in the answer and error details, `retry:true` from the Check button skips the pause; client retries by itself only while the page is visible and the check is on, at most 12 times in a row, restarts on Check / setting / language change / success, honest notice ("Writer will try again by itself" / "has stopped trying"), a refusal (403) is never retried; a service that appears later (installed or recovered) is picked up by the next attempt and the notice clears | `test_assist.py` (3), `test_v24_integration.py`, `tests_ts/proof_status.test.ts` (4), `tests_e2e/proofing.mjs` (service down then back, long pause respected, manual check at once, refusal not retried, typing not blocked) | **Completed.** The outage is simulated at the network in the browser test; a service installed mid-session is covered by the same path (the server re-probes after the pause), not by installing a package during a test |
| C. Export fidelity tests conditional on Documaster (P1) | P1 | Skips were silent; three tests quietly depended on SLAI Reader | `skipTest` scattered, no gate | Every skip goes through `independent.need()`; `SLAI_REQUIRE_INTEGRATION=1` makes it a failure; `tests/gate.py` also fails on any other skip; **`ci/writer-integration-gate.yml`: mandatory CI job on Linux and Windows, installs LibreOffice, poppler, the Python readers and citeproc-py, runs the gate, and is meant to be a required status check**; `docs/INTEGRATION_GATE.md`. Exported documents are compared by software that did not write them (pdfplumber, pypdf, pdftoppm, python-docx, LibreOffice) | `test_export_fidelity`, `test_export_layout`, `test_book_layout`, `test_manuscript_scenario`, `test_odd_even` | **Completed on Linux. The CI workflow exists but has not been run (no CI here); Windows and Reader import unverified.** Default run: 11 skipped. Gate run: those 11 fail by design |
| D. APA 7 name parsing relies on heuristics (P2): prefer structured CSL author fields, preserve literal/institutional names, correction controls for ambiguous personal names, tests for multilingual/compound/particle/suffix/institutional/disambiguation against the APA CSL style | P2 | Names were free strings split by a heuristic in the citation engine; an institution was split into "Organization, W. H."; `Smith JA` read as family "JA"; the legacy in-text mark ignored particles; no way to say "I meant this" | One heuristic in one function, used by one of five code paths | `names.py`: `Family, Given` and `{Literal}` are the person's statement and become CSL `family`/`given`/`suffix`/`literal`; guesses are flagged with a note that says what to type; particles, suffixes, compound and hyphenated names, CJK, institutions, "&"/"and"; one reading for CSL mapping, in-text, reference line, year suffixes, warnings; organisation-only sources have an author; same-surname-same-year gets the initial. **Correction controls (2026-11-17):** the source editor shows each name as read ("Your wording" / "Writer's reading", the reference-list form, the note) and offers Confirm this reading, Keep as one name, and Change… (family / given / suffix / organisation, refused with a reason when it cannot be read back); the corrected line is the only text that changes. Endpoint `POST /api/names/read` (nothing stored) | `test_names.py` 23 (incl. a canonical-text fixture shared with the editor), `test_citation_mapping.py`, `test_academic.py`, `test_api_tools.py::AuthorNames`, `tests_ts/names_ui.test.ts` 5, `tests_e2e/author_names.mjs` 3/3, **`test_names_csl.py` 8 — multilingual, particle, suffix, institution, disambiguation through the real APA CSL: written, not run here** | **Completed for reading, controls and fallback output. Rendering through citeproc-py and apa.csl is unverified: the package cannot be installed in this environment, so `test_names_csl.py` skips here, fails under the gate, and runs in the CI job.** SLDC stores an author as a string (≤100 names), so the structure lives in the spelling; a structured author field would change the shared format and is not made |
| E. v2.4 integration | — | Offset-based cross-reference had no base version | Missed route | Base version on `/xref`; transactions, rollback, unknown-extension round trip, unavailable services, concurrent windows tested | `test_v24_integration.py` 10, `test_api_revisions.py` 4 | **Completed for Writer.** "Agent registration" is not a Writer concept: agents are reached through Documaster's gateway; their absence is reported, not hidden |
| F. Browser-level and visual verification | — | Several features had server tests only | — | Browser suites for page views, book layout, odd/even, author names, writing audit, table insertion, proofing recovery; export-vs-preview visual comparison | all suites in section 7 | **Completed** within the limits above |

## 6. The mandatory manuscript scenario

`tests/test_manuscript_scenario.py`: cover; front matter with ordinary margins; three chapters in a mirrored section (inside 22, outside 16); Scripture
paragraphs; a 3×3 table; a picture; a text box; a citation with a bibliography; a contents list; header and page-number footer. Steps: measure alternation
→ change the gutter 8 → 12 and measure again (the stored margins stay 22/16) → insert three paragraphs, check parity alternates → remove them, the page
count returns → edit, save, reopen twice, equal → export PDF (pypdf, pdfplumber, pdftoppm) → compare with the Rendered view → export DOCX (python-docx:
headings, table, picture, three sections) → print the DOCX with LibreOffice and measure edges and page count (within 2 pages of the PDF). **Passes.**
Browser side of the same workflow: `page_views.mjs`, `book_layout.mjs`.

## 7. Test evidence (this environment, 2026-11-17)

| Suite | Result |
|---|---|
| Writer Python | **495 tests, OK, 11 skipped** (3 SLAI Reader import tests; 8 `test_names_csl.py` tests that need citeproc-py) |
| Same, gate mode | exactly those 11 fail, with their reasons; everything else passes |
| Writer TypeScript unit | 202/202; `tsc` clean on `tsconfig.json`, `.build.json`, `.test.json` |
| Browser | run 38/38, page_views 8/8, book_layout 8/8, **odd_even 4/4**, **author_names 4/4**, textbox 19/19, writing_audit 17/17, table_insertion 7/7, table_features 10/10, table_editor (all PASS lines), column_features 11/11, toc_features 7/7, startup 10/10, proofing 14/14. One writing_audit scenario failed in the batch run because the client was rebuilt while it was running; the run on the final build is 17/17. `author_names` failed once in the batch (a pending refresh repainted an open correction form away): fixed, a scenario added, 4/4 three times in a row |
| Performance (`writing_perf.mjs`, this run) | typing p95 ≈ 31 ms at 2, 15 and 60 pages; Enter / Backspace-merge at 60 pages 466 / 452 ms (the 2026-11-16 figure was ≈350 ms: run-to-run variation on this machine was not measured, so no claim is made either way); undo ≤ 11 ms, scroll without a frame over 50 ms |
| Shared tools Python | 49 pass; `test_commit_host` cannot be imported here (`src/agents/planning` absent). Pre-existing and outside Writer; not changed |
| CI workflow | `ci/writer-integration-gate.yml` parses as YAML; **never executed** |

## 8. Compatibility

| | SLDC | PDF / DOCX | Windows | Linux | SLAI |
|---|---|---|---|---|---|
| Result | Unknown extensions on the document and on blocks survive editing and saving (tested). Reader, SPlanner and Documaster forward-compatibility with `.sldc` from this round: **not done** | Verified with independent readers on Linux (above) | **Unverified** (needs a run there; see `INTEGRATION_GATE.md`) | Verified | Documaster verified; Reader import **unverified** (absent) |

## 9. Outstanding

* **Completed:** items 1–6 including odd/even header and footer content; audit findings A, B, C (locally), D (reading, controls, fallback), E, F.
* **Partial:** enter/Backspace latency in very long documents (about 0.35–0.47 s at 60 pages) is improved against the starting point but not flat.
* **Unverified (could not be run here):** APA 7 rendering of names through citeproc-py and `apa.csl` (`test_names_csl.py` is written and will run in CI);
  the CI workflow itself; anything on Windows; DOCX pagination and odd/even in Microsoft Word; SLAI Reader import tests (Reader absent).
* **Limits that remain by design:** ODT left-hand headers need equal left and right margins (otherwise a warning and the ordinary band); Word decides
  odd/even by the printed page number, so a section restarting at an even number swaps the pages in Word.
* **Not done from an earlier request:** `.sldc` forward-compatibility in Reader, SPlanner and Documaster.
* **Known noise:** three-word names such as "Mary Jane Watson" carry a "check this reading" note by design (the reading cannot be known); the correction
  controls (or retyping as `Watson, Mary Jane`) remove it.
