#!/usr/bin/env node
// Smoke for adapters/langmem-python-adapter.mjs.
//
// Gated: skips cleanly unless langgraph + langmem import AND an embeddings backend
// is configured (OPENAI_API_KEY or LANGMEM_EMBEDDER). When enabled it verifies
// /write, /query, and reset snapshot isolation against a real embedder.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.AMBIENT_LANGMEM_PYTHON || process.env.PYTHON || "python3";

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

function langmemImportable() {
  const probe = spawnSync(PYTHON, ["-c", "import langgraph, langmem"], { stdio: "ignore" });
  return probe.status === 0;
}

async function main() {
  const hasEmbedder = Boolean(process.env.OPENAI_API_KEY || process.env.LANGMEM_EMBEDDER);
  if (!langmemImportable() || !hasEmbedder) {
    console.log("SKIP: langmem not installed or no embedder configured (set OPENAI_API_KEY or LANGMEM_EMBEDDER)");
    process.exit(0);
  }

  const roots = await mkdtemp(join(tmpdir(), "ambient-langmem-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/langmem-python-adapter.mjs",
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
    if (name.name !== "langmem") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "langmem stores memories in a LangGraph store indexed by a semantic embedder",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) throw new Error(`langmem snapshot was not created: ${JSON.stringify(write)}`);

    const hit = await post(base, "/query", { store: "custom", question: "Where does langmem keep memories with semantic search?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("langmem"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "langmem semantic memory store", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate snapshot: ${JSON.stringify(miss)}`);
    }
    console.log("langmem bridge smoke: write/query/reset isolated snapshot verified");
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
