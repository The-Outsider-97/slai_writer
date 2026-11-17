"""Table styles: the gallery of looks, borders as edges of the grid, and the resolver that turns "style + hand-made formatting" into the
exact fill, text and borders of every cell.

The gallery lives in ``table_styles.json`` and is read by this module (server, export) and by the browser (it is compiled into
``src/client/table_styles_data.ts`` by ``scripts/gen_table_styles.py``); ``tests/test_table_styles.py`` and ``tests_ts/table_styles.test.ts``
check both resolvers against the same golden file, so the preview in the browser and the exported document use one definition.

Borders are stored per *edge of the grid* (``slai.writer.table_borders``), never per cell, so the two cells that share an edge cannot disagree
about it. The one rule for a border is therefore simple and deterministic:

1. an edge the person set (a colour/thickness/style, or "no border") wins;
2. otherwise the table style's rule for that edge applies (outer edges, header bottom, inside lines);
3. otherwise there is no border.

A later edit of an edge replaces an earlier one. A cell merged over several grid positions takes, for each side, the border of its first position.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .opcore import OpError
from .tablegrid import BORDERS_KEY, CELLS_KEY, STYLE_KEY, Grid

DATA: dict[str, Any] = json.loads((Path(__file__).parent / "table_styles.json").read_text(encoding="utf-8"))
PRESETS: dict[str, Any] = DATA["presets"]
DEFAULT_ACCENT: str = DATA["accent"]
OPTION_KEYS = ("header_row", "first_column", "banded_rows", "banded_columns")
LINE_STYLES = ("solid", "dashed", "dotted", "double")
INHERIT = object()                      # "no explicit border: let the table style decide"
_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")


class StyleError(ValueError):
    pass


def _fail(message: str) -> None:
    raise OpError(message)


# ------------------------------------------------------------------------------------------------------------- colours
def _rgb(value: str) -> tuple[int, int, int]:
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def mix(colour: str, other: tuple[int, int, int], amount: float) -> str:
    """``colour`` moved ``amount`` (0..1) of the way towards ``other``; rounding is half-up so the browser computes the same value."""
    r, g, b = _rgb(colour)
    out = [int((a + (o - a) * amount) + 0.5) for a, o in zip((r, g, b), other)]
    return "#%02X%02X%02X" % tuple(out)


def colour(spec: str | None, accent: str) -> str | None:
    if spec is None:
        return None
    if spec == "accent":
        return accent.upper()
    if spec == "accent_light":
        return mix(accent, (255, 255, 255), 0.85)
    if spec == "accent_dark":
        return mix(accent, (0, 0, 0), 0.35)
    return spec.upper()


# ----------------------------------------------------------------------------------------------------------- validation
def border_spec(color: Any = None, width_pt: Any = None, style: Any = None) -> dict[str, Any] | None:
    """A complete border from the parts that were given (defaults: black, 0.75 pt, solid). A style of ``none`` is "draw nothing"."""
    if style == "none":
        return None
    return {"color": (color or "#000000").upper(), "width_pt": 0.75 if width_pt is None else width_pt, "style": style or "solid"}


def checked_border(spec: dict[str, Any]) -> dict[str, Any] | None:
    unknown = set(spec) - {"color", "width_pt", "style"}
    if unknown:
        _fail(f"Unknown border setting: {sorted(unknown)[0]}")
    color, width, style = spec.get("color"), spec.get("width_pt"), spec.get("style")
    if color is not None and (not isinstance(color, str) or not _COLOUR.fullmatch(color)):
        _fail("A border colour must be #rrggbb")
    if width is not None and (isinstance(width, bool) or not isinstance(width, (int, float)) or not 0 <= width <= 12 or width != width):
        _fail("A border thickness must be a number from 0 to 12 points")
    if style is not None and style not in (*LINE_STYLES, "none"):
        _fail("A border style must be solid, dashed, dotted, double or none")
    return border_spec(color, width, style)


_KEY = re.compile(r"^(\d{1,5}),(\d{1,5})$")


def check_borders(value: Any, rows: int, columns: int) -> None:
    if not isinstance(value, dict) or set(value) - {"h", "v"}:
        _fail("Table borders must have 'h' and 'v' edges")
    for axis, (lines, positions) in {"h": (rows, columns), "v": (columns, rows)}.items():
        edges = value.get(axis, {})
        if not isinstance(edges, dict) or len(edges) > 400_000:
            _fail("Table borders must be objects keyed by edge")
        for key, spec in edges.items():
            match = _KEY.fullmatch(key) if isinstance(key, str) else None
            if match is None:
                _fail("A table border edge is keyed 'line,position'")
            a, b = int(match.group(1)), int(match.group(2))
            line, position = (a, b) if axis == "h" else (b, a)     # h: "line,column"; v: "row,line"
            if not 0 <= line <= lines or not 0 <= position < positions:
                _fail("A table border edge lies outside the table")
            if spec is not None:
                if not isinstance(spec, dict) or set(spec) != {"color", "width_pt", "style"}:
                    _fail("A table border needs a colour, a thickness and a style")
                checked = checked_border(spec)
                if checked != spec or spec["style"] == "none":
                    _fail("A stored table border must be complete and valid")


def check_style(style: Any, custom: dict[str, Any]) -> None:
    if not isinstance(style, dict):
        _fail("A table style must be an object")
    unknown = set(style) - {"preset", "accent", *OPTION_KEYS}
    if unknown:
        _fail(f"Unknown table style setting: {sorted(unknown)[0]}")
    preset = style.get("preset")
    if preset is not None:
        known = preset in PRESETS or (isinstance(preset, str) and preset.startswith("custom:") and preset[7:] in custom)
        if not known:
            _fail(f"There is no table style '{preset}'")
    accent = style.get("accent")
    if accent is not None and (not isinstance(accent, str) or not _COLOUR.fullmatch(accent)):
        _fail("The accent colour must be #rrggbb")
    for key in OPTION_KEYS:
        if key in style and not isinstance(style[key], bool):
            _fail(f"{key} must be true or false")


# --------------------------------------------------------------------------------------------------------------- edges
def region_edges(r0: int, c0: int, r1: int, c1: int, target: str, n_rows: int, n_cols: int) -> list[tuple[str, int, int]]:
    """The grid edges ``(axis, a, b)`` of the rectangle rows r0..r1-1 x columns c0..c1-1 that ``target`` names.

    Horizontal edges are ``("h", line, column)``, vertical ones ``("v", row, line)``.
    """
    rows, cols = range(r0, r1), range(c0, c1)
    parts = {
        "top": [("h", r0, c) for c in cols], "bottom": [("h", r1, c) for c in cols],
        "left": [("v", r, c0) for r in rows], "right": [("v", r, c1) for r in rows],
        "inside_h": [("h", line, c) for line in range(r0 + 1, r1) for c in cols],
        "inside_v": [("v", r, line) for r in rows for line in range(c0 + 1, c1)],
    }
    names = {"all": ("top", "bottom", "left", "right", "inside_h", "inside_v"), "none": ("top", "bottom", "left", "right", "inside_h", "inside_v"),
             "outside": ("top", "bottom", "left", "right"), "inside": ("inside_h", "inside_v")}.get(target, (target,))
    if any(name not in parts for name in names):
        raise StyleError(f"unknown border target {target}")
    out: list[tuple[str, int, int]] = []
    for name in names:
        out.extend(parts[name])
    return out


# ---------------------------------------------------------------------------------------------------------- the resolver
def options(style: dict[str, Any] | None, custom: dict[str, Any] | None = None) -> dict[str, Any]:
    """The preset, accent colour and the four switches a table ends up with (explicit values over the preset's defaults)."""
    style = dict(style or {})
    preset = style.get("preset", "default")
    base: dict[str, Any] = {}
    if isinstance(preset, str) and preset.startswith("custom:"):
        base = dict((custom or {}).get(preset[7:]) or {})
        preset = base.get("preset", "default")
    if preset not in PRESETS:
        preset = "default"
    flags = dict(PRESETS[preset]["defaults"])
    for source in (base, style):
        for key in OPTION_KEYS:
            if key in source:
                flags[key] = bool(source[key])
    accent = style.get("accent") or base.get("accent") or DEFAULT_ACCENT
    return {"preset": preset, "accent": accent, **flags}


def _derived(rule: dict[str, Any] | None, accent: str) -> dict[str, Any] | None:
    if not rule:
        return None
    return {"color": colour(rule["color"], accent), "width_pt": rule["width_pt"], "style": rule["style"]}


def resolve(block: dict[str, Any], custom: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Per cell (keyed ``"row,position in row"``): ``fill``, ``color``, ``bold`` and ``borders`` {top,bottom,left,right}."""
    table, ext = block["table"], block.get("extensions") or {}
    opt = options(ext.get(STYLE_KEY), custom)
    preset, accent = PRESETS[opt["preset"]], opt["accent"]
    grid = Grid(table)
    rows, cols = grid.n_rows, grid.columns
    header = min(table.get("header_rows", 0), rows) if opt["header_row"] else 0
    explicit = ext.get(BORDERS_KEY) or {}
    own_h, own_v = explicit.get("h", {}), explicit.get("v", {})
    rules = preset["borders"]

    def h_edge(line: int, column: int) -> dict[str, Any] | None:
        key = f"{line},{column}"
        if key in own_h:
            return own_h[key]
        if line == 0:
            rule = rules.get("top")
        elif line == rows:
            rule = rules.get("bottom")
        elif header and line == header:
            rule = rules.get("header_bottom", rules.get("inside_h"))
        else:
            rule = rules.get("inside_h")
        return _derived(rule, accent)

    def v_edge(row: int, line: int) -> dict[str, Any] | None:
        key = f"{row},{line}"
        if key in own_v:
            return own_v[key]
        rule = rules.get("left") if line == 0 else rules.get("right") if line == cols else rules.get("inside_v")
        return _derived(rule, accent)

    out: dict[str, dict[str, Any]] = {}
    for cell in grid.cells:
        r, c = cell.r, cell.c
        fill = text = None
        bold = False
        if r < header:
            role = preset["header"]
        elif opt["first_column"] and c == 0:
            role = preset["first_column"]
        else:
            role = {}
        fill, text, bold = colour(role.get("fill"), accent), colour(role.get("color"), accent), bool(role.get("bold"))
        if not role:
            body_row = r - header
            body_col = c - (1 if opt["first_column"] else 0)
            if opt["banded_rows"] and body_row % 2 == 1:
                fill = colour(preset["band_rows"].get("fill"), accent)
            elif opt["banded_columns"] and body_col >= 0 and body_col % 2 == 1:
                fill = colour(preset["band_columns"].get("fill"), accent)
        own = (ext.get(CELLS_KEY) or {}).get(cell.key or "", {})
        if own.get("background"):
            fill = own["background"].upper()
        out[cell.key or f"{r},{c}"] = {
            "fill": fill, "color": text, "bold": bold,
            "borders": {"top": h_edge(r, c), "bottom": h_edge(cell.bottom, c), "left": v_edge(r, c), "right": v_edge(r, cell.right)},
        }
    return out
