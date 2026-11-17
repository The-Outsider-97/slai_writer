# Integration gate (export and import fidelity)

Writer hands documents to Documaster, which writes PDF, DOCX, ODT and RTF and reads other formats through SLAI Reader. Whether those files are *right* is
only known when they are opened by software that did not write them. That is what this gate does, and it refuses to pass when it could not.

## Running it

    SLAI_REQUIRE_INTEGRATION=1 python -m applications.slai_writer.tests.gate        # from the SLAI repository root

* Without the variable (a developer's machine) a missing tool **skips** its tests and the run says how many checks were skipped and that nothing was
  verified for them.
* With `SLAI_REQUIRE_INTEGRATION=1` a missing tool, or any skip at all, is a **failure**. Every skip in the suite goes through `tests/independent.need()`,
  and `tests/gate.py` additionally fails on a skip from any other source, so a new `skipTest` cannot hide.
* A green gate means: every check below ran.

## What must be present

| Needed | Used for |
|---|---|
| Documaster (`src/utils/doc`, loaded by `DocumasterLink`) | writing PDF, DOCX, ODT, RTF |
| `pdfplumber`, `pypdf` | reading the PDF: words and positions, page count, images, metadata |
| `python-docx` | reading the DOCX package: headings, tables, pictures, sections, margins |
| LibreOffice (`soffice` on PATH) | opening DOCX/ODT/RTF the way a user's word processor does, printing them to PDF, measuring that |
| poppler `pdftoppm` | rasterising the PDF independently of the Rendered view's pypdfium2 |
| `citeproc-py` (with the bundled `assets/csl/apa.csl`) | APA 7 rendering of author names (`test_names_csl.py`, 8 tests) |
| SLAI Reader (`src/agents/reader`) | importing Markdown, text and HTML (three tests) |

## What is checked

* **Structure, PDF and DOCX** (`test_export_fidelity.py`, `test_export_layout.py`, `test_book_layout.py`): headings, character formatting, lists, tables
  (header row repeats across pages), page size and margins, running header and footer with a live page number, reading order, page count equals the
  editor's, columns, separators and column breaks, contents entries with leaders and page references.
* **Geometry, independently measured**: the left and right text edges of every page (mirrored margins alternate, the gutter is added once, the text width
  never changes) from the PDF, and from DOCX/ODT/RTF as printed by LibreOffice.
* **Visual** (`test_manuscript_scenario.py`): the Rendered view's page pictures and poppler's rasterisation of the exported PDF agree on where the ink
  is, per page, within 2 mm.
* **The manuscript scenario** (`test_manuscript_scenario.py`): cover, front matter, mirrored chapters with a gutter, headers and footers, Scripture, a table, a
  picture, a text box, a citation with its bibliography and a contents list; the gutter changed and the section reflowed; pages inserted and removed; saved,
  reopened; exported to PDF and DOCX; read back by the independent tools above.

## The mandatory CI environment

`ci/writer-integration-gate.yml` is the job that makes the gate mandatory. Copy it to `.github/workflows/` at the SLAI repository root and make the `gate`
jobs required status checks on the protected branches. It runs `python -m applications.slai_writer.tests.gate` with `SLAI_REQUIRE_INTEGRATION=1` on **Ubuntu
and Windows**, after installing LibreOffice, poppler, `pdfplumber`, `python-docx`, `pypdf` and `citeproc-py`, so a skipped check on either system fails the
job. A second job builds the client, type-checks, runs the unit tests and every browser suite. **This workflow has not been run**: there is no CI in the build
environment, so it is unproven until its first run (package names for LibreOffice and poppler on the Windows runner in particular).

## Platforms

The tests use only `pathlib`, `subprocess` with argument lists and temporary directories, and look tools up with `shutil.which`; nothing is hard-coded to
a path or a shell. They were run on **Linux** (this build, 2026-11-16). They have **not been run on Windows by this build**: that run needs LibreOffice and
poppler on the machine's PATH (for example `winget install TheDocumentFoundation.LibreOffice` and a poppler build) and `pip install pdfplumber pypdf
python-docx`. Until it is run there, the Windows column of the compatibility report is *unverified*, not *passing*.

## Status in this environment (2026-11-17)

* Default run: 495 tests, 11 skipped (3 SLAI Reader import tests, 8 `test_names_csl.py` tests that need citeproc-py), 0 failures.
* Gate run: those 11 **fail**, by design; the three Reader tests with "The integration gate needs SLAI Reader's parser engine, which is not available here:
  src/agents/reader is missing or could not be loaded", the eight names tests with the citeproc-py reason. Importing Markdown, text and HTML and the APA CSL rendering of names are therefore **unverified** here, and Writer's import screen
  already says so to the user (`available_formats()` reports the reason). Every export test ran and passed.
