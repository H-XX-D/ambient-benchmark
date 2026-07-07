#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const ix = args.indexOf(name);
  if (ix === -1) return fallback;
  if (ix + 1 >= args.length) throw new Error(`missing value for ${name}`);
  return args[ix + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function repoRelative(value) {
  return path.relative(ROOT, value) || ".";
}

function verdictPathFor(transcriptPath) {
  return transcriptPath.replace(/transcript-/, "verdicts-");
}

function summaryPathFor(verdictPath) {
  return verdictPath.replace(/\.jsonl$/, "-summary.json");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonl(file) {
  const body = await readFile(file, "utf8");
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, ix) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${repoRelative(file)}:${ix + 1}: ${err.message}`);
      }
    });
}

function runNode(script, scriptArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function tail(value, max = 2400) {
  if (!value) return "";
  return value.length <= max ? value : value.slice(value.length - max);
}

const matrixPath = resolveRepoPath(argValue("--matrix", "results/cross-adapter-matrix.json"));
const outPath = resolveRepoPath(argValue("--out", "results/cross-adapter-grade-summary.json"));
const adapterFilter = argValue("--adapters", "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
const strict = hasFlag("--strict");

const matrix = await readJson(matrixPath);
const selected = adapterFilter.length
  ? matrix.adapters.filter((entry) => adapterFilter.includes(entry.id))
  : matrix.adapters;

if (adapterFilter.length && selected.length !== adapterFilter.length) {
  const seen = new Set(selected.map((entry) => entry.id));
  const missing = adapterFilter.filter((id) => !seen.has(id));
  throw new Error(`matrix does not contain requested adapter(s): ${missing.join(", ")}`);
}

const judgeScript = path.join(ROOT, "tiers", "judge.mjs");
const entries = [];

for (const entry of selected) {
  const adapter = {
    id: entry.id,
    matrixStatus: entry.status,
    rows: entry.rows ?? null,
    transcript: entry.transcript ?? null,
  };

  if (entry.status !== "passed") {
    entries.push({
      ...adapter,
      status: "skipped",
      reason: `matrix status is ${entry.status}`,
    });
    continue;
  }

  if (!entry.transcript) {
    entries.push({
      ...adapter,
      status: "failed",
      reason: "matrix entry has no transcript",
    });
    continue;
  }

  const transcriptPath = resolveRepoPath(entry.transcript);
  if (!existsSync(transcriptPath)) {
    entries.push({
      ...adapter,
      status: "failed",
      reason: `transcript not found: ${entry.transcript}`,
    });
    continue;
  }

  const proc = await runNode(judgeScript, [repoRelative(transcriptPath)], process.env);
  const verdictPath = verdictPathFor(transcriptPath);
  const summaryPath = summaryPathFor(verdictPath);

  if (proc.code !== 0 || !existsSync(summaryPath)) {
    entries.push({
      ...adapter,
      status: "failed",
      verdicts: repoRelative(verdictPath),
      summary: repoRelative(summaryPath),
      exitCode: proc.code,
      signal: proc.signal,
      stdoutTail: tail(proc.stdout),
      stderrTail: tail(proc.stderr),
      reason: proc.code !== 0 ? "judge process failed" : "judge summary was not written",
    });
    continue;
  }

  const summary = await readJson(summaryPath);
  const verdicts = existsSync(verdictPath) ? await readJsonl(verdictPath) : [];
  const judgeErrors = verdicts.filter((row) =>
    String(row.reason ?? "").startsWith("judge error:"),
  ).length;

  entries.push({
    ...adapter,
    status: judgeErrors ? "judge-error" : "passed",
    verdicts: repoRelative(verdictPath),
    summary: repoRelative(summaryPath),
    judgeErrors,
    completion: summary.completion ?? null,
    deltas: summary.deltas ?? null,
    byTier: summary.byTier ?? null,
    byAbility: summary.byAbility ?? null,
  });
}

const totals = {
  adapters: entries.length,
  passed: entries.filter((entry) => entry.status === "passed").length,
  judgeError: entries.filter((entry) => entry.status === "judge-error").length,
  failed: entries.filter((entry) => entry.status === "failed").length,
  skipped: entries.filter((entry) => entry.status === "skipped").length,
  judgeErrors: entries.reduce((sum, entry) => sum + (entry.judgeErrors ?? 0), 0),
};

const artifact = {
  schema: "ambient.cross-adapter-grades.v1",
  generatedAt: new Date().toISOString(),
  matrix: repoRelative(matrixPath),
  matrixSchema: matrix.schema ?? null,
  judge: {
    endpoint: process.env.AMBIENT_JUDGE_ENDPOINT ?? "http://localhost:8089/v1",
    model: process.env.AMBIENT_JUDGE_MODEL ?? "judge",
  },
  strict,
  totals,
  adapters: entries,
};

await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(
  [
    `wrote ${repoRelative(outPath)}`,
    `adapters=${totals.adapters}`,
    `passed=${totals.passed}`,
    `judge-error=${totals.judgeError}`,
    `failed=${totals.failed}`,
    `skipped=${totals.skipped}`,
    `row-judge-errors=${totals.judgeErrors}`,
  ].join(" "),
);

if (strict && (totals.failed || totals.judgeErrors)) {
  process.exit(1);
}
