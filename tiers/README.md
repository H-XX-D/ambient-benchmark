# tiers/

The attribution axis: the four-tier 2x2 ablation runner. It drives one adapter across
four conditions with the model held fixed. A model judge scores semantic correctness;
a deterministic gate separately awards completion only for a correct answer with
non-empty externally served support. Reports preserve both reader accuracy and memory
completion, plus per-capability deltas and the interaction term.

Two independent components, each on or off:

| tier | auto-capture | curated store |
|------|--------------|---------------|
| T1 baseline      | off | off |
| T2 auto only     | on  | off |
| T3 auto + custom | on  | on  |
| T4 custom only   | off | on  |

The runner toggles auto-capture via `adapter.setAutoCapture` and controls whether
the curated store is loaded. When a system lacks native auto-memory, the runner
uses AMBIENT's reference auto-ingestion harness so the same reader model builds the
store before the benchmark questions begin. Reported per capability: T2 over T1
(auto alone), T4 over T1 (curation alone), T3 against the sum (synergy or
redundancy). If T4 already matches T3, the automatic capture completed no extra
segments.
