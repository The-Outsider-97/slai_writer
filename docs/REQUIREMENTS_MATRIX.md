# Requirements traceability matrix

Source pages are those of `SLAI_Writer_main.pdf` (Document A, 15 pages) unless marked **B** (`SLAI_Writer_-_ChatGPT_Application_concept_v1.1.pdf`).
Both documents say they are "not drawn fully to scale"; Writer keeps their layout logic, identity, relative positions and interaction behaviour.

Status values: **Done** = implemented and verified by the tests named; **Done, disclosed limit** = implemented, with a limit that is stated in the
product; **Honest unavailable** = depends on something this installation does not have, and the screen says so instead of faking it.

Test names: `py:` = Python module in `tests/`; `e2e:` = scenario in `tests_e2e/run.mjs`; `ts:` = `tests_ts/`.

## A. Screens and flows

| # | Requirement (page) | Where | Verified by | Status |
|---|---|---|---|---|
| A1 | Startup: Login, Sign up, Continue as guest; guest usage may be limited (p1) | `screens/auth.ts`, `plans.py` | e2e: startup offers guest use; py: test_api_accounts | Done |
| A2 | Guest can create, edit, save, reopen and export offline (p1, p9) | whole app; no account needed for any `/docs` route | e2e: guest creates…, save/reopen, SLDC file check; py: test_api_documents | Done |
| A3 | Signup → 25-character e-mail code, paste + keyboard cells, 5-minute life, resend invalidates the old code and is throttled, failures rate-limited, change e-mail restarts, nothing disclosed about accounts (p2) | `screens/auth.ts`, `accounts.py`, `routes_account.py`, `mailer.py` | py: test_accounts (22), test_api_accounts (15) | Done (real SMTP untested here, see TEST_REPORT) |
| A4 | Login → six-digit authenticator code on new device / expired trust / high-risk change; "remember this device 30 days"; trust revocable; does not extend an expired session (p3) | `accounts.py`, `totp.py`, `screens/auth.ts`, `screens/profile.ts` | py: test_accounts, test_api_accounts | Done |
| A5 | Plans & Pricing: Guest/Essential/Creator/Professional/Workspace, monthly/yearly (−10 %), 30 % student discount, Creator recommended, Workspace €30 per paid user, VAT note, current plan (p4) | `plans.py`, `configs/plans.yaml`, `screens/plans.ts` | e2e: plans show Workspace €30; no simulated payment; py: test_api_tools | Done; billing **Honest unavailable** |
| A6 | Enrollment and recovery: QR once in a protected step, confirm a code before enabling, recovery codes shown once and kept separately, lost-authenticator recovery with delay (p5) | `accounts.py`, `screens/profile.ts`, `screens/auth.ts` | py: test_accounts | Done |
| A7 | Application side panel: fixed on Home/Settings; in an open document it is the **left application panel, collapsed by default** (arrow "<" opens it; icons + dots rail when collapsed) and the dropdown sandwich menu keeps the same entries (p5 note, p11) | `shell.ts`, `sidepanels.ts`, `navmenu.ts` | e2e: reopen via menu → Home; five panels collapsed; panels independent | Done |
| A8 | Signature graphics: draw, upload, choose saved; inspect uploads (type, dimensions, metadata) with preview; optional, not credentials (p6) | `screens/signatures.ts`, `sigdialog.ts`, `signing.py` | py: test_signing (11) | Done |
| A9 | Sign a frozen revision: document/revision/signer table, only the selected revision signed, later changes are new work (p7) | `screens/signing.ts`, `signing.py`, SLDC signing API | py: test_signing | Done |
| A10 | Verify: current draft and signed history evaluated separately; "modified since signed revision" (p8) | `screens/signing.ts`, `signing.py` | py: test_signing | Done |
| A11 | Home / library: search, New document / Open local file / Open folder, recents with location and save state, favorites, local first (p9) | `screens/home.ts`, `library.py` | e2e: reopen from Home; py: test_api_documents | Done; shared items **Honest unavailable** |
| A12 | New document and templates: name, template cards, page size, language, accessible headings, destination; Blank available to Guest; Creator adds publishing templates (p10) | `screens/newdoc.ts`, `templates.py` | py: test_api_documents; e2e: create document | Done (8 templates, spec shows 3) |
| A13 | Settings (theme, text size, cursors, autosave, spelling, AI) and Help/Support (p5, p11, p15 + B) | `screens/settings.ts`, `screens/help.ts` | e2e: settings/plans/help render | Done |
| A14 | Open / Upload / Export / Import / Favorite / Version history / Print in the side panel (p9, p11) | `shell.ts`, `fileops.ts`, `screens/versions.ts`, `export.py` | py: test_export (11); e2e: history | Done |

## B. Editor chrome (p11–p15)

| # | Requirement | Where | Verified by | Status |
|---|---|---|---|---|
| B1 | Dropdown sandwich menu (white rounded menu under the top bar, design icons, Profile/Settings at the bottom; the icon turns into a cross while open) | `navmenu.ts`, `docbars.ts` | e2e (menu used for Home, Version history) | Done |
| B2 | Save: left click saves now, right click chooses autosave on/off and interval | `docbars.ts`, `docsave.ts`, `/docs/{sid}/autosave` | py: test_api_documents; e2e: save | Done |
| B3 | Undo / redo (+ history lists) | `docbars.ts`, `actions.ts`, `session.py` | e2e: find/replace undo; py | Done |
| B4 | Dropdown of other opened files ("01: Name") | `docbars.ts` | e2e (document button present) | Done |
| B5 | Double-click the file name (not the extension) to rename; F2 | `docbars.ts`, `/docs/{sid}/rename` | py: test_extension_is_kept_on_rename | Done |
| B6 | Search in the document; a leading "/" searches Writer's functions; matches green; "2/24" counter; hover + double-click makes a linked note | `find.ts`, `commands.ts`, `docbars.ts`, `notesapi.ts` | e2e: find/replace; linked note from a match; slash palette | Done |
| B7 | Tools: Documaster, SReader, SPlanner, SciCal, Secure folder, AI Assistant (left application panel, design icons) | `panels/tools.ts`, `sidepanels.ts` | e2e: left panel opens from its arrow | Documaster **Done** (converters); the others **Honest unavailable** ("Not connected" / "Unavailable") |
| B8 | Right application panel, **collapsed by default**: Pages / Chapters / Sections, Layers, Page background, Illustrations as expandable sections with the design icons (p11) | `panels/right.ts`, `sidepanels.ts` | e2e: opens from its arrow, independent of the others; py: ops | Done; layer hide is screen-only and says so |
| B9 | Page-attached panels: **left pink/coral tab → dark-red Corrections panel** (proofing + AI); **right gold tab → olive Notes panel** (notes, comments, sources); **bottom grey tab → charcoal EMBED panel** (p12–p14). Hidden by default, tabs always visible, one set per page | `attach.ts`, `screens/doc.ts`, `panels/*` | e2e: five panels collapsed; tab positions; each panel independent; Esc closes and returns focus | Done |
| B10 | On-page lines: black = outer margin, blue = header/footer, red = user-added; movable | `page.ts`, `ext.guides` | e2e: page setup; manual | Done |
| B11 | Double-click on a ruler → edit page dimensions; on a blank page area → vertical + horizontal line at that point | `page.ts`, `dialogs.ts` | e2e: page setup from the ruler | Done |
| B12 | Typos highlighted transparent red, grammar transparent orange, user notes pastel blue | `decor.ts`, `styles.css` | manual + e2e (panels) | Done (spell checker itself **Honest unavailable**, below) |
| B13 | Status bar (p12): "Page 01 of 12", words – characters, "Version", "last edit"; centre: workspace, pen, eye (Hide/Reveal) and status dots; right: zoom to height / width, 1 % slider, percentage | `docbars.ts` | e2e: zoom | Done, disclosed limit (page count approximate) |
| B14 | Separate statuses: local save, cloud sync, AI availability, signature verification | `shell.ts` `statusDots` | e2e (visible) | Done; cloud = "not connected" |
| B15 | Hide / Reveal (the eye): darken and blur everything except the page. Separate from panel visibility | `screens/doc.ts`, `editor.css` | e2e: Hide / Esc; screenshot light + dark | Done |
| B16 | Custom cursors: default pointer, drag and drop, manual drawing, typing; user can import and assign (p15) | `cursors.py`, `screens/settings.ts`, `Editor.setCursors` | py: test_api_documents (cursor import/assign) | Done |
| B17 | Proofing panel: grammar and orthography errors, fixes, synonyms (p13) | `panels/proof.ts` | py: test_assist; e2e: honest state | Spell/grammar/synonyms **Honest unavailable** in this install |
| B18 | AI Assistant flow: scope, task, provider (local/cloud visible), review diff, Accept/Reject/Cancel, degrade safely (p12) | `panels/proof.ts`, `assist.py` | py: test_assist (17) | Done; model **Honest unavailable** |
| B19 | Notes panel: max width 100 mm, height = page height − (top + bottom margin) (p12); follows the page when zooming and scrolling | `attach.ts` | e2e: stays at the page edge at 100 % and 60 % | Done; width is 72 mm at 100 %, never above 100 mm and never below 236 px on screen so text stays readable when zoomed out |

## B+. UI design fidelity (brief "UI Design Fidelity, Panel Visibility, and Interaction Requirements" and pages 11–14)

| # | Requirement | Where | Verified by | Status |
|---|---|---|---|---|
| F1 | A newly opened document shows **all five panels collapsed**; nothing expands on open | `screens/doc.ts`, `attach.ts`, `sidepanels.ts`; `side_panel: false` default in `app.py` | e2e: five panels collapsed | Done |
| F2 | Arrows of the two application panels and the three coloured page tabs stay visible when collapsed; tabs are the design's tabs, not floating buttons | `sidepanels.ts`, `attach.ts` | e2e: tab and arrow visibility and position (left / right / beneath the page) | Done |
| F3 | Each of the five panels opens and closes independently | same | e2e: independent panels | Done |
| F4 | Page panels are editing UI: outside the contenteditable and the sheet, not printed, no change to text, version, page size or margins | `page.ts` `layer`, print rules | e2e: panels do not change the document or the page; not inside the page content; print rule | Done |
| F5 | Panels keep their page relation when scrolling and zooming (and sit on each page of a multi-page document) | `PageView.onPlace`, `sheetRect` | e2e: panel at page edge at 100 % and 60 % | Done; multi-page placement is by the same code but was **not** covered by a scenario |
| F6 | Opening the EMBED panel does not unlock or run anything; security is independent of visibility | `panels/embed.ts` | e2e: no embed created, text says so; py: test_embeds | Done |
| F7 | Design icons are the design's own (cut from the PDF), used as masks so they follow the theme; no icon library | `assets/ico-*.png` (38), `dico.ts`, `editor.css` | review + screenshots | Done |
| F8 | Colours sampled from the PDF (page white, pink tab, gold tab, dark-red / olive / charcoal panels, grey tab, ruler and guide lines); light and dark appearances | `editor.css` | screenshots light + dark against p11–p14 | Done |
| F9 | Top bar: sandwich, save (dirty dot), undo / redo with history, `01:` documents pill, file name + `.sldc`, search that opens into a pill, theme toggle | `docbars.ts`, `shell.ts` | e2e: save, undo, search, rename | Done |
| F10 | Rulers with bar-code ticks only (no numbers), rounded page, margin guides | `page.ts`, `editor.css` | screenshots | Done |
| F11 | Panel proportions, hierarchy and spatial relations preserved at any zoom; default zoom fits the page height so the page is dominant | `attach.ts`, `page.ts`, `app.py` `zoom_mode: height` | screenshots at 61 % and 100 % | Done |

### Deviations from the pages 11–14 drawings that remain (each is deliberate)

1. **Four status dots** (local save, cloud, AI, signature) where the drawing shows three; p12 lists four statuses.
2. **Serif typography** of the drawing is not applied to the interface; the kit's sans-serif is kept (the Home screen you approved uses it). The document page itself keeps its own fonts.
3. **OS window controls** in the drawings are not drawn (browser / OS chrome).
4. **Formatting bar.** The drawings show none; Writer keeps a compact one, **hidden by default**, shown with the `/` function search ("formatting bar") or the View command.
5. **EMBED tab arrow.** The drawing (p13) has the arrow pointing down while the panel is closed and up while it is open; the brief says "upward-facing". The drawing was followed. One-line change in `attach.ts` if you want the other.
6. **Panel width.** 72 mm at 100 % (limit 100 mm), not the drawn proportion, so that two panels plus the page fit a laptop screen.
7. **Theme toggle** is the design's toggle and is also used on Home.
8. **Panel text is not scaled with the page**, so it stays readable when the page is zoomed out; only the panel's position and height follow the page.

### Not verified

Dark-mode details of every dialog; screenshots exist for the editor only. Multi-page documents with several panels open at once were not
exercised in a browser run. Screen-reader behaviour of the new tabs was not tested.

## B++. Last-round requests

| # | Request | Status | Evidence |
|---|---|---|---|
| 1 | Logo `applications/assets/slai_writer` | Done | start-up and shell use the file |
| 2 | Start-up in the page-1 style | Done (by eye) | e2e 1 |
| 3 | Smoother theme toggle and panel motion | Done (by eye; no automated check of smoothness) | – |
| 4 | Signature fields on one level | Done | e2e 33 |
| 5 | Never both side panels on one side | Done | e2e 15 |
| 6 | Ruler numbers on hover | Done | e2e 34 + manual run |
| 7 | Movable margin / header / footer lines | Done; saved as `header_mm`/`footer_mm` (SLDC 1.1 `page-bands`); "tab" = ruler margin handles | e2e 34, `test_page_bands`, `figure.test.ts` |
| 8 | Page panels zoom with the page | Done | e2e 17 |
| 9 | EMBED attached behind the page | Done (by eye) | e2e 16/17 |
| 10 | Shortcuts: new page, section, layer, background, illustration | Done; provenance in Support page | e2e 36 |
| 11 | Return to document | Done for Settings, Plans, Support; Profile not driven | e2e 32 |
| 12 | Edit and move an inserted picture | Done within the limits in `CHANGES.md` | e2e 35, `figure.test.ts`, `test_page_bands.PictureSettings` |
| 13 | Paste a picture | Done for PNG, JPEG, GIF, WebP; other types and links are refused with a message | e2e 35 (synthetic paste) |
| 14 | Orphan-asset error | Fixed | `test_page_bands.OrphanPictures` |

## C. Document features

| # | Requirement | Where | Verified by | Status |
|---|---|---|---|---|
| C1 | Text, headings, styles, lists, quotes, code, alignment, indent | `actions.ts`, `ops.py` | e2e: bold/heading; py | Done |
| C2 | Pages, chapters, sections, section breaks, page breaks | `ops.py` (`section_break`, `page_setup`), `panels/right.ts` | py: test_api_documents | Done |
| C3 | Headers/footers, margins, page numbering, orientation, custom sizes | `dialogs.ts`, `ops.py` | py; e2e: page setup | Done |
| C4 | Rulers, guides, background (colour), layers | `page.ts`, `dialogs.ts`, `ext_set` | e2e (ruler, guides) | Done; picture background **not supported** (colour only) |
| C5 | Images (drag/drop, paste, picker), alt text or "decorative", captions, figure properties | `dialogs.ts`, `/docs/{sid}/images` | py: test_api_documents | Done |
| C6 | Tables (insert, cell typing, Tab, rows/columns, header rows) | `dialogs.ts`, `ops.py` | e2e: table scenario | Done |
| C7 | Equations (block and inline), shown as source | `dialogs.ts` | e2e: equation; py: equation upgrade test | Done, disclosed limit (no offline typesetting) |
| C8 | Footnotes, citations, cross-references, bibliography, contents | `panels/sources.ts`, `academic.py` | py: test_academic (15) | Done |
| C9 | Comments (threads, resolve, anchored) and notes (private, linked) | `panels/notes.ts`, `store.py` | e2e: comment; linked note | Done |
| C10 | `/` command search, context menu, formatting toolbar (Writer adds a compact one) | `commands.ts` | e2e: slash palette | Done |
| C11 | Zoom 10–400 %, counts, undo/redo, shortcuts, drag and drop, links | `page.ts`, `input.ts` | e2e: zoom; ts | Done |
| C12 | Version history; restore as a **new** revision; snapshots | `session.py`, `screens/versions.ts` | py: test_api_documents | Done |
| C13 | Conflict detection and recovery (stale version, external change, crash recovery) | `session.py`, `docsave.ts` | e2e: stale 409; py | Done |
| C14 | Import / export / print / PDF preflight with honest loss disclosure | `export.py`, `fileops.ts` | py: test_export | Done; needs Documaster / pypdf / pypdfium2 (503 otherwise) |
| C15 | `.sldc` canonical; `.sdoc` only explicit safe migration | `library.py`, SLDC `migrate_*` | py: test_api_documents | Done |

## D. Academic integrity, AI and EMBED

| # | Requirement | Where | Verified by | Status |
|---|---|---|---|---|
| D1 | Never fabricate sources, authors, dates, DOIs, pages or quotations; distinguish verified / user-provided / AI-suggested | `academic.py`, `panels/sources.ts` | py: test_academic | Done |
| D2 | Spell, grammar and AI are explicit, scoped, permission-aware, reviewed before application and reversible; writing works without AI | `assist.py`, `panels/proof.ts` | py: test_assist; e2e: nothing changes by itself | Done |
| D3 | EMBED locked state: purpose, role, access denied, public summary, Request access, Verify identity, Validate; a signature does not unlock (p13) | `embeds.py`, `panels/embed.ts` | py: test_embeds (9) | Done; Request access **Honest unavailable** |
| D4 | EMBED editor and preview: schema/inputs/version, validation errors block Preview/Apply, last valid output, revision-bound patch, undoable (p14) | `embeds.py`, `panels/embed.ts` | py: test_embeds; e2e: EMBED drawer | Done |
| D5 | Opening/previewing never executes declarations; AI/LSTP requests are not authorisation | `embeds.py` | py: test_embeds | Done |
| D6 | A visual signature is never proof of integrity or identity | `sigdialog.ts`, `signing.py` | py: test_signing | Done |

## E. Security, accessibility, quality

| # | Requirement | Where | Verified by | Status |
|---|---|---|---|---|
| E1 | Loopback only; token + HttpOnly cookie; Host/Origin checks; marker header; CSP; `{ok,data}` envelope | `applications/tools/server` | py: tools tests (46); e2e: marker/origin refused | Done |
| E2 | No secrets or document text in logs; path traversal, malformed archives, bombs, injection, unauthorised API | `routing.py`, SLDC bounded reader, `validation.py` | py: test_api_*; e2e: 403 on missing marker, no document text in server output | Done |
| E3 | Accessibility: keyboard, focus, names, live regions, contrast theme, reduced motion, text scaling, non-colour status | all client | e2e: Tab focus; manual (no screen-reader run) | Done, disclosed limit (no assistive-technology test) |
| E4 | No fake AI / saves / exports / empty handlers / dummy subscription / placeholder collaboration | whole app | review + e2e (honest states) | Done |
| E5 | Collaboration/workspace with backend-enforced permissions, never simulated | `workspace.py` | py: test_workspace (5) | **Honest unavailable** (merge-a-copy is real) |
| E6 | Tests: shared tools, Writer, type checks, build checks, siblings | see `TEST_REPORT.md` | — | Sibling suites run on the user's machine (not in this mirror) |

## Discrepancies and decisions (A wins; each recorded here)

1. **E-mail code length.** A: 25 characters; B: 6 digits. Implemented 25 (A p2). The authenticator code is 6 digits (A p3).
2. **Workspace price.** A p4: €30; B: €25. Implemented €30 in `plans.yaml` (configurable).
3. **Local documents on Guest/Essential.** The A plans table says "limited"; its own note says no local document-count cap. Implemented unlimited; the value is in `plans.yaml`.
4. **Signature limits.** A p1 says max 2 distinct / 20 uploads; p6 says those are "not security requirements". Implemented as configurable limits (`signatures:` in config) and described as preferences, never as security.
5. **Hosted accounts vs local store.** A describes accounts as if hosted; this installation keeps accounts in the local store. Stated on the signup and profile screens; cloud is "not connected".
6. **Version label.** A shows "Version: 2.1"; SLDC revisions are integers. The status bar shows "Version: N" (the revision number).
7. **`.sdoc` line.** An A/B README line lists `.sdoc`; `.sldc` is canonical. `.sdoc` is import/migration only.
8. **Secure folder** is described as an app; no such application exists in SLAI. It is shown as "Unavailable". SReader, SPlanner and SciCal are shown "Not connected" because Writer has no link to them.
9. **Documaster PDF** leaves Helvetica unembedded; export lists fonts that are not embedded.
10. **SLDC `year`** is an integer; citations with a non-numeric year are stored in `note`, never coerced.
11. **EMBED lock** is an interface-level lock; the declaration is not encrypted by Writer.
12. **Window controls** in the mock-ups are OS/browser chrome and are not drawn.
13. **Templates.** A shows 3; Writer offers 8 (the 3 plus others); plan gating decides which are available.
14. **Page count** is approximate (block-granular layout); the exact count comes only from the print preview. Stated in the status bar tooltip.
15. **Tabloid** exists in SLDC and is offered in page setup; the original preference list lacked it.
16. **Page-background picture** is not supported by SLDC page properties; colour only.
17. **Columns** are shown as one column and the page-setup dialog has no column control (SLDC stores `columns`, but reflowing columns is not implemented).
18. **Startup screen** shows an e-mail field in all three modes (as drawn); in guest mode it is ignored.
19. **Verify screen "Change email address"** cancels the pending signup and restarts verification (A p2: "Changing email restarts verification").
20. **Formatting toolbar.** The mock-ups show none; Writer adds a compact one that is **hidden by default** and can be shown (its state is remembered per browser).
21. **Status "percentage of errors … or just the SLAI connection, i don't know yet"** (p13 note). Writer shows the four separate statuses of p12 instead of an error percentage.
22. **The original 25-scenario test list** from the task statement is not recoverable from the working notes; `TEST_REPORT.md` maps this suite to the requirements instead and invites the exact list.
