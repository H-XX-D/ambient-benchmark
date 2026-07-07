#!/usr/bin/env node
// Smoke for adapters/cognee-python-adapter.mjs.
//
// Bridges topoteretes/cognee (async, LLM-backed) into the AMBIENT wire protocol,
// then verifies /write, /query, and reset directory isolation.
//
// cognify() calls an LLM on every write, so this smoke is gated: it SKIPs unless
// cognee is importable AND an LLM is configured (LLM_API_KEY or OPENAI_API_KEY).
// Timeouts are generous because each write drives a full LLM graph build.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.AMBIENT_COGNEE_PYTHON || process.env.PYTHON || "python3";
const PACKAGE_PATH = process.env.AMBIENT_COGNEE_TEST_PACKAGE_PATH || "";
// cognify() calls the LLM per write, so allow long request budgets.
const REQUEST_TIMEOUT_MS = Number(process.env.AMBIENT_COGNEE_TEST_TIMEOUT_MS || 600000);

function withPackagePath(env) {
  const next = { ...env };
  if (PACKAGE_PATH) {
    next.PYTHONPATH = next.PYTHONPATH ? `${PACKAGE_PATH}:${next.PYTHONPATH}` : PACKAGE_PATH;
  }
  return next;
}

function cogneeImportable() {
  const probe = spawnSync(PYTHON, ["-c", "import cognee"], {
    env: withPackagePath(process.env),
    stdio: "ignore",
  });
  return probe.status === 0;
}

function llmConfigured() {
  return Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);
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

async function readJson(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return data;
}

async function waitForAdapter(port) {
  const deadline = Date.now() + 20000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/name`);
      if (res.ok) return;
      lastErr = new Error(`/name ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error("adapter did not start");
}

async function main() {
  if (!cogneeImportable() || !llmConfigured()) {
    console.log("SKIP: cognee not installed or no LLM configured (set LLM_API_KEY)");
    process.exit(0);
  }

  const roots = await mkdtemp(join(tmpdir(), "ambient-cognee-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const args = ["adapters/cognee-python-adapter.mjs", "--root", roots, "--port", String(port)];
  if (PACKAGE_PATH) args.push("--package-path", PACKAGE_PATH);
  const bridge = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  try {
    await waitForAdapter(port);
    const base = `http://127.0.0.1:${port}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "cognee") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "cognee builds an LLM knowledge graph from ingested text for AMBIENT recall",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`cognee write was not accepted or dir missing: ${JSON.stringify(write)}`);
    }

    const hit = await post(base, "/query", {
      store: "custom",
      question: "What does cognee build from ingested text?",
      top_k: 5,
    });
    if (!Array.isArray(hit.support) || !hit.support.some((s) => /cognee|knowledge graph/i.test(s))) {
      throw new Error(`expected cognee support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "cognee knowledge graph", top_k: 5 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate cognee dirs: ${JSON.stringify(miss)}`);
    }
    console.log("cognee bridge smoke: write/query/reset isolated cognee dirs verified");
  } finally {
    bridge.kill("SIGTERM");
    if (bridge.exitCode == null && !bridge.killed) bridge.kill("SIGKILL");
    await Promise.race([once(bridge, "exit"), new Promise((r) => setTimeout(r, 500))]);
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
