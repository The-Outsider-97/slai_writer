# Operating SLAI Writer

## 1. Install

1. Python 3.10 or newer and the SLAI checkout (Writer finds it by walking up from its own folder, or use `--slai-root` / `SLAI_ROOT`).
2. `pip install -r applications/slai_writer/requirements.txt` (cryptography, Pillow, reportlab; pypdfium2 and pypdf for print preview and PDF checks).
3. Node (built and tested with 22) is needed only to build or test the browser client: in `applications/slai_writer` run `npm install` then `npm run build` (this writes `dist/`).
   A pre-built `dist/` is included in the delivered folder, so Node is not needed just to run Writer.

## 2. Run

```
python -m applications.slai_writer                 # from the SLAI root
python applications/slai_writer/run_slaiwriter.py  # same thing; can be double-clicked
```

Writer prints a start-up URL that contains a one-time token and opens it in your browser. The token is traded for an HttpOnly cookie; keep the
URL to yourself. Options (shared by all SLAI applications): `--port` (default 8770), `--data-dir`, `--config`, `--plans`, `--client-dir`,
`--slai-root`, `--no-browser`, `--token` (tests only). `--host` other than `127.0.0.1` is refused: Writer is never exposed to a network.

If port 8770 is taken, Writer says so; pass `--port`. If `dist/index.html` is missing it says how to build.

## 3. Where things are

| What | Default location |
|---|---|
| Application data (accounts, notes, snapshots, signing keys, `prefs.json`, `master.key`, backups, crash recovery) | Windows `%LOCALAPPDATA%\SLAI\Writer`; elsewhere `$XDG_DATA_HOME/slai/writer` (`~/.local/share/slai/writer`) |
| Documents (the library) | `Documents/SLAI Writer` (or your home folder when there is no Documents), unless `app.library_root` is set |
| Settings you edit | `applications/slai_writer/configs/config.yaml`, `configs/plans.yaml` |
| Personal choices (theme, text size, autosave, cursors, zoom, spelling, AI) | Settings inside the app, stored in `prefs.json` |

`master.key` seals secrets (authenticator seeds, signing keys) with AES-256-GCM. It is created readable by its owner only. **Back it up with the
rest of the data folder**: without it the sealed values cannot be read, and Writer will say so rather than guess. Do not commit it or e-mail it.

The database is backed up automatically (every `backup_every_days`, keeping `backup_keep`) and before any migration that touches existing data.
Documents are ordinary `.sldc` files and are as safe as any file you back up; the data folder holds only what is not in them (notes, history,
accounts).

## 4. Configuration (`configs/config.yaml`)

Every key is optional; the file documents its defaults. Notable ones:

* `app.library_root` where new documents go; `app.autosave_default_seconds`; `app.recovery_seconds` (how soon unsaved work is copied for crash recovery);
  `app.max_upload_bytes` (32 MiB) and `app.max_request_bytes` (8 MiB for JSON).
* `accounts.*` session length, "remember me" days, trusted-device days (30), e-mail code life (5 min), resend delay, attempts and lockout, secure-recovery
  delay (24 h), minimum password length.
* `mail.*` SMTP host/port/username/sender/starttls. **The password is read from the `SLAI_WRITER_SMTP_PASSWORD` environment variable, never from a file.**
* `signatures.*` the signature-graphics limits (preferences, not security).

An invalid value is refused at start-up with a message that names the key.

## 5. What needs something extra (and what you see without it)

| Feature | Needs | Without it |
|---|---|---|
| Sign up, resend code, password reset | An SMTP server in `mail:` (+ the password variable) | Sign-up says e-mail is not configured. No code is ever shown on screen or logged. Guest use and existing accounts are unaffected |
| Import/export of DOCX, ODT, RTF, HTML, Markdown, PDF, text | `applications/Documaster` in the SLAI checkout | The Export/Import screens list the missing piece (503); SLDC save/open still work |
| Print preview, PDF page count and fonts | `pypdfium2`, `pypdf` | The preview says which package is missing |
| Spelling, grammar, AI Assistant | The SLAI language agent, and **AI switched on in Settings** | Spelling: "not available". Grammar/AI: "AI is off" with a button to Settings. Nothing is checked or sent unless you press a button |
| Native file dialogs | `tkinter` | Writer's own in-page file chooser is used |
| Shared workspace, Request access, roles, cloud storage, paid plans | A workspace/billing service that this installation does not have | Shown as "not connected"; merge-an-edited-copy works locally. No purchase can succeed |
| SReader, SPlanner, SciCal, Secure folder | The corresponding SLAI applications and links | Tools panel shows "Not connected" / "Unavailable" |

## 6. Plans and pricing

Edit `configs/plans.yaml`. The shipped values follow the main specification (page 4); `enforcement: strict` makes features follow the signed-in
account's plan, `enforcement: off` removes limits on this computer (self-hosted/development). The file moves no money. A paid plan can become active
only through a real billing integration, which Writer does not contain; until one exists the Plans screen says billing is not connected and nothing
is "bought".

## 7. Security notes for operators

* Loopback only; never put Writer behind a reverse proxy that exposes it. The start-up URL token is a capability: anyone holding it while Writer runs
  can use your documents.
* Cookies are HttpOnly + SameSite=Strict; writes need the `X-SLAI-Writer` header; Host and Origin are checked; the CSP allows only same-origin scripts
  and styles.
* Document text, passwords, codes and keys are never written to Writer's console output (the end-to-end suite checks the document-text part).
* Recovery codes are shown once, at enrolment. Writer cannot show them again.
* A visual signature is a picture, not proof. Cryptographic signatures use your signing key (sealed in the data folder); verification tells you which
  revision is covered and whether later edits exist.
* `.sldc` files may be encrypted with a password (SLDC's own recipient mechanism). Writer cannot recover a lost password.

## 8. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| "The web client is not built" | Run `npm run build` in `applications/slai_writer`, or copy the delivered `dist/` |
| Browser shows "Unauthorized" | Open the exact URL Writer printed; the token changes every start |
| "Is another copy already running?" | Another Writer is using the port; close it or pass `--port` |
| Save says the file changed on disk | Another program wrote it. Choose Merge, Keep both, Overwrite or Reload in the dialog; nothing is overwritten silently |
| "This document changed since your screen last updated" | Another window/session edited it. Use "Load the latest version" |
| Export/Import says a dependency is missing | See table in section 5 |
| "A document named X already exists" | Choose another name or folder; Writer never overwrites on create |
| Highlights (search, typos, notes) are not coloured | Old browser without the CSS Custom Highlight API; update the browser. Text and counts still work |
| An equation appears as its source | By design: no offline typesetting is available; the source is stored in the file |
| An old reader cannot open a file | The file was upgraded to SLDC 1.1 because it contains equations, inline pictures or similar; Writer showed a notice when that happened |

## 9. Regression check on your machine

The build environment did not contain the sibling applications. After copying Writer in, run (Windows venv shown; adapt the paths):

```
cd G:\GAIA\AI\SLAI
venv\Scripts\python -m unittest discover -s applications\tools\tests -t .
venv\Scripts\python -m unittest discover -s applications\slai_writer\tests -t .
venv\Scripts\python -m unittest discover -s applications\splanner\tests -t .      # and the other siblings' test folders
```

The only shared code Writer changed is `applications/tools/server/router.py` (`Request.bytes`) and `applications/tools/server/http.py` (`Response.cookies`),
both additive; see `CHANGES.md`.

## 10. Backups and removal

Copy the data folder and your library folder. To remove Writer, delete `applications/slai_writer` (and optionally the data folder). Nothing outside
the data folder, your library and the SLAI checkout is touched.
