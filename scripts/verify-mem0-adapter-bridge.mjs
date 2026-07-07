#!/usr/bin/env node
// Smoke for adapters/mem0-http-adapter.mjs.
//
// Gated: if mem0 is not importable, or neither OPENAI_API_KEY nor
// MEM0_CONFIG_JSON is set, this prints SKIP and exits 0. When a backend is
// present it drives the bridge through /write, /query, and reset isolation.
//
// Note: mem0 infers memories with its llm on add, so the stored text may be a
// paraphrase of the fact. The query check therefore asserts that support came
// back at all, not an exact substring. Reset must then return no support.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON =
  process.env.AMBIENT_MEM0_TEST_PYTHON ||
  process.env.AMBIENT_MEM0_PYTHON ||
  process.env.PYTHON ||
  "python3";

function skip(reason) {
  console.log(reason);
  process.exit(0);
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
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return data;
}

async function waitForAdapter(port) {
  const deadline = Date.now() + 5000;
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
  const hasMem0 = spawnSync(PYTHON, ["-c", "import mem0"], { stdio: "ignore" }).status === 0;
  const hasBackend = Boolean(process.env.OPENAI_API_KEY || process.env.MEM0_CONFIG_JSON);
  if (!hasMem0 || !hasBackend) {
    skip("SKIP: mem0 not installed or no backend configured (set OPENAI_API_KEY or MEM0_CONFIG_JSON)");
  }

  const roots = await mkdtemp(join(tmpdir(), "ambient-mem0-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/mem0-http-adapter.mjs",
      "--root",
      roots,
      "--port",
      String(port),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForAdapter(port);
    const base = `http://127.0.0.1:${port}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "mem0") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "The AMBIENT mem0 adapter stores scoped benchmark memories in a configured vector store.",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) throw new Error(`mem0 store was not created: ${JSON.stringify(write)}`);

    const hit = await post(base, "/query", {
      store: "custom",
      question: "Where does the AMBIENT mem0 adapter store scoped benchmark memories?",
      top_k: 3,
    });
    if (!Array.isArray(hit.support) || hit.support.length === 0) {
      throw new Error(`expected support after write: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.some((p) => p.origin === "external")) {
      throw new Error(`expected external provenance: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", {
      store: "custom",
      question: "Where does the AMBIENT mem0 adapter store scoped benchmark memories?",
      top_k: 3,
    });
    if (miss.support.length) {
      throw new Error(`reset did not isolate memory: ${JSON.stringify(miss)}`);
    }
    console.log("mem0 bridge smoke: write/query/reset isolation verified");
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
