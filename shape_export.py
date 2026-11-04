"""Deterministic shape-to-image export adapter for Documaster.

SLDC retains editable vector geometry in Writer's namespaced extensions. The
current external Documaster writers do not read those extensions. Until those
writers support native vector shapes, convert a *copy* to high-resolution
transparent PNG figures rather than silently dropping the objects.

This is an explicit RASTER FALLBACK for PDF, DOCX and other foreign formats.
Do not use the result as evidence of editable DOCX DrawingML or vector PDF.
"""
from __future__ import annotations

import copy
import io
import math
from typing import Any

from .shape_validation import SHAPE_KEY, validate_shape


def _region(kind: str) -> tuple[float, float, float, float]:
    return {
        "rectangle": (.05, .07, .9, .86), "ellipse": (.18, .18, .64, .64),
        "triangle": (.35, .48, .30, .44), "diamond": (.28, .28, .44, .44),
        "pentagon": (.24, .34, .52, .50), "hexagon": (.2, .18, .6, .64),
        "star": (.33, .37, .34, .27), "arrow": (.10, .36, .48, .28),
        "plus": (.09, .37, .82, .26), "line": (0, 0, 0, 0),
    }[kind]


def _vertices(kind: str) -> list[tuple[float, float]]:
    if kind == "triangle":
        return [(50, 0), (100, 100), (0, 100)]
    if kind == "diamond":
        return [(50, 0), (100, 50), (50, 100), (0, 50)]
    if kind == "arrow":
        return [(0, 30), (62, 30), (62, 5), (100, 50),
                (62, 95), (62, 70), (0, 70)]
    if kind == "plus":
        return [(35, 0), (65, 0), (65, 35), (100, 35), (100, 65),
                (65, 65), (65, 100), (35, 100), (35, 65), (0, 65),
                (0, 35), (35, 35)]
    if kind == "star":
        return [(50 + (22 if i % 2 else 50) * math.cos(-math.pi / 2 + i * math.pi / 5),
                 50 + (22 if i % 2 else 50) * math.sin(-math.pi / 2 + i * math.pi / 5))
                for i in range(10)]
    n = 5 if kind == "pentagon" else 6
    return [(50 + 50 * math.cos(-math.pi / 2 + i * 2 * math.pi / n),
             50 + 50 * math.sin(-math.pi / 2 + i * 2 * math.pi / n))
            for i in range(n)]


def _font(size: int, bold: bool = False, italic: bool = False) -> Any:
    from PIL import ImageFont
    import os
    names = (["DejaVuSans-BoldOblique.ttf", "DejaVuSans-Bold.ttf"] if bold and italic
             else ["DejaVuSans-Bold.ttf"] if bold
             else ["DejaVuSans-Oblique.ttf"] if italic else ["DejaVuSans.ttf"])
    candidates = names + [
        "/usr/share/fonts/truetype/dejavu/" + names[0],
        os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", "arial.ttf"),
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def _rgba(color: str, alpha: float) -> tuple[int, int, int, int]:
    return (int(color[1:3], 16), int(color[3:5], 16),
            int(color[5:7], 16), max(0, min(255, round(255 * alpha))))


def render_shape_png(value: dict[str, Any]) -> tuple[bytes, float]:
    """Return transparent PNG and its accurate full painted width in millimetres.

    Raster resolution is bounded by a 14 MP pixel budget. Rotations and effects
    enlarge the output box so they are not cropped; expensive inputs are limited.
    """
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
    shape = validate_shape(value)
    w, h = shape["width_mm"], shape["height_mm"]
    shadows = shape["shadows"]
    spread = max([abs(s["spread_mm"]) + s["blur_mm"] * 3 for s in shadows] + [0]) + 3
    left = spread + max([max(0, -s["offset_x_mm"]) for s in shadows] + [0])
    right = spread + max([max(0, s["offset_x_mm"]) for s in shadows] + [0])
    top = spread + max([max(0, -s["offset_y_mm"]) for s in shadows] + [0])
    bottom = spread + max([max(0, s["offset_y_mm"]) for s in shadows] + [0])
    ow, oh = w + left + right, h + top + bottom
    scale = min(300 / 25.4, 4096 / max(ow, oh), (14_000_000 / (ow * oh)) ** .5)
    pxw, pxh = max(1, round(w * scale)), max(1, round(h * scale))
    fullw, fullh = max(1, round(ow * scale)), max(1, round(oh * scale))
    x0, y0 = round(left * scale), round(top * scale)
    bounds = (x0, y0, x0 + pxw - 1, y0 + pxh - 1)

    mask = Image.new("L", (fullw, fullh))
    draw = ImageDraw.Draw(mask)
    kind = shape["kind"]
    def pt(point: tuple[float, float]) -> tuple[float, float]:
        return x0 + point[0] * pxw / 100, y0 + point[1] * pxh / 100
    if kind == "ellipse":
        draw.ellipse(bounds, fill=255)
    elif kind == "rectangle":
        draw.rectangle(bounds, fill=255)
        # Remove corner squares and restore circular arcs independently.
        for (index, corner) in enumerate(((x0, y0, 180, 270),
                                          (x0 + pxw, y0, 270, 360),
                                          (x0 + pxw, y0 + pxh, 0, 90),
                                          (x0, y0 + pxh, 90, 180))):
            radius = round(shape["corners_mm"][index] * scale)
            if radius <= 0:
                continue
            cx, cy, a, b = corner
            if index == 0:
                sq = (cx, cy, cx + radius, cy + radius)
                arc = (cx, cy, cx + 2 * radius, cy + 2 * radius)
            elif index == 1:
                sq = (cx - radius, cy, cx, cy + radius)
                arc = (cx - 2 * radius, cy, cx, cy + 2 * radius)
            elif index == 2:
                sq = (cx - radius, cy - radius, cx, cy)
                arc = (cx - 2 * radius, cy - 2 * radius, cx, cy)
            else:
                sq = (cx, cy - radius, cx + radius, cy)
                arc = (cx, cy - 2 * radius, cx + 2 * radius, cy)
            draw.rectangle(sq, fill=0)
            draw.pieslice(arc, a, b, fill=255)
    elif kind == "line":
        draw.line([(x0, y0 + pxh / 2), (x0 + pxw, y0 + pxh / 2)],
                  fill=255, width=max(1, round(shape["outline"]["width_pt"] * 25.4 / 72 * scale)))
    else:
        draw.polygon([pt(p) for p in _vertices(kind)], fill=255)

    canvas = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    for shadow in reversed(shadows):
        if not shadow["enabled"]:
            continue
        sm = mask.copy()
        spread_px = round(shadow["spread_mm"] * scale)
        if spread_px:
            kernel = min(151, abs(spread_px) * 2 + 1)
            if kernel % 2 == 0:
                kernel -= 1
            sm = sm.filter(ImageFilter.MaxFilter(kernel) if spread_px > 0
                           else ImageFilter.MinFilter(kernel))
        if shadow["blur_mm"]:
            sm = sm.filter(ImageFilter.GaussianBlur(shadow["blur_mm"] * scale))
        shifted = Image.new("L", sm.size)
        dx, dy = round(shadow["offset_x_mm"] * scale), round(shadow["offset_y_mm"] * scale)
        shifted.paste(sm, (dx, dy))
        shifted = shifted.point(lambda v: round(v * shadow["opacity"]))
        layer = Image.new("RGBA", canvas.size, _rgba(shadow["color"], 1))
        layer.putalpha(shifted)
        canvas.alpha_composite(layer)

    fill = shape["fill"]
    if fill["enabled"] and kind != "line":
        m = mask.point(lambda v: round(v * fill["opacity"]))
        layer = Image.new("RGBA", canvas.size, _rgba(fill["color"], 1))
        layer.putalpha(m)
        canvas.alpha_composite(layer)
    outline = shape["outline"]
    if outline["enabled"]:
        if kind == "line":
            edge = mask
        else:
            width_px = max(1, round(outline["width_pt"] * scale * 25.4 / 72))
            kernel = min(151, width_px * 2 + 1)
            eroded = mask.filter(ImageFilter.MinFilter(kernel))
            edge = ImageChops.subtract(mask, eroded)
        edge = edge.point(lambda v: round(v * outline["opacity"]))
        layer = Image.new("RGBA", canvas.size, _rgba(outline["color"], 1))
        layer.putalpha(edge)
        canvas.alpha_composite(layer)

    text = shape["text"]
    if text["content"] and kind != "line":
        rx, ry, rw, rh = _region(kind)
        padding = text["padding_mm"] * scale
        bx = x0 + pxw * rx + padding
        by = y0 + pxh * ry + padding
        bw = max(1, pxw * rw - 2 * padding)
        bh = max(1, pxh * rh - 2 * padding)
        font_size = max(5, round(text["font_size_pt"] * scale * 25.4 / 72))
        font = _font(font_size, text["bold"], text["italic"])
        drawer = ImageDraw.Draw(canvas)
        lines: list[str] = []
        for paragraph in text["content"].split("\n"):
            words = paragraph.split(" ")
            line = ""
            for word in words:
                nxt = (line + " " + word).strip() if line else word
                if line and drawer.textlength(nxt, font=font) > bw:
                    lines.append(line)
                    line = word
                else:
                    line = nxt
            lines.append(line)
        def height_for(f: Any) -> int:
            return sum(drawer.textbbox((0, 0), line or "M", font=f)[3] -
                       drawer.textbbox((0, 0), line or "M", font=f)[1] + 3
                       for line in lines)
        if text.get("fit") == "shrink":
            while font_size > 5 and (height_for(font) > bh or
                  any(drawer.textlength(line, font=font) > bw for line in lines)):
                font_size -= 1
                font = _font(font_size, text["bold"], text["italic"])
        total_h = height_for(font)
        cy = by + max(0, (bh - total_h) / 2)
        ink = _rgba(text["color"], 1)
        for line in lines:
            width = drawer.textlength(line, font=font)
            xx = bx if text["align"] == "left" else bx + bw - width if text["align"] == "right" else bx + (bw - width) / 2
            drawer.text((xx, cy), line, font=font, fill=ink)
            bbox = drawer.textbbox((0, 0), line or "M", font=font)
            cy += bbox[3] - bbox[1] + 3

    if shape["opacity"] < 1:
        canvas.putalpha(canvas.getchannel("A").point(lambda v: round(v * shape["opacity"])))
    rotation = shape["rotation_deg"]
    if rotation:
        canvas = canvas.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)
    buf = io.BytesIO()
    canvas.save(buf, "PNG", optimize=True)
    return buf.getvalue(), canvas.width / scale


def prepare_shapes(package: Any, fmt: str, sldc: Any) -> tuple[Any, list[str]]:
    """Return a separate package where shape blocks become exportable figures.

    Native SLDC is unchanged. Plain text formats receive a textual description.
    The original package remains byte-for-byte untouched.
    """
    source = package.document["blocks"]
    shapes = [(b, b.get("extensions", {}).get(SHAPE_KEY)) for b in source]
    shapes = [(b, validate_shape(s)) for b, s in shapes if s is not None]
    if not shapes:
        return package, []
    output = package.copy()
    warnings = []
    if fmt in ("txt", "md", "xml"):
        for block in output.document["blocks"]:
            shape = block.get("extensions", {}).get(SHAPE_KEY)
            if shape is not None:
                block["text"] = f"[{shape['kind']} shape: {shape['text']['content']}]"
                block.pop("extensions", None)
        return output, ["Vector shapes exported as text descriptions; geometry, effects and editability are not preserved."]
    for block in output.document["blocks"]:
        shape = block.get("extensions", {}).get(SHAPE_KEY)
        if shape is None:
            continue
        raw, display_width = render_shape_png(shape)
        asset = sldc.make_asset(raw)
        output.assets[asset.id] = asset
        block["type"] = "figure"
        block["text"] = ""
        block["figure"] = {
            "asset": asset.id, "alt": f"{shape['kind']} shape. {shape['text']['content']}".strip()[:2000],
            "width_mm": min(display_width, 5000), "align": "center",
        }
        block.pop("extensions", None)
    warnings.append(
        f"{len(shapes)} editable vector shape(s) rendered as high-resolution PNG for {fmt.upper()}. "
        "Foreign-format copies preserve visual content, NOT editable geometry, native shape text or "
        "precise vector effects. Keep the SLDC source.")
    return output, warnings
