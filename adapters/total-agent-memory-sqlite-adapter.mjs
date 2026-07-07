#!/usr/bin/env node
// AMBIENT wire-protocol bridge for Superherojt/total-agent-memory's local DB floor.
//
// total-agent-memory's full Store runtime is intentionally heavyweight
// (ChromaDB, embedding providers, enrichment workers). This adapter targets
// the stable local SQLite knowledge/FTS schema that tam-lookup reads:
//   TAM_MEMORY_DIR/memory.db
//
// Each AMBIENT store gets an isolated TAM_MEMORY_DIR. Reset rotates that path,
// so benchmark runs do not mutate the user's ~/.tam/memory.db.

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
        parts.append('"' + tok.replace('"', '""') + '"')
    return " ".join(parts) or '""'

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
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT,
            project TEXT DEFAULT 'general', status TEXT DEFAULT 'open',
            summary TEXT, log_count INTEGER DEFAULT 0, branch TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS knowledge (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL, type TEXT NOT NULL,
            content TEXT NOT NULL, context TEXT DEFAULT '',
            project TEXT DEFAULT 'general', tags TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active', superseded_by INTEGER,
            confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'explicit',
            created_at TEXT NOT NULL, last_confirmed TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled TEXT,
            branch TEXT DEFAULT '', importance TEXT NOT NULL DEFAULT 'medium',
            agent_id TEXT DEFAULT NULL, parent_agent_id TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS relations (
            from_id INTEGER, to_id INTEGER, type TEXT, created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS timeline (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL, ts TEXT NOT NULL,
            event TEXT NOT NULL, summary TEXT NOT NULL,
            details TEXT DEFAULT '', project TEXT DEFAULT 'general', files TEXT DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_k_status ON knowledge(status);
        CREATE INDEX IF NOT EXISTS idx_k_type ON knowledge(type);
        CREATE INDEX IF NOT EXISTS idx_k_project ON knowledge(project);
        CREATE INDEX IF NOT EXISTS idx_k_session ON knowledge(session_id);
        CREATE INDEX IF NOT EXISTS idx_k_last_confirmed ON knowledge(last_confirmed);
        CREATE INDEX IF NOT EXISTS idx_k_agent_id ON knowledge(agent_id) WHERE agent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_k_parent_agent_id ON knowledge(parent_agent_id) WHERE parent_agent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_id);
        CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_id);
        CREATE INDEX IF NOT EXISTS idx_t_session ON timeline(session_id);
        CREATE INDEX IF NOT EXISTS idx_s_started ON sessions(started_at);
        CREATE TABLE IF NOT EXISTS embeddings (
            knowledge_id INTEGER PRIMARY KEY,
            binary_vector BLOB NOT NULL,
            float32_vector BLOB NOT NULL,
            embed_model TEXT NOT NULL,
            embed_dim INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    try:
        conn.executescript("""
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                content, context, tags, content='knowledge', content_rowid='id'
            );
            CREATE TRIGGER IF NOT EXISTS k_fts_i AFTER INSERT ON knowledge BEGIN
                INSERT INTO knowledge_fts(rowid,content,context,tags)
                VALUES (new.id,new.content,new.context,new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS k_fts_u AFTER UPDATE ON knowledge BEGIN
                INSERT INTO knowledge_fts(knowledge_fts,rowid,content,context,tags)
                VALUES ('delete',old.id,old.content,old.context,old.tags);
                INSERT INTO knowledge_fts(rowid,content,context,tags)
                VALUES (new.id,new.content,new.context,new.tags);
            END;
        """)
    except sqlite3.OperationalError:
        pass
    conn.commit()

def has_fts(conn):
    try:
        conn.execute("SELECT 1 FROM knowledge_fts LIMIT 1").fetchone()
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
        project = payload.get("project") or "general"
        session_id = payload.get("session_id") or f"ambient-{project}"
        created_at = now()
        tags = payload.get("tags") or []
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, started_at, project, status, summary, log_count) VALUES (?,?,?,?,?,?)",
            (session_id, created_at, project, "open", "AMBIENT adapter session", 0),
        )
        cur = conn.execute(
            """INSERT INTO knowledge
               (session_id,type,content,context,project,tags,source,confidence,created_at,
                last_confirmed,recall_count,branch,importance,agent_id,parent_agent_id)
               VALUES (?,?,?,?,?,?,?,1.0,?,?,0,?,?,?,?)""",
            (
                session_id,
                payload.get("type") or "fact",
                fact,
                payload.get("context") or "",
                project,
                json.dumps(tags),
                payload.get("source") or "ambient",
                created_at,
                created_at,
                payload.get("branch") or "",
                payload.get("importance") or "medium",
                payload.get("agent_id"),
                payload.get("parent_agent_id"),
            ),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": cur.lastrowid, "db": str(db_path)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        project = payload.get("project") or None
        where = ["k.status = 'active'"]
        params = []
        if project:
            where.append("k.project = ?")
            params.append(project)
        if has_fts(conn):
            rows = conn.execute(
                "SELECT k.id, k.project, k.type, k.content, k.tags, k.created_at, bm25(knowledge_fts) AS score "
                "FROM knowledge_fts JOIN knowledge k ON k.id = knowledge_fts.rowid "
                "WHERE knowledge_fts MATCH ? AND " + " AND ".join(where) + " "
                "ORDER BY score LIMIT ?",
                (fts_query(question), *params, limit),
            ).fetchall()
        else:
            rows = []
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(k.content) LIKE ?" for _ in terms])
                score_expr = " + ".join(["CASE WHEN lower(k.content) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
                like_params = [f"%{t}%" for t in terms]
                rows = conn.execute(
                    "SELECT k.id, k.project, k.type, k.content, k.tags, k.created_at, "
                    "(" + score_expr + ") AS score "
                    "FROM knowledge k WHERE " + " AND ".join(where) + " AND (" + like_where + ") "
                    "ORDER BY score DESC, k.created_at DESC LIMIT ?",
                    (*[f"%{t}%" for t in terms], *params, *like_params, limit),
                ).fetchall()
        if not rows:
            rows = conn.execute(
                "SELECT k.id, k.project, k.type, k.content, k.tags, k.created_at, 0.0 AS score "
                "FROM knowledge k WHERE " + " AND ".join(where) + " AND k.content LIKE ? "
                "ORDER BY k.created_at DESC LIMIT ?",
                (*params, f"%{question}%", limit),
            ).fetchall()
        support = []
        provenance = []
        for row in rows:
            support.append(row["content"])
            provenance.append({
                "id": str(row["id"]),
                "origin": "external",
                "source": "total-agent-memory:knowledge",
                "project": row["project"],
                "type": row["type"],
                "writtenAt": row["created_at"],
                "score": row["score"],
            })
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM knowledge WHERE status = 'active'").fetchone()
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

const NAME = "total-agent-memory-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8097"));
const PYTHON = arg("python", process.env.AMBIENT_TAM_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_TAM_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-tam-"));
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
          return reject(new Error(`TAM SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} TAM SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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
    project: store,
    source: String(b?.source || "ambient"),
    tags: ["ambient", store, String(b?.source || "ingest")].filter(Boolean),
  });
}

async function queryMemory(b) {
  const store = safeStoreName(b?.store);
  const db = await storeDb(b?.store);
  return runPython({
    op: "query",
    db,
    project: store,
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
