# SLAI Writer: architecture

SLAI Writer is a local-first document authoring application. A Python process serves a TypeScript browser client on `127.0.0.1` and owns every
document in memory; the browser is a view that sends small, versioned operations. Documents are SLDC packages (`.sldc`), written by the
single SLDC implementation in `src/utils/sldc.py`. Writer contains no second SLDC parser, serializer, encryption format, signing scheme or
revision engine.

Source of truth: `SLAI_Writer_main.pdf` (Document A). `SLAI_Writer_-_ChatGPT_Application_concept_v1.1.pdf` (Document B) supplements it.
Where they disagree Writer follows A and the difference is recorded in `REQUIREMENTS_MATRIX.md`, section "Discrepancies".

## 1. Layers and what is reused

```
Browser (TypeScript, no bundler)          applications/slai_writer/src/client/*.ts  ──►  dist/ (tsc output + styles.css)
   │  kit imports only through src/client/kit.ts
   ▼
Shared web kit                            applications/tools/web   (slai-ui.css, h(), dialogs, menus, toasts, API client, themes, icons)
   │  HTTP, JSON envelope {ok,data} / {ok:false,error}
   ▼
Shared server                             applications/tools/server (loopback ThreadingHTTPServer, token → HttpOnly cookie, Host/Origin checks,
   │                                       CSP, marker header on writes, body limits, static files, router)
   ▼
Writer application                        applications/slai_writer/*.py
   │   routes_*.py    HTTP handlers (126 routes, see API.md)
   │   session.py     one DocumentSession per open document: model, undo/redo, revisions, autosave, recovery, snapshots, merge
   │   ops.py         the operation vocabulary applied to a session (text, format, blocks, tables, pages, styles, sources, embeds, ext…)
   │   textmodel.py   block/span arithmetic shared by ops
   │   accounts.py    signup, e-mail code, login, TOTP, recovery codes, trusted devices, sessions, throttling, audit
   │   totp.py        RFC 6238 on hashlib/hmac only
   │   signing.py     signature graphics + signing/verification through SLDC's own signing API
   │   academic.py    sources, citations, footnotes, bibliography, contents; verification statuses
   │   embeds.py      EMBED catalogue, schema validation, locked/inert components, revision-bound patches
   │   assist.py      proofing and AI Assistant orchestration (explicit, scoped, reviewable, reversible)
   │   export.py      import/export/print preview/PDF preflight with honest loss reports
   │   docmaster.py   the link to Documaster's readers and writers (not copied, never modified)
   │   workspace.py   shared-workspace boundary: always "not connected" here; merge-a-copy is real
   │   plans.py       plan catalogue/entitlements from configs/plans.yaml; no payment code
   │   store.py       Writer's SQLite store (via applications/tools storage + database)
   │   library.py     library folders, recents, favorites, unique names
   │   templates.py   8 templates, built through SLDC
   │   cursors.py, picker.py, mailer.py, protect.py, app.py, routing.py
   ▼
SLAI core                                 src/utils/sldc.py (SLDC), src/utils/configuration (ConfigRepository, optional), applications/Documaster
```

Reused rather than rebuilt: the server, storage, database, config, errors, validation, SLAI locator and web kit in `applications/tools`; the
logo/icon set in `applications/assets`; SLDC in `src/utils/sldc.py`; Documaster's format converters. The only edits to shared code are listed in
`CHANGES.md` ("Shared tools") and are covered by tests.

## 2. Server-authoritative editing

The server is the only place a document changes. The browser never edits a private copy.

* Every edit is `POST /api/docs/{sid}/ops` with `{op, base}`. `base` is the version the browser last saw. A stale base is refused with 409
  `details.kind = "stale_version"`; the client then offers "Load the latest version". Nothing is merged silently.
* The server answers with a **patch**: changed blocks, optional new order, document metadata, dirty flag, counts, undo/redo depth, revision,
  signature count and notices. The client merges it (`model.ts`) and re-renders only what changed (`render.ts`, `editor.ts`).
* Operations that change many things (open reference list, restore a version, merge, AI apply) answer with a whole `state` instead, and the client
  resynchronises (`Editor.resync`).
* Undo/redo are server-side stacks per session. A single-step undo answers with a patch, a multi-step undo with a state.
* The client sends operations through one serial `OpQueue`, so versions never cross. Other server work (citations, EMBED apply, AI apply) runs in the
  same queue (`OpQueue.run`).
* Keys pressed while a structural edit (Enter, Backspace, Undo, replacing a selection) is waiting for the server are held and replayed in order,
  consecutive characters merged into one insertion (`input.ts`). Save, export and search wait for held keys (`Editor.whenIdle`), and so does every command.
* If the caret is outside any paragraph (after Ctrl+End past a picture, for example) a keystroke is held, the caret is put in a real paragraph,
  and the key is replayed. Text is never shown that the server does not have.

### Persistence, recovery and conflicts

* `Save` writes the SLDC package atomically; `Save as` never overwrites without an explicit confirmation; a name the person did not choose gets a
  free variant (`Untitled document (2)`), a name they typed never does.
* Autosave is per document (on/off and interval), plus a crash-recovery copy of unsaved work a few seconds after each edit (`recovery_seconds`).
* Snapshots (version history) are taken on save, sign, restore, merge and on demand. **Restore creates a new revision**; the old one stays.
* If the file on disk changed while there are unsaved edits, Save is refused (409 `external_change`) and the person chooses: merge (conflicts
  are shown first, then merged keeping their text), keep both (save theirs as a separate file), overwrite (a snapshot is kept first) or reload.
* The package version is upgraded from SLDC 1.0 to 1.1 exactly once, when the content needs it (equations, inline pictures, EMBED…); a notice tells
  the person that older 1.0-only readers may not open the file.
* `.sdoc` is a compatibility import only: it is read through SLDC's migration path and written as `.sldc`; it is never renamed in place or
  reinterpreted silently.

## 3. The browser client

Strict TypeScript (`noUncheckedIndexedAccess`, `noUnusedLocals`), compiled by the shared `build-static.mjs`. There is no framework and no inline
style or script (the CSP forbids both).

| Concern | Files |
|---|---|
| Boot, routing, session, preferences, open documents | `main.ts`, `app.ts`, `net.ts`, `shell.ts` |
| Pre-editor screens | `screens/auth.ts` (startup, signup, verify, login, 2FA, recovery), `home.ts`, `newdoc.ts`, `settings.ts`, `plans.ts`, `profile.ts`, `help.ts`, `signatures.ts`, `signing.ts`, `versions.ts` |
| Editor engine | `editor.ts` (one `contenteditable` root, diffed typing), `input.ts` (beforeinput/keys/drag/drop), `actions.ts` (every edit as ops), `model.ts`, `render.ts`, `domtext.ts`, `textops.ts`, `page.ts` (sheets, zoom, rulers, guides), `decor.ts` (highlights via the CSS Custom Highlight API) |
| Editor screen | `screens/doc.ts` (assembly), `docbars.ts` (top bar, status bar, optional formatting bar), `navmenu.ts` (sandwich menu), `docsave.ts`, `find.ts`, `commands.ts` (one command table for toolbar, `/` search, context menu), `dialogs.ts`, `sigdialog.ts`, `notesapi.ts`, `dico.ts` (the design's icons), `editor.css` |
| Application panels (collapsed by default) | `sidepanels.ts` (left Tools rail/panel, right organisation rail/panel, arrows in the ruler row), `panels/tools.ts`, `panels/right.ts` (pages/chapters/sections, layers, background, illustrations) |
| Page-attached panels (collapsed by default) | `attach.ts`: three tabs per page (pink left, gold right, grey bottom) and the panels they open, in an overlay `layer` beside the scaled pages, never inside the editable root. Content: `panels/proof.ts` (corrections + AI), `notes.ts`, `sources.ts`, `embed.ts` |
| Shared | `kit.ts` is the **only** import point for `applications/tools/web` |

Pagination is block-granular and approximate; the status bar says "approx." and the print preview (rasterised from the real PDF the PDF writer
produces) is the only exact page count. Zoom is a CSS transform (10–400 %) on the pages only; the panel layer is positioned from each sheet's on-screen rectangle (`PageView.sheetRect`, re-run by `onPlace` after layout, zoom, reflow and resize), so panels follow their page without being scaled or printed. The EMBED panel pushes the following pages down with the sheet's bottom margin. Rulers are SVG. Search matches, typos, grammar marks, notes and comments
are highlights over the live text, not wrapper elements, so they never change what is typed.

### Page bands, pictures and layers (last round)

* **Page bands.** `header_mm` / `footer_mm` live in the section's `page` (SLDC feature `page-bands`, format 1.1.0). `PageView` draws six draggable
  slider-role lines per sheet and the ruler handles from one `LineSpec` list; changes go through the `page_setup` op. Defaults: `max(2, margin/2 - 3)` mm.
* **Pictures.** `figlayout.ts` is the single place that turns the figure properties (width/height, crop, rotation, mirroring, placement) into sizes;
  `render.ts` paints with it and `imageedit.ts` edits with it (overlay in `PageView.overlay`, in front of the sheets). Every edit is a `figure_set` op, checked by
  `ops._check_figure_props`. Unused pictures are dropped by `prune_assets()` when the file is written (`session._rid`).
* **Layers.** Writer-only data in `extensions["slai.writer"]`: `layers` (name, visible, locked, custom) and `layer_of` (block id → layer), set by `ext_set` and validated in `ops._check_layers`.

## 4. Accounts and security

* **Guest** needs no account: create, edit, save, reopen and export all work offline.
* **Signup:** e-mail + password → a 25-character code is e-mailed (5-minute life, resend invalidates the previous code, throttled, failed attempts rate
  limited, "change e-mail" cancels the pending signup) → authenticator enrolment (QR + secret shown only in the protected setup step, confirmed
  with a code before 2FA is enabled) → recovery codes shown once.
* **Login:** password, then a six-digit TOTP code on new devices, expired trust or high-risk changes; "remember this device" is limited to the
  configured days and can be revoked; recovery codes; "lost authenticator" starts a delayed secure recovery.
* E-mail is sent through SMTP only (`configs/config.yaml` `mail:`; the password comes from `SLAI_WRITER_SMTP_PASSWORD`). With no SMTP configured
  signup says so; no code is ever shown on screen or logged. Tests use an in-memory `Outbox`.
* Passwords are stored as scrypt hashes and codes only as keyed hashes; secrets (TOTP seeds, signing keys) are encrypted at rest with the data-folder master key
  (`master.key`, created with owner-only permissions).
* The server listens on loopback only (`--host` other than 127.0.0.1 is refused), requires the launch token (exchanged for an HttpOnly,
  SameSite=Strict cookie), checks `Host` and `Origin`, requires the marker header on writes, sends a strict CSP, caps request and upload sizes, and
  never logs document text or secrets.
* File paths from the browser are validated (`clean_path`): absolute, no traversal, no device names; archives are read through SLDC's bounded
  reader (size, entry count and compression-ratio limits).

## 5. Signatures

A visual signature (drawn, uploaded or saved) is a picture and **never** proof. The graphics dialog says so, and a visual mark is never described
as verified. Cryptographic signing uses SLDC's own signing API on the frozen revision; verification evaluates the current draft and signed history
separately ("Modified since signed revision N"). Later edits start a new revision and never alter signed bytes. Limits (2 distinct signatures, 20
uploads) are configuration, not security.

## 6. Academic writing

Sources have a status that says who vouches for them: `user` (typed by the person), `imported`, `ai` (suggested, must be checked), `checked`
(the person confirmed against the real work) and `registry` (a DOI-registry match, only after an explicit online lookup the person enabled).
Writer never invents authors, dates, DOIs, page numbers or quotations; AI-suggested sources start as `ai` and are labelled in the list, in the
citation and in the reference list. A reference list is built from each source's own fields.

## 7. Proofing and AI

Spelling, grammar and the AI Assistant never run by themselves. Each is started by a button, scoped (selection, section or document), checked
against the plan and the person's AI setting, returned as proposals (hunks with original and replacement) and applied only for hunks the person
accepts; additions that introduce unverified references need a second confirmation. Every apply is one undoable edit, and a stale proposal is
refused because it names the exact text it expects. With AI off or its agent unavailable the panel says so and writing is unaffected. There is no
stub model: unavailable means unavailable.

## 8. EMBED

An EMBED block is an inert, locked component: a declarative definition (`kind`, `schema_version`, `params`, `inputs`) validated against a schema from
the catalogue (`writer.stats`, `writer.excerpt`, `writer.table_total`). It cannot run code. Preview shows the exact output and its SHA-256 without
changing the document; Apply is bound to the document revision and input hashes and is refused (409) if either moved. A locked view shows a public
summary and an access-denied state; "Request access" is an honest "needs a workspace" answer. An AI request is never an authorisation. The lock
is an interface-level lock, not encryption of the declaration (recorded as a discrepancy).

## 9. Import, export, print

Formats: SLDC (native), PDF, DOCX, ODT, RTF, HTML, Markdown, text, XML (and CSV/DOC/PDF import) through Documaster. Before export the dialog lists
what the target format loses; the result report repeats it and adds PDF facts (pages, fonts not embedded). Print preview rasterises the real PDF.
If Documaster or a PDF library is missing the feature says exactly what is missing (503 `dependency_missing`) and nothing is faked.

## 10. Collaboration and plans

There is no workspace server in this installation, so shared editing, roles and "request access" report "not connected" rather than simulating
people. What is real: merging an edited **copy** of the same document (conflicts shown, local text kept on conflict, their whole version saved to
history). Plans (Guest, Essential, Creator, Professional, Workspace) come from `configs/plans.yaml` with the values of Document A page 4;
gating is enforced server-side (`strict`) and a paid plan can only become active through a real billing integration. The app never reports a
successful payment it did not receive.

## 11. Accessibility

Every control has an accessible name; dialogs trap and restore focus; menus and the `/` palette are keyboard operable; status is never colour
alone (text + icon + dot); live regions announce save, search counts, errors and mode changes; Esc closes page panels, menus, palettes and Hide; reduced
motion and text scaling are honoured; the "contrast" theme raises contrast of page marks and highlights.

## 12. Directory map

```
applications/slai_writer/
  *.py              server side            tests/            Python tests (151)
  src/client/       browser client         tests_ts/         TypeScript unit tests (27)
  configs/          config.yaml, plans.yaml tests_e2e/        Playwright scenarios (31), run.mjs
  assets/           Writer-only images     docs/             this documentation
  dist/             build output (generated)
```
