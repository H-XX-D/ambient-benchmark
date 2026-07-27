#!/usr/bin/env node
// Local/free cross-adapter runner matrix.
//
// This is intentionally smaller than a publishable AMBIENT grade. It starts a
// mock OpenAI-compatible reader/checker plus several local adapters, drives the
// shared four-tier runner through each adapter, and validates the emitted
// transcript row counts. The output artifact is a reproducible smoke matrix, not
// a final served-context golden.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = arg("source", "beam");
const SIZE = arg("size", "small");
const LIMIT = Number(arg("limit", "2"));
const PER_ABILITY = Number(arg("per-ability", "0"));
const OUT = arg("out", "results/cross-adapter-matrix.json");
const EXPECTED_SEGMENTS = expectedSegmentCount();
const EXPECTED_ROWS = EXPECTED_SEGMENTS * 4;
const INCLUDE_OPTIONAL = hasFlag("include-optional");
const ALLOW_SKIPS = hasFlag("allow-skips");
const USE_EXTERNAL_MODEL = hasFlag("use-external-model");
const ADAPTER_TIMEOUT_MS = Number(arg("adapter-timeout-ms", USE_EXTERNAL_MODEL ? "900000" : "90000"));

const DEFAULT_ADAPTERS = [
  {
    id: "baseline-pull",
    script: "adapters/baseline-pull-server.mjs",
  },
  {
    id: "total-agent-memory-sqlite",
    script: "adapters/total-agent-memory-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-tam-",
  },
  {
    id: "mcp-local-memory-sqlite",
    script: "adapters/mcp-local-memory-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-mcp-local-",
  },
  {
    id: "sqlite-memory-mcp-sqlite",
    script: "adapters/sqlite-memory-mcp-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-sqlite-memory-mcp-",
  },
  {
    id: "agent-memory-sqlite",
    script: "adapters/agent-memory-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-agent-memory-",
  },
  {
    id: "agent-recall-python",
    script: "adapters/agent-recall-python-adapter.mjs",
    rootPrefix: "ambient-cross-agent-recall-",
    packagePathEnv: "AMBIENT_AGENT_RECALL_TEST_PACKAGE_PATH",
    packagePathDefault: "/tmp/ambient-agent-recall",
    packagePathProbe: ["agent_recall", "store.py"],
  },
  {
    id: "mcp-memory-keeper-sqlite",
    script: "adapters/mcp-memory-keeper-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-mcp-memory-keeper-",
  },
  {
    id: "local-memory-mcp-sqlite",
    script: "adapters/local-memory-mcp-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-local-memory-mcp-",
  },
  {
    id: "mcp-memory-sqlite",
    script: "adapters/mcp-memory-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-mcp-memory-sqlite-",
  },
  {
    id: "agent-memory-mcp-sqlite",
    script: "adapters/agent-memory-mcp-sqlite-adapter.mjs",
    rootPrefix: "ambient-cross-agent-memory-mcp-",
  },
];

const OPTIONAL_ADAPTERS = [
  {
    id: "recall",
    script: "adapters/recall_adapter.mjs",
  },
  {
    id: "ai-memory-search",
    script: "adapters/ai-memory-http-adapter.mjs",
    targetEnv: "AMBIENT_AI_MEMORY_TARGET",
    targetDefault: "http://127.0.0.1:9077",
    targetHealthPath: "/api/v1/health",
  },
  {
    id: "projectmem-cli",
    script: "adapters/projectmem-cli-adapter.mjs",
    rootPrefix: "ambient-cross-projectmem-",
    binEnv: "AMBIENT_PROJECTMEM_BIN",
    binDefault: "projectmem",
  },
  {
    id: "simple-memory-cli",
    script: "adapters/simple-memory-cli-adapter.mjs",
    rootPrefix: "ambient-cross-simple-memory-",
    binEnv: "AMBIENT_SIMPLE_MEMORY_BIN",
    binDefault: "simple-memory",
  },
  {
    id: "tree-ring-cli",
    script: "adapters/tree-ring-cli-adapter.mjs",
    rootPrefix: "ambient-cross-tree-ring-",
    binEnv: "AMBIENT_TREE_RING_BIN",
    binDefault: "tree-ring",
  },
  {
    id: "claude-memory-mcp-cli",
    script: "adapters/claude-memory-mcp-cli-adapter.mjs",
    rootPrefix: "ambient-cross-claude-memory-mcp-",
    binEnv: "AMBIENT_CLAUDE_MEMORY_BIN",
    binDefault: "claude-memory-mcp",
  },
  {
    id: "engram-cli",
    script: "adapters/engram-cli-adapter.mjs",
    rootPrefix: "ambient-cross-engram-",
    binEnv: "AMBIENT_ENGRAM_BIN",
    binDefault: "engram",
  },
];

const ALL_ADAPTERS = [...DEFAULT_ADAPTERS, ...OPTIONAL_ADAPTERS];

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes("--" + name);
}

function selectedAdapters() {
  const raw = arg("adapters", "");
  if (!raw) return INCLUDE_OPTIONAL ? ALL_ADAPTERS : DEFAULT_ADAPTERS;
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const selected = ALL_ADAPTERS.filter((a) => wanted.has(a.id));
  const missing = [...wanted].filter((id) => !ALL_ADAPTERS.some((a) => a.id === id));
  if (missing.length) throw new Error(`unknown adapter id(s): ${missing.join(", ")}`);
  if (!selected.length) throw new Error("--adapters selected no adapters");
  return selected;
}

function expectedSegmentCount() {
  const file = join(ROOT, "corpora", "out", SOURCE, SIZE, "segments.jsonl");
  const all = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const byAbility = new Map();
  for (const segment of all) {
    if (!byAbility.has(segment.ability)) byAbility.set(segment.ability, []);
    byAbility.get(segment.ability).push(segment);
  }
  const cap = PER_ABILITY || Math.max(1, Math.ceil(LIMIT / byAbility.size));
  const picked = [];
  for (const [, segments] of byAbility) picked.push(...segments.slice(0, cap));
  return picked.slice(0, LIMIT || picked.length).length;
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function startMockModel() {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const prompt = body?.messages?.map((m) => m.content || "").join("\n") || "";
    const content = /Relation:/i.test(prompt) ? "NONE" : "I don't know.";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return listen(server).then((port) => ({ server, port }));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForAdapter(port, timeoutMs = 5000) {
  const url = `http://127.0.0.1:${port}/name`;
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      lastErr = new Error(`adapter /name ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error("adapter did not start");
}

async function checkTarget(target, healthPath = "/") {
  const url = target.replace(/\/$/, "") + healthPath;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return null;
    return `${url} returned HTTP ${res.status}`;
  } catch (e) {
    return `${url} unavailable: ${e?.message || String(e)}`;
  }
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs);
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve({ stdout, stderr, code });
      const label = timedOut ? `timed out after ${timeoutMs}ms` : `exited ${code}`;
      reject(new Error(`${args.join(" ")} ${label}\n${stdout}${stderr}`));
    });
  });
}

async function countRows(path) {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).length;
}

function parseTranscript(output) {
  const match = output.match(/wrote\s+(\d+)\s+rows\s+->\s+([^\s]+)/);
  if (!match) throw new Error(`runner output did not include transcript path\n${output}`);
  return { rows: Number(match[1]), transcript: match[2] };
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 500))]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

async function runAdapter(adapter, modelPort) {
  const port = await freePort();
  const tempRoot = adapter.rootPrefix ? await mkdtemp(join(tmpdir(), adapter.rootPrefix)) : "";
  const args = [adapter.script, "--port", String(port)];
  if (tempRoot) args.push("--root", tempRoot);

  if (adapter.binEnv || adapter.binDefault) {
    const bin = process.env[adapter.binEnv] || adapter.binDefault;
    if (!commandExists(bin)) {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      return {
        id: adapter.id,
        status: ALLOW_SKIPS ? "skipped" : "failed",
        reason: "missing-prerequisite",
        error: `${adapter.id} binary missing: ${bin}. Set ${adapter.binEnv} or install it.`,
      };
    }
    args.push("--bin", bin);
  }

  if (adapter.targetEnv || adapter.targetDefault) {
    const target = process.env[adapter.targetEnv] || adapter.targetDefault;
    const targetError = await checkTarget(target, adapter.targetHealthPath);
    if (targetError) {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      return {
        id: adapter.id,
        status: ALLOW_SKIPS ? "skipped" : "failed",
        reason: "missing-prerequisite",
        error: `${adapter.id} target not ready: ${targetError}. Set ${adapter.targetEnv} or start the daemon.`,
      };
    }
    args.push("--target", target);
  }

  if (adapter.packagePathEnv || adapter.packagePathDefault) {
    const packagePath = process.env[adapter.packagePathEnv] || adapter.packagePathDefault;
    const probe = adapter.packagePathProbe ? join(packagePath, ...adapter.packagePathProbe) : packagePath;
    if (!existsSync(probe)) {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
      return {
        id: adapter.id,
        status: ALLOW_SKIPS ? "skipped" : "failed",
        reason: "missing-prerequisite",
        error: `package path missing for ${adapter.id}: ${probe}`,
      };
    }
    args.push("--package-path", packagePath);
  }
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let adapterOutput = "";
  child.stdout.on("data", (b) => { adapterOutput += b.toString(); });
  child.stderr.on("data", (b) => { adapterOutput += b.toString(); });

  try {
    const name = await waitForAdapter(port);
    if (name.name !== adapter.id) {
      throw new Error(`expected /name ${adapter.id}, got ${JSON.stringify(name)}`);
    }

    const runnerArgs = [
      "tiers/runner.mjs",
      "--adapter-url",
      `http://127.0.0.1:${port}`,
      "--source",
      SOURCE,
      "--size",
      SIZE,
      "--limit",
      String(LIMIT),
    ];
    if (PER_ABILITY) runnerArgs.push("--per-ability", String(PER_ABILITY));
    const modelEnv = USE_EXTERNAL_MODEL
      ? process.env
      : {
          ...process.env,
          AMBIENT_MODEL_BACKEND: "local",
          AMBIENT_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
          AMBIENT_MODEL: "mock",
          AMBIENT_CHECKER_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
          AMBIENT_CHECKER_MODEL: "mock",
        };
    const { stdout, stderr } = await runProcess(process.execPath, runnerArgs, {
      timeoutMs: ADAPTER_TIMEOUT_MS,
      env: modelEnv,
    });
    const output = stdout + stderr;
    const transcript = parseTranscript(output);
    const transcriptPath = isAbsolute(transcript.transcript)
      ? transcript.transcript
      : join(ROOT, transcript.transcript);
    if (transcript.rows !== EXPECTED_ROWS) {
      throw new Error(`expected ${EXPECTED_ROWS} rows for ${adapter.id}, runner wrote ${transcript.rows}`);
    }
    if (!existsSync(transcriptPath)) {
      throw new Error(`transcript missing for ${adapter.id}: ${transcriptPath}`);
    }
    const fileRows = await countRows(transcriptPath);
    if (fileRows !== EXPECTED_ROWS) {
      throw new Error(`expected ${EXPECTED_ROWS} transcript rows for ${adapter.id}, file has ${fileRows}`);
    }
    if (!new RegExp(`adapter=${adapter.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\+auto)?`).test(output)) {
      throw new Error(`runner output did not identify ${adapter.id}\n${output}`);
    }
    console.log(`matrix ${adapter.id}: passed ${fileRows} rows -> ${transcript.transcript}`);
    return {
      id: adapter.id,
      status: "passed",
      adapterUrl: `http://127.0.0.1:${port}`,
      transcript: transcript.transcript,
      rows: fileRows,
      command: [process.execPath, ...runnerArgs].join(" "),
    };
  } catch (e) {
    return {
      id: adapter.id,
      status: "failed",
      error: e?.message || String(e),
      adapterLogTail: adapterOutput.slice(-2000),
    };
  } finally {
    await stopProcess(child);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const adapters = selectedAdapters();
  const mockModel = USE_EXTERNAL_MODEL ? null : await startMockModel();
  const modelPort = mockModel?.port;
  const startedAt = new Date();
  const entries = [];
  try {
    for (const adapter of adapters) {
      entries.push(await runAdapter(adapter, modelPort));
    }
  } finally {
    mockModel?.server.close();
  }

  const artifact = {
    schema: "ambient.cross-adapter-matrix.v1",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    source: SOURCE,
    size: SIZE,
    limit: LIMIT,
    perAbility: PER_ABILITY || null,
    expectedRowsPerAdapter: EXPECTED_ROWS,
    model: USE_EXTERNAL_MODEL ? (process.env.AMBIENT_MODEL || "external") : "mock",
    checker: USE_EXTERNAL_MODEL ? (process.env.AMBIENT_CHECKER_MODEL || process.env.AMBIENT_MODEL || "external") : "mock",
    adapters: entries,
  };
  const outPath = isAbsolute(OUT) ? OUT : join(ROOT, OUT);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`cross-adapter matrix wrote ${entries.length} entries -> ${OUT}`);

  const failures = entries.filter((entry) => entry.status !== "passed" && entry.status !== "skipped");
  const skipped = entries.filter((entry) => entry.status === "skipped");
  if (skipped.length) {
    for (const skip of skipped) {
      console.warn(`matrix ${skip.id}: skipped\n${skip.error}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) {
      console.error(`matrix ${failure.id}: failed\n${failure.error}`);
      if (failure.adapterLogTail) console.error(failure.adapterLogTail);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
