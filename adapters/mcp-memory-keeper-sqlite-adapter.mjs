#!/usr/bin/env node
// AMBIENT wire-protocol bridge for mkreyman/mcp-memory-keeper's SQLite floor.
//
// mcp-memory-keeper is a TypeScript MCP server backed by better-sqlite3 at:
//   DATA_DIR/context.db
//
// This adapter targets the stable local context DB substrate directly. It writes
// AMBIENT facts as public context_items in an isolated per-store session and
// queries with the same LIKE-based search family used by context_search.
//
// Each AMBIENT store gets an isolated DATA_DIR so reset never touches the user's
// ~/mcp-data/memory-keeper/context.db.

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
        if len(terms) >= 12:
            break
    return terms

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          branch TEXT,
          working_directory TEXT,
          parent_id TEXT,
          default_channel TEXT DEFAULT 'general',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (parent_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          category TEXT,
          priority TEXT DEFAULT 'normal',
          metadata TEXT,
          size INTEGER DEFAULT 0,
          is_private INTEGER DEFAULT 0,
          channel TEXT DEFAULT 'general',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          UNIQUE(session_id, key)
        );

        CREATE TABLE IF NOT EXISTS file_cache (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          content TEXT,
          hash TEXT,
          size INTEGER DEFAULT 0,
          last_read TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          UNIQUE(session_id, file_path)
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          metadata TEXT,
          git_status TEXT,
          git_branch TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS checkpoint_items (
          id TEXT PRIMARY KEY,
          checkpoint_id TEXT NOT NULL,
          context_item_id TEXT NOT NULL,
          FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
          FOREIGN KEY (context_item_id) REFERENCES context_items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS checkpoint_files (
          id TEXT PRIMARY KEY,
          checkpoint_id TEXT NOT NULL,
          file_cache_id TEXT NOT NULL,
          FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE,
          FOREIGN KEY (file_cache_id) REFERENCES file_cache(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          attributes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS relations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object_id TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (subject_id) REFERENCES entities(id) ON DELETE CASCADE,
          FOREIGN KEY (object_id) REFERENCES entities(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          observation TEXT NOT NULL,
          source TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS journal_entries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          entry TEXT NOT NULL,
          mood TEXT,
          tags TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS context_relationships (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          from_key TEXT NOT NULL,
          to_key TEXT NOT NULL,
          relationship_type TEXT NOT NULL,
          metadata TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          UNIQUE(session_id, from_key, to_key, relationship_type)
        );

        CREATE INDEX IF NOT EXISTS idx_context_items_session ON context_items(session_id);
        CREATE INDEX IF NOT EXISTS idx_context_items_category ON context_items(category);
        CREATE INDEX IF NOT EXISTS idx_context_items_priority ON context_items(priority);
        CREATE INDEX IF NOT EXISTS idx_context_items_private ON context_items(is_private);
        CREATE INDEX IF NOT EXISTS idx_context_items_channel ON context_items(channel);
        CREATE INDEX IF NOT EXISTS idx_context_items_created ON context_items(created_at);
        CREATE INDEX IF NOT EXISTS idx_context_items_session_created ON context_items(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_file_cache_session ON file_cache(session_id);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
        CREATE INDEX IF NOT EXISTS idx_relationships_from ON context_relationships(session_id, from_key);
        CREATE INDEX IF NOT EXISTS idx_relationships_to ON context_relationships(session_id, to_key);
        CREATE INDEX IF NOT EXISTS idx_relationships_type ON context_relationships(relationship_type);
    """)
    conn.commit()

db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    ensure_schema(conn)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        session_id = payload.get("session_id") or "ambient-default"
        channel = payload.get("channel") or "general"
        stamp = now()
        conn.execute(
            """INSERT OR IGNORE INTO sessions
               (id, name, description, default_channel, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_id, "AMBIENT " + channel, "AMBIENT isolated memory-keeper session", channel, stamp, stamp),
        )
        conn.execute("UPDATE sessions SET updated_at = ?, default_channel = ? WHERE id = ?", (stamp, channel, session_id))
        item_id = payload.get("id") or "ambient-" + stamp
        key = payload.get("key") or item_id
        metadata = json.dumps({
            "source": payload.get("source") or "ambient",
            "adapter": "mcp-memory-keeper-sqlite",
        })
        conn.execute(
            """INSERT OR REPLACE INTO context_items
               (id, session_id, key, value, category, priority, metadata, size, is_private, channel, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
            (item_id, session_id, key, fact, payload.get("category") or "note", payload.get("priority") or "normal", metadata, len(fact), channel, stamp, stamp),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": item_id, "sessionId": session_id, "db": str(db_path), "dataDir": str(db_path.parent)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        terms = query_terms(question)
        rows = []
        if terms:
            where = " OR ".join(["lower(value) LIKE ? OR lower(key) LIKE ?" for _ in terms])
            score_expr = " + ".join(["CASE WHEN lower(value) LIKE ? OR lower(key) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
            rows = conn.execute(
                "SELECT id, session_id, key, value, category, priority, metadata, channel, created_at, "
                "(" + score_expr + ") AS score "
                "FROM context_items WHERE is_private = 0 AND (" + where + ") "
                "ORDER BY score DESC, "
                "CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, "
                "created_at DESC LIMIT ?",
                (*[v for term in terms for v in (f"%{term}%", f"%{term}%")],
                 *[v for term in terms for v in (f"%{term}%", f"%{term}%")],
                 limit),
            ).fetchall()
        if not rows and question:
            rows = conn.execute(
                """SELECT id, session_id, key, value, category, priority, metadata, channel, created_at, 0 AS score
                   FROM context_items
                   WHERE is_private = 0 AND (value LIKE ? OR key LIKE ?)
                   ORDER BY created_at DESC LIMIT ?""",
                (f"%{question}%", f"%{question}%", limit),
            ).fetchall()
        support = []
        provenance = []
        for row in rows:
            support.append(row["value"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "mcp-memory-keeper:context_items",
                "sessionId": row["session_id"],
                "key": row["key"],
                "category": row["category"],
                "priority": row["priority"],
                "channel": row["channel"],
                "writtenAt": row["created_at"],
                "score": row["score"],
            })
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        items = conn.execute("SELECT COUNT(*) AS c FROM context_items").fetchone()
        sessions = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()
        print(json.dumps({"supported": True, "size": int(items["c"]), "sessions": int(sessions["c"])}))
    else:
        raise SystemExit(f"unsupported op: {op}")
finally:
    conn.close()
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "mcp-memory-keeper-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8102"));
const PYTHON = arg("python", process.env.AMBIENT_MCP_MEMORY_KEEPER_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_MCP_MEMORY_KEEPER_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-mcp-memory-keeper-"));
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
  return join(dir, "context.db");
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
          return reject(new Error(`mcp-memory-keeper SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} mcp-memory-keeper SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const store = safeStoreName(b?.store);
  const db = await storeDb(b?.store);
  const id = randomUUID();
  return runPython({
    op: "write",
    db,
    id,
    session_id: `ambient-${store}`,
    key: `ambient/${id}`,
    channel: store,
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
