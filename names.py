"""Author names: how the text a person typed becomes a structured name, and when Writer cannot be sure.

SLDC stores an author as one string (the shared format allows up to 100 names of up to 200 characters), so the structured name lives in the *spelling*:

    Family, Given            read exactly as written ("García Márquez, Gabriel", "van Beethoven, Ludwig", "King, Martin Luther, Jr.")
    {Literal Name}           an institution or any name that must never be split ("{World Health Organization}", "{Plato}")
    Given Family             a guess: the last word is the family name, with the particles before it (van, de la, bin, ...) and a trailing Jr./III apart
    Smith JA                 a guess: a family name followed by initials (the reference-list style of medicine)

Only the first two are the author's statement; the others are readings, and a reading that could be wrong carries a ``note`` that says what Writer took and
what to type to say otherwise. Nothing is rewritten in the stored text: Writer never changes a name the person typed, it tells them how it read it. The
correction is always the same one: retype the name as ``Family, Given`` or ``{Literal}``. A source that has an organisation uses the organisation field.

The structured name (CSL-JSON) is built from the reading when a citation is formatted; the stored text is not touched.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

#: Lower-case words that belong to a family name written without a comma ("Ludwig van Beethoven"): APA 7 files such a name under its particle.
PARTICLES = frozenset({"van", "von", "de", "der", "den", "del", "della", "di", "da", "du", "la", "le", "ten", "ter", "bin", "ibn", "al", "el", "dos", "das", "af", "av",
                       "zu", "zur", "des", "los", "las", "bint"})
SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv", "v"})
#: Words that make a name an organisation ("World Health Organization", "Universiteit van Amsterdam"). Matched as whole words, case-insensitively.
INSTITUTION = frozenset({"university", "universiteit", "universität", "universitat", "université", "universidad", "universidade", "institute", "institut", "instituto",
                         "association", "organization", "organisation", "committee", "council", "ministry", "department", "agency", "society", "foundation", "bureau",
                         "company", "corporation", "inc", "ltd", "llc", "gmbh", "press", "center", "centre", "college", "commission", "board", "office", "group", "network",
                         "alliance", "academy", "laboratory", "laboratories", "federation", "authority", "administration", "ministerie", "gemeente", "government", "trust",
                         "consortium", "service", "services", "directorate", "parliament", "bank"})


@dataclass(frozen=True)
class Name:
    family: str
    given: str = ""
    suffix: str = ""
    literal: bool = False                    # an institution or a name that is not split
    stated: bool = False                     # the person wrote the order ("Family, Given" or "{Literal}"), so Writer did not guess
    note: str | None = None                  # what Writer took and how to say otherwise, when the reading could be wrong

    def csl(self) -> dict[str, str]:
        if self.literal:
            return {"literal": self.family}
        out = {"family": self.family}
        if self.given:
            out["given"] = self.given
        if self.suffix:
            out["suffix"] = self.suffix
        return out

    @property
    def initials(self) -> str:
        """The first letters of the given names, lower-case, for telling two people of the same family name apart (J. Smith and A. Smith)."""
        if self.literal:
            return ""
        return "".join(part[0] for part in re.split(r"[\s.\-]+", self.given) if part).casefold()

    def key(self) -> tuple[str, str]:
        """Same person, whichever way the name was typed: Smith, Jane / Jane Smith / J. Smith share a key."""
        return (unicodedata.normalize("NFKC", self.family).casefold(), self.initials[:1])

    def display(self) -> str:
        """``Family, G. M.``: the reading as a reference list prints it, given names as initials (Jean-Pierre becomes J.-P.), an institution whole."""
        if self.literal:
            return self.family
        initials = " ".join("-".join(f"{p[0]}." for p in word.split("-") if p) for word in re.split(r"[\s.]+", self.given) if word)
        return self.family + (f", {initials}" if initials else "") + (f", {self.suffix}" if self.suffix else "")

    def canonical(self) -> str:
        """The name in the form that is read exactly: what to type to confirm or correct a reading."""
        if self.literal:
            return "{" + self.family + "}"
        text = self.family + (f", {self.given}" if self.given else "")
        if not self.given and not self.suffix and " " in self.family:      # "van Beethoven," : the comma says the whole of it is the family name
            text += ","
        return text + (f", {self.suffix}" if self.suffix else "")

    def describe(self, typed: str) -> dict[str, object]:
        """What the editor shows beside a typed name: the reading in parts, whether the person stated it, how a reference list prints it, and the note."""
        return {"typed": typed, "family": self.family, "given": self.given, "suffix": self.suffix, "literal": self.literal, "stated": self.stated,
                "display": self.display(), "canonical": self.canonical(), "note": self.note}


def _tidy(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text).replace(" ", " ")).strip(" ;")


def _is_initial(token: str) -> bool:
    """J, J., JA, J.K. : letters that stand for given names."""
    bare = token.rstrip(".")
    return bool(re.fullmatch(r"(?:\w\.){1,3}", token)) or (0 < len(bare) <= 2 and bare.isupper())


def _words(text: str) -> list[str]:
    return [w.casefold().strip(".,") for w in re.split(r"[\s,]+", text) if w]


def _looks_like_institution(text: str) -> bool:
    words = _words(text)
    return len(words) >= 2 and any(w in INSTITUTION for w in words)


def _cjk(text: str) -> bool:
    return any(unicodedata.name(c, "").startswith(("CJK", "HIRAGANA", "KATAKANA", "HANGUL")) for c in text)


def parse(text: str) -> Name:
    """Read one author as typed. See the module text for the spellings that are the person's statement and the readings that are guesses."""
    name = _tidy(text)
    if len(name) >= 2 and name.startswith("{") and name.endswith("}"):
        return Name(family=name[1:-1].strip(), literal=True, stated=True)
    if re.search(r"(?:^|\s)(?:&|and)(?:\s|$)", name):                         # "Johnson & Johnson", "Smith and Jones": an organisation, or two people typed as one
        return Name(family=name, literal=True, note=f"“{name}” has “&” or “and” in it, so Writer kept it as one name (an organisation). If these are two people, "
                                                   f"put one on each line; to keep it as one name, write it as {{{name}}}.")
    if "," in name:
        family, _, rest = name.partition(",")
        tail = [t.strip() for t in rest.split(",")]
        if len(tail) == 1 and tail[0].rstrip(".").casefold() in SUFFIXES:     # "Martin Luther King, Jr.": the comma is before the suffix, not before the given name
            return parse(f"{family.strip()} {tail[0]}")
        suffix = ""
        if len(tail) > 1 and tail[-1].rstrip(".").casefold() in SUFFIXES:
            suffix = tail.pop()
        given = ", ".join(t for t in tail if t)
        if not given and not suffix:                                        # "Smith," is just a family name
            return Name(family=family.strip(), stated=True)
        if _looks_like_institution(name) and not _is_initial(given.split()[0] if given else ""):
            return Name(family=name, literal=True, note=f"“{name}” looks like an organisation, so Writer kept it whole. To say so, write it as {{{name}}} "
                                                       f"or put it in the Organisation field; to read it as a person, write it as Family, Given.")
        return Name(family=family.strip(), given=given, suffix=suffix, stated=True)
    if _looks_like_institution(name):
        return Name(family=name, literal=True, note=f"“{name}” looks like an organisation, so Writer kept it whole. To say so, write it as {{{name}}} "
                                                   f"or put it in the Organisation field; to read it as a person, write it as Family, Given.")
    parts = name.split()
    suffix = ""
    if len(parts) > 1 and parts[-1].rstrip(".").casefold() in SUFFIXES:
        suffix = parts.pop()
    if len(parts) <= 1:
        return Name(family=" ".join(parts), suffix=suffix)                    # one word: a mononym such as Plato, or a name in a script that is not split by spaces
    if len(parts) == 2 and re.fullmatch(r"[A-Z]{1,3}", parts[1]) and not re.fullmatch(r"[A-Z]{1,3}", parts[0]) and len(parts[0]) > 1:
        initials = " ".join(c + "." for c in parts[1])                        # "Smith JA": the medical reference-list order
        return Name(family=parts[0], given=initials, suffix=suffix,
                    note=f"“{name}” was read as the family name {parts[0]} followed by the initials {parts[1]}. If that is wrong, write it as Family, Given.")
    start = len(parts) - 1
    while start > 1 and parts[start - 1].casefold() in PARTICLES:
        start -= 1
    family, given = " ".join(parts[start:]), " ".join(parts[:start])
    note = None
    if _cjk(name):
        note = (f"“{name}” was read as given name {given}, family name {family}. Names in Chinese, Japanese and Korean usually put the family name first; "
                f"write it as Family, Given to say which is which.")
    elif len(parts) - start == 1 and len(parts) >= 3 and not all(_is_initial(p) for p in parts[1:-1]):
        note = (f"“{name}” was read as given name {given}, family name {family}. If the family name is longer (for example {parts[-2]} {parts[-1]}), "
                f"write it as {parts[-2]} {parts[-1]}, {' '.join(parts[:-2])}.")
    return Name(family=family, given=given, suffix=suffix, note=note)


def read_all(names: list[str]) -> list[dict[str, object] | None]:
    """How each typed name is read, one answer per line typed (``None`` for a blank line), for the correction controls of the source editor. ``typed`` is the line exactly as it was sent, so the editor can tell whether it is still the same line when a correction comes back."""
    return [parse(n).describe(x) if n else None for x, n in ((x, _tidy(x)) for x in names)]


def surname(text: str) -> str:
    """The name an in-text citation uses: the family name, or the whole of an institution."""
    return parse(text).family
