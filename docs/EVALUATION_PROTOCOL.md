# AMBIENT evaluation protocol

## The claim is about memory architecture

AMBIENT's controlled track estimates the effect of changing a memory architecture while holding the model-facing parts of the experiment fixed. It does not estimate which complete AI product is best, and it does not treat a passing adapter smoke test as a quality result.

The unit of comparison is a paired question instance. For item `i` and tier `t`, let `Yᵢ(t)` be the deterministic memory-completion outcome after the semantic judge and the trace-based attribution gate. The main effects are:

```text
Δauto   = mean(Y(T2) - Y(T1))
Δcustom = mean(Y(T4) - Y(T1))
Δboth   = mean(Y(T3) - Y(T1))
I       = Δboth - Δauto - Δcustom
```

The interaction `I` asks whether reference capture and the custom store compose better or worse than their separate gains. Results ship with a paired segment-cluster bootstrap 95% interval. Replicates remain inside their segment cluster rather than being counted as new independent questions. The interval describes sampling uncertainty in this corpus; it does not prove generalization to all agent tasks.

## The two tracks

### Controlled architecture track

A run may make an architecture-effect claim only when all of the following are identical across compared adapters:

- corpus bytes and selected items;
- reader provider, endpoint class, model/version, temperature, prompt, and token limit;
- shared capture and ingest-classifier model/version and prompt;
- representation/embedding model and reranker, or an explicit `null` declaration;
- context and per-item budgets;
- tier-order policy, seed, and repeat count;
- judge model/version, rubric, and decoding configuration.

Adapter-side generative calls during ingest or query are not allowed in this track. Every adapter supplies an `ambient.adapter-declaration.v1` document. `scripts/verify-model-isolation.mjs` compares the resulting manifests and fails closed on drift.

Run at least three replicates with counterbalanced tier order:

```bash
node tiers/runner.mjs \
  --track architecture \
  --repeats 3 \
  --tier-order balanced \
  --seed ambient-paper-v1 \
  --adapter-declaration adapters/declarations/<adapter>.json \
  --adapter-url http://127.0.0.1:8091 \
  --source longmemeval --size medium --limit 0
```

The generated `results/manifest-*.json` pins the corpus, models, prompts, budgets, runtime, repository commit, dirty state, and exact CLI arguments. A dirty run is useful for development but should not be published as a canonical result.

Architecture publication also requires seeded stratified sampling across every corpus ability with at least 30 unique questions per ability. Repeats estimate reader variability; they do not increase the unique-question count. The public `items` field therefore means unique segments, not tier rows or repeated cells.

### Native system track

Native capture, proprietary embeddings, rerankers, and query-time models are allowed. This answers a different question: how useful is the complete system as configured? Report it as end-to-end system performance, with every component disclosed. Never use this track to claim that a storage or graph architecture caused the difference.

## What each tier actually controls

| Tier | Reference capture | Custom substrate store | Interpretation |
|---|---:|---:|---|
| T1 | off | off | Instructed no-context control. It is not unrestricted "raw model knowledge." |
| T2 | on | off | Shared reference capture contribution. |
| T3 | on | on | Combined contribution and interaction. |
| T4 | off | on | Custom substrate path contribution. |

T1 receives the same reader instruction as every other cell and no served memory. It is deliberately an attribution control. Calling it unrestricted raw model capability would be inaccurate.

## Evidence classes

Keep these artifacts visually and numerically separate:

1. **Deterministic component checks** prove specific mechanics and regressions.
2. **Adapter wire smokes** prove that a runner can call an adapter and receive a valid transcript.
3. **Mock-reader or mock-judge pipeline tests** prove orchestration only.
4. **Controlled judged runs** support comparative architecture estimates after the integrity gate passes.
5. **Native judged runs** support end-to-end system comparisons only.

Only class 4 belongs in an architecture leaderboard. A judge error invalidates the affected run; converting it to `wrong` may preserve row shape for diagnostics but cannot produce a publishable score.

## Reasoning audit

**Claim:** an observed score lift was caused by the memory architecture.

**Reasoning map:** fixed questions + fixed reader + fixed semantic components + randomized/counterbalanced paired tiers + traced external support → architecture treatment is the remaining planned difference → paired lift estimates its effect in the tested corpus.

**Failed tests in the earlier protocol:**

- **Hidden-confounder test:** fixing only the reader left adapter-side embeddings, rerankers, or generative calls free to vary. That supports a system comparison, not an architecture-only causal claim.
- **Style-over-substance / Goodhart guard:** a successful mock pipeline or polished dashboard does not increase evidence for quality. Mock output is now labeled non-publishable.
- **Moving-goalpost guard:** without a frozen manifest, corpus, prompts, and model settings could drift between runs. The run manifest and isolation gate freeze the decision rule.
- **Hasty-generalization guard:** a point estimate without repeat or item-level uncertainty does not justify broad claims. Architecture runs now require repeated paired cells and report bootstrap intervals.
- **Pseudoreplication guard:** repeated answers to the same question are correlated measurements, not new corpus coverage. Bootstrap resampling therefore uses the segment as the cluster and keeps its repeats together.

**Minimal repair:** split the tracks, require component declarations, hash the controlled inputs, counterbalance tier order, preserve trace-based attribution, and refuse publication when the judge or integrity gate fails.

**Residual uncertainty:** the authored ability mix may not represent every production workload; model APIs can still change behind an unchanged alias; and declarations are auditable claims, not remote attestation. Canonical runs should therefore pin dated model versions where providers expose them, publish raw transcripts, and invite independent reproduction.

## Publication gate

A comparative result is publishable only when:

- all four cells exist exactly once for every `(segment, replicate)`;
- the run and judge manifests are present and hash-consistent;
- the architecture isolation gate passes across every compared adapter;
- no row has a reader, adapter, or judge error;
- source traces and served context are present;
- the score is labeled with its track, corpus, sample size, repeats, interval, and date;
- mock and deterministic evidence remain outside the comparative table.
