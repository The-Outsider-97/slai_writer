"""Measure Writer's proofreading on the curated corpus (tests/proofing_corpus.py) and, when a recorded baseline exists, compare it with Writer 2.3.

    python -m applications.slai_writer.tests.proofing_eval [--json]

The baseline (tests/fixtures/slai_spell_baseline.json) holds what SLAI's own SpellChecker answered for every word of the corpus, recorded once on a machine
that has SLAI installed; replaying it through the Writer 2.3 rules (words under 3 letters, upper-case words and words with digits skipped, everything else the
checker rejects is marked) gives the "before" numbers without needing SLAI to be importable here.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from applications.slai_writer.proofing import Proofreader, split_language
from applications.slai_writer.tests import proofing_corpus as C

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).with_name("fixtures") / "slai_spell_baseline.json"
WORD = re.compile(r"[^\W\d_][\w'’-]*", re.U)


def proofreader() -> Proofreader:
    return Proofreader(slai_root=ROOT)


def run_after(pr: Proofreader | None = None) -> dict[str, Any]:
    pr = pr or proofreader()
    fp: list[dict[str, Any]] = []
    words = 0
    for lang, btype, text, why in C.CLEAN:
        words += len(WORD.findall(text))
        r = pr.check([("b", text, btype)], language=lang, kinds=("spelling", "grammar"))
        for i in r.issues:
            fp.append({"text": text, "marked": i["text"], "kind": i["kind"], "rule": i["rule"], "lang": lang})
    hit = top1 = top3 = 0
    misses: list[dict[str, Any]] = []
    for lang, text, planted, kind, accepted, why in C.ERRORS:
        start = text.index(planted)
        end = start + len(planted)
        r = pr.check([("b", text, "paragraph")], language=lang, kinds=("spelling", "grammar"))
        found = [i for i in r.issues if i["kind"] == kind and i["start"] < end and start < i["end"]]
        if not found:
            misses.append({"text": text, "planted": planted, "why": why})
            continue
        hit += 1
        sug = [i["replacement"] for i in found if i["replacement"]] + [s for i in found for s in i["suggestions"]]
        if sug and sug[0] in accepted:
            top1 += 1
        if any(s in accepted for s in sug[:3]):
            top3 += 1
    return {"clean_words": words, "false_positives": len(fp), "fp_detail": fp, "errors": len(C.ERRORS), "hits": hit, "top1": top1, "top3": top3, "misses": misses}


def run_before() -> dict[str, Any] | None:
    """Writer 2.3's spelling on the same corpus, from the recorded SLAI answers. Grammar before is not measurable: SLAI's grammar processor cannot be run here."""
    if not FIXTURE.is_file():
        return None
    base = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def marks(text: str) -> list[tuple[int, int, str, list[str]]]:
        out = []
        for m in WORD.finditer(text):
            w = m.group(0)
            if len(w) < 3 or w.isupper() or any(c.isdigit() for c in w):
                continue
            ok, sug = base.get(w, [True, []])
            if not ok:
                out.append((m.start(), m.end(), w, sug))
        return out

    fp = []
    words = 0
    for lang, btype, text, why in C.CLEAN:
        words += len(WORD.findall(text))
        if split_language(lang)[0] != "en":
            continue                                           # 2.3 did not check other languages
        for s, e, w, sug in marks(text):
            fp.append({"text": text, "marked": w, "kind": "spelling", "suggestions": sug[:5]})
    hit = top1 = top3 = 0
    spelling_total = 0
    for lang, text, planted, kind, accepted, why in C.ERRORS:
        if kind != "spelling":
            continue
        spelling_total += 1
        start = text.index(planted)
        end = start + len(planted)
        found = [(w, sug) for s, e, w, sug in marks(text) if s < end and start < e]
        if not found:
            continue
        hit += 1
        sug = found[0][1]
        top1 += bool(sug and sug[0] in accepted)
        top3 += any(s in accepted for s in sug[:3])
    return {"clean_words": words, "false_positives": len(fp), "fp_detail": fp, "spelling_errors": spelling_total, "hits": hit, "top1": top1, "top3": top3}


def main() -> None:
    after, before = run_after(), run_before()
    if "--json" in sys.argv:
        print(json.dumps({"before": before, "after": after}, indent=2, ensure_ascii=False))
        return
    print(f"corpus: {after['clean_words']} words of clean text, {after['errors']} planted mistakes")
    if before:
        print(f"BEFORE (Writer 2.3 spelling, SLAI checker): {before['false_positives']} false positives; spelling hits {before['hits']}/{before['spelling_errors']}, "
              f"top-1 {before['top1']}, top-3 {before['top3']}")
        for f in before["fp_detail"]:
            print("   false positive:", f["marked"], "->", f["suggestions"])
    print(f"AFTER  (Writer 2.4 proofreading): {after['false_positives']} false positives; hits {after['hits']}/{after['errors']}, top-1 {after['top1']}, top-3 {after['top3']}")
    for f in after["fp_detail"]:
        print("   false positive:", f)
    for m in after["misses"]:
        print("   miss:", m)


if __name__ == "__main__":
    main()
