#!/usr/bin/env node
// Validate the latest local/free cross-adapter matrix artifact and transcripts.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = "results/cross-adapter-matrix.json";
const EXPECTED = {
  schema: "ambient.cross-adapter-matrix.v1",
  source: "beam",
  size: "small",
  limit: 2,
  expectedRowsPerAdapter: 8,
  model: "mock",
  checker: "mock",
  adapters: [
    "baseline-pull",
    "total-agent-memory-sqlite",
    "mcp-local-memory-sqlite",
    "sqlite-memory-mcp-sqlite",
    "agent-memory-sqlite",
    "agent-recall-python",
    "mcp-memory-keeper-sqlite",
    "local-memory-mcp-sqlite",
    "mcp-memory-sqlite",
    "agent-memory-mcp-sqlite",
  ],
};
const TIERS = new Set(["T1", "T2", "T3", "T4"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function absolute(path) {
  return isAbsolute(path) ? path : join(ROOT, path);
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

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`${path}:${index + 1} is not valid JSON: ${e.message}`);
    }
  });
}

async function validateTranscript(entry, matrix) {
  assert(typeof entry.transcript === "string" && entry.transcript, `${entry.id} missing transcript`);
  const path = absolute(entry.transcript);
  assert(existsSync(path), `${entry.id} transcript does not exist: ${entry.transcript}`);
  const rows = await readJsonl(path);
  assert(rows.length === matrix.expectedRowsPerAdapter, `${entry.id} transcript rows ${rows.length} !== ${matrix.expectedRowsPerAdapter}`);

  const tiers = new Map();
  const segs = new Set();
  for (const row of rows) {
    assert(typeof row.segId === "string" && row.segId, `${entry.id} transcript row missing segId`);
    assert(TIERS.has(row.tier), `${entry.id} transcript row has invalid tier ${row.tier}`);
    assert(typeof row.question === "string" && row.question, `${entry.id} transcript row missing question`);
    assert(typeof row.gold === "string", `${entry.id} transcript row missing gold`);
    assert(typeof row.answer === "string", `${entry.id} transcript row missing answer`);
    assert(typeof row.storeCall === "boolean", `${entry.id} transcript row missing storeCall boolean`);
    assert(Number.isInteger(row.servedCount) && row.servedCount >= 0, `${entry.id} transcript row invalid servedCount`);
    segs.add(row.segId);
    tiers.set(row.tier, (tiers.get(row.tier) || 0) + 1);
  }
  assert(segs.size === matrix.limit, `${entry.id} transcript segment count ${segs.size} !== ${matrix.limit}`);
  for (const tier of TIERS) {
    assert(tiers.get(tier) === matrix.limit, `${entry.id} ${tier} rows ${tiers.get(tier) || 0} !== ${matrix.limit}`);
  }
}

async function main() {
  const matrix = JSON.parse(await readFile(absolute(MATRIX_PATH), "utf8"));
  assert(matrix.schema === EXPECTED.schema, `unexpected schema ${matrix.schema}`);
  assert(Date.parse(matrix.generatedAt), `invalid generatedAt ${matrix.generatedAt}`);
  assert(typeof matrix.durationMs === "number" && matrix.durationMs >= 0, "durationMs must be nonnegative");
  for (const key of ["source", "size", "limit", "expectedRowsPerAdapter", "model", "checker"]) {
    assert(matrix[key] === EXPECTED[key], `${key} ${matrix[key]} !== ${EXPECTED[key]}`);
  }
  assertArrayEqual(matrix.adapters?.map((entry) => entry.id), EXPECTED.adapters, "adapters");

  for (const entry of matrix.adapters) {
    assert(entry.status === "passed", `${entry.id} status is ${entry.status}`);
    assert(entry.rows === matrix.expectedRowsPerAdapter, `${entry.id} rows ${entry.rows} !== ${matrix.expectedRowsPerAdapter}`);
    assert(typeof entry.command === "string" && entry.command.includes("tiers/runner.mjs"), `${entry.id} missing runner command`);
    await validateTranscript(entry, matrix);
  }

  console.log(`cross-adapter matrix artifact ok: ${matrix.adapters.length} adapters, ${matrix.expectedRowsPerAdapter} rows each, generated ${matrix.generatedAt}`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
