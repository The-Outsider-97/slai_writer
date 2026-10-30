"""Academic writing: sources, citations, footnotes, bibliography, contents and cross-references.

The rule for sources is absolute: **Writer never makes a source up.** Every field of a bibliography entry is something a person typed, an
import carried over, or a registry returned when asked; nothing is filled in, "completed" or guessed. Missing information stays missing
(an entry without a year is shown as "n.d.", without authors by its title). Each source carries a status that is shown wherever the
source appears and checked before export:

* ``user``     typed in by the author (the default; Writer has not checked it);
* ``imported`` carried in with an imported document;
* ``checked``  the author states they compared it with the real work (recorded with the date);
* ``registry`` its DOI was looked up in the Crossref registry when the author asked, and the title matched;
* ``ai``       suggested by an assistant. Writer's own assistant is never asked to produce sources, so this appears only if a person marks one.

The language agent can only propose edits to wording (see assist.py); it cannot add, change or delete a source.
"""
from __future__ import annotations

import difflib
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from typing import Any, Callable

from ..tools.errors import BadRequest, DependencyMissing, NotFound
from ..tools.validation import utc_now
from .session import DocumentSession, sldc
from .textmodel import OBJ

STATUSES = ("user", "imported", "checked", "registry", "ai")
STATUS_LABELS = {"user": "Provided by you", "imported": "Imported with the document", "checked": "Checked by you", "registry": "Verified in the DOI registry",
                 "ai": "AI-suggested, not verified"}
DOI = re.compile(r"^10\.\d{4,9}/\S{1,180}$")
FOOTNOTE_ANCHOR = "​"
CROSSREF = "https://api.crossref.org/works/"
_FIELDS = ("key", "title", "container", "publisher", "volume", "issue", "pages", "note", "authors", "year", "doi", "url", "accessed")
TOC_EXTENSION = "slai.sldc.toc"


def _statuses(doc: dict[str, Any]) -> dict[str, Any]:
    return ((doc.get("extensions") or {}).get("slai.writer") or {}).get("source_status") or {}


def _surname(author: str) -> str:
    author = author.strip()
    if "," in author:
        return author.split(",", 1)[0].strip()
    parts = author.split()
    return parts[-1] if parts else author


def in_text(entry: dict[str, Any]) -> str:
    """The in-text mark, built only from the entry's own fields."""
    authors = entry.get("authors") or []
    year = str(entry.get("year") or "n.d.")
    if not authors:
        title = entry.get("title", "")
        short = title if len(title) <= 40 else title[:37].rstrip() + "…"
        return f"({short}, {year})"
    names = [_surname(a) for a in authors]
    who = names[0] if len(names) == 1 else f"{names[0]} & {names[1]}" if len(names) == 2 else f"{names[0]} et al."
    return f"({who}, {year})"


def reference_line(entry: dict[str, Any]) -> str:
    """One bibliography line in Writer's simple author-year layout (not a claim of conformity to APA, MLA or any style guide)."""
    parts = []
    authors = entry.get("authors") or []
    if authors:
        parts.append((", ".join(authors[:-1]) + (", & " if len(authors) > 2 else " & " if len(authors) == 2 else "") + authors[-1]) if len(authors) > 1 else authors[0])
    parts.append(f"({entry.get('year') or 'n.d.'})")
    title = entry.get("title", "").rstrip(".")
    lead = " ".join(parts)
    line = lead + (" " if len(parts) == 1 else ". ") + title + "."
    if entry.get("container"):
        vol = entry.get("volume", "")
        issue = f"({entry['issue']})" if entry.get("issue") else ""
        pages = f", {entry['pages']}" if entry.get("pages") else ""
        line += f" {entry['container']}" + (f", {vol}{issue}" if vol or issue else "") + pages + "."
    if entry.get("publisher"):
        line += f" {entry['publisher']}."
    if entry.get("doi"):
        line += f" https://doi.org/{entry['doi']}"
    elif entry.get("url"):
        line += f" {entry['url']}"
    return line


def clean_entry(data: dict[str, Any]) -> dict[str, Any]:
    """Validate what a person typed. Nothing is added; a bad value is an error, not corrected."""
    entry: dict[str, Any] = {"kind": "citation"}
    title = (data.get("title") or "").strip()
    if not title:
        raise BadRequest("A source needs at least a title.")
    entry["title"] = title[:1000]
    authors = data.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r"[;\n]", authors) if a.strip()]
    if not isinstance(authors, list) or len(authors) > 100 or not all(isinstance(a, str) and 0 < len(a.strip()) <= 200 for a in authors):
        raise BadRequest("Authors must be names, one per line (up to 100).")
    if authors:
        entry["authors"] = [a.strip() for a in authors]
    year = str(data.get("year") or "").strip()
    if year:
        if not re.fullmatch(r"\d{4}", year) or not 1000 <= int(year) <= time.gmtime().tm_year + 1:
            raise BadRequest("The year must be four digits, such as 2021.")
        entry["year"] = int(year)
    doi = (data.get("doi") or "").strip()
    if doi:
        doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi, flags=re.I)
        if not DOI.fullmatch(doi):
            raise BadRequest("That is not a valid DOI. It looks like 10.1000/xyz123.")
        entry["doi"] = doi
    url = (data.get("url") or "").strip()
    if url:
        if not re.match(r"^https?://[^\s/]+\S*$", url) or len(url) > 2000 or "@" in url.split("/")[2]:
            raise BadRequest("The link must start with http:// or https:// and must not contain a password.")
        entry["url"] = url
    accessed = (data.get("accessed") or "").strip()
    if accessed:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", accessed):
            raise BadRequest("The access date must look like 2024-05-31.")
        entry["accessed"] = accessed
    for key, limit in (("container", 500), ("publisher", 300), ("volume", 40), ("issue", 40), ("pages", 40), ("note", 2000), ("key", 128)):
        value = (data.get(key) or "").strip()
        if value:
            entry[key] = value[:limit]
    return entry


class Academic:
    def __init__(self, app: Any, fetch: Callable[[str], dict[str, Any]] | None = None) -> None:
        self.app = app
        self._fetch = fetch or self._crossref

    # ------------------------------------------------------------------------------------------------------ listing
    def sources(self, session: DocumentSession) -> dict[str, Any]:
        doc = session.doc
        status = _statuses(doc)
        counts: dict[str, int] = {}
        for block in doc["blocks"]:
            for span in block.get("spans", []):
                if span.get("type") == "ref":
                    counts[span["ref"]] = counts.get(span["ref"], 0) + 1
        out = []
        for ref in doc.get("references", []) or []:
            entry = {"id": ref["id"], "kind": ref["kind"], "uses": counts.get(ref["id"], 0)}
            if ref["kind"] == "citation":
                st = status.get(ref["id"], {"status": "user"})
                entry.update({"data": {k: ref[k] for k in _FIELDS if k in ref}, "status": st["status"], "statusLabel": STATUS_LABELS[st["status"]],
                              "statusDate": st.get("date"), "inText": in_text(ref), "line": reference_line(ref),
                              "problems": self._problems(ref)})
            else:
                entry.update({"text": ref.get("text", "")})
            out.append(entry)
        return {"sources": out, "statuses": STATUS_LABELS, "unverified": [s["id"] for s in out if s["kind"] == "citation" and s["status"] in ("ai",)]}

    @staticmethod
    def _problems(ref: dict[str, Any]) -> list[str]:
        found = []
        if not ref.get("authors"):
            found.append("No author is recorded.")
        if not ref.get("year"):
            found.append("No year is recorded (shown as n.d.).")
        if not (ref.get("doi") or ref.get("url") or ref.get("publisher") or ref.get("container")):
            found.append("There is no publisher, journal, DOI or link, so a reader cannot find this source.")
        return found

    # ---------------------------------------------------------------------------------------------------- changing
    def put_source(self, session: DocumentSession, data: dict[str, Any], source_id: str | None = None, status: str = "user") -> dict[str, Any]:
        if status not in ("user", "imported", "ai"):
            raise BadRequest("A source starts as provided by you, imported, or AI-suggested. Checked and verified are earned (see Check / Verify).")
        entry = clean_entry(data)
        if source_id:
            entry["id"] = source_id
        ops: list[dict[str, Any]] = [{"op": "reference_put", "reference": entry}]
        patch = session.apply({"op": "batch", "ops": ops, "label": "source"}, None)
        sid = patch["result"]["results"][0]["reference"]
        statuses = dict(_statuses(session.doc))
        if source_id is None or statuses.get(sid, {}).get("status") in (None, "user"):
            statuses[sid] = {"status": status, "date": utc_now()}
        elif source_id:                                              # editing a checked / verified source drops that claim: it was checked as it was
            statuses[sid] = {"status": "user", "date": utc_now(), "note": "Edited after it was checked."}
        session.apply({"op": "ext_set", "values": {"source_status": statuses}}, None)
        return {"id": sid, "status": statuses[sid]["status"], "inText": in_text(entry), "state": session.state()}

    def delete_source(self, session: DocumentSession, source_id: str) -> dict[str, Any]:
        if not any(r["id"] == source_id for r in session.doc.get("references", []) or []):
            raise NotFound("That source no longer exists.")
        patch = session.apply({"op": "reference_delete", "id": source_id}, None)
        statuses = {k: v for k, v in _statuses(session.doc).items() if k != source_id}
        session.apply({"op": "ext_set", "values": {"source_status": statuses or None}}, None)
        return patch

    def mark_checked(self, session: DocumentSession, source_id: str, note: str) -> dict[str, Any]:
        """The author says they compared the entry with the real work. Writer records the statement and the date; it cannot verify it."""
        ref = self._ref(session, source_id)
        if ref["kind"] != "citation":
            raise BadRequest("Only sources can be checked.")
        statuses = dict(_statuses(session.doc))
        statuses[source_id] = {"status": "checked", "date": utc_now(), "note": (note or "")[:300]}
        return session.apply({"op": "ext_set", "values": {"source_status": statuses}}, None)

    def _ref(self, session: DocumentSession, source_id: str) -> dict[str, Any]:
        ref = next((r for r in session.doc.get("references", []) or [] if r["id"] == source_id), None)
        if ref is None:
            raise NotFound("That source no longer exists.")
        return ref

    # ---------------------------------------------------------------------------------------------------- registry
    def _crossref(self, doi: str) -> dict[str, Any]:
        request = urllib.request.Request(CROSSREF + urllib.parse.quote(doi, safe="/"), headers={"User-Agent": "SLAI-Writer/1.0 (local; DOI check on request)"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:             # noqa: S310 - fixed https host, explicit user action
                return json.loads(response.read(2_000_000).decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {"status": "not_found"}
            raise DependencyMissing(f"The DOI registry answered with an error ({exc.code}).") from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise DependencyMissing("The DOI registry could not be reached (no network, or it is blocked). Nothing was changed.",
                                    hint="Checking a DOI needs an internet connection. You can still mark a source as checked yourself.") from exc

    def verify_doi(self, session: DocumentSession, source_id: str) -> dict[str, Any]:
        """Ask the Crossref registry about this source's DOI - only when the person asks, and only if they allowed online lookups."""
        if not self.app.preferences().get("lookup_online"):
            raise DependencyMissing("Online DOI checks are switched off.", hint="Turn on 'Check DOIs online' in Settings. Only the DOI is sent to api.crossref.org.")
        ref = self._ref(session, source_id)
        if not ref.get("doi"):
            raise BadRequest("This source has no DOI to check.")
        data = self._fetch(ref["doi"])
        if data.get("status") == "not_found":
            return {"match": False, "found": False, "message": "The registry has no record of this DOI. Check it for typing mistakes.", "state": None}
        message = data.get("message") or {}
        titles = message.get("title") or []
        registry_title = titles[0] if titles else ""
        ratio = difflib.SequenceMatcher(None, re.sub(r"\W+", " ", ref["title"]).lower().strip(), re.sub(r"\W+", " ", registry_title).lower().strip()).ratio()
        years = [message.get(k, {}).get("date-parts", [[None]])[0][0] for k in ("issued", "published-print", "published-online") if message.get(k)]
        registry_year = next((y for y in years if y), None)
        family = {a.get("family", "").lower() for a in message.get("author", []) if a.get("family")}
        ours = {_surname(a).lower() for a in ref.get("authors", [])}
        report = {"found": True, "registryTitle": registry_title, "registryYear": registry_year, "registryAuthors": sorted(family)[:20],
                  "titleSimilarity": round(ratio, 2), "yearMatches": (str(registry_year) == str(ref.get("year", ""))[:4]) if (registry_year and ref.get("year")) else None,
                  "authorsMatch": (not ours or bool(ours & family)) if family else None}
        report["match"] = ratio >= 0.85 and report["yearMatches"] is not False and report["authorsMatch"] is not False
        if report["match"]:
            statuses = dict(_statuses(session.doc))
            statuses[source_id] = {"status": "registry", "date": utc_now(), "note": "Crossref"}
            session.apply({"op": "ext_set", "values": {"source_status": statuses}}, None)
            report["message"] = "The registry record matches this entry."
        else:
            report["message"] = "The registry record does not match this entry closely enough. Compare them and correct the entry; it was not marked as verified."
        return report

    # ------------------------------------------------------------------------------------------------- inserting
    def cite(self, session: DocumentSession, block_id: str, at: int, source_id: str, *, base: int | None = None) -> dict[str, Any]:
        """Insert the in-text mark for a source at ``at`` and link it to the source."""
        ref = self._ref(session, source_id)
        if ref["kind"] != "citation":
            raise BadRequest("Choose a source, not a footnote.")
        mark = in_text(ref)
        ops = [{"op": "text", "block": block_id, "start": at, "end": at, "insert": mark},
               {"op": "span", "block": block_id, "start": at, "end": at + len(mark), "kind": "ref", "ref": source_id}]
        return session.apply({"op": "batch", "ops": ops, "label": "citation"}, base)

    def footnote(self, session: DocumentSession, block_id: str, at: int, text: str, *, base: int | None = None) -> dict[str, Any]:
        text = (text or "").strip()
        if not text or len(text) > 20_000:
            raise BadRequest("Write the footnote text (up to 20,000 characters).")
        fid = "fn" + secrets.token_hex(4)
        ops = [{"op": "reference_put", "reference": {"id": fid, "kind": "footnote", "text": text}},
               {"op": "text", "block": block_id, "start": at, "end": at, "insert": FOOTNOTE_ANCHOR},
               {"op": "span", "block": block_id, "start": at, "end": at + 1, "kind": "ref", "ref": fid}]
        patch = session.apply({"op": "batch", "ops": ops, "label": "footnote"}, base)
        return {**patch, "footnote": fid}

    def bibliography(self, session: DocumentSession, *, only_cited: bool = True, after: str | None = None, heading: str = "References") -> dict[str, Any]:
        """Insert (or return, with ``after=None`` and no change) a reference list built from the entries' own fields."""
        listing = self.sources(session)
        entries = [s for s in listing["sources"] if s["kind"] == "citation" and (s["uses"] or not only_cited)]
        if not entries:
            raise BadRequest("There are no cited sources to list yet.")
        entries.sort(key=lambda s: s["line"].lower())
        warnings = []
        weak = [s for s in entries if s["status"] in ("ai",)]
        if weak:
            warnings.append(f"{len(weak)} source(s) are AI-suggested and not verified. Check them against the real works before you publish.")
        warnings += [f"“{s['data']['title'][:50]}”: {p}" for s in entries for p in s["problems"][:1]]
        patch = session.apply({"op": "batch", "ops": [{"op": "block_insert", "after": after, "block": {"type": "heading", "text": heading, "attributes": {"level": 1}}}], "label": "bibliography"}, None)
        head = patch["result"]["results"][0]["block"]
        prev = head
        for s in entries:
            p = session.apply({"op": "block_insert", "after": prev, "block": {"type": "list_item", "text": s["line"]}}, None)
            prev = p["result"]["block"]
        return {"heading": head, "entries": len(entries), "warnings": warnings, "state": session.state()}

    def contents(self, session: DocumentSession, after: str | None, title: str = "Contents", depth: int = 4) -> dict[str, Any]:
        """
        Insert a managed, refreshable TOC.

        The operation is performed as one undoable
        document transaction.

        TOC metadata is preserved as a namespaced
        SLDC block extension.
        """

        with session.lock:
            return self._contents(session, after, title, depth, toc_id=secrets.token_hex(12))

    def refresh_contents(self, session: DocumentSession, toc_id: str) -> dict[str, Any]:
        """
        Refresh one existing managed TOC.

        Only blocks belonging to this TOC are replaced.
        Unrelated document content is preserved.
        """

        with session.lock:
            blocks = session.doc["blocks"]

            owned = [
                (index, block)
                for index, block in enumerate(blocks)
                if block.get(
                    "extensions", {}
                ).get(
                    TOC_EXTENSION, {}
                ).get("id") == toc_id
            ]

            titles = [
                (index, block)
                for index, block in owned
                if block["extensions"][
                    TOC_EXTENSION
                ].get("role") == "title"
            ]

            if len(titles) != 1 or not owned:
                raise BadRequest("This table of contents no longer exists or has invalid metadata.")

            index, title_block = titles[0]
            settings = title_block["extensions"][TOC_EXTENSION]

            after = (
                blocks[index - 1]["id"]
                if index
                else None
            )

            return self._contents(
                session,
                after,
                title_block["text"],
                settings["depth"],
                toc_id=toc_id,
                remove=[block["id"] for _, block in owned],
            )


    def _contents(
        self,
        session: DocumentSession,
        after: str | None,
        title: str,
        depth: int,
        toc_id: str,
        remove: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Build and apply a managed TOC transaction.

        The document's semantic headings are authoritative.

        Existing generated TOC content is excluded from
        heading collection.

        All changes are applied through the existing
        document operation system.
        """

        if (
            not isinstance(depth, int)
            or not 1 <= depth <= 6
        ):
            raise BadRequest("TOC depth must be between 1 and 6.")

        generated_ids = {
            block["id"]
            for block in session.doc["blocks"]
            if block.get("extensions", {}).get(TOC_EXTENSION)
        }

        headings = [
            heading
            for heading in session.outline()
            if (
                heading["level"] <= depth
                and heading["text"].strip()
                and heading["block"] not in generated_ids
            )
        ]

        if not headings:
            raise BadRequest("There are no headings to list yet.")

        if (
            len(headings) > 4998
            or (remove and len(remove) > 5000)
        ):
            raise BadRequest("This document has too many headings for one TOC update.")

        if remove and after in remove:
            raise BadRequest("Cannot replace a TOC with an invalid insertion anchor.")

        ops: list[dict[str, Any]] = []
        if remove:
            ops.append({
                "op": "block_delete",
                "blocks": remove,
            })

        head = "toc_" + secrets.token_hex(12)

        ops.append({
            "op": "block_insert",
            "after": after,
            "block": {
                "id": head,
                "type": "paragraph",
                "text": title,
                "extensions": {
                    TOC_EXTENSION: {
                        "id": toc_id,
                        "role": "title",
                        "depth": depth,
                    },
                },
            },
        })

        prev = head

        for heading in headings:
            label = heading["text"].strip()

            new_id = (
                "toc_" + secrets.token_hex(12)
            )

            ops.append({
                "op": "block_insert",
                "after": prev,
                "block": {
                    "id": new_id,
                    "type": "list_item",
                    "text": label,
                    "attributes": {
                        "ordered": False,
                        "depth": heading["level"] - 1,
                    },
                    "spans": [{
                        "type": "xref",
                        "start": 0,
                        "end": len(label),
                        "target": heading["block"],
                    }],
                    "extensions": {
                        TOC_EXTENSION: {
                            "id": toc_id,
                            "role": "entry",
                            "heading": heading["block"],
                        },
                    },
                },
            })

            prev = new_id

        session.apply({
            "op": "batch",
            "ops": ops,
            "label": (
                "refresh contents"
                if remove
                else "insert contents"
            ),
        }, None)

        return {
            "heading": head,
            "tocId": toc_id,
            "entries": len(headings),
            "generatedAtRevision": session.revision_no,
            "note": (
                "Use Update contents after changing "
                "document headings."
            ),
            "state": session.state(),
        }

    def cross_reference(self, session: DocumentSession, block_id: str, start: int, end: int, target: str) -> dict[str, Any]:
        return session.apply({"op": "span", "block": block_id, "start": start, "end": end, "kind": "xref", "target": target}, None)

    # -------------------------------------------------------------------------------------------------- pre-export
    def audit(self, session: DocumentSession) -> list[dict[str, Any]]:
        """Findings for the export check: unverified sources that are cited, and cited sources that are missing."""
        found = []
        listing = self.sources(session)
        for s in listing["sources"]:
            if s["kind"] != "citation":
                continue
            if s["status"] == "ai" and s["uses"]:
                found.append({"severity": "error", "code": "ai_source", "message": f"“{s['data']['title'][:60]}” is an AI-suggested source that has not been verified.", "block": None})
            elif s["uses"] and s["status"] in ("user", "imported") and s["problems"]:
                found.append({"severity": "info", "code": "source_incomplete", "message": f"“{s['data']['title'][:60]}”: {s['problems'][0]}", "block": None})
        return found
