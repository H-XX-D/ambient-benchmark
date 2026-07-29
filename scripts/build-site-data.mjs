#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUBMISSIONS_ROOT = join(ROOT, "submissions");
const TIERS = ["T1", "T2", "T3", "T4"];
const ARTIFACT_KEYS = ["runManifest", "transcript", "judgeManifest", "verdicts", "summary"];
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && entry.name === "submission.json" ? [path] : [];
  });
}

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${relative(ROOT, path)}:${index + 1}: ${error.message}`); }
  });
}

function artifactPath(bundleDir, declaredPath, label) {
  assert(typeof declaredPath === "string" && declaredPath.length > 0, `${label}: artifact path is missing`);
  assert(!isAbsolute(declaredPath), `${label}: artifact path must be relative`);
  const candidate = resolve(bundleDir, declaredPath);
  const bundlePrefix = `${resolve(bundleDir)}${sep}`;
  assert(candidate.startsWith(bundlePrefix), `${label}: artifact path escapes its bundle`);
  assert(existsSync(candidate) && statSync(candidate).isFile(), `${label}: artifact does not exist`);
  assert(realpathSync(candidate).startsWith(`${realpathSync(bundleDir)}${sep}`), `${label}: artifact symlink escapes its bundle`);
  return candidate;
}

function scoreFromSummary(summary, tier) {
  const cell = summary?.byTier?.[tier];
  assert(Number.isInteger(cell?.n) && cell.n > 0, `summary: missing ${tier} item count`);
  assert(Number.isFinite(cell.completed), `summary: missing ${tier} completed count`);
  return cell.completed / cell.n;
}

function validateSubmission(submissionPath) {
  const label = relative(ROOT, submissionPath);
  const bundleDir = dirname(submissionPath);
  const value = JSON.parse(readFileSync(submissionPath, "utf8"));
  assert(value?.schema === "ambient.submission.v1", `${label}: unexpected schema`);
  assert(/^[a-z0-9][a-z0-9._-]{2,79}$/.test(value.id ?? ""), `${label}: invalid id`);
  assert(["architecture", "native-system"].includes(value.track), `${label}: invalid track`);
  assert(typeof value.system?.name === "string" && value.system.name.length > 0 && value.system.name.length <= 100, `${label}: invalid system name`);
  assert(typeof value.system?.version === "string" && value.system.version.length > 0 && value.system.version.length <= 100, `${label}: invalid system version`);
  assert(typeof value.corpus === "string" && value.corpus.length > 0 && value.corpus.length <= 100, `${label}: invalid corpus`);
  assert(Number.isFinite(Date.parse(value.submittedAt)), `${label}: invalid submittedAt`);
  assert(/^[0-9a-f]{40}$/.test(value.sourceCommit ?? ""), `${label}: invalid sourceCommit`);
  assert(typeof value.submittedBy === "string" && value.submittedBy.length > 0 && value.submittedBy.length <= 100, `${label}: invalid submittedBy`);
  assert(value.publicationGate === "passed", `${label}: publication gate did not pass`);

  const artifactFiles = {};
  for (const key of ARTIFACT_KEYS) {
    artifactFiles[key] = artifactPath(bundleDir, value.artifacts?.[key], `${label}:${key}`);
    const digest = sha256(readFileSync(artifactFiles[key]));
    assert(value.artifactSha256?.[key] === digest, `${label}:${key}: SHA-256 mismatch`);
  }

  const manifest = JSON.parse(readFileSync(artifactFiles.runManifest, "utf8"));
  const judgeManifest = JSON.parse(readFileSync(artifactFiles.judgeManifest, "utf8"));
  const summary = JSON.parse(readFileSync(artifactFiles.summary, "utf8"));
  const transcript = jsonl(artifactFiles.transcript);
  const verdicts = jsonl(artifactFiles.verdicts);

  assert(manifest.schema === "ambient.run-manifest.v1", `${label}: invalid run manifest schema`);
  assert(manifest.claimTrack === value.track, `${label}: run manifest track differs from submission`);
  assert(judgeManifest.schema === "ambient.judge-manifest.v1", `${label}: invalid judge manifest schema`);
  assert(judgeManifest.judgeErrors === 0 && judgeManifest.validForPublication === true, `${label}: judge manifest is not publishable`);
  assert(judgeManifest.rows === transcript.length, `${label}: judge row count differs from transcript`);
  assert(judgeManifest.transcriptSha256 === value.artifactSha256.transcript, `${label}: judge transcript hash differs from submission`);
  assert(verdicts.length === transcript.length, `${label}: verdict row count differs from transcript`);
  assert(!verdicts.some((row) => row.verdict === "judge-error" || row.error), `${label}: verdicts contain judge errors`);
  assert(!/mock/i.test(judgeManifest.judge?.model ?? ""), `${label}: mock judge output cannot be ranked`);
  assert(!transcript.some((row) => /mock/i.test(row.sourceTrace?.answer?.model ?? "")), `${label}: mock reader output cannot be ranked`);
  assert(transcript.every((row) => row.runId === manifest.runId), `${label}: transcript runId differs from manifest`);
  assert(transcript.every((row) => row.sourceTrace?.answer?.fingerprint === manifest.models?.reader?.fingerprint), `${label}: reader fingerprint drift`);

  const paired = new Map();
  const replicates = new Map();
  const abilityBySegment = new Map();
  for (const row of transcript) {
    assert(TIERS.includes(row.tier), `${label}: invalid transcript tier ${row.tier}`);
    assert(row.tier === "T1" ? row.storeCall === false : row.storeCall === true, `${label}: ${row.segId}/${row.tier} store-call invariant failed`);
    const key = `${row.segId}:${row.replicate ?? 0}`;
    const set = paired.get(key) ?? new Set();
    assert(!set.has(row.tier), `${label}: duplicate paired cell ${key}/${row.tier}`);
    set.add(row.tier);
    paired.set(key, set);
    const perSegment = replicates.get(row.segId) ?? new Set();
    perSegment.add(row.replicate ?? 0);
    replicates.set(row.segId, perSegment);
    if (abilityBySegment.has(row.segId)) {
      assert(abilityBySegment.get(row.segId) === row.ability, `${label}: ${row.segId} ability drift`);
    } else {
      assert(typeof row.ability === "string" && row.ability, `${label}: ${row.segId} missing ability`);
      abilityBySegment.set(row.segId, row.ability);
    }
  }
  for (const [key, tiers] of paired) assert(TIERS.every((tier) => tiers.has(tier)), `${label}: incomplete paired cell ${key}`);
  const uniqueSegments = replicates.size;
  const repeats = manifest.design?.repeats;
  assert(Number.isInteger(repeats) && repeats >= 1, `${label}: manifest repeat count is invalid`);
  assert(paired.size === uniqueSegments * repeats, `${label}: paired cell count differs from unique segments × repeats`);
  assert(uniqueSegments === value.result?.items, `${label}: result items must count unique question segments`);

  const uncertainty = summary.uncertainty;
  assert(uncertainty?.method === "paired-segment-cluster-bootstrap-v2", `${label}: uncertainty must use segment-cluster bootstrap v2`);
  assert(uncertainty.clusterUnit === "segment", `${label}: uncertainty cluster unit must be segment`);
  assert(uncertainty.clusters === uniqueSegments, `${label}: uncertainty cluster count differs from unique segments`);
  const interval = value.track === "architecture"
    ? uncertainty.intervals95?.T4
    : uncertainty.completionIntervals95?.T3;
  assert(Array.isArray(interval) && interval.length === 2 && interval.every(Number.isFinite), `${label}: missing result 95% interval`);

  const baseline = scoreFromSummary(summary, "T1");
  const treatment = scoreFromSummary(summary, value.track === "architecture" ? "T4" : "T3");
  const expectedMetric = value.track === "architecture" ? "architecture-lift" : "native-completion";
  const expectedScore = value.track === "architecture" ? treatment - baseline : treatment;
  assert(value.result?.metric === expectedMetric, `${label}: result metric must be ${expectedMetric}`);
  for (const key of ["score", "lower95", "upper95"]) assert(Number.isFinite(value.result?.[key]), `${label}: result ${key} is invalid`);
  const minimum = value.track === "architecture" ? -1 : 0;
  for (const key of ["score", "lower95", "upper95"]) assert(value.result[key] >= minimum && value.result[key] <= 1, `${label}: result ${key} is outside its valid range`);
  assert(value.result.lower95 <= value.result.score && value.result.score <= value.result.upper95, `${label}: score lies outside its interval`);
  assert(Math.abs(value.result.score - expectedScore) < 1e-9, `${label}: score differs from the attributed summary`);
  assert(Math.abs(value.result.lower95 - interval[0] / 100) < 1e-9, `${label}: lower95 differs from attributed summary`);
  assert(Math.abs(value.result.upper95 - interval[1] / 100) < 1e-9, `${label}: upper95 differs from attributed summary`);
  if (value.track === "architecture") {
    assert(Math.abs(value.result.baseline - baseline) < 1e-9, `${label}: T1 baseline differs from summary`);
    assert(Math.abs(value.result.treatment - treatment) < 1e-9, `${label}: T4 treatment differs from summary`);
    assert(manifest.design?.tierOrder === "balanced", `${label}: architecture track requires balanced tier order`);
    assert(Number.isInteger(manifest.design?.repeats) && manifest.design.repeats >= 3, `${label}: architecture track requires at least three repeats`);
    assert(manifest.adapter?.declaration?.components?.queryGenerativeModel === null, `${label}: architecture adapter query model must be null`);
    assert(manifest.adapter?.declaration?.components?.ingestGenerativeModel === null, `${label}: architecture adapter ingest model must be null`);
    const sampling = manifest.design?.sampling;
    assert(sampling?.method === "seeded-stratified-round-robin-v1", `${label}: architecture track requires seeded stratified sampling`);
    assert(sampling.selectedSegments === uniqueSegments, `${label}: sampling segment count differs from transcript`);
    const abilityCounts = {};
    for (const ability of abilityBySegment.values()) abilityCounts[ability] = (abilityCounts[ability] ?? 0) + 1;
    assert(sampling.selectedAbilities === Object.keys(abilityCounts).length, `${label}: sampling ability count differs from transcript`);
    assert(sampling.selectedAbilities === sampling.availableAbilities, `${label}: architecture track must cover every corpus ability`);
    assert(Math.min(...Object.values(abilityCounts)) >= 30, `${label}: architecture track requires at least 30 unique questions per ability`);
    assert(JSON.stringify(stable(sampling.selectedByAbility)) === JSON.stringify(stable(abilityCounts)), `${label}: sampling ability distribution differs from transcript`);
    for (const [segId, seen] of replicates) assert(seen.size === manifest.design.repeats, `${label}: ${segId} repeat count differs from manifest`);
  }

  const control = {
    reader: manifest.models?.reader,
    judge: judgeManifest.judge,
    classifier: manifest.models?.classifier,
    prompts: manifest.prompts,
    corpus: manifest.corpus,
    design: manifest.design,
  };
  const controlKey = sha256(JSON.stringify(stable(control))).slice(0, 12);
  return {
    id: value.id,
    track: value.track,
    system: value.system,
    corpus: value.corpus,
    submittedAt: value.submittedAt,
    submittedBy: value.submittedBy,
    sourceCommit: value.sourceCommit,
    result: value.result,
    controlKey,
    bundlePath: relative(ROOT, bundleDir).split(sep).join("/"),
    artifactSha256: value.artifactSha256,
  };
}

const clean = readJson("results/clean-verification.json");
const smoke = readJson("results/cross-adapter-grade-pipeline-summary.json");
const entries = walk(SUBMISSIONS_ROOT).sort().map(validateSubmission);
const ids = new Set();
for (const entry of entries) {
  assert(!ids.has(entry.id), `duplicate submission id: ${entry.id}`);
  ids.add(entry.id);
}
entries.sort((a, b) => a.track.localeCompare(b.track) || a.corpus.localeCompare(b.corpus) || a.controlKey.localeCompare(b.controlKey) || b.result.score - a.result.score || a.submittedAt.localeCompare(b.submittedAt));

let commit = null;
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
catch { /* Vercel source archives may omit .git. */ }
const status = {
  schema: "ambient.site-status.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: commit,
  release: {
    code: clean.status === "passed" ? "verified-pre-release" : "verification-failed",
    label: clean.status === "passed"
      ? `Verified pre-release · ${entries.length} validated submission${entries.length === 1 ? "" : "s"}`
      : "Verification currently failing",
  },
  verification: {
    status: clean.status,
    generatedAt: clean.generatedAt,
    steps: clean.totals?.completed ?? 0,
    copy: clean.status === "passed"
      ? `${clean.totals?.completed ?? 0} deterministic and local checks passed in the latest recorded clean run.`
      : "The latest recorded clean run did not pass; inspect the repository artifact before relying on results.",
  },
  adapterSmoke: {
    kind: "mock-reader-mock-judge-pipeline-smoke",
    generatedAt: smoke.generatedAt,
    adapters: smoke.totals?.passed ?? 0,
    publishableAsQualityResult: false,
  },
  publicEvidence: {
    publishableComparisons: entries.length,
    copy: entries.length > 0
      ? `${entries.length} community submission${entries.length === 1 ? " has" : "s have"} passed the static evidence publication gate.`
      : "No comparative score is published. Passing mock output remains pipeline evidence only, never a ranking.",
  },
};

for (const [path, value] of [["site/data/status.json", status]]) {
  const out = join(ROOT, path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`built ${path} from repository evidence`);
}
