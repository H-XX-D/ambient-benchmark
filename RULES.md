# AMBIENT participation rules

AMBIENT is substrate-neutral. Any memory system can enter: a graph store, a vector
index, a flat log, a hosted service. Recall is only the first system tested,
not a reference the rules assume. These rules never mention a data structure, and
none of them favor how Recall happens to work.

## Rule 1: the one requirement to enter

A system must expose a store call the harness can route through and watch: the model
issues a query, the store receives it, returns information, and the model responds.
The harness traces that call. The model does not cite its own sources, and the system
does not have to return per-item provenance; the harness knows the information came
from outside the model because it watched the call go to the store and come back. That
observable call is the entire entry bar.

A system that exposes no such call cannot be traced and is ineligible, not scored
zero. Everything else is optional: per-item provenance, push surfacing, staleness,
calibration are all a bonus or graded, none mandatory.

## Rule 2: same corpus, same questions, same model

Every system is given the same information to build its store, asked the same
questions through the same adapter interface, and read by the same fixed model.
The model is held constant so any score difference is attributable to the memory
layer, not the model. A system that needs a stronger model to look good is
measuring the model, not the memory.

## Rule 3: ingest, then question; score correct, wrong, or gullible

The system takes in the information (ingest), then is asked questions (query). The
harness verifies the answer's support came from outside the model by watching the
store call: the model queries, the store returns information, the model responds. The
harness traces the call; the model does not self-attribute. Given the traced call,
each answer is one of three:

- CORRECT: the right answer, support traced outside the model. This completes the
  segment and is the only verdict that scores for the memory.
- WRONG: an incorrect answer to a question the record can answer.
- GULLIBLE: the system was easily fooled by misleading or contradictory input. Faced
  with a claim that contradicts an established fact (one presented as true and not
  changeable), a non-gullible system pushes back ("that conflicts with what I was told
  is true and cannot be changed") or at least asks for clarification; a gullible system
  just accepts it and runs with it. Answering an unanswerable question instead of
  abstaining is the milder form. Gullibility is a distinct, heavier failure than being
  wrong: the system was credulous, not merely mistaken. The contradiction-resolution
  and abstention segments draw it out.

A correct answer produced with no store call is the model knowing it, not the memory,
so it earns the memory nothing (the T1 baseline with no store isolates this). See
docs/ATTRIBUTION.md.

## Rule 4: four tiers, a 2x2 ablation

Two independent components, automatic capture and the curated store, each on or
off:

| tier | auto-capture | curated store | isolates |
|------|--------------|---------------|----------|
| T1 baseline     | off | off | raw model capability |
| T2 auto only    | on  | off | automatic capture alone |
| T3 auto + custom| on  | on  | full stack |
| T4 custom only  | off | on  | curated memory alone |

All four cells are run, so the interaction is visible, not just four scores. If
custom-only (T4) matches auto-plus-custom (T3), the automatic capture earned
nothing, however strong T3 looks in isolation. Report per-capability normalized
lift (memory-on score minus the T1 baseline), never a single number.

## Rule 5: shadow memory is detected, not assumed away

A system may carry hidden state: the model's own pretraining, a cache, an
undisclosed auto-capture. AMBIENT controls for it. Every item is tagged known or
novel. On known, common-knowledge facts the model answers with or without memory,
so any lift there is shadow memory, and the system is flagged for it, not credited.
Only private, novel facts may show a positive lift.

## Rule 6: score ability, not mechanism

A system is scored on how well it does the task, not on which mechanism it uses or
possesses. Whether a store resolves a contradiction with a write-time hook or by
retrieving both sides at query time is invisible to the score; only the outcome
counts. AMBIENT gives no bonus for having a particular lever (a push hook, a graph, a
standing program) and no penalty for lacking one. There is no "you lack this
primitive" rung. Mechanism-agnostic ability is the point: it is the only way a pull
system and a push system compete on one honest board. A proactive/unprompted behavior
is measured only when it is framed as an ability with a task outcome (did the system
produce the right result), never as a checkbox for owning the primitive.

## Rule 7: every number is recomputable

A reported result ships with its served context, the model transcript, and a
script that recomputes it. Structural claims are graded by deterministic code with
sha256-recomputable proofs, never through the model. A number nobody else can
reproduce is not published.

## What a system implements

One interface, `adapters/contract.mjs`. Mandatory: `query(question)` returning the
served context with provenance (Rule 1). Optional: `write`, `surface` (the push
hook), `setAutoCapture` (the tier toggle). Full contract in
`docs/ADAPTER_CONTRACT.md`.

## Testing a bare model

A model with no memory of its own is still testable. When a system has native
automatic capture, AMBIENT uses it: that native auto-memory is what the auto tiers
measure. When a system has none, AMBIENT supplies a reference auto-memory harness, a
standard capture-on-write, retrieve-on-query loop over an external store, identical
for every entrant, so the bare model can still run T2 and T3. Its served context
comes from the harness store, which is outside the model, so segments score normally.
The harness is a fallback and a shared baseline, never a substitute for a native
lever: a system with its own auto-memory is measured against the same harness, so it
scores only by beating it, not by out-engineering it. The harness lives in
`adapters/harness-automemory.mjs`.

## Corpus size and reader backend

The corpus and its questions come in three sizes: small (a fast smoke), medium (the
default), and large (a stress run). A run picks one size; the tasks are the same shape
at every scale. The fixed reader model is a backend, chosen once and held constant
across every system and tier: a local llama-server, or an online OpenAI-compatible API
selected by key. Keys are read from the environment or a local key file that never
enters the repo. See `corpora/` and `model/`.
