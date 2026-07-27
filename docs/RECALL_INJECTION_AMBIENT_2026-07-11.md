# AMBIENT recovery and Recall injection packet

Date: 2026-07-11  
Workspace: `/Users/hendrixx./SENTINEL memory system  Benchmark `  
Repository branch: `master` tracking `origin/master`  
Status: implemented and locally verified; changes are not committed

## Purpose

This document is the durable recovery body for the AMBIENT/SENTINEL benchmark work
performed across the July 10–11, 2026 Codex task. If conversational context or Recall
state is lost, read this file before continuing. Store compact Recall cells that point
back to this document instead of copying the entire body into flat memory.

The central outcome is that AMBIENT now distinguishes semantic answer quality from
attributable memory performance, routes structural scenarios through the adapter
boundary, supports medium/large corpora, and protects L4 against drift in the
benchmark's own definition of expiry.

## Project identity

AMBIENT means Agentic Memory: Baseline-Isolated Evaluation, Normalized Tiers. It was
formerly named SENTINEL. The benchmark is substrate-neutral: Recall is the first
system tested, not the benchmark definition.

The attribution axis is a four-tier 2x2 ablation:

| Tier | Auto capture | Curated store | Meaning |
|---|---:|---:|---|
| T1 | off | off | reader baseline |
| T2 | on | off | automatic capture alone |
| T3 | on | on | full stack |
| T4 | off | on | curated memory alone |

The capability axis contains deterministic L1–L4 tests, an 18-area structural
profile, absorbed BEAM/LongMemEval corpora, and a 92-segment/15-ability authored
corpus.

## Decision 1: semantic judging and memory attribution are separate

Before this work, `tiers/judge.mjs` judged answer versus gold and counted every
semantic `correct` as completion. It copied `storeCall` into verdict rows but never
used that evidence. Consequently:

- correct T1 answers could count as memory completion;
- correct answers after an empty store response could count as memory completion;
- a mock or real judge could award attribution even though attribution is a
  deterministic harness fact.

The repair is implemented in `tiers/attribution.mjs`.

The model judge still emits one semantic verdict:

- `correct`
- `wrong`
- `gullible`

A deterministic attribution gate then emits one final outcome:

- `completed`: semantically correct, credit-eligible, with a watched store call and
  non-empty externally served context;
- `untraced`: semantically correct but no store call, only model/unknown support, or
  a control row that cannot isolate memory;
- `not-served`: semantically correct, a store call occurred, but it returned no
  context;
- `wrong`;
- `gullible`.

Reports now preserve both:

- `answerAccuracy = semantic correct / n`
- `completion = attributed completed / n`

T1 may have answer accuracy but has zero memory completion by construction.

Abstention and known/common-knowledge controls cannot earn positive memory completion
from ordinary retrieved passages. Positive context does not prove absence, and known
facts do not isolate the store from model knowledge. A future typed negative-evidence
receipt could make absence attributable; an empty or unrelated retrieval cannot.

Grade artifacts were advanced from `ambient.cross-adapter-grades.v1` to
`ambient.cross-adapter-grades.v2`.

## Decision 2: per-item provenance is optional, exact served context is mandatory

The specification previously contradicted itself: Rule 1 said per-item provenance
was optional, while `adapters/contract.mjs` said it was required for completion.

The reconciled rule is:

- the harness must observe the adapter query boundary;
- the exact context returned and shown to the reader must be stored;
- non-empty context crossing that watched boundary is external by default;
- an adapter's explicit `origin: "model"` is preserved and never earns memory credit;
- per-item IDs, sources, timestamps, and scores are optional but recommended
  diagnostic metadata.

Every transcript row now carries:

- `servedContext`
- `servedProvenance`
- `sourceTrace.schema = "ambient.source_trace.v1"`
- a reader/model API trace
- memory-query traces
- `hasStoreCall`
- `hasMemoryDbSupport`

Artifact validators recompute attribution evidence from the transcript rather than
trusting declared summary numbers.

## Decision 3: L4's expiry definition is itself versioned benchmark state

The user identified a meta-level staleness problem: rerunning the same L4 script makes
an implementation reproducible, but does not prove that the harness's definition of
"expired" still means what it meant six months earlier.

AMBIENT now defines immutable `l4-expiry.v1` semantics:

- clock: UTC;
- expired predicate: `expiresAt <= evaluationTime`;
- named month scope is inclusive through the final millisecond of that month;
- an explicit year wins; otherwise use the UTC year of `createdAt`;
- Q1 and Q2 are inclusive through the final millisecond of March and June;
- text without recognized temporal scope is timeless.

Canonical parsed definition SHA-256:

`aa7659becfa2e9cf7a71e24a578a13d0aa722b50398bec98d977139a9c647784`

Nine frozen witnesses cover:

- equality at the expiry boundary;
- one millisecond before and after;
- leap-year February 2024;
- implicit and explicit years;
- quarter boundaries;
- inclusive `through December` language;
- timeless facts.

Files:

- `suites/ambient/fixtures/l4-expiry-v1.json`
- `suites/ambient/l4-expiry-policy.mjs`
- `scripts/verify-l4-expiry-policy.mjs`
- `docs/L4_EXPIRY_POLICY.md`
- `results/l4-expiry-policy-witness.json`

`npm run bench` verifies the policy hash and witnesses before executing L4. Mutating
v1 now fails even if the capability probe still happens to report 100/100. A
legitimate rule change creates v2 and an explicit migration note; it must not rewrite
v1.

Current L4 result remains:

- naive age: 75% recall / 50% precision;
- expiry-aware: 100% recall / 100% precision;
- definition-drift guard: PASS.

## Adapter and structural work

The local/free default comparison matrix remains ten adapters, but its brittle
dependency on `/tmp/ambient-agent-recall` was removed. The default matrix now uses
the self-contained `mcp-memory-sqlite-personal` adapter. `agent-recall-python` moved
to the optional matrix.

The agent-recall bridge smoke remains deterministic through an explicitly labeled
fixture under `fixtures/agent-recall/`. That fixture is never treated as a benchmark
entrant; it only tests the bridge's write/query/reset wiring.

Two local/free matrix artifacts are verified:

1. Wiring matrix: 10 adapters × 8 rows = 80 transcript rows.
2. Structural matrix: 10 adapters × 60 rows = 600 transcript rows, representing one
   scenario from each of the 15 authored structural abilities across four tiers.

The structural matrix is a routing and transcript-evidence milestone, not a real
comparative grade because it uses a mock reader/checker.

## Corpora and scale-up workflows

The following corpus inputs are materialized locally under `corpora/out/`:

| Source | Size | Segments |
|---|---|---:|
| BEAM | small | 400 |
| BEAM | medium | 700 |
| BEAM | large | 700 |
| LongMemEval | small | 500 |
| LongMemEval | medium | 500 |
| LongMemEval | large | 500 |
| Authored areas | small | 92 |

The reconstructed corpus tree is approximately 3 GB and is not part of the tracked
source diff.

Added commands:

```text
npm run corpus:beam:medium
npm run corpus:longmemeval:medium
npm run corpus:beam:large
npm run corpus:longmemeval:large
npm run bench:paid:medium
npm run bench:paid:large
```

The paid workflows are prepared but were not run. At verification time neither
`OPENAI_API_KEY` nor `AMBIENT_JUDGE_KEY` was present. Do not present mock-judge output
as a comparative capability result.

## Verification evidence

Final local/free verification:

- `results/clean-verification.json`
- schema: `ambient.clean-verification.v1`
- 116 commands completed;
- 87 JavaScript syntax checks;
- 29 npm verification/benchmark commands;
- duration: 25.223 seconds;
- result: PASS.

Additional verified artifacts:

- `results/cross-adapter-matrix.json`
  - schema `ambient.cross-adapter-matrix.v1`
  - 10 adapters, 8 rows each, PASS.
- `results/cross-adapter-structural-matrix.json`
  - schema `ambient.cross-adapter-matrix.v1`
  - 10 adapters, 60 rows each, PASS.
- `results/cross-adapter-grade-pipeline-summary.json`
  - schema `ambient.cross-adapter-grades.v2`
  - 10 passed, 0 failed, 0 judge errors;
  - uses a mock judge and proves plumbing/artifact integrity only.
- `results/l4-expiry-policy-witness.json`
  - schema `ambient.l4-expiry-policy-witness.v1`
  - verified true.

The deterministic 18-area profile also remains green at 958 cases:

- SELF-VERIFIED: 9
- INDEPENDENTLY-VERIFIED: 3
- RESIDUAL(@EXTERNALLY-ANCHORED): 1
- RESIDUAL(@SELF-VERIFIED): 5

## Important honesty boundaries

- The historical `recall-self-run` report has 988 cases; the current suite runs 958.
  The historical folder is prior art and must not be presented as the current profile.
- The ten-adapter wiring and structural matrices use mock model infrastructure. They
  prove routing, isolation, trace shape, and artifact recomputation—not comparative
  memory quality.
- `results/cross-adapter-grade-pipeline-summary.json` uses a mock judge.
- A publishable comparison still requires a fixed real reader, a separate real judge,
  model/build/version metadata, served-context goldens, and cost authorization.
- Recall's deterministic L1–L4 core still exercises Recall primitives directly. The
  structural authored scenarios now cross adapters, but that is not equivalent to
  porting every deterministic primitive probe to every substrate.

## Remaining work

1. Configure a fast ingest-time classifier separate from the fixed reader.
2. Run medium real-reader/real-judge grading once credentials and spending authority
   are explicitly available.
3. Review medium results before launching the large stress run.
4. Publish only after transcript goldens and model/runtime metadata are frozen.
5. Optionally externally anchor published policy hashes so expiry-definition history
   is independently timestamped rather than protected only by repository history.
6. Consider a typed negative-evidence receipt if abstention is to earn attributable
   memory completion.

## Primary implementation files

Core attribution and tracing:

- `tiers/attribution.mjs`
- `tiers/judge.mjs`
- `tiers/runner.mjs`
- `adapters/contract.mjs`
- `scripts/verify-attribution-scoring.mjs`
- `scripts/check-cross-adapter-grades.mjs`
- `scripts/check-cross-adapter-matrix.mjs`

L4 longitudinal policy:

- `suites/ambient/l4-expiry-policy.mjs`
- `suites/ambient/fixtures/l4-expiry-v1.json`
- `scripts/verify-l4-expiry-policy.mjs`
- `docs/L4_EXPIRY_POLICY.md`

Matrix and workflow changes:

- `scripts/verify-cross-adapter-matrix.mjs`
- `scripts/verify-cross-adapter-grade-pipeline.mjs`
- `scripts/judge-cross-adapter-matrix.mjs`
- `scripts/verify-agent-recall-adapter-bridge.mjs`
- `fixtures/agent-recall/agent_recall/store.py`
- `package.json`

Specification updates:

- `README.md`
- `RULES.md`
- `docs/ATTRIBUTION.md`
- `docs/ADAPTER_CONTRACT.md`
- `docs/10_AMBIENT_SUITE.md`
- `ROADMAP.md`
- `tiers/README.md`

## Recovery commands

Run these from the workspace root:

```bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
npm run verify:attribution
npm run verify:l4-policy
npm run verify:clean
npm run verify:clean:artifact
npm run verify:adapters:matrix:artifact
npm run verify:adapters:structural:artifact
```

To regenerate local/free cross-adapter outputs:

```bash
npm run verify:adapters:matrix
npm run verify:adapters:structural
node --disable-warning=ExperimentalWarning scripts/verify-cross-adapter-grade-pipeline.mjs \
  --skip-matrix \
  --matrix results/cross-adapter-matrix.json \
  --out results/cross-adapter-grade-pipeline-summary.json
```

## Recall state and suggested injection records

Recall was active for substantial parts of the task. These durable cells were already
admitted:

- `ref_022b` / `022b9a05-4e57-49c1-aefc-7b632d56e478` — canonical reference to
  this recovery packet.
- `ver_3b81` / `3b8144ec-230d-467f-a23c-8d3c79a6b8a3` — attribution gate verified.
- `dec_3dcd` / `3dcd5738-ea7f-4f60-b8fe-dc0da4110aef` — L4 policy versioning decision.
- `rsk_f438` / `f438cd1b-c810-4ccd-ba4a-ea5b372222cf` — original attribution-scoring
  risk discovered during audit; this risk is now resolved by `ver_3b81`.

Canonical Recall reference now admitted:

- kind: `ref`
- title: `AMBIENT July 2026 recovery and injection packet`
- body: point to this file and summarize that it is the canonical detailed recovery
  body for attribution v2, cross-adapter matrices, medium/large corpora, and
  `l4-expiry.v1`.
- source reference: this absolute file path.

Do not inject this entire document as many duplicated flat observations. Admit compact
decision, verification, risk, and task cells and use this file as the addressable body.
