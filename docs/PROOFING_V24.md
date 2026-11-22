# Proofreading (SLAI Writer v2.4)

Request part 3: intelligent spelling and grammar. The problems were reproduced from the 16 November screenshot: "Timeline" flagged with the suggestion "Timeliine";
names and terminology flagged; grammar saying "Convinced" disagrees with its subject ("Convinceds") and that "a" is wrong before "a".

## Design

SLAI's spell checker and grammar processor remain **providers**. `proofing.py` puts one layer around them (nothing leaves the computer):

1. a lexicon (SLAI's list read directly, plus a supplement and the person's own words) that knows inflections of newer words, hyphenated/prefixed forms and the
   US/UK pairs; suggestions are generated and ranked there and a suggestion that is not a word is dropped;
2. a rule engine for mistakes recognisable with certainty from the neighbouring words (a/an by pronunciation, repeated words, agreement with a pronoun subject,
   "should of", capitals after a full stop, spacing before punctuation, ...);
3. a verifier every provider finding must pass before it is shown;
4. one normaliser: category, exact range, explanation, ranked replacements, confidence, severity and provider on each result; unchanged/invalid replacements rejected;
   overlaps deduplicated; low-confidence findings suppressed.

Server: `proofing.py`, `proofing_data.py`, `assist.py` (route `/api/docs/{id}/proof`). Client: `panels/proof.ts` (panel), `decor.ts` (marks as CSS highlights).

## Interface

Marks: spelling red, grammar blue (solid), style blue dotted. Switches for Spelling / Grammar / Style (style suggestions off by default). Panel cards show category,
reason and ranked suggestions; **Accept** changes exactly that text (one undo step); **Ignore once**, **Ignore all** (this document), **Add to dictionary** (this document)
and **Add to my dictionary** (every document); Next/Previous walk the findings; Recheck; a per-document language (Dutch grammar rules for Dutch; a language without a
word list says so and marks nothing). Results computed for older text are never painted at old offsets: text typed during a check triggers a recheck. Typing never
waits for a check. A check never changes the document.

## Before / after (reproducible)

`python -m applications.slai_writer.tests.proofing_eval` on `tests/proofing_corpus.py` (366 words of clean text, 53 planted mistakes). "Before" replays what SLAI's own
SpellChecker answered for each corpus word (recorded in `tests/fixtures/slai_spell_baseline.json`) through the v2.3 rules.

| | v2.3 (spelling only) | v2.4 |
|---|---|---|
| false positives on the clean text | 19 (Timeline x3, names, don't/it's/you're, db_cache, https, docx, organisation's ...) | 0 |
| planted mistakes found | 17 of the 21 spelling mistakes (v2.3 checked spelling only) | 53 of 53 (spelling, grammar and style together) |
| first suggestion correct | 16 of 21 | 52 of 53 (any of the top 3: 53) |

The two columns count different sets (v2.3 could only see spelling), so only the false-positive row is directly comparable; the
corpus is in `tests/proofing_corpus.py` and the numbers come from running the command above.

Caveats, stated plainly: the corpus was authored alongside the rules, so the v2.4 numbers show the cases were fixed, not general accuracy on unseen text; no claim of
better accuracy beyond this corpus is made. The grammar processor of SLAI could not be run in the development environment (its word lists are missing there);
grammar results there come from the rule engine. Typos embedded in SLAI's own list beyond the corrected `MISSPELLINGS` remain possible.

## Other limits

* No Dutch word list is installed, so Dutch spelling is unavailable (grammar rules for Dutch work). SLDC has no span-level language, so language is per document.
* Provider-unavailable now reports "unavailable" instead of silently returning nothing (a contract change from 2.3).

Tests: `test_proofing.py`, `test_proofreading_safety.py`, `test_assist.py`, `tests_ts/proof_status.test.ts`, `tests_e2e/proofing.mjs` (11 scenarios).
