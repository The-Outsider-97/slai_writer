"""Document operations: the only way a document changes.

An *operation* is a small JSON object (``{"op": "text", "block": "b1", "start": 3, "end": 3, "insert": "x"}``). :func:`apply_operation`
applies one to an SLDC document dictionary and returns an :class:`Undo` record that restores exactly what the operation changed;
applying an ``Undo`` returns the matching redo. Every edit - typing, formatting, pasting, a table cell, an accepted AI suggestion, an
EMBED patch, a restored snapshot - is an operation, so undo, redo, recovery, history and conflict detection work the same way for all
of them. The module knows the document model (blocks, styles, sections, references, embeds) but nothing about files, users or HTTP.
"""
from __future__ import annotations

import copy
import math
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from ..tools.errors import BadRequest, Conflict, LimitExceeded, NotFound
from . import textmodel as tm

MISSING = "\x00missing"
TEXT_TYPES = ("heading", "paragraph", "list_item", "quote", "code")
STRUCTURAL = ("table", "figure", "equation", "embed")
MAX_BLOCK_CHARS = 2_000_000
MAX_TABLE_CELLS = 20_000
WRITER_EXT = "slai.writer"
EXT_KEYS = ("guides", "background", "layers", "layer_of", "view", "dictionary", "spell_ignore", "signature_marks", "locks", "versions", "source_status")
_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9 _.-]{0,63}$")
_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
_FONT_FAMILY = re.compile(r"^[^\x00-\x1f\x7f{};<>\\\"'`]{1,100}$")
DEFAULT_SECTION = "s1"


class OpError(BadRequest):
    """An operation that does not fit the document (unknown block, bad offsets, wrong block type)."""


@dataclass
class Undo:
    """What an operation changed, stored as the state *before* it. Applying it restores that state."""

    label: str = "edit"
    blocks: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    order: list[str] | None = None
    keys: dict[str, Any] = field(default_factory=dict)
    typing: str | None = None                 # block id when this is a run of typing (so neighbours can be merged)

    def absorb(self, later: "Undo") -> None:
        """Merge ``later`` (made after this one) into this record: the earlier 'before' state wins."""
        for block_id, before in later.blocks.items():
            self.blocks.setdefault(block_id, before)
        if self.order is None:
            self.order = later.order
        for key, before in later.keys.items():
            self.keys.setdefault(key, before)

    @property
    def empty(self) -> bool:
        return not self.blocks and self.order is None and not self.keys


class Tracker:
    """Gives handlers access to the document while remembering the 'before' state of everything they touch."""

    def __init__(self, doc: dict[str, Any]) -> None:
        self.doc = doc
        self.undo = Undo()
        self.index = {b["id"]: b for b in doc["blocks"]}
        self.touched: set[str] = set()
        self.structural = False

    # blocks ---------------------------------------------------------------------------------------------------------
    def peek(self, block_id: Any) -> dict[str, Any]:
        block = self.index.get(block_id) if isinstance(block_id, str) else None
        if block is None:
            raise OpError(f"There is no block {block_id!r} in this document", details={"block": block_id})
        return block

    def get(self, block_id: Any) -> dict[str, Any]:
        block = self.peek(block_id)
        if block_id not in self.undo.blocks:
            self.undo.blocks[block_id] = copy.deepcopy(block)
        self.touched.add(block_id)
        return block

    def position(self, block_id: str) -> int:
        for i, b in enumerate(self.doc["blocks"]):
            if b["id"] == block_id:
                return i
        raise OpError(f"There is no block {block_id!r} in this document")

    def _order(self) -> None:
        if self.undo.order is None:
            self.undo.order = [b["id"] for b in self.doc["blocks"]]
        self.structural = True

    def insert(self, at: int, block: dict[str, Any]) -> None:
        self._order()
        if block["id"] in self.index:
            raise OpError(f"Block id {block['id']!r} is already used")
        self.undo.blocks.setdefault(block["id"], None)
        self.doc["blocks"].insert(at, block)
        self.index[block["id"]] = block
        self.touched.add(block["id"])

    def remove(self, block_id: str) -> None:
        block = self.get(block_id)
        self._order()
        self.doc["blocks"].remove(block)
        del self.index[block_id]

    def reorder(self, ids: list[str]) -> None:
        self._order()
        self.doc["blocks"][:] = [self.index[i] for i in ids]

    # document keys --------------------------------------------------------------------------------------------------
    def key(self, name: str) -> Any:
        if name not in self.undo.keys:
            self.undo.keys[name] = copy.deepcopy(self.doc.get(name, MISSING))
        return self.doc.get(name)

    def set_key(self, name: str, value: Any) -> None:
        self.key(name)
        if value is None:
            self.doc.pop(name, None)
        else:
            self.doc[name] = value


def fresh_id(doc: dict[str, Any], prefix: str = "b") -> str:
    used = {b["id"] for b in doc["blocks"]}
    while True:
        candidate = f"{prefix}{uuid.uuid4().hex[:10]}"
        if candidate not in used:
            return candidate


# ------------------------------------------------------------------------------------------------------------------- undo
def apply_undo(doc: dict[str, Any], undo: Undo) -> Undo:
    """Restore the state recorded in ``undo``; returns the record that reverses this restore (redo of an undo and vice versa)."""
    current = {b["id"]: b for b in doc["blocks"]}
    inverse = Undo(label=undo.label)
    for block_id in undo.blocks:
        now = current.get(block_id)
        inverse.blocks[block_id] = copy.deepcopy(now) if now is not None else None
    if undo.order is not None:
        inverse.order = [b["id"] for b in doc["blocks"]]
    for key in undo.keys:
        inverse.keys[key] = copy.deepcopy(doc.get(key, MISSING))
    merged = dict(current)
    for block_id, before in undo.blocks.items():
        if before is None:
            merged.pop(block_id, None)
        else:
            merged[block_id] = copy.deepcopy(before)
    if undo.order is not None:
        doc["blocks"][:] = [merged[i] for i in undo.order]
    else:
        doc["blocks"][:] = [merged[b["id"]] for b in doc["blocks"]]
    for key, before in undo.keys.items():
        if before == MISSING:
            doc.pop(key, None)
        else:
            doc[key] = copy.deepcopy(before)
    return inverse


# ------------------------------------------------------------------------------------------------------------- field checks
def _s(op: dict[str, Any], key: str, *, required: bool = True, limit: int = 1_000_000) -> str | None:
    value = op.get(key)
    if value is None:
        if required:
            raise OpError(f"The operation needs '{key}'")
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise OpError(f"'{key}' must be text of at most {limit} characters")
    return value


def _i(op: dict[str, Any], key: str, low: int = 0, high: int = 10_000_000, *, required: bool = True) -> int | None:
    value = op.get(key)
    if value is None:
        if required:
            raise OpError(f"The operation needs '{key}'")
        return None
    if type(value) is not int or not low <= value <= high:
        raise OpError(f"'{key}' must be a whole number from {low} to {high}")
    return value


def _d(op: dict[str, Any], key: str, *, required: bool = True) -> dict[str, Any] | None:
    value = op.get(key)
    if value is None:
        if required:
            raise OpError(f"The operation needs '{key}'")
        return None
    if not isinstance(value, dict):
        raise OpError(f"'{key}' must be an object")
    return value


def _is_text_block(block: dict[str, Any]) -> bool:
    return block["type"] in TEXT_TYPES


def _need_text_block(tr: Tracker, block_id: Any) -> dict[str, Any]:
    block = tr.get(block_id)
    if not _is_text_block(block) and block["type"] not in ("table", "figure"):
        raise OpError("This block does not hold editable text")
    return block


def _tidy_attributes(block: dict[str, Any]) -> None:
    attrs = block.get("attributes")
    if attrs is None:
        return
    kind = block["type"]
    if kind != "heading":
        attrs.pop("level", None)
    elif "level" not in attrs:
        attrs["level"] = 1
    if kind != "list_item":
        attrs.pop("ordered", None)
        attrs.pop("depth", None)
    if kind != "code":
        attrs.pop("language", None)
    if not attrs:
        block.pop("attributes", None)


def repair_sections(tr: Tracker) -> None:
    """Sections must be contiguous and in order; after a move or an insert make that true again."""
    sections = tr.doc.get("sections") or []
    if not sections:
        return
    order = {s["id"]: i for i, s in enumerate(sections)}
    current = -1
    current_id: str | None = None
    for block in list(tr.doc["blocks"]):
        sid = block.get("section")
        if sid is None:
            continue
        position = order.get(sid, 0)
        if position < current:
            tr.get(block["id"])["section"] = current_id
        else:
            current, current_id = position, sid


def _inherit_section(tr: Tracker, block: dict[str, Any], neighbour: dict[str, Any] | None) -> None:
    if tr.doc.get("sections") and neighbour is not None and neighbour.get("section"):
        block["section"] = neighbour["section"]


# ------------------------------------------------------------------------------------------------------------- the handlers
Handler = Callable[[Tracker, dict[str, Any]], dict[str, Any]]
HANDLERS: dict[str, Handler] = {}


def handler(name: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        return fn
    return register


@handler("text")
def op_text(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = _need_text_block(tr, op.get("block"))
    if not _is_text_block(block):
        raise OpError("Edit a table cell or a figure caption with its own operation")
    start, end, insert = _i(op, "start"), _i(op, "end"), _s(op, "insert", required=False) or ""
    expect = op.get("expect")
    if expect is not None and block["text"][start:end] != expect:        # a suggestion made for other text must not be applied here
        raise Conflict("The text changed since this suggestion was made, so it was not applied.", details={"kind": "stale_text"})
    if len(block["text"]) - (end - start) + len(insert) > MAX_BLOCK_CHARS:
        raise LimitExceeded("That block would become longer than the format allows")
    try:
        tm.replace_text(block, start, end, insert)
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    tr.undo.typing = block["id"]
    return {}


@handler("format")
def op_format(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = _need_text_block(tr, op.get("block"))
    start, end = _i(op, "start"), _i(op, "end")
    set_props = dict(_d(op, "set", required=False) or {})
    unset = list(op.get("unset") or [])
    toggle = op.get("toggle")
    try:
        if toggle:
            if toggle not in tm.FORMAT_FLAGS:
                raise OpError(f"Cannot toggle '{toggle}'")
            if tm.toggled(block, start, end, toggle):
                unset.append(toggle)
            else:
                set_props[toggle] = True
        for key in ("color", "background"):
            if key in set_props and (not isinstance(set_props[key], str) or not _COLOUR.fullmatch(set_props[key])):
                raise OpError(f"'{key}' must be a #rrggbb colour")
        if "font_family" in set_props and (not isinstance(set_props["font_family"], str)
                                           or not _FONT_FAMILY.fullmatch(set_props["font_family"])):
            raise OpError("font_family must be a safe font family name")
        if "font_size_pt" in set_props:
            size = set_props["font_size_pt"]
            if type(size) not in (int, float) or not math.isfinite(size) or not 4 <= size <= 400:
                raise OpError("font_size_pt must be between 4 and 400 points")
        for key, value in set_props.items():
            if key in tm.FORMAT_FLAGS and type(value) is not bool:
                raise OpError(f"'{key}' must be true or false")
        tm.apply_format(block, start, end, set_props, unset)
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    return {}


@handler("case")
def op_case(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Case-convert selected Unicode text while remapping every inline span boundary."""
    block = _need_text_block(tr, op.get("block"))
    start, end = _i(op, "start"), _i(op, "end")
    mode = _s(op, "mode")
    if mode not in ("upper", "lower"):
        raise OpError("Case mode must be upper or lower")
    try:
        tm.check_range(block, start, end)
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    source = block["text"][start:end]
    convert = str.upper if mode == "upper" else str.lower
    result = convert(source)
    if len(block["text"]) - len(source) + len(result) > MAX_BLOCK_CHARS:
        raise LimitExceeded("That block would become longer than the format allows")
    if result == source:
        return {}
    offsets = [0]
    for char in source:
        offsets.append(offsets[-1] + len(convert(char)))
    delta = len(result) - len(source)

    def map_position(position: int) -> int:
        if position <= start:
            return position
        if position >= end:
            return position + delta
        return start + offsets[position - start]

    for span in block.get("spans", ()):
        span["start"] = map_position(span["start"])
        span["end"] = map_position(span["end"])
    block["text"] = block["text"][:start] + result + block["text"][end:]
    tm.normalise(block)
    return {}


@handler("span")
def op_span(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = _need_text_block(tr, op.get("block"))
    kind, start, end = _s(op, "kind"), _i(op, "start"), _i(op, "end")
    try:
        if op.get("clear"):
            tm.clear_span(block, start, end, kind)
        elif kind == "link":
            tm.set_span(block, start, end, "link", href=_s(op, "href", limit=4096))
        elif kind == "style":
            name = _s(op, "style")
            if name not in (tr.doc.get("styles", {}).get("character", {})):
                raise OpError(f"There is no character style '{name}'")
            tm.set_span(block, start, end, "style", style=name)
        elif kind == "ref":
            ref = _s(op, "ref")
            if not any(r["id"] == ref for r in tr.doc.get("references", [])):
                raise OpError(f"There is no reference '{ref}'")
            tm.set_span(block, start, end, "ref", ref=ref)
        elif kind == "xref":
            target = _s(op, "target")
            tr.peek(target)
            tm.set_span(block, start, end, "xref", target=target)
        else:
            raise OpError(f"Unknown span type '{kind}'")
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    return {}


@handler("inline_object")
def op_inline_object(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    if not _is_text_block(block) or block["type"] == "code":
        raise OpError("Inline objects go into paragraphs, headings, list items and quotes")
    kind = _s(op, "kind")
    payload_key = "equation" if kind == "equation" else "figure"
    try:
        tm.insert_object(block, _i(op, "at"), kind, payload_key, _d(op, payload_key))
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    return {}


@handler("block_set")
def op_block_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    new_type = op.get("type")
    if new_type is not None:
        if new_type not in TEXT_TYPES or not _is_text_block(block):
            raise OpError("Only text blocks can change between heading, paragraph, list item, quote and code")
        block["type"] = new_type
    attrs = dict(block.get("attributes") or {})
    for key, value in (_d(op, "attributes", required=False) or {}).items():
        if value is None:
            attrs.pop(key, None)
        else:
            attrs[key] = value
    if attrs:
        block["attributes"] = attrs
    else:
        block.pop("attributes", None)
    if "style" in op:
        style = op["style"]
        if style in (None, ""):
            block.pop("style", None)
        else:
            if style not in tr.doc.get("styles", {}).get("paragraph", {}):
                raise OpError(f"There is no paragraph style '{style}'")
            block["style"] = style
    if "section" in op:
        if op["section"] in (None, ""):
            block.pop("section", None)
        else:
            if not any(s["id"] == op["section"] for s in tr.doc.get("sections", [])):
                raise OpError(f"There is no section '{op['section']}'")
            block["section"] = op["section"]
    _tidy_attributes(block)
    return {}


@handler("block_insert")
def op_block_insert(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    spec = _d(op, "block")
    kind = spec.get("type", "paragraph")
    if kind not in TEXT_TYPES + STRUCTURAL:
        raise OpError(f"Unknown block type '{kind}'")
    after = op.get("after")
    where = 0 if after in (None, "") else tr.position(after) + 1
    block: dict[str, Any] = {"id": spec.get("id") or fresh_id(tr.doc), "type": kind, "text": spec.get("text", "")}
    if not isinstance(block["text"], str):
        raise OpError("Block text must be text")
    for key in ("attributes", "spans", "style", "table", "figure", "equation", "embed", "extensions", "section"):
        if key in spec:
            block[key] = copy.deepcopy(spec[key])
    if kind == "table" and "table" not in block:
        rows, cols = _i(spec, "rows", 1, 200, required=False) or 2, _i(spec, "columns", 1, 40, required=False) or 2
        block["table"] = {"columns": cols, "header_rows": 1,
                          "rows": [[{"text": ""} for _ in range(cols)] for _ in range(rows)]}
    if "section" not in block:
        _inherit_section(tr, block, tr.doc["blocks"][where - 1] if where else (tr.doc["blocks"][0] if tr.doc["blocks"] else None))
    _tidy_attributes(block)
    if kind == "heading" and "attributes" not in block:
        block["attributes"] = {"level": 1}
    tr.insert(where, block)
    return {"block": block["id"]}


@handler("block_delete")
def op_block_delete(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    ids = op.get("blocks") if isinstance(op.get("blocks"), list) else [op.get("block")]
    if not ids or len(ids) > 5000:
        raise OpError("Choose the blocks to delete")
    for block_id in ids:
        tr.peek(block_id)
    for block_id in ids:
        tr.remove(block_id)
    if not tr.doc["blocks"]:                                   # a document always keeps one (empty) paragraph to write in
        tr.insert(0, {"id": fresh_id(tr.doc), "type": "paragraph", "text": ""})
    repair_sections(tr)
    return {}


@handler("split")
def op_split(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    if not _is_text_block(block):
        raise OpError("Only text blocks can be split")
    at = _i(op, "at")
    try:
        left, right = tm.split(block, at)
    except tm.TextError as exc:
        raise OpError(str(exc)) from exc
    block["text"], block_spans = left["text"], left.get("spans")
    if block_spans:
        block["spans"] = block_spans
    else:
        block.pop("spans", None)
    right["id"] = op.get("new_id") or fresh_id(tr.doc)
    if block["type"] in ("heading", "quote") and not op.get("keep_type"):
        right["type"] = "paragraph"
        right.pop("style", None)
        right.pop("attributes", None)
    if block["type"] == "list_item" and not right["text"] and not block["text"]:
        right["type"] = "paragraph"                            # Enter on an empty list item leaves the list
        right.pop("attributes", None)
    _tidy_attributes(right)
    tr.insert(tr.position(block["id"]) + 1, right)
    return {"block": right["id"]}


@handler("merge")
def op_merge(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    position = tr.position(block["id"])
    if position == 0:
        raise OpError("This is the first block; there is nothing to merge into")
    previous = tr.get(tr.doc["blocks"][position - 1]["id"])
    if not _is_text_block(block) or not _is_text_block(previous):
        raise OpError("Only text blocks can be merged")
    offset = tm.join(previous, block)
    tr.remove(block["id"])
    repair_sections(tr)
    return {"block": previous["id"], "offset": offset}


@handler("move")
def op_move(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    ids = [b["id"] for b in tr.doc["blocks"]]
    moving = op.get("blocks") if isinstance(op.get("blocks"), list) else [op.get("block")]
    for m in moving:
        tr.peek(m)
    after = op.get("after")
    if after is not None and after not in ids:
        raise OpError(f"There is no block {after!r}")
    if after in moving:
        raise OpError("A block cannot move after itself")
    rest = [i for i in ids if i not in moving]
    at = 0 if after is None else rest.index(after) + 1
    tr.reorder(rest[:at] + [m for m in ids if m in moving] + rest[at:])
    repair_sections(tr)
    return {}


# ---- tables and figures ------------------------------------------------------------------------------------------------
def _table(tr: Tracker, block_id: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    block = tr.get(block_id)
    if block["type"] != "table":
        raise OpError("This block is not a table")
    return block, block["table"]


def _plain_grid(table: dict[str, Any]) -> list[list[dict[str, Any]]]:
    for row in table["rows"]:
        for cell in row:
            if cell.get("colspan", 1) != 1 or cell.get("rowspan", 1) != 1:
                raise OpError("This table has merged cells; row and column changes are not available for it yet")
    return table["rows"]


@handler("table_cell")
def op_table_cell(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    _, table = _table(tr, op.get("block"))
    row, col = _i(op, "row", 0, 10_000), _i(op, "col", 0, 1_000)
    text = _s(op, "text", limit=20_000)
    grid = _plain_grid(table)
    if row >= len(grid) or col >= len(grid[row]):
        raise OpError("That table cell does not exist")
    grid[row][col]["text"] = text
    return {}


@handler("table_edit")
def op_table_edit(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block, table = _table(tr, op.get("block"))
    action, index = _s(op, "action"), _i(op, "index", 0, 10_000, required=False) or 0
    grid = _plain_grid(table)
    cols = table["columns"]
    if action == "insert_row":
        if len(grid) + 1 > 10_000 or (len(grid) + 1) * cols > MAX_TABLE_CELLS:
            raise LimitExceeded("The table would become too large")
        grid.insert(min(index, len(grid)), [{"text": ""} for _ in range(cols)])
    elif action == "delete_row":
        if len(grid) <= 1 or index >= len(grid):
            raise OpError("A table keeps at least one row")
        del grid[index]
        table["header_rows"] = min(table.get("header_rows", 0), len(grid))
    elif action == "insert_col":
        if cols + 1 > 256 or len(grid) * (cols + 1) > MAX_TABLE_CELLS:
            raise LimitExceeded("The table would become too large")
        for row in grid:
            row.insert(min(index, cols), {"text": ""})
        table["columns"] = cols + 1
    elif action == "delete_col":
        if cols <= 1 or index >= cols:
            raise OpError("A table keeps at least one column")
        for row in grid:
            del row[index]
        table["columns"] = cols - 1
    elif action == "header_rows":
        table["header_rows"] = _i(op, "count", 0, len(grid))
    else:
        raise OpError(f"Unknown table action '{action}'")
    return {}


@handler("caption")
def op_caption(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    if block["type"] not in ("table", "figure"):
        raise OpError("Only tables and figures have a caption")
    block["text"] = _s(op, "text", limit=5000)
    return {}


_FIGURE_KEYS = frozenset({"alt", "decorative", "width_mm", "height_mm", "align", "crop", "rotation_deg", "flip_horizontal", "flip_vertical", "placement", "credit", "rights"})


def _num(value: Any, low: float, high: float, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or not low <= value <= high:
        raise OpError(f"{what} must be a number between {low:g} and {high:g}")
    return value


def _check_figure_props(tr: Tracker, block_id: str, props: dict[str, Any]) -> None:
    """The picture properties the editing handles can set. The .sldc format checks the same rules when the document is saved; checking here
    means a bad value is refused at once and never reaches the document."""
    unknown = set(props) - _FIGURE_KEYS
    if unknown:
        raise OpError(f"Unknown picture setting: {sorted(unknown)[0]}")
    for key in ("width_mm", "height_mm"):
        if props.get(key) is not None:
            _num(props[key], 0.1, 5000, key)
    if props.get("rotation_deg") is not None:
        _num(props["rotation_deg"], -360, 360, "rotation_deg")
    for key in ("flip_horizontal", "flip_vertical", "decorative"):
        if props.get(key) is not None and not isinstance(props[key], bool):
            raise OpError(f"{key} must be true or false")
    if props.get("align") is not None and props["align"] not in ("left", "center", "right"):
        raise OpError("align must be left, center or right")
    crop = props.get("crop")
    if crop is not None:
        if not isinstance(crop, dict) or set(crop) != {"left", "top", "right", "bottom"}:
            raise OpError("crop needs left, top, right and bottom")
        for side in crop:
            _num(crop[side], 0, 1, f"crop.{side}")
        if crop["left"] >= crop["right"] or crop["top"] >= crop["bottom"]:
            raise OpError("The cropped part of the picture would be empty")
    placement = props.get("placement")
    if placement is not None:
        if not isinstance(placement, dict) or set(placement) - {"mode", "anchor", "target", "x_mm", "y_mm", "wrap", "layer"}:
            raise OpError("placement has settings the format does not know")
        if placement.get("mode") != "floating" or placement.get("anchor") not in ("page", "block"):
            raise OpError("A floating picture is anchored to the page or to a block")
        _num(placement.get("x_mm"), -5000, 5000, "placement.x_mm")
        _num(placement.get("y_mm"), -5000, 5000, "placement.y_mm")
        wrap, layer = placement.get("wrap", "none"), placement.get("layer", "content")
        if wrap not in ("none", "square", "top_bottom") or layer not in ("content", "behind_text", "in_front_of_text"):
            raise OpError("Unknown wrap or layer for a floating picture")
        if layer != "content" and wrap != "none":
            raise OpError("A picture in front of or behind the text cannot wrap the text")
        if placement["anchor"] == "page" and wrap != "none":
            raise OpError("A picture fixed to the page cannot wrap the text")
        if placement["anchor"] == "block":
            if placement.get("target") in (None, block_id):
                raise OpError("A picture anchored to a block needs another block as its anchor")
            tr.get(placement.get("target"))
        elif "target" in placement:
            raise OpError("Only a block anchor has a target")


@handler("figure_set")
def op_figure_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    if block["type"] != "figure":
        raise OpError("This block is not a figure")
    props = _d(op, "props") or {}
    if "asset" in props:
        raise OpError("A figure cannot be pointed at another image; insert a new figure")
    _check_figure_props(tr, block["id"], props)
    figure = block["figure"]
    for key, value in props.items():
        if value is None:
            figure.pop(key, None)
        else:
            figure[key] = value
    if figure.get("placement"):
        figure.pop("align", None)               # the format does not allow both: a floating picture has no line alignment
    if figure.get("decorative"):
        figure["alt"] = ""
    return {}


@handler("equation_set")
def op_equation_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    block = tr.get(op.get("block"))
    if block["type"] != "equation":
        raise OpError("This block is not an equation")
    for key, value in (_d(op, "props") or {}).items():
        if value is None:
            block["equation"].pop(key, None)
        else:
            block["equation"][key] = value
    return {}


# ---- document-level operations -----------------------------------------------------------------------------------------
@handler("meta")
def op_meta(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    values = _d(op, "set")
    for key, value in values.items():
        if key in ("title", "language"):
            if not isinstance(value, str) or not value.strip() or len(value) > 4096:
                raise OpError(f"'{key}' must be text")
            tr.set_key(key, value.strip() if key == "title" else value)
        elif key == "publication":
            if value is not None and not isinstance(value, dict):
                raise OpError("'publication' must be an object")
            tr.set_key("publication", copy.deepcopy(value) if value else None)
        else:
            raise OpError(f"Cannot change '{key}' this way")
    return {}


def _section(tr: Tracker, section_id: str) -> dict[str, Any]:
    sections = list(tr.key("sections") or [])
    for s in sections:
        if s["id"] == section_id:
            return s
    s = {"id": section_id}
    sections.append(s)
    tr.doc["sections"] = sections
    return s


@handler("page_setup")
def op_page_setup(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Page size, orientation, margins, columns, header, footer and page numbering of a section (default: the whole document)."""
    sid = op.get("section") or DEFAULT_SECTION
    sections = copy.deepcopy(tr.key("sections") or [])
    tr.doc["sections"] = sections
    section = next((s for s in sections if s["id"] == sid), None)
    if section is None:
        if sid != DEFAULT_SECTION and not sections:
            raise OpError(f"There is no section '{sid}'")
        section = {"id": sid}
        sections.append(section)
    if "page" in op:
        page = copy.deepcopy(_d(op, "page"))
        section["page"] = {**section.get("page", {}), **page}
        for band in ("header_mm", "footer_mm"):                 # null puts the header or footer back to its default place
            if section["page"].get(band, 0) is None:
                section["page"].pop(band, None)
        if "size" in page:
            section["page"].pop("width_mm", None)
            section["page"].pop("height_mm", None)
        elif "width_mm" in page or "height_mm" in page:         # a custom size replaces a named one (the format allows only one of the two)
            section["page"].pop("size", None)
        if "margins_mm" in page:
            section["page"]["margins_mm"] = {**(section.get("page", {}).get("margins_mm", {})), **page["margins_mm"]}
    for key in ("columns", "column_gap_mm", "numbering"):
        if key in op:
            if op[key] is None:
                section.pop(key, None)
            else:
                section[key] = op[key]
    for edge in ("header", "footer"):
        if edge in op:
            if op[edge] is None:
                section.pop(edge, None)
            else:
                section[edge] = {k: v for k, v in op[edge].items() if v not in (None, "")}
                if not section[edge]:
                    section.pop(edge)
    if sid == DEFAULT_SECTION and tr.doc["blocks"]:
        first = tr.doc["blocks"][0]
        if not first.get("section"):
            for block in tr.doc["blocks"]:                      # a first page setup puts every block into the one section
                if not block.get("section"):
                    tr.get(block["id"])["section"] = sid
    return {"section": sid}


@handler("section_break")
def op_section_break(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Start a new section at a block: it inherits the previous section's page setup."""
    block = tr.get(op.get("block"))
    sections = copy.deepcopy(tr.key("sections") or [])
    if not sections:
        sections = [{"id": DEFAULT_SECTION}]
        for b in tr.doc["blocks"]:
            tr.get(b["id"])["section"] = DEFAULT_SECTION
    previous = sections[-1]
    sid = f"s{len(sections) + 1}"
    while any(s["id"] == sid for s in sections):
        sid += "x"
    new = {k: copy.deepcopy(v) for k, v in previous.items() if k != "id"}
    new.update({"id": sid})
    sections.append(new)
    tr.doc["sections"] = sections
    for b in tr.doc["blocks"][tr.position(block["id"]):]:
        tr.get(b["id"])["section"] = sid
    return {"section": sid}


@handler("style_define")
def op_style_define(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    kind, name = _s(op, "kind"), _s(op, "name", limit=64)
    if kind not in ("paragraph", "character") or not _NAME.fullmatch(name):
        raise OpError("A style needs a name of letters, digits, spaces, dots, dashes or underscores")
    styles = copy.deepcopy(tr.key("styles") or {})
    group = styles.setdefault(kind, {})
    if op.get("delete"):
        group.pop(name, None)
        used = {b.get("style") for b in tr.doc["blocks"]}
        if kind == "paragraph" and name in used:
            raise Conflict(f"Style '{name}' is still in use")
    else:
        group[name] = copy.deepcopy(_d(op, "props"))
    if not group:
        styles.pop(kind, None)
    tr.doc["styles"] = styles
    if not styles:
        tr.doc.pop("styles", None)
    return {}


@handler("reference_put")
def op_reference_put(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    ref = copy.deepcopy(_d(op, "reference"))
    refs = copy.deepcopy(tr.key("references") or [])
    if not ref.get("id"):
        ref["id"] = f"{'fn' if ref.get('kind') == 'footnote' else 'c'}{uuid.uuid4().hex[:8]}"
    replaced = False
    for i, existing in enumerate(refs):
        if existing["id"] == ref["id"]:
            refs[i], replaced = ref, True
    if not replaced:
        refs.append(ref)
    tr.doc["references"] = refs
    return {"reference": ref["id"]}


@handler("reference_delete")
def op_reference_delete(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    rid = _s(op, "id")
    refs = [r for r in copy.deepcopy(tr.key("references") or []) if r["id"] != rid]
    for block in tr.doc["blocks"]:                              # spans that cite it go too (so the document stays valid)
        if any(s.get("type") == "ref" and s.get("ref") == rid for s in block.get("spans", ())):
            b = tr.get(block["id"])
            b["spans"] = [s for s in b["spans"] if not (s.get("type") == "ref" and s.get("ref") == rid)]
            if not b["spans"]:
                b.pop("spans")
    tr.set_key("references", refs or None)
    return {}


@handler("embed_put")
def op_embed_put(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    embed = copy.deepcopy(_d(op, "embed"))
    embeds = copy.deepcopy(tr.key("embeds") or [])
    if not embed.get("id"):
        embed["id"] = f"e{uuid.uuid4().hex[:8]}"
    for i, existing in enumerate(embeds):
        if existing["id"] == embed["id"]:
            embeds[i] = embed
            break
    else:
        embeds.append(embed)
    tr.doc["embeds"] = embeds
    return {"embed": embed["id"]}


@handler("embed_delete")
def op_embed_delete(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    eid = _s(op, "id")
    for block in list(tr.doc["blocks"]):
        if block.get("embed") == eid:
            tr.remove(block["id"])
    tr.set_key("embeds", [e for e in copy.deepcopy(tr.key("embeds") or []) if e["id"] != eid] or None)
    if not tr.doc["blocks"]:
        tr.insert(0, {"id": fresh_id(tr.doc), "type": "paragraph", "text": ""})
    return {}


def _check_layers(value: Any) -> None:
    """The layers of the page: the built-in ones (Text, Illustrations) and the ones the person added, each shown or hidden and locked or not."""
    if not isinstance(value, list) or len(value) > 50:
        raise OpError("layers must be a list of at most 50 layers")
    seen: set[str] = set()
    for layer in value:
        if not isinstance(layer, dict) or set(layer) - {"id", "name", "visible", "locked", "custom"}:
            raise OpError("A layer has an id, a name, visible, locked and custom")
        ident, name = layer.get("id"), layer.get("name")
        if not isinstance(ident, str) or not 1 <= len(ident) <= 64 or ident in seen:
            raise OpError("Every layer needs its own short id")
        seen.add(ident)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise OpError("A layer's name is 1 to 80 characters")
        for flag in ("visible", "locked", "custom"):
            if flag in layer and not isinstance(layer[flag], bool):
                raise OpError(f"A layer's {flag} is true or false")


def _check_layer_of(value: Any) -> None:
    """Which layer a block is on, when it is not the one its kind belongs to: {block id: layer id}."""
    if not isinstance(value, dict) or len(value) > 20000:
        raise OpError("layer_of must be an object with at most 20000 entries")
    for block, layer in value.items():
        if not isinstance(block, str) or not isinstance(layer, str) or not 1 <= len(block) <= 64 or not 1 <= len(layer) <= 64:
            raise OpError("layer_of maps a block id to a layer id")


@handler("ext_set")
def op_ext_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Writer's own notes in the document (guides, page background, view): stored under extensions['slai.writer'], which other
    readers ignore and preserve."""
    ext = copy.deepcopy(tr.key("extensions") or {})
    mine = ext.setdefault(WRITER_EXT, {})
    for key, value in (_d(op, "values") or {}).items():
        if key not in EXT_KEYS:
            raise OpError(f"Unknown setting '{key}'")
        if value is not None and key == "layers":
            _check_layers(value)
        if value is not None and key == "layer_of":
            _check_layer_of(value)
        if value is None:
            mine.pop(key, None)
        else:
            mine[key] = copy.deepcopy(value)
    if not mine:
        ext.pop(WRITER_EXT)
    tr.doc["extensions"] = ext
    if not ext:
        tr.doc.pop("extensions")
    return {}


@handler("batch")
def op_batch(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    ops = op.get("ops")
    if not isinstance(ops, list) or not ops or len(ops) > 5000:
        raise OpError("A batch needs 1 to 5000 operations")
    results = []
    for inner in ops:
        if not isinstance(inner, dict) or inner.get("op") not in HANDLERS or inner.get("op") == "batch":
            raise OpError("A batch holds ordinary operations only")
        results.append(HANDLERS[inner["op"]](tr, inner))
    return {"results": results}


LABELS = {
    "text": "typing", "format": "formatting", "span": "link or reference", "inline_object": "insert object", "block_set": "paragraph style",
    "block_insert": "insert block", "block_delete": "delete", "split": "new paragraph", "merge": "join paragraphs", "move": "move",
    "table_cell": "table cell", "table_edit": "table", "caption": "caption", "figure_set": "picture", "equation_set": "equation",
    "meta": "document details", "page_setup": "page setup", "section_break": "section break", "style_define": "style",
    "reference_put": "citation or footnote", "reference_delete": "remove citation", "embed_put": "EMBED", "embed_delete": "remove EMBED",
    "ext_set": "page settings", "batch": "edit",
}


def apply_operation(doc: dict[str, Any], op: dict[str, Any]) -> tuple[Undo, dict[str, Any], Tracker]:
    """Apply ``op`` to ``doc`` in place. Raises :class:`OpError` (and leaves ``doc`` as it was) when it does not fit."""
    if not isinstance(op, dict) or op.get("op") not in HANDLERS:
        raise OpError(f"Unknown operation {op.get('op') if isinstance(op, dict) else op!r}")
    tracker = Tracker(doc)
    try:
        result = HANDLERS[op["op"]](tracker, op)
    except BaseException:
        apply_undo(doc, tracker.undo)                           # put back whatever was already touched
        raise
    tracker.undo.label = op.get("label") or LABELS.get(op["op"], "edit")
    return tracker.undo, result, tracker
