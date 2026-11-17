"""The integration gate: the whole suite, where a skipped test is a failure.

    SLAI_REQUIRE_INTEGRATION=1 python -m applications.slai_writer.tests.gate

A test that cannot run because Documaster, LibreOffice, pdfplumber, python-docx, pypdf, poppler or SLAI Reader is missing is reported with its reason and the
gate exits non-zero, so a green gate means every export and import check ran against the real thing. Without the variable it behaves like ``unittest discover``
(skips are allowed and listed) and it never claims compatibility it did not measure: the closing line says how many checks were skipped.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

from . import independent


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), top_level_dir=str(root))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    skipped = result.skipped
    for test, reason in skipped:
        print(f"SKIPPED {test.id()}: {reason}")
    ok = result.wasSuccessful()
    if independent.gate_required() and skipped:
        print(f"\nIntegration gate FAILED: {len(skipped)} check(s) were skipped, so compatibility with the real tools was not measured.")
        ok = False
    elif skipped:
        print(f"\n{len(skipped)} check(s) were skipped: nothing was verified for them. Run with SLAI_REQUIRE_INTEGRATION=1 to make that a failure.")
    else:
        print("\nEvery check ran.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
