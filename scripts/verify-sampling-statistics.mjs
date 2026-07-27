#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { aggregateAttributedVerdicts } from "../tiers/attribution.mjs";
import { selectStratifiedSegments } from "../tiers/sampling.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const corpus = readFileSync("corpora/out/beam/small/segments.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

for (const [limit, expectedMin, expectedMax] of [
  [10, 1, 1],
  [12, 1, 2],
  [100, 10, 10],
  [200, 20, 20],
  [400, 40, 40],
]) {
  const first = selectStratifiedSegments(corpus, { limit, seed: "sampling-regression-v1" });
  const repeat = selectStratifiedSegments(corpus, { limit, seed: "sampling-regression-v1" });
  assert(first.metadata.selectedSegments === limit, `${limit}: selected count drift`);
  assert(first.metadata.selectedAbilities === 10, `${limit}: ability coverage drift`);
  assert(first.metadata.minPerAbility === expectedMin, `${limit}: minimum ability count drift`);
  assert(first.metadata.maxPerAbility === expectedMax, `${limit}: maximum ability count drift`);
  assert(first.metadata.selectionSha256 === repeat.metadata.selectionSha256, `${limit}: same-seed selection is not deterministic`);
}

const seedA = selectStratifiedSegments(corpus, { limit: 100, seed: "seed-a" });
const seedB = selectStratifiedSegments(corpus, { limit: 100, seed: "seed-b" });
assert(seedA.metadata.selectionSha256 !== seedB.metadata.selectionSha256, "different seeds produced the same 100-item selection");

const verdicts = [];
for (let segment = 0; segment < 40; segment += 1) {
  for (let replicate = 0; replicate < 3; replicate += 1) {
    for (const tier of ["T1", "T2", "T3", "T4"]) {
      const completed = tier !== "T1" && (segment + replicate) % 3 !== 0;
      verdicts.push({
        segId: `segment-${segment}`,
        replicate,
        tier,
        ability: `ability-${segment % 10}`,
        semanticVerdict: completed ? "correct" : "wrong",
        outcome: completed ? "completed" : "wrong",
      });
    }
  }
}
const summary = aggregateAttributedVerdicts(verdicts);
assert(summary.uncertainty.method === "paired-segment-cluster-bootstrap-v2", "bootstrap method drift");
assert(summary.uncertainty.clusterUnit === "segment", "bootstrap cluster unit drift");
assert(summary.uncertainty.clusters === 40, "repeats were incorrectly counted as independent clusters");
assert(summary.uncertainty.repeatsPerSegment.min === 3 && summary.uncertainty.repeatsPerSegment.max === 3, "repeat accounting drift");
assert(Array.isArray(summary.uncertainty.intervals95.T4), "paired lift interval missing");
assert(Array.isArray(summary.uncertainty.completionIntervals95.T3), "native completion interval missing");

console.log("stratified sampling and segment-cluster uncertainty gates passed");
