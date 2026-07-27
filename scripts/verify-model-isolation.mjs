#!/usr/bin/env node
// Fail closed on architecture-only claims when model, corpus, prompt, or pairing
// conditions drift. A passing adapter smoke test is intentionally not enough.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const TIERS = ["T1", "T2", "T3", "T4"];

function argValue(name, fallback = "") {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`missing value for ${name}`);
  return args[index + 1];
}

function absolute(value) {
  return isAbsolute(value) ? value : join(ROOT, value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });
}

function manifestForTranscript(transcript) {
  const file = transcript.split("/").pop().replace(/^transcript-/, "manifest-").replace(/\.jsonl$/, ".json");
  return join(dirname(transcript), file);
}

function stableComponents(components) {
  return JSON.stringify({
    capturePolicy: components?.capturePolicy ?? null,
    ingestGenerativeModel: components?.ingestGenerativeModel ?? null,
    queryGenerativeModel: components?.queryGenerativeModel ?? null,
    representationModel: components?.representationModel ?? null,
    rerankerModel: components?.rerankerModel ?? null,
  });
}

function validateOne(transcriptPath) {
  const manifestPath = manifestForTranscript(transcriptPath);
  assert(existsSync(manifestPath), `missing run manifest for ${transcriptPath}`);
  const manifest = readJson(manifestPath);
  const rows = readJsonl(transcriptPath);
  assert(manifest.schema === "ambient.run-manifest.v1", `${manifestPath}: unexpected schema`);
  assert(rows.length > 0, `${transcriptPath}: empty transcript`);
  assert(rows.every((row) => row.runId === manifest.runId), `${transcriptPath}: mixed or missing runId`);
  assert(rows.every((row) => row.sourceTrace?.answer?.fingerprint === manifest.models?.reader?.fingerprint), `${transcriptPath}: reader fingerprint drift`);

  const groups = new Map();
  const replicatesBySegment = new Map();
  for (const row of rows) {
    assert(TIERS.includes(row.tier), `${transcriptPath}: invalid tier ${row.tier}`);
    assert(row.tier === "T1" ? row.storeCall === false : row.storeCall === true, `${transcriptPath}: ${row.segId}/${row.tier} store-call invariant failed`);
    const key = `${row.segId}:${row.replicate ?? 0}`;
    const tiers = groups.get(key) ?? new Set();
    assert(!tiers.has(row.tier), `${transcriptPath}: duplicate ${key}/${row.tier}`);
    tiers.add(row.tier);
    groups.set(key, tiers);
    const replicates = replicatesBySegment.get(row.segId) ?? new Set();
    replicates.add(row.replicate ?? 0);
    replicatesBySegment.set(row.segId, replicates);
  }
  for (const [key, tiers] of groups) {
    assert(TIERS.every((tier) => tiers.has(tier)), `${transcriptPath}: incomplete paired cell ${key}`);
  }

  if (manifest.claimTrack === "architecture") {
    const components = manifest.adapter?.declaration?.components;
    assert(components, `${manifestPath}: architecture track requires an adapter component declaration`);
    assert(components.queryGenerativeModel === null, `${manifestPath}: queryGenerativeModel must be null in architecture track`);
    assert(components.ingestGenerativeModel === null, `${manifestPath}: adapter ingestGenerativeModel must be null; shared classifier is recorded separately`);
    assert(manifest.design?.tierOrder === "balanced", `${manifestPath}: architecture track requires balanced tier order`);
    assert(Number.isInteger(manifest.design?.repeats) && manifest.design.repeats >= 3, `${manifestPath}: architecture track requires at least three repeats`);
    for (const [segId, replicates] of replicatesBySegment) {
      assert(replicates.size === manifest.design.repeats, `${transcriptPath}: ${segId} has ${replicates.size} repeats, expected ${manifest.design.repeats}`);
    }
    const sampling = manifest.design?.sampling;
    if (sampling) {
      assert(sampling.method === "seeded-stratified-round-robin-v1", `${manifestPath}: unsupported sampling method`);
      assert(sampling.selectedSegments === replicatesBySegment.size, `${manifestPath}: sampling count differs from transcript`);
    }
  }
  return { manifest, rows, transcriptPath, componentKey: stableComponents(manifest.adapter?.declaration?.components) };
}

function main() {
  const transcriptArg = argValue("--transcripts");
  assert(transcriptArg, "usage: node scripts/verify-model-isolation.mjs --transcripts <a.jsonl,b.jsonl>");
  const runs = transcriptArg.split(",").map((value) => value.trim()).filter(Boolean).map(absolute).map(validateOne);
  const reference = runs[0].manifest;
  const invariant = (label, getter) => {
    const expected = JSON.stringify(getter(reference));
    for (const run of runs.slice(1)) {
      assert(JSON.stringify(getter(run.manifest)) === expected, `${label} differs between ${runs[0].transcriptPath} and ${run.transcriptPath}`);
    }
  };
  invariant("reader", (m) => m.models?.reader);
  invariant("claim track", (m) => m.claimTrack);
  invariant("shared classifier", (m) => m.models?.classifier);
  invariant("prompts", (m) => m.prompts);
  invariant("corpus", (m) => m.corpus);
  invariant("experimental design", (m) => m.design);

  if (reference.claimTrack === "architecture") {
    assert(runs.every((run) => run.manifest.claimTrack === "architecture"), "cannot mix architecture and non-architecture tracks");
    const components = runs[0].componentKey;
    assert(runs.every((run) => run.componentKey === components), "adapter-side representation/reranker components differ; this is a system comparison, not architecture-only");
  }
  console.log(`model-isolation gate passed: ${runs.length} transcript(s), ${runs.reduce((n, run) => n + run.rows.length, 0)} paired rows, track=${reference.claimTrack}`);
}

try { main(); }
catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
