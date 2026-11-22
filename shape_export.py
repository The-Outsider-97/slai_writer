"""Deterministic shape-to-image export adapter for Documaster.

SLDC retains editable vector geometry in Writer's namespaced extensions. The
current external Documaster writers do not read those extensions. Until those
writers support native vector shapes, convert a *copy* to high-resolution
transparent PNG figures rather than silently dropping the objects.

This is an explicit RASTER FALLBACK for PDF, DOCX and other foreign formats.
Do not use the result as evidence of editable DOCX DrawingML or vector PDF.
"""
from __future__ import annotations

import io
import math
import os
from typing import Any

from .columns import SCRIPTURE_PROPS
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



def _paint_rich_text(canvas: Any, text: dict[str, Any],
                     x: float, y: float, width: float, height: float,
                     scale: float) -> None:
    """Render validated Writer text spans with bounded glyph-level layout.

    UTF-16 spans align with browser offsets, including non-BMP characters.
    All individual glyphs retain font size, style, underline and color.
    """
    from PIL import Image, ImageDraw
    chars = text.get("content", "")
    if not chars:
        return
    spans = [s for s in (text.get("spans") or []) if s.get("type") == "format"]
    per_char = text.get("per_char")          # text boxes: paragraph alignment, spacing and leading for each character
    valign = text.get("valign", "middle")
    styles: list[tuple[str, dict[str, Any]]] = []
    offset = 0
    for char in chars:
        style = {"align": None, "gap_pt": 0.0, "leading": 1.25,
                 "bold": text.get("bold", False), "italic": text.get("italic", False),
                 "color": text.get("color", "#101010"),
                 "font_size_pt": text.get("font_size_pt", 12), "underline": False,
                 "strike": False, "superscript": False, "subscript": False,
                 "background": None, "letter_spacing_pt": 0, "word_spacing_pt": 0}
        override = per_char[len(styles)] if per_char is not None and len(styles) < len(per_char) else {}
        style.update(override.get("base", {}))
        for span in spans:
            if span["start"] <= offset < span["end"]:
                for key in ("bold", "italic", "color", "font_size_pt", "underline",
                            "strike", "superscript", "subscript", "background",
                            "letter_spacing_pt", "word_spacing_pt"):
                    if key in span:
                        style[key] = span[key]
        style.update({k: v for k, v in override.items() if k != "base"})
        styles.append((char, style))
        offset += 2 if ord(char) > 0xffff else 1
    fonts: dict[tuple[int, bool, bool], Any] = {}
    def font_for(size: int, bold: bool, italic: bool) -> Any:
        key = size, bold, italic
        if key not in fonts:
            fonts[key] = _font(size, bold, italic)
        return fonts[key]

    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    def layout(factor: float) -> tuple[list[list[tuple[str, Any, dict[str, Any], float]]], list[dict[str, Any]], float]:
        lines: list[list[tuple[str, Any, dict[str, Any], float]]] = [[]]
        meta: list[dict[str, Any]] = [{"align": None, "gap": 0.0, "leading": 1.25}]
        current = 0.0
        for char, style in styles:
            if style.get("align"):
                meta[-1]["align"] = style["align"]
            meta[-1]["leading"] = max(meta[-1]["leading"] if lines[-1] else 0.0, float(style.get("leading", 1.25)))
            if char == "\n":
                meta[-1]["gap"] = float(style.get("gap_pt", 0)) * scale * 25.4 / 72 * factor
                lines.append([])
                meta.append({"align": None, "gap": 0.0, "leading": 1.25})
                current = 0
                continue
            modifier = .75 if style.get("superscript") or style.get("subscript") else 1
            pixel_size = max(5, round(float(style["font_size_pt"]) * modifier * scale * 25.4 / 72 * factor))
            font = font_for(pixel_size, bool(style["bold"]), bool(style["italic"]))
            advance = (float(draw.textlength(char, font=font))
                       + (float(style.get("letter_spacing_pt", 0))
                          + (float(style.get("word_spacing_pt", 0)) if char == " " else 0))
                          * scale * 25.4 / 72)
            if current > 0 and current + advance > width:
                carry: list[tuple[str, Any, dict[str, Any], float]] = []
                if char != " ":
                    # Break at the last space on the line rather than in the middle of a word.
                    cut = next((i for i in range(len(lines[-1]) - 1, 0, -1) if lines[-1][i][0] == " "), None)
                    if cut is not None:
                        carry = lines[-1][cut + 1:]
                        del lines[-1][cut + 1:]
                lines.append(carry)
                meta.append({"align": meta[-1]["align"], "gap": 0.0, "leading": float(style.get("leading", 1.25))})
                current = sum(item[3] for item in carry)
            lines[-1].append((char, font, style, advance))
            current += advance
        leading = sum(max([float(font.size) * meta[i]["leading"] for _, font, _, _ in line] + [12.0]) + meta[i]["gap"]
                      for i, line in enumerate(lines))
        return lines, meta, leading

    factor = 1.0
    lines, line_meta, total_height = layout(factor)
    if text.get("fit") == "shrink":
        for _ in range(24):
            if total_height <= height or factor <= .38:
                break
            factor *= .93
            lines, line_meta, total_height = layout(factor)
    spare = max(0, height - total_height)
    current_y = y + (0 if valign == "top" else spare if valign == "bottom" else spare / 2)
    default_align = text.get("align", "center")
    for line_index, line in enumerate(lines):
        align = line_meta[line_index]["align"] or default_align
        advance = sum(run[3] for run in line)
        current_x = x if align == "left" else x + max(0, width - advance) if align == "right" else x + max(0, (width - advance) / 2)
        lead = max([float(font.size) * line_meta[line_index]["leading"] for _, font, _, _ in line] + [12.0])
        for char, font, style, extent in line:
            if current_y + lead <= y + height + 1:
                inset = -font.size * .35 if style.get("superscript") else (
                    font.size * .18 if style.get("subscript") else 0)
                glyph_y = current_y + inset
                if style.get("background"):
                    draw.rectangle((current_x, current_y, current_x+extent, current_y+lead),
                                   fill=_rgba(style["background"], 1))
                draw.text((current_x, glyph_y), char, font=font, fill=_rgba(style["color"], 1))
                if style.get("underline"):
                    baseline = glyph_y + max(1, int(font.size * 1.04))
                    draw.line([(current_x, baseline), (current_x + extent, baseline)],
                              fill=_rgba(style["color"], 1), width=max(1, int(font.size / 14)))
                if style.get("strike"):
                    strike_y = glyph_y + font.size * .5
                    draw.line([(current_x, strike_y), (current_x+extent, strike_y)],
                              fill=_rgba(style["color"], 1), width=max(1,int(font.size/14)))
            current_x += extent
        current_y += lead + line_meta[line_index]["gap"]
    # Strict containment: external drawing cannot paint shape text outside
    # the conservative box. The editor signals and preflight warns of overflow.
    left, top, right, bottom = round(x), round(y), round(x + width), round(y + height)
    mask = Image.new("L", canvas.size)
    md = ImageDraw.Draw(mask)
    md.rectangle((left, top, right, bottom), fill=255)
    from PIL import ImageChops
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    canvas.alpha_composite(layer)

ROLE_SCALE = {"heading1": 1.8, "heading2": 1.45, "heading3": 1.2}      # the editor uses the same ratios (shape.ts TEXTBOX_ROLE_SCALE)


def resolve_paragraph_style(styles: dict[str, Any] | None, name: str | None) -> dict[str, Any]:
    """A named paragraph style with its ``based_on`` chain folded in, parent first (as the editor does)."""
    group = ((styles or {}).get("paragraph") or {}) if isinstance(styles, dict) else {}
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    current = name
    while current and current in group and current not in seen and isinstance(group[current], dict):
        seen.add(current)
        chain.insert(0, group[current])
        current = group[current].get("based_on")
    if not chain and name == "Scripture":                                # not yet defined in this document: the built-in definition, as the editor uses
        return dict(SCRIPTURE_PROPS)
    merged: dict[str, Any] = {}
    for item in chain:
        merged.update(item)
    return merged


def textbox_text(shape: dict[str, Any], styles: dict[str, Any] | None = None) -> dict[str, Any]:
    """The painter's input for a text box: one string, the format spans moved to its offsets, and what each character inherits."""
    text = shape["text"]
    box = shape["textbox"]
    base_size = float(text["font_size_pt"])
    pieces: list[str] = []
    spans: list[dict[str, Any]] = []
    per_char: list[dict[str, Any]] = []
    offset = 0                                                           # UTF-16 units, as the span offsets are
    number = 0
    for index, para in enumerate(box["paragraphs"]):
        named = resolve_paragraph_style(styles, para.get("style"))
        role = para.get("role", "normal")
        size = float(named.get("font_size_pt", base_size * ROLE_SCALE.get(role, 1)))
        base = {"font_size_pt": size,
                "bold": bool(named.get("bold", text["bold"] or role.startswith("heading"))),
                "italic": bool(named.get("italic", text["italic"] or role == "quote")),
                "color": named.get("color", text["color"]) if isinstance(named.get("color", text["color"]), str) else text["color"]}
        align = para.get("align") or named.get("align") or text["align"]
        align = "left" if align == "justify" else align
        gap = float(para.get("space_after_pt", named.get("space_after_pt", 4 if role != "normal" else 0)))
        leading = float(para.get("line_height", named.get("line_height", 1.25)))
        marker = ""
        if para.get("list") == "bullet":
            marker = "\u2022 "
        elif para.get("list") == "number":
            number += 1
            marker = f"{number}. "
        if para.get("list") != "number":
            number = 0
        line = marker + para["text"]
        shift = len(marker.encode("utf-16-le")) // 2
        for span in para.get("spans", []):
            spans.append({**span, "start": span["start"] + offset + shift, "end": span["end"] + offset + shift})
        last = index == len(box["paragraphs"]) - 1
        full = line if last else line + "\n"
        pieces.append(full)
        for _char in full:
            per_char.append({"base": base, "align": align, "gap_pt": gap, "leading": leading})
        offset += len((full).encode("utf-16-le")) // 2
    return {**text, "content": "".join(pieces), "spans": spans, "per_char": per_char,
            "valign": box.get("vertical_align", "top"), "fit": "keep"}


def render_shape_png(value: dict[str, Any], styles: dict[str, Any] | None = None) -> tuple[bytes, float]:
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
    # Bounded working memory: drop resolution for expensive layered shadows
    # instead of allocating multiple unbounded RGBA/filter intermediates.
    pixel_budget = max(1_500_000, 6_000_000 // (1 + len(shadows) // 2))
    scale = min(300 / 25.4, 4096 / max(ow, oh), (pixel_budget / (ow * oh)) ** .5)
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
            if outline["style"] == "double":
                # Two lines of the stated width with a gap of the same width between them.
                def inset(steps: int) -> Any:
                    return mask.filter(ImageFilter.MinFilter(min(151, width_px * 2 * steps + 1)))
                edge = ImageChops.add(edge, ImageChops.subtract(inset(2), inset(3)))
        edge = edge.point(lambda v: round(v * outline["opacity"]))
        layer = Image.new("RGBA", canvas.size, _rgba(outline["color"], 1))
        layer.putalpha(edge)
        canvas.alpha_composite(layer)

    # Mirror the vector silhouette and shadow layers before painting text;
    # ordinary Word shape text must remain legible, not rendered backwards.
    if shape.get("flip_horizontal") or shape.get("flip_vertical"):
        from PIL import ImageOps
        if shape.get("flip_horizontal"):
            canvas = ImageOps.mirror(canvas)
        if shape.get("flip_vertical"):
            canvas = ImageOps.flip(canvas)

    text = shape["text"]
    if shape.get("textbox"):
        text = textbox_text(shape, styles)
    if text["content"] and kind != "line":
        rx, ry, rw, rh = (0, 0, 1, 1) if shape.get("textbox") else _region(kind)
        padding = text["padding_mm"] * scale
        bx = x0 + pxw * rx + padding
        by = y0 + pxh * ry + padding
        bw = max(1, pxw * rw - 2 * padding)
        bh = max(1, pxh * rh - 2 * padding)
        _paint_rich_text(canvas, text, bx, by, bw, bh, scale)

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
        raw, display_width = render_shape_png(shape, getattr(package, "document", {}).get("styles"))
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
