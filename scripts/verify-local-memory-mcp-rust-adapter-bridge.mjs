#!/usr/bin/env node
// Smoke for adapters/local-memory-mcp-rust-sqlite-adapter.mjs.
//
// Verifies AMBIENT /write, /query, /collection, reset isolation, and a
// chriswessells/local-memory-mcp-compatible memories + memory_fts (FTS5) SQLite
// schema, confirmed against src/db.rs (migrate_v1) upstream.

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
  const roots = await mkdtemp(join(tmpdir(), "ambient-local-memory-mcp-rust-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/local-memory-mcp-rust-sqlite-adapter.mjs",
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
    if (name.name !== "local-memory-mcp-rust") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "local-memory-mcp-rust stores memories in a SQLite memories table indexed by an FTS5 virtual table",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`local-memory-mcp-rust memories db was not created: ${JSON.stringify(write)}`);
    }

    // Query terms are a scattered subset of the fact, not a contiguous phrase, so
    // the adapter's first-pass LIKE substring match must miss and fall through to
    // the FTS5 MATCH path, genuinely exercising the memory_fts index.
    const hit = await post(base, "/query", { store: "custom", question: "memories table FTS5 virtual index", top_k: 3 });
    if (!hit.support.some((s) => s.includes("local-memory-mcp-rust"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.every((p) => p.origin === "external" && p.source === "local-memory-mcp-rust:memories")) {
      throw new Error(`unexpected provenance: ${JSON.stringify(hit.provenance)}`);
    }

    const collection = await post(base, "/collection", { store: "custom" });
    if (!collection.supported || collection.size !== 1) {
      throw new Error(`unexpected collection result: ${JSON.stringify(collection)}`);
    }

    const { stdout } = await runPython(
      `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
row = conn.execute("""
  SELECT id, content, actor_id, namespace, strategy, is_valid
  FROM memories
  LIMIT 1
""").fetchone()
fts_hit = conn.execute(
    "SELECT count(*) FROM memory_fts WHERE memory_fts MATCH 'fts5'"
).fetchone()[0]
print(json.dumps({"tables": sorted(tables), "row": row, "fts_hit": fts_hit}))
      `,
      [write.db],
    );
    const schema = JSON.parse(stdout);
    if (!schema.tables.includes("memories")) throw new Error(`missing memories table: ${stdout}`);
    if (!schema.tables.includes("memory_fts")) throw new Error(`missing memory_fts FTS5 table: ${stdout}`);
    if (!schema.row || !String(schema.row[1]).includes("local-memory-mcp-rust")) {
      throw new Error(`memory row probe failed: ${stdout}`);
    }
    if (schema.row[5] !== 1) throw new Error(`expected is_valid=1 on fresh write: ${stdout}`);
    if (!schema.fts_hit) {
      throw new Error(`memory_fts index probe failed, insert trigger did not populate FTS5 index: ${stdout}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "memories table FTS5 virtual index", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate local-memory-mcp-rust DB: ${JSON.stringify(miss)}`);
    }
    const missCollection = await post(base, "/collection", { store: "custom" });
    if (!missCollection.supported || missCollection.size !== 0) {
      throw new Error(`reset did not isolate local-memory-mcp-rust collection count: ${JSON.stringify(missCollection)}`);
    }
    console.log("local-memory-mcp-rust bridge smoke: write/query/reset isolated SQLite+FTS5 memories DB verified");
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
