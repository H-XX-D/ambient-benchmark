// Deterministic attribution gate for AMBIENT.
//
// The model judge decides semantic correctness only. Memory credit is a separate,
// model-free decision over the harness-authored trace. Keeping those two decisions
// separate prevents a correct answer from being credited to memory merely because a
// query happened.

export const SEMANTIC_VERDICTS = new Set(["correct", "wrong", "gullible"]);
export const ATTRIBUTION_OUTCOMES = new Set([
  "completed",
  "untraced",
  "not-served",
  "wrong",
  "gullible",
]);

function servedCountOf(row) {
  if (Array.isArray(row?.servedContext)) return row.servedContext.length;
  return Number.isInteger(row?.servedCount) ? row.servedCount : 0;
}

export function attributionEvidence(row) {
  const storeCall = row?.storeCall === true;
  const servedCount = servedCountOf(row);
  const provenance = Array.isArray(row?.servedProvenance) ? row.servedProvenance : [];
  const externalSupportCount = provenance.filter((item) => item?.origin === "external").length;
  const modelSupportCount = provenance.filter((item) => item?.origin === "model").length;

  // An observable adapter round trip makes per-item provenance optional. When an
  // adapter omits provenance entirely, non-empty context returned through that watched
  // call is still external. If provenance is present, at least one item must explicitly
  // be external; an all-model or all-unknown response is not credited.
  const provenanceOmitted = provenance.length === 0;
  const tag = String(row?.tag ?? "").toLowerCase();
  const creditEligible = !["abstention", "known", "common-knowledge"].includes(tag);
  const hasMemoryDbSupport = Boolean(
    storeCall && servedCount > 0 && (externalSupportCount > 0 || provenanceOmitted),
  );

  return {
    storeCall,
    servedCount,
    externalSupportCount,
    modelSupportCount,
    provenanceOmitted,
    creditEligible,
    hasMemoryDbSupport,
  };
}

export function attributionOutcome(row, semanticVerdict) {
  if (!SEMANTIC_VERDICTS.has(semanticVerdict)) {
    throw new Error(`invalid semantic verdict: ${semanticVerdict}`);
  }
  if (semanticVerdict === "wrong" || semanticVerdict === "gullible") {
    return semanticVerdict;
  }

  const evidence = attributionEvidence(row);
  if (!evidence.storeCall) return "untraced";
  if (evidence.servedCount === 0) return "not-served";
  // Positive context cannot prove that an unanswered question was absent, and known
  // controls are intentionally never credited to memory. A future adapter may expose
  // a typed negative-evidence receipt; ordinary retrieved passages are not one.
  if (!evidence.creditEligible) return "untraced";
  return evidence.hasMemoryDbSupport ? "completed" : "untraced";
}

export function attributedVerdict(row, judged) {
  const semanticVerdict = judged?.verdict;
  const evidence = attributionEvidence(row);
  return {
    semanticVerdict,
    outcome: attributionOutcome(row, semanticVerdict),
    reason: String(judged?.reason ?? ""),
    evidence,
  };
}

function emptyBucket() {
  return {
    n: 0,
    correct: 0,
    wrong: 0,
    gullible: 0,
    completed: 0,
    untraced: 0,
    notServed: 0,
  };
}

function add(bucket, row) {
  bucket.n += 1;
  bucket[row.semanticVerdict] += 1;
  if (row.outcome === "completed") bucket.completed += 1;
  else if (row.outcome === "untraced") bucket.untraced += 1;
  else if (row.outcome === "not-served") bucket.notServed += 1;
}

function pct(value, n) {
  return n ? Math.round((1000 * value) / n) / 10 : 0;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

function pairedBootstrap(verdicts, iterations = 2000) {
  const segments = new Map();
  for (const row of verdicts) {
    const replicates = segments.get(row.segId) ?? new Map();
    const replicate = row.replicate ?? 0;
    const group = replicates.get(replicate) ?? {};
    group[row.tier] = row.outcome === "completed" ? 1 : 0;
    replicates.set(replicate, group);
    segments.set(row.segId, replicates);
  }
  const complete = [];
  const replicateCounts = [];
  for (const replicates of segments.values()) {
    const cells = [...replicates.values()].filter((group) => ["T1", "T2", "T3", "T4"].every((tier) => tier in group));
    if (cells.length !== replicates.size || cells.length === 0) continue;
    replicateCounts.push(cells.length);
    complete.push(Object.fromEntries(
      ["T1", "T2", "T3", "T4"].map((tier) => [
        tier,
        cells.reduce((sum, group) => sum + group[tier], 0) / cells.length,
      ]),
    ));
  }
  if (complete.length < 2) {
    return {
      method: "paired-segment-cluster-bootstrap-v2",
      clusterUnit: "segment",
      clusters: complete.length,
      repeatsPerSegment: null,
      iterations: 0,
      intervals95: null,
      completionIntervals95: null,
    };
  }
  const random = mulberry32(0x414d4249);
  const samples = { T2: [], T4: [], T3: [], interaction: [] };
  const completionSamples = { T1: [], T2: [], T3: [], T4: [] };
  for (let b = 0; b < iterations; b += 1) {
    const sum = { T1: 0, T2: 0, T3: 0, T4: 0 };
    for (let i = 0; i < complete.length; i += 1) {
      const group = complete[Math.floor(random() * complete.length)];
      for (const tier of Object.keys(sum)) sum[tier] += group[tier];
    }
    const delta = {
      T2: 100 * (sum.T2 - sum.T1) / complete.length,
      T4: 100 * (sum.T4 - sum.T1) / complete.length,
      T3: 100 * (sum.T3 - sum.T1) / complete.length,
    };
    delta.interaction = delta.T3 - delta.T2 - delta.T4;
    for (const key of Object.keys(samples)) samples[key].push(delta[key]);
    for (const tier of Object.keys(completionSamples)) {
      completionSamples[tier].push(100 * sum[tier] / complete.length);
    }
  }
  const intervals95 = {};
  for (const [key, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    intervals95[key] = [Math.round(percentile(values, 0.025) * 10) / 10, Math.round(percentile(values, 0.975) * 10) / 10];
  }
  const completionIntervals95 = {};
  for (const [key, values] of Object.entries(completionSamples)) {
    values.sort((a, b) => a - b);
    completionIntervals95[key] = [Math.round(percentile(values, 0.025) * 10) / 10, Math.round(percentile(values, 0.975) * 10) / 10];
  }
  return {
    method: "paired-segment-cluster-bootstrap-v2",
    clusterUnit: "segment",
    clusters: complete.length,
    repeatsPerSegment: {
      min: Math.min(...replicateCounts),
      max: Math.max(...replicateCounts),
    },
    iterations,
    intervals95,
    completionIntervals95,
  };
}

export function aggregateAttributedVerdicts(verdicts, tiers = ["T1", "T2", "T3", "T4"]) {
  const byTier = {};
  const byAbility = {};
  for (const row of verdicts) {
    if (!SEMANTIC_VERDICTS.has(row.semanticVerdict)) {
      throw new Error(`invalid semantic verdict in aggregate: ${row.semanticVerdict}`);
    }
    if (!ATTRIBUTION_OUTCOMES.has(row.outcome)) {
      throw new Error(`invalid attribution outcome in aggregate: ${row.outcome}`);
    }
    const tier = (byTier[row.tier] ??= emptyBucket());
    add(tier, row);
    const ability = (byAbility[row.ability] ??= {});
    const abilityTier = (ability[row.tier] ??= emptyBucket());
    add(abilityTier, row);
  }

  const answerAccuracy = Object.fromEntries(
    tiers.map((tier) => [tier, pct(byTier[tier]?.correct ?? 0, byTier[tier]?.n ?? 0)]),
  );
  const completion = Object.fromEntries(
    tiers.map((tier) => [tier, pct(byTier[tier]?.completed ?? 0, byTier[tier]?.n ?? 0)]),
  );
  const relativeToT1 = (metric, tier) => metric[tier] - metric.T1;
  const deltas = {
    T2: relativeToT1(completion, "T2"),
    T4: relativeToT1(completion, "T4"),
    T3: relativeToT1(completion, "T3"),
  };
  deltas.interaction = deltas.T3 - (deltas.T2 + deltas.T4);
  const accuracyDeltas = {
    T2: relativeToT1(answerAccuracy, "T2"),
    T4: relativeToT1(answerAccuracy, "T4"),
    T3: relativeToT1(answerAccuracy, "T3"),
  };
  accuracyDeltas.interaction = accuracyDeltas.T3 - (accuracyDeltas.T2 + accuracyDeltas.T4);

  return {
    schema: "ambient.attributed-summary.v1",
    byTier,
    byAbility,
    answerAccuracy,
    completion,
    deltas,
    accuracyDeltas,
    uncertainty: pairedBootstrap(verdicts),
  };
}
