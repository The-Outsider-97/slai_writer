"""Writer's proofreading layer: one place where spelling, grammar and style findings are produced, checked and normalised.

SLAI's spell checker and grammar processor stay what they are: *providers*. What was wrong in v2.3 (reproduced with the screenshot of 16 November) was
that their output went to the page unchecked:

* "Timeline" was flagged because SLAI's English word list has no "timeline"; the suggestions began with "Timeliine", which is not a word either;
* names (Yarla, Abiarra, WTPA) and a document's own terminology were flagged as typos;
* the grammar processor said "Convinced" disagrees with its subject and offered "Convinceds", and said "a" is wrong before "a" (suggesting "an").

This module puts four things around the providers, none of which needs SLAI to be installed:

1. a lexicon (SLAI's word list read directly, plus the supplement and the person's own words) that knows inflections of newer words, hyphenated and
   prefixed forms, and the American / British pairs; spelling suggestions are generated and ranked here, and a suggestion that is not a word is dropped;
2. a rule engine for the mistakes that can be recognised with certainty from the words next to the error (a / an by pronunciation, repeated words,
   agreement with a pronoun subject, "should of", capital letters after a full stop, spacing before punctuation, ...);
3. a verifier that every provider finding must pass (a replacement that is not a word, an "agreement" finding on a participle, an article finding
   that disagrees with the pronunciation rule) before it is shown;
4. one normaliser: category, exact range, explanation, replacements, confidence, severity and provider on every result; unchanged and invalid replacements
   rejected; overlapping findings deduplicated by priority; low-confidence findings suppressed.

Nothing here sends text anywhere. Providers that run locally are the only ones used; the text of a document never leaves the computer.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from . import proofing_data as D

OBJ = "￿"      # replaced below by the text model's own object character
try:                # pragma: no cover - the text model is always there inside Writer
    from .textmodel import OBJ as OBJ  # type: ignore[no-redef]  # noqa: F811
except Exception:   # noqa: BLE001
    pass

MIN_CONFIDENCE = 0.6
WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*", re.U)
TOKEN = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*|\d+(?:[.,]\d+)*|[^\w\s]", re.U)
PROTECTED = re.compile(r"(?:https?://|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+|10\.\d{4,9}/\S+|(?:[A-Za-z]:\\|/)[\w./\\-]{3,}|[#@]\w+|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[\w-]+\.(?:docx?|xlsx?|pptx?|pdf|txt|csv|json|html?|css|jsx?|tsx?|py|png|jpe?g|gif|svg|zip|md|sldc|exe|dll|log|xml|ya?ml)\b")
ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "eg", "ie", "fig", "no", "vol", "pp", "approx", "cf", "al", "inc", "ltd", "co",
                 "dept", "ed", "eds", "ch", "sec", "p", "ca", "est", "min", "max", "mt", "ft", "viz", "op", "ibid", "cp", "resp", "nr", "dhr", "mevr", "mw", "bijv", "enz", "ir", "drs", "mr"}
MODALS = {"can", "could", "should", "would", "will", "must", "may", "might", "shall"}
BEFORE_BARE_VERB = MODALS | {"to", "let", "lets", "let's", "make", "makes", "made", "help", "helps", "helped", "see", "saw", "watch", "watched", "hear", "heard", "have", "has", "had",
                             "get", "gets", "got", "want", "wants", "wanted", "need", "needs", "needed", "did", "do", "does", "didn't", "don't", "doesn't", "bid", "dare", "rather",
                             "that", "whether", "though"}     # "that he go": the subjunctive ("it is essential that he go") is correct, so a subject after these is left alone
CLOSED_CLASS = {"is", "are", "am", "was", "were", "be", "been", "being", "and", "or", "of", "in", "on", "at", "as", "if", "it", "its", "i", "into", "not", "but", "to", "by", "for", "with",
                "can", "could", "will", "would", "should", "shall", "may", "might", "must", "has", "have", "had", "does", "do", "did", "that", "which", "who", "whom", "whose", "this",
                "these", "those", "then", "than", "also", "he", "she", "we", "you", "they", "them", "us", "his", "her", "their", "our", "my", "your", "so", "up", "out", "off", "over",
                "about", "after", "before", "from", "under", "until", "while", "when", "where", "how", "why", "what", "all", "any", "each", "every", "no", "nor", "yet", "too", "very"}
PREPOSITIONS = {"of", "in", "on", "at", "for", "with", "by", "from", "about", "into", "over", "under", "through", "between", "against", "without", "within", "among", "toward", "towards", "upon", "onto", "across", "behind", "beyond", "than"}
LABEL_WORDS = {"vol", "volume", "part", "section", "chapter", "appendix", "table", "figure", "fig", "item", "step", "case", "phase", "type", "class", "group", "level", "article", "page",
               "p", "pp", "no", "plan", "option", "option", "grade", "category", "stage", "version", "point", "list", "rule", "clause", "annex", "exhibit", "scenario", "question"}
SUBJECT_ONE = {"he", "she", "it"}
SUBJECT_MANY = {"i", "you", "we", "they"}
PAST_MARKERS = re.compile(r"\b(yesterday|ago|last (?:night|week|month|year|summer|winter|spring|autumn|fall|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b", re.I)
HABIT_MARKERS = {"will", "would", "used", "every", "each", "usually", "often", "always", "never", "sometimes", "if", "when", "whenever", "tomorrow", "next", "going"}
NOT_WORDS_BEFORE_TO = {"went", "came", "took", "gave", "wrote", "knew", "ate", "ran", "began", "drove", "flew", "drank", "sang", "swam", "spoke", "chose", "forgot", "threw", "wore", "broke"}


# ----------------------------------------------------------------------------------------------------------------------------------- the result type
@dataclass
class Issue:
    block: str
    start: int
    end: int
    text: str
    kind: str                       # "spelling" | "grammar" | "style": which mark the editor draws
    category: str                   # spelling | grammar | punctuation | capitalization | agreement | usage | style
    rule: str
    message: str
    replacements: list[str] = field(default_factory=list)
    confidence: float = 0.8
    severity: str = "error"         # error | warning | info
    provider: str = "Writer"

    def public(self, block_text: str) -> dict[str, Any]:
        key = f"{self.block}|{self.rule}|{self.start}|{self.text}|{block_text[max(0, self.start - 12):self.end + 12]}"
        first = self.replacements[0] if self.replacements else None
        return {"id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16], "kind": self.kind, "category": self.category, "block": self.block, "start": self.start,
                "end": self.end, "text": self.text, "message": self.message, "suggestions": self.replacements[:5], "replacement": first,
                "suggestion": (f"Change “{self.text}” to “{first}”." if first else None), "severity": self.severity, "confidence": round(self.confidence, 2),
                "rule": self.rule, "provider": self.provider, "source": self.provider,
                "context": [block_text[max(0, self.start - 12):self.start], block_text[self.end:self.end + 12]]}


# ------------------------------------------------------------------------------------------------------------------------------------- the lexicon
def _distance(a: str, b: str, limit: int) -> int:
    """Damerau-Levenshtein (adjacent transpositions count one), giving up above ``limit``."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous2: list[int] | None = None
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i] + [0] * len(b)
        low = current[0]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            value = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            if previous2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                value = min(value, previous2[j - 2] + 1)
            current[j] = value
            low = min(low, value)
        if low > limit:
            return limit + 1
        previous2, previous = previous, current
    return previous[-1]


def _sound(word: str) -> str:
    """A small phonetic key: equal keys mean the words are probably said alike (so "definately" finds "definitely")."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return ""
    w = re.sub(r"^(kn|gn|pn|wr)", lambda m: m.group(1)[1], w)
    for a, b in (("ph", "f"), ("ck", "k"), ("sch", "sk"), ("tch", "ch"), ("dg", "j"), ("gh", ""), ("wh", "w"), ("c(?=[eiy])", "s"), ("c", "k"), ("q", "k"), ("x", "ks"), ("z", "s")):
        w = re.sub(a, b, w)
    head, tail = w[0], re.sub(r"[aeiouy]", "", w[1:])
    return head + re.sub(r"(.)\1+", r"\1", tail)


def _case_like(original: str, word: str) -> str:
    if original.isupper() and len(original) > 1:
        return word.upper()
    if original[:1].isupper():
        return word[:1].upper() + word[1:]
    return word


_LEXICONS: dict[tuple[str, str, str], "Lexicon | None"] = {}
_LEXICON_LOCK = threading.Lock()


class Lexicon:
    """The words of one language: SLAI's list (read directly), the supplement, the person's dictionary, and the word forms derived from those."""

    def __init__(self, language: str, words: set[str], source: str, extra: Iterable[str] = ()) -> None:
        self.language, self.source = language, source
        self.words = words
        extras = {w.lower() for w in extra}
        if language == "en":
            for w in D.SUPPLEMENT_EN:
                extras |= self._forms(w.lower())
            extras |= {w for w in D.US_UK.values()} | set(D.US_UK)
            for w in D.REGULAR_VERBS:
                extras |= self._forms(w)
        self.words |= extras
        self.common = {w.lower() for w in D.COMMON_EN} if language == "en" else set()
        self.by_length: dict[int, list[str]] | None = None
        self._cache: dict[str, list[str]] = {}

    @staticmethod
    def _forms(w: str) -> set[str]:
        out = {w, w + "s", w + "'s", w + "’s", w + "es"}
        if w.endswith("y") and len(w) > 2 and w[-2] not in "aeiou":
            out |= {w[:-1] + "ies", w[:-1] + "ied"}
        out |= {w + "ed", w + "d", w + "ing", w + "er", w + "ers", w + "ly"}
        if w.endswith("e"):
            out |= {w[:-1] + "ing"}
        return out

    @classmethod
    def load(cls, language: str, slai_root: Path | None, data_dir: Path | None = None) -> "Lexicon | None":
        key = (language, str(slai_root), str(data_dir))
        with _LEXICON_LOCK:
            if key in _LEXICONS:
                return _LEXICONS[key]
            words: set[str] = set()
            source = ""
            library = (slai_root / "src" / "agents" / "language" / "library") if slai_root else None
            candidates = [library / f"wordlist_{language}.json", library / f"structured_wordlist_{language}.json", library / f"wordlist_{language}.txt"] if library else []
            if data_dir:
                candidates.append(data_dir / "dictionaries" / f"{language}.txt")
            for path in candidates:
                try:
                    if not path.is_file() or path.stat().st_size < 8:
                        continue
                    if path.suffix == ".json":
                        payload = json.loads(path.read_text(encoding="utf-8"))
                        inner = payload.get("words") if isinstance(payload, dict) else None
                        listed = inner if isinstance(inner, (dict, list)) else payload       # {"words": [...]}, or {word: 1} where "words" is itself a word
                        words |= {str(w).lower() for w in listed}
                    else:
                        words |= {w.lower() for w in re.split(r"[\s,;]+", path.read_text(encoding="utf-8")) if w}
                    source = source or path.name
                    if len(words) >= 5000:
                        break                                               # the first complete list is enough: the others hold the same words with extra data
                except (OSError, ValueError):
                    continue
            lex = cls(language, words, source) if len(words) >= 5000 else None      # a list this small would flag nearly every word
            _LEXICONS[key] = lex
            return lex

    # -- knowing a word -------------------------------------------------------------------------------------------------------------------------
    def _inflected(self, w: str) -> bool:
        """A regular inflection of a listed word that the list itself lacks ("prioritizes", "rasterised"). Stops at doubled-letter mistakes ("occured")."""
        words = self.words
        ok = lambda stem: len(stem) >= 4 and stem in words and stem not in D.MISSPELLINGS
        cvc = lambda stem: len(stem) >= 3 and stem[-1] not in "aeiouwxy" and stem[-2] in "aeiou" and stem[-3] not in "aeiou"
        for suffix in ("ies", "ied"):
            if w.endswith(suffix) and ok(w[:-3] + "y"):
                return True
        for suffix in ("es", "s"):
            if w.endswith(suffix) and ok(w[:-len(suffix)]):
                return True
        for suffix in ("ed", "ing", "er", "ers", "est", "ly", "ness", "ment", "ments"):
            if not w.endswith(suffix):
                continue
            stem = w[:-len(suffix)]
            if suffix in ("ed", "ing") and stem.endswith("e") and not stem.endswith(("ee", "ye", "oe")):
                continue                                                  # "hopeing": the final e is dropped in a correct form
            if suffix in ("ed", "ing", "er", "ers", "est") and cvc(stem):
                continue                                                  # "occured", "begining": the final letter is doubled in a correct form
            if ok(stem) or (suffix in ("ed", "ing", "er", "ers", "est") and (ok(stem + "e") or (len(stem) > 5 and stem[-1] == stem[-2] and ok(stem[:-1])))):
                return True
        if w.endswith(("ers", "er", "r", "rs", "d", "ds")) and any(ok(w[:-n] + "e") for n in (2, 3, 1) if w[:-n]):
            pass
        for suffix in ("r", "rs", "d", "ds"):
            if w.endswith(suffix) and w[-len(suffix) - 1:-len(suffix)] == "e" and ok(w[:-len(suffix)]):
                return True
        return False

    def has(self, w: str) -> bool:
        return w.lower().replace("’", "'") in self.words

    def known(self, word: str) -> bool:
        """Whether ``word`` is a word: in the list, an inflection or possessive of one, a hyphenated compound of words, or a safe prefix + word."""
        w = word.lower().replace("’", "'")
        if w in D.MISSPELLINGS and self.language == "en":
            return False                                                   # in SLAI's list, but a typo ("wich", "accomodate")
        if w in self.words:
            return True
        if w.endswith(("'s", "s'")) and w[:-2] in self.words:
            return True
        if w.endswith("n't") and (w[:-3] in self.words or w[:-3] in {"ca", "wo", "sha", "ai"}):
            return True
        for suffix in ("'re", "'ve", "'ll", "'d", "'m"):
            if w.endswith(suffix) and w[:-len(suffix)] in self.words:
                return True
        if "-" in w:
            return all(part == "" or part in self.words or part.isdigit() for part in w.split("-"))
        if self.language != "en":
            return False
        if self._inflected(w):
            return True
        if len(w) < 8:
            return False
        for prefix in ("non", "anti", "pre", "post", "multi", "semi", "inter", "intra", "over", "under", "sub", "super", "ultra", "co", "mid", "micro", "macro", "mini", "counter", "cyber", "re", "un", "dis", "mis", "out"):
            if w.startswith(prefix) and len(w) - len(prefix) >= 4 and w[len(prefix):] in self.words:
                return True
        if w not in _RUN_TOGETHER:                                    # two words written as one ("timeline" is such a word; "eachother" is a typo)
            for cut in range(4, len(w) - 3):
                if w[:cut] in self.words and w[cut:] in self.words and len(w) <= 14:
                    return True
        return False

    # -- suggestions ----------------------------------------------------------------------------------------------------------------------------
    @staticmethod
    def _edits1(w: str) -> set[str]:
        letters = "abcdefghijklmnopqrstuvwxyz'"
        splits = [(w[:i], w[i:]) for i in range(len(w) + 1)]
        deletes = {a + b[1:] for a, b in splits if b}
        swaps = {a + b[1] + b[0] + b[2:] for a, b in splits if len(b) > 1}
        replaces = {a + c + b[1:] for a, b in splits if b for c in letters}
        inserts = {a + c + b for a, b in splits for c in letters}
        return deletes | swaps | replaces | inserts

    def suggest(self, word: str, extra: Iterable[str] = (), limit: int = 5) -> list[str]:
        """Ranked replacements, every one a word: one edit away first, two only when nothing is that close; said-alike and common words rank higher."""
        w = word.lower().replace("\u2019", "'")
        if w in self._cache:
            return [_case_like(word, c) for c in self._cache[w]]
        letters = re.sub(r"[^a-z']", "", w)
        pool: dict[str, int] = {}
        ok = lambda c: c != w and c in self.words and c not in D.MISSPELLINGS and (c.isalpha() or "'" in c)
        fixed = D.MISSPELLINGS.get(w) if self.language == "en" else None
        if fixed:
            pool[fixed] = 0
        first = self._edits1(letters) if len(letters) <= 24 else set()
        for c in first:
            if ok(c):
                pool[c] = 1
        if sum(1 for d in pool.values() if d == 1) < 3 and 4 <= len(letters) <= 13:
            for e1 in first:
                for c in self._edits1(e1):
                    if c not in pool and ok(c):
                        pool[c] = 2
        for cand in extra:
            c = re.sub(r"[^A-Za-z']", "", str(cand)).lower()
            if c and c != w and c not in pool and self.known(c) and _distance(letters, c, 3) <= 3:
                pool[c] = _distance(letters, c, 3)
        key = _sound(letters)
        ranked: list[tuple[float, str]] = []
        for cand, d in pool.items():
            score = d * 2.0
            score -= 0.8 if cand[:1] == letters[:1] else 0.0
            score -= 0.3 if cand[-1:] == letters[-1:] else 0.0
            score -= 1.1 if _sound(cand) == key else 0.0
            score -= 1.2 if cand in self.common else 0.0
            score -= 0.5 if sorted(cand) == sorted(letters) else 0.0       # the same letters in another order: a transposition
            score -= 3.0 if d == 0 else 0.0                                # the known correction of a common typo
            score += 0.25 * abs(len(cand) - len(letters))
            score += 0.35 if cand.endswith("ing") != letters.endswith("ing") else 0.0
            score += 0.2 * (len(cand) > 9)
            ranked.append((score, cand))
        ranked.sort()
        out = [c for _, c in ranked][:limit]
        self._cache[w] = out
        return [_case_like(word, c) for c in out]


_RUN_TOGETHER = {"eachother", "aswell", "infact", "incase", "atleast", "alot", "noone", "everytime", "allright", "thankyou", "inspite", "alittle", "aloud", "whatshisname"}


# ---------------------------------------------------------------------------------------------------------------------------- a / an by pronunciation
_UNI_VOWEL = ("unin", "unimp", "unimag", "unident", "uninv", "unins", "unir", "unimm", "unimb", "unimit")
_SILENT_H = ("hour", "honest", "honor", "honour", "heir", "hono")
_H_EITHER = ("herb", "homage", "histor", "hotel", "hallelujah")
_YOO = ("use", "usu", "usa", "usi", "uti", "uto", "ubi", "ura", "uri", "uro", "eu", "ewe", "one", "once", "ufo", "ukul", "unanim", "unesco", "uvul", "ute", "uter")


def _word_sound(low: str) -> bool | None:
    if low.startswith(_H_EITHER):
        return None
    if low.startswith(_SILENT_H):
        return True
    if low.startswith("uni"):
        return low.startswith(_UNI_VOWEL)
    if low.startswith(("usher", "usurp")):
        return True
    if low.startswith(_YOO):
        return False
    return low[:1] in "aeiou"


def vowel_sound(word: str) -> bool | None:
    """Whether ``word`` starts with a vowel *sound* (so takes "an"); None when that cannot be told (a symbol, an unknown acronym, an ambiguous word)."""
    raw = word.strip("\u201c\u201d\"'(\u2018\u2019[")
    if not raw:
        return None
    if raw[0].isdigit():
        digits = re.sub(r"\D", "", re.split(r"[-\u2013%]", raw)[0])
        if not digits:
            return None
        if len(digits) == 4 and digits[:2] in ("11", "18"):
            return None                                                  # a year: "an eighteen hundred" or "a one thousand eight hundred"
        if digits[0] == "8" or (digits[:2] in ("11", "18") and len(digits) % 3 == 2):
            return True
        return False
    letters = re.sub(r"[^A-Za-z]", "", raw.split("-")[0] if "-" in raw and len(raw.split("-")[0]) == 1 else raw)
    if not letters:
        return None
    if len(letters) > 1 and not letters.isupper() and any(c.isupper() for c in letters[1:]):
        return None                                                      # HttpOnly, iPhone, eBay: how it is said cannot be told from the spelling
    if len(letters) == 1:
        return letters.upper() in D.VOWEL_LETTERS if letters.isupper() or "-" in raw else None
    if letters.isupper():                                                # an initialism or an acronym
        if letters in D.ACRONYM_AS_WORD:
            return _word_sound(letters.lower())
        spelled = letters[0] in D.VOWEL_LETTERS
        if letters in D.ACRONYM_SPELLED or not re.search(r"[AEIOU]", letters):
            return spelled
        as_word = _word_sound(letters.lower())
        return spelled if as_word == spelled else None                   # an unknown acronym: only when both readings agree
    return _word_sound(letters.lower())


# ----------------------------------------------------------------------------------------------------------------------------------- verb forms
def third_person(verb: str) -> str:
    if verb == "have":
        return "has"
    if verb == "do":
        return "does"
    if verb == "go":
        return "goes"
    if verb == "be":
        return "is"
    if verb.endswith(("s", "x", "z", "ch", "sh", "o")):
        return verb + "es"
    if verb.endswith("y") and len(verb) > 2 and verb[-2] not in "aeiou":
        return verb[:-1] + "ies"
    return verb + "s"


def past_tense(verb: str) -> str:
    if verb in D.IRREGULAR:
        return D.IRREGULAR[verb][0]
    if verb.endswith("e"):
        return verb + "d"
    if verb.endswith("y") and len(verb) > 2 and verb[-2] not in "aeiou":
        return verb[:-1] + "ied"
    return verb + "ed"


_BASE = (set(D.REGULAR_VERBS) | {v for v in D.IRREGULAR if v not in ("be", "read", "put", "set")}) - {"like", "close", "direct", "fall", "lead", "count", "care", "check", "change"}
_THIRD = {third_person(v): v for v in _BASE} | {"has": "have", "does": "do", "goes": "go"}
_PAST_TO_BASE = {past: base for base, (past, part) in D.IRREGULAR.items() if past not in (base, "was")}
_PAST_PARTICIPLE = {past: part for base, (past, part) in D.IRREGULAR.items() if past != part and past not in ("was", "read")}


# ------------------------------------------------------------------------------------------------------------------------------------- the rules
@dataclass
class Tok:
    text: str
    start: int
    end: int

    @property
    def low(self) -> str:
        return self.text.lower().replace("’", "'")

    @property
    def is_word(self) -> bool:
        return self.text[:1].isalpha()


def tokenize(text: str) -> list[Tok]:
    return [Tok(m.group(0), m.start(), m.end()) for m in TOKEN.finditer(text)]


def _protected_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in PROTECTED.finditer(text)]


def _inside(spans: list[tuple[int, int]], start: int, end: int) -> bool:
    return any(a <= start and end <= b for a, b in spans)


def _adjacent(text: str, a: Tok, b: Tok) -> bool:
    gap = text[a.end:b.start]
    return bool(gap) and gap.strip() == "" and "\n" not in gap


def grammar_rules(text: str, block: str, *, language: str, is_heading: bool = False) -> list[Issue]:
    """Findings that can be recognised with certainty from the words around them. English rules run only on English text."""
    found: list[Issue] = []
    toks = tokenize(text)
    spans = _protected_spans(text)
    english = language == "en"

    def add(start: int, end: int, kind: str, category: str, rule: str, message: str, replacements: list[str], confidence: float, severity: str = "error") -> None:
        if _inside(spans, start, end):
            return
        found.append(Issue(block, start, end, text[start:end], kind, category, rule, message, replacements, confidence, severity))

    # -- repeated words ("the the") -----------------------------------------------------------------------------------------------------------------
    for a, b in zip(toks, toks[1:]):
        if a.is_word and b.is_word and a.low == b.low and len(a.text) > 1 and _adjacent(text, a, b) and a.low not in {"had", "that"}:
            add(a.start, b.end, "grammar", "grammar", "repeated-word", f"“{a.text}” is repeated.", [a.text], 0.9)

    # -- spacing and punctuation --------------------------------------------------------------------------------------------------------------------
    for m in re.finditer(r"(?<=\S)[ \t]+([,.;:!?])(?!\d)", text):
        if m.group(1) in ".:" and re.match(r"\s*[.:]\w", text[m.start():m.end() + 2]):
            continue
        add(m.start(), m.end(), "grammar", "punctuation", "space-before-punctuation", "No space before this punctuation mark.", [m.group(1)], 0.85)
    for m in re.finditer(r"(?<=[^\W\d_]),(?=[^\W\d_])", text):
        add(m.start(), m.end(), "grammar", "punctuation", "space-after-comma", "A comma is followed by a space.", [", "], 0.85)
    for m in re.finditer(r"(?<=[^\W\d_\s])  +(?=[^\W\s])", text):
        add(m.start(), m.end(), "grammar", "punctuation", "double-space", "One space is enough between words.", [" "], 0.7, "info")
    for m in re.finditer(r"([,;:!?])\1+|(?<!\.)\.\.(?!\.)", text):
        add(m.start(), m.end(), "grammar", "punctuation", "repeated-punctuation", "The punctuation mark is repeated.", [m.group(0)[0]], 0.8)

    # -- the pronoun I (and I'm, I'll, I've, I'd); a sentence that starts in lower case ------------------------------------------------------------------
    for i, t in enumerate(toks if english else ()):
        if (t.text == "i" or re.fullmatch(r"i['’](?:m|ll|ve|d)", t.text)) and not _inside(spans, t.start, t.end):
            before = text[t.start - 1:t.start] if t.start else ""
            after = text[t.end:t.end + 1]
            previous = toks[i - 1].low if i else ""
            if before in ("(", "[", "/", "\\") or after in (")", "]", "-", ".", "/", "\u2013") or previous in LABEL_WORDS or (previous == "." and i > 1 and toks[i - 2].low in LABEL_WORDS):
                continue
            add(t.start, t.end, "grammar", "capitalization", "pronoun-i", "The pronoun “I” is always a capital letter.", ["I" + t.text[1:]], 0.85)
    for m in re.finditer(r"(?<=[a-z]{2})([.!?])(?=(?:[A-Z][a-z]+|the|i|it|he|she|we|they|a|an|and|but|this|that|de|het|een|ik|hij|zij|wij)\b)", text):
        add(m.start(), m.end(), "grammar", "punctuation", "space-after-period", "A sentence ends with a space after the full stop.", [m.group(1) + " "], 0.8)
    if not is_heading:
        for i in range(2, len(toks)):
            t, p = toks[i], toks[i - 1]
            if p.text in ".!?" and t.is_word and t.text[:1].islower() and t.start - p.end >= 1 and text[p.end:t.start].strip() == "" and "\n" not in text[p.end:t.start]:
                q = toks[i - 2]
                if q.low in ABBREVIATIONS or (len(q.text) == 1 and q.text.isalpha()) or q.text == "." or not q.is_word:
                    continue
                if any(ch.isupper() for ch in t.text[1:]):
                    continue
                add(t.start, t.end, "grammar", "capitalization", "sentence-capital", "A sentence starts with a capital letter.", [t.text[:1].upper() + t.text[1:]], 0.8)

    if language == "nl":
        found += _dutch_rules(text, block, toks, spans)
    if not english:
        return found

    # -- a / an --------------------------------------------------------------------------------------------------------------------------------------------------
    for a, b in zip(toks, toks[1:]):
        if a.low in ("a", "an") and (b.is_word or b.text[:1].isdigit()) and _adjacent(text, a, b) and b.low not in ("a", "an") and b.low not in CLOSED_CLASS:
            sound = vowel_sound(b.text)
            if sound is None:
                continue
            want = "an" if sound else "a"
            if a.low != want:
                add(a.start, a.end, "grammar", "grammar", "article-a-an", f"Use “{want}” before “{b.text}”, which starts with {'a vowel' if sound else 'a consonant'} sound.",
                    [_case_like(a.text, want)], 0.9)

    # -- subject / verb agreement with a pronoun subject ---------------------------------------------------------------------------------------------
    for i in range(len(toks) - 1):
        s, v = toks[i], toks[i + 1]
        if not (s.is_word and v.is_word and _adjacent(text, s, v)):
            continue
        before = toks[i - 1].low if i else ""
        if before in PREPOSITIONS or (s.text == "i" and before in LABEL_WORDS):
            continue                                                       # "in the middle of it start": the pronoun is the object of the preposition; "Vol i is" is a numeral
        if (before in BEFORE_BARE_VERB or before.endswith("n't")) and not (s.low in SUBJECT_ONE | SUBJECT_MANY and v.low in ("are", "were", "is", "was")):
            continue
        w = v.low
        if s.low in SUBJECT_ONE:
            if w in _BASE and w not in ("be", "may", "might", "will", "can", "must", "shall", "should", "would", "could", "need", "dare"):
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “{third_person(w)}”, not “{v.text}”.", [_case_like(v.text, third_person(w))], 0.86)
            elif w in ("are",):
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “is”, not “{v.text}”.", [_case_like(v.text, "is")], 0.88)
            elif w == "have":
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “has”, not “{v.text}”.", [_case_like(v.text, "has")], 0.86)
            elif w == "don't":
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “doesn't”, not “{v.text}”.", [_case_like(v.text, "doesn't")], 0.9)
        elif s.low in SUBJECT_MANY:
            if w in _THIRD and w not in ("is", "was") and s.low != "you" or (w in _THIRD and s.low == "you" and w not in ("is", "was")):
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “{_THIRD[w]}”, not “{v.text}”.", [_case_like(v.text, _THIRD[w])], 0.86)
            elif w in ("is", "was") or (w == "are" and s.low == "i"):
                fix = {"i": {"is": "am", "was": "was", "are": "am"}, "you": {"is": "are", "was": "were"}, "we": {"is": "are", "was": "were"}, "they": {"is": "are", "was": "were"}}[s.low].get(w)
                if fix and fix != w:
                    add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “{fix}”, not “{v.text}”.", [_case_like(v.text, fix)], 0.88)
            elif w == "doesn't":
                add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” takes “don't”, not “{v.text}”.", [_case_like(v.text, "don't")], 0.9)
        elif s.low in ("these", "those") and w in ("is", "was"):
            add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“{s.text}” is plural: use “{'are' if w == 'is' else 'were'}”.", [_case_like(v.text, "are" if w == "is" else "were")], 0.85)
        elif s.low == "this" and w in ("are", "were"):
            add(v.start, v.end, "grammar", "agreement", "subject-verb", f"“this” is singular: use “{'is' if w == 'are' else 'was'}”.", [_case_like(v.text, "is" if w == "are" else "was")], 0.85)

    # -- verb forms after helpers ----------------------------------------------------------------------------------------------------------------------
    for i in range(len(toks) - 1):
        h, v = toks[i], toks[i + 1]
        if not (h.is_word and v.is_word and _adjacent(text, h, v)):
            continue
        hl, vl = h.low, v.low
        if (hl in MODALS or hl in ("did", "didn't", "does", "doesn't", "do", "don't", "to")) and (vl in NOT_WORDS_BEFORE_TO or (vl in _THIRD and hl != "to" and vl not in ("is", "was", "has"))):
            base = _PAST_TO_BASE.get(vl) or _THIRD.get(vl)
            if base and not (hl == "to" and vl in _THIRD):
                add(v.start, v.end, "grammar", "grammar", "verb-form", f"After “{h.text}” the verb stays in its base form: “{base}”.", [_case_like(v.text, base)], 0.85)
        elif hl in ("has", "have", "had", "having") and vl in _PAST_PARTICIPLE:
            add(v.start, v.end, "grammar", "grammar", "participle", f"After “{h.text}” use “{_PAST_PARTICIPLE[vl]}”, not “{v.text}”.", [_case_like(v.text, _PAST_PARTICIPLE[vl])], 0.85)

    # -- tense: a past time word with a present-tense verb after the subject -----------------------------------------------------------------------------
    for sentence in re.finditer(r"[^.!?\n]+[.!?]?", text):
        chunk = sentence.group(0)
        if not PAST_MARKERS.search(chunk):
            continue
        lowered = set(re.findall(r"[a-z']+", chunk.lower()))
        if lowered & HABIT_MARKERS or "?" in chunk:
            continue
        for tk in tokenize(chunk):
            pass
        ct = [Tok(t.text, t.start + sentence.start(), t.end + sentence.start()) for t in tokenize(chunk)]
        for i in range(len(ct) - 1):
            s, v = ct[i], ct[i + 1]
            if s.is_word and v.is_word and _adjacent(text, s, v):
                if s.low in SUBJECT_MANY and v.low in _BASE and v.low not in ("can", "may", "must", "will", "have", "do", "need", "be") and len(v.low) > 2:
                    add(v.start, v.end, "grammar", "grammar", "tense", f"“{v.text}” is present tense, but the sentence is about the past.", [_case_like(v.text, past_tense(v.low))], 0.72, "warning")
                elif s.low in SUBJECT_ONE and v.low in _THIRD and v.low not in ("is", "was", "has", "does"):
                    base = _THIRD[v.low]
                    add(v.start, v.end, "grammar", "grammar", "tense", f"“{v.text}” is present tense, but the sentence is about the past.", [_case_like(v.text, past_tense(base))], 0.72, "warning")

    # -- words that are often confused ---------------------------------------------------------------------------------------------------------------------
    for pattern, replacement, message, rule in D.SIMPLE_PHRASES:
        for m in re.finditer(pattern, text, re.I):
            if _inside(spans, m.start(), m.end()):
                continue
            fixed = m.expand(replacement) if "\\" in replacement else replacement
            fixed = _case_like(m.group(0), fixed) if m.group(0)[:1].isupper() else fixed
            if fixed.lower() != m.group(0).lower():
                add(m.start(), m.end(), "grammar", "usage", rule, message, [fixed], 0.88)
    for m in re.finditer(r"\b(its)\s+(a|an|the|not|been|being|going|just|very|also|still|really|always|never|almost|too|so|time)\b", text, re.I):
        add(m.start(1), m.end(1), "grammar", "usage", "its-it's", "“It's” (it is, it has) is needed here, not the possessive “its”.", [_case_like(m.group(1), "it's")], 0.82)
    for m in re.finditer(r"\b(it['’]s)\s+(own|purpose|name|size|shape|value|meaning|role|effect|impact|goal|history|creator|owner|author)\b", text, re.I):
        add(m.start(1), m.end(1), "grammar", "usage", "its-it's", "The possessive “its” has no apostrophe.", [_case_like(m.group(1), "its")], 0.8)
    for m in re.finditer(r"\b(your)\s+(a|an|the|going|not|welcome|being|too|very|so|right|wrong|correct|doing)\b", text, re.I):
        add(m.start(1), m.end(1), "grammar", "usage", "your-you're", "“You're” (you are) is needed here, not the possessive “your”.", [_case_like(m.group(1), "you're")], 0.8)
    for m in re.finditer(r"\b(more|less|better|worse|rather|bigger|smaller|larger|greater|higher|lower|faster|slower|easier|harder|older|younger|taller|longer|shorter|other)\s+(then)\b", text, re.I):
        add(m.start(2), m.end(2), "grammar", "usage", "than-then", "After a comparison use “than”, not “then”.", [_case_like(m.group(2), "than")], 0.85)
    for m in re.finditer(r"\b(there)\s+(own)\b", text, re.I):
        add(m.start(1), m.end(1), "grammar", "usage", "there-their", "“Their” (belonging to them) is needed here.", [_case_like(m.group(1), "their")], 0.8)

    # -- style: optional improvements, never errors ------------------------------------------------------------------------------------------------------
    for pattern, replacement, message, rule in D.STYLE_PHRASES:
        for m in re.finditer(pattern, text, re.I):
            if replacement:
                add(m.start(), m.end(), "style", "style", rule, message, [_case_like(m.group(0), replacement)], 0.65, "info")
    return found


_NL_SUBJECT = {"ik": {1}, "jij": {2}, "je": {2}, "hij": {3}, "het": {3}, "zij": {3, 4}, "ze": {3, 4}, "wij": {4}, "we": {4}, "jullie": {4}}
# Dutch present tense by person: 1 singular, 2 singular, 3 singular, 4 plural. Only verbs whose wrong forms are common and unambiguous.
_NL_VERBS = {"worden": ("word", "wordt", "wordt", "worden"), "hebben": ("heb", "hebt", "heeft", "hebben"), "zijn": ("ben", "bent", "is", "zijn"),
             "kunnen": ("kan", "kunt", "kan", "kunnen"), "willen": ("wil", "wilt", "wil", "willen"), "zullen": ("zal", "zult", "zal", "zullen"),
             "gaan": ("ga", "gaat", "gaat", "gaan"), "komen": ("kom", "komt", "komt", "komen"), "moeten": ("moet", "moet", "moet", "moeten"),
             "mogen": ("mag", "mag", "mag", "mogen")}
_NL_FORM_OWNER: dict[str, set[int]] = {}
for _v, _forms in _NL_VERBS.items():
    for _i, _f in enumerate(_forms):
        _NL_FORM_OWNER.setdefault(_f, set()).add(_i + 1)
_NL_ALLOWED_PAIRS = {("je", "kan"), ("je", "zal"), ("je", "wil"), ("jij", "kan"), ("jij", "zal"), ("jij", "wil")}      # colloquial, accepted
_NL_BEFORE_INFINITIVE = {"laat", "laten", "liet", "lieten", "zie", "zien", "zag", "zagen", "hoor", "horen", "hoorde", "hoorden", "voel", "voelen", "voelde", "kan", "kunt", "kunnen",
                         "wil", "wilt", "willen", "moet", "moeten", "mag", "mogen", "zal", "zult", "zullen", "ga", "gaat", "gaan", "blijf", "blijft", "blijven", "help", "helpt",
                         "helpen", "leer", "leert", "leren", "te", "om", "dat", "of", "als"}
_NL_COMPARATIVES = ("beter", "groter", "kleiner", "sneller", "hoger", "lager", "langer", "korter", "mooier", "slechter", "duurder", "goedkoper", "zwaarder", "lichter", "sterker",
                    "zwakker", "makkelijker", "moeilijker", "ouder", "jonger", "liever")


def _dutch_rules(text: str, block: str, toks: list["Tok"], spans: list[tuple[int, int]]) -> list[Issue]:
    """The few Dutch mistakes that can be recognised with certainty: the verb after a pronoun ("hij word"), and "groter als"."""
    out: list[Issue] = []
    for i, (s, v) in enumerate(zip(toks, toks[1:])):
        if not (s.is_word and v.is_word and _adjacent(text, s, v)) or _inside(spans, v.start, v.end):
            continue
        persons = _NL_SUBJECT.get(s.low)
        owners = _NL_FORM_OWNER.get(v.low)
        if not persons or not owners or owners & persons or (s.low, v.low) in _NL_ALLOWED_PAIRS:
            continue
        if i and toks[i - 1].low in _NL_BEFORE_INFINITIVE and 4 in owners:
            continue                                                  # "ik zie het gaan": the pronoun is an object here
        for forms in _NL_VERBS.values():
            if v.low in forms:
                right = forms[min(persons) - 1]
                out.append(Issue(block, v.start, v.end, v.text, "grammar", "agreement", "nl-subject-verb", f"Na “{s.text}” hoort “{right}”, niet “{v.text}”.", [_case_like(v.text, right)], 0.86))
                break
    for m in re.finditer(r"\b(" + "|".join(_NL_COMPARATIVES) + r")\s+(als)\b", text, re.I):
        out.append(Issue(block, m.start(2), m.end(2), m.group(2), "grammar", "usage", "nl-dan-als", "Na een vergrotende trap hoort “dan”, niet “als”.", [_case_like(m.group(2), "dan")], 0.8))
    return out


# -------------------------------------------------------------------------------------------------------------------------------------- spelling
def guess_language(text: str) -> str | None:
    """"en" or "nl" when the words say so clearly, otherwise None (so nothing is forced on a paragraph in a language that cannot be told)."""
    words = re.findall(r"[a-z']+", text.lower())
    if len(words) < 6:
        return None
    en = sum(w in D.STOP_EN for w in words)
    nl = sum(w in D.STOP_NL for w in words)
    if nl >= 3 and nl > 1.6 * en:
        return "nl"
    if en >= 3 and en > 1.6 * nl:
        return "en"
    return None


def document_vocabulary(blocks: Iterable[tuple[str, str, str]]) -> tuple[dict[str, int], dict[str, int]]:
    """({lower word: occurrences}, {lower word: occurrences written capitalised in the middle of a sentence}) for the whole document."""
    counts: dict[str, int] = {}
    mid_caps: dict[str, int] = {}
    for _, text, _type in blocks:
        toks = tokenize(text.replace(OBJ, " "))
        for i, t in enumerate(toks):
            if not t.is_word:
                continue
            counts[t.low] = counts.get(t.low, 0) + 1
            starts = i == 0 or toks[i - 1].text in ".!?:" or text[toks[i - 1].end:t.start].count("\n")
            if t.text[:1].isupper() and not starts:
                mid_caps[t.low] = mid_caps.get(t.low, 0) + 1
    return counts, mid_caps


def spelling_issues(text: str, block: str, *, lex: Lexicon, locale: str, block_type: str, counts: dict[str, int], mid_caps: dict[str, int],
                    known: set[str], slai: Callable[[str], tuple[bool, list[str]]] | None) -> list[Issue]:
    found: list[Issue] = []
    clean = text.replace(OBJ, " ")
    toks = tokenize(clean)
    spans = _protected_spans(clean)
    is_heading = block_type == "heading"
    uk = locale == "en-GB"
    us = locale == "en-US"
    uk_forms = {v: k for k, v in D.US_UK.items()}
    for i, t in enumerate(toks):
        if not t.is_word or len(t.text) < 2 or _inside(spans, t.start, t.end):
            continue
        word = t.text
        if (t.start and clean[t.start - 1].isdigit()) or (t.end < len(clean) and clean[t.end].isdigit()):
            continue
        low = t.low
        if low in known or word.isupper() or any(ch.isupper() for ch in word[1:]) and not word[1:].islower() and not word.istitle():
            continue
        if lex.known(word) or (slai is not None and low not in D.MISSPELLINGS and slai(word)[0]):
            if lex.language == "en" and low not in D.US_UK_AMBIGUOUS:
                if uk and low in D.US_UK:
                    found.append(Issue(block, t.start, t.end, word, "spelling", "spelling", "locale-variant", f"“{word}” is the American spelling; this document is in British English.",
                                       [_case_like(word, D.US_UK[low])], 0.7, "info"))
                elif us and low in uk_forms and low != uk_forms[low]:
                    found.append(Issue(block, t.start, t.end, word, "spelling", "spelling", "locale-variant", f"“{word}” is the British spelling; this document is in American English.",
                                       [_case_like(word, uk_forms[low])], 0.7, "info"))
            continue
        starts_sentence = i == 0 or toks[i - 1].text in ".!?" or "\n" in clean[toks[i - 1].end:t.start]
        capitalised = word[:1].isupper()
        if capitalised and (not starts_sentence or is_heading):
            continue                                                        # a name in the middle of a sentence, or a title-case heading
        if capitalised and starts_sentence:
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if mid_caps.get(low, 0) >= 1 or counts.get(low, 0) >= 2 or (nxt is not None and nxt.is_word and nxt.text[:1].isupper() and _adjacent(clean, t, nxt)):
                continue                                                    # the same name elsewhere, or part of a name
            near = lex.suggest(word, limit=5)
            if not (low in D.MISSPELLINGS or any(c.lower() in lex.common or sorted(c.lower()) == sorted(low) for c in near)):
                continue                                                    # "Yarla said ...": nothing common is near it, so it is probably a name, not a typo
        if counts.get(low, 0) >= 3:
            continue                                                        # used three times or more: the document's own terminology
        extra = slai(word)[1] if slai is not None else ()
        suggestions = [s for s in lex.suggest(word, extra) if s.lower() != low and lex.known(s)]
        if "-" in word:
            continue
        confidence = 0.9 if suggestions else 0.65
        if capitalised:
            confidence -= 0.1
        found.append(Issue(block, t.start, t.end, word, "spelling", "spelling", "unknown-word", f"“{word}” is not in the dictionary.", suggestions[:5], confidence,
                           "error" if suggestions else "warning", "Writer dictionary" if slai is None else "SLAI spell checker + Writer dictionary"))
    return found


# --------------------------------------------------------------------------------------------------------------------- verifying a provider's finding
def verify_provider_issue(raw: dict[str, Any], text: str, lex: Lexicon | None) -> Issue | None:
    """A finding from SLAI's grammar processor, or None when it does not hold. Rules here are about *evidence*, not about hiding the provider."""
    start, end = raw.get("start"), raw.get("end")
    replacement = raw.get("replacement")
    if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(text) or not isinstance(replacement, str) or not replacement.strip():
        return None
    original = text[start:end]
    if original == replacement:
        return None
    rule = str(raw.get("rule") or "").lower()
    message = str(raw.get("message") or "A possible grammar problem.")
    words = WORD.findall(replacement)
    if lex is not None and any(not lex.known(w) for w in words):
        return None                                                          # "Convinceds": a replacement that is not a word
    follower = re.match(r"\s*(\S+)", text[end:])
    if "article" in rule or "article" in message.lower():
        probe = follower.group(1) if follower else ""
        if original.lower() not in ("a", "an") or not probe:
            return None
        sound = vowel_sound(probe)
        if sound is None or replacement.lower() != ("an" if sound else "a") or original.lower() == replacement.lower():
            return None                                                      # the pronunciation rule disagrees: "a" before "a" is a repeated word, not an article
    if "subject" in rule or "agreement" in message.lower() or "subject-verb" in rule:
        low = original.lower()
        if re.search(r"(ed|ing)$", low) or low in D.IRREGULAR or any(low == v[0] or low == v[1] for v in D.IRREGULAR.values()):
            return None                                                      # a participle or past tense does not agree with a subject
    return Issue(str(raw.get("block", "")), start, end, original, "grammar", "grammar", str(raw.get("rule") or "slai-grammar"), message, [replacement],
                 float(raw.get("confidence") or 0.8), "warning", "SLAI grammar processor")


# ----------------------------------------------------------------------------------------------------------------------------------- normalising
_PRIORITY = {"repeated-word": 0, "article-a-an": 1, "subject-verb": 1, "unknown-word": 2}


def normalise(issues: list[Issue], text: str, *, lex: Lexicon | None, ignore_rules: set[str] | None = None) -> list[Issue]:
    """Drop the invalid and the weak, merge duplicates, order by position. One finding per stretch of text: the one with the strongest evidence."""
    ignore_rules = ignore_rules or set()
    good: list[Issue] = []
    for issue in issues:
        if not (0 <= issue.start < issue.end <= len(text)) or text[issue.start:issue.end] != issue.text:
            continue
        issue.replacements = [r for i, r in enumerate(issue.replacements) if r and r != issue.text and r not in issue.replacements[:i]
                              and (issue.kind != "spelling" or lex is None or all(lex.known(w) for w in WORD.findall(r)))]
        if issue.category in ("grammar", "agreement", "usage") and issue.rule not in ("repeated-word",) and not issue.replacements:
            continue
        if issue.confidence < MIN_CONFIDENCE or f"{issue.rule}|{issue.text.lower()}" in ignore_rules:
            continue
        good.append(issue)
    good.sort(key=lambda i: (i.start, _PRIORITY.get(i.rule, 3), -i.confidence, i.end - i.start))
    out: list[Issue] = []
    for issue in good:
        clash = next((o for o in out if issue.start < o.end and o.start < issue.end), None)
        if clash is None:
            out.append(issue)
        elif (issue.kind != "style") and clash.kind == "style":
            out[out.index(clash)] = issue
        elif issue.provider != clash.provider and issue.rule == clash.rule and issue.start == clash.start and issue.end == clash.end:
            clash.provider = f"{clash.provider} + {issue.provider}"           # found by both: one card
            clash.confidence = max(clash.confidence, issue.confidence)
    return sorted(out, key=lambda i: (i.start, i.end))


# ---------------------------------------------------------------------------------------------------------------------------------- the proofreader
@dataclass
class Result:
    available: bool
    issues: list[dict[str, Any]]
    reason: str | None = None
    truncated: bool = False
    providers: list[str] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)


def split_language(tag: str | None) -> tuple[str, str]:
    """("en", "en-GB") from "en-GB"; ("en", "en") from "en": spellings of either country are accepted until the document says which one it is written in."""
    tag = (tag or "en").replace("_", "-")
    base = tag.split("-")[0].lower() or "en"
    if base == "en":
        low = tag.lower()
        return "en", ("en-GB" if low in ("en-gb", "en-au", "en-nz", "en-ie", "en-za", "en-in") else "en-US" if low == "en-us" else "en")
    return base, tag


class Proofreader:
    """Checks blocks of text. ``spell_provider`` and ``grammar_provider`` are optional SLAI components; without them Writer's own layer still works."""

    def __init__(self, *, slai_root: Path | None = None, data_dir: Path | None = None, spell_provider: Callable[[], Any] | None = None,
                 grammar_provider: Callable[[list[tuple[str, str]]], list[dict[str, Any]]] | None = None) -> None:
        self.slai_root, self.data_dir = slai_root, data_dir
        self.spell_provider = spell_provider
        self.grammar_provider = grammar_provider
        self._cache: OrderedDict[tuple, list[Issue]] = OrderedDict()
        self._lock = threading.Lock()

    def lexicon(self, language: str) -> Lexicon | None:
        return Lexicon.load(language, self.slai_root, self.data_dir)

    def _slai_spell(self) -> Callable[[str], tuple[bool, list[str]]] | None:
        if self.spell_provider is None:
            return None
        try:
            checker = self.spell_provider()
        except Exception:                                                   # noqa: BLE001 - a missing component must not stop Writer's own checks
            return None

        def ask(word: str) -> tuple[bool, list[str]]:
            try:
                r = checker.check(word)
            except Exception:                                               # noqa: BLE001
                return False, []
            if not getattr(r, "checkable", True):
                return True, []
            return bool(getattr(r, "is_correct", True)), [str(getattr(s, "word", s)) for s in getattr(r, "suggestions", ())]
        return ask

    def check(self, blocks: list[tuple[str, str, str]], *, language: str, all_blocks: list[tuple[str, str, str]] | None = None,
              kinds: Iterable[str] = ("spelling", "grammar"), known_words: Iterable[str] = (), ignore_rules: Iterable[str] = (),
              paragraph_languages: dict[str, str] | None = None, limit: int = 400) -> Result:
        """``blocks`` is [(id, text, type)] to check; ``all_blocks`` (default: the same) is what the document's vocabulary is learned from."""
        kinds = set(kinds)
        base, locale = split_language(language)
        known = {w.lower() for w in known_words}
        ignored = set(ignore_rules)
        counts, mid = document_vocabulary(all_blocks or blocks)
        lex = self.lexicon(base) if base in ("en", "nl") else None
        slai = self._slai_spell() if base == "en" else None
        out: list[dict[str, Any]] = []
        reasons: list[str] = []
        providers = ["Writer rules"]
        skipped: list[dict[str, str]] = []
        want_spelling = "spelling" in kinds
        if want_spelling and lex is None and slai is None:
            reasons.append(f"No word list is installed for {base.upper()}: spelling is not checked for this language. "
                           f"Put a word list (one word per line) in the SLAI language library or in Writer's data folder (dictionaries/{base}.txt) to turn it on.")
        elif want_spelling:
            providers.append("Writer dictionary")
        if slai is not None:
            providers.append("SLAI spell checker")
        grammar_raw: list[dict[str, Any]] = []
        sentence_blocks = [(i, t) for i, t, ty in blocks if ty in ("paragraph", "heading", "list_item", "quote") and t.strip()]
        if "grammar" in kinds and self.grammar_provider is not None and base == "en":
            try:
                grammar_raw = list(self.grammar_provider(sentence_blocks) or [])
                providers.append("SLAI grammar processor")
            except Exception as exc:                                        # noqa: BLE001 - optional component
                reasons.append(f"SLAI's grammar processor is not available ({getattr(exc, 'message', None) or type(exc).__name__}); Writer's own grammar rules ran.")
        by_block: dict[str, list[dict[str, Any]]] = {}
        for raw in grammar_raw:
            by_block.setdefault(str(raw.get("block")), []).append(raw)
        for block_id, text, block_type in blocks:
            if block_type not in ("paragraph", "heading", "list_item", "quote") or not text.strip():
                continue
            clean = text.replace(OBJ, " ")
            lang_here = (paragraph_languages or {}).get(block_id, base)
            guess = guess_language(clean)
            if guess is not None and guess != lang_here and (paragraph_languages or {}).get(block_id) is None:
                skipped.append({"block": block_id, "reason": f"This paragraph looks {guess.upper()}, not {lang_here.upper()}: it was not checked."})
                continue
            key = (block_id if False else None, clean, lang_here, locale, tuple(sorted(kinds)), want_spelling and lex is not None, slai is not None,
                   hash(tuple(sorted(known))), tuple(sorted(ignored)), tuple(raw.get("rule", "") + str(raw.get("start")) for raw in by_block.get(block_id, ())),
                   block_type == "heading", tuple(sorted((w, counts.get(w, 0) >= 3, mid.get(w, 0) >= 1, counts.get(w, 0) >= 2) for w in set(w.lower() for w in WORD.findall(clean)) if w not in known and not (lex and lex.known(w)))))
            with self._lock:
                cached = self._cache.get(key)
                if cached is not None:
                    self._cache.move_to_end(key)
            if cached is None:
                found: list[Issue] = []
                if want_spelling and lex is not None:
                    found += spelling_issues(clean, block_id, lex=lex, locale=locale, block_type=block_type, counts=counts, mid_caps=mid, known=known, slai=slai)
                elif want_spelling and slai is not None:
                    found += _slai_only_spelling(clean, block_id, slai, known)
                if "grammar" in kinds or "style" in kinds:
                    found += [i for i in grammar_rules(clean, block_id, language=lang_here, is_heading=block_type == "heading") if i.kind in kinds | ({"grammar", "style"} if "grammar" in kinds else set())]
                    for raw in by_block.get(block_id, ()):
                        verified = verify_provider_issue({**raw, "block": block_id}, clean, lex)
                        if verified is not None:
                            found.append(verified)
                cached = normalise(found, clean, lex=lex, ignore_rules=ignored)
                with self._lock:
                    self._cache[key] = cached
                    while len(self._cache) > 3000:
                        self._cache.popitem(last=False)
            for issue in cached:
                if issue.kind in kinds:
                    out.append(issue.public(clean))
                    if len(out) >= limit:
                        return Result(True, out, " ".join(reasons) or None, True, providers, skipped)
        available = not (want_spelling and lex is None and slai is None and kinds == {"spelling"})
        return Result(available, out, " ".join(reasons) or None, False, providers, skipped)


def _slai_only_spelling(text: str, block: str, slai: Callable[[str], tuple[bool, list[str]]], known: set[str]) -> list[Issue]:
    """When Writer cannot read a word list itself, SLAI's checker alone decides (still with the rules about names and verified suggestions)."""
    found = []
    for t in tokenize(text):
        if t.is_word and len(t.text) > 2 and not t.text.isupper() and t.low not in known:
            ok, suggestions = slai(t.text)
            if not ok:
                found.append(Issue(block, t.start, t.end, t.text, "spelling", "spelling", "unknown-word", f"“{t.text}” is not in the dictionary.", suggestions[:5], 0.8, "error",
                                   "SLAI spell checker"))
    return found
