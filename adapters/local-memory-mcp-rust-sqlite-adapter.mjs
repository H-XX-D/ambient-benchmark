#!/usr/bin/env node
// AMBIENT wire-protocol bridge for chriswessells/local-memory-mcp's SQLite floor.
//
// Upstream is a one-binary Rust MCP memory server (rmcp) providing short and long
// term memory, a knowledge graph, namespaces, and session/event tracking on top of
// SQLite, inspired by Amazon Bedrock AgentCore Memory. It embeds SQLite with FTS5
// for full-text search and sqlite-vec for vector similarity search.
//
// Schema confirmed directly from src/db.rs (fn migrate_v1, SCHEMA_VERSION = 1) at
// https://github.com/chriswessells/local-memory-mcp, not invented:
//   memories(memory_rowid, id, actor_id, namespace, strategy, content, metadata,
//            source_session_id, is_valid, superseded_by, created_at, updated_at)
//   memory_fts USING fts5(content, content=memories, content_rowid=memory_rowid)
//     kept in sync by the memory_fts_insert / memory_fts_delete / memory_fts_update
//     triggers defined on memories in the same migration.
// Upstream also defines events, knowledge_edges, namespaces, checkpoints, branches,
// and a memory_vec sqlite-vec virtual table (vec0, float[384] embeddings), all OUT
// OF SCOPE here. This adapter targets only the local SQLite/FTS5 lexical memory
// floor, so AMBIENT gets deterministic write/query/reset coverage against a real
// memories + memory_fts pair without compiling or running the Rust binary; vector
// search over memory_vec is a heavier follow-up.
//
// The per-store db filename mirrors upstream's StoreManager convention in
// src/store.rs (base_dir.join(format!("{name}.db"))): one "<store>.db" file per
// store name, isolated per AMBIENT run/reset under its own directory.

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
import uuid
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
            memory_rowid INTEGER PRIMARY KEY,
            id TEXT UNIQUE NOT NULL,
            actor_id TEXT NOT NULL,
            namespace TEXT DEFAULT 'default',
            strategy TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            source_session_id TEXT,
            is_valid INTEGER DEFAULT 1,
            superseded_by TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_actor ON memories(actor_id, namespace, is_valid);
        CREATE INDEX IF NOT EXISTS idx_memories_strategy ON memories(strategy, is_valid);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content,
            content=memories,
            content_rowid=memory_rowid
        );

        CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memories BEGIN
            INSERT INTO memory_fts(rowid, content) VALUES (new.memory_rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content)
                VALUES ('delete', old.memory_rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF content ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content)
                VALUES ('delete', old.memory_rowid, old.content);
            INSERT INTO memory_fts(rowid, content) VALUES (new.memory_rowid, new.content);
        END;
    """)
    conn.commit()

db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    ensure_schema(conn)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        mem_id = payload.get("id") or ""
        if not mem_id:
            mem_id = "ambient_" + str(uuid.uuid4())
        actor_id = payload.get("actorId") or "ambient"
        namespace = payload.get("namespace") or "default"
        strategy = payload.get("strategy") or "ambient"
        source = payload.get("source") or "ambient"
        metadata = json.dumps({"source": source, "created_at": time.time()})
        conn.execute(
            """
            INSERT INTO memories (id, actor_id, namespace, strategy, content, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (mem_id, actor_id, namespace, strategy, fact, metadata),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": mem_id, "db": str(db_path)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        lower = f"%{question.lower()}%"
        rows = conn.execute(
            """
            SELECT id, content, memory_rowid
            FROM memories
            WHERE is_valid = 1 AND lower(content) LIKE ?
            ORDER BY memory_rowid DESC
            LIMIT ?
            """,
            (lower, limit),
        ).fetchall()
        if not rows:
            terms = query_terms(question)
            if terms:
                match_expr = " OR ".join(terms)
                try:
                    match_rows = conn.execute(
                        """
                        SELECT rowid FROM memory_fts
                        WHERE memory_fts MATCH ?
                        ORDER BY rank
                        LIMIT ?
                        """,
                        (match_expr, limit),
                    ).fetchall()
                except sqlite3.OperationalError:
                    match_rows = []
                rowids = [r["rowid"] for r in match_rows]
                if rowids:
                    placeholders = ",".join(["?" for _ in rowids])
                    found = conn.execute(
                        f"""
                        SELECT id, content, memory_rowid
                        FROM memories
                        WHERE memory_rowid IN ({placeholders}) AND is_valid = 1
                        """,
                        tuple(rowids),
                    ).fetchall()
                    by_rowid = {r["memory_rowid"]: r for r in found}
                    rows = [by_rowid[rid] for rid in rowids if rid in by_rowid]
        support = []
        provenance = []
        for row in rows:
            content = row["content"]
            if not content:
                continue
            support.append(content)
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "local-memory-mcp-rust:memories",
            })
            if len(support) >= limit:
                break
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM memories WHERE is_valid = 1").fetchone()
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

const NAME = "local-memory-mcp-rust";
const PORT = Number(arg("port", process.env.PORT || "8115"));
const PYTHON = arg("python", process.env.AMBIENT_LOCAL_MEMORY_MCP_RUST_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_LOCAL_MEMORY_MCP_RUST_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-local-memory-mcp-rust-"));
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
  return join(dir, `${safeStoreName(store)}.db`);
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
          return reject(new Error(`local-memory-mcp-rust helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} local-memory-mcp-rust helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    id: `ambient_${Date.now()}_${randomUUID().slice(0, 8)}`,
    fact: String(b?.fact ?? ""),
    source: String(b?.source || "ambient"),
    actorId: String(b?.actorId || "ambient"),
    namespace: String(b?.namespace || "default"),
    strategy: String(b?.strategy || "ambient"),
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
  try {
    const handler = routes[path];
    if (!handler) return send(res, { error: "not found" }, 404);
    const body = req.method === "POST" ? await readBody(req) : {};
    return send(res, await handler(body));
  } catch (e) {
    return send(res, { error: e?.message || String(e) }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`${NAME} adapter listening on http://127.0.0.1:${PORT}`);
});
