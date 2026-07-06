#!/usr/bin/env node
// AMBIENT contradiction corpus (area 5: unprompted contradiction detection).
//
// A parameterized benchmark for the admission-time detector in
// src/core/contradiction-detect.ts. Reports recall (in-scope positives),
// precision, and false-positive rate over a generated case set, and exits
// non-zero if the tier thresholds are not met (CI gate).
//
// Tiers:
//   lite : 1 subject per axis + core negatives (fast smoke / regression guard)
//   full : every axis x every subject + every negative family (headline number)
//   hard : the false-positive duals only (double-negative, temporal, cross-subject,
//          paraphrase, same-sign), the precision stressors
//
// Usage: node scripts/sentinel-contradiction-corpus.mjs [--tier lite|full|hard]

import { detectAndLinkUnpromptedContradictions as detect } from "../dist/src/core/contradiction-detect.js";

function fires(existingTitle, incomingTitle) {
  const store = {
    listNodes: () => [{ id: "C1", title: existingTitle, status: "active", tags: { topics: [] }, kind: "observation" }]
  };
  const proposal = { intent: { operation: "create" }, content: { title: incomingTitle }, evidence: { contradicts: [] } };
  detect(proposal, store, []);
  return proposal.evidence.contradicts.length > 0;
}

// [a, b, inScope], inScope=false means intentionally outside the detector's
// designed coverage (so a non-fire is correct, not a miss).
const PAIRS = [
  ["up", "down", true], ["present", "absent", true], ["enabled", "disabled", true],
  ["valid", "invalid", true], ["online", "offline", true], ["healthy", "unhealthy", true],
  ["active", "inactive", true], ["passing", "failing", true], ["pass", "fail", true],
  ["secure", "vulnerable", true], ["allowed", "blocked", true], ["true", "false", true],
  ["present", "missing", true], ["healthy", "broken", true], ["succeeded", "failed", true],
  ["success", "failure", true],
  ["open", "closed", false] // ambiguous everyday pair, deliberately excluded
];
const MULTI = ["Service Alpha", "The primary database", "The build pipeline", "Cluster east", "The payment gateway"];
const SHORT = ["Node7", "Network", "Sales"]; // single core token: stresses the ratio threshold

function buildCases(tier) {
  const cases = [];
  const subjects = tier === "lite" ? MULTI.slice(0, 1) : MULTI;
  const shorts = tier === "lite" ? SHORT.slice(0, 1) : SHORT;
  const negSubjects = tier === "lite" ? MULTI.slice(0, 1) : MULTI;

  if (tier !== "hard") {
    for (const [a, b, inScope] of PAIRS) {
      for (const s of subjects) {
        cases.push({ cat: "pos-multi", a: `${s} is ${a} right now`, b: `${s} is ${b} right now`, expect: inScope });
      }
      for (const s of shorts) {
        cases.push({ cat: "pos-short", pair: `${a}/${b}`, a: `${s} is ${a}`, b: `${s} is ${b}`, expect: inScope });
      }
    }
  }
  for (const s of negSubjects) {
    cases.push({ cat: "neg-doubleneg", a: `${s} is up right now`, b: `${s} is not down right now`, expect: false });
    cases.push({ cat: "neg-temporal", a: `${s} was valid in 2024`, b: `${s} was invalid in 2026`, expect: false });
    cases.push({ cat: "neg-samesign", a: `${s} is healthy right now`, b: `${s} is healthy and stable right now`, expect: false });
    cases.push({ cat: "neg-crosssubject", a: `Service Beta is down right now`, b: `${s} is up right now`, expect: false });
    cases.push({ cat: "neg-unrelated", a: `${s} is up right now`, b: `The weather is sunny today here`, expect: false });
    cases.push({ cat: "neg-paraphrase", a: `Deploy is scheduled for Friday this week`, b: `We will not finish before next week ever`, expect: false });
  }
  return cases;
}

const tier = (() => {
  const i = process.argv.indexOf("--tier");
  return i >= 0 ? process.argv[i + 1] : "full";
})();
const THRESH = {
  lite: { recall: 1.0, precision: 1.0, fpr: 0.0 },
  full: { recall: 0.95, precision: 0.98, fpr: 0.02 },
  hard: { recall: 1.0, precision: 1.0, fpr: 0.0 } // hard is negatives-only: precision/fpr are what matter
};

const cases = buildCases(tier);
let tp = 0, fp = 0, fn = 0, tn = 0;
const byCat = {};
for (const c of cases) {
  const f = fires(c.a, c.b);
  const cat = (byCat[c.cat] ||= { fire: 0, n: 0, bad: [] });
  cat.n++;
  if (f) cat.fire++;
  if (c.expect && f) tp++;
  else if (c.expect && !f) { fn++; cat.bad.push("miss:" + (c.pair || c.b).slice(0, 26)); }
  else if (!c.expect && f) { fp++; cat.bad.push("FP:" + c.b.slice(0, 26)); }
  else tn++;
}
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);

console.log(`\n==================== AMBIENT contradiction corpus, tier=${tier} ====================\n`);
console.log(`cases: ${cases.length}   in-scope positives: ${tp + fn}   negatives/excluded: ${fp + tn}`);
console.log(`recall ${(recall * 100).toFixed(1)}%   precision ${(precision * 100).toFixed(1)}%   false-positive rate ${(fpr * 100).toFixed(1)}%\n`);
for (const [k, v] of Object.entries(byCat)) {
  const flag = v.bad.length ? `   ${[...new Set(v.bad)].slice(0, 6).join(", ")}` : "";
  console.log(`  ${k.padEnd(18)} ${v.fire}/${v.n}${flag}`);
}
const t = THRESH[tier] ?? THRESH.full;
const ok = recall >= t.recall - 1e-9 && precision >= t.precision - 1e-9 && fpr <= t.fpr + 1e-9;
console.log(`\n${ok ? "PASS" : "FAIL"} (tier ${tier}: recall>=${t.recall}, precision>=${t.precision}, fpr<=${t.fpr})\n`);
process.exit(ok ? 0 : 1);
