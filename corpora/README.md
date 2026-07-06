# corpora/

The information a system ingests to build its store, plus the questions that probe
it. Two tracks, both driven by the same segment schema (see `reconstruct.py`'s
docstring and `areas.mjs`):

## Absorbed: BEAM + LongMemEval (`reconstruct.py`)

`reconstruct.py` fetches BEAM and LongMemEval from their official Hugging Face
releases and normalizes them locally; nothing third-party is redistributed here
(see [LICENSES.md](LICENSES.md), [sources.json](sources.json)). Sizes map to their
own published scales:

| size   | intent           | BEAM scale | LongMemEval file            |
|--------|------------------|------------|------------------------------|
| small  | fast smoke       | 100K       | longmemeval_oracle.json      |
| medium | default run      | 500K       | longmemeval_s_cleaned.json   |
| large  | stress / scaling | 1M         | longmemeval_m_cleaned.json   |
| xlarge | BEAM-only        | 10M        | -                             |

```
python reconstruct.py --source longmemeval --tier small
python reconstruct.py --source beam --tier small
python reconstruct.py --all-small
```

LoCoMo was evaluated and excluded (CC BY-NC blocks commercial/monetized-leaderboard
use; LongMemEval already covers the same role under MIT). LongMemEval carries its
own answer-session provenance (`supportIds`, scores both halves of segment
completion); BEAM has none (correctness-only scoring), so pair the two rather than
running BEAM alone when attribution matters.

## Authored: the 15-ability profile (`areas.mjs`)

A smaller, purpose-built 92-segment corpus assembled by `areas.mjs` for structural
abilities the absorbed corpora don't target directly: supersession lineage,
holonomy (cyclic ordering), reactivity, calibration, and others ported from the
original SENTINEL 18-area profile. Output: `out/areas/small/segments.jsonl` plus
per-conversation ingest events in `out/areas/small/corpus/`.

Every segment (either track) carries a known-or-novel tag (Rule 5) and a gold answer
plus its supporting store item, so "served from outside the model" is checkable
(Rule 1 and docs/ATTRIBUTION.md).
