#!/usr/bin/env node
// Smoke for adapters/graphiti-python-adapter.mjs.
//
// Bridges getzep/graphiti (async, Neo4j plus LLM backed) into the AMBIENT wire
// protocol, then verifies /write, /query, and reset group_id isolation.
//
// graphiti needs a running Neo4j instance and a live LLM for entity and edge
// extraction, so this smoke is gated: it SKIPs unless graphiti_core is importable
// AND NEO4J_URI is set AND OPENAI_API_KEY is set. Timeouts are generous because
// each write drives a full LLM extraction pass plus graph writes.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.AMBIENT_GRAPHITI_PYTHON || process.env.PYTHON || "python3";
const PACKAGE_PATH = process.env.AMBIENT_GRAPHITI_TEST_PACKAGE_PATH || "";
// add_episode() calls the LLM per write and search() reranks with the LLM too,
// so allow long request budgets.
const REQUEST_TIMEOUT_MS = Number(process.env.AMBIENT_GRAPHITI_TEST_TIMEOUT_MS || 600000);

function withPackagePath(env) {
  const next = { ...env };
  if (PACKAGE_PATH) {
    next.PYTHONPATH = next.PYTHONPATH ? `${PACKAGE_PATH}:${next.PYTHONPATH}` : PACKAGE_PATH;
  }
  return next;
}

function graphitiImportable() {
  const probe = spawnSync(PYTHON, ["-c", "import graphiti_core"], {
    env: withPackagePath(process.env),
    stdio: "ignore",
  });
  return probe.status === 0;
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
  if (!graphitiImportable() || !process.env.NEO4J_URI || !process.env.OPENAI_API_KEY) {
    console.log("SKIP: graphiti not installed or Neo4j/LLM not configured (set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, OPENAI_API_KEY)");
    process.exit(0);
  }

  const roots = await mkdtemp(join(tmpdir(), "ambient-graphiti-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const args = ["adapters/graphiti-python-adapter.mjs", "--root", roots, "--port", String(port)];
  if (PACKAGE_PATH) args.push("--package-path", PACKAGE_PATH);
  const bridge = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  try {
    await waitForAdapter(port);
    const base = `http://127.0.0.1:${port}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "graphiti") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "graphiti builds a temporal knowledge graph in Neo4j from ingested episodes",
      source: "smoke",
    });
    if (!write.accepted || !write.id) {
      throw new Error(`graphiti write was not accepted: ${JSON.stringify(write)}`);
    }

    const hit = await post(base, "/query", {
      store: "custom",
      question: "What does graphiti build in Neo4j from ingested episodes?",
      top_k: 5,
    });
    if (!Array.isArray(hit.support) || !hit.support.some((s) => /graphiti|knowledge graph/i.test(s))) {
      throw new Error(`expected graphiti support missing: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.some((p) => p.origin === "external")) {
      throw new Error(`expected external provenance missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", {
      store: "custom",
      question: "graphiti temporal knowledge graph episodes",
      top_k: 5,
    });
    if (miss.support.length) {
      throw new Error(`reset did not isolate group_id: ${JSON.stringify(miss)}`);
    }
    console.log("graphiti bridge smoke: write/query/reset isolated group_id verified");
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
