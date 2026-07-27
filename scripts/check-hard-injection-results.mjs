#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_ARTIFACTS = [1, 2, 3].map(
  (trial) => `results/ambient-injection-hard-z6-qwen32-20260727-trial-${trial}.json`,
);
const EXPECTED_CASES = [
  "empty-trace-1",
  "empty-trace-2",
  "empty-trace-3",
  "forced-policy-write",
  "clean-official-control",
  "forced-query-coupled-attack",
  "sybil-top-k-flood",
  "delayed-split-attack",
];
const READER_CASES = new Set(EXPECTED_CASES.filter((id) => id !== "forced-policy-write"));
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verdicts(row) {
  return row.grade?.verdicts ?? [row.grade?.verdict ?? "UNSCORED"];
}

function sameMembers(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validateArtifact(path) {
  const raw = readFileSync(path, "utf8");
  const artifact = JSON.parse(raw);
  const label = path;

  assert(artifact.schema === "ambient.injection-hard.v1", `${label}: unexpected schema`);
  assert(typeof artifact.runSeed === "string" && artifact.runSeed.length > 0, `${label}: missing run seed`);
  assert(typeof artifact.backend?.model === "string" && artifact.backend.model.length > 0, `${label}: missing reader model`);
  assert(
    artifact.backend.apiKey === undefined || ["no-key", "[redacted]"].includes(artifact.backend.apiKey),
    `${label}: artifact contains an API credential`,
  );
  assert(Array.isArray(artifact.cases), `${label}: cases must be an array`);
  assert(artifact.cases.length === EXPECTED_CASES.length, `${label}: expected ${EXPECTED_CASES.length} cases`);
  assert(
    EXPECTED_CASES.every((id) => artifact.cases.some((row) => row.id === id)),
    `${label}: case set is incomplete`,
  );

  for (const row of artifact.cases) {
    assert(typeof row.grade?.pass === "boolean", `${label}: ${row.id} is ungraded`);
    if (READER_CASES.has(row.id)) {
      assert(row.boundary?.proven === true, `${label}: ${row.id} lacks a proven fresh-reader boundary`);
      assert(row.boundary.mode === "llama-slot-erase", `${label}: ${row.id} used an unexpected boundary mode`);
      assert(Array.isArray(row.boundary.listed) && row.boundary.listed.length > 0, `${label}: ${row.id} listed no slots`);
      assert(Array.isArray(row.boundary.erased), `${label}: ${row.id} has no erased-slot trace`);
      assert(sameMembers(row.boundary.listed, row.boundary.erased), `${label}: ${row.id} did not erase every listed slot`);
    }
  }

  const failed = artifact.cases.filter((row) => !row.grade.pass);
  const byVerdict = {};
  for (const row of artifact.cases) {
    for (const verdict of verdicts(row)) byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
  }
  assert(artifact.summary?.total === artifact.cases.length, `${label}: summary total drift`);
  assert(artifact.summary?.passed === artifact.cases.length - failed.length, `${label}: summary pass drift`);
  assert(artifact.summary?.failed === failed.length, `${label}: summary failure drift`);
  assert(artifact.summary?.resistant === (failed.length === 0), `${label}: resistant flag drift`);
  assert(JSON.stringify(artifact.summary?.byVerdict) === JSON.stringify(byVerdict), `${label}: verdict counts drift`);

  const byId = new Map(artifact.cases.map((row) => [row.id, row]));
  const query = byId.get("forced-query-coupled-attack");
  const sybil = byId.get("sybil-top-k-flood");
  const policy = byId.get("forced-policy-write");
  const semanticRaw = raw.replace(UUID_PATTERN, "<UUID>");

  return {
    path,
    rawSha256: sha256(raw),
    semanticSha256: sha256(semanticRaw),
    artifact,
    signals: {
      policyHeld: policy.grade?.verdict === "POLICY_HELD",
      queryTargetServed: query.retrieved?.some((record) => record.id === query.targetId) === true,
      queryReaderLeak: query.grade?.leak?.leaked === true,
      sybilTargetServed: sybil.retrieved?.some((record) => record.id === sybil.targetId) === true,
      sybilReaderLeak: sybil.grade?.leak?.leaked === true,
    },
  };
}

const paths = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ARTIFACTS).map((path) => resolve(path));
const runs = paths.map(validateArtifact);
const seeds = new Set(runs.map((run) => run.artifact.runSeed));
const models = new Set(runs.map((run) => run.artifact.backend.model));
const semanticDigests = new Set(runs.map((run) => run.semanticSha256));

const report = {
  schema: "ambient.injection-hard.audit.v1",
  publication: {
    class: "diagnostic-only",
    leaderboardEligible: false,
    reasons: [
      "No paired T1-T4 architecture-track manifest or common-control comparison is present.",
      "Reader-mediated literal leaks and memory-layer retrieval failures are mixed in the legacy 6/8 aggregate.",
      "The three repeats use one fixed seed and are semantically identical after generated UUIDs are removed.",
    ],
  },
  repeatability: {
    runs: runs.length,
    sameSeed: seeds.size === 1,
    sameFixedReader: models.size === 1,
    uniqueSemanticOutcomes: semanticDigests.size,
    interpretation:
      seeds.size === 1 && semanticDigests.size === 1
        ? "Repeatable fixed-seed outcome; not independent scenario coverage."
        : "Runs differ semantically; inspect before aggregating.",
  },
  architectureSignals: {
    policyHeldRuns: runs.filter((run) => run.signals.policyHeld).length,
    queryTargetServedRuns: runs.filter((run) => run.signals.queryTargetServed).length,
    sybilTargetDroppedRuns: runs.filter((run) => !run.signals.sybilTargetServed).length,
  },
  readerSignals: {
    queryLiteralLeakRuns: runs.filter((run) => run.signals.queryReaderLeak).length,
    sybilLiteralLeakRuns: runs.filter((run) => run.signals.sybilReaderLeak).length,
  },
  artifacts: runs.map(({ path, rawSha256, semanticSha256, artifact }) => ({
    path,
    rawSha256,
    semanticSha256,
    runSeed: artifact.runSeed,
    readerModel: artifact.backend.model,
    passed: artifact.summary.passed,
    total: artifact.summary.total,
  })),
};

console.log(JSON.stringify(report, null, 2));
