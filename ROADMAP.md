# AMBIENT roadmap

## Where it is now

Everything in the "Build queue" and P1/P2 phases below is now built: the adapter
contract runs as code (adapters/http-client.mjs + adapters/recall_adapter.mjs), the
four-tier runner (tiers/runner.mjs) drives T1 to T4 with a build-once/query-many
store split, the reference auto-memory harness (adapters/harness-automemory.mjs)
covers lever-less systems, and the write firewall classifies relations at write time
against a live model instead of regex markers. The small corpus (92 segments, 15
abilities) is assembled and the ceiling test (tiers/quality-graph.mjs) confirmed the
memory graph carries full signal for a 32B reader's residual gaps. See README.md
Status for the current numbers; this file keeps the original phase plan below as a
record of the order things were built in and what is still open (medium/large
corpus, a fast ingest-time classifier, a second non-Recall adapter).

The deterministic, model-free AMBIENT core runs green in this folder against a
vendored build of Recall, the first system tested (vendor/recall, commit 4c1e232),
Node 24, no keys, no network: L1 100/100, L3 100/100, L2 literal 0 vs entailment 100,
L4 naive 75/50 vs expiry-aware 100/100. The core currently runs on Recall's own
primitives, so these numbers are Recall demonstrating the capabilities, not yet a
neutral cross-system field until a second adapter exists (see Risks to hold).

## Dependency strategy

Vendor Recall's compiled dist into vendor/recall/dist and pin the commit in
vendor/recall/VERSION. Do not npm-link or submodule: Recall ships no runtime deps and
its npm files list omits the probes, so the package alone cannot supply them. Refresh with a script and re-run the goldens whenever the pinned build
changes, or the numbers drift silently.

## Immediate steps (get the suite fully green here)

1. Done: vendored dist at vendor/recall, symlinked suites/dist so the ../dist and
   ../../dist imports resolve.
2. Done: smoke-tested suites/ambient/ambient-bench.mjs (the deterministic core),
   green.
3. Repoint the three hardcoded absolute imports at the vendored build:
   suites/ambient/probes/federation.mjs (lines 19 to 20) and
   concurrency.mjs (line 37) import from an absolute Recall-Personal path. Add
   suites/ambient/_recall.mjs re-exporting from ../dist/src/index.js and point them
   at it.
4. Run the full 18-area profile (npm run bench:suite) and the contradiction gate,
   confirm green.
5. Fix recall-self-run portability: replace the hardcoded Desktop run path and the
   absolute imports with repo-relative corpora and the _recall re-export; relocate
   ingest fixtures under recall-self-run/corpora.
6. Optional model arms: start a local llama-server on port 8089 serving
   Llama-3.2-1B, run bench:suite:1b, bench:1b-hard, and the reader-independence
   python arm.
7. Commit passing outputs into results/ as goldens with the exact model, quant, and
   llama build recorded.

## Fairness phases (the path to a real cross-system benchmark)

The order is fixed by the honesty bar; each phase is a precondition for the next.

P0. Honesty relabel. Stop calling the single-system run cross-system. Its only
target is Recall. Now in recall-self-run/, labeled Recall-only, until a second
adapter exists. Carry its structural-versus-model split into the shared attribution
vocabulary. (Done.)

P1. Define the adapter contract. docs/ADAPTER_CONTRACT.md and adapters/contract.mjs:
query-with-provenance mandatory, write/surface/setAutoCapture optional. A system can
say it has no push axis rather than crash. (Contract drafted; wiring next.)

P2. Two real adapters. adapters/recall.mjs (wrap the existing store behind the
contract) and adapters/baseline-pull.mjs (a plain vector or RAG incumbent).
Re-express the model-facing probes to read adapter.query output, holding the same
fixed model for every system, and score by segment completion.

P3. Capability grading across systems. Grade each adapter per rung (pull-correctness,
supersession, contradiction-surfacing, unprompted-push) and report a profile, never
one number. A pull system that cannot surface unprompted is ABSENT on that rung, not
FAIL, and its lower rungs still score.

P4. Independent verifiability. Every result ships with its served context, the model
transcript, and a recompute script. Use the merkle and set-integrity probes as the
template. Bind epoch roots to an external anchor so timing claims are not
self-minted.

P5. Leaderboard, last. Only after P1 to P4 are green for at least two independently
run systems, publish the profile. Each cell links to its trace, its recompute
artifact, and its attribution grade.

## Reconciling capability grading with fair-adapters-first

They are not rivals, they are ordered phases of one requirement. The capability
grading is how you score a system once it is on a fair adapter, not a shortcut
around building one. You cannot place a pull incumbent on the ladder honestly until
it speaks the shared contract and segment completion separates NOT-SERVED (a memory
gap) from a model ceiling. Build the levers of fairness first (P1, P2); the
generalization to lever-less incumbents (P3) is what those levers produce.

## Risks to hold

- Vendored dist goes stale: pin the commit and re-run goldens on refresh, or a
  regression can read as an improvement.
- Model non-determinism: llama.cpp varies by build, quant, and hardware even at
  temperature 0. Goldens must record all three.
- Not cross-system yet: publishing recall-self-run as cross-system before a second
  adapter exists would itself break the honesty bar.
- Push-axis unfairness: if ABSENT is graded as FAIL, the board becomes a rigged demo.
- Attribution mislabel: if served context is not captured with external-origin
  provenance, a correct answer cannot be told from model knowledge and credit is
  guesswork.
- Portability rot: three absolute paths plus the old Desktop run dir mean a naive
  copy runs here and breaks elsewhere. Fix before sharing.

## Build queue (design requirements captured)

- Adapter contract wiring (P1) and two adapters (P2): adapters/recall.mjs (Recall, the
  first system tested) and a lever-less adapters/baseline-pull.mjs.
- Reference auto-memory harness (adapters/harness-automemory.mjs): the fallback so a
  bare model runs the auto tiers; a system's native auto-memory defaults when present.
- Sized corpora (corpora/): small, medium, and large corpus and question sets, each
  with known-or-novel tags and a per-question gold answer plus supporting store item.
- Reader backends (model/): a local llama-server and an online OpenAI-compatible API by
  key, the model held constant, the key never committed.
- Four-tier runner (tiers/): drives an adapter across T1 to T4, scores by segment
  completion, reports per-capability lift and the interaction.
- Express the deterministic capabilities (L1 to L4, the 18-area profile) through the
  adapter contract, so they measure any system, not Recall's primitives.
- Prompt-injection resistance (AMBIENT-authored, adversarial): seed the ingest stream
  with injection attempts (flagged instruction-like content). Score the ability:
  following an injected instruction is GULLIBLE, flagging or refusing it is CORRECT.
  Also test the TREND behaviorally: the system's resistance to an actor should escalate
  as that actor's injection attempts recur, and relax ONLY with elapsed time (not via
  overwrite, reset, or any other action). Concrete checks: resistance rises with attempt
  count; a benign reset does NOT lower it; only a clean time gap relaxes it. How it does
  this does not matter, only that it does (Rule 6). One implementation is Recall's
  warning-edge (accumulate-on-trend, decay-only-with-time).
