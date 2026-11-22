"""Shapes in headers and footers.

A header or footer is a definition that every page using it repeats; the shapes of that definition belong to it, not to any page and not to the body. They are
stored in Writer's own document extension ``slai.writer.band_shapes``, keyed by section id (readers that do not know it keep it and show the text of the bands as
before)::

    {"<section>": {"header": {"default": [item, ...], "even": [...], "first": [...]}, "footer": {...},
                   "first_page": true,                      # the section's first page has its own shapes ("first")
                   "link": {"header": true, "footer": false}}}   # true: this section's band is the previous section's (it has none of its own)

An item is ``{"id", "shape", "x_mm", "y_mm", "layer", "locked", "span"}``. ``shape`` is exactly what a body shape is (``slai.writer.shape``, validated by
:func:`shape_validation.validate_shape`, without ``layout``: a band shape is placed by its band). Where it goes on a page:

* ``x_mm`` is measured from the left edge of the text frame of *that page* (so changing margins, page size or the mirroring of the document moves it with the frame);
  with ``span`` the shape is as wide as the frame and ``x_mm`` is ignored. On the left-hand pages of a mirrored section whose edges are swapped, ``x_mm`` is measured
  from the frame's right edge instead (the way the page number and the running text swap).
* ``y_mm`` is the distance from the top of the page to the top of the shape in a header, and from the bottom of the page to the bottom of the shape in a footer.
* ``layer`` is ``behind`` or ``front`` of the text of the page. The order of the list is the order of drawing within a layer.

Which pages show which list is decided by :func:`variant_for`; the arithmetic of where a shape is drawn is :func:`place`, shared by the editor (a TypeScript
port tied to this by a golden file) and by the PDF and Word writers of Documaster. Every change is one ordinary Writer operation: one undo step, saved with the document.
"""
from __future__ import annotations

import copy
import math
import secrets
from typing import Any

from .columns import _ensure_sections
from .opcore import LABELS, OpError, Tracker, WRITER_EXT, handler
from .shape_validation import validate_shape

KEY = "band_shapes"
EDGES = ("header", "footer")
VARIANTS = ("default", "even", "first")
LAYERS = ("behind", "front")
MAX_ITEMS = 40
ITEM_KEYS = {"id", "shape", "x_mm", "y_mm", "layer", "locked", "span", "name"}
ORDERS = ("front", "back", "forward", "backward")


def _num(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise OpError(f"{name} must be a number from {low:g} to {high:g}")
    return float(value)


def check_item(raw: Any) -> dict[str, Any]:
    """One shape of a band, validated and returned as an independent copy."""
    if not isinstance(raw, dict) or set(raw) - ITEM_KEYS:
        raise OpError("A header or footer shape has: " + ", ".join(sorted(ITEM_KEYS)))
    ident = raw.get("id")
    if not isinstance(ident, str) or not 1 <= len(ident) <= 64 or not ident.replace("_", "").replace("-", "").isalnum():
        raise OpError("A header or footer shape needs an id of letters, digits, - and _")
    shape = copy.deepcopy(raw.get("shape"))
    if isinstance(shape, dict):
        shape.pop("layout", None)
        shape.pop("group_id", None)
    out = {"id": ident, "shape": validate_shape(shape), "x_mm": _num(raw.get("x_mm", 0), "x_mm", -1000, 3000), "y_mm": _num(raw.get("y_mm", 0), "y_mm", -1000, 3000),
           "layer": raw.get("layer", "front"), "locked": raw.get("locked", False), "span": raw.get("span", False)}
    if out["layer"] not in LAYERS:
        raise OpError("A header or footer shape is behind or in front of the text")
    for key in ("locked", "span"):
        if type(out[key]) is not bool:
            raise OpError(f"{key} must be true or false")
    if "name" in raw:
        if not isinstance(raw["name"], str) or not 1 <= len(raw["name"]) <= 80 or any(ord(c) < 32 for c in raw["name"]):
            raise OpError("The name of a shape is 1 to 80 printable characters")
        out["name"] = raw["name"]
    return out


def check_entry(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict) or set(entry) - {"header", "footer", "first_page", "link"}:
        raise OpError("The shapes of a section have: header, footer, first_page, link")
    out: dict[str, Any] = {}
    seen: set[str] = set()
    for edge in EDGES:
        if edge not in entry:
            continue
        bands = entry[edge]
        if not isinstance(bands, dict) or set(bands) - set(VARIANTS):
            raise OpError(f"The {edge} has shapes for: {', '.join(VARIANTS)}")
        clean: dict[str, list[dict[str, Any]]] = {}
        for variant, items in bands.items():
            if not isinstance(items, list) or len(items) > MAX_ITEMS:
                raise OpError(f"A {edge} holds at most {MAX_ITEMS} shapes")
            checked = [check_item(i) for i in items]
            for item in checked:
                if item["id"] in seen:
                    raise OpError(f"The shape id {item['id']!r} is used twice in this section")
                seen.add(item["id"])
            if checked:
                clean[variant] = checked
        if clean:
            out[edge] = clean
    if "first_page" in entry:
        if type(entry["first_page"]) is not bool:
            raise OpError("first_page must be true or false")
        if entry["first_page"]:
            out["first_page"] = True
    if "link" in entry:
        link = entry["link"]
        if not isinstance(link, dict) or set(link) - set(EDGES) or any(type(v) is not bool for v in link.values()):
            raise OpError("link says, for the header and the footer, whether they are the previous section's")
        link = {k: True for k, v in link.items() if v}
        if link:
            out["link"] = link
    return out


# --------------------------------------------------------------------------------------------------------------------------- reading
def store_of(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return ((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get(KEY) or {}


def owner(doc: dict[str, Any], section_id: str, edge: str) -> str:
    """The section whose definition of ``edge`` this section shows: itself, or, while it is linked to the previous one, whoever that one shows."""
    sections = [s["id"] for s in doc.get("sections") or []]
    store = store_of(doc)
    at = sections.index(section_id) if section_id in sections else 0
    while at > 0 and (store.get(sections[at]) or {}).get("link", {}).get(edge):
        at -= 1
    return sections[at] if sections else section_id


def items_of(doc: dict[str, Any], section_id: str, edge: str, variant: str) -> list[dict[str, Any]]:
    return list((((store_of(doc).get(owner(doc, section_id, edge)) or {}).get(edge) or {}).get(variant)) or [])


def variant_for(doc: dict[str, Any], section_id: str, physical: int, first_of_section: bool) -> str:
    """Which list a page shows: the section's first page its own (when asked for), a left-hand page its own when the section has odd and even pages and gave it one."""
    entry = store_of(doc).get(section_id) or {}
    if entry.get("first_page") and first_of_section:
        return "first"
    book = ((((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get("book_layouts")) or {}).get(section_id) or {}
    if physical % 2 == 0 and book.get("odd_even") is True:
        return "even"
    return "default"


def shapes_for_page(doc: dict[str, Any], section_id: str, edge: str, physical: int, first_of_section: bool) -> tuple[list[dict[str, Any]], str, bool]:
    """The shapes a page shows in its header or footer, the variant they come from, and whether the page mirrors them (a left-hand page of a book whose
    edges are swapped: it has no list of its own, so it shows the ordinary one, from the other side)."""
    variant = variant_for(doc, section_id, physical, first_of_section)
    items = items_of(doc, section_id, edge, variant)
    book = ((((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get("book_layouts")) or {}).get(section_id) or {}
    mirrored = False
    if variant == "even" and not items:
        variant, items = "default", items_of(doc, section_id, edge, "default")
    if physical % 2 == 0 and variant == "default" and book.get("mirror") is True and book.get("mirror_edges") is not False:
        mirrored = True
    return items, variant, mirrored


def place(item: dict[str, Any], edge: str, page_w: float, page_h: float, left: float, right: float, mirrored: bool = False) -> dict[str, float]:
    """Where a shape's box is on its page, in millimetres from the top-left corner of the page: ``{"x", "y", "w", "h"}`` (the unrotated box; the shape turns about its centre)."""
    shape = item["shape"]
    frame = page_w - left - right
    h = float(shape["height_mm"])
    if item.get("span"):
        w, x = frame, left
    else:
        w = float(shape["width_mm"])
        x = left + frame - float(item["x_mm"]) - w if mirrored else left + float(item["x_mm"])
    y = float(item["y_mm"]) if edge == "header" else page_h - float(item["y_mm"]) - h
    return {"x": x, "y": y, "w": w, "h": h}


# -------------------------------------------------------------------------------------------------------------------------- the store
def _read(tr: Tracker) -> dict[str, dict[str, Any]]:
    return copy.deepcopy(((tr.key("extensions") or {}).get(WRITER_EXT) or {}).get(KEY) or {})


def _write(tr: Tracker, store: dict[str, dict[str, Any]]) -> None:
    ext = copy.deepcopy(tr.key("extensions") or {})
    mine = ext.setdefault(WRITER_EXT, {})
    live = {sid: entry for sid, entry in store.items() if entry}
    if live:
        mine[KEY] = live
    else:
        mine.pop(KEY, None)
    if not mine:
        ext.pop(WRITER_EXT)
    if ext:
        tr.doc["extensions"] = ext
    else:
        tr.doc.pop("extensions", None)


def validate_document(doc: dict[str, Any]) -> None:
    raw = ((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get(KEY)
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise OpError("band_shapes must be an object")
    known = {s["id"] for s in doc.get("sections") or []}
    for sid, entry in raw.items():
        if sid not in known:
            raise OpError(f"Header and footer shapes belong to section '{sid}', which does not exist")
        check_entry(entry)


def reconcile(tr: Tracker) -> None:
    """Shapes of a section that is gone go with it; a section after it that was linked to it is linked to the one before."""
    mine = ((tr.doc.get("extensions") or {}).get(WRITER_EXT) or {})
    if not mine.get(KEY):
        return
    known = [s["id"] for s in tr.doc.get("sections") or []]
    store = _read(tr)
    live = {sid: entry for sid, entry in store.items() if sid in known}
    if live != store:
        _write(tr, live)


# ------------------------------------------------------------------------------------------------------------------------ operations
def _target(tr: Tracker, op: dict[str, Any], *, edge_needed: bool = True) -> tuple[str, str, str]:
    sections = _ensure_sections(tr)
    tr.doc["sections"] = sections
    known = [s["id"] for s in sections]
    sid = op.get("section") or known[0]
    if sid not in known:
        raise OpError(f"There is no section '{sid}'")
    edge = op.get("edge")
    if edge_needed and edge not in EDGES:
        raise OpError("Say whether the shape is in the header or the footer")
    variant = op.get("variant", "default")
    if variant not in VARIANTS:
        raise OpError(f"The variant is one of: {', '.join(VARIANTS)}")
    return sid, edge, variant


def _list(store: dict[str, Any], doc: dict[str, Any], sid: str, edge: str, variant: str) -> tuple[str, list[dict[str, Any]]]:
    """The list a change goes into: the one of the section that owns the band (a linked band is the previous section's)."""
    own = owner(doc, sid, edge)
    entry = store.setdefault(own, {})
    return own, entry.setdefault(edge, {}).setdefault(variant, [])


def _tidy(store: dict[str, Any]) -> None:
    for sid in list(store):
        entry = store[sid]
        for edge in EDGES:
            bands = entry.get(edge)
            if bands is not None:
                for variant in list(bands):
                    if not bands[variant]:
                        del bands[variant]
                if not bands:
                    del entry[edge]
        if not entry:
            del store[sid]


@handler("band_shape_set")
def op_band_shape_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Add a shape to a header or footer (an item with a new id) or change one (the fields given replace those it has)."""
    sid, edge, variant = _target(tr, op)
    item = op.get("item")
    if not isinstance(item, dict) or not isinstance(item.get("id"), str):
        raise OpError("Give the shape to put in the header or footer")
    store = _read(tr)
    own, items = _list(store, tr.doc, sid, edge, variant)
    at = next((i for i, x in enumerate(items) if x["id"] == item["id"]), None)
    if at is None:
        if "shape" not in item:
            raise OpError("There is no such shape in this header or footer")
        if any(x["id"] == item["id"] for e in store.values() for b in (e.get("header", {}), e.get("footer", {})) for l in b.values() for x in l):
            raise OpError(f"The shape id {item['id']!r} is already used")
        items.append(check_item(item))
    else:
        if items[at].get("locked") and set(item) - {"id", "locked"}:
            raise OpError("The shape is locked: unlock it to change it")
        merged = {**items[at], **{k: v for k, v in item.items() if k != "shape"}}
        if "shape" in item:
            merged["shape"] = item["shape"]
        items[at] = check_item(merged)
    if len(items) > MAX_ITEMS:
        raise OpError(f"A header or footer holds at most {MAX_ITEMS} shapes")
    _tidy(store)
    _write(tr, store)
    return {"section": own, "id": item["id"]}


@handler("band_shape_delete")
def op_band_shape_delete(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    sid, edge, variant = _target(tr, op)
    ids = op.get("ids")
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids):
        raise OpError("Name the shapes to delete")
    store = _read(tr)
    own, items = _list(store, tr.doc, sid, edge, variant)
    locked = [x["id"] for x in items if x["id"] in ids and x.get("locked")]
    if locked:
        raise OpError("A locked shape cannot be deleted: unlock it first")
    found = [x["id"] for x in items if x["id"] in ids]
    if len(found) != len(set(ids)):
        raise OpError("There is no such shape in this header or footer")
    items[:] = [x for x in items if x["id"] not in ids]
    _tidy(store)
    _write(tr, store)
    return {"section": own, "deleted": found}


@handler("band_shape_order")
def op_band_shape_order(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Move a shape in the order of drawing: to the front or back of its list, or one step forward or backward."""
    sid, edge, variant = _target(tr, op)
    ident, to = op.get("id"), op.get("to")
    if to not in ORDERS:
        raise OpError(f"Order a shape to: {', '.join(ORDERS)}")
    store = _read(tr)
    own, items = _list(store, tr.doc, sid, edge, variant)
    at = next((i for i, x in enumerate(items) if x["id"] == ident), None)
    if at is None:
        raise OpError("There is no such shape in this header or footer")
    item = items.pop(at)
    to_at = {"front": len(items), "back": 0, "forward": min(len(items), at + 1), "backward": max(0, at - 1)}[to]
    items.insert(to_at, item)
    _write(tr, store)
    return {"section": own, "id": ident, "index": to_at}


@handler("band_shape_duplicate")
def op_band_shape_duplicate(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    sid, edge, variant = _target(tr, op)
    store = _read(tr)
    own, items = _list(store, tr.doc, sid, edge, variant)
    source = next((x for x in items if x["id"] == op.get("id")), None)
    if source is None:
        raise OpError("There is no such shape in this header or footer")
    if len(items) >= MAX_ITEMS:
        raise OpError(f"A header or footer holds at most {MAX_ITEMS} shapes")
    new_id = op.get("new_id") or "bs_" + secrets.token_hex(6)
    clone = copy.deepcopy(source)
    clone.update(id=new_id, locked=False)
    clone["x_mm"] = _num(source["x_mm"] + float(op.get("dx_mm", 5)), "x_mm", -1000, 3000)
    clone["y_mm"] = _num(source["y_mm"] + float(op.get("dy_mm", 5)), "y_mm", -1000, 3000)
    if any(x["id"] == new_id for e in store.values() for b in (e.get("header", {}), e.get("footer", {})) for l in b.values() for x in l):
        raise OpError(f"The shape id {new_id!r} is already used")
    items.insert(items.index(source) + 1, check_item(clone))
    _write(tr, store)
    return {"section": own, "id": new_id}


@handler("band_config")
def op_band_config(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Whether a section's first page has its own shapes, and whether its header and footer shapes are the previous section's (``link``).
    Unlinking copies what it showed, so nothing changes on the pages until the shapes are changed; linking drops its own."""
    sections = _ensure_sections(tr)
    tr.doc["sections"] = sections
    known = [s["id"] for s in sections]
    sid = op.get("section") or known[0]
    if sid not in known:
        raise OpError(f"There is no section '{sid}'")
    store = _read(tr)
    entry = store.setdefault(sid, {})
    if "first_page" in op:
        if type(op["first_page"]) is not bool:
            raise OpError("first_page must be true or false")
        if op["first_page"]:
            entry["first_page"] = True
        else:
            entry.pop("first_page", None)
            for edge in EDGES:
                entry.get(edge, {}).pop("first", None)
    link = op.get("link")
    if link is not None:
        if not isinstance(link, dict) or set(link) - set(EDGES) or any(type(v) is not bool for v in link.values()):
            raise OpError("link says, for the header and the footer, whether they are the previous section's")
        for edge, value in link.items():
            if value and known.index(sid) == 0:
                raise OpError("The first section has no previous section to link to")
            now = bool(entry.get("link", {}).get(edge))
            if value and not now:
                entry.pop(edge, None)
                entry.setdefault("link", {})[edge] = True
            elif not value and now:
                source = owner(tr.doc, sid, edge)
                entry.get("link", {}).pop(edge, None)
                copied = copy.deepcopy((store.get(source) or {}).get(edge) or {})
                renamed: dict[str, list[dict[str, Any]]] = {}
                for variant, items in copied.items():
                    renamed[variant] = [{**i, "id": "bs_" + secrets.token_hex(6)} for i in items]
                if renamed:
                    entry[edge] = renamed
            if not entry.get("link"):
                entry.pop("link", None)
    _tidy(store)
    _write(tr, store)
    return {"section": sid}


LABELS.update({"band_shape_set": "header or footer shape", "band_shape_delete": "delete header or footer shape", "band_shape_order": "arrange header or footer shape",
               "band_shape_duplicate": "duplicate header or footer shape", "band_config": "header and footer shapes"})
