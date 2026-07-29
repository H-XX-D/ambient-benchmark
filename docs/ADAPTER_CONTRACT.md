# Adapter contract

A system competes in AMBIENT by implementing the MemoryAdapter interface
(adapters/contract.mjs). The contract is small on purpose, so pull, vector, graph,
and hosted systems can all run it.

## The one mandatory method: an observable query

`query(question)` must return the information the system served for the question. The
harness invokes this call, so it observes the round trip (query, information back,
response) and knows the served content came from outside the model, without the system
citing itself. That observable call is the single hard requirement.

The reason is the scoring rule (docs/ATTRIBUTION.md): an answer scores for the memory
only when it is correct and the harness watched a store call return non-empty support
that was actually served to the reader.
Returning per-item provenance (id, source, write time) is recommended and sharpens
diagnostics, but it is not the eligibility bar; the traced call is. A system that
exposes no store call cannot be traced and is ineligible, not scored zero.

HTTP adapters receive an opaque, random `X-AMBIENT-Run-ID` header on every request.
Hosted adapters must include that value in their namespace so simultaneous participant
runs cannot read, reset, or overwrite one another. It is a run-isolation identifier,
not a user identity or credential.

The runner writes that observation into every transcript row:

- `servedContext`: exact budgeted context strings shown to the reader.
- `servedProvenance`: one provenance object per served context item.
- `sourceTrace`: a harness-authored trace with memory query entries marked
  `origin: "memory_db"` and the reader answer entry marked `origin: "model_api"`.

Judging happens after answers are stored in the transcript. The judge scores the
stored answer and gold; it does not award memory credit. A deterministic attribution
gate combines the semantic verdict with the harness trace afterward. A query returning
zero items is `NOT-SERVED`, not memory support.

## Optional capabilities (a system may use them; presence is never scored)

- `write(fact)`: ingest one fact, return a receipt id. Needed to build a store,
  trivial for any system.
- `surface(newFact)`: an optional push hook a system MAY use to flag, unprompted, that
  a new fact invalidates a prior belief. It is never scored by presence: a system that
  lacks it is neither penalized nor credited (Rule 6). Any ability it serves is
  measured only by task outcome.
- `setAutoCapture(enabled)`: toggle automatic capture so the harness can run the
  four-tier ablation (auto on for T2 and T3, off for T4). A system without automatic
  capture reports not-supported and is scored on the tiers it supports.

## Why this stays fair

Every system is served the same corpus and asked the same questions through this
interface, read by the same fixed model. A segment is credited only when the answer
is correct and traced outside the model, so a stronger model cannot inflate a weak
memory and a system cannot bank the model's own knowledge. A system declares what it
cannot do rather than being silently zeroed, so lever-less incumbents score on the
rungs they actually reach.
