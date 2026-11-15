# SLAI Writer

SLAI Writer is a local-first document editor in the [SLAI ecosystem](https://github.com/The-Outsider-97/SLAI). It provides document editing, layout and writing tools, with optional integrations for proofreading, AI assistance and document conversion.

Its native document format is **`.sldc` (SLAI Document)**. Importing and exporting other formats depends on the available integrations, particularly Documaster.

## Quick start — Windows (PowerShell)

### Requirements

- **Git** to clone the repositories.
- **Python 3.10–3.12** (Python **3.11 recommended** for compatibility with the SLAI v2.4 project). On Windows, check available versions with `py -0p`.
- A modern web browser. Writer runs a local server and opens its interface in the browser.
- **Node.js 22** and npm **only if you need to rebuild the browser client**. A built `dist/` directory is included in this repository.

SLAI Writer is an application inside the main SLAI checkout, **not a standalone Python package**. Use this folder structure:

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

### 1. Clone SLAI and SLAI Writer

In PowerShell, navigate to the directory where you want to keep your projects, then run:

```powershell
git clone https://github.com/The-Outsider-97/SLAI.git
cd SLAI
git clone https://github.com/The-Outsider-97/slai_writer.git applications/slai_writer
```

**Already have SLAI?** Open PowerShell in your existing SLAI root (the directory containing `src` and `applications`) and run only the last `git clone` command. Do not clone Writer into a second nested `SLAI` folder. If `applications/slai_writer` already exists, update that checkout instead of cloning over it.

### 2. Create a Python environment and install dependencies

Run these commands **from the SLAI root**:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r .\applications\slai_writer\requirements.txt "pyyaml>=6.0"
```

The Writer requirements cover its document, security, citation and PDF-related Python features. PyYAML provides the shared SLAI configuration loader. You do **not** need to install SLAI's entire machine-learning dependency list just to launch Writer; individual optional integrations may need additional packages or services.

If the PowerShell execution policy prevents activation, you can still install and run with the environment's Python executable:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\applications\slai_writer\requirements.txt "pyyaml>=6.0"
.\.venv\Scripts\python.exe -m applications.slai_writer
```

### 3. Run SLAI Writer

Still in the **SLAI root**, with the environment activated, run:

```powershell
python -m applications.slai_writer
```

Alternatively, start it via:

```powershell
python .\applications\slai_writer\run_slaiwriter.py
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

With Git and Python 3.11 installed, run:

```bash
git clone https://github.com/The-Outsider-97/SLAI.git
cd SLAI
git clone https://github.com/The-Outsider-97/slai_writer.git applications/slai_writer
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r applications/slai_writer/requirements.txt 'pyyaml>=6.0'
python -m applications.slai_writer
```

To rebuild the client on Linux / WSL, run `npm ci` and `npm run build` from `applications/slai_writer` (Node.js required), then return to the SLAI root to start Writer.

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
