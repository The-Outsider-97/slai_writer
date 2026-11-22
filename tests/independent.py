"""Independent readers for export checks: a document written by Documaster is opened by software that did not write it.

The PDF is read with pdfplumber (a different PDF reader than the one that wrote it, reportlab's own is write-only); DOCX, ODT and RTF are opened by
LibreOffice and printed to PDF, which is then measured the same way. Nothing here trusts the writer's own bookkeeping.

A missing reader skips the test on a developer's machine. When ``SLAI_REQUIRE_INTEGRATION=1`` (the dedicated integration gate, see docs/INTEGRATION_GATE.md)
a missing reader or an unexpected skip is a failure instead: a green gate then means the checks ran.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

MM_PT = 72 / 25.4


def gate_required() -> bool:
    return os.environ.get("SLAI_REQUIRE_INTEGRATION") == "1"


def need(test: unittest.TestCase, what: str, available: bool, reason: str) -> None:
    """Skip when ``what`` is not available, or fail when the integration gate demands that it is."""
    if available:
        return
    if gate_required():
        test.fail(f"The integration gate needs {what}, which is not available here: {reason}")
    test.skipTest(f"{what} is not available: {reason}")


def soffice() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def to_pdf(source: Path, out_dir: Path) -> bytes:
    """Open a document in LibreOffice and print it to PDF. Raises when LibreOffice cannot do that."""
    binary = soffice()
    if not binary:
        raise RuntimeError("LibreOffice is not installed")
    profile = Path(tempfile.mkdtemp(prefix="lo-profile-"))
    try:
        run = subprocess.run([binary, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(out_dir), str(source)],
                             capture_output=True, text=True, timeout=180)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    produced = out_dir / (source.stem + ".pdf")
    if run.returncode != 0 or not produced.exists():
        raise RuntimeError(f"LibreOffice could not open {source.name}: {run.stderr.strip() or run.stdout.strip()}")
    return produced.read_bytes()


def text_edges(data: bytes, margin_band_pt: float = 60.0) -> list[tuple[float, float] | None]:
    """For every page: the distance in millimetres from the left and from the right edge of the page to the text, headers and footers left out."""
    import pdfplumber
    out: list[tuple[float, float] | None] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            words = [w for w in page.extract_words() if w["top"] > margin_band_pt and w["bottom"] < page.height - margin_band_pt]
            out.append((round(min(w["x0"] for w in words) / MM_PT, 1), round((page.width - max(w["x1"] for w in words)) / MM_PT, 1)) if words else None)
    return out
