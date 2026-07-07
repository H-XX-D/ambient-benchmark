#!/usr/bin/env node
// Smoke for adapters/memoryos-python-adapter.mjs.
//
// Bridges BAI-LAB/MemoryOS (import name "memoryos", distribution "memoryos-pro"). This needs a
// live OpenAI-compatible model plus a sentence-transformers embedding backend, so it is gated:
// if MemoryOS is not importable OR OPENAI_API_KEY is unset, it prints SKIP and exits 0.
// Otherwise it verifies /write, /query, and reset data_storage_path isolation with generous
// timeouts (the first run downloads the embedding model).

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.AMBIENT_MEMORYOS_PYTHON || process.env.PYTHON || "python3";
const TEST_PACKAGE_PATH = process.env.AMBIENT_MEMORYOS_TEST_PACKAGE_PATH || "";
const OP_TIMEOUT_MS = 300000;
const SKIP_MESSAGE =
  "SKIP: memoryos not installed or no model configured (set OPENAI_API_KEY, optionally OPENAI_BASE_URL)";

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

async function post(base, path, body, timeoutMs = OP_TIMEOUT_MS) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return data;
}

async function waitForAdapter(port) {
  const deadline = Date.now() + 15000;
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

function memoryosImportable() {
  const env = { ...process.env };
  if (TEST_PACKAGE_PATH) {
    env.PYTHONPATH = env.PYTHONPATH ? `${TEST_PACKAGE_PATH}:${env.PYTHONPATH}` : TEST_PACKAGE_PATH;
  }
  const probe = spawnSync(PYTHON, ["-c", "import memoryos"], { env, stdio: "ignore" });
  return probe.status === 0;
}

async function main() {
  // Gate: MemoryOS must be importable AND an OpenAI-compatible key must be present.
  if (!memoryosImportable() || !process.env.OPENAI_API_KEY) {
    console.log(SKIP_MESSAGE);
    process.exit(0);
  }

  const roots = await mkdtemp(join(tmpdir(), "ambient-memoryos-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridgeArgs = ["adapters/memoryos-python-adapter.mjs", "--root", roots, "--port", String(port)];
  if (TEST_PACKAGE_PATH) bridgeArgs.push("--package-path", TEST_PACKAGE_PATH);
  const bridge = spawn(process.execPath, bridgeArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  try {
    await waitForAdapter(port);
    const base = `http://127.0.0.1:${port}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "memoryos") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "MemoryOS stores conversation memories that the retriever can recall later",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`memoryos data path was not created: ${JSON.stringify(write)}`);
    }

    const hit = await post(base, "/query", {
      store: "custom",
      question: "What does MemoryOS store?",
      top_k: 3,
    });
    if (!hit.support.some((s) => s.includes("MemoryOS"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.some((p) => p.origin === "external")) {
      throw new Error(`expected external provenance missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", {
      store: "custom",
      question: "What does MemoryOS store?",
      top_k: 3,
    });
    if (miss.support.length) {
      throw new Error(`reset did not isolate data_storage_path: ${JSON.stringify(miss)}`);
    }
    console.log("memoryos bridge smoke: write/query/reset isolated data_storage_path verified");
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
