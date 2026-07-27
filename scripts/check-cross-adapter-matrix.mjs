#!/usr/bin/env node
// Validate the latest local/free cross-adapter matrix artifact and transcripts.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributionEvidence } from "../tiers/attribution.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) throw new Error(`missing value for ${name}`);
  return args[index + 1];
}
const MATRIX_PATH = argValue("--artifact", "results/cross-adapter-matrix.json");
const EXPECTED = {
  schema: "ambient.cross-adapter-matrix.v1",
  source: argValue("--expect-source", "beam"),
  size: argValue("--expect-size", "small"),
  limit: Number(argValue("--expect-limit", "2")),
  perAbility: Number(argValue("--expect-per-ability", "0")) || null,
  seed: argValue("--expect-seed", "ambient-v1"),
  repeats: Number(argValue("--expect-repeats", "1")),
  track: argValue("--expect-track", "development"),
  tierOrder: argValue("--expect-tier-order", "balanced"),
  expectedRowsPerAdapter: Number(argValue("--expect-rows", "8")),
  model: argValue("--expect-model", "mock"),
  checker: argValue("--expect-checker", "mock"),
  adapters: argValue("--expect-adapters", [
    "baseline-pull",
    "total-agent-memory-sqlite",
    "mcp-local-memory-sqlite",
    "sqlite-memory-mcp-sqlite",
    "agent-memory-sqlite",
    "mcp-memory-sqlite-personal",
    "mcp-memory-keeper-sqlite",
    "local-memory-mcp-sqlite",
    "mcp-memory-sqlite",
    "agent-memory-mcp-sqlite",
  ].join(",")).split(",").map((value) => value.trim()).filter(Boolean),
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
  const paired = new Map();
  for (const row of rows) {
    assert(typeof row.segId === "string" && row.segId, `${entry.id} transcript row missing segId`);
    assert(TIERS.has(row.tier), `${entry.id} transcript row has invalid tier ${row.tier}`);
    assert(typeof row.question === "string" && row.question, `${entry.id} transcript row missing question`);
    assert(typeof row.gold === "string", `${entry.id} transcript row missing gold`);
    assert(typeof row.answer === "string", `${entry.id} transcript row missing answer`);
    assert(typeof row.storeCall === "boolean", `${entry.id} transcript row missing storeCall boolean`);
    assert(Number.isInteger(row.servedCount) && row.servedCount >= 0, `${entry.id} transcript row invalid servedCount`);
    assert(Array.isArray(row.servedContext), `${entry.id} transcript row missing servedContext array`);
    assert(row.servedContext.length === row.servedCount, `${entry.id} transcript row servedContext length ${row.servedContext.length} !== servedCount ${row.servedCount}`);
    assert(row.servedContext.every((item) => typeof item === "string"), `${entry.id} transcript row servedContext must contain strings`);
    assert(Array.isArray(row.servedProvenance), `${entry.id} transcript row missing servedProvenance array`);
    assert(row.servedProvenance.length === row.servedCount, `${entry.id} transcript row servedProvenance length ${row.servedProvenance.length} !== servedCount ${row.servedCount}`);
    assert(row.sourceTrace?.schema === "ambient.source_trace.v1", `${entry.id} transcript row missing sourceTrace schema`);
    assert(row.sourceTrace?.answer?.origin === "model_api", `${entry.id} transcript row missing model answer source trace`);
    assert(Array.isArray(row.sourceTrace?.memoryQueries), `${entry.id} transcript row missing memory query source trace`);
    const evidence = attributionEvidence(row);
    assert(row.sourceTrace?.attribution?.hasStoreCall === row.storeCall, `${entry.id} transcript row hasStoreCall mismatch`);
    assert(row.sourceTrace?.attribution?.hasMemoryDbSupport === evidence.hasMemoryDbSupport, `${entry.id} transcript row hasMemoryDbSupport mismatch`);
    if (row.storeCall) {
      assert(row.sourceTrace.memoryQueries.length > 0, `${entry.id} transcript row storeCall without memory query trace`);
      assert(row.sourceTrace.memoryQueries.every((q) => q.origin === "memory_db"), `${entry.id} transcript row memory query origin must be memory_db`);
    } else {
      assert(row.sourceTrace.memoryQueries.length === 0, `${entry.id} transcript row no-store tier should not have memory query trace`);
    }
    segs.add(row.segId);
    tiers.set(row.tier, (tiers.get(row.tier) || 0) + 1);
    const pairKey = `${row.segId}:${row.replicate ?? 0}`;
    const pairTiers = paired.get(pairKey) ?? new Set();
    assert(!pairTiers.has(row.tier), `${entry.id} duplicate paired cell ${pairKey}/${row.tier}`);
    pairTiers.add(row.tier);
    paired.set(pairKey, pairTiers);
  }
  const expectedSegments = matrix.expectedRowsPerAdapter / (TIERS.size * matrix.repeats);
  assert(Number.isInteger(expectedSegments), `${entry.id} expected rows are not divisible by tier count × repeats`);
  assert(segs.size === expectedSegments, `${entry.id} transcript unique segment count ${segs.size} !== ${expectedSegments}`);
  assert(paired.size === expectedSegments * matrix.repeats, `${entry.id} paired replicate count drift`);
  for (const [pairKey, pairTiers] of paired) {
    assert([...TIERS].every((tier) => pairTiers.has(tier)), `${entry.id} incomplete paired cell ${pairKey}`);
  }
  for (const tier of TIERS) {
    assert(tiers.get(tier) === expectedSegments * matrix.repeats, `${entry.id} ${tier} rows ${tiers.get(tier) || 0} !== ${expectedSegments * matrix.repeats}`);
  }
}

async function main() {
  const matrix = JSON.parse(await readFile(absolute(MATRIX_PATH), "utf8"));
  assert(matrix.schema === EXPECTED.schema, `unexpected schema ${matrix.schema}`);
  assert(Date.parse(matrix.generatedAt), `invalid generatedAt ${matrix.generatedAt}`);
  assert(typeof matrix.durationMs === "number" && matrix.durationMs >= 0, "durationMs must be nonnegative");
  for (const key of ["source", "size", "limit", "perAbility", "seed", "repeats", "track", "tierOrder", "expectedRowsPerAdapter", "model", "checker"]) {
    assert(matrix[key] === EXPECTED[key], `${key} ${matrix[key]} !== ${EXPECTED[key]}`);
  }
  assert(matrix.sampling?.method === "seeded-stratified-round-robin-v1", "matrix sampling method is missing");
  assert(matrix.sampling.selectedSegments * 4 * matrix.repeats === matrix.expectedRowsPerAdapter, "matrix sampling count differs from expected rows");
  assertArrayEqual(matrix.adapters?.map((entry) => entry.id), EXPECTED.adapters, "adapters");

  for (const entry of matrix.adapters) {
    assert(entry.status === "passed", `${entry.id} status is ${entry.status}`);
    assert(entry.rows === matrix.expectedRowsPerAdapter, `${entry.id} rows ${entry.rows} !== ${matrix.expectedRowsPerAdapter}`);
    assert(typeof entry.command === "string" && entry.command.includes("tiers/runner.mjs"), `${entry.id} missing runner command`);
    assert(typeof entry.manifest === "string" && existsSync(absolute(entry.manifest)), `${entry.id} missing run manifest`);
    await validateTranscript(entry, matrix);
  }

  console.log(`cross-adapter matrix artifact ok: ${matrix.adapters.length} adapters, ${matrix.expectedRowsPerAdapter} rows each, generated ${matrix.generatedAt}`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
