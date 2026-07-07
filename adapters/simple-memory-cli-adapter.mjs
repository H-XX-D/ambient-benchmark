#!/usr/bin/env node
// AMBIENT wire-protocol bridge for chrisribe/simple-memory-mcp.
//
// This bridge does not vendor simple-memory-mcp. Install it locally, then run:
//   npm install -g simple-memory-mcp
//   npm run adapter:simple-memory -- --port 8095
//
// Each AMBIENT store gets an isolated MEMORY_DB path. Reset rotates that path,
// so benchmark runs do not mutate the user's ~/.simple-memory/memory.db.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "simple-memory-cli";
const PORT = Number(arg("port", process.env.PORT || "8095"));
const SIMPLE_MEMORY_BIN = arg("bin", process.env.AMBIENT_SIMPLE_MEMORY_BIN || process.env.SIMPLE_MEMORY_BIN || "simple-memory");
const BASE_ROOT = arg("root", process.env.AMBIENT_SIMPLE_MEMORY_ROOT || "");

let runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const storeRuns = new Map();
let allocatedBaseRoot = "";

function safeStoreName(store = "default") {
  return String(store || "default").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";
}

async function baseRoot() {
  if (BASE_ROOT) {
    await mkdir(BASE_ROOT, { recursive: true });
    return BASE_ROOT;
  }
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-simple-memory-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeDb(store = "default") {
  const dir = join(await baseRoot(), storeKey(store));
  await mkdir(dir, { recursive: true });
  return join(dir, "memory.db");
}

function rotateStore(store) {
  if (!store || store === "all") {
    runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    storeRuns.clear();
    return "all";
  }
  const key = safeStoreName(store);
  storeRuns.set(key, (storeRuns.get(key) || 0) + 1);
  return key;
}

function runSimpleMemory(args, memoryDb) {
  return new Promise((resolve, reject) => {
    const child = spawn(SIMPLE_MEMORY_BIN, args, {
      env: { ...process.env, MEMORY_DB: memoryDb },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${SIMPLE_MEMORY_BIN} ${args.join(" ")} exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`simple-memory returned non-JSON output: ${text.slice(0, 240)}`);
  }
}

async function writeMemory(b) {
  const fact = String(b?.fact ?? "").trim();
  if (!fact) return { accepted: false, reason: "empty fact" };
  const db = await storeDb(b?.store);
  const tags = ["ambient", safeStoreName(b?.store), String(b?.source || "ingest")]
    .filter(Boolean)
    .join(",");
  const { stdout } = await runSimpleMemory(["store", "--content", fact, "--tags", tags], db);
  const data = parseJsonOutput(stdout);
  const result = data?.data?.store || data?.store || {};
  if (result.success === false) throw new Error(result.error || "simple-memory store failed");
  return { accepted: true, id: result.hash, db };
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  const limit = Number(b?.top_k || 8);
  const question = String(b?.question ?? "");
  const { stdout } = await runSimpleMemory(["search", "--query", question, "--limit", String(limit)], db);
  const data = parseJsonOutput(stdout);
  const memories = data?.data?.memories || data?.memories || [];
  return {
    support: memories.map((m) => String(m?.content || m?.preview || m?.title || "")).filter(Boolean),
    provenance: memories.map((m, i) => ({
      id: String(m?.hash || `simple-memory-${i}`),
      origin: "external",
      source: "simple-memory",
      writtenAt: m?.createdAt || m?.created_at,
      score: Number(m?.relevance ?? 0),
    })),
  };
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res, body, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes = {
  name: async () => ({ name: NAME }),
  reset: async (b) => ({ ok: true, reset: rotateStore(b?.store) }),
  setAutoCapture: async (b) => ({ supported: false, auto: Boolean(b?.enabled) }),
  write: writeMemory,
  query: queryMemory,
  surface: async () => ({ supported: false }),
  dag: async () => ({ supported: false, isDag: null, cycles: [] }),
  collection: async () => ({ supported: false, size: 0 }),
};

const server = createServer(async (req, res) => {
  const path = (req.url || "").replace(/^\//, "").split("?")[0];
  if (req.method === "GET" && path === "name") return send(res, await routes.name());
  if (req.method !== "POST" || !routes[path]) return send(res, { error: "not found" }, 404);
  try {
    return send(res, await routes[path](await readBody(req)));
  } catch (e) {
    return send(res, { error: String(e?.message || e) }, 502);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${SIMPLE_MEMORY_BIN}`);
});
