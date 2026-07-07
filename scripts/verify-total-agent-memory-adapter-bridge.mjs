#!/usr/bin/env node
// Smoke for adapters/total-agent-memory-sqlite-adapter.mjs.
//
// Verifies /write, /query, reset isolation, and compatibility with
// total-agent-memory's tam-lookup CLI when a source checkout is available.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TAM_PATH = "/tmp/ambient-total-agent-memory";

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

function runPython(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${args.join(" ")} exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function main() {
  const roots = await mkdtemp(join(tmpdir(), "ambient-tam-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/total-agent-memory-sqlite-adapter.mjs",
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
    if (name.name !== "total-agent-memory-sqlite") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "total-agent-memory stores local SQLite knowledge rows searchable by tam-lookup FTS",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) throw new Error(`TAM memory.db was not created: ${JSON.stringify(write)}`);

    const hit = await post(base, "/query", { store: "custom", question: "tam-lookup FTS", top_k: 3 });
    if (!hit.support.some((s) => s.includes("total-agent-memory"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    const collection = await post(base, "/collection", { store: "custom" });
    if (!collection.supported || collection.size !== 1) {
      throw new Error(`unexpected collection result: ${JSON.stringify(collection)}`);
    }

    const tamPath = process.env.AMBIENT_TAM_TEST_PACKAGE_PATH || DEFAULT_TAM_PATH;
    const lookup = join(tamPath, "total_agent_memory", "lookup.py");
    if (existsSync(lookup)) {
      const { stdout } = await runPython([lookup, "--db", write.db, "--json", "--limit", "3", "tam-lookup FTS"], ROOT);
      const rows = JSON.parse(stdout || "[]");
      if (!rows.some((r) => String(r.content || "").includes("total-agent-memory"))) {
        throw new Error(`tam-lookup did not find adapter row: ${stdout}`);
      }
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "tam-lookup FTS", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate TAM memory.db: ${JSON.stringify(miss)}`);
    }
    console.log("total-agent-memory bridge smoke: write/query/reset isolated TAM-compatible SQLite DB verified");
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
