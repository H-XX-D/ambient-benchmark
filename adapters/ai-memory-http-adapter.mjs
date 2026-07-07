#!/usr/bin/env node
// AMBIENT wire-protocol bridge for alphaonedev/ai-memory-mcp.
//
// This does not vendor or start ai-memory. Run a local daemon separately:
//   ai-memory serve --host 127.0.0.1 --port 9077
//
// Then expose it to AMBIENT:
//   npm run adapter:ai-memory -- --target http://127.0.0.1:9077 --port 8093
//
// The bridge uses per-run namespaces instead of destructive resets. A runner
// reset rotates the namespace prefix, so old memories in the target daemon are
// ignored without requiring admin/delete permissions.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const TARGET = arg("target", process.env.AMBIENT_AI_MEMORY_TARGET || "http://127.0.0.1:9077").replace(/\/$/, "");
const PORT = Number(arg("port", process.env.PORT || "8093"));
const QUERY_MODE = arg("query-mode", process.env.AMBIENT_AI_MEMORY_QUERY_MODE || "search");
const API_KEY = process.env.AI_MEMORY_API_KEY || process.env.AMBIENT_AI_MEMORY_API_KEY || "";
const AGENT_ID = process.env.AMBIENT_AI_MEMORY_AGENT_ID || "ambient:adapter";

let runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const storeRuns = new Map();

function storeNamespace(store = "default") {
  const key = String(store || "default");
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

function rotateStore(store) {
  if (!store || store === "all") {
    runId = `ambient-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    storeRuns.clear();
    return "all";
  }
  const key = String(store);
  storeRuns.set(key, (storeRuns.get(key) || 0) + 1);
  return key;
}

async function targetFetch(path, init = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-Id": AGENT_ID,
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(`${TARGET}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!res.ok) {
    const msg = body?.error || body?.message || text || `${res.status}`;
    throw new Error(`ai-memory ${path} ${res.status}: ${String(msg).slice(0, 220)}`);
  }
  return body;
}

function memoryText(memory) {
  return String(memory?.content || memory?.body || memory?.title || "");
}

function memoryProvenance(memory, i) {
  return {
    id: String(memory?.id || `ai-memory-${i}`),
    origin: "external",
    source: memory?.source || "ai-memory",
    writtenAt: memory?.created_at || memory?.createdAt,
    score: Number(memory?.score ?? 0),
  };
}

async function writeMemory(b) {
  const fact = String(b?.fact ?? "");
  const body = {
    title: fact.slice(0, 80) || "ambient memory",
    content: fact,
    tier: "mid",
    namespace: storeNamespace(b?.store),
    tags: [String(b?.source || "ambient")].filter(Boolean),
    priority: 5,
    confidence: 0.7,
    source: "api",
    kind: "observation",
    metadata: {
      ambient_store: String(b?.store || "default"),
      ambient_source: String(b?.source || "ingest"),
    },
  };
  const r = await targetFetch("/api/v1/memories", { method: "POST", body: JSON.stringify(body) });
  return { id: r.id || r.memory?.id, accepted: true, namespace: body.namespace };
}

async function queryMemory(b) {
  const question = String(b?.question ?? "");
  const namespace = storeNamespace(b?.store);
  const limit = Number(b?.top_k || 8);
  let memories = [];
  if (QUERY_MODE === "recall") {
    const r = await targetFetch("/api/v1/recall", {
      method: "POST",
      body: JSON.stringify({ context: question, namespace, limit }),
    });
    memories = r.memories || r.results || [];
  } else {
    const params = new URLSearchParams({ q: question, namespace, limit: String(limit) });
    const r = await targetFetch(`/api/v1/search?${params.toString()}`, { method: "GET" });
    memories = r.results || r.memories || [];
  }
  const support = memories.map(memoryText).filter(Boolean);
  return {
    support,
    provenance: memories.slice(0, support.length).map(memoryProvenance),
  };
}

const routes = {
  name: async () => ({ name: `ai-memory-${QUERY_MODE}` }),
  reset: async (b) => ({ ok: true, reset: rotateStore(b?.store) }),
  setAutoCapture: async (b) => ({ supported: false, auto: Boolean(b?.enabled) }),
  write: writeMemory,
  query: queryMemory,
  surface: async () => ({ supported: false }),
  dag: async () => ({ supported: false, isDag: null, cycles: [] }),
  collection: async () => ({ supported: false, size: 0 }),
};

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
  console.log(`ai-memory adapter on 127.0.0.1:${PORT} -> ${TARGET} (${QUERY_MODE})`);
});
