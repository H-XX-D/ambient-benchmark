#!/usr/bin/env node
// Validate the last clean-verification summary against the current repo command graph.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARY_PATH = "results/clean-verification.json";

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectMjs(dir) {
  const root = join(ROOT, dir);
  if (!(await pathExists(root))) return [];
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...await collectMjs(relative(ROOT, full)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(relative(ROOT, full));
    }
  }
  return out.sort();
}

async function expectedCommands(summary) {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  const adapterScripts = Object.keys(scripts).filter((name) => name.startsWith("verify:adapter:"));
  const requiredScripts = [
    "bench",
    "bench:suite",
    "bench:contradiction",
    "verify:mal:standing-programs",
    ...adapterScripts,
  ];

  if (summary.scope?.includeInjection) requiredScripts.push("corpus:injection", "bench:injection");
  if (summary.scope?.includeModel) requiredScripts.push("bench:suite:1b", "bench:1b-hard");

  const syntaxDirs = ["adapters", "scripts", "suites", "tiers", "corpora", "model"];
  const syntaxFiles = (await Promise.all(syntaxDirs.map(collectMjs))).flat();
  return [
    ...syntaxFiles.map((file) => `node --check ${file}`),
    ...requiredScripts.map((script) => `npm run ${script}`),
  ];
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

async function main() {
  const summary = JSON.parse(await readFile(join(ROOT, SUMMARY_PATH), "utf8"));
  const commands = await expectedCommands(summary);
  const syntaxChecks = commands.filter((c) => c.startsWith("node --check ")).length;
  const npmScripts = commands.filter((c) => c.startsWith("npm run ")).length;

  assert(summary.schema === "ambient.clean-verification.v1", `unexpected schema ${summary.schema}`);
  assert(summary.status === "passed", `summary status is ${summary.status}`);
  assert(Date.parse(summary.generatedAt), `invalid generatedAt ${summary.generatedAt}`);
  assert(summary.scope && typeof summary.scope === "object", "missing scope");
  assert(summary.loop && typeof summary.loop === "object", "missing loop");
  assert(summary.environment?.node, "missing environment.node");
  assert(summary.totals?.steps === commands.length, `steps ${summary.totals?.steps} !== ${commands.length}`);
  assert(summary.totals?.completed === commands.length, `completed ${summary.totals?.completed} !== ${commands.length}`);
  assert(summary.totals?.syntaxChecks === syntaxChecks, `syntaxChecks ${summary.totals?.syntaxChecks} !== ${syntaxChecks}`);
  assert(summary.totals?.npmScripts === npmScripts, `npmScripts ${summary.totals?.npmScripts} !== ${npmScripts}`);
  assert(typeof summary.totals?.durationMs === "number" && summary.totals.durationMs >= 0, "durationMs must be nonnegative");
  assertArrayEqual(summary.commands, commands, "commands");

  const skipped = [];
  if (!summary.scope.includeInjection) skipped.push("injection suite");
  if (!summary.scope.includeModel) skipped.push("local-model 1B suites");
  assertArrayEqual(summary.scope.skipped || [], skipped, "scope.skipped");

  console.log(`clean verification artifact ok: ${commands.length} commands, generated ${summary.generatedAt}`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
