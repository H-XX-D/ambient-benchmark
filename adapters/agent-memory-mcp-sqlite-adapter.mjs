#!/usr/bin/env node
// AMBIENT wire-protocol bridge for mikeylong/agent-memory-mcp's SQLite floor.
//
// Upstream default path:
//   AGENT_MEMORY_HOME/memory.db
//
// This adapter targets the local lexical substrate directly: scoped memories,
// idempotency keys, and memories_fts. It intentionally avoids Ollama embeddings
// and the MCP server process so AMBIENT can run a deterministic, local/free
// adapter smoke without installing the source package.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

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

def fts_query(q):
    return " OR ".join(['"' + t.replace('"', '""') + '"' for t in query_terms(q)]) or '""'

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'session')),
          scope_id TEXT,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
          metadata_json TEXT,
          source_agent TEXT,
          embedding_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_accessed_at TEXT,
          expires_at TEXT,
          deleted_at TEXT,
          canonical_key TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
          ON memories(scope_type, scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_expires_at
          ON memories(expires_at);
        CREATE INDEX IF NOT EXISTS idx_memories_content_hash_scope
          ON memories(content_hash, scope_type, scope_id);
        CREATE INDEX IF NOT EXISTS idx_memories_canonical_scope_active
          ON memories(scope_type, scope_id, canonical_key, updated_at DESC)
          WHERE canonical_key IS NOT NULL AND deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS memory_embedding_chunks (
          parent_memory_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content_start_byte INTEGER NOT NULL,
          content_end_byte INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding_json TEXT NOT NULL,
          chunk_config_version TEXT NOT NULL,
          parent_content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (parent_memory_id, chunk_index),
          FOREIGN KEY (parent_memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_memory_embedding_chunks_parent
          ON memory_embedding_chunks(parent_memory_id);
    """)
    conn.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)", (now_iso(),))
    conn.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)", (now_iso(),))
    conn.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)", (now_iso(),))
    conn.execute("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)", (now_iso(),))
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          id UNINDEXED,
          content,
          tokenize = 'unicode61 remove_diacritics 1'
        )
    """)
    conn.executescript("""
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;

        CREATE TRIGGER memories_ai AFTER INSERT ON memories
        WHEN NEW.deleted_at IS NULL
        BEGIN
          INSERT INTO memories_fts (rowid, id, content)
          VALUES (NEW.rowid, NEW.id, NEW.content);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories
        BEGIN
          DELETE FROM memories_fts WHERE rowid = OLD.rowid;
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories
        BEGIN
          DELETE FROM memories_fts WHERE rowid = OLD.rowid;
          INSERT INTO memories_fts(rowid, id, content)
          SELECT NEW.rowid, NEW.id, NEW.content
          WHERE NEW.deleted_at IS NULL;
        END;
    """)
    conn.commit()

def active_clause(now):
    return "(m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?))"

db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=3000")
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_schema(conn)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        memory_id = payload.get("id")
        content_hash = payload.get("content_hash")
        stamp = now_iso()
        tags = payload.get("tags") or ["ambient"]
        metadata = payload.get("metadata") or {}
        metadata["ambient_store"] = payload.get("store") or "default"
        scope_type = payload.get("scope_type") or "project"
        scope_id = payload.get("scope_id") or payload.get("store") or "ambient"
        existing = conn.execute(
            """
            SELECT id FROM memories
            WHERE scope_type = ? AND COALESCE(scope_id, '') = COALESCE(?, '')
              AND content_hash = ? AND deleted_at IS NULL
            LIMIT 1
            """,
            (scope_type, scope_id, content_hash),
        ).fetchone()
        if existing:
            print(json.dumps({"accepted": True, "id": existing["id"], "created": False, "db": str(db_path), "dataDir": str(db_path.parent)}))
            sys.exit(0)
        conn.execute(
            """
            INSERT INTO memories (
              id, scope_type, scope_id, content, content_hash, canonical_key,
              tags_json, importance, metadata_json, source_agent, embedding_json,
              created_at, updated_at, last_accessed_at, expires_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)
            """,
            (
                memory_id,
                scope_type,
                scope_id,
                fact,
                content_hash,
                json.dumps(tags),
                float(payload.get("importance") or 0.5),
                json.dumps(metadata),
                payload.get("source_agent") or payload.get("source") or "ambient",
                stamp,
                stamp,
            ),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": memory_id, "created": True, "db": str(db_path), "dataDir": str(db_path.parent)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        now = now_iso()
        rows = []
        try:
            rows = conn.execute(
                """
                SELECT m.*, bm25(memories_fts) AS score
                FROM memories_fts
                JOIN memories m ON m.rowid = memories_fts.rowid
                WHERE """ + active_clause(now) + """
                  AND memories_fts MATCH ?
                ORDER BY bm25(memories_fts), m.updated_at DESC
                LIMIT ?
                """,
                (now, fts_query(question), limit),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(m.content) LIKE ? OR lower(m.tags_json) LIKE ?" for _ in terms])
                score_expr = " + ".join(["CASE WHEN lower(m.content) LIKE ? OR lower(m.tags_json) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
                score_params = []
                where_params = []
                for term in terms:
                    v = f"%{term}%"
                    score_params.extend([v, v])
                    where_params.extend([v, v])
                rows = conn.execute(
                    "SELECT m.*, (" + score_expr + ") AS score "
                    "FROM memories m WHERE " + active_clause(now) + " AND (" + like_where + ") "
                    "ORDER BY score DESC, m.updated_at DESC LIMIT ?",
                    tuple(score_params + [now] + where_params + [limit]),
                ).fetchall()
        if not rows:
            rows = conn.execute(
                """
                SELECT m.*, 0 AS score
                FROM memories m
                WHERE """ + active_clause(now) + """
                ORDER BY m.updated_at DESC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        if rows:
            stamp = now_iso()
            conn.execute(
                "UPDATE memories SET last_accessed_at = ? WHERE id IN (" + ",".join(["?" for _ in rows]) + ")",
                tuple([stamp] + [row["id"] for row in rows]),
            )
            conn.commit()
        support = []
        provenance = []
        for row in rows:
            try:
                tags = json.loads(row["tags_json"] or "[]")
            except Exception:
                tags = []
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except Exception:
                metadata = {}
            support.append(row["content"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "agent-memory-mcp:memories",
                "scope": {"type": row["scope_type"], "id": row["scope_id"]},
                "tags": tags,
                "metadata": metadata,
                "importance": row["importance"],
                "writtenAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "score": row["score"],
            })
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL").fetchone()
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

const NAME = "agent-memory-mcp-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8106"));
const PYTHON = arg("python", process.env.AMBIENT_AGENT_MEMORY_MCP_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_AGENT_MEMORY_MCP_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-agent-memory-mcp-"));
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

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
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
          return reject(new Error(`agent-memory-mcp SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} agent-memory-mcp SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const store = safeStoreName(b?.store);
  const fact = String(b?.fact ?? "");
  const db = await storeDb(store);
  return runPython({
    op: "write",
    db,
    id: randomUUID(),
    fact,
    content_hash: sha256(fact),
    scope_type: "project",
    scope_id: store,
    store,
    tags: ["ambient", String(b?.source || "memory")],
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

