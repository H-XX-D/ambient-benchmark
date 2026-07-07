#!/usr/bin/env node
// Smoke for adapters/agent-memory-mcp-sqlite-adapter.mjs.
//
// Verifies AMBIENT /write, /query, /collection, reset isolation, and a
// mikeylong/agent-memory-mcp-compatible AGENT_MEMORY_HOME memory.db schema.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function runPython(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", ["-c", code, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`python schema probe exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function main() {
  const roots = await mkdtemp(join(tmpdir(), "ambient-agent-memory-mcp-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/agent-memory-mcp-sqlite-adapter.mjs",
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
    if (name.name !== "agent-memory-mcp-sqlite") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "agent-memory-mcp stores scoped Codex memories in AGENT_MEMORY_HOME memory.db with lexical FTS recall",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`agent-memory-mcp memory.db was not created: ${JSON.stringify(write)}`);
    }

    const hit = await post(base, "/query", { store: "custom", question: "AGENT_MEMORY_HOME memory.db lexical FTS", top_k: 3 });
    if (!hit.support.some((s) => s.includes("agent-memory-mcp"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    const collection = await post(base, "/collection", { store: "custom" });
    if (!collection.supported || collection.size !== 1) {
      throw new Error(`unexpected collection result: ${JSON.stringify(collection)}`);
    }

    const { stdout } = await runPython(
      `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')")}
row = conn.execute("SELECT scope_type, scope_id, content, tags_json, source_agent FROM memories LIMIT 1").fetchone()
fts = conn.execute("SELECT m.content FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? LIMIT 1", ('"lexical"',)).fetchone()
migrations = [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
print(json.dumps({"tables": sorted(tables), "row": row, "fts": fts, "migrations": migrations}))
      `,
      [write.db],
    );
    const schema = JSON.parse(stdout);
    for (const table of ["memories", "memories_fts", "idempotency_keys", "memory_embedding_chunks", "schema_migrations"]) {
      if (!schema.tables.includes(table)) throw new Error(`missing compatible table ${table}: ${stdout}`);
    }
    if (!schema.row || schema.row[0] !== "project" || schema.row[1] !== "custom" || !String(schema.row[2]).includes("agent-memory-mcp")) {
      throw new Error(`memory row probe failed: ${stdout}`);
    }
    if (!schema.fts || !String(schema.fts[0]).includes("agent-memory-mcp")) {
      throw new Error(`FTS probe failed: ${stdout}`);
    }
    for (const version of [1, 2, 3, 4]) {
      if (!schema.migrations.includes(version)) throw new Error(`migration marker ${version} missing: ${stdout}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "AGENT_MEMORY_HOME memory.db lexical FTS", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate agent-memory-mcp DB: ${JSON.stringify(miss)}`);
    }
    console.log("agent-memory-mcp bridge smoke: write/query/reset isolated AGENT_MEMORY_HOME memory.db verified");
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

