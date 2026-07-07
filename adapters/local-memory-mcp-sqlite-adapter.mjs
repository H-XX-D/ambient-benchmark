#!/usr/bin/env node
// AMBIENT wire-protocol bridge for cunicopia-dev/local-memory-mcp's SQLite floor.
//
// local-memory-mcp offers a SQLite+FAISS MCP server and a PostgreSQL+pgvector
// server. This adapter targets the local SQLite substrate used by the SQLite
// implementation:
//   MCP_DATA_DIR/memory.db
//
// It writes directly to the stable memories table and queries with the same
// text-search fallback used by SQLiteMemoryAPI, with a bounded term fallback so
// natural AMBIENT questions still retrieve relevant rows.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import json
import sqlite3
import sys
import time
from pathlib import Path

payload = json.loads(sys.argv[1])
op = payload["op"]
db_path = Path(payload["db"])

def query_terms(q):
    stop = {
        "a", "an", "and", "are", "before", "can", "did", "does", "for", "from",
        "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or",
        "the", "this", "to", "what", "when", "where", "which", "with",
    }
    terms = []
    for raw in (q or "").lower().split():
        tok = "".join(ch for ch in raw if ch.isalnum() or ch in ("_", "-")).strip("_-")
        if len(tok) < 3 or tok in stop:
            continue
        if tok not in terms:
            terms.append(tok)
        if len(terms) >= 10:
            break
    return terms

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            metadata TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
        CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    """)
    conn.commit()

db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_schema(conn)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        stamp = time.time()
        memory_id = payload.get("id") or f"mem_{int(stamp * 1000)}"
        metadata = payload.get("metadata") or {}
        metadata.update({
            "source": payload.get("source") or metadata.get("source") or "ambient",
            "importance": float(payload.get("importance") or metadata.get("importance") or 0.5),
            "created_at": stamp,
            "updated_at": stamp,
        })
        conn.execute(
            "INSERT INTO memories (id, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (memory_id, fact, json.dumps(metadata), stamp, stamp),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": memory_id, "db": str(db_path), "dataDir": str(db_path.parent)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        rows = conn.execute(
            "SELECT id, content, metadata, created_at, updated_at, 0.0 AS score "
            "FROM memories WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?",
            (f"%{question}%", limit),
        ).fetchall()
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(content) LIKE ?" for _ in terms])
                score_expr = " + ".join(["CASE WHEN lower(content) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
                rows = conn.execute(
                    "SELECT id, content, metadata, created_at, updated_at, "
                    "(" + score_expr + ") AS score "
                    "FROM memories WHERE " + like_where + " "
                    "ORDER BY score DESC, updated_at DESC LIMIT ?",
                    (*[f"%{t}%" for t in terms], *[f"%{t}%" for t in terms], limit),
                ).fetchall()
        support = []
        provenance = []
        for row in rows:
            try:
                metadata = json.loads(row["metadata"] or "{}")
            except Exception:
                metadata = {}
            support.append(row["content"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "local-memory-mcp:memories",
                "metadata": metadata,
                "writtenAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "score": row["score"],
            })
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()
        print(json.dumps({"supported": True, "size": int(row["c"])}))
    else:
        raise SystemExit(f"unsupported op: {op}")
finally:
    conn.close()
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "local-memory-mcp-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8103"));
const PYTHON = arg("python", process.env.AMBIENT_LOCAL_MEMORY_MCP_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_LOCAL_MEMORY_MCP_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-local-memory-mcp-"));
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

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["-c", PY_HELPER, JSON.stringify(payload)], {
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
        } catch {
          return reject(new Error(`local-memory-mcp SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} local-memory-mcp SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    id: `mem_${Date.now()}_${randomUUID().slice(0, 8)}`,
    fact: String(b?.fact ?? ""),
    source: String(b?.source || "ambient"),
  });
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "query",
    db,
    question: String(b?.question ?? ""),
    limit: Number(b?.top_k || 8),
  });
}

async function collection(b) {
  const db = await storeDb(b?.store);
  return runPython({ op: "collection", db });
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
  collection,
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
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${PYTHON}`);
});
