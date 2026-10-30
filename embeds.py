"""EMBED: inert, locked, declarative components.

An EMBED in a document is a *declaration* (kind, schema version, parameters, hashed inputs, requested capabilities) plus the text of its
last valid output. Writer never runs code that comes from a document. It only evaluates declarations whose ``kind`` is in the small
registry below - pure functions of the text and tables the declaration names - after validating every parameter against that kind's schema.
Consequences, all enforced here and tested:

* no network, no files, no clock, no randomness: a kind cannot ask for a capability, and a document that requests one is shown but not run;
* an output is bound to the exact input content (SHA-256) and to the document version; a changed input or a stale screen cannot apply it;
* a request from the interface, from the language agent or from another document is never an authorization: access follows the
  signed-in account's role on this computer, and a locked component's parameters are not even sent to a viewer without access;
* Apply is unavailable until the declaration validates.

Honest limit: a lock hides a component *inside Writer*. The file itself is not encrypted by it; encrypt the document (SLDC password) when
the source must stay private.
"""
from __future__ import annotations

import copy
import hashlib
import re
import uuid
from typing import Any, Callable

from ..tools.errors import BadRequest, Conflict, DependencyMissing, Forbidden, NotFound
from .session import DocumentSession, block_plain, sldc

KIND = re.compile(r"^[a-z][a-z0-9_.-]{1,63}$")
MAX_OUTPUT = 4000


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def block_digest(block: dict[str, Any]) -> str:
    if block["type"] == "table":
        return sha("\x1f".join("\x1e".join(c["text"] for c in row) for row in block["table"]["rows"]))
    return sha(block.get("text", ""))


# ------------------------------------------------------------------------------------------------------------- schema
def check_params(schema: dict[str, dict[str, Any]], params: Any) -> list[dict[str, str]]:
    """A deliberately small validator: every parameter is declared, typed and bounded; unknown parameters are errors."""
    errors: list[dict[str, str]] = []
    if not isinstance(params, dict):
        return [{"path": "params", "message": "Parameters must be an object."}]
    for name in params:
        if name not in schema:
            errors.append({"path": f"params.{name}", "message": "This parameter is not part of the component."})
    for name, rule in schema.items():
        if name not in params:
            if rule.get("required"):
                errors.append({"path": f"params.{name}", "message": "This parameter is required."})
            continue
        value = params[name]
        kind = rule["type"]
        if kind == "int":
            ok = isinstance(value, int) and not isinstance(value, bool)
        elif kind == "bool":
            ok = isinstance(value, bool)
        elif kind == "str":
            ok = isinstance(value, str)
        else:
            ok = False
        if not ok:
            errors.append({"path": f"params.{name}", "message": f"Expected {kind}."})
            continue
        if kind == "int" and not rule.get("min", -10**9) <= value <= rule.get("max", 10**9):
            errors.append({"path": f"params.{name}", "message": f"Must be between {rule.get('min')} and {rule.get('max')}."})
        if kind == "str" and len(value) > rule.get("max_len", 200):
            errors.append({"path": f"params.{name}", "message": f"At most {rule.get('max_len', 200)} characters."})
        if "enum" in rule and value not in rule["enum"]:
            errors.append({"path": f"params.{name}", "message": "Choose one of: " + ", ".join(map(str, rule["enum"])) + "."})
    return errors


# ------------------------------------------------------------------------------------------------------------ kinds
class Invalid(Exception):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__(errors[0]["message"])
        self.errors = errors


def _fmt(n: float, decimals: int) -> str:
    return f"{n:,.{decimals}f}"


def run_stats(params: dict[str, Any], inputs: list[dict[str, Any]]) -> str:
    text = "\n".join(block_plain(b) for b in inputs if b["type"] != "table")
    metric = params["metric"]
    if metric == "words":
        n = len(re.findall(r"\w+", text, re.U))
    elif metric == "characters":
        n = len(text)
    elif metric == "sentences":
        n = len([s for s in re.split(r"[.!?]+(?:\s|$)", text) if s.strip()])
    else:
        n = len([b for b in inputs if b["type"] != "table" and block_plain(b).strip()])
    return f"{metric.capitalize()}: {n:,}"


def run_excerpt(params: dict[str, Any], inputs: list[dict[str, Any]]) -> str:
    text = block_plain(inputs[0]).strip()
    limit = params.get("max_chars", 300)
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return f"“{text}”" if params.get("quote", True) else text


def run_table_total(params: dict[str, Any], inputs: list[dict[str, Any]]) -> str:
    block = inputs[0]
    if block["type"] != "table":
        raise Invalid([{"path": "inputs[0]", "message": "This component needs a table."}])
    rows = block["table"]["rows"][block["table"].get("header_rows", 0):]
    col, values, errors = params["column"], [], []
    for r, row in enumerate(rows):
        if col >= len(row):
            errors.append({"path": f"table.row{r + 1}", "message": f"Row {r + 1} has no column {col + 1}."})
            continue
        cell = row[col]["text"].strip().replace(",", "").replace(" ", "")
        try:
            values.append(float(cell))
        except ValueError:
            errors.append({"path": f"table.row{r + 1}.col{col + 1}", "message": f"“{row[col]['text'].strip()[:30]}” is not a number."})
    if errors:
        raise Invalid(errors[:10])
    if not values:
        raise Invalid([{"path": "table", "message": "The table has no data rows."}])
    op = params["operation"]
    result = {"sum": sum(values), "mean": sum(values) / len(values), "min": min(values), "max": max(values)}[op]
    return f"{op.capitalize()}: {_fmt(result, params.get('decimals', 2))}"


KINDS: dict[str, dict[str, Any]] = {
    "writer.stats": {
        "label": "Count words, characters or sentences", "inputs": (1, 20), "run": run_stats,
        "params": {"title": {"type": "str", "max_len": 80}, "metric": {"type": "str", "required": True, "enum": ["words", "characters", "sentences", "paragraphs"]}},
        "describes": "Counts what the chosen text contains."},
    "writer.excerpt": {
        "label": "Quote an excerpt of another passage", "inputs": (1, 1), "run": run_excerpt,
        "params": {"title": {"type": "str", "max_len": 80}, "max_chars": {"type": "int", "min": 20, "max": 2000}, "quote": {"type": "bool"}},
        "describes": "Copies the start of a passage verbatim; it never rewrites it."},
    "writer.table_total": {
        "label": "Total, average, smallest or largest value of a table column", "inputs": (1, 1), "run": run_table_total,
        "params": {"title": {"type": "str", "max_len": 80}, "column": {"type": "int", "required": True, "min": 0, "max": 99},
                   "operation": {"type": "str", "required": True, "enum": ["sum", "mean", "min", "max"]}, "decimals": {"type": "int", "min": 0, "max": 6}},
        "describes": "Calculates from numbers that are in the table; a cell that is not a number is an error, never a guess."},
}
GUARANTEES = {"network": "denied", "files": "none (no file or folder access; inputs are the named blocks of this document)",
              "clock": "none", "code": "none (declarations only)"}


class Embeds:
    def __init__(self, app: Any) -> None:
        self.app = app

    # ----------------------------------------------------------------------------------------------------- catalogue
    def catalogue(self, plan: str) -> dict[str, Any]:
        level = self.app.plans.embed_level(plan)
        return {"level": level, "kinds": [{"kind": k, "label": v["label"], "describes": v["describes"], "inputs": list(v["inputs"]),
                                          "params": v["params"], "version": 1} for k, v in KINDS.items()],
                "guarantees": GUARANTEES,
                "note": "Components are declarations. Writer only runs the kinds listed here, and none of them can reach the network or your files."}

    # -------------------------------------------------------------------------------------------------------- access
    def locks(self, session: DocumentSession) -> dict[str, Any]:
        return ((session.doc.get("extensions") or {}).get("slai.writer") or {}).get("locks") or {}

    def view(self, session: DocumentSession, embed_id: str) -> dict[str, Any]:
        """What this viewer may see of one component (a locked one without access shows no parameters)."""
        decl = self._decl(session, embed_id)
        lock = self.locks(session).get(embed_id)
        role = session.role()
        granted = not lock or role == "owner"
        out: dict[str, Any] = {"id": embed_id, "kind": decl["kind"], "version": decl["schema_version"], "locked": bool(lock), "role": role,
                               "access": "granted" if granted else "denied", "guarantees": GUARANTEES,
                               "capabilities": decl.get("capabilities", []), "known": decl["kind"] in KINDS}
        block = next((b for b in session.doc["blocks"] if b.get("embed") == embed_id), None)
        out["block"] = block["id"] if block else None
        out["output"] = block["text"] if block else ""
        if lock:
            out["lock"] = {"label": lock.get("label", "Locked component"), "requires": lock.get("requires", "owner"), "summary": lock.get("summary", "")}
        if granted:
            out.update({"params": decl.get("params", {}), "inputs": decl.get("inputs", []), "outputSha256": decl.get("output_sha256")})
        else:
            out["message"] = f"Access denied: the role “{role}” cannot open the source. The public summary remains available."
        return out

    def _decl(self, session: DocumentSession, embed_id: str) -> dict[str, Any]:
        decl = next((e for e in session.doc.get("embeds", []) if e["id"] == embed_id), None)
        if decl is None:
            raise NotFound("That component no longer exists.")
        return decl

    def request_access(self, session: DocumentSession) -> None:
        raise DependencyMissing("Requesting access needs a shared workspace, which this installation does not have.",
                                hint="Ask the owner to share a copy without the locked source, or sign in as the owner (Verify identity).")

    def lock(self, session: DocumentSession, embed_id: str, label: str, summary: str) -> dict[str, Any]:
        self._decl(session, embed_id)
        if session.role() != "owner":
            raise Forbidden("Only the owner can lock a component.")
        locks = dict(self.locks(session))
        locks[embed_id] = {"requires": "owner", "label": (label or "Locked component")[:80], "summary": (summary or "")[:500]}
        return session.apply({"op": "ext_set", "values": {"locks": locks}}, None)

    def unlock(self, session: DocumentSession, embed_id: str) -> dict[str, Any]:
        if session.role() != "owner":
            raise Forbidden("Only the owner can remove a lock.")
        locks = dict(self.locks(session))
        locks.pop(embed_id, None)
        return session.apply({"op": "ext_set", "values": {"locks": locks or None}}, None)

    # ------------------------------------------------------------------------------------------------------ evaluate
    def validate(self, session: DocumentSession, declaration: dict[str, Any]) -> dict[str, Any]:
        """Check a declaration and, when it is valid, compute what it would output. Nothing in the document changes."""
        errors: list[dict[str, str]] = []
        kind = declaration.get("kind")
        spec = KINDS.get(kind) if isinstance(kind, str) else None
        if spec is None:
            return {"valid": False, "errors": [{"path": "kind", "message": f"“{kind}” is not a component Writer can run. Available: " + ", ".join(KINDS) + "."}], "output": None}
        if declaration.get("capabilities"):
            errors.append({"path": "capabilities", "message": "This component asks for capabilities. Writer does not grant any: network and files are denied."})
        errors += check_params(spec["params"], declaration.get("params", {}))
        refs = declaration.get("inputs", [])
        low, high = spec["inputs"]
        if not isinstance(refs, list) or not low <= len(refs) <= high:
            errors.append({"path": "inputs", "message": f"Name {low if low == high else f'{low} to {high}'} input block(s)."})
            refs = []
        blocks = []
        index = {b["id"]: b for b in session.doc["blocks"]}
        for i, ref in enumerate(refs):
            block = index.get(ref.get("ref")) if isinstance(ref, dict) else None
            if block is None:
                errors.append({"path": f"inputs[{i}]", "message": "That input block does not exist."})
            elif block["type"] == "embed":
                errors.append({"path": f"inputs[{i}]", "message": "A component cannot read another component."})
            else:
                blocks.append(block)
        if errors:
            return {"valid": False, "errors": errors, "output": None}
        params = {**{k: v for k, v in declaration.get("params", {}).items()}}
        defaults = {"max_chars": 300, "quote": True, "decimals": 2}
        for k, v in defaults.items():
            if k in spec["params"]:
                params.setdefault(k, v)
        try:
            output = spec["run"](params, blocks)
        except Invalid as exc:
            return {"valid": False, "errors": exc.errors, "output": None}
        if len(output) > MAX_OUTPUT:
            return {"valid": False, "errors": [{"path": "output", "message": "The output is too long."}], "output": None}
        return {"valid": True, "errors": [], "output": output, "inputs": [{"ref": b["id"], "sha256": block_digest(b)} for b in blocks],
                "outputSha256": sha(output)}

    def preview(self, session: DocumentSession, declaration: dict[str, Any], embed_id: str | None = None) -> dict[str, Any]:
        result = self.validate(session, declaration)
        last = None
        if embed_id:
            block = next((b for b in session.doc["blocks"] if b.get("embed") == embed_id), None)
            last = block["text"] if block else None
        result["lastValidOutput"] = last
        result["preview"] = result["output"] if result["valid"] else last
        result["canApply"] = bool(result["valid"])
        result["note"] = "A preview changes nothing. Apply writes the output into the document as one undoable edit."
        return result

    # --------------------------------------------------------------------------------------------------------- apply
    def apply(self, session: DocumentSession, declaration: dict[str, Any], *, after: str | None, embed_id: str | None, base: int | None,
              plan: str) -> dict[str, Any]:
        """Create or update a component. Bound to the document version (``base``) and to the content of every input it reads."""
        self.app.plans.require_embed(plan, "declarative")
        if base is None:
            raise BadRequest("Apply needs the document version you previewed.")
        if base != session.version:
            raise Conflict("The document changed since you previewed this component. Preview it again.", details={"kind": "stale_version"})
        if embed_id and embed_id in self.locks(session) and session.role() != "owner":
            raise Forbidden("This EMBED component is locked. Unlock it with the right access first.")
        result = self.validate(session, declaration)
        if not result["valid"]:
            raise BadRequest("The component is not valid yet, so it cannot be applied.", details={"errors": result["errors"]})
        for given in declaration.get("inputs", []):                       # the previewed inputs must still be what is in the document
            current = next((b for b in session.doc["blocks"] if b["id"] == given["ref"]), None)
            if given.get("sha256") and (current is None or block_digest(current) != given["sha256"]):
                raise Conflict("An input changed since you previewed this component. Preview it again.", details={"kind": "stale_input", "ref": given["ref"]})
        decl = {"id": embed_id or "e" + uuid.uuid4().hex[:8], "kind": declaration["kind"], "schema_version": 1,
                "params": copy.deepcopy(declaration.get("params", {})), "inputs": result["inputs"], "output_sha256": result["outputSha256"]}
        existing = next((b for b in session.doc["blocks"] if b.get("embed") == embed_id), None) if embed_id else None
        ops: list[dict[str, Any]] = [{"op": "embed_put", "embed": decl}]
        if existing is None:
            ops.append({"op": "block_insert", "after": after, "block": {"type": "embed", "text": result["output"], "embed": decl["id"]}})
        else:
            ops.append({"op": "text", "block": existing["id"], "start": 0, "end": len(existing["text"]), "insert": result["output"]})
        patch = session.apply({"op": "batch", "ops": ops, "label": "EMBED component"}, base)
        return {"embed": decl["id"], "patch": patch, "output": result["output"]}

    def stale(self, session: DocumentSession) -> list[dict[str, Any]]:
        """Components whose inputs changed since their output was written (their text is kept; the person decides when to refresh)."""
        index = {b["id"]: b for b in session.doc["blocks"]}
        out = []
        for decl in session.doc.get("embeds", []) or []:
            if decl["kind"] not in KINDS:
                continue
            for ref in decl.get("inputs", []):
                block = index.get(ref["ref"])
                if block is None or block_digest(block) != ref["sha256"]:
                    out.append({"embed": decl["id"], "reason": "An input changed or was removed since the output was written."})
                    break
        return out
