# Hard-question design

AMBIENT's generated hard track tests whether an external memory system returns enough
usable information for a fixed reader to answer correctly. Difficulty belongs in the
memory task—not in adapter bureaucracy, trivia, obscure vocabulary, or an ambiguous
judge rubric.

## Construct contract

Every world contains:

1. A deterministic seed and private opaque values, preventing pretraining recall.
2. A latent state transition, constraint system, temporal interval, relational
   chain, or evidence-selection rule.
3. Query-coupled cover history distributed across multiple sessions.
4. A mechanical answer oracle and a compact derivation proof.
5. Explicit support event indices and protected values that identify gullible
   selections such as retracted, quarantined, or adjacent-entity values.

A question is not considered hard merely because it is wordy. The generator checks
that composed answers do not occur verbatim in one event. Tasks whose answer is an
atomic stored value identify that fact explicitly: their difficulty is reaching or
selecting it through a multi-hop or evidence-ranking rule.

## Ability families

The hard track contains the ten BEAM behavior families plus three declared AMBIENT
extensions:

| Ability | Load-bearing operation |
|---|---|
| knowledge update | fold replacements and a later retraction |
| contradiction resolution | preserve two live incompatible reports |
| multi-session reasoning | traverse a 4/7/12-hop relation chain |
| temporal reasoning | separate filing time from retroactive effective time |
| event ordering | compute a unique topological order from shuffled constraints |
| information extraction | select and compose three labeled fragments |
| preference following | satisfy hard constraints before a soft preference |
| instruction following | retain an operation while applying a scoped update |
| summarization | fold ADD/REMOVE/RENAME events into canonical final state |
| abstention | reject values belonging only to confusable adjacent entities |
| trust discrimination | prefer verified evidence over correlated mirror count |
| belief-revision audit | reconstruct the last valid belief, current belief, and cause |
| poisoned-memory quarantine | use signed data without obeying an imported instruction |

Model-independent properties—concurrency, endurance, set integrity, and similar
systems behavior—remain structural tests. Turning those into prose questions would
only test whether a reader can repeat a supplied verdict.

## Size and time

| Size | Worlds per ability | Query-coupled cover events | Relation-chain depth |
|---|---:|---:|---:|
| small | 4 | 16 | 4 |
| medium | 20 | 64 | 7 |
| large | 100 | 256 | 12 |

Each generated world is an independent sample. Events and checkpoints within a
world are correlated repeated observations and never inflate the independent `n`.
These are logical-session histories; they do not establish wall-clock decay.

The development set is `calibration-v1`. The confirmatory protocol uses the disjoint
`confirmatory-v2` seed namespace at medium size: 20 worlds per ability, 260 independent
worlds, and 1,040 tier answers. Calibration answers cannot be promoted into that set.

## Qualification, scoring, and fresh-reader boundary

The only memory qualification gate is the captured three-link trace:

1. the answer path calls an external memory store;
2. at least one memory item is returned and served to the fixed reader;
3. the fixed reader produces an answer.

The answer is then graded. A wrong or gullible answer after a complete trace is a valid
benchmark failure: the returned context was not sufficient in practice for that fixed
model. A correct answer without the complete trace earns no memory credit. The report
separates trace coverage, end-to-end memory completion, and conditional accuracy so an
entrant cannot hide empty returns by shrinking the denominator.

Required-support coverage is diagnostic only. It can distinguish an incomplete return
from a reader failure despite all generator-declared support being visible, but it never
qualifies, excludes, or rescues a row.

`tiers/score-hard.mjs` compares normalized answers with the embedded exact oracle.
It does not call a judge model. A wrong answer is marked `gullible` only when the
mechanical trace shows a specific credulity failure: asserting an absent value,
choosing one side of an unresolved conflict, or returning a protected retracted,
out-of-scope, or quarantined token.

Mechanical does not mean format-hostile. The scorer normalizes irrelevant whitespace
and accepts the two sides of an unresolved conflict in either order because the state
is a set. It remains strict where order or labels carry the answer, such as event
ordering, temporal state, current-versus-previous values, and composed keys.

The four-tier runner erases every observable llama.cpp slot before each answer and
stores the boundary proof in the transcript. Backends without a slot API are marked
unproven; a fresh HTTP request is not silently promoted to proven session isolation.

## Commands

```bash
npm run corpus:hard
npm run bench:hard
npm run corpus:hard:calibration
npm run bench:hard:calibration
npm run score:hard -- results/transcript-hard-small-<adapter>.jsonl
npm run bench:hard:reader
```

`bench:hard:reader` is an oracle-support diagnostic: it supplies only the
generator-declared support events and bypasses retrieval. It is useful for interpreting
reader limitations, but it is not a memory score and never qualifies or excludes an
end-to-end row. The normal four-tier run is the memory benchmark.

## Initial calibration, not confirmatory evidence

One small calibration world per ability was run with oracle support on two models hosted
on the Z6 under v2:

- Qwen2.5 0.5B Q4_K_M: 3/13 correct, 4/13 gullible.
- Dolphin3 8B Q4_K_M: 7/13 correct, 3/13 gullible.

These are reader diagnostics, not memory scores or qualification gates. The same
Dolphin3 8B reader completed a v2 end-to-end baseline-pull calibration with complete
call-return-answer traces on all 39 memory-tier rows: T1 1/13, T2 4/13, T3 5/13,
and T4 6/13. All Ollama boundaries remain `proven:false`.

Earlier, one small world per ability was run with complete event history on two models hosted
on the Z6:

- Qwen2.5 0.5B Q4_K_M: 2/13 correct, 1/13 gullible.
- Dolphin3 8B Q4_K_M: 5/13 correct, 4/13 gullible.

These v1 runs measure full-history reader load, not oracle-support ability and not
memory sufficiency. They are only 13-world calibrations. Ollama exposed no slot-erasure API, so both artifacts
correctly report 0/13 proven-fresh boundaries. They are not longitudinal estimates
and must not be pooled with the confirmatory injection v5 results.

The same Qwen2.5 0.5B reader also completed a 13-world end-to-end four-tier
calibration using the isolated baseline-pull stores: T1 1/13, T2 2/13, T3 3/13,
and T4 2/13. T1's single success was the legitimate abstention item. All 52 answer
rows record `fresh-http-request` and `proven:false`, so this validates the pipeline
but is not a fresh-session or population estimate. The v1 transcript also omitted the
actual served text, so it is audit-incomplete under the corrected contract and cannot
be promoted to confirmatory evidence.

## Anti-tuning freeze

All current hard-track runs are exploratory calibration. Before any confirmatory run,
AMBIENT freezes the corpus seeds, reader prompt, retrieval limits, context budget,
model and quant, scorer, and protocol manifest. Any change after results are observed
requires a version bump and a full rerun of every compared system. There are no
system-specific prompts or post-result patches.

The candidate lock is `protocols/ambient-hard-confirmatory-v2.json`. It pins ten
load-bearing implementation files and the complete 261-file generated corpus tree by
SHA-256. Run `npm run verify:hard:protocol` before and after execution. The lock remains
`candidate-frozen` until an exact reader model/quant is selected; no result may be
called confirmatory before that field is filled and the version is re-locked.
