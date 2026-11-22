# SLAI Writer

SLAI Writer is a local-first document editor in the [SLAI ecosystem](https://github.com/The-Outsider-97/SLAI). It provides document editing, layout and writing tools, with optional integrations for proofreading, AI assistance and document conversion.

Its native document format is **`.sldc` (SLAI Document)**. Importing and exporting other formats depends on the available integrations, particularly Documaster.

## Install and run — Windows (PowerShell)

### Requirements

- An **existing SLAI checkout**. Writer belongs at `SLAI/applications/slai_writer/` and uses SLAI's shared application tools and document-format implementation. If SLAI itself is not installed yet, follow the [SLAI installation guide](https://github.com/The-Outsider-97/SLAI#environment-and-installation) first.
- **Git** to clone SLAI Writer into that checkout.
- **Python 3.10–3.12** (Python **3.11 recommended** for compatibility with the SLAI v2.4 project). On Windows, check available versions with `py -0p`.
- A modern web browser. Writer runs a local server and opens its interface in the browser.
- **Node.js 22** and npm **only if you need to rebuild the browser client**. A built `dist/` directory is included in this repository.

SLAI Writer runs from its designated folder inside SLAI. The expected folder structure is:

```text
SLAI/
├── applications/
│   ├── tools/              # Shared SLAI application infrastructure
│   └── slai_writer/        # This repository
│       ├── run_slaiwriter.py
│       ├── requirements.txt
│       └── dist/
└── src/
    └── utils/
        └── sldc.py        # Shared document format
```

### 1. Clone SLAI Writer into `applications/slai_writer`

Open PowerShell **in your existing SLAI root directory** (the folder containing `src` and `applications`; for example, `G:\GAIA\AI\SLAI`). Run:

```powershell
git clone https://github.com/The-Outsider-97/slai_writer.git .\applications\slai_writer
```

This creates `SLAI/applications/slai_writer/` directly. **Do not clone Writer elsewhere or move its files to the SLAI root.** If that folder already exists as a Git checkout, use `git -C .\applications\slai_writer status` to inspect it before updating; do not clone over an existing folder.

### 2. Install Writer's Python dependencies

Use the **same Python environment you already use for SLAI**. If your SLAI virtual environment is named `venv`, activate it from the SLAI root with `.\venv\Scripts\Activate.ps1`; if it is already active, leave it active. Then run:

```powershell
python -m pip install -r .\applications\slai_writer\requirements.txt "pyyaml>=6.0"
```

The Writer requirements cover document, security, citation and PDF-related Python features. PyYAML provides the shared SLAI configuration loader. These commands **do not create or replace your existing SLAI environment**. Individual optional integrations may need additional packages or services.

If PowerShell prevents activating the existing `venv` environment, invoke its Python executable directly:

```powershell
.\venv\Scripts\python.exe -m pip install -r .\applications\slai_writer\requirements.txt "pyyaml>=6.0"
.\venv\Scripts\python.exe -m applications.slai_writer
```

If you use a differently named environment (for example `.venv`), substitute its name in those commands.

### 3. Run SLAI Writer

Still in the **SLAI root**, with the environment activated, run:

```powershell
python .\applications\slai_writer\run_slaiwriter.py
```

Or use the equivalent module command:

```powershell
python -m applications.slai_writer
```

**Do not move `run_slaiwriter.py` to the SLAI root.** The launcher already resolves the root from its current location.

Writer normally opens your browser automatically using a URL on `http://127.0.0.1:8770/` containing a temporary access token. If the browser does not open, use the **exact URL printed in the terminal**; do not share that token. Leave the terminal running while you work and press **Ctrl+C** to stop the application.

To use another port or avoid opening the browser automatically:

```powershell
python -m applications.slai_writer --port 8771
python -m applications.slai_writer --no-browser
python -m applications.slai_writer --help
```

### 4. Optional: rebuild the browser interface

Skip this step for a normal first run when `applications/slai_writer/dist/index.html` is present. For frontend development, install Node.js 22 and npm, then run:

```powershell
cd applications/slai_writer
npm.cmd ci
npm.cmd run build
cd ../..
python -m applications.slai_writer
```

`npm.cmd` is used here for PowerShell compatibility. `npm ci` uses the committed `package-lock.json`; `npm run build` compiles the TypeScript client using the shared builder at `applications/tools/build/build-static.mjs`.

## Linux / WSL

From an **existing SLAI root**, with its Python environment already activated, run:

```bash
git clone https://github.com/The-Outsider-97/slai_writer.git applications/slai_writer
python -m pip install -r applications/slai_writer/requirements.txt 'pyyaml>=6.0'
python -m applications.slai_writer
```

If Writer already exists in that folder, do not clone it again. To rebuild the client on Linux / WSL, run `npm ci` and `npm run build` from `applications/slai_writer` (Node.js required), then return to the SLAI root to start Writer.

## Optional features and integrations

| Capability | Additional requirement |
| --- | --- |
| Native `.sldc` documents | The main SLAI checkout, including `src/utils/sldc.py` |
| DOCX, ODT, RTF, HTML, Markdown and PDF import/export | Documaster installed at `SLAI/applications/Documaster` |
| AI-assisted writing | Compatible SLAI language components/models and the relevant settings enabled |
| Account e-mail verification and recovery | Configured SMTP service; guest use does not require it |
| Print preview, PDF checks and citation formatting | Dependencies listed in `requirements.txt` |

Unconnected integrations are reported in the application. They are not a reason to relocate Writer or install every SLAI dependency by default.

## Where files are saved

- **Documents:** `Documents/SLAI Writer` by default (or the configured library directory).
- **Application data:** `%LOCALAPPDATA%\SLAI\Writer` on Windows; typically `~/.local/share/slai/writer` on Linux. This contains settings, recovery data, backups and security material. **Back up this folder along with your documents**; do not commit its keys or private data to Git.
- **Configuration:** `applications/slai_writer/configs/config.yaml` and `configs/plans.yaml` within the Writer folder.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `No module named 'applications.slai_writer'` or missing `applications.tools` | Confirm the folder layout above and launch from the SLAI root. |
| `dist/index.html` is missing | Build the frontend using the optional Node.js instructions above. |
| Error importing `yaml` | Install `pyyaml>=6.0` in the Python environment used to launch Writer. |
| Python version or dependency installation fails | Use a supported Python version; 3.11 is recommended for SLAI v2.4. |
| Port 8770 is already in use | Stop the other instance or start Writer with `--port 8771`. |
| Browser says **Unauthorized** | Open the exact tokenized URL printed during the current launch. |
| Word/PDF import or export is unavailable | Install/configure Documaster and check Writer's integration notices; `.sldc` editing works without it. |

For configuration, security, backups and more troubleshooting, see [Operating SLAI Writer](docs/OPERATIONS.md). For internals and technical checks, see the [documentation index](docs/README.md).

## License

See [LICENSE](LICENSE).
