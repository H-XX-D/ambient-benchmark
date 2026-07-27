#!/usr/bin/env node
// AMBIENT wire-protocol bridge for TerminallyLazy/Tree_Ring_Memory.
//
// This bridge does not vendor Tree Ring. Install the CLI locally, then run:
//   cargo install --path /path/to/Tree_Ring_Memory/crates/tree-ring-memory-cli
//   npm run adapter:tree-ring -- --port 8107
//
// Each AMBIENT store gets an isolated Tree Ring root. Reset rotates that root,
// so benchmark runs do not mutate user memory stores.

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

const NAME = "tree-ring-cli";
const PORT = Number(arg("port", process.env.PORT || "8107"));
const TREE_RING_BIN = arg("bin", process.env.AMBIENT_TREE_RING_BIN || process.env.TREE_RING_BIN || "tree-ring");
const BASE_ROOT = arg("root", process.env.AMBIENT_TREE_RING_ROOT || "");

let runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const storeRuns = new Map();
const initializedRoots = new Set();
let allocatedBaseRoot = "";

function safeStoreName(store = "default") {
  return String(store || "default").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";
}

async function baseRoot() {
  if (BASE_ROOT) {
    await mkdir(BASE_ROOT, { recursive: true });
    return BASE_ROOT;
  }
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-tree-ring-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeRoot(store = "default") {
  return join(await baseRoot(), storeKey(store));
}

function rotateStore(store) {
  if (!store || store === "all") {
    runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    storeRuns.clear();
    initializedRoots.clear();
    return "all";
  }
  const key = safeStoreName(store);
  storeRuns.set(key, (storeRuns.get(key) || 0) + 1);
  return key;
}

function runTreeRing(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(TREE_RING_BIN, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = String(stderr || stdout || "").trim() || `${TREE_RING_BIN} ${args.join(" ")} exited ${code}`;
      reject(new Error(detail.slice(0, 800)));
    });
  });
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    const arrayStart = text.indexOf("[");
    const start = [objectStart, arrayStart].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`tree-ring returned non-JSON output: ${text.slice(0, 240)}`);
  }
}

async function ensureTreeRing(store) {
  const root = await storeRoot(store);
  if (initializedRoots.has(root)) return root;
  await mkdir(root, { recursive: true });
  await runTreeRing(["init", "--root", root, "--json"]);
  initializedRoots.add(root);
  return root;
}

function projectFor(store) {
  return `ambient-${safeStoreName(store)}`;
}

async function writeMemory(b) {
  const fact = String(b?.fact ?? "").trim();
  if (!fact) return { accepted: false, reason: "empty fact" };
  const root = await ensureTreeRing(b?.store);
  const sourceTag = `source:${safeStoreName(b?.source || "ingest")}`;
  let stdout = "";
  try {
    ({ stdout } = await runTreeRing([
      "remember",
      "--root",
      root,
      "--json",
      "--event-type",
      "observation",
      "--scope",
      "eval",
      "--project",
      projectFor(b?.store),
      "--tag",
      "ambient",
      "--tag",
      sourceTag,
      fact,
    ]));
  } catch (e) {
    const reason = String(e?.message || e);
    if (/blocked by policy/i.test(reason)) return { accepted: false, reason, root };
    throw e;
  }
  const event = parseJsonOutput(stdout);
  return { accepted: true, id: event?.id, root };
}

async function queryMemory(b) {
  const root = await ensureTreeRing(b?.store);
  const limit = Number(b?.top_k || 8);
  const question = String(b?.question ?? "");
  const { stdout } = await runTreeRing([
    "recall",
    "--root",
    root,
    "--json",
    "--project",
    projectFor(b?.store),
    "--limit",
    String(limit),
    "--include-sensitive",
    question,
  ]);
  const rows = parseJsonOutput(stdout);
  const memories = Array.isArray(rows) ? rows : [];
  return {
    support: memories
      .map((row) => String(row?.memory?.summary || row?.memory?.details || ""))
      .filter(Boolean),
    provenance: memories.map((row, i) => {
      const memory = row?.memory || {};
      return {
        id: String(memory.id || `tree-ring-${i}`),
        origin: "external",
        source: memory.event_type ? `tree-ring:${memory.event_type}` : "tree-ring",
        writtenAt: memory.created_at,
        score: Number(row?.score ?? 0),
      };
    }),
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
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${TREE_RING_BIN}`);
});
