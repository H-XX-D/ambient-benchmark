#!/usr/bin/env node
// Local clean-pass loop for AMBIENT.
//
// Default scope is fully local/free: syntax checks, deterministic benchmarks,
// admission-time contradiction corpus, and every verify:adapter:* smoke.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    delayMs: Number(process.env.AMBIENT_VERIFY_DELAY_MS || 2000),
    forever: process.env.AMBIENT_VERIFY_FOREVER === "1",
    includeInjection: process.env.AMBIENT_VERIFY_INCLUDE_INJECTION === "1",
    includeModel: process.env.AMBIENT_VERIFY_INCLUDE_MODEL === "1",
    maxIterations: process.env.AMBIENT_VERIFY_MAX_ITERATIONS
      ? Number(process.env.AMBIENT_VERIFY_MAX_ITERATIONS)
      : undefined,
    once: false,
    summaryJson: process.env.AMBIENT_VERIFY_SUMMARY_JSON || undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") options.once = true;
    else if (arg === "--forever") options.forever = true;
    else if (arg === "--include-injection") options.includeInjection = true;
    else if (arg === "--include-model") options.includeModel = true;
    else if (arg === "--delay-ms") options.delayMs = Number(argv[++i]);
    else if (arg === "--max-iterations") options.maxIterations = Number(argv[++i]);
    else if (arg === "--summary-json") options.summaryJson = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.once) options.maxIterations = 1;
  if (!options.forever && !options.maxIterations) options.maxIterations = 25;
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error(`invalid --delay-ms: ${options.delayMs}`);
  }
  if (!options.forever && (!Number.isInteger(options.maxIterations) || options.maxIterations < 1)) {
    throw new Error(`invalid --max-iterations: ${options.maxIterations}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run verify:clean[:loop] -- [options]

Options:
  --once                 Run one clean pass and exit.
  --max-iterations N     Retry until success or N failed passes. Default: 25.
  --forever              Retry until success with no iteration cap.
  --delay-ms N           Delay between failed passes. Default: 2000.
  --include-injection    Include corpus:injection + bench:injection. Needs GEMINI_API_KEY.
  --include-model        Include bench:suite:1b + bench:1b-hard. Needs local model backend.
  --summary-json PATH    Write a JSON pass/fail summary.
`);
}

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

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`));
    });
  });
}

async function commandList(options) {
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

  if (options.includeInjection) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("--include-injection needs GEMINI_API_KEY in the environment");
    }
    requiredScripts.push("corpus:injection", "bench:injection");
  }

  if (options.includeModel) {
    requiredScripts.push("bench:suite:1b", "bench:1b-hard");
  }

  for (const script of requiredScripts) {
    if (!scripts[script]) throw new Error(`package.json is missing script ${script}`);
  }

  const syntaxDirs = ["adapters", "scripts", "suites", "tiers", "corpora", "model"];
  const syntaxFiles = (await Promise.all(syntaxDirs.map(collectMjs))).flat();
  const checks = syntaxFiles.map((file) => ({
    label: `node --check ${file}`,
    command: process.execPath,
    args: ["--check", file],
  }));
  const npmRuns = requiredScripts.map((script) => ({
    label: `npm run ${script}`,
    command: "npm",
    args: ["run", script],
  }));

  return [...checks, ...npmRuns];
}

async function runIteration(iteration, commands, options) {
  console.log(`\n=== AMBIENT clean verification pass ${iteration} ===`);
  const skipped = [];
  if (!options.includeInjection) skipped.push("injection suite");
  if (!options.includeModel) skipped.push("local-model 1B suites");
  if (skipped.length) console.log(`Scope: local/free default; skipped ${skipped.join(" and ")}.`);

  const started = Date.now();
  const completed = [];
  for (let i = 0; i < commands.length; i += 1) {
    const step = commands[i];
    console.log(`\n[${i + 1}/${commands.length}] ${step.label}`);
    await run(step.command, step.args, step.env);
    completed.push(step.label);
  }
  const durationMs = Date.now() - started;
  const seconds = (durationMs / 1000).toFixed(1);
  console.log(`\nAMBIENT clean verification pass ${iteration} succeeded in ${seconds}s.`);
  return {
    completed,
    durationMs,
    iteration,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSummary(options, commands, result) {
  if (!options.summaryJson) return;
  const path = resolve(ROOT, options.summaryJson);
  const skipped = [];
  if (!options.includeInjection) skipped.push("injection suite");
  if (!options.includeModel) skipped.push("local-model 1B suites");
  const summary = {
    schema: "ambient.clean-verification.v1",
    generatedAt: new Date().toISOString(),
    status: result.status,
    scope: {
      localFreeDefault: !options.includeInjection && !options.includeModel,
      includeInjection: options.includeInjection,
      includeModel: options.includeModel,
      skipped,
    },
    loop: {
      iteration: result.iteration,
      maxIterations: options.forever ? null : options.maxIterations,
      forever: options.forever,
      delayMs: options.delayMs,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    totals: {
      steps: commands.length,
      syntaxChecks: commands.filter((c) => c.label.startsWith("node --check ")).length,
      npmScripts: commands.filter((c) => c.label.startsWith("npm run ")).length,
      completed: result.completed?.length ?? 0,
      durationMs: result.durationMs ?? null,
    },
    commands: commands.map((c) => c.label),
    failure: result.failure ?? null,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nwrote clean verification summary -> ${relative(ROOT, path)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commands = await commandList(options);
  let iteration = 1;
  for (;;) {
    try {
      const result = await runIteration(iteration, commands, options);
      await writeSummary(options, commands, {
        ...result,
        status: "passed",
      });
      return;
    } catch (e) {
      console.error(`\nAMBIENT clean verification pass ${iteration} failed:`);
      console.error(e?.stack || e?.message || String(e));
      if (!options.forever && iteration >= options.maxIterations) {
        await writeSummary(options, commands, {
          completed: [],
          durationMs: null,
          failure: e?.stack || e?.message || String(e),
          iteration,
          status: "failed",
        });
        console.error(`\nNo clean pass after ${iteration} iteration(s).`);
        process.exit(1);
      }
      iteration += 1;
      console.error(`\nRetrying in ${options.delayMs}ms...`);
      await sleep(options.delayMs);
    }
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
