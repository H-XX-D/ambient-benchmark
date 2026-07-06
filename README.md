# AMBIENT

Agentic Memory Benchmark: Baseline-Isolated Evaluation, Normalized Tiers.

It doesn't measure what a model can't do. It measures what your memory layer
actually does for the agent.

AMBIENT measures what an agentic memory system adds to a model, with the model held
fixed and the memory's contribution isolated so no result is mis-credited. It is
substrate-neutral: any memory system can enter (a graph store, a vector index, a
flat log, a hosted service). Recall is only the first system tested, not the
definition.

You attach a memory system to a model, let it build a store from provided
information, then grade capability across four ablation tiers. AMBIENT's core test
suite (the L1 to L4 contradiction and staleness ladder plus an 18-area profile,
formerly named SENTINEL) is the capability axis; the tiers are the attribution axis.

## The rules, short form

Full text in [RULES.md](RULES.md).

1. To enter, a system must expose a store call the harness can route through and watch
   (query, information back, response). The harness traces the call; the model never
   cites itself. That is the only requirement.
2. Same corpus, same questions, same fixed model for every system.
3. Score correct, wrong, or gullible. The harness confirms the info came from a store
   call (not the model's weights), then grades the answer. Correct with no store call
   is the model knowing it, not the memory.
4. Four tiers (a 2x2 ablation of auto-capture by curated store). Report lift and
   the interaction, never one number.
5. Shadow memory is detected via a known-versus-novel split, not assumed away.
6. Score ability, not mechanism: how well a system does the task, never whether it
   owns a particular lever (push hook, graph). No bonus for having one, no penalty
   for lacking one.
7. Every number ships with its served context, transcript, and a recompute script.

## The four tiers

| tier | auto-capture | curated store | isolates |
|------|--------------|---------------|----------|
| T1 baseline      | off | off | raw model capability |
| T2 auto only     | on  | off | automatic capture alone |
| T3 auto + custom | on  | on  | full stack |
| T4 custom only   | off | on  | curated memory alone |

All four cells run, so beyond four scores you get the interaction. If custom-only
(T4) matches both (T3), the automatic capture earned nothing. If T3 beats the sum
of the T2 and T4 gains over baseline, auto and curation are synergistic. That
interaction is the thing a ranking cannot show, and the reason the tiers exist.

A bare model with no memory of its own runs the auto tiers (T2 and T3) through a
reference auto-memory harness that AMBIENT supplies, identical for every entrant, so
lever-less systems can still be placed on the ladder. See [RULES.md](RULES.md).

## Where the questions come from

AMBIENT does not invent a new corpus to make its point. Most of the question content
is absorbed from established, licensed long-term-memory benchmarks, reconstructed
from their official releases at run time (`corpora/reconstruct.py`), never
redistributed: **BEAM** (arXiv:2510.27246, CC BY-SA 4.0, scales 100K to 10M tokens)
and **LongMemEval** (arXiv:2410.10813, MIT, carries its own answer-session
provenance). LoCoMo was evaluated and excluded: its CC BY-NC license blocks
commercial or monetized-leaderboard use, and LongMemEval already covers the same
small-tier pull-plus-attribution role under MIT. See
[corpora/LICENSES.md](corpora/LICENSES.md) and
[corpora/sources.json](corpora/sources.json) for the full attribution.

A smaller, purpose-authored 92-segment / 15-ability corpus (`corpora/areas.mjs`)
supplements this for structural abilities the absorbed corpora don't target directly:
supersession lineage, holonomy (cyclic ordering), reactivity, and calibration.

What's actually novel here isn't the question content, it's the harness: the entry
bar is loosened to Rule 1 (any system exposing one traceable store call, substrate-
neutral) rather than requiring a specific mechanism, and the scoring is different
from how these corpora are normally graded, reader held constant across four
ablation tiers, correct/wrong/gullible instead of a single accuracy number, so the
result is attributable to the memory system rather than the reader.

## The capability suite

The capability axis, what memory can do: L1 unprompted value-flip, L2 entailed
contradiction, L3 transitive inconsistency, L4 stale-by-expiry, plus an 18-area
profile. This suite was formerly named SENTINEL; it is AMBIENT's core. The tiers are
the attribution axis, how much the memory contributed. Run a capability test across
the four tiers and you get a normalized lift you can honestly attribute to the memory
system. See [docs/00_AMBIENT.md](docs/00_AMBIENT.md) and
[docs/10_AMBIENT_SUITE.md](docs/10_AMBIENT_SUITE.md).

## Status

The full pipeline is built and running end to end against Recall, the first system
tested: adapter contract, four-tier runner, reference auto-memory harness, an
ingest-time write firewall, and a 92-segment / 15-ability capability corpus.

**Deterministic core** (model-free, Node 24, no keys, no network):
- L1 unprompted contradiction: recall 100%, precision 100%, 0-tick latency
- L3 transitive inconsistency: recall 100%, precision 100% (cyclic ordering
  rejected at write time)
- L2 entailed contradiction: literal baseline 0% vs entailment detector 100%
- L4 stale-by-expiry: naive age 75/50 vs expiry-aware 100/100

**Write-time model firewall**: relations (supersedes, contradicts, concerns,
ordering, collection membership) are decided by a model reading each turn against
the growing store at write time, not by regex. A regex-marker detector was tried
first and kept breaking on real prose; replacing it with model classification is
what made the harder abilities (reactivity, holonomy, enumeration) tractable at all.
See [docs/00_AMBIENT.md](docs/00_AMBIENT.md).

**The ceiling test**: to separate "the memory graph is missing something" from "the
reader can't use what it's given," we hand-constructed an ideal graph for 30
scenarios across the 15-ability corpus (no classifier noise) and ran the same served
context through two readers. A fixed 32B reader scored 20/30 (67%); a frontier
reader (gpt-4.1) on the byte-identical context scored 30/30 (100%). Every one of the
32B's misses, including a case that looked like a genuine temporal-reasoning gap,
cleared under the stronger reader. Conclusion: for this corpus, the residual gap is
reader capability, not a missing memory primitive. This is also why the fixed-reader
design is a lever, not a limitation: a mid-capability reader surfaces memory-graph
seams that a weak reader fails too broadly to isolate and a frontier reader quietly
papers over. See [docs/10_AMBIENT_SUITE.md](docs/10_AMBIENT_SUITE.md).

Open items: a fast ingest-time classifier backend (the write firewall currently rides
on the same 32B reader, which is slow at scale), the medium/large corpus sizes, and a
second non-Recall adapter to make the cross-system claim literal rather than
structural. See [ROADMAP.md](ROADMAP.md).

## Quickstart

Requires Node >= 24. No dependencies. The deterministic arms need no API keys; the
model-driven arms need a reader backend (see below).

```
npm run bench                 # L1 to L4 deterministic core
npm run bench:suite           # 18-area capability profile
npm run bench:contradiction   # admission-time contradiction gate
node tiers/runner.mjs         # the four-tier ablation runner (T1-T4), full corpus
```

The reader backend is local by default (a llama-server on port 8089) or an online
OpenAI-compatible API, chosen by `AMBIENT_MODEL_BACKEND=local|online` (see
`model/README.md`). The ingest-time write firewall's classifier is independently
configurable via `AMBIENT_CHECKER_*`, so it can run on a fast small model while the
reader stays fixed.

## Layout

```
RULES.md          the participation rules (substrate-neutral)
docs/             AMBIENT spec, capability-suite spec, attribution and adapter contracts
suites/ambient/   the AMBIENT capability suite (scripts + probes); dist symlink to the vendored build
adapters/         the fairness layer: MemoryAdapter contract (http-client.mjs), per-system adapters
                   (recall_adapter.mjs), reference auto-memory harness (harness-automemory.mjs)
tiers/            the four-tier ablation runner (runner.mjs) and the hand-constructed
                   quality-graph ceiling test (quality-graph.mjs)
corpora/          the 15-ability / 92-segment capability corpus (areas.mjs assembles it)
model/            the fixed reader backend: local llama-server or an online API by key
recall-self-run/  single-system empirical run (Recall only), pending a second adapter
vendor/recall/    Recall's pinned build (the first system tested); the current core runs on it
```
