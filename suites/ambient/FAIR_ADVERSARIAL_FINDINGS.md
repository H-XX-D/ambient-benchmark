# AMBIENT fair-adversarial battery

A benchmark your own system scores 100 percent on is a mirror, not a measurement.
This battery is built to do the opposite: to genuinely try to break the Recall
store, fairly, and to report where it breaks.

## What "fair" means here (all four enforced per axis)

1. Both-direction headroom. Every axis contains cases that should pass and cases
   that can fail, so the score can land anywhere from 0 to 100. An axis that can
   only produce 100 is rigged and was rejected.
2. Inputs are not hand-matched to the mechanism. Hard cases come from a rule that
   stresses the store, or from real held-out data, not from author intuition
   about what the store handles.
3. Same-capability-class. The store is only scored on what it claims to do.
   Probes that need a capability this build does not have (point-in-time as-of
   query, auto-detecting an undeclared contradiction from raw text) are marked
   UNTESTED with the reason, never scored as a failure.
4. Report the breaking point, not a trophy. Each axis reports a threshold or a
   curve, and separates store failures from model failures where a model is in
   the loop.

Each axis was built and run by one agent, then an independent skeptic agent
judged the test itself for fairness and believability before the number was
trusted. All eight axes were graded SOLID (fair, believable, real headroom).

## Axes and breaking points

| Axis | Model | Result (where it breaks) |
|------|-------|--------------------------|
| supersession-distance | none | Undeclared updates (rely on retrieval ranking) fall off a cliff at distance d about 29 to 32: the fused reranker only reorders the top 30 lexical candidates, so once the newer value sits past raw rank 30 the recency prior can never lift it. Declared `contradicts` also breaks at the same d (sinks confidence but leaves stale cells in the lexical pool). Declared `supersede` holds 100 percent through d=256, because it removes the stale cell from active search. |
| retrieval-haystack | none | Unrelated distractors: no break through N=20000 (needle survives). Collision distractors that share the query vocabulary: clean cascade, precision@1 gone by N=100, recall@10 gone by N=5000. Root cause is BM25 length-normalization, a terse keyword-only decoy outranks the slightly longer real fact. Semantic (hash:v1) never returns empty by default, so absent-query false positives are 100 percent without a score threshold. |
| confidence-laundering | none | Naive repetition never launders (flat at the 0.70 single-admit cap through R=1000), and support-lift is tanh-bounded at 0.85. But a self-corroboration ring of declared `supports` edges raises effective confidence above the cap (0.85 by R=5). Bounded, but it does breach, and there is no provenance-cycle detection. |
| sybil-forgery | none | Breaks immediately at M=2. `scores.effective` aggregates support mass but is provenance-blind: it ignores origin, verification, and signature, so two weak unverified sybils out-weigh one better-attested genuine source. Damage is bounded (100 sybils are no worse than 5, tanh ceiling) but truth loses, and the verified attestation is inert on the scored surface. |
| expiry-temporal | none | Breaks on precision, in extraction. `extractExpiryV1` matches month names by substring (`normalized.includes(month)`), so non-temporal words invent an expiry: mayor, dismayed, mayhem, maybe, mayonnaise, Mayan, marching, Juneau, Juneteenth, Augustus, Aprilia. 14 of 14 ambiguous beliefs get a spurious expiry, precision falls to about 38 percent worst case. Recall stays 100 percent. Q3/Q4 are out of the policy's declared Q1/Q2 scope (UNTESTED). |
| poisoning-injection | 3B | The write-side firewall held 100 percent over its declared single-substitution coverage. It breaks outside that scope: a digit-lookalike after `(` in a phone escapes the normalizer, and the card path scans raw text so the normalizer never applies, so payment-card and US-phone leak at obfuscation level L2, SSN and email survive to L3. The 3B keep/skip decision is degenerate (a separate model cap, reported apart). |
| paraphrase-entailment | 3B | The store's surfacing floor holds 100 percent at the shipped default (delta 0.15, contradictor confidence 0.8). It breaks on the sweep: floor recall goes to 0 once delta >= 0.4 (the contradicts-edge collapse tops out at about 0.363, so a larger delta can never be crossed) or once contradictor confidence <= 0.25. Detection of a paraphrase-contradiction from raw text is the model's job and is UNTESTED for the store. |
| heldout-locomo | 3B | Regression re-check on real LOCOMO (conv-26, 24 questions). Store-side retrieval recall: @1 42 percent, @3 71 percent, @5 75 percent, @10 83 percent, a hard ceiling at 83 percent (4 of 24 gold sessions never surface in top 10). The verbatim transcript is guaranteed present, so misses are pure BM25 index misses, not build misses. No crash, no empty retrievals, no non-ASCII drops: the store shows no regression signature, and the curve is consistent with the known design-faithful ~83 percent. |

## Real bugs surfaced (follow-up, in the Recall source, not this repo)

These are honest defects the fair fight drew out. They belong in the
`recall-memory-substrate` source, tracked here so the finding is not lost:

1. `extractExpiryV1` month matching is substring, not word-boundary. It invents
   expiries on words that merely contain a month token. Fix: match on word
   boundaries. Requires a new versioned expiry policy (the current one has a
   sha256 drift guard).
2. Source aggregation (`scores.effective`) is provenance-blind. Verification and
   origin do not weight, so sybil corroboration beats a better-attested truth
   from M=2. Fix: apply a trust/verification multiplier or diversity discount.
3. The firewall lookalike normalizer has coverage gaps: a digit-lookalike after
   `(` in a phone number, and the raw-text card path that bypasses the
   normalizer entirely. Obfuscated PII leaks past L2/L3.
4. Undeclared and `contradicts`-only "current value" retrieval is capped by the
   top-30 candidate pool: past that distance the recency prior cannot recover the
   newest write. `supersede` is the reliable path for currency; this should be
   documented, and the pool limit reconsidered for recency-sensitive queries.
5. Declared `supports` rings launder effective confidence above the single-admit
   cap. No provenance-cycle detection exists.

## Also in this drop

- `ambient-bench-xl.mjs`: the deterministic ladder (L1 to L4) scaled to 2859
  cases. It still scores 100 percent, which is the point: scale alone is a
  mirror. Its value is that all four negative controls break as required (so the
  100 is verified non-tautological) and the scale-up surfaced two real gotchas:
  `admit()` dedupes by body content so templated beliefs with identical text
  silently merge, and `extractExpiryV1` supports only Q1/Q2.
- `ambient-graph-qa-local.mjs`: the local-model pipeline. A 3B builds a Recall
  graph with real supersede edges, a fresh 3B answers from the retrieved graph,
  and grading is external (the answerer never grades itself). On a 12-item probe
  the 3B scored 83.3 percent, with one build-side miss (a false supersede
  poisoned retrieval) and one answer-side miss (correct retrieval, model
  refused), which is exactly the blame-localization the split is for.

## Running

Model-free axes run directly:

    node --disable-warning=ExperimentalWarning suites/ambient/ambient-adv-supersession-distance.mjs

Model-mediated axes (`poisoning-injection`, `paraphrase-entailment`,
`heldout-locomo`, and `ambient-graph-qa-local.mjs`) expect a local
OpenAI-compatible endpoint on port 8081 serving a 3B instruct model:

    mlx_lm.server --model mlx-community/Qwen2.5-3B-Instruct-4bit --port 8081
