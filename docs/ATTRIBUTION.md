# Attribution: segment completion

AMBIENT scores in segments. A segment is one task: a question with a known correct
answer whose supporting context was placed in the memory, not in the model. A
system is judged on how many segments it completes.

## A segment is completed when both hold

1. The answer is correct.
2. The information came from a store call the harness observed (query, information
   back, response), not from the model's weights. The harness traces the call; the
   system does not self-cite and need not return per-item sources.

Both are required. A correct answer the system cannot trace to an external source
does not complete the segment, because the memory has not been shown to do
anything: the model may have known it. A trace with a wrong answer does not complete
it either. Only correct-and-externally-traced counts.

## Why "outside the model" is the decisive test

The failure AMBIENT refuses to make is crediting the memory for what the model already
knew. The guard is structural: the harness routes every query through itself, so it
watches whether a store call returned the information the answer used, rather than the
model answering from its weights. This is the entry requirement (Rule 1) and the
shadow-memory control (Rule 5) fused into one criterion. It is why a system that
exposes no store call is ineligible: with no call to watch, "outside the model" is
unprovable and no segment can be honestly credited.

## The verdicts

After the harness confirms whether the support was traced outside the model, every
answer is one of three:

1. CORRECT: right answer, support traced outside the model. The only verdict that
   scores for the memory (a completed segment).
2. WRONG: an incorrect answer to a question the record can answer.
3. GULLIBLE: the system was easily fooled by misleading or contradictory input. When a
   claim contradicts an established, unchangeable fact, a non-gullible system pushes
   back or asks for clarification; a gullible one just accepts it. Answering an
   unanswerable question instead of abstaining is the milder form. A heavier failure
   than WRONG: credulity, not a miss. The contradiction-resolution and abstention
   segments draw it out.

Two orthogonal flags refine these for diagnostics:

- UNTRACED: a CORRECT answer the system cannot trace outside the model. The model
  knew it, so it is not credited to the memory (shadow or model knowledge), reported
  separately so a system cannot bank the model's competence as its own.
- NOT-SERVED: the needed context never appeared, so a WRONG here is a memory gap, not
  a model failure.

Only CORRECT-and-traced advances the score. WRONG, GULLIBLE, and UNTRACED are kept
distinct so a review sees whether a system is mistaken, credulous, or leaning on the
model.

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
