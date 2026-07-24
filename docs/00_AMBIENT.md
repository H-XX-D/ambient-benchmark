# 00 · AMBIENT

Agentic Memory Benchmark: Baseline-Isolated Evaluation, Normalized Tiers.

## Why this exists

Read-accuracy benchmarks (LoCoMo, LongMemEval) grade a model's answer given
history. Two things they cannot do: tell whether the memory system or the model
produced the answer, and see whether the store surfaced anything unprompted. So
they measure a model-plus-memory bundle and hand the credit to whoever markets it.
AMBIENT grades the memory system's own contribution, with the model fixed, and
treats the ability to trace where an answer came from as the price of entry.

## Substrate-neutral by construction

AMBIENT defines a scoring frame and an adapter interface, not a memory design. Any
substrate that can report what it served and where that came from can be measured.
Recall is only the first system tested, not a reference the benchmark
assumes. When a system has no native auto-capture, AMBIENT supplies a
reference auto-ingestion harness so the same reader model can build the
memory store before questions begin. The rules (RULES.md) never mention a
data structure.

## Two axes

AMBIENT scores on a grid, not a line.

- Capability axis, what memory can do: the AMBIENT capability levels (L1 to L4,
  formerly named SENTINEL) and the 18-area profile.
- Attribution axis, how much the memory contributed: the four tiers.

A cell is (capability, tier). The figure reported for a capability is its
normalized lift: the score with memory on minus the T1 baseline, model held
constant.

## The four tiers (2x2 ablation)

Two independent components, automatic capture and the curated store, each on or
off:

| tier | auto-capture | curated store |
|------|--------------|---------------|
| T1 baseline      | off | off |
| T2 auto only     | on  | off |
| T3 auto + custom | on  | on  |
| T4 custom only   | off | on  |

Deltas, per capability, model held constant:

- T2 over T1: value of automatic capture alone.
- T4 over T1: value of the curated store alone.
- T3 over T2: what curation adds on top of auto.
- T3 over T4: what auto adds on top of curation.
- interaction: T3 over T1 compared with the sum of (T2 over T1) and (T4 over T1).
  Greater means synergy, less means redundancy.

The mis-attribution guard: a system whose T4 already matches T3 is getting no value
from its automatic capture, however impressive T3 looks alone.

## Attribution: correct, wrong, or gullible

Each answer is scored correct, wrong, or gullible. An answer scores for the memory only
when it is correct and the harness watched a store call supply the support; a correct
answer produced with no store call is the model knowing it, not the memory, and earns
nothing. This is why an observable store call is mandatory: with no call to watch, you
cannot tell the store's contribution from the model's own knowledge, and crediting the
model to the memory is the one error the benchmark refuses to make. Full contract in
docs/ATTRIBUTION.md.

## The capability suite

AMBIENT's core capabilities (formerly named SENTINEL): L1 unprompted value-flip, L2
entailed contradiction, L3 transitive inconsistency, L4 stale-by-expiry, plus sibling
axes (trust discrimination, belief-revision audit, poisoned-memory quarantine,
prompt-injection resistance). Each capability test runs across the four tiers to yield
a normalized, attributable lift. See docs/10_AMBIENT_SUITE.md.

Prompt-injection resistance is the adversarial edge of the gullible verdict: a system
that follows an injected instruction is gullible, one that flags or refuses it is
correct. It also has a trend dimension: the system's resistance to an actor should
escalate as that actor's injection attempts recur, and relax only with elapsed time,
not because the actor reset or overwrote anything. How a system achieves this (a
warning value, a reputation score, anything) does not matter; only the behavior is
scored (Rule 6).

## Running: corpus size and reader backend

The corpus and question set come in three sizes, small, medium, and large, selected
at run time, so a quick smoke and a stress run use the same tasks at different scale.
The fixed reader model is a backend: either a local llama-server or an online
OpenAI-compatible API selected by key. The model is held constant across systems and
tiers whichever backend is chosen. See corpora/ and model/.

## Status

The deterministic AMBIENT core runs green here against a vendored build of Recall,
the first system tested. That core exercises Recall's own primitives, so until the
capabilities go through the adapter contract the numbers show Recall, not a neutral
field. The adapter contract, the reference auto-ingestion harness, a second
substrate, the sized corpora, the reader backends, and the tier runner are the next
build. See ROADMAP.md.
