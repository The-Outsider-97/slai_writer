"""Reads what a browser drew of a table: ``python -m applications.slai_writer.tests.pixel_cli input.json`` prints a JSON list of differences.

The input is a list of ``{label, block, custom, rows, columns, png, scale, words}`` (a screenshot of the editor, with where the text of every cell is)
or ``{label, block, custom, rows, columns, pdf, pdf_page, png?}`` (a PDF, drawn by poppler or, with ``png``, as the Rendered View shows it): the table block with its Writer extensions, the style the document
defines, a screenshot, how many screenshot pixels make one point, and where every cell's text is (points from the screenshot's top left corner). The
expectation is Writer's own resolution of the block (``table_styles.export_look``); the browser's pixels are compared to it with the same probe that checks
the PDF, Word, OpenDocument and RTF output.
"""
from __future__ import annotations

import json
import sys

from PIL import Image

from applications.slai_writer import table_styles as ts
from . import pdf_tables


def main(path: str) -> int:
    found: list[str] = []
    for item in json.load(open(path)):
        look = ts.export_look(item["block"], item.get("custom") or {})
        if "pdf" in item:                                     # the words come from the PDF; the pixels from a screenshot of it (the Rendered View) or from poppler
            import io

            import pdfplumber
            data = open(item["pdf"], "rb").read()
            with pdfplumber.open(io.BytesIO(data)) as document:
                page = document.pages[item["pdf_page"] - 1]
                _, _, words = pdf_tables.centres(page, item["rows"], item["columns"])
                width_pt = float(page.width)
            if item.get("png"):
                image = Image.open(item["png"]).convert("RGB")
                scale = image.width / width_pt
            else:
                image, scale = pdf_tables.rasterise(data, item["pdf_page"], 200), 200 / 72
            got = pdf_tables.probe(image, scale, words, item["rows"], item["columns"], look)
        else:
            image = Image.open(item["png"]).convert("RGB")
            got = pdf_tables.probe(image, item["scale"], item["words"], item["rows"], item["columns"], look)
        found.extend(pdf_tables.problems(got, look, item["label"], item.get("tolerance", 10.0)))
    print(json.dumps(found))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
