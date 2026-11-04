"""Validated, data-only vector-shape extension for SLDC 1.x Writer blocks.

The extension is attached to a dedicated empty paragraph block rather than
adding an unrecognized SLDC block kind. Readers without shape support retain
the inert extension, but cannot claim that they render it. No SVG/HTML is
accepted from the document; the browser constructs geometry from known kinds.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any

from .ops import OpError  # Imported lazily by ops handlers; no imports of this module at ops load time.

SHAPE_KEY = "slai.writer.shape"
SHAPE_KINDS = frozenset({"rectangle", "ellipse", "line", "triangle", "diamond",
                         "pentagon", "hexagon", "star", "arrow", "plus"})
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_ALLOWED = frozenset({"version", "kind", "width_mm", "height_mm", "rotation_deg", "fill",
                       "outline", "opacity", "corners_mm", "text", "shadows"})


def _object(value: Any, name: str, keys: set[str] | frozenset[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpError(f"{name} must be an object")
    if set(value) - keys:
        raise OpError(f"{name} contains unsupported fields")
    return value


def _num(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise OpError(f"{name} must be a finite number")
    if not low <= value <= high:
        raise OpError(f"{name} must be between {low} and {high}")
    return float(value)


def _color(value: Any, name: str) -> None:
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        raise OpError(f"{name} must be #RRGGBB")


def _bool(value: Any, name: str) -> None:
    if not isinstance(value, bool):
        raise OpError(f"{name} must be boolean")


def validate_shape(value: Any) -> dict[str, Any]:
    """Validate a full replacement atomically, then return an independent copy."""
    shape = _object(value, "shape", _ALLOWED)
    if shape.get("version") != 1 or type(shape.get("version")) is not int:
        raise OpError("Unsupported vector shape schema version")
    kind = shape.get("kind")
    if kind not in SHAPE_KINDS:
        raise OpError("Unsupported vector shape kind")
    w = _num(shape.get("width_mm"), "width_mm", 2, 1000)
    h = _num(shape.get("height_mm"), "height_mm", 2, 1000)
    _num(shape.get("rotation_deg"), "rotation_deg", -360, 360)
    _num(shape.get("opacity"), "opacity", 0, 1)

    fill = _object(shape.get("fill"), "fill", {"color", "opacity", "enabled"})
    _color(fill.get("color"), "fill.color")
    _num(fill.get("opacity"), "fill.opacity", 0, 1)
    _bool(fill.get("enabled"), "fill.enabled")

    outline = _object(shape.get("outline"), "outline",
                      {"color", "opacity", "enabled", "width_pt", "style"})
    _color(outline.get("color"), "outline.color")
    _num(outline.get("opacity"), "outline.opacity", 0, 1)
    _num(outline.get("width_pt"), "outline.width_pt", 0.1, 72)
    _bool(outline.get("enabled"), "outline.enabled")
    if outline.get("style") not in ("solid", "dashed", "dotted"):
        raise OpError("Unsupported outline style")

    corners = shape.get("corners_mm")
    if not isinstance(corners, list) or len(corners) != 4:
        raise OpError("corners_mm needs four corner radii")
    if kind != "rectangle" and any(corners):
        raise OpError("Corner radii are currently supported for rectangles only")
    for index, radius in enumerate(corners):
        _num(radius, f"corners_mm[{index}]", 0, min(w, h) / 2)
    if corners[0] + corners[1] > w or corners[3] + corners[2] > w \
            or corners[0] + corners[3] > h or corners[1] + corners[2] > h:
        raise OpError("Corner radii overlap")

    text = _object(shape.get("text"), "text",
                   {"content", "color", "font_size_pt", "bold", "italic", "align", "padding_mm"})
    if not isinstance(text.get("content"), str) or len(text["content"]) > 4000:
        raise OpError("Shape text must be at most 4000 characters")
    _color(text.get("color"), "text.color")
    _num(text.get("font_size_pt"), "text.font_size_pt", 5, 144)
    _num(text.get("padding_mm"), "text.padding_mm", 0, min(w, h) / 4)
    _bool(text.get("bold"), "text.bold")
    _bool(text.get("italic"), "text.italic")
    if text.get("align") not in ("left", "center", "right"):
        raise OpError("Unsupported text alignment")

    shadows = shape.get("shadows")
    if not isinstance(shadows, list) or len(shadows) > 8:
        raise OpError("A shape can have at most eight shadow layers")
    for i, entry in enumerate(shadows):
        sh = _object(entry, f"shadows[{i}]",
                     {"color", "opacity", "offset_x_mm", "offset_y_mm",
                      "blur_mm", "spread_mm", "enabled"})
        _color(sh.get("color"), f"shadows[{i}].color")
        _num(sh.get("opacity"), f"shadows[{i}].opacity", 0, 1)
        _num(sh.get("offset_x_mm"), f"shadows[{i}].offset_x_mm", -100, 100)
        _num(sh.get("offset_y_mm"), f"shadows[{i}].offset_y_mm", -100, 100)
        _num(sh.get("blur_mm"), f"shadows[{i}].blur_mm", 0, 30)
        _num(sh.get("spread_mm"), f"shadows[{i}].spread_mm", -20, 30)
        _bool(sh.get("enabled"), f"shadows[{i}].enabled")

    return copy.deepcopy(shape)
