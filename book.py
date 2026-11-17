"""Book layout: mirrored margins, the binding gutter, and changing a page's margins for a chosen part of the document.

Where things live (nothing here is screen-only):

* The core SLDC fields stay what every reader understands: ``sections[i].page.margins_mm`` (top, right, bottom, left) and ``orientation``.
  In a section with mirrored margins ``left`` is the **inside** margin and ``right`` the **outside** margin *of a right-hand page* (page 1 of a
  book, and every odd page). A reader that does not know about book layout therefore shows the right-hand page's margins on every page, which is
  a faithful, readable page and loses nothing. The stored margins are never changed to carry the gutter or the page's side.
* What the core format has no field for lives in Writer's own document extension ``slai.writer.book_layouts`` (keyed by section id):
  ``mirror`` (true: the inside margin faces the spine, alternating page by page), ``gutter_mm`` (extra binding space, added to the inside margin,
  counted once) and ``gutter_position`` (``left`` is the default, ``right``, or ``top``; in a mirrored section the gutter is always on the inside,
  so only ``top`` is meaningful there). Readers that do not know the extension ignore and keep it.
* ``odd_even`` (true: left-hand pages, every even one, have their own header and footer) with ``header_even`` and ``footer_even``, each an object
  with ``left``, ``center`` and ``right`` text (the fields {page}, {pages} and {title} as in the core header). A left-hand page without its own text
  for a band uses the ordinary one, with its edges swapped in a mirrored section; the typography is that of the same position on the ordinary band.
  The ordinary header and footer stay the core SLDC ones, so a reader that does not know the extension shows them on every page.
* Which side a page is on depends on its position in the document, never on the number printed on it: physical page 1 is a right-hand page,
  page 2 a left-hand page, and so on. Page numbering that starts over or hides numbers changes the labels, not the sides.

One operation, ``page_layout``, changes margins, orientation, mirroring and the gutter together, for the whole document, one section, some
sections, or from a block to the end of the document, and it is one undo step. The arithmetic of margins for a given page lives in
:func:`effective_margins`; the PDF/DOCX/ODT/RTF writers (Documaster) and the editor use the same formulas, and the tests hold all three to the same cases.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any

from .columns import _ensure_sections, _read_layouts, group_members
from .opcore import HANDLERS, LABELS, OpError, Tracker, WRITER_EXT, handler

BOOKS = "book_layouts"
POSITIONS = ("left", "right", "top")
SCOPES = ("document", "section", "sections", "from_here")
MARGIN_KEYS = ("top", "right", "bottom", "left")
MIN_CONTENT_MM = 25.0
MAX_MARGIN_MM = 200.0
MAX_GUTTER_MM = 100.0
KEYS = {"mirror", "gutter_mm", "gutter_position", "mirror_edges", "odd_even", "header_even", "footer_even"}
TEMPLATE_KEYS = ("left", "center", "right")
TEMPLATE_TOKENS = ("{page}", "{pages}", "{title}")
MAX_TEMPLATE_CHARS = 500
SIDES = {"inside": "left", "outside": "right"}
PAGE_SIZES_MM = {"A3": (297.0, 420.0), "A4": (210.0, 297.0), "A5": (148.0, 210.0), "B5": (176.0, 250.0),
                 "Letter": (215.9, 279.4), "Legal": (215.9, 355.6), "Tabloid": (279.4, 431.8)}
DEFAULT_MARGIN_MM = 25.0


# ------------------------------------------------------------------------------------------------------------- arithmetic
def page_dims(page: dict[str, Any]) -> tuple[float, float]:
    """Width and height of a page in millimetres, as the editor and the writers read them."""
    if page.get("width_mm") and page.get("height_mm"):
        w, h = float(page["width_mm"]), float(page["height_mm"])
    else:
        w, h = PAGE_SIZES_MM.get(page.get("size") or "A4", PAGE_SIZES_MM["A4"])
    if page.get("orientation") == "landscape" and w < h:
        w, h = h, w
    return w, h


def effective_margins(page: dict[str, Any], book: dict[str, Any] | None, physical: int) -> dict[str, float]:
    """The margins a page really has: ``left`` and ``right`` are the physical sides of *that* page, the gutter included once.

    ``physical`` is the 1-based position of the page in the document (not its printed number)."""
    stored = page.get("margins_mm") or {}
    top = float(stored.get("top", DEFAULT_MARGIN_MM))
    bottom = float(stored.get("bottom", DEFAULT_MARGIN_MM))
    left = float(stored.get("left", DEFAULT_MARGIN_MM))
    right = float(stored.get("right", DEFAULT_MARGIN_MM))
    book = book or {}
    gutter = float(book.get("gutter_mm", 0) or 0)
    position = book.get("gutter_position", "left")
    if book.get("mirror") is True:
        inside, outside = left, right
        inside_with = inside + (gutter if position != "top" else 0.0)
        if physical % 2 == 1:
            left, right = inside_with, outside
        else:
            left, right = outside, inside_with
    elif position == "right":
        right += gutter
    elif position == "top":
        pass
    else:
        left += gutter
    if position == "top":
        top += gutter
    return {"top": top, "bottom": bottom, "left": left, "right": right}


def content_mm(page: dict[str, Any], book: dict[str, Any] | None) -> tuple[float, float]:
    """The width and height left for text. They are the same on every page of a section, whichever side the page is on."""
    w, h = page_dims(page)
    m = effective_margins(page, book, 1)
    return w - m["left"] - m["right"], h - m["top"] - m["bottom"]


# ------------------------------------------------------------------------------------------------------------- validation
def check_entry(entry: Any) -> None:
    if not isinstance(entry, dict):
        raise OpError("A book layout must be an object")
    unknown = set(entry) - KEYS
    if unknown:
        raise OpError(f"Unknown book layout setting: {sorted(unknown)[0]}")
    for key in ("mirror", "mirror_edges", "odd_even"):
        if key in entry and not isinstance(entry[key], bool):
            raise OpError(f"'{key}' must be true or false")
    for key in ("header_even", "footer_even"):
        if key in entry:
            check_template(entry[key], key)
    if "gutter_mm" in entry:
        value = entry["gutter_mm"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= MAX_GUTTER_MM:
            raise OpError(f"The gutter is 0 to {MAX_GUTTER_MM:g} mm")
    if "gutter_position" in entry:
        if entry["gutter_position"] not in POSITIONS:
            raise OpError("The gutter position is left, right or top")
        if entry.get("mirror") is True and entry["gutter_position"] == "right":
            raise OpError("In mirrored margins the gutter is on the inside of every page; choose left (the default) or top")


def check_template(value: Any, name: str) -> None:
    """The text of an even-page header or footer: three optional positions, each text of at most 500 characters using only the fields the format knows."""
    if not isinstance(value, dict):
        raise OpError(f"'{name}' must be an object with left, center and right text")
    extra = set(value) - set(TEMPLATE_KEYS)
    if extra:
        raise OpError(f"'{name}' has no '{sorted(extra)[0]}'; use left, center and right")
    for position, text in value.items():
        if not isinstance(text, str) or len(text) > MAX_TEMPLATE_CHARS:
            raise OpError(f"The {position} text of '{name}' must be text of at most {MAX_TEMPLATE_CHARS} characters")
        rest = text.replace("{{", "").replace("}}", "")
        for token in re.findall(r"\{[^{}]*\}", rest):
            if token not in TEMPLATE_TOKENS:
                raise OpError(f"The {position} text of '{name}' uses an unknown field {token}; use {{page}}, {{pages}} or {{title}}")
        if re.search(r"[{}]", re.sub(r"\{[^{}]*\}", "", rest)):
            raise OpError(f"The {position} text of '{name}' has an unmatched brace (write {{{{ or }}}} for a literal one)")


def _section_label(section: dict[str, Any]) -> str:
    return f"section '{section['id']}'"


def check_content(section: dict[str, Any], book: dict[str, Any] | None) -> None:
    width, height = content_mm(section.get("page") or {}, book)
    if width < MIN_CONTENT_MM or height < MIN_CONTENT_MM:
        raise OpError(f"The margins and the gutter leave less than {MIN_CONTENT_MM:g} mm for text in {_section_label(section)}. Make them smaller.")


def books_of(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return ((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get(BOOKS) or {}


def validate_document(doc: dict[str, Any]) -> None:
    """Called after every change: book layouts may only describe sections that exist, with values the formats can carry, and a text area that remains."""
    books = books_of(doc)
    if not books:
        raw = ((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get(BOOKS)
        if raw is not None and not isinstance(raw, dict):
            raise OpError("book_layouts must be an object")
        return
    sections = {s["id"]: s for s in doc.get("sections") or []}
    for sid, entry in books.items():
        if sid not in sections:
            raise OpError(f"A book layout belongs to section '{sid}', which does not exist")
        check_entry(entry)
        check_content(sections[sid], entry)


def reconcile(tr: Tracker) -> None:
    """Drop the layouts of sections that are gone, and say nothing (store nothing) for a section that has no book layout left."""
    mine = ((tr.doc.get("extensions") or {}).get(WRITER_EXT) or {})
    if not mine.get(BOOKS):
        return
    sections = list(tr.doc.get("sections") or [])
    books = copy.deepcopy(mine[BOOKS])
    live = {sid: entry for sid, entry in books.items() if entry and any(s["id"] == sid for s in sections)}
    if live != books:
        _write(tr, live)


def inherit(tr: Tracker, from_id: str, to_id: str) -> None:
    """A section that starts with a section break looks like the one before it, mirrored margins and gutter included."""
    books = _read(tr)
    if from_id in books:
        books[to_id] = copy.deepcopy(books[from_id])
        _write(tr, books)


# ------------------------------------------------------------------------------------------------------------- storage
def _read(tr: Tracker) -> dict[str, dict[str, Any]]:
    return copy.deepcopy(((tr.key("extensions") or {}).get(WRITER_EXT) or {}).get(BOOKS) or {})


def _write(tr: Tracker, books: dict[str, dict[str, Any]]) -> None:
    ext = copy.deepcopy(tr.key("extensions") or {})
    mine = ext.setdefault(WRITER_EXT, {})
    live = {sid: entry for sid, entry in books.items() if entry}
    if live:
        mine[BOOKS] = live
    else:
        mine.pop(BOOKS, None)
    if not mine:
        ext.pop(WRITER_EXT)
    if ext:
        tr.doc["extensions"] = ext
    else:
        tr.doc.pop("extensions", None)


def _normalise(entry: dict[str, Any]) -> dict[str, Any]:
    """The smallest entry that says the same thing: nothing for the defaults (not mirrored, no gutter, binding on the left)."""
    out = {k: v for k, v in entry.items() if k in KEYS}
    if out.get("mirror") is not True:
        out.pop("mirror", None)
        out.pop("mirror_edges", None)                           # it only means something in a mirrored section
    elif out.get("mirror_edges") is not False:
        out.pop("mirror_edges", None)                           # the default is to mirror them
    if out.get("odd_even") is not True:
        out.pop("odd_even", None)                              # the even-page texts belong to the setting: turning it off takes them with it (Undo brings them back)
        out.pop("header_even", None)
        out.pop("footer_even", None)
    else:
        for key in ("header_even", "footer_even"):
            if key in out:
                out[key] = {pos: text for pos, text in out[key].items() if text}
                if not out[key]:
                    out.pop(key)
    if not out.get("gutter_mm"):
        out.pop("gutter_mm", None)
        out.pop("gutter_position", None)                       # a position without a gutter says nothing
    elif out.get("gutter_position") == "left":
        out.pop("gutter_position")
    if isinstance(out.get("gutter_mm"), float):
        out["gutter_mm"] = round(out["gutter_mm"], 2)
    return out


# ------------------------------------------------------------------------------------------------------------- the operation
def _margin_values(op: dict[str, Any], mirror: bool) -> dict[str, float]:
    given = op.get("margins_mm")
    if given is None:
        return {}
    if not isinstance(given, dict):
        raise OpError("margins_mm must be an object")
    out: dict[str, float] = {}
    for key, value in given.items():
        stored = SIDES.get(key, key)
        if key in SIDES and not mirror:
            raise OpError("Inside and outside margins need mirrored margins; use left and right otherwise")
        if stored not in MARGIN_KEYS:
            raise OpError(f"Unknown margin '{key}'")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= MAX_MARGIN_MM:
            raise OpError(f"A margin is 0 to {MAX_MARGIN_MM:g} mm")
        if stored in out and out[stored] != float(value):
            raise OpError(f"The {stored} and {'inside' if stored == 'left' else 'outside'} margins are the same setting and were given different values")
        out[stored] = float(value)
    return out


def _targets(tr: Tracker, op: dict[str, Any], sections: list[dict[str, Any]]) -> list[str]:
    scope = op.get("scope", "section")
    if scope not in SCOPES:
        raise OpError(f"The scope is one of: {', '.join(SCOPES)}")
    known = [s["id"] for s in sections]
    if scope == "document":
        return known
    if scope == "section":
        sid = op.get("section") or known[0]
        if sid not in known:
            raise OpError(f"There is no section '{sid}'")
        return [sid]
    if scope == "sections":
        ids = op.get("sections")
        if not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids):
            raise OpError("Name the sections to change")
        missing = [i for i in ids if i not in known]
        if missing:
            raise OpError(f"There is no section '{missing[0]}'")
        return [i for i in known if i in ids]
    block = tr.get(op.get("block"))                                              # from_here
    sid = block.get("section") or known[0]
    members = [b for b in tr.doc["blocks"] if (b.get("section") or known[0]) == sid]
    if members and members[0]["id"] != block["id"]:                              # the change starts in the middle of a section: a new page starts here
        handler_result = HANDLERS["section_break"](tr, {"op": "section_break", "block": block["id"]})
        sections[:] = copy.deepcopy(tr.key("sections") or [])
        sid = handler_result["section"]
    known = [s["id"] for s in sections]
    return known[known.index(sid):]


@handler("page_layout")
def op_page_layout(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Margins, orientation, mirroring and the gutter, for the whole document, one section, some sections, or from a block to the end."""
    sections = _ensure_sections(tr)
    tr.doc["sections"] = sections
    targets = _targets(tr, op, sections)
    layouts = _read_layouts(tr)
    expanded: list[str] = []
    for sid in targets:                                                          # sections that continue on a page change with it
        for member in group_members(sections, layouts, sid):
            if member not in expanded:
                expanded.append(member)
    books = _read(tr)
    orientation = op.get("orientation")
    if orientation is not None and orientation not in ("portrait", "landscape"):
        raise OpError("Orientation is portrait or landscape")
    for key in KEYS:
        if key in op and op[key] is not None:
            check_entry({key: op[key]})
    changed: list[str] = []
    for sid in expanded:
        section = next(s for s in sections if s["id"] == sid)
        entry = copy.deepcopy(books.get(sid, {}))
        for key in KEYS:
            if key in op:
                if op[key] is None:
                    entry.pop(key, None)
                else:
                    entry[key] = op[key]
        if entry.get("mirror") is True and entry.get("gutter_position") == "right":
            entry["gutter_position"] = "left"                                     # in a book the gutter is on the inside; left is its default name
        if any(op.get(k) for k in ("header_even", "footer_even")) and entry.get("odd_even") is not True:
            raise OpError("Turn on different odd and even pages before giving the even pages their own header or footer")
        entry = _normalise(entry)
        check_entry(entry)
        page = copy.deepcopy(section.get("page") or {})
        values = _margin_values(op, entry.get("mirror") is True)
        if values:
            page["margins_mm"] = {**{k: DEFAULT_MARGIN_MM for k in MARGIN_KEYS}, **(page.get("margins_mm") or {}), **values}
        if orientation is not None:
            if page.get("width_mm") and page.get("height_mm"):
                w, h = float(page["width_mm"]), float(page["height_mm"])
                page["width_mm"], page["height_mm"] = (max(w, h), min(w, h)) if orientation == "landscape" else (min(w, h), max(w, h))
            page["orientation"] = orientation
        section["page"] = page
        check_content(section, entry)
        if entry:
            books[sid] = entry
        else:
            books.pop(sid, None)
        changed.append(sid)
    tr.doc["sections"] = sections
    _write(tr, books)
    if sections and any(not b.get("section") for b in tr.doc["blocks"]):
        for block in tr.doc["blocks"]:
            if not block.get("section"):
                tr.get(block["id"])["section"] = sections[0]["id"]
    return {"sections": changed}


LABELS.update({"page_layout": "margins"})
