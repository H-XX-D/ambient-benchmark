#!/usr/bin/env node
// Validate a cross-adapter grade artifact plus its verdict/summary files.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const STATUSES = new Set(["passed", "judge-error", "failed", "skipped"]);
const MATRIX_STATUSES = new Set(["passed", "failed", "skipped"]);
const VERDICTS = new Set(["correct", "wrong", "gullible"]);
const TIERS = ["T1", "T2", "T3", "T4"];

function argValue(name, fallback) {
  const ix = args.indexOf(name);
  if (ix === -1) return fallback;
  if (ix + 1 >= args.length) throw new Error(`missing value for ${name}`);
  return args[ix + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function absolute(path) {
  return isAbsolute(path) ? path : join(ROOT, path);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertArrayEqual(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(actual.length === expected.length, `${label} length ${actual.length} !== ${expected.length}`);
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${label}[${i}] mismatch:\n  actual:   ${actual[i]}\n  expected: ${expected[i]}`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${path}:${index + 1} is not valid JSON: ${e.message}`);
      }
    });
}

function pct(correct, n) {
  if (!n) return 0;
  return Math.round((correct / n) * 1000) / 10;
}

function validateTotals(artifact) {
  const totals = {
    adapters: artifact.adapters.length,
    passed: artifact.adapters.filter((entry) => entry.status === "passed").length,
    judgeError: artifact.adapters.filter((entry) => entry.status === "judge-error").length,
    failed: artifact.adapters.filter((entry) => entry.status === "failed").length,
    skipped: artifact.adapters.filter((entry) => entry.status === "skipped").length,
    judgeErrors: artifact.adapters.reduce((sum, entry) => sum + (entry.judgeErrors ?? 0), 0),
  };
  for (const [key, value] of Object.entries(totals)) {
    assert(artifact.totals?.[key] === value, `totals.${key} ${artifact.totals?.[key]} !== ${value}`);
  }
}

async function validateJudgedEntry(entry) {
  assert(typeof entry.transcript === "string" && entry.transcript, `${entry.id} missing transcript`);
  assert(typeof entry.verdicts === "string" && entry.verdicts, `${entry.id} missing verdicts path`);
  assert(typeof entry.summary === "string" && entry.summary, `${entry.id} missing summary path`);

  const transcriptPath = absolute(entry.transcript);
  const verdictPath = absolute(entry.verdicts);
  const summaryPath = absolute(entry.summary);
  assert(existsSync(transcriptPath), `${entry.id} transcript does not exist: ${entry.transcript}`);
  assert(existsSync(verdictPath), `${entry.id} verdicts do not exist: ${entry.verdicts}`);
  assert(existsSync(summaryPath), `${entry.id} summary does not exist: ${entry.summary}`);

  const transcriptRows = await readJsonl(transcriptPath);
  const verdictRows = await readJsonl(verdictPath);
  const summary = await readJson(summaryPath);

  assert(Number.isInteger(entry.rows) && entry.rows > 0, `${entry.id} rows must be a positive integer`);
  assert(transcriptRows.length === entry.rows, `${entry.id} transcript rows ${transcriptRows.length} !== ${entry.rows}`);
  assert(verdictRows.length === entry.rows, `${entry.id} verdict rows ${verdictRows.length} !== ${entry.rows}`);

  for (let i = 0; i < verdictRows.length; i += 1) {
    const transcriptRow = transcriptRows[i];
    const verdictRow = verdictRows[i];
    assert(verdictRow.segId === transcriptRow.segId, `${entry.id} row ${i} segId mismatch`);
    assert(verdictRow.tier === transcriptRow.tier, `${entry.id} row ${i} tier mismatch`);
    assert(VERDICTS.has(verdictRow.verdict), `${entry.id} row ${i} invalid verdict ${verdictRow.verdict}`);
    assert(typeof verdictRow.reason === "string", `${entry.id} row ${i} missing reason`);
  }

  const judgeErrors = verdictRows.filter((row) =>
    String(row.reason ?? "").startsWith("judge error:"),
  ).length;
  assert(entry.judgeErrors === judgeErrors, `${entry.id} judgeErrors ${entry.judgeErrors} !== ${judgeErrors}`);
  assert(entry.status === (judgeErrors ? "judge-error" : "passed"), `${entry.id} status inconsistent with judgeErrors`);

  for (const tier of TIERS) {
    const tierRows = verdictRows.filter((row) => row.tier === tier);
    assert(summary.byTier?.[tier]?.n === tierRows.length, `${entry.id} summary ${tier}.n mismatch`);
    const correct = tierRows.filter((row) => row.verdict === "correct").length;
    const wrong = tierRows.filter((row) => row.verdict === "wrong").length;
    const gullible = tierRows.filter((row) => row.verdict === "gullible").length;
    assert(summary.byTier[tier].correct === correct, `${entry.id} summary ${tier}.correct mismatch`);
    assert(summary.byTier[tier].wrong === wrong, `${entry.id} summary ${tier}.wrong mismatch`);
    assert(summary.byTier[tier].gullible === gullible, `${entry.id} summary ${tier}.gullible mismatch`);
    assert(summary.completion?.[tier] === pct(correct, tierRows.length), `${entry.id} summary ${tier} completion mismatch`);
  }

  assert(JSON.stringify(entry.completion) === JSON.stringify(summary.completion), `${entry.id} completion differs from summary`);
  assert(JSON.stringify(entry.deltas) === JSON.stringify(summary.deltas), `${entry.id} deltas differ from summary`);
  assert(JSON.stringify(entry.byTier) === JSON.stringify(summary.byTier), `${entry.id} byTier differs from summary`);
}

async function main() {
  const artifactPath = absolute(argValue("--artifact", "results/cross-adapter-grade-summary.json"));
  const expectAdapters = argValue("--expect-adapters", "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const expectModel = argValue("--expect-model", "");
  const expectRows = Number(argValue("--expect-rows", "0"));
  const requireAllPassed = hasFlag("--require-all-passed");

  assert(existsSync(artifactPath), `grade artifact does not exist: ${artifactPath}`);
  const artifact = await readJson(artifactPath);
  assert(artifact.schema === "ambient.cross-adapter-grades.v1", `unexpected schema ${artifact.schema}`);
  assert(Date.parse(artifact.generatedAt), `invalid generatedAt ${artifact.generatedAt}`);
  assert(artifact.matrixSchema === "ambient.cross-adapter-matrix.v1", `unexpected matrixSchema ${artifact.matrixSchema}`);
  assert(typeof artifact.matrix === "string" && artifact.matrix, "matrix path is required");
  assert(typeof artifact.judge?.endpoint === "string" && artifact.judge.endpoint, "judge endpoint is required");
  assert(typeof artifact.judge?.model === "string" && artifact.judge.model, "judge model is required");
  assert(Array.isArray(artifact.adapters), "adapters must be an array");
  validateTotals(artifact);

  if (expectAdapters.length) {
    assertArrayEqual(artifact.adapters.map((entry) => entry.id), expectAdapters, "adapters");
  }
  if (expectModel) {
    assert(artifact.judge.model === expectModel, `judge model ${artifact.judge.model} !== ${expectModel}`);
  }

  const matrixPath = absolute(artifact.matrix);
  if (existsSync(matrixPath)) {
    const matrix = await readJson(matrixPath);
    assert(matrix.schema === artifact.matrixSchema, `matrix schema ${matrix.schema} !== ${artifact.matrixSchema}`);
  }

  for (const entry of artifact.adapters) {
    assert(typeof entry.id === "string" && entry.id, "adapter entry missing id");
    assert(MATRIX_STATUSES.has(entry.matrixStatus), `${entry.id} invalid matrixStatus ${entry.matrixStatus}`);
    assert(STATUSES.has(entry.status), `${entry.id} invalid status ${entry.status}`);
    if (expectRows) {
      assert(entry.rows === expectRows, `${entry.id} rows ${entry.rows} !== ${expectRows}`);
    }
    if (requireAllPassed) {
      assert(entry.status === "passed", `${entry.id} status ${entry.status} !== passed`);
    }
    if (entry.status === "passed" || entry.status === "judge-error") {
      await validateJudgedEntry(entry);
    } else {
      assert(typeof entry.reason === "string" && entry.reason, `${entry.id} ${entry.status} entry missing reason`);
    }
  }

  console.log(
    `cross-adapter grade artifact ok: ${artifact.adapters.length} adapters, passed=${artifact.totals.passed}, judge-errors=${artifact.totals.judgeErrors}, generated ${artifact.generatedAt}`,
  );
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
