#!/usr/bin/env node
// Check local prerequisites for optional AMBIENT adapter matrix targets.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = arg("out", "results/optional-adapter-prereqs.json");
const STRICT = hasFlag("strict");

const TARGETS = [
  {
    id: "recall",
    kind: "vendored",
    probe: "vendor/recall/dist/index.js",
    run: "included in the repo; no external runtime required",
  },
  {
    id: "ai-memory-search",
    kind: "daemon",
    env: "AMBIENT_AI_MEMORY_TARGET",
    target: process.env.AMBIENT_AI_MEMORY_TARGET || "http://127.0.0.1:9077",
    healthPath: "/api/v1/health",
    run: "ai-memory serve --host 127.0.0.1 --port 9077",
  },
  {
    id: "projectmem-cli",
    kind: "binary",
    env: "AMBIENT_PROJECTMEM_BIN",
    command: process.env.AMBIENT_PROJECTMEM_BIN || "projectmem",
    install: "pip install projectmem",
  },
  {
    id: "simple-memory-cli",
    kind: "binary",
    env: "AMBIENT_SIMPLE_MEMORY_BIN",
    command: process.env.AMBIENT_SIMPLE_MEMORY_BIN || "simple-memory",
    install: "npm install -g simple-memory-mcp",
  },
  {
    id: "claude-memory-mcp-cli",
    kind: "binary",
    env: "AMBIENT_CLAUDE_MEMORY_BIN",
    command: process.env.AMBIENT_CLAUDE_MEMORY_BIN || "claude-memory-mcp",
    install: "npm install -g @whenmoon-afk/memory-mcp",
  },
  {
    id: "engram-cli",
    kind: "binary",
    env: "AMBIENT_ENGRAM_BIN",
    command: process.env.AMBIENT_ENGRAM_BIN || "engram",
    install: "brew install gentleman-programming/tap/engram",
  },
];

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes("--" + name);
}

function commandExists(command) {
  if (!command) return false;
  if (command.includes("/") && existsSync(command)) return true;
  const quoted = JSON.stringify(command);
  const result = spawnSync("/bin/sh", ["-lc", `command -v -- ${quoted} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function checkHttp(target, healthPath) {
  const url = target.replace(/\/$/, "") + healthPath;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return {
      ok: res.ok,
      probe: url,
      detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      probe: url,
      detail: e?.message || String(e),
    };
  }
}

async function checkTarget(target) {
  if (target.kind === "vendored") {
    const probe = join(ROOT, target.probe);
    return {
      id: target.id,
      kind: target.kind,
      ok: existsSync(probe),
      probe: target.probe,
      action: target.run,
    };
  }

  if (target.kind === "daemon") {
    const checked = await checkHttp(target.target, target.healthPath);
    return {
      id: target.id,
      kind: target.kind,
      ok: checked.ok,
      env: target.env,
      value: target.target,
      probe: checked.probe,
      detail: checked.detail,
      action: checked.ok ? "ready" : `start with: ${target.run}`,
    };
  }

  if (target.kind === "binary") {
    const ok = commandExists(target.command);
    return {
      id: target.id,
      kind: target.kind,
      ok,
      env: target.env,
      value: target.command,
      detail: ok ? "found on PATH or explicit path exists" : "binary not found",
      action: ok ? "ready" : `install with: ${target.install}; or set ${target.env}`,
    };
  }

  throw new Error(`unsupported target kind: ${target.kind}`);
}

async function main() {
  const checked = [];
  for (const target of TARGETS) {
    checked.push(await checkTarget(target));
  }
  const report = {
    schema: "ambient.optional-adapter-prereqs.v1",
    generatedAt: new Date().toISOString(),
    strict: STRICT,
    ready: checked.filter((row) => row.ok).length,
    missing: checked.filter((row) => !row.ok).length,
    targets: checked,
  };

  const outPath = join(ROOT, OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");

  for (const row of checked) {
    const status = row.ok ? "ready" : "missing";
    console.log(`${status.padEnd(7)} ${row.id} :: ${row.action}`);
  }
  console.log(`optional adapter prereqs: ${report.ready} ready, ${report.missing} missing -> ${OUT}`);

  if (STRICT && report.missing) process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
