"""Offline APA 7 formatting through citeproc-py and the bundled upstream CSL style.

The processor owns punctuation, author disambiguation, and source-specific
typography. This module only maps verified SLDC metadata into CSL-JSON and
converts trusted renderer markup into SLDC character spans.
"""
from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

from ..tools.errors import DependencyMissing

APA_STYLE = Path(__file__).resolve().parent / "assets" / "csl" / "apa.csl"
SOURCE_TYPES = frozenset({"article-journal", "book", "chapter", "webpage", "report", "thesis", "paper-conference",
                          "article", "dataset", "motion_picture", "software", "post-weblog", "document", "book-section"})


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
    collide; ordering is deterministic by title and stable source ID.
    """
    buckets: dict[tuple[tuple[str, ...], str], list[dict[str, Any]]] = {}
    for ref in references:
        authors = [str(name).strip().casefold() for name in ref.get("authors", [])]
        if not authors and ref.get("organization"):
            authors = [str(ref["organization"]).strip().casefold()]
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


def _person(name: str) -> dict[str, str]:
    if "," in name:
        family, given = name.split(",", 1)
    else:
        parts = name.strip().split()
        family, given = parts[-1], " ".join(parts[:-1])
    return {"family": family.strip(), **({"given": given.strip()} if given.strip() else {})}


def csl_source(entry: dict[str, Any]) -> dict[str, Any]:
    kind = entry.get("source_type") or ("article-journal" if entry.get("container") else
                                        "book" if entry.get("publisher") else "webpage")
    if kind not in SOURCE_TYPES:
        raise ValueError(f"Unsupported CSL source type {kind!r}")
    record: dict[str, Any] = {"id": entry["id"], "type": kind, "title": entry["title"]}
    if entry.get("authors"):
        record["author"] = [_person(a) for a in entry["authors"]]
    elif entry.get("organization"):
        record["author"] = [{"literal": entry["organization"]}]
    if entry.get("editors"):
        record["editor"] = [_person(e) for e in entry["editors"]]
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
        try:
            from citeproc import Citation, CitationItem, CitationStylesBibliography, CitationStylesStyle, Locator, formatter
            from citeproc.source.json import CiteProcJSON
        except ImportError as exc:
            raise DependencyMissing("APA 7 citation formatting needs citeproc-py. Install it from Writer requirements.txt.") from exc
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
        if narrative and mark.startswith("(") and mark.endswith(")"):
            inner = mark[1:-1]
            # Narrative citations are derived from the CSL result, preserving
            # the processor's et al. and year-suffix disambiguation.
            if ", " in inner:
                authors, date = inner.split(", ", 1)
                return f"{authors.replace(' & ', ' and ')} ({date})"
        return mark

    def bibliography(self) -> list[tuple[str, str, list[dict[str, Any]]]]:
        self.bib.sort()
        out = []
        for sid, item in zip(self.bib.keys, self.bib.bibliography()):
            text, spans = styled_text(str(item))
            out.append((sid, text, spans))
        return out
