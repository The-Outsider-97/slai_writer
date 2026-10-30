"""Pure text-and-spans arithmetic for SLDC blocks.

A block is ``{"id", "type", "text", "spans": [...]}``. This module edits ``text`` and keeps ``spans`` valid and in canonical order:

* ``format`` spans are normalised to non-overlapping runs, one per maximal stretch of identical formatting, so formatting commands
  are simple to apply and to invert;
* ``link``, ``style``, ``ref`` and ``xref`` spans keep their own ranges (they may overlap format runs);
* ``equation`` and ``image`` spans own exactly one U+FFFC placeholder character and move with it.

Nothing in this module validates against SLDC (``src.utils.sldc`` does that on every save); it only guarantees the invariants SLDC
checks for spans: ``0 <= start < end <= len(text)`` and sorted by ``(start, end, type)``.
"""
from __future__ import annotations

import copy
from typing import Any, Iterable

OBJ = "￼"
FORMAT_FLAGS = ("bold", "italic", "underline", "strike", "code", "superscript", "subscript")
FORMAT_COLOURS = ("color", "background")
FORMAT_FONTS = ("font_family", "font_size_pt")
FORMAT_KEYS = FORMAT_FLAGS + FORMAT_COLOURS + FORMAT_FONTS
OBJECT_KINDS = ("equation", "image")


class TextError(ValueError):
    """The requested edit does not fit the block (bad offsets, forbidden characters)."""


def _sort_key(span: dict[str, Any]) -> tuple[int, int, str]:
    return (span["start"], span["end"], str(span["type"]))


def sorted_spans(spans: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(spans, key=_sort_key)


def format_props(span: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in span.items() if k in FORMAT_KEYS and v not in (False, None)}


# ------------------------------------------------------------------------------------------------------------ format runs
def format_runs(block: dict[str, Any]) -> list[tuple[int, int, dict[str, Any]]]:
    """The block's formatting as non-overlapping ``(start, end, props)`` runs (props never empty)."""
    spans = [s for s in block.get("spans", ()) if s.get("type") == "format"]
    if not spans:
        return []
    points = sorted({0, len(block["text"])} | {s["start"] for s in spans} | {s["end"] for s in spans})
    runs: list[tuple[int, int, dict[str, Any]]] = []
    for a, b in zip(points, points[1:]):
        props: dict[str, Any] = {}
        for s in spans:
            if s["start"] <= a and s["end"] >= b:
                props.update(format_props(s))
        if props:
            if runs and runs[-1][1] == a and runs[-1][2] == props:
                runs[-1] = (runs[-1][0], b, props)
            else:
                runs.append((a, b, props))
    return runs


def _runs_to_spans(runs: Iterable[tuple[int, int, dict[str, Any]]]) -> list[dict[str, Any]]:
    out = []
    for a, b, props in runs:
        if a < b and props:
            out.append({"type": "format", "start": a, "end": b, **props})
    return out


def _other_spans(block: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in block.get("spans", ()) if s.get("type") != "format"]


def _store(block: dict[str, Any], spans: list[dict[str, Any]]) -> None:
    spans = sorted_spans(spans)
    if spans:
        block["spans"] = spans
    else:
        block.pop("spans", None)


def normalise(block: dict[str, Any]) -> None:
    """Re-derive canonical spans (merged runs, sorted, in range). Safe to call at any time."""
    length = len(block["text"])
    keep = []
    for s in _other_spans(block):
        if 0 <= s["start"] < s["end"] <= length:
            keep.append(s)
    _store(block, keep + _runs_to_spans(format_runs(block)))


# --------------------------------------------------------------------------------------------------------------- editing
def check_range(block: dict[str, Any], start: int, end: int) -> None:
    n = len(block["text"])
    if type(start) is not int or type(end) is not int or not 0 <= start <= end <= n:
        raise TextError(f"The selection {start}-{end} does not fit a block of {n} characters")


def replace_text(block: dict[str, Any], start: int, end: int, insert: str) -> None:
    """Replace ``text[start:end]`` with ``insert`` and carry every span along (see the module doc for the rules)."""
    check_range(block, start, end)
    if OBJ in insert:
        raise TextError("The object character cannot be typed; insert an equation or image instead")
    text = block["text"]
    deleted_objects = {i for i in range(start, end) if text[i] == OBJ}
    length = len(insert)
    removed = end - start
    out: list[dict[str, Any]] = []
    for span in block.get("spans", ()):
        kind = span["type"]
        a, b = span["start"], span["end"]
        if kind in OBJECT_KINDS and a in deleted_objects:
            continue
        a2 = _map_start(a, start, end, removed, length)
        b2 = _map_end(b, start, end, removed, length, inherit=kind == "format")
        if a2 >= b2:
            continue
        item = dict(span)
        item["start"], item["end"] = a2, b2
        out.append(item)
    block["text"] = text[:start] + insert + text[end:]
    _store(block, out)
    normalise(block)


def _map_start(p: int, s: int, e: int, removed: int, added: int) -> int:
    if p <= s:
        return p                                   # strictly before the edit, or at its start (text typed here is not inherited)
    if p < e:
        p = s                                      # inside the deleted range
    else:
        p -= removed
    return p + added


def _map_end(p: int, s: int, e: int, removed: int, added: int, inherit: bool) -> int:
    if p < s:
        return p
    if p == s:
        return p + added if inherit else p         # typing at the end of a format run continues it; a link or reference does not grow
    if p < e:
        p = s
        return p + added if inherit else p
    p -= removed
    return p + added


def apply_format(block: dict[str, Any], start: int, end: int, set_props: dict[str, Any] | None = None,
                 unset: Iterable[str] = ()) -> None:
    """Set (``set_props``) or clear (``unset``) formatting on ``text[start:end]``."""
    check_range(block, start, end)
    if start == end:
        return
    set_props = dict(set_props or {})
    for key, value in set_props.items():
        if key not in FORMAT_KEYS:
            raise TextError(f"Unknown formatting '{key}'")
        if key in FORMAT_COLOURS and value is None:
            raise TextError(f"'{key}' needs a #rrggbb colour")
    if set_props.get("superscript"):
        set_props["subscript"] = False
    if set_props.get("subscript"):
        set_props["superscript"] = False
    unset = list(unset)
    for key in unset:
        if key not in FORMAT_KEYS:
            raise TextError(f"Unknown formatting '{key}'")
    runs = format_runs(block)
    points = sorted({0, len(block["text"]), start, end} | {r[0] for r in runs} | {r[1] for r in runs})
    cells: list[tuple[int, int, dict[str, Any]]] = []
    for a, b in zip(points, points[1:]):
        props: dict[str, Any] = {}
        for ra, rb, rp in runs:
            if ra <= a and rb >= b:
                props = dict(rp)
                break
        if start <= a and b <= end:
            for key in unset:
                props.pop(key, None)
            for key, value in set_props.items():
                if value in (False, None):
                    props.pop(key, None)
                else:
                    props[key] = value
        if props:
            if cells and cells[-1][1] == a and cells[-1][2] == props:
                cells[-1] = (cells[-1][0], b, props)
            else:
                cells.append((a, b, props))
    _store(block, _other_spans(block) + _runs_to_spans(cells))


def toggled(block: dict[str, Any], start: int, end: int, flag: str) -> bool:
    """True when every character of the selection already has ``flag`` (so a toggle should remove it)."""
    if start >= end:
        return False
    covered = 0
    for a, b, props in format_runs(block):
        if props.get(flag):
            covered += max(0, min(b, end) - max(a, start))
    return covered >= end - start


def set_span(block: dict[str, Any], start: int, end: int, kind: str, **fields: Any) -> None:
    """Add a ``link`` / ``style`` / ``ref`` / ``xref`` span on a range, replacing a span of the same kind that overlaps it."""
    check_range(block, start, end)
    if start == end:
        raise TextError("Select some text first")
    if kind not in ("link", "style", "ref", "xref"):
        raise TextError(f"Unknown span type '{kind}'")
    kept = []
    for s in block.get("spans", ()):
        if s["type"] == kind and s["start"] < end and s["end"] > start:
            if s["start"] < start:
                kept.append({**s, "end": start})
            if s["end"] > end:
                kept.append({**s, "start": end})
        else:
            kept.append(s)
    kept.append({"type": kind, "start": start, "end": end, **fields})
    _store(block, kept)


def clear_span(block: dict[str, Any], start: int, end: int, kind: str) -> None:
    check_range(block, start, end)
    kept = []
    for s in block.get("spans", ()):
        if s["type"] == kind and s["start"] < end and s["end"] > start:
            if s["start"] < start:
                kept.append({**s, "end": start})
            if s["end"] > end:
                kept.append({**s, "start": end})
        else:
            kept.append(s)
    _store(block, kept)


def insert_object(block: dict[str, Any], at: int, kind: str, payload_key: str, payload: dict[str, Any]) -> None:
    """Insert an inline equation/image: one placeholder character plus its span."""
    check_range(block, at, at)
    if kind not in OBJECT_KINDS:
        raise TextError("An inline object is an equation or an image")
    moved = []
    for s in block.get("spans", ()):
        a, b = s["start"], s["end"]
        moved.append({**s, "start": a + 1 if a >= at else a, "end": b + 1 if b > at else b})
    text = block["text"]
    block["text"] = text[:at] + OBJ + text[at:]
    moved.append({"type": kind, "start": at, "end": at + 1, payload_key: copy.deepcopy(payload)})
    _store(block, moved)
    normalise(block)


# ------------------------------------------------------------------------------------------------------ split and merge
def split(block: dict[str, Any], at: int) -> tuple[dict[str, Any], dict[str, Any]]:
    """Cut a block in two at ``at``; returns ``(left, right)`` copies carrying the matching spans (ids are the caller's job)."""
    check_range(block, at, at)
    left, right = copy.deepcopy(block), copy.deepcopy(block)
    left["text"], right["text"] = block["text"][:at], block["text"][at:]
    lspans, rspans = [], []
    for s in block.get("spans", ()):
        a, b = s["start"], s["end"]
        if a < at:
            lspans.append({**s, "end": min(b, at)})
        if b > at:
            if s["type"] in OBJECT_KINDS and a < at:
                continue
            rspans.append({**s, "start": max(a, at) - at, "end": b - at})
    _store(left, lspans)
    _store(right, rspans)
    return left, right


def join(first: dict[str, Any], second: dict[str, Any]) -> int:
    """Append ``second`` to ``first`` in place; returns the offset where ``second`` begins."""
    offset = len(first["text"])
    first["text"] += second["text"]
    spans = list(first.get("spans", ()))
    for s in second.get("spans", ()):
        spans.append({**s, "start": s["start"] + offset, "end": s["end"] + offset})
    _store(first, spans)
    normalise(first)
    return offset


def plain(block: dict[str, Any]) -> str:
    """The block's readable text (object placeholders removed)."""
    return block["text"].replace(OBJ, "")
