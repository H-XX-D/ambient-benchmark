#!/usr/bin/env node
// AMBIENT wire-protocol bridge for LangMem (github.com/langchain-ai/langmem).
//
// This bridges the LangMem/LangGraph memory-store floor: a LangGraph BaseStore
// (InMemoryStore) with a semantic embeddings index, which is exactly what
// LangMem's managers and tools (create_manage_memory_tool, create_search_memory_tool,
// create_memory_store_manager) sit on top of. The full create_memory_store_manager
// path (LLM-based extraction and consolidation) is a heavier follow-up; this adapter
// exercises the store floor: store.put(namespace, key, {"content": fact}) plus a
// semantic store.search(namespace, query=..., limit=...).
//
// Install the Python deps locally, then run:
//   pip install langmem langgraph langchain
//   npm run adapter:langmem -- --port 8113
//
// The store needs an embeddings backend. Either export OPENAI_API_KEY (default
// embedder openai:text-embedding-3-small, 1536 dims) or point LANGMEM_EMBEDDER at a
// local model, e.g. LANGMEM_EMBEDDER=ollama:nomic-embed-text (also set
// LANGMEM_EMBED_DIMS to match any non-1536 embedder).
//
// Persistence note: LangGraph's InMemoryStore lives only for one process, and this
// bridge spawns a fresh `python3 -c` per op, so an in-memory store would forget every
// write before the next query. To make write-then-query durable across those separate
// invocations, each op reloads the store's memories from a per-store JSON snapshot on
// disk and re-puts them (which re-embeds them, rebuilding the semantic index); writes
// append to that snapshot. Reset rotates the per-store dir, so runs never mutate a
// prior run's snapshot.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import json
import os
import sys
import uuid
from datetime import datetime, timezone

from langgraph.store.memory import InMemoryStore

payload = json.loads(sys.argv[1])
op = payload["op"]
db_path = payload["db"]
scope = payload.get("scope") or "ambient"

# All memories for this AMBIENT store live under one namespace tuple, matching
# LangMem's own ("memories", ...) scoping convention.
namespace = (scope, "memories")


def build_store():
    # Resolve the embeddings backend the semantic index vectorizes with.
    # LANGMEM_EMBEDDER picks the model: "openai:text-embedding-3-small" needs
    # OPENAI_API_KEY, or a local backend like "ollama:nomic-embed-text".
    spec = os.environ.get("LANGMEM_EMBEDDER") or "openai:text-embedding-3-small"
    dims = int(os.environ.get("LANGMEM_EMBED_DIMS") or "1536")
    try:
        # Preferred: build an Embeddings object up front (LangMem's own path).
        from langchain.embeddings import init_embeddings
        embed = init_embeddings(spec)
    except Exception:
        # Fallback: hand the provider:model string to the store, which resolves it
        # internally. InMemoryStore's index config accepts either form.
        embed = spec
    return InMemoryStore(index={"dims": dims, "embed": embed, "fields": ["content"]})


def load_records(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, ValueError):
        return []
    if isinstance(data, list):
        return data
    return data.get("records") or []


def save_records(path, records):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"records": records}, fh)
    os.replace(tmp, path)


# Rebuild the semantic index from the durable snapshot: re-put every stored memory
# so InMemoryStore re-embeds it. This is how a write from an earlier python
# invocation becomes searchable in this one.
records = load_records(db_path)
store = build_store()
for rec in records:
    key = rec.get("id")
    content = rec.get("content")
    if not key or not content:
        continue
    store.put(namespace, key, {"content": content, "writtenAt": rec.get("writtenAt")})

if op == "write":
    fact = (payload.get("fact") or "").strip()
    if not fact:
        print(json.dumps({"accepted": False, "reason": "empty fact"}))
        sys.exit(0)
    key = uuid.uuid4().hex
    written_at = datetime.now(timezone.utc).isoformat()
    store.put(namespace, key, {"content": fact, "writtenAt": written_at})
    records.append({"id": key, "content": fact, "writtenAt": written_at})
    save_records(db_path, records)
    print(json.dumps({"accepted": True, "id": key, "db": db_path}))
elif op == "query":
    question = payload.get("question") or ""
    limit = int(payload.get("limit") or 8)
    items = store.search(namespace, query=question, limit=limit)
    support = []
    provenance = []
    for item in items:
        value = item.value or {}
        content = value.get("content") or ""
        if not content:
            continue
        support.append(content)
        provenance.append({
            "id": item.key,
            "origin": "external",
            "source": "langmem:memory",
            "writtenAt": value.get("writtenAt"),
            "score": item.score if item.score is not None else 0,
        })
    print(json.dumps({"support": support, "provenance": provenance}))
else:
    raise SystemExit(f"unsupported op: {op}")
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "langmem";
const PORT = Number(arg("port", process.env.PORT || "8113"));
const PYTHON = arg("python", process.env.AMBIENT_LANGMEM_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_LANGMEM_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_LANGMEM_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-langmem-"));
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
  return join(dir, "store.json");
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

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (PACKAGE_PATH) {
      env.PYTHONPATH = env.PYTHONPATH ? `${PACKAGE_PATH}:${env.PYTHONPATH}` : PACKAGE_PATH;
    }
    const child = spawn(PYTHON, ["-c", PY_HELPER, JSON.stringify(payload)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        try {
          return resolve(JSON.parse(stdout || "{}"));
        } catch (e) {
          return reject(new Error(`langmem returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} langmem helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    scope: safeStoreName(b?.store),
    fact: String(b?.fact ?? ""),
    entity: "__ambient_memory__",
  });
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "query",
    db,
    scope: safeStoreName(b?.store),
    question: String(b?.question ?? ""),
    limit: Number(b?.top_k || 8),
  });
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
  const pkg = PACKAGE_PATH ? ` package=${PACKAGE_PATH}` : "";
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${PYTHON}${pkg}`);
});
