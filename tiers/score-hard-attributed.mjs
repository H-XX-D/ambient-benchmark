#!/usr/bin/env node
// Deterministic AMBIENT hard-corpus scoring. The generated world carries an
// exact oracle, so using an LLM judge would add cost and disagreement without
// adding information. Output remains compatible with the attributed grade
// artifact contract used by the hosted runner.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { gradeHardAnswer } from "../corpora/hard-behavior-core.mjs";
import { aggregateAttributedVerdicts, attributedVerdict } from "./attribution.mjs";

const TRANSCRIPT = process.argv[2];
if (!TRANSCRIPT) {
  console.error("usage: node tiers/score-hard-attributed.mjs <transcript-hard-*.jsonl>");
  process.exit(1);
}

const transcriptBytes = readFileSync(TRANSCRIPT);
const rows = transcriptBytes.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const verdicts = rows.map((row) => {
  const grade = gradeHardAnswer(row.answer, row.oracle);
  const reason = grade.reason || (grade.semanticEquivalence
    ? `mechanical oracle match: ${grade.semanticEquivalence}`
    : "exact mechanical oracle match");
  const attributed = attributedVerdict(row, { verdict: grade.verdict, reason });
  return {
    runId: row.runId ?? null,
    replicate: row.replicate ?? 0,
    segId: row.segId,
    tier: row.tier,
    ability: row.ability,
    tag: row.tag,
    storeCall: row.storeCall,
    servedCount: row.servedCount,
    verdict: attributed.semanticVerdict,
    ...attributed,
    oracle: {
      schema: row.oracle.schema,
      kind: row.oracle.kind,
      actual: grade.actual,
      expected: grade.expected,
      protectedHits: grade.protectedHits || [],
      semanticEquivalence: grade.semanticEquivalence || null,
    },
  };
});

const summary = aggregateAttributedVerdicts(verdicts);
const verdictPath = TRANSCRIPT.replace(/transcript-/, "verdicts-");
const summaryPath = verdictPath.replace(/\.jsonl$/, "-summary.json");
const manifestPath = TRANSCRIPT.replace(/transcript-/, "judge-manifest-").replace(/\.jsonl$/, ".json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const runIds = [...new Set(rows.map((row) => row.runId).filter(Boolean))];
const scorer = {
  endpoint: "local://ambient-mechanical-oracle",
  model: "ambient-mechanical-oracle-v2",
  temperature: 0,
  maxTokens: 0,
  rubricSha256: sha256("ambient.mechanical-answer.v1|exact|protected-token|unordered-conflict-set"),
};
scorer.fingerprint = sha256(JSON.stringify(scorer));

writeFileSync(verdictPath, verdicts.map((row) => JSON.stringify(row)).join("\n") + "\n");
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
writeFileSync(manifestPath, JSON.stringify({
  schema: "ambient.judge-manifest.v1",
  generatedAt: new Date().toISOString(),
  transcript: TRANSCRIPT,
  transcriptSha256: sha256(transcriptBytes),
  runIds,
  rows: rows.length,
  judge: scorer,
  scorerType: "deterministic-mechanical-oracle",
  judgeErrors: 0,
  validForPublication: runIds.length === 1,
}, null, 2) + "\n");

console.log(`mechanically scored ${rows.length} rows`);
console.log(`wrote ${basename(verdictPath)} + ${basename(summaryPath)} + ${basename(manifestPath)}`);
