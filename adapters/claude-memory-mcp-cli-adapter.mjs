#!/usr/bin/env node
// AMBIENT wire-protocol bridge for WhenMoon-afk/claude-memory-mcp.
//
// This bridge does not vendor claude-memory-mcp. Install it locally, then run:
//   npm install -g @whenmoon-afk/memory-mcp
//   npm run adapter:claude-memory-mcp -- --port 8098
//
// Each AMBIENT store gets an isolated CLAUDE_MEMORY_DB_PATH. Reset rotates that
// path, so benchmark runs do not mutate the user's continuity.db.

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

const NAME = "claude-memory-mcp-cli";
const PORT = Number(arg("port", process.env.PORT || "8098"));
const MEMORY_BIN = arg("bin", process.env.AMBIENT_CLAUDE_MEMORY_BIN || process.env.CLAUDE_MEMORY_BIN || "claude-memory-mcp");
const BASE_ROOT = arg("root", process.env.AMBIENT_CLAUDE_MEMORY_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-claude-memory-"));
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
  return join(dir, "continuity.db");
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

function runMemory(args, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(MEMORY_BIN, args, {
      env: {
        ...process.env,
        CLAUDE_MEMORY_DB_PATH: dbPath,
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
      reject(new Error(`${MEMORY_BIN} ${args.join(" ")} exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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
  const db = await storeDb(b?.store);
  const store = safeStoreName(b?.store);
  const { stdout } = await runMemory([
    "save",
    "--type",
    "snapshot",
    "--title",
    titleFor(fact, b?.source),
    "--summary",
    fact,
    "--project",
    store,
    "--theme",
    "ambient",
    "--entity",
    String(b?.source || "ingest"),
  ], db);
  const match = stdout.match(/Saved\s+([A-Za-z0-9_-]+)/);
  return { accepted: true, id: match?.[1], db };
}

function parseSearch(stdout, limit) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^No continuity artifacts found\./i.test(trimmed)) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+?)\s+::\s+(.+?)(?:\s+\[(.+)\])?$/);
    if (match) {
      rows.push({
        id: match[1],
        type: match[2],
        label: match[3],
        preview: match[4],
        project: match[5],
      });
    } else {
      rows.push({ id: `claude-memory-${rows.length}`, type: "artifact", label: "", preview: trimmed });
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  const limit = Number(b?.top_k || 8);
  const question = String(b?.question ?? "");
  const { stdout } = await runMemory(["search", question], db);
  const rows = parseSearch(stdout, limit);
  return {
    support: rows.map((row) => [row.label, row.preview].filter(Boolean).join(" :: ")),
    provenance: rows.map((row, i) => ({
      id: String(row.id || `claude-memory-${i}`),
      origin: "external",
      source: row.type ? `claude-memory-mcp:${row.type}` : "claude-memory-mcp",
      project: row.project,
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
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${MEMORY_BIN}`);
});
