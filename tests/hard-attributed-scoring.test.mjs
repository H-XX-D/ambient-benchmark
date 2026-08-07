import test from "node:test";
import assert from "node:assert/strict";
import { generateHardScenario, gradeHardAnswer } from "../corpora/hard-behavior-core.mjs";
import { aggregateAttributedVerdicts, attributedVerdict } from "../tiers/attribution.mjs";

function verdictRow(item, tier, answer, served = []) {
  const grade = gradeHardAnswer(answer, item.oracle);
  const row = {
    segId: item.id,
    replicate: 0,
    ability: item.ability,
    tag: item.tag,
    tier,
    storeCall: tier !== "T1",
    servedCount: served.length,
    servedContext: served,
    servedProvenance: served.map((_, index) => ({ id: `m${index}`, origin: "external" })),
  };
  return {
    ...row,
    verdict: grade.verdict,
    ...attributedVerdict(row, { verdict: grade.verdict, reason: grade.reason || "mechanical match" }),
  };
}

test("mechanical hard verdicts only earn memory completion with a served external trace", () => {
  const item = generateHardScenario("knowledge-update", "attribution", "small");
  const t1 = verdictRow(item, "T1", item.oracle.expected);
  const t4 = verdictRow(item, "T4", item.oracle.expected, ["support"]);
  const unserved = verdictRow(item, "T3", item.oracle.expected);
  assert.equal(t1.outcome, "untraced");
  assert.equal(t4.outcome, "completed");
  assert.equal(unserved.outcome, "not-served");
});

test("hard attributed aggregation preserves paired T1 to T4 lift", () => {
  const items = [
    generateHardScenario("knowledge-update", "pair-a", "small"),
    generateHardScenario("temporal-reasoning", "pair-b", "small"),
  ];
  const rows = items.flatMap((item) => [
    verdictRow(item, "T1", "wrong"),
    verdictRow(item, "T2", "wrong", ["support"]),
    verdictRow(item, "T3", item.oracle.expected, ["support"]),
    verdictRow(item, "T4", item.oracle.expected, ["support"]),
  ]);
  const summary = aggregateAttributedVerdicts(rows);
  assert.equal(summary.completion.T1, 0);
  assert.equal(summary.completion.T4, 100);
  assert.equal(summary.deltas.T4, 100);
  assert.equal(summary.uncertainty.clusters, 2);
});
