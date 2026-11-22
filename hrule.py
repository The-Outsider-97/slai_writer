"""The horizontal rule: a paragraph-level formatting object that draws one line from the left to the right text margin.

SLDC has no paragraph-border or rule element, and a new block type would make every older reader refuse the file. A rule is therefore an *inert
carrier*, the way a vector shape is: an empty ``paragraph`` block whose namespaced extension ``slai.writer.rule`` says how the line looks. A reader
that does not know the extension shows an empty paragraph (nothing is lost, nothing breaks), and one that does draws the line. The line always spans
the whole text width of its column, whatever the margins, columns or paragraph indents around it are (see ``docs`` of the extension below).

``slai.writer.rule`` is ``{"style", "width_pt", "color", "space_before_pt", "space_after_pt"}``; every key is optional on disk and defaults to
:data:`DEFAULTS`, and Writer always writes all of them so another program need not know the defaults.

Operations: ``rule_insert`` (turn the paragraph that holds only ``___`` into a rule and open an empty paragraph below it, one undo step) and
``rule_set`` (change the look of a rule).
"""
from __future__ import annotations

import math
import re
from typing import Any

from .columns import BREAK_KEY, RULE_STYLES
from .opcore import HANDLERS, LABELS, OpError, Tracker, _d, _s, fresh_id, handler

RULE_KEY = "slai.writer.rule"
DEFAULTS: dict[str, Any] = {"style": "solid", "width_pt": 1.0, "color": "#404040", "space_before_pt": 6.0, "space_after_pt": 6.0}
_NUMBERS = {"width_pt": (0.25, 12.0), "space_before_pt": (0.0, 72.0), "space_after_pt": (0.0, 72.0)}
_COLOUR = re.compile(r"#[0-9a-fA-F]{6}")
#: Exactly three underscores and nothing else but blanks. Four or more are an ordinary line of underscores.
TRIGGER = re.compile(r"[ \t ]*___[ \t ]*")
#: What a rule carrier may hold besides the rule itself: a page break and a column break belong to the start of the paragraph the rule replaced.
_ALLOWED_ATTRIBUTES = {"page_break_before"}


def is_rule(block: dict[str, Any]) -> bool:
    return RULE_KEY in (block.get("extensions") or {})


def normalise(value: Any) -> dict[str, Any]:
    """A rule description made complete (defaults filled in) and checked. Raises :class:`OpError` for anything Writer would not write."""
    if not isinstance(value, dict):
        raise OpError("A rule is described by an object")
    unknown = set(value) - set(DEFAULTS)
    if unknown:
        raise OpError(f"A rule holds only style, width_pt, color, space_before_pt and space_after_pt, not {sorted(unknown)}")
    rule = {**DEFAULTS, **value}
    if rule["style"] not in RULE_STYLES:
        raise OpError("A rule is solid, dashed, dotted or double")
    if not isinstance(rule["color"], str) or not _COLOUR.fullmatch(rule["color"]):
        raise OpError("The rule colour must be #rrggbb")
    for key, (low, high) in _NUMBERS.items():
        number = rule[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or not low <= number <= high:
            raise OpError(f"The rule's {key} must be a number from {low} to {high}")
        rule[key] = float(number)
    return rule


def check_block(block: dict[str, Any]) -> None:
    """The invariants of a rule carrier. Called after every operation that touched one, so no edit can put text or formatting into a rule."""
    if block["type"] != "paragraph" or block.get("text") or block.get("spans"):
        raise OpError("A horizontal rule holds no text; it is its own paragraph")
    if set(block.get("extensions") or {}) - {RULE_KEY, BREAK_KEY}:
        raise OpError("A horizontal rule cannot also be a shape, table of contents or other object")
    if set(block.get("attributes") or {}) - _ALLOWED_ATTRIBUTES or block.get("style"):
        raise OpError("A horizontal rule has no paragraph style or text formatting; change the line itself instead")
    block["extensions"][RULE_KEY] = normalise(block["extensions"][RULE_KEY])


def is_trigger(text: str) -> bool:
    return TRIGGER.fullmatch(text) is not None


@handler("rule_insert")
def op_rule_insert(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Replace the paragraph that holds only ``___`` with a rule, and open an empty paragraph below it for the next line of text."""
    block = tr.get(op.get("block"))
    if block["type"] != "paragraph" or is_rule(block) or set(block.get("extensions") or {}) - {BREAK_KEY}:
        raise OpError("A rule replaces an ordinary paragraph that holds only three underscores")
    if not is_trigger(block.get("text", "")):
        raise OpError("A rule replaces a paragraph that holds only three underscores")
    rule = normalise(_d(op, "rule", required=False) or {})
    new_id = _s(op, "new_id", required=False) or fresh_id(tr.doc)
    keep = {key: block["attributes"][key] for key in _ALLOWED_ATTRIBUTES if key in (block.get("attributes") or {})}
    block["text"] = ""
    for key in ("spans", "style", "attributes"):
        block.pop(key, None)
    if keep:
        block["attributes"] = keep
    block.setdefault("extensions", {})[RULE_KEY] = rule
    fresh: dict[str, Any] = {"id": new_id, "type": "paragraph", "text": ""}
    if block.get("section"):
        fresh["section"] = block["section"]
    tr.insert(tr.position(block["id"]) + 1, fresh)
    return {"block": new_id, "rule": block["extensions"][RULE_KEY]}


@handler("rule_set")
def op_rule_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Change the look of a rule (thickness, colour, style, spacing). Only the given keys change."""
    block = tr.get(op.get("block"))
    if not is_rule(block):
        raise OpError("This block is not a horizontal rule")
    block["extensions"][RULE_KEY] = normalise({**block["extensions"][RULE_KEY], **(_d(op, "rule") or {})})
    return {"rule": block["extensions"][RULE_KEY]}


LABELS.update({"rule_insert": "horizontal rule", "rule_set": "horizontal rule format"})
assert "rule_insert" in HANDLERS
