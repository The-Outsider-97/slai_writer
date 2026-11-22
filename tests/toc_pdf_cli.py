"""Reads the contents page of a PDF for the browser test of the contents entries: python -m applications.slai_writer.tests.toc_pdf_cli <pdf> <leader char> <left margin mm> <right margin mm>

Prints one JSON object: ``{"frame": [left, right] (points), "entries": {first word: {"text": [x0, x1], "number": [x0, x1] | null, "leader": [x0, x1] | null, "lines": n}}}``."""
from __future__ import annotations

import json
import sys

from .test_toc_layout import MM, PdfLayout


def main(pdf: str, leader_char: str, left_mm: float, right_mm: float) -> dict:
    grouped, width = PdfLayout.entries(None, pdf, leader_char)       # type: ignore[arg-type]  (the reader does not use the test case)
    out = {}
    for name, lines in grouped.items():
        first, last = lines[0], lines[-1]
        def span(chars):
            return [min(c["x0"] for c in chars), max(c["x1"] for c in chars)] if chars else None
        text_first = span(first["text"])
        # the number and the leader of an entry stand on its first line (numbers first) or on its last (numbers last): take them from whichever line has them
        number = next((span(line["number"]) for line in lines if line["number"]), None)
        leader = next((span(line["leader"]) for line in lines if line["leader"]), None)
        out[name] = {"text": text_first, "text_last": span(last["text"]), "number": number, "leader": leader, "lines": len(lines)}
    return {"frame": [left_mm * MM, width - right_mm * MM], "entries": out}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))))
