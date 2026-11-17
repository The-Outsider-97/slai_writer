"""The kernel of document operations: what every operation module builds on.

This module holds the operation error, the undo record, the tracker that remembers the "before" state of everything a handler touches, the
field checkers and the handler registry. It imports nothing from the rest of Writer's operation modules, so :mod:`.ops`, :mod:`.tableops`,
:mod:`.columns`, :mod:`.book` and :mod:`.shape_validation` can all depend on it without depending on each other in a circle. :mod:`.ops`
re-exports every name defined here, so ``from .ops import OpError`` keeps working.
"""
from __future__ import annotations

import copy
import re
import uuid

from dataclasses import dataclass, field
from typing import Any, Callable

from ..tools.errors import BadRequest

MISSING = "\x00missing"
TEXT_TYPES = ("heading", "paragraph", "list_item", "quote", "code")
STRUCTURAL = ("table", "figure", "equation", "embed")
MAX_BLOCK_CHARS = 2_000_000
MAX_TABLE_CELLS = 20_000
WRITER_EXT = "slai.writer"
SEMANTIC_STYLES = frozenset({"Body Text", "Quote", "Title", "Subtitle", "Slogan", "Author", "Document Date", "TOC Title"}
                             | {f"Heading {n}" for n in range(1, 7)} | {f"TOC Level {n}" for n in range(1, 7)})
EXT_KEYS = ("guides", "background", "layers", "layer_of", "view", "dictionary", "spell_ignore", "proof_ignore", "signature_marks", "locks", "versions", "source_status")
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



LABELS = {
    "text": "typing", "format": "formatting", "span": "link or reference", "inline_object": "insert object", "block_set": "paragraph style",
    "block_insert": "insert block", "block_delete": "delete", "split": "new paragraph", "merge": "join paragraphs", "move": "move",
    "table_cell": "table cell", "table_cell_text": "table cell", "table_edit": "table", "table_cell_style": "table cell format",
    "table_layout": "table layout", "table_style": "table style", "table_borders": "table borders", "table_style_define": "table style", "caption": "caption", "figure_set": "picture", "shape_set": "shape", "equation_set": "equation",
    "meta": "document details", "page_setup": "page setup", "section_break": "section break", "style_define": "style",
    "reference_put": "citation or footnote", "reference_delete": "remove citation", "embed_put": "EMBED", "embed_delete": "remove EMBED",
    "ext_set": "page settings", "batch": "edit",
}
