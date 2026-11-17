"""Page and section columns, column breaks and the Scripture style.

Where things live (nothing here is CSS-only):

* ``sections[i].columns`` (1-8 in the format, Writer offers 1-4) and ``sections[i].column_gap_mm`` are the core SLDC fields every reader understands.
* What the core format has no field for lives in Writer's own document extension ``slai.writer.column_layouts`` (keyed by section id):
  ``rule`` (the line between columns: colour, width_pt, style), ``widths_mm`` (unequal column widths), ``balance``, ``flow`` (ltr or rtl)
  and ``continuous`` (the section starts on the page of the one before it, which is how a selection gets its own columns in the middle of a page).
  Readers that do not know the extension ignore and keep it.
* ``scripture`` (in the same layout entry) marks a section that the Scripture paragraph style made: its two columns belong to that style and go away
  again, paragraph by paragraph, when a paragraph stops being Scripture. Any column change the person makes by hand takes the mark off, because
  those columns are theirs then.
* A column break is the block extension ``slai.writer.column_break`` (``{"before": true}``): the block starts in the next column
  (in a one-column section it starts a new page, as in Word).

Scope of a change: the entire document, the current section, or a selection (whole paragraphs; a selection inside a paragraph takes the paragraph).
A selection is carried out with the existing section infrastructure: the selected blocks move into their own continuous section and the
text before and after stays in sections that look exactly as before. Repeating the same change changes nothing.
"""
from __future__ import annotations

import copy
import json
import math
from typing import Any

from .opcore import (DEFAULT_SECTION, HANDLERS, LABELS, OpError, TEXT_TYPES, Tracker, WRITER_EXT, _i, _tidy_attributes, handler,
                     repair_sections)
from .shape_validation import SHAPE_KEY

LAYOUTS = "column_layouts"
BREAK_KEY = "slai.writer.column_break"
MAX_COLUMNS = 4
DEFAULT_GAP_MM = 10.0
RULE_STYLES = ("solid", "dashed", "dotted", "double")
FLOWS = ("ltr", "rtl")
SCRIPTURE = "Scripture"
SCRIPTURE_PROPS = {"font_family": "Times New Roman", "font_size_pt": 11, "italic": True, "align": "left"}


# ------------------------------------------------------------------------------------------------------------- the stored layout
def check_layout(entry: Any, columns: int) -> None:
    """Raise when a stored column layout is not one Writer would write."""
    if not isinstance(entry, dict) or set(entry) - {"rule", "widths_mm", "balance", "flow", "continuous", "scripture"}:
        raise OpError("A column layout holds only rule, widths_mm, balance, flow, continuous and scripture")
    rule = entry.get("rule")
    if rule is not None:
        if not isinstance(rule, dict) or set(rule) - {"color", "width_pt", "style"}:
            raise OpError("The line between columns holds only colour, width and style")
        colour = rule.get("color", "#000000")
        if not isinstance(colour, str) or len(colour) != 7 or not colour.startswith("#") or any(c not in "0123456789abcdefABCDEF" for c in colour[1:]):
            raise OpError("The column line colour must be #rrggbb")
        width = rule.get("width_pt", 0.75)
        if isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or not 0.25 <= width <= 6:
            raise OpError("The column line is between 0.25 and 6 points thick")
        if rule.get("style", "solid") not in RULE_STYLES:
            raise OpError("The column line is solid, dashed, dotted or double")
    widths = entry.get("widths_mm")
    if widths is not None:
        if (not isinstance(widths, list) or len(widths) != columns or columns < 2
                or any(isinstance(w, bool) or not isinstance(w, (int, float)) or not math.isfinite(w) or not 10 <= w <= 500 for w in widths)):
            raise OpError(f"Unequal widths need one width (10 to 500 mm) for each of the {columns} columns")
    for key in ("balance", "continuous", "scripture"):
        if key in entry and not isinstance(entry[key], bool):
            raise OpError(f"'{key}' must be true or false")
    if entry.get("flow", "ltr") not in FLOWS:
        raise OpError("The column flow is ltr or rtl")


def validate_document(doc: dict[str, Any]) -> None:
    """Called after every change: the extension may only describe sections that exist, and a column break only sits on a block."""
    mine = (doc.get("extensions") or {}).get(WRITER_EXT) or {}
    layouts = mine.get(LAYOUTS)
    if layouts is None:
        return
    if not isinstance(layouts, dict):
        raise OpError("column_layouts must be an object")
    sections = {s["id"]: s for s in doc.get("sections") or []}
    for sid, entry in layouts.items():
        if sid not in sections:
            raise OpError(f"A column layout belongs to section '{sid}', which does not exist")
        check_layout(entry, int(sections[sid].get("columns", 1)))


def layouts_of(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return ((doc.get("extensions") or {}).get(WRITER_EXT) or {}).get(LAYOUTS) or {}


# ------------------------------------------------------------------------------------------------------------- helpers on the tracker
def _read_layouts(tr: Tracker) -> dict[str, dict[str, Any]]:
    return copy.deepcopy(((tr.key("extensions") or {}).get(WRITER_EXT) or {}).get(LAYOUTS) or {})


def _write_layouts(tr: Tracker, layouts: dict[str, dict[str, Any]], sections: list[dict[str, Any]]) -> None:
    live = {sid: v for sid, v in layouts.items() if v and any(s["id"] == sid for s in sections)}
    ext = copy.deepcopy(tr.key("extensions") or {})
    mine = ext.setdefault(WRITER_EXT, {})
    if live:
        mine[LAYOUTS] = live
    else:
        mine.pop(LAYOUTS, None)
    if not mine:
        ext.pop(WRITER_EXT)
    if ext:
        tr.doc["extensions"] = ext
    else:
        tr.doc.pop("extensions", None)


def _ensure_sections(tr: Tracker) -> list[dict[str, Any]]:
    sections = copy.deepcopy(tr.key("sections") or [])
    if not sections:
        sections = [{"id": DEFAULT_SECTION}]
    first = sections[0]["id"]
    for block in tr.doc["blocks"]:
        if not block.get("section"):
            tr.get(block["id"])["section"] = first
    return sections


def _new_id(sections: list[dict[str, Any]]) -> str:
    n = len(sections) + 1
    while any(s["id"] == f"s{n}" for s in sections):
        n += 1
    return f"s{n}"


def _copy_for_continuation(section: dict[str, Any], new_id: str) -> dict[str, Any]:
    fresh = {k: copy.deepcopy(v) for k, v in section.items() if k != "id"}
    numbering = fresh.get("numbering")
    if isinstance(numbering, dict):
        numbering.pop("start", None)                      # page numbers must not start over where only the columns change
        if not numbering:
            fresh.pop("numbering")
    fresh["id"] = new_id
    return fresh


def _blocks_of(tr: Tracker, section_id: str) -> list[int]:
    return [i for i, b in enumerate(tr.doc["blocks"]) if b.get("section") == section_id]


def _signature(section: dict[str, Any], layout: dict[str, Any]) -> str:
    plain = {k: v for k, v in section.items() if k != "id"}
    if isinstance(plain.get("numbering"), dict):
        plain["numbering"] = {k: v for k, v in plain["numbering"].items() if k != "start"}
    return json.dumps([plain, {k: v for k, v in layout.items() if k != "continuous"}], sort_keys=True)


def _coalesce(tr: Tracker, sections: list[dict[str, Any]], layouts: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Join a continuous section that Writer made with the section before it when nothing tells them apart any more."""
    kept: list[dict[str, Any]] = []
    for section in sections:
        previous = kept[-1] if kept else None
        layout = layouts.get(section["id"], {})
        if (previous is not None and layout.get("continuous")
                and _signature(section, layout) == _signature(previous, layouts.get(previous["id"], {}))):
            for block in tr.doc["blocks"]:
                if block.get("section") == section["id"]:
                    tr.get(block["id"])["section"] = previous["id"]
            layouts.pop(section["id"], None)
            continue
        kept.append(section)
    return kept


def _isolate(tr: Tracker, sections: list[dict[str, Any]], layouts: dict[str, dict[str, Any]], first: str, last: str) -> list[str]:
    """Give the blocks from ``first`` to ``last`` sections of their own (one per section the range touches). Returns the ids of those sections."""
    blocks = tr.doc["blocks"]
    p0, p1 = tr.position(first), tr.position(last)
    if p0 > p1:
        p0, p1 = p1, p0
    default = sections[0]["id"]
    sid_at = lambda i: blocks[i].get("section") or default                      # noqa: E731
    targets: list[str] = []
    for sid in dict.fromkeys(sid_at(i) for i in range(p0, p1 + 1)):
        mine = [i for i in range(len(blocks)) if sid_at(i) == sid]
        a, b = max(p0, mine[0]), min(p1, mine[-1])
        original = next(s for s in sections if s["id"] == sid)
        at = sections.index(original)
        tail_id = range_id = None
        insert_at = at + 1
        if b < mine[-1]:                                                         # text after the range stays as it was, in a section of its own
            tail_id = _new_id(sections)
            tail = _copy_for_continuation(original, tail_id)
            sections.insert(insert_at, tail)
            layouts[tail_id] = {**copy.deepcopy(layouts.get(sid, {})), "continuous": True}
            for i in range(b + 1, mine[-1] + 1):
                tr.get(blocks[i]["id"])["section"] = tail_id
        if a > mine[0]:                                                          # text before the range stays in the original section
            range_id = _new_id(sections)
            head = _copy_for_continuation(original, range_id)
            sections.insert(insert_at, head)
            layouts[range_id] = {**copy.deepcopy(layouts.get(sid, {})), "continuous": True}
            for i in range(a, b + 1):
                tr.get(blocks[i]["id"])["section"] = range_id
        targets.append(range_id or sid)
    return targets


def _apply(section: dict[str, Any], layout: dict[str, Any], op: dict[str, Any]) -> None:
    """Change the columns, gap, widths, line, balance and flow named in ``op`` (whatever it leaves out stays as it is)."""
    if "columns" in op:
        count = _i(op, "columns", 1, MAX_COLUMNS)
        if count != int(section.get("columns", 1)):
            layout.pop("widths_mm", None)                                        # widths belong to a number of columns
        if count == 1:
            section.pop("columns", None)
            if "gap_mm" not in op:
                section.pop("column_gap_mm", None)                               # a gap is only there for columns
        else:
            section["columns"] = count
            section.setdefault("column_gap_mm", DEFAULT_GAP_MM)
    columns = int(section.get("columns", 1))
    if "gap_mm" in op:
        gap = op["gap_mm"]
        if gap is None:
            section.pop("column_gap_mm", None)
        elif isinstance(gap, bool) or not isinstance(gap, (int, float)) or not math.isfinite(gap) or not 0 <= gap <= 50:
            raise OpError("The space between columns is 0 to 50 mm")
        else:
            section["column_gap_mm"] = round(float(gap), 2)
    if columns == 1:
        for key in ("rule", "widths_mm", "balance", "flow"):
            layout.pop(key, None)
    for key in ("rule", "widths_mm", "balance", "flow"):
        if key in op and columns > 1:
            if op[key] is None:
                layout.pop(key, None)
            else:
                layout[key] = copy.deepcopy(op[key])
    if "rule" in layout and isinstance(layout["rule"], dict):
        layout["rule"] = {"color": layout["rule"].get("color", "#000000"), "width_pt": layout["rule"].get("width_pt", 0.75),
                          "style": layout["rule"].get("style", "solid")}
    if op.get("scripture") is True and columns > 1:
        layout["scripture"] = True                                               # these columns come from the Scripture style
    else:
        layout.pop("scripture", None)                                            # columns the person sets are theirs, whatever style the text has
    if layout.get("flow") == "ltr":
        layout.pop("flow")                                                       # left to right is what an absent value means
    if layout.get("balance") is False:
        layout.pop("balance")
    check_layout(layout, columns)


def group_members(sections: list[dict[str, Any]], layouts: dict[str, dict[str, Any]], section_id: str) -> list[str]:
    """The sections that share a page with ``section_id``: a continuous section with the same page setup as the one before it belongs to that one's group.
    A change of page size, margins, header or footer has to reach all of them, or the sections would start new pages."""
    groups: dict[str, str] = {}
    previous: dict[str, Any] | None = None
    for section in sections:
        same = previous is not None and layouts.get(section["id"], {}).get("continuous") is True and \
            json.dumps(previous.get("page", {}), sort_keys=True) == json.dumps(section.get("page", {}), sort_keys=True)
        groups[section["id"]] = groups[previous["id"]] if same and previous else section["id"]
        previous = section
    mine = groups.get(section_id)
    return [s["id"] for s in sections if groups[s["id"]] == mine] if mine else [section_id]


# ------------------------------------------------------------------------------------------------------------- the operations
@handler("columns_set")
def op_columns_set(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Set columns (1-4), gap, unequal widths, the line between columns, balance and flow order for the entire document, one section or a selection.

    ``scope``: "document" | "section" (``section`` id, or the section of ``block``) | "selection" (``block`` .. ``end_block``, whole paragraphs).
    """
    scope = op.get("scope", "section")
    if scope not in ("document", "section", "selection"):
        raise OpError("The scope is document, section or selection")
    if not tr.doc["blocks"]:
        raise OpError("There is nothing to set columns for")
    sections = _ensure_sections(tr)
    layouts = _read_layouts(tr)
    if scope == "document":
        targets = [s["id"] for s in sections]
    elif scope == "section":
        if op.get("section"):
            targets = [str(op["section"])]
        elif op.get("block"):
            targets = [tr.get(op["block"]).get("section") or sections[0]["id"]]
        else:
            targets = [sections[0]["id"]]
        if targets[0] not in {s["id"] for s in sections}:
            raise OpError(f"There is no section '{targets[0]}'")
    else:
        start = op.get("block")
        end = op.get("end_block") or start
        if not start:
            raise OpError("A selection needs the block it starts in")
        tr.get(start), tr.get(end)
        targets = _isolate(tr, sections, layouts, start, end)
    for section in sections:
        if section["id"] in targets:
            _apply(section, layouts.setdefault(section["id"], {}), op)
            if not layouts[section["id"]]:
                layouts.pop(section["id"])
    if scope == "selection":
        sections = _coalesce(tr, sections, layouts)
        # `_coalesce` may have merged a target away; report where the text ended up.
        targets = list(dict.fromkeys((tr.get(op["block"]).get("section") or sections[0]["id"],
                                      tr.get(op.get("end_block") or op["block"]).get("section") or sections[0]["id"])))
    tr.doc["sections"] = sections
    repair_sections(tr)
    _write_layouts(tr, layouts, sections)
    return {"sections": targets}


@handler("column_break")
def op_column_break(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """Start the next column at a block, or (with ``at``) at a place inside a paragraph, which is first split in two.
    ``remove`` takes a break away again. In a one-column section a column break starts a new page."""
    block = tr.get(op.get("block"))
    if op.get("remove"):
        extensions = dict(block.get("extensions") or {})
        extensions.pop(BREAK_KEY, None)
        if extensions:
            block["extensions"] = extensions
        else:
            block.pop("extensions", None)
        return {"block": block["id"]}
    result: dict[str, Any] = {}
    at = op.get("at")
    if at not in (None, 0):
        if block["type"] not in TEXT_TYPES:
            raise OpError("A column break can only be put inside text")
        result = HANDLERS["split"](tr, {"block": block["id"], "at": _i(op, "at"), "keep_type": True})
        block = tr.get(result["block"])
    if block["type"] == "table" and block.get("extensions", {}).get(BREAK_KEY):
        return {"block": block["id"]}
    block["extensions"] = {**(block.get("extensions") or {}), BREAK_KEY: {"before": True}}
    return {"block": block["id"], **({"split": True} if result else {})}


@handler("scripture_apply")
def op_scripture_apply(tr: Tracker, op: dict[str, Any]) -> dict[str, Any]:
    """The Scripture paragraph style on the selected paragraphs, and a two-column section around them.

    The paragraph style (Times New Roman, 11 pt, italic, left aligned, automatic colour, default spacing, left-to-right) is what the text looks like;
    the two columns are a section (the style cannot hold them). Applying it again to the same text changes nothing.
    """
    start = op.get("block")
    end = op.get("end_block") or start
    if not start:
        raise OpError("Select the text to set as Scripture")
    p0, p1 = sorted((tr.position(start), tr.position(end)))
    chosen = [b for b in tr.doc["blocks"][p0:p1 + 1] if _is_text(b)]
    if not chosen:
        raise OpError("Scripture style applies to text paragraphs")
    styles = copy.deepcopy(tr.key("styles") or {})
    if SCRIPTURE not in styles.setdefault("paragraph", {}):                      # the person may have edited the definition: keep it
        styles["paragraph"][SCRIPTURE] = dict(SCRIPTURE_PROPS)
    tr.doc["styles"] = styles
    for block in chosen:
        target = tr.get(block["id"])
        target["style"] = SCRIPTURE
        attrs = dict(target.get("attributes") or {})
        for key in ("align", "line_height", "space_before_pt", "space_after_pt", "indent_mm", "first_line_indent_mm"):
            attrs.pop(key, None)                                                  # direct paragraph formatting would hide the style
        if attrs:
            target["attributes"] = attrs
        else:
            target.pop("attributes", None)
        if target["type"] != "paragraph":
            target["type"] = "paragraph"
            _tidy_attributes(target)
    inner = {"op": "columns_set", "scope": "selection", "block": chosen[0]["id"], "end_block": chosen[-1]["id"], "columns": 2, "scripture": True}
    return {"blocks": [b["id"] for b in chosen], **op_columns_set(tr, inner)}


def _is_text(block: dict[str, Any]) -> bool:
    """A paragraph the Scripture style can apply to: text, not code, and not the inert carrier of a vector shape or text box."""
    return block["type"] in TEXT_TYPES and block["type"] != "code" and SHAPE_KEY not in (block.get("extensions") or {})


def _scripture_sync(tr: Tracker) -> None:
    """The two columns of a Scripture section belong to the Scripture style. A paragraph in such a section that is no longer Scripture (switched to
    Normal text, a heading, a list ...) goes back to the one column it would have had; paragraphs around it keep their columns, and so does every
    section the style did not make. Undo restores both together because it restores the document as it was."""
    layouts = copy.deepcopy(layouts_of(tr.doc))            # read straight from the document: asking the tracker for the key would report a document change on every edit
    flagged = [sid for sid, entry in layouts.items() if entry.get("scripture")]
    if not flagged:
        return
    blocks = tr.doc["blocks"]
    runs: list[tuple[str, str]] = []
    for sid in flagged:
        members = _blocks_of(tr, sid)
        if not members:
            continue
        texts = [i for i in members if _is_text(blocks[i])]
        if not any(blocks[i].get("style") == SCRIPTURE for i in texts):          # nothing of the style is left: the whole section goes back
            runs.append((blocks[members[0]]["id"], blocks[members[-1]]["id"]))
            continue
        start = None
        for i in members:
            stray = _is_text(blocks[i]) and blocks[i].get("style") != SCRIPTURE
            if stray and start is None:
                start = i
            if not stray and start is not None:
                runs.append((blocks[start]["id"], blocks[i - 1]["id"]))
                start = None
        if start is not None:
            runs.append((blocks[start]["id"], blocks[members[-1]]["id"]))
    if not runs:
        return
    sections = _ensure_sections(tr)
    for first, last in runs:
        for target in _isolate(tr, sections, layouts, first, last):
            section = next(x for x in sections if x["id"] == target)
            _apply(section, layouts.setdefault(target, {}), {"columns": 1})
            if not layouts[target]:
                layouts.pop(target)
    sections = _coalesce(tr, sections, layouts)
    tr.doc["sections"] = sections
    repair_sections(tr)
    _write_layouts(tr, layouts, sections)


def reconcile(tr: Tracker) -> None:
    """Keep the extension in step with the sections: drop layouts of sections that are gone and widths that no longer match the column count."""
    _scripture_sync(tr)
    mine = ((tr.doc.get("extensions") or {}).get(WRITER_EXT) or {})
    if not mine.get(LAYOUTS):
        return
    sections = list(tr.doc.get("sections") or [])
    layouts = _read_layouts(tr)
    changed = False
    for sid in list(layouts):
        section = next((s for s in sections if s["id"] == sid), None)
        if section is None:
            layouts.pop(sid)
            changed = True
            continue
        columns = int(section.get("columns", 1))
        if columns == 1:
            for key in ("rule", "widths_mm", "balance", "flow"):
                changed |= layouts[sid].pop(key, None) is not None
        elif layouts[sid].get("widths_mm") is not None and len(layouts[sid]["widths_mm"]) != columns:
            layouts[sid].pop("widths_mm")
            changed = True
        if not layouts[sid]:
            layouts.pop(sid)
            changed = True
    if changed:
        _write_layouts(tr, layouts, sections)


def inherit(tr: Tracker, from_id: str, to_id: str) -> None:
    """A section that starts with a section break looks like the one before it, columns included."""
    layouts = _read_layouts(tr)
    if from_id in layouts:
        copied = {k: copy.deepcopy(v) for k, v in layouts[from_id].items() if k != "continuous"}
        if copied:
            layouts[to_id] = copied
            _write_layouts(tr, layouts, list(tr.doc.get("sections") or []))


LABELS.update({"columns_set": "columns", "column_break": "column break", "scripture_apply": "Scripture style"})
