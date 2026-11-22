"""The twelve table-of-contents looks, and the settings that go with them.

A look is made of ordinary Writer things, so nothing here is a second style engine:

* the paragraph styles ``TOC Title`` and ``TOC Level 1`` .. ``TOC Level 6`` (typeface, size, weight, colour, indent, spacing) in the document's ``styles``;
* the options stored on the table's title block in the namespaced extension ``slai.writer.toc_style``: ``preset``, ``leader``, ``page_align``,
  ``hyperlinks`` and ``numbered``, and the layout of an entry (where the page number goes and how it is aligned, the leader, the alignment of the text): ``page_position``,
  ``custom_tab_mm``, ``number_align``, ``number_column_mm``, ``leader_char``, ``leader_gap_pt`` and ``text_align``. (Showing page numbers and "leader" on/off stay in the
  native ``slai.sldc.toc`` extension every SLDC reader knows.) ``page_align`` is what older versions wrote; ``page_position`` is the full setting and wins when both are there.

The core ``slai.sldc.toc`` extension only knows three presets, so every look here also names the nearest of those (``core``) and writes that.
"""
from __future__ import annotations

from typing import Any

EXTENSION = "slai.writer.toc_style"
LEADERS = ("dots", "dashes", "solid", "custom", "none")
ALIGNS = ("right", "inline", "left")
POSITIONS = ("right", "left", "inline", "custom", "hidden")
LEGACY_POSITION = {"right": "right", "inline": "inline", "left": "left"}
NUMBER_ALIGNS = ("left", "center", "right")
TEXT_ALIGNS = ("left", "center", "right")
LEVEL_ALIGNS = ("left", "center", "right", "justify")
LOOK_KEYS = frozenset({"preset", "leader", "page_align", "page_position", "custom_tab_mm", "number_align", "number_column_mm", "leader_char", "leader_gap_pt", "text_align",
                       "hyperlinks", "numbered", "levels", "title"})
LEVEL_KEYS = frozenset({"font_family", "font_size_pt", "bold", "italic", "small_caps", "color", "indent_mm", "space_before_pt", "space_after_pt", "line_height", "align"})
TITLE_KEYS = frozenset({"font_family", "font_size_pt", "bold", "italic", "small_caps", "color", "align", "space_after_pt", "space_before_pt"})
ORDER = ["classic", "modern", "minimalist", "academic", "professional", "formal", "compact", "elegant", "technical", "book", "outline", "custom"]


def _levels(family: str, sizes: list[float], *, bold: list[bool], italic: list[bool] | None = None, indent: float, before: list[float], after: float,
            colour: list[str | None] | None = None, small_caps: list[bool] | None = None, line_height: float | None = None) -> list[dict[str, Any]]:
    out = []
    for n in range(6):
        level: dict[str, Any] = {"font_family": family, "font_size_pt": sizes[min(n, len(sizes) - 1)], "indent_mm": round(indent * n, 2),
                                 "space_before_pt": before[min(n, len(before) - 1)], "space_after_pt": after}
        if bold[min(n, len(bold) - 1)]:
            level["bold"] = True
        if italic and italic[min(n, len(italic) - 1)]:
            level["italic"] = True
        if small_caps and small_caps[min(n, len(small_caps) - 1)]:
            level["small_caps"] = True
        if colour and colour[min(n, len(colour) - 1)]:
            level["color"] = colour[min(n, len(colour) - 1)]
        if line_height:
            level["line_height"] = line_height
        out.append(level)
    return out


def _title(family: str, size: float, *, bold: bool = True, italic: bool = False, align: str = "left", colour: str | None = None, small_caps: bool = False,
           after: float = 12) -> dict[str, Any]:
    out: dict[str, Any] = {"font_family": family, "font_size_pt": size, "align": align, "space_after_pt": after}
    for key, on in (("bold", bold), ("italic", italic), ("small_caps", small_caps)):
        if on:
            out[key] = True
    if colour:
        out["color"] = colour
    return out


PRESETS: dict[str, dict[str, Any]] = {
    "classic": {
        "name": "Classic", "description": "Serif type, bold chapters, dotted leaders to the page number.", "core": "standard",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": _title("Times New Roman", 18),
        "levels": _levels("Times New Roman", [12, 11.5, 11], bold=[True, False], italic=[False, False, True], indent=6, before=[4, 0], after=3),
    },
    "modern": {
        "name": "Modern", "description": "Sans-serif with an accent colour for chapters; no leaders, page numbers on the right.", "core": "standard",
        "leader": "none", "page_align": "right", "numbered": False,
        "title": _title("Arial", 22, colour="#1f4e79", after=14),
        "levels": _levels("Arial", [11, 10.5, 10], bold=[True, False], indent=6, before=[8, 2], after=3, colour=["#1f4e79", None]),
    },
    "minimalist": {
        "name": "Minimalist", "description": "Small, quiet type in grey; nothing but the entries and their pages.", "core": "compact",
        "leader": "none", "page_align": "right", "numbered": False,
        "title": _title("Arial", 14, bold=False, colour="#444444", after=10),
        "levels": _levels("Arial", [10, 10, 9.5], bold=[False], indent=4, before=[3, 0], after=2, colour=["#222222", "#555555"]),
    },
    "academic": {
        "name": "Academic", "description": "Centred title, 12 pt serif, dotted leaders: for theses and papers.", "core": "academic",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": _title("Times New Roman", 16, align="center", after=14),
        "levels": _levels("Times New Roman", [12], bold=[True, False], italic=[False, False, True], indent=7, before=[5, 0], after=4, line_height=1.3),
    },
    "professional": {
        "name": "Professional Report", "description": "Georgia with small-capital chapters and a bold title: for business reports.", "core": "standard",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": _title("Georgia", 20, colour="#222222", after=14),
        "levels": _levels("Georgia", [11.5, 11, 10.5], bold=[True, False], indent=6, before=[8, 2], after=3, small_caps=[True, False]),
    },
    "formal": {
        "name": "Formal", "description": "Centred small-capital title, ruled leaders, generous spacing: for official documents.", "core": "academic",
        "leader": "solid", "page_align": "right", "numbered": False,
        "title": _title("Times New Roman", 16, align="center", small_caps=True, after=16),
        "levels": _levels("Times New Roman", [12], bold=[True, False], indent=8, before=[8, 3], after=5, small_caps=[True, False]),
    },
    "compact": {
        "name": "Compact", "description": "Small type with no space between entries: the most entries per page.", "core": "compact",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": _title("Arial", 12, after=6),
        "levels": _levels("Arial", [9, 9, 8.5], bold=[True, False], indent=3, before=[0], after=0),
    },
    "elegant": {
        "name": "Elegant", "description": "EB Garamond italic title, dashed leaders, airy spacing.", "core": "standard",
        "leader": "dashes", "page_align": "right", "numbered": False,
        "title": _title("EB Garamond", 24, bold=False, italic=True, align="center", after=18),
        "levels": _levels("EB Garamond", [13, 12, 12], bold=[False], italic=[True, False], indent=7, before=[8, 3], after=3),
    },
    "technical": {
        "name": "Technical Documentation", "description": "Numbered sections (1, 1.1, 1.1.1), dashed leaders, tight spacing.", "core": "compact",
        "leader": "dashes", "page_align": "right", "numbered": True,
        "title": _title("Arial", 16, after=10),
        "levels": _levels("Arial", [10.5, 10, 10], bold=[True, False], indent=6, before=[4, 0], after=1),
    },
    "book": {
        "name": "Book / Manuscript", "description": "Chapters set plain, sections indented, page numbers on the right.", "core": "academic",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": _title("Times New Roman", 20, bold=False, align="center", after=20),
        "levels": _levels("Times New Roman", [12], bold=[False], italic=[False, False, True], indent=10, before=[8, 0], after=2, line_height=1.35),
    },
    "outline": {
        "name": "Numbered Outline", "description": "Every entry numbered like an outline; the page number follows the title.", "core": "standard",
        "leader": "none", "page_align": "inline", "numbered": True,
        "title": _title("Arial", 16, after=10),
        "levels": _levels("Arial", [11, 10.5, 10], bold=[True, False], indent=8, before=[5, 1], after=2),
    },
    "custom": {
        "name": "Custom", "description": "Your own settings: change the options and the formatting of each level.", "core": "standard",
        "leader": "dots", "page_align": "right", "numbered": False,
        "title": None, "levels": None,
    },
}


def options() -> list[dict[str, Any]]:
    """What the gallery needs: ids in order with their name, description and the data of the look."""
    return [{"id": key, **{k: v for k, v in PRESETS[key].items()}} for key in ORDER]


def check_levels(levels: Any) -> dict[int, dict[str, Any]]:
    """``{"1": {...}, "2": {...}}`` -> ``{1: {...}}``, raising ValueError on anything the style engine would not take."""
    if levels is None:
        return {}
    if not isinstance(levels, dict):
        raise ValueError("Level formatting must be an object with a level number for each entry.")
    out: dict[int, dict[str, Any]] = {}
    for key, props in levels.items():
        try:
            n = int(key)
        except (TypeError, ValueError):
            raise ValueError("Level formatting is given per level number (1 to 6).") from None
        if not 1 <= n <= 6 or not isinstance(props, dict) or set(props) - LEVEL_KEYS:
            raise ValueError(f"Level {key} can only change: {', '.join(sorted(LEVEL_KEYS))}.")
        if "align" in props and props["align"] not in LEVEL_ALIGNS:
            raise ValueError(f"Level {key}: the text alignment is left, center, right or justify.")
        out[n] = dict(props)
    return out


def check_title(props: Any) -> dict[str, Any]:
    if props is None:
        return {}
    if not isinstance(props, dict) or set(props) - TITLE_KEYS:
        raise ValueError(f"The title can only change: {', '.join(sorted(TITLE_KEYS))}.")
    return dict(props)


def _number(value: Any, name: str, low: float, high: float) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(f"{name} is a number from {low:g} to {high:g}.")
    return float(value)


def check_layout(look: dict[str, Any]) -> dict[str, Any]:
    """The layout settings of an entry that the request carries, validated: ``{"page_position": "custom", "custom_tab_mm": 120.0, ...}``. A key left out is not changed;
    a key set to None clears it (the look's own default applies again)."""
    out: dict[str, Any] = {}
    position = look.get("page_position")
    if position is None and look.get("page_align") is not None:
        position = look["page_align"]
    if position is not None and position not in POSITIONS:
        raise ValueError("Page numbers go on the right, on the left, right after the title, at a tab stop of your own, or nowhere.")
    if "page_position" in look or "page_align" in look:
        out["page_position"] = position
    if "leader" in look and look["leader"] not in LEADERS:
        raise ValueError("Choose dots, dashes, a solid line, a character of your own or no leader.")
    for key, options, what in (("number_align", NUMBER_ALIGNS, "The page number is aligned left, center or right in its column."),
                               ("text_align", TEXT_ALIGNS, "The text of the entries is aligned left, center or right.")):
        if key in look:
            if look[key] is not None and look[key] not in options:
                raise ValueError(what)
            out[key] = look[key]
    for key, name, low, high in (("custom_tab_mm", "The tab stop of the page numbers", 0, 600), ("number_column_mm", "The width of the page-number column", 1, 100),
                                 ("leader_gap_pt", "The space between the marks of the leader", 0, 40)):
        if key in look:
            out[key] = _number(look[key], name, low, high)
    if "leader_char" in look:
        char = look["leader_char"]
        if char is not None and (not isinstance(char, str) or not 0 < len(char) <= 3 or not char.isprintable() or char.isspace()):
            raise ValueError("The leader character is one to three visible characters.")
        out["leader_char"] = char
    return out
