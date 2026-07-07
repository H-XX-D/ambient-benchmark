#!/usr/bin/env node
// AMBIENT wire-protocol bridge for Beledarian/mcp-local-memory's local DB floor.
//
// The full server is an MCP stdio process with local transformer embeddings,
// sqlite-vec, archivist workers, and graph/task tools. This adapter targets the
// stable MEMORY_DB_PATH SQLite substrate used by the server:
//   ~/.memory/memory.db by default, isolated here per AMBIENT store.
//
// It covers deterministic write/query/reset benchmarking without downloading
// embedding models or mutating a user's real ~/.memory/memory.db.

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
from datetime import datetime, timezone
from pathlib import Path

payload = json.loads(sys.argv[1])
op = payload["op"]
db_path = Path(payload["db"])

def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def fts_query(q):
    parts = []
    for tok in (q or "").split():
        cleaned = "".join(ch if (ch.isalnum() or ch in ("_", "-")) else " " for ch in tok)
        cleaned = cleaned.strip("_- ")
        if cleaned:
            parts.append('"' + cleaned.replace('"', '""') + '"')
    return " OR ".join(parts) or '""'

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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          source TEXT,
          tags TEXT,
          importance FLOAT DEFAULT 0.5,
          last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
          access_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

        CREATE TABLE IF NOT EXISTS vec_items (rowid INTEGER PRIMARY KEY, embedding BLOB);
        CREATE TABLE IF NOT EXISTS vec_entities (rowid INTEGER PRIMARY KEY, embedding BLOB);

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          tags
        );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END;
        DROP TRIGGER IF EXISTS memories_ad;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.rowid;
        END;
        DROP TRIGGER IF EXISTS memories_au;
        CREATE TRIGGER memories_au AFTER UPDATE OF content, tags ON memories BEGIN
          DELETE FROM memories_fts WHERE rowid = old.rowid;
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
        END;

        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT,
          observations TEXT,
          importance FLOAT DEFAULT 0.5
        );
        CREATE TABLE IF NOT EXISTS relations (
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          relation TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(source) REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
          FOREIGN KEY(target) REFERENCES entities(name) ON DELETE CASCADE ON UPDATE CASCADE,
          PRIMARY KEY (source, target, relation)
        );
        CREATE TABLE IF NOT EXISTS entity_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          due_date DATETIME,
          status TEXT CHECK(status IN ('pending', 'completed')) DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_active DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_last_active ON conversations(last_active);
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          section TEXT,
          content TEXT NOT NULL,
          status TEXT CHECK(status IN ('pending', 'in-progress', 'complete')) DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    """)
    conn.commit()

def has_fts(conn):
    try:
        conn.execute("SELECT 1 FROM memories_fts LIMIT 1").fetchone()
        return True
    except sqlite3.OperationalError:
        return False

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
        memory_id = payload.get("id") or str(payload.get("uuid") or "")
        if not memory_id:
            import uuid
            memory_id = str(uuid.uuid4())
        tags = payload.get("tags") or []
        created_at = now()
        conn.execute(
            """INSERT INTO memories
               (id, content, created_at, source, tags, importance, last_accessed, access_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0)""",
            (
                memory_id,
                fact,
                created_at,
                payload.get("source") or "ambient",
                json.dumps(tags),
                float(payload.get("importance") or 0.5),
                created_at,
            ),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": memory_id, "db": str(db_path)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        rows = []
        if has_fts(conn):
            try:
                rows = conn.execute(
                    """SELECT memories.id, memories.content, memories.tags, memories.source,
                              memories.created_at, memories.importance, rank AS score
                       FROM memories_fts
                       JOIN memories ON memories_fts.rowid = memories.rowid
                       WHERE memories_fts MATCH ?
                       ORDER BY rank
                       LIMIT ?""",
                    (fts_query(question), limit),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(content) LIKE ?" for _ in terms])
                score_expr = " + ".join(["CASE WHEN lower(content) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
                rows = conn.execute(
                    "SELECT id, content, tags, source, created_at, importance, "
                    "(" + score_expr + ") AS score "
                    "FROM memories WHERE " + like_where + " "
                    "ORDER BY score DESC, created_at DESC LIMIT ?",
                    (*[f"%{t}%" for t in terms], *[f"%{t}%" for t in terms], limit),
                ).fetchall()
        if rows:
            conn.execute(
                "UPDATE memories SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 "
                "WHERE id IN (" + ",".join(["?" for _ in rows]) + ")",
                tuple(row["id"] for row in rows),
            )
            conn.commit()
        support = []
        provenance = []
        for row in rows:
            support.append(row["content"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "mcp-local-memory:memories",
                "writtenAt": row["created_at"],
                "tags": row["tags"],
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

const NAME = "mcp-local-memory-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8100"));
const PYTHON = arg("python", process.env.AMBIENT_MCP_LOCAL_MEMORY_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_MCP_LOCAL_MEMORY_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-mcp-local-memory-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeDb(store = "default") {
  const dir = join(await baseRoot(), storeKey(store), ".memory");
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
          return reject(new Error(`mcp-local-memory SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} mcp-local-memory SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const store = safeStoreName(b?.store);
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    fact: String(b?.fact ?? ""),
    source: String(b?.source || "ambient"),
    tags: ["ambient", store, String(b?.source || "ingest")].filter(Boolean),
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
