#!/usr/bin/env node
// AMBIENT wire-protocol bridge for Gentleman-Programming/engram.
//
// This bridge does not vendor engram. Install it locally, then run:
//   brew install gentleman-programming/tap/engram
//   npm run adapter:engram -- --port 8099
//
// Each AMBIENT store gets an isolated ENGRAM_DATA_DIR. Reset rotates that
// directory, so benchmark runs do not mutate the user's ~/.engram/engram.db.

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

const NAME = "engram-cli";
const PORT = Number(arg("port", process.env.PORT || "8099"));
const ENGRAM_BIN = arg("bin", process.env.AMBIENT_ENGRAM_BIN || process.env.ENGRAM_BIN || "engram");
const BASE_ROOT = arg("root", process.env.AMBIENT_ENGRAM_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-engram-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeDir(store = "default") {
  const dir = join(await baseRoot(), storeKey(store));
  await mkdir(dir, { recursive: true });
  return dir;
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

function runEngram(args, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGRAM_BIN, args, {
      env: {
        ...process.env,
        ENGRAM_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${ENGRAM_BIN} ${args.join(" ")} exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

function titleFor(fact, source) {
  const prefix = source ? `${source}: ` : "AMBIENT: ";
  return (prefix + fact.replace(/\s+/g, " ").trim()).slice(0, 120);
}

async function writeMemory(b) {
  const fact = String(b?.fact ?? "").trim();
  if (!fact) return { accepted: false, reason: "empty fact" };
  const dataDir = await storeDir(b?.store);
  const store = safeStoreName(b?.store);
  const { stdout } = await runEngram([
    "save",
    titleFor(fact, b?.source),
    fact,
    "--type",
    "note",
    "--project",
    store,
    "--scope",
    "project",
    "--topic",
    `ambient/${String(b?.source || "ingest").replace(/[^A-Za-z0-9_.-]/g, "_")}`,
  ], dataDir);
  const match = stdout.match(/Memory saved:\s+#(\d+)/);
  return { accepted: true, id: match?.[1], dataDir };
}

const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "answer", "because", "before",
  "being", "could", "does", "from", "have", "into", "memory", "should",
  "that", "their", "there", "these", "thing", "this", "what", "when", "where",
  "which", "while", "with", "would",
]);

function queryTerms(text) {
  return Array.from(new Set(String(text).toLowerCase().match(/[a-z0-9_./-]{3,}/g) || []))
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 8);
}

function parseSearch(stdout, limit) {
  const lines = String(stdout || "").split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.trim() || "";
    const match = header.match(/^\[(\d+)\]\s+#(\d+)\s+\(([^)]+)\)\s+.\s+(.+)$/);
    if (!match) continue;
    const content = (lines[i + 1] || "").trim();
    const meta = (lines[i + 2] || "").trim();
    const project = meta.match(/\|\s*project:\s*([^|]+)/)?.[1]?.trim();
    const scope = meta.match(/\|\s*scope:\s*([^|]+)/)?.[1]?.trim();
    rows.push({
      rank: Number(match[1]),
      id: match[2],
      type: match[3],
      title: match[4],
      content,
      project,
      scope,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

async function searchOnce(dataDir, store, question, limit) {
  const { stdout } = await runEngram([
    "search",
    question,
    "--project",
    store,
    "--scope",
    "project",
    "--limit",
    String(limit),
  ], dataDir);
  return parseSearch(stdout, limit);
}

async function queryMemory(b) {
  const dataDir = await storeDir(b?.store);
  const store = safeStoreName(b?.store);
  const limit = Number(b?.top_k || 8);
  const question = String(b?.question ?? "");
  const byId = new Map();
  for (const row of await searchOnce(dataDir, store, question, limit)) {
    byId.set(row.id, row);
  }
  if (byId.size === 0) {
    for (const term of queryTerms(question)) {
      for (const row of await searchOnce(dataDir, store, term, limit)) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      if (byId.size >= limit) break;
    }
  }
  const rows = Array.from(byId.values()).slice(0, limit);
  return {
    support: rows.map((row) => [row.title, row.content].filter(Boolean).join(" :: ")),
    provenance: rows.map((row, i) => ({
      id: String(row.id || `engram-${i}`),
      origin: "external",
      source: row.type ? `engram:${row.type}` : "engram",
      project: row.project || store,
      score: rows.length - i,
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
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${ENGRAM_BIN}`);
});
