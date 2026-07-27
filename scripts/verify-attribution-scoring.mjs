#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { scoreSegment } from "../adapters/contract.mjs";
import {
  aggregateAttributedVerdicts,
  attributedVerdict,
  attributionEvidence,
  attributionOutcome,
} from "../tiers/attribution.mjs";

const noCall = { storeCall: false, servedCount: 0, servedContext: [], servedProvenance: [] };
const emptyCall = { storeCall: true, servedCount: 0, servedContext: [], servedProvenance: [] };
const external = {
  storeCall: true,
  servedCount: 1,
  servedContext: ["private launch code: ORBIT-73"],
  servedProvenance: [{ id: "m1", origin: "external" }],
};
const omittedProvenance = {
  storeCall: true,
  servedCount: 1,
  servedContext: ["private launch code: ORBIT-73"],
  servedProvenance: [],
};
const modelOnly = {
  storeCall: true,
  servedCount: 1,
  servedContext: ["Paris is the capital of France"],
  servedProvenance: [{ id: "shadow", origin: "model" }],
};

assert.equal(attributionOutcome(noCall, "correct"), "untraced");
assert.equal(attributionOutcome(emptyCall, "correct"), "not-served");
assert.equal(attributionOutcome(external, "correct"), "completed");
assert.equal(attributionOutcome(omittedProvenance, "correct"), "completed");
assert.equal(attributionOutcome(modelOnly, "correct"), "untraced");
assert.equal(attributionOutcome({ ...external, tag: "abstention" }, "correct"), "untraced");
assert.equal(attributionOutcome({ ...external, tag: "known" }, "correct"), "untraced");
assert.equal(attributionOutcome(external, "wrong"), "wrong");
assert.equal(attributionOutcome(external, "gullible"), "gullible");
assert.equal(attributionEvidence(emptyCall).hasMemoryDbSupport, false);
assert.equal(attributionEvidence(external).hasMemoryDbSupport, true);

assert.equal(scoreSegment({ correct: true, storeCall: false, served: { support: ["x"] } }), "UNTRACED");
assert.equal(scoreSegment({ correct: true, storeCall: true, served: { support: [] } }), "UNTRACED");
assert.equal(scoreSegment({ correct: true, storeCall: true, served: { support: ["x"] } }), "COMPLETED");
assert.equal(
  scoreSegment({ correct: true, storeCall: true, served: { support: ["x"], provenance: [{ origin: "model" }] } }),
  "UNTRACED",
);

const fixtures = [
  { ...noCall, tier: "T1", ability: "fixture" },
  { ...emptyCall, tier: "T2", ability: "fixture" },
  { ...external, tier: "T3", ability: "fixture" },
  { ...modelOnly, tier: "T4", ability: "fixture" },
];
const verdicts = fixtures.map((row) => ({
  ...row,
  ...attributedVerdict(row, { verdict: "correct", reason: "fixture" }),
}));
const summary = aggregateAttributedVerdicts(verdicts);
assert.equal(summary.schema, "ambient.attributed-summary.v1");
assert.deepEqual(summary.answerAccuracy, { T1: 100, T2: 100, T3: 100, T4: 100 });
assert.deepEqual(summary.completion, { T1: 0, T2: 0, T3: 100, T4: 0 });
assert.equal(summary.byTier.T1.untraced, 1);
assert.equal(summary.byTier.T2.notServed, 1);
assert.equal(summary.byTier.T3.completed, 1);
assert.equal(summary.byTier.T4.untraced, 1);

console.log("attribution scoring verified: semantic accuracy is separate from deterministic memory completion");
