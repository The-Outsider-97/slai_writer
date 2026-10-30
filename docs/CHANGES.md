# Change summary

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
