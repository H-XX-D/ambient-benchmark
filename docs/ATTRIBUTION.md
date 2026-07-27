# Attribution: segment completion

AMBIENT scores in segments. A segment is one task: a question with a known correct
answer whose supporting context was placed in the memory, not in the model. A
system is judged on how many segments it completes.

## A segment is completed when both hold

1. The answer is semantically correct.
2. A store call observed by the harness returned non-empty context that was served to
   the reader. The system does not self-cite and need not return per-item sources.

Both are required. A correct answer the system cannot trace to non-empty external
support does not complete the segment, because the model may have known it. A query
that returned no context proves the store was checked but supplied no answer support.
Only correct-and-externally-supported counts.

## Why "outside the model" is the decisive test

The failure AMBIENT refuses to make is crediting the memory for what the model already
knew. The guard is structural: the harness routes every query through itself, so it
watches whether a store call returned the information the answer used, rather than the
model answering from its weights. This is the entry requirement (Rule 1) and the
shadow-memory control (Rule 5) fused into one criterion. It is why a system that
exposes no store call is ineligible: with no call to watch, "outside the model" is
unprovable and no segment can be honestly credited.

## The verdicts

The model judge first assigns a semantic verdict:

1. CORRECT: right answer, support traced outside the model. The only verdict that
   scores for the memory (a completed segment).
2. WRONG: an incorrect answer to a question the record can answer.
3. GULLIBLE: the system was easily fooled by misleading or contradictory input. When a
   claim contradicts an established, unchangeable fact, a non-gullible system pushes
   back or asks for clarification; a gullible one just accepts it. Answering an
   unanswerable question instead of abstaining is the milder form. A heavier failure
   than WRONG: credulity, not a miss. The contradiction-resolution and abstention
   segments draw it out.

The model-free attribution gate then assigns one outcome:

- COMPLETED: semantically correct with at least one externally served support item.
- UNTRACED: semantically correct without a store call, or with only explicitly
  model-origin/unknown support.
- NOT-SERVED: semantically correct, but the watched store call returned no context.
- WRONG or GULLIBLE: the semantic failure remains the final outcome.

Abstention and known/common-knowledge control rows cannot earn positive memory
completion from ordinary retrieved passages. Positive context does not prove absence,
and known facts do not isolate memory from model knowledge. A future typed
negative-evidence receipt could make absence attributable; an empty or unrelated
retrieval cannot.

Reports keep answer accuracy (`correct / n`) separate from memory completion
(`completed / n`). T1 can have reader accuracy but, by construction, has zero memory
completion. This lets a review distinguish reader knowledge, retrieval gaps, missing
attribution, ordinary mistakes, and credulity.

## Model held fixed

One weak model (Llama-3.2-1B) reads every system's served context, held constant
across systems and tiers, so completion differences come from the memory layer, not
the model. On common-knowledge segments the model completes with or without memory,
so those are tagged known and expose UNTRACED credit-grabbing; only novel, private
segments can be completed by memory alone.

## Structural claims stay model-free

Set-integrity, reactivity, cycle rejection, expiry, and concurrency are graded by
deterministic code over the real cells, with sha256-recomputable proofs, never
through the model, so store correctness and model behavior never contaminate each
other's numbers.
