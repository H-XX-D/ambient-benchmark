#!/usr/bin/env node
// AMBIENT wire-protocol bridge for riponcm/projectmem.
//
// This bridge does not vendor projectmem. Install it locally, then run:
//   pip install projectmem
//   npm run adapter:projectmem -- --port 8094
//
// Each AMBIENT store gets an isolated temporary projectmem root. Reset rotates
// that root, so benchmark runs do not mutate user project memory.

import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "projectmem-cli";
const PORT = Number(arg("port", process.env.PORT || "8094"));
const PROJECTMEM_BIN = arg("bin", process.env.AMBIENT_PROJECTMEM_BIN || process.env.PROJECTMEM_BIN || "projectmem");
const BASE_ROOT = arg("root", process.env.AMBIENT_PROJECTMEM_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-projectmem-"));
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

function runProjectmem(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(PROJECTMEM_BIN, args, {
      cwd,
      env: { ...process.env, PROJECTMEM_ROOT: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${PROJECTMEM_BIN} ${args.join(" ")} exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function ensureProject(store) {
  const root = await storeRoot(store);
  if (initializedRoots.has(root)) return root;
  await mkdir(root, { recursive: true });
  if (!existsSync(join(root, ".projectmem", "config.toml"))) {
    await runProjectmem([
      "init",
      "--no-hooks",
      "--no-global",
      "--no-watch",
      "--no-backfill",
      "--no-claude-md",
      "--no-stack-detect",
      "--no-mcp-config",
    ], root);
  }
  initializedRoots.add(root);
  return root;
}

async function writeMemory(b) {
  const fact = String(b?.fact ?? "").trim();
  if (!fact) return { accepted: false, reason: "empty fact" };
  const root = await ensureProject(b?.store);
  const args = ["note", fact];
  if (b?.source) args.push("--at", String(b.source));
  await runProjectmem(args, root);
  return { accepted: true, root };
}

const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "answer", "because", "before",
  "being", "could", "does", "from", "have", "into", "memory", "should",
  "that", "their", "there", "these", "thing", "this", "what", "when", "where",
  "which", "while", "with", "would",
]);

function terms(text) {
  return Array.from(new Set(String(text).toLowerCase().match(/[a-z0-9_./-]{3,}/g) || []))
    .filter((t) => !STOPWORDS.has(t));
}

function scoreEvent(event, queryTerms) {
  const haystack = [
    event.summary,
    event.notes,
    event.location,
    ...(event.files || []),
  ].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += term.length;
  }
  return score;
}

async function readEvents(root) {
  const path = join(root, ".projectmem", "events.jsonl");
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

async function queryMemory(b) {
  const root = await ensureProject(b?.store);
  const queryTerms = terms(b?.question);
  const limit = Number(b?.top_k || 8);
  const events = await readEvents(root);
  const scored = events
    .map((event, i) => ({ event, i, score: scoreEvent(event, queryTerms) }))
    .filter((row) => row.score > 0 || queryTerms.length === 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, limit);
  return {
    support: scored.map(({ event }) => event.summary || event.notes || ""),
    provenance: scored.map(({ event, score }, i) => ({
      id: String(event.id || `projectmem-${i}`),
      origin: "external",
      source: event.type ? `projectmem:${event.type}` : "projectmem",
      writtenAt: event.timestamp,
      score,
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
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${PROJECTMEM_BIN}`);
});
