"""Offline APA 7 formatting through citeproc-py and the bundled upstream CSL style.

The processor owns punctuation, author disambiguation, and source-specific
typography. This module only maps verified SLDC metadata into CSL-JSON and
converts trusted renderer markup into SLDC character spans.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

from ..tools.errors import DependencyMissing
from .dependencies import require
from .names import parse

APA_STYLE = Path(__file__).resolve().parent / "assets" / "csl" / "apa.csl"
SOURCE_TYPES = frozenset({"article-journal", "book", "chapter", "webpage", "report", "thesis", "paper-conference",
                          "article", "dataset", "motion_picture", "software", "post-weblog", "document", "book-section"})


#: Where the date starts in one parenthetical citation: the comma before a year (2020, 2020a), n.d. or in press.
_DATE_START = re.compile(r", (?=(?:\d{4}|n\.d\.|in press))")


def _letters(index: int) -> str:
    """Stable a, ..., z, aa, ab suffixes for otherwise identical author-years."""
    output = ""
    while True:
        index, digit = divmod(index, 26)
        output = chr(ord("a") + digit) + output
        if index == 0:
            return output
        index -= 1


def _year_suffixes(references: list[dict[str, Any]]) -> dict[str, str]:
    """Supply year suffixes that citeproc-py currently does not calculate.

    The CSL renderer itself handles the resulting suffix in both in-text
    citations and the reference list. Only identical author lists and years
    collide, where an author is the same person however the name was typed
    (Smith, Jane / Jane Smith / J. Smith); ordering is deterministic by title
    and stable source ID.
    """
    buckets: dict[tuple[tuple[tuple[str, str], ...], str], list[dict[str, Any]]] = {}
    for ref in references:
        authors = [parse(str(name)).key() for name in ref.get("authors", [])]
        if not authors and ref.get("organization"):
            authors = [parse("{" + str(ref["organization"]).strip() + "}").key()]
        year = str(ref.get("year") or (str(ref.get("published") or "").split("-")[0]))
        if not authors or not year.isdigit() or len(year) != 4:
            continue
        buckets.setdefault((tuple(authors), year), []).append(ref)
    suffixes: dict[str, str] = {}
    for candidates in buckets.values():
        if len(candidates) <= 1:
            continue
        for i, ref in enumerate(sorted(candidates, key=lambda r: (str(r["title"]).casefold(), str(r["id"])))):
            suffixes[str(ref["id"]).casefold()] = _letters(i)
    return suffixes


def csl_source(entry: dict[str, Any]) -> dict[str, Any]:
    kind = entry.get("source_type") or ("article-journal" if entry.get("container") else
                                        "book" if entry.get("publisher") else "webpage")
    if kind not in SOURCE_TYPES:
        raise ValueError(f"Unsupported CSL source type {kind!r}")
    record: dict[str, Any] = {"id": entry["id"], "type": kind, "title": entry["title"]}
    if entry.get("authors"):
        record["author"] = [parse(a).csl() for a in entry["authors"]]
    elif entry.get("organization"):
        record["author"] = [{"literal": entry["organization"]}]
    if entry.get("editors"):
        record["editor"] = [parse(e).csl() for e in entry["editors"]]
    if entry.get("published"):
        digits = str(entry["published"]).split("-")
        if all(d.isdigit() for d in digits) and len(digits) in (1, 2, 3):
            record["issued"] = {"date-parts": [[int(d) for d in digits]]}
    elif entry.get("year"):
        record["issued"] = {"date-parts": [[int(entry["year"])]]}
    for key, target in (("container", "container-title"), ("publisher", "publisher"), ("volume", "volume"),
                        ("issue", "issue"), ("pages", "page"), ("doi", "DOI"), ("url", "URL"),
                        ("isbn", "ISBN"), ("edition", "edition")):
        if entry.get(key):
            record[target] = str(entry[key])
    return record


class _StyledHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.spans: list[dict[str, Any]] = []
        self.active: list[tuple[str, int]] = []
        self.length = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("i", "em", "b", "strong", "u"):
            self.active.append((tag, self.length))

    def handle_endtag(self, tag: str) -> None:
        for i in range(len(self.active) - 1, -1, -1):
            name, start = self.active[i]
            if name == tag:
                self.active.pop(i)
                if self.length > start:
                    prop = "italic" if tag in ("i", "em") else "bold" if tag in ("b", "strong") else "underline"
                    self.spans.append({"type": "format", "start": start, "end": self.length, prop: True})
                return

    def handle_data(self, data: str) -> None:
        self.parts.append(data)
        self.length += len(data)


def styled_text(markup: str) -> tuple[str, list[dict[str, Any]]]:
    parser = _StyledHTML()
    parser.feed(markup)
    parser.close()
    return "".join(parser.parts), sorted(parser.spans, key=lambda x: (x["start"], x["end"], x["type"]))


class CitationEngine:
    """One in-memory CSL context per bibliography/citation batch."""

    def __init__(self, references: Iterable[dict[str, Any]]) -> None:
        citeproc = require("citeproc", needed_for="APA 7 citation formatting", package="citeproc-py")
        Citation, CitationItem, CitationStylesBibliography = citeproc.Citation, citeproc.CitationItem, citeproc.CitationStylesBibliography
        CitationStylesStyle, Locator, formatter = citeproc.CitationStylesStyle, citeproc.Locator, citeproc.formatter
        CiteProcJSON = require("citeproc.source.json", needed_for="APA 7 citation formatting", package="citeproc-py").CiteProcJSON
        if not APA_STYLE.is_file():
            raise DependencyMissing("The bundled APA 7 CSL definition was not found.")
        self.Citation, self.CitationItem, self.Locator = Citation, CitationItem, Locator
        self.references = [r for r in references if r.get("kind") == "citation"]
        self.source = CiteProcJSON([csl_source(ref) for ref in self.references])
        for sid, suffix in _year_suffixes(self.references).items():
            self.source[sid]["year_suffix"] = suffix
        style = CitationStylesStyle(str(APA_STYLE), validate=False)
        self.bib = CitationStylesBibliography(style, self.source, formatter.html)
        self.groups: list[Any] = []

    def register(self, source_ids: list[str], *, locator: str | None = None,
                 label: str = "page") -> int:
        items = []
        for sid in source_ids:
            if sid.casefold() not in self.source:
                raise ValueError(f"Unknown citation source {sid!r}")
            kwargs = {"locator": self.Locator(label, locator)} if locator and len(source_ids) == 1 else {}
            items.append(self.CitationItem(sid, **kwargs))
        group = self.Citation(items)
        self.bib.register(group)
        self.groups.append(group)
        return len(self.groups) - 1

    def cite(self, index: int, *, narrative: bool = False) -> str:
        mark = styled_text(str(self.bib.cite(self.groups[index], lambda _: None)))[0]
        if narrative:
            return self.narrative(mark, [str(r["organization"]) for r in self.references if r.get("organization")])
        return mark

    @staticmethod
    def narrative(mark: str, organizations: Iterable[str] = ()) -> str:
        """The narrative form of a parenthetical APA citation, derived from the CSL result so the processor's et al. and year-suffix disambiguation are kept:
        ``(Smith & Jones, 2020, p. 5)`` becomes ``Smith and Jones (2020, p. 5)``, and a group ``(Jones, 2021; Smith, 2020)`` becomes
        ``Jones (2021) and Smith (2020)``. The text is returned as it came when it cannot be split reliably, so a citation is never mangled."""
        if not (mark.startswith("(") and mark.endswith(")")):
            return mark
        pieces = []
        for part in mark[1:-1].split("; "):
            found = _DATE_START.search(part)
            if not found:
                return mark
            authors, date = part[:found.start()], part[found.end():]
            if not any(" & " in org and org in authors for org in organizations):          # "Johnson & Johnson" is one name; "Smith & Jones" is two
                authors = authors.replace(" & ", " and ")
            pieces.append(f"{authors} ({date})")
        if len(pieces) <= 2:
            return " and ".join(pieces)
        return ", ".join(pieces[:-1]) + ", and " + pieces[-1]

    def bibliography(self) -> list[tuple[str, str, list[dict[str, Any]]]]:
        self.bib.sort()
        out = []
        for sid, item in zip(self.bib.keys, self.bib.bibliography()):
            text, spans = styled_text(str(item))
            out.append((sid, text, spans))
        return out
