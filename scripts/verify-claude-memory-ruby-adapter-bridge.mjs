#!/usr/bin/env node
// Smoke for adapters/claude-memory-ruby-sqlite-adapter.mjs.
//
// Verifies AMBIENT /write, /query, /collection, reset isolation, and a
// codenamev/claude_memory-compatible local SQLite fact/observation schema
// (entities, facts, observations, per db/migrations/001, 002, 009, 019, and
// 020 in https://github.com/codenamev/claude_memory). No skip gate: this
// needs only python3 (with the sqlite3 stdlib module) and node.

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
  const roots = await mkdtemp(join(tmpdir(), "ambient-claude-memory-ruby-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/claude-memory-ruby-sqlite-adapter.mjs",
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
    if (name.name !== "claude-memory-ruby") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "claude-memory-ruby persists Claude Code hook and MCP tool observations in a local SQLite memory.sqlite3 store",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`claude-memory-ruby memory.sqlite3 was not created: ${JSON.stringify(write)}`);
    }

    const hit = await post(base, "/query", { store: "custom", question: "hook and MCP tool observations SQLite memory.sqlite3", top_k: 3 });
    if (!hit.support.some((s) => s.includes("claude-memory-ruby"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.some((p) => p.origin === "external" && p.source === "claude-memory-ruby:observations")) {
      throw new Error(`expected external observations provenance missing: ${JSON.stringify(hit)}`);
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
  SELECT id, body, kind, status
  FROM observations
  LIMIT 1
""").fetchone()
print(json.dumps({"tables": sorted(tables), "row": row}))
      `,
      [write.db],
    );
    const schema = JSON.parse(stdout);
    for (const table of ["entities", "facts", "observations"]) {
      if (!schema.tables.includes(table)) throw new Error(`missing claude_memory table ${table}: ${stdout}`);
    }
    if (!schema.row || !String(schema.row[1]).includes("claude-memory-ruby")) {
      throw new Error(`observation row probe failed: ${stdout}`);
    }
    if (schema.row[3] !== "active") {
      throw new Error(`observation row was not active: ${stdout}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "hook and MCP tool observations SQLite memory.sqlite3", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate claude-memory-ruby DB: ${JSON.stringify(miss)}`);
    }
    console.log("claude-memory-ruby bridge smoke: write/query/reset isolated SQLite fact/observation DB verified");
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
