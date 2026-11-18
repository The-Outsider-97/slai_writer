"""Reads the borders and fills of tables back out of a PDF, with pdfplumber, so a test can compare them with what the editor's resolver says.

Every cell of the tables in these tests holds a text ``r<row>c<column>`` that no other cell has. The words give the centre of every row (the first column) and of
every column (the first row); an edge between two rows is the stroked line that crosses a column's centre between those two row centres, and the outer edges
are the lines beyond the first and last centre. Colours come back as ``#RRGGBB``, widths in points.
"""
from __future__ import annotations

import io
from typing import Any


def _hex(colour: Any) -> str | None:
    if colour is None:
        return None
    if isinstance(colour, (int, float)):
        colour = (colour, colour, colour)
    if len(colour) == 1:
        colour = (colour[0],) * 3
    if len(colour) == 4:                                    # CMYK
        c, m, y, k = colour
        colour = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return "#%02X%02X%02X" % tuple(int(round(v * 255)) for v in colour[:3])


def centres(page: Any, rows: int, columns: int) -> tuple[list[float], list[float], dict[str, dict[str, Any]]]:
    words = {w["text"]: w for w in page.extract_words()}
    ys = [(words[f"r{r}c0"]["top"] + words[f"r{r}c0"]["bottom"]) / 2 for r in range(rows)]
    xs = [(words[f"r0c{c}"]["x0"] + words[f"r0c{c}"]["x1"]) / 2 for c in range(columns)]
    return ys, xs, words


def read(page: Any, rows: int, columns: int) -> dict[str, Any]:
    ys, xs, words = centres(page, rows, columns)
    horizontal = [l for l in page.lines if abs(l["top"] - l["bottom"]) < 0.01]
    vertical = [l for l in page.lines if abs(l["x0"] - l["x1"]) < 0.01]
    # a rectangle that is only a rule (reportlab draws some thin lines as filled rectangles) counts as a line
    h: dict[str, list[dict[str, Any]]] = {}
    v: dict[str, list[dict[str, Any]]] = {}
    far = 400
    for line in range(rows + 1):
        low = ys[line - 1] if line > 0 else ys[0] - far
        high = ys[line] if line < rows else ys[-1] + far
        for c in range(columns):
            found = [l for l in horizontal if low < l["top"] < high and l["x0"] - 0.5 <= xs[c] <= l["x1"] + 0.5]
            if found:
                h[f"{line},{c}"] = [{"color": _hex(l["stroking_color"]), "width": round(l["linewidth"], 3), "y": l["top"]} for l in found]
    for line in range(columns + 1):
        low = xs[line - 1] if line > 0 else xs[0] - far
        high = xs[line] if line < columns else xs[-1] + far
        for r in range(rows):
            found = [l for l in vertical if low < l["x0"] < high and l["top"] - 0.5 <= ys[r] <= l["bottom"] + 0.5]
            if found:
                v[f"{r},{line}"] = [{"color": _hex(l["stroking_color"]), "width": round(l["linewidth"], 3), "x": l["x0"]} for l in found]
    fills: dict[str, str | None] = {}
    for key, word in words.items():
        if not (key.startswith("r") and "c" in key):
            continue
        cx, cy = (word["x0"] + word["x1"]) / 2, (word["top"] + word["bottom"]) / 2
        best = None
        for rect in page.rects:
            if not rect.get("fill") or rect["x0"] > cx or rect["x1"] < cx or rect["top"] > cy or rect["bottom"] < cy:
                continue
            area = (rect["x1"] - rect["x0"]) * (rect["bottom"] - rect["top"])
            if best is None or area < best[0]:
                best = (area, _hex(rect["non_stroking_color"]))
        fills[key[1:].replace("c", ",")] = best[1] if best else None
    return {"h": h, "v": v, "fills": fills, "ys": ys, "xs": xs}


# ---------------------------------------------------------------------------------------------- pixels (documents that were printed by another program)
def _distance(a: tuple[int, int, int], b: str) -> float:
    target = tuple(int(b[i:i + 2], 16) for i in (1, 3, 5))
    return max(abs(a[i] - target[i]) for i in range(3))


def rasterise(pdf: bytes, page_number: int, dpi: int = 200) -> Any:
    """One page of a PDF as a PIL image, drawn by poppler."""
    import subprocess
    import tempfile
    from pathlib import Path

    from PIL import Image
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "in.pdf"
        source.write_bytes(pdf)
        subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page_number), "-l", str(page_number), "-png", "-singlefile", str(source), str(Path(tmp) / "page")],
                       check=True, capture_output=True, timeout=120)
        return Image.open(Path(tmp) / "page.png").convert("RGB")


def pixels(pdf: bytes, page_number: int, rows: int, columns: int, expected: dict[str, Any], dpi: int = 200) -> dict[str, Any]:
    """``probe`` on one page of a PDF as poppler draws it."""
    import io

    import pdfplumber
    image = rasterise(pdf, page_number, dpi)
    with pdfplumber.open(io.BytesIO(pdf)) as document:
        _, _, words = centres(document.pages[page_number - 1], rows, columns)
    return probe(image, dpi / 72, words, rows, columns, expected)


def probe(image: Any, scale: float, words: dict[str, dict[str, float]], rows: int, columns: int, expected: dict[str, Any]) -> dict[str, Any]:
    """Compares a drawn table with ``expected`` (an ``export_look``) by looking at the pixels poppler draws for it.

    Returns ``fills`` (cell -> the colour found just inside the cell), ``h``/``v`` (edge -> the smallest colour distance to the border's colour in a strip
    around where the edge is; None when the edge has no border) and ``ink`` (edges that have no border but have a mark in them)."""
    ys = [(words[f"r{r}c0"]["top"] + words[f"r{r}c0"]["bottom"]) / 2 for r in range(rows)]
    xs = [(words[f"r0c{c}"]["x0"] + words[f"r0c{c}"]["x1"]) / 2 for c in range(columns)]
    height = max(w["bottom"] - w["top"] for w in words.values())

    def at(x: float, y: float) -> tuple[int, int, int]:
        return image.getpixel((max(0, min(image.width - 1, int(x * scale))), max(0, min(image.height - 1, int(y * scale)))))

    def hexed(rgb: tuple[int, int, int]) -> str:
        return "#%02X%02X%02X" % rgb

    fills: dict[str, str] = {}
    for key in expected["cells"]:
        r, c = (int(x) for x in key.split(","))
        word = words[f"r{r}c{c}"]
        fills[key] = hexed(at(word["x1"] + 4.0, (word["top"] + word["bottom"]) / 2))   # to the right of the text: in every program the cell reaches further that way than to the left

    def strip(x0: float, x1: float, y0: float, y1: float, fine: str) -> list[tuple[int, int, int]]:
        out = []
        # twice per pixel across the line (``fine``): a line one pixel thick must not fall between samples; along it every pixel (a dotted line has gaps)
        steps_x, steps_y = max(2, int((x1 - x0) * scale * (2 if fine == 'x' else 1))), max(2, int((y1 - y0) * scale * (2 if fine == 'y' else 1)))
        for i in range(steps_x + 1):
            for j in range(steps_y + 1):
                out.append(at(x0 + (x1 - x0) * i / steps_x, y0 + (y1 - y0) * j / steps_y))
        return out

    reach = 14.0
    result: dict[str, Any] = {"fills": fills, "h": {}, "v": {}, "ink": []}
    for axis, count, size in (("h", rows + 1, columns), ("v", columns + 1, rows)):
        for line in range(count):
            for index in range(size):
                key = f"{line},{index}" if axis == "h" else f"{index},{line}"
                if axis == "h":
                    # between the lowest ink of the row above and the highest ink of the row below (rows can be as tight as the text)
                    y0 = words[f"r{line - 1}c{index}"]["bottom"] + 0.2 if line > 0 else ys[0] - height * 0.5 - 12
                    y1 = words[f"r{line}c{index}"]["top"] - 0.2 if line < rows else ys[-1] + height * 0.5 + 26
                    sample = strip(xs[index] - 6, xs[index] + 6, y0, max(y0 + 0.5, y1), 'y')   # narrower than a cell: the neighbouring vertical edges must stay out
                else:
                    # between the right end of the text of the column on the left and the left end of the text of the column on the right
                    x0 = max(words[f"r{r}c{line - 1}"]["x1"] for r in range(rows)) + 0.5 if line > 0 else min(words[f"r{r}c0"]["x0"] for r in range(rows)) - 90
                    x1 = min(words[f"r{r}c{line}"]["x0"] for r in range(rows)) - 0.5 if line < columns else min(max(words[f"r{r}c{columns - 1}"]["x1"] for r in range(rows)) + 200, image.width / scale)
                    if line == 0:
                        x1 = min(words[f"r{r}c0"]["x0"] for r in range(rows)) - 0.5
                    if line == columns:
                        x0 = max(words[f"r{r}c{columns - 1}"]["x1"] for r in range(rows)) + 0.5
                    sample = strip(x0, max(x0 + 0.5, x1), ys[index] - height * 0.3, ys[index] + height * 0.3, 'x')
                spec = expected["h" if axis == "h" else "v"].get(key)
                around = {fills.get(f"{a},{b}", "#FFFFFF") for a, b in ((line - 1, index), (line, index)) if axis == "h"} | \
                         {fills.get(f"{a},{b}", "#FFFFFF") for a, b in ((index, line - 1), (index, line)) if axis == "v"}
                around |= {"#FFFFFF"}
                if spec:
                    # how far the best pixel is from the border's colour, less half of how far it is from the cell colours on either side: a line that
                    # anti-aliasing has softened is still the line (it is nearer to its own colour than to the cells), a line of another colour or none is not
                    result[axis][key] = min(_distance(p, spec["color"]) - 0.5 * min(_distance(p, f) for f in around) for p in sample)
                else:
                    result[axis][key] = None
                    if any(all(_distance(p, f) > 70 for f in around) for p in sample):
                        result["ink"].append(f"{axis}:{key}")
    return result


def problems(got: dict[str, Any], look: dict[str, Any], label: str, tolerance: float = 10.0) -> list[str]:
    """What is different between a ``probe`` result and the look it was drawn from (an empty list when it is the same)."""
    out: list[str] = []
    for key, cell in look["cells"].items():
        want = cell["fill"] or "#FFFFFF"
        if _distance(tuple(int(got["fills"][key][i:i + 2], 16) for i in (1, 3, 5)), want) > 40:
            out.append(f"{label}: cell {key} fill should be {want}, drawn {got['fills'][key]}")
    for axis in ("h", "v"):
        for key, spec in look[axis].items():
            # a dotted or hairline stroke never reaches its full colour in a picture of a page: it only has to show
            allowed = tolerance if spec.get("style", "solid") == "solid" and spec["width_pt"] >= 0.75 else tolerance + 40
            if got[axis][key] is None or got[axis][key] > allowed:
                out.append(f"{label}: {axis} border {key} {spec['color']} is not drawn (best match scores {got[axis][key]:.0f}, it should be {allowed:.0f} or less)")
    out.extend(f"{label}: a mark on {mark}, where the style has no border" for mark in got["ink"])
    return out


def check_pixels(case: Any, pdf: bytes, looks: list[dict[str, Any]], rows: int, columns: int, labels: list[str], tolerance: float = 10.0) -> None:
    """Asserts, for every page of ``pdf``, that what poppler draws is what ``looks`` (one per page) resolve to."""
    for n, (look, label) in enumerate(zip(looks, labels)):
        found = problems(pixels(pdf, n + 1, rows, columns, look), look, label, tolerance)
        case.assertEqual(found, [], "\n".join(found))
