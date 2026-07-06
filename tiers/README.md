# tiers/

The attribution axis: the four-tier 2x2 ablation runner (to build). It drives one
adapter across four conditions with the model held fixed, scores each segment by
completion (correct answer plus support traced outside the model, see
`docs/ATTRIBUTION.md`), and reports per-capability completion rate plus the
interaction term.

Two independent components, each on or off:

| tier | auto-capture | curated store |
|------|--------------|---------------|
| T1 baseline      | off | off |
| T2 auto only     | on  | off |
| T3 auto + custom | on  | on  |
| T4 custom only   | off | on  |

The runner toggles auto-capture via `adapter.setAutoCapture` and controls whether
the curated store is loaded. Reported per capability: T2 over T1 (auto alone), T4
over T1 (curation alone), T3 against the sum (synergy or redundancy). If T4 already
matches T3, the automatic capture completed no extra segments.
