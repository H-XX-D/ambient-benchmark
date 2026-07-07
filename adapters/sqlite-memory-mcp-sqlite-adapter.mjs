#!/usr/bin/env node
// AMBIENT wire-protocol bridge for RMANOV/sqlite-memory-mcp's core SQLite floor.
//
// sqlite-memory-mcp's full package exposes FastMCP micro-servers for graph,
// sessions, tasks, bridge sync, collab, entity hygiene, and intelligence tools.
// This adapter targets the stable local SQLITE_MEMORY_DB substrate for the core
// graph server: entities, observations, relations, and memory_fts.
//
// Each AMBIENT store gets an isolated memory.db so benchmark reset never touches
// the user's default ~/.claude/memory/memory.db.

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
MAX_SUPPORT_CHARS = 1200

def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def fts_query(raw):
    escaped = []
    for token in query_terms(raw):
        escaped.append('"' + token.replace('"', '""') + '"')
    return " OR ".join(escaped) or '""'

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

def clip_support(value):
    text = str(value or "")
    if len(text) <= MAX_SUPPORT_CHARS:
        return text
    return text[:MAX_SUPPORT_CHARS] + "..."

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            entity_type TEXT NOT NULL,
            project TEXT DEFAULT NULL,
            shared_by TEXT DEFAULT NULL,
            origin TEXT DEFAULT 'local',
            visibility TEXT DEFAULT 'private',
            publish_requested_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY,
            entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(entity_id, content)
        );
        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY,
            from_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            to_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(from_id, to_id, relation_type)
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            session_id TEXT UNIQUE NOT NULL,
            project TEXT DEFAULT NULL,
            summary TEXT DEFAULT NULL,
            active_files TEXT DEFAULT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT DEFAULT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'not_started',
            priority TEXT DEFAULT 'medium',
            section TEXT DEFAULT 'inbox',
            due_date TEXT DEFAULT NULL,
            project TEXT DEFAULT NULL,
            parent_id TEXT DEFAULT NULL REFERENCES tasks(id) ON DELETE SET NULL,
            notes TEXT DEFAULT NULL,
            recurring TEXT DEFAULT NULL,
            reminder_at TEXT DEFAULT NULL,
            type TEXT NOT NULL DEFAULT 'task',
            assignee TEXT DEFAULT NULL,
            shared_by TEXT DEFAULT NULL,
            visibility TEXT DEFAULT 'private',
            publish_requested_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
        CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
        CREATE INDEX IF NOT EXISTS idx_obs_entity ON observations(entity_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_section ON tasks(section);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            name, entity_type, observations_text,
            tokenize = "unicode61 remove_diacritics 2"
        );

        CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON entities BEGIN
            INSERT INTO memory_fts(rowid, name, entity_type, observations_text)
            VALUES (new.rowid, new.name, new.entity_type, '');
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON entities BEGIN
            DELETE FROM memory_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON entities BEGIN
            DELETE FROM memory_fts WHERE rowid = old.rowid;
            INSERT INTO memory_fts(rowid, name, entity_type, observations_text)
            SELECT new.rowid, new.name, new.entity_type,
                   COALESCE(GROUP_CONCAT(o.content, ' '), '')
            FROM (SELECT 1) LEFT JOIN observations o ON o.entity_id = new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_obs_ai AFTER INSERT ON observations BEGIN
            DELETE FROM memory_fts WHERE rowid = new.entity_id;
            INSERT INTO memory_fts(rowid, name, entity_type, observations_text)
            SELECT e.id, e.name, e.entity_type,
                   COALESCE(GROUP_CONCAT(o.content, ' '), '')
            FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
            WHERE e.id = new.entity_id GROUP BY e.id;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_fts_obs_ad AFTER DELETE ON observations BEGIN
            DELETE FROM memory_fts WHERE rowid = old.entity_id;
            INSERT INTO memory_fts(rowid, name, entity_type, observations_text)
            SELECT e.id, e.name, e.entity_type,
                   COALESCE(GROUP_CONCAT(o.content, ' '), '')
            FROM entities e LEFT JOIN observations o ON o.entity_id = e.id
            WHERE e.id = old.entity_id GROUP BY e.id;
        END;
    """)
    conn.commit()

def entity_rows_to_memory(conn, rows):
    if not rows:
        return [], []
    ids = [row["eid"] for row in rows]
    ph = ",".join("?" for _ in ids)
    obs_rows = conn.execute(
        "SELECT entity_id, id, content, created_at FROM observations "
        f"WHERE entity_id IN ({ph}) ORDER BY entity_id, id",
        ids,
    ).fetchall()
    obs_by_entity = {}
    for obs in obs_rows:
        obs_by_entity.setdefault(obs["entity_id"], []).append(obs)
    support = []
    provenance = []
    for row in rows:
        observations = obs_by_entity.get(row["eid"], [])
        for obs in observations:
            support.append(clip_support(obs["content"]))
            provenance.append({
                "id": str(obs["id"]),
                "origin": "external",
                "source": "sqlite-memory-mcp:observations",
                "entity": row["name"],
                "entityType": row["entity_type"],
                "project": row["project"],
                "writtenAt": obs["created_at"],
                "score": row["score"],
            })
    return support, provenance

db_path.parent.mkdir(parents=True, exist_ok=True)
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_schema(conn)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        created_at = now()
        project = payload.get("project") or "default"
        entity_name = payload.get("entity") or ("AMBIENT " + str(payload.get("id") or "")).strip()
        if entity_name == "AMBIENT":
            import uuid
            entity_name = "AMBIENT " + str(uuid.uuid4())
        cur = conn.execute(
            """INSERT OR IGNORE INTO entities
               (name, entity_type, project, visibility, created_at, updated_at)
               VALUES (?, ?, ?, 'private', ?, ?)""",
            (entity_name, payload.get("entity_type") or "AMBIENTFact", project, created_at, created_at),
        )
        eid_row = conn.execute("SELECT id FROM entities WHERE name = ?", (entity_name,)).fetchone()
        eid = eid_row["id"]
        conn.execute(
            "INSERT OR IGNORE INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)",
            (eid, fact, created_at),
        )
        conn.execute("UPDATE entities SET updated_at = ? WHERE id = ?", (created_at, eid))
        conn.commit()
        print(json.dumps({"accepted": True, "id": str(eid), "entity": entity_name, "db": str(db_path), "created": cur.rowcount > 0}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        project = payload.get("project") or None
        rows = []
        where = []
        params = []
        if project:
            where.append("e.project = ?")
            params.append(project)
        try:
            sql = (
                "SELECT memory_fts.rowid AS eid, memory_fts.name, memory_fts.entity_type, "
                "e.project, memory_fts.rank AS score FROM memory_fts "
                "JOIN entities e ON e.id = memory_fts.rowid "
                "WHERE memory_fts MATCH ?"
            )
            if where:
                sql += " AND " + " AND ".join(where)
            sql += " ORDER BY memory_fts.rank LIMIT ?"
            rows = conn.execute(sql, (fts_query(question), *params, limit)).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(o.content) LIKE ?" for _ in terms])
                score_expr = " + ".join(["CASE WHEN lower(o.content) LIKE ? THEN 1 ELSE 0 END" for _ in terms])
                sql = (
                    "SELECT e.id AS eid, e.name, e.entity_type, e.project, "
                    "(" + score_expr + ") AS score "
                    "FROM entities e JOIN observations o ON o.entity_id = e.id "
                    "WHERE (" + like_where + ")"
                )
                if where:
                    sql += " AND " + " AND ".join(where)
                sql += " GROUP BY e.id ORDER BY score DESC, e.updated_at DESC LIMIT ?"
                rows = conn.execute(
                    sql,
                    (*[f"%{t}%" for t in terms], *[f"%{t}%" for t in terms], *params, limit),
                ).fetchall()
        support, provenance = entity_rows_to_memory(conn, rows)
        print(json.dumps({"support": support[:limit], "provenance": provenance[:limit]}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM observations").fetchone()
        entities = conn.execute("SELECT COUNT(*) AS c FROM entities").fetchone()
        print(json.dumps({"supported": True, "size": int(row["c"]), "entities": int(entities["c"])}))
    else:
        raise SystemExit(f"unsupported op: {op}")
finally:
    conn.close()
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "sqlite-memory-mcp-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8101"));
const PYTHON = arg("python", process.env.AMBIENT_SQLITE_MEMORY_MCP_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_SQLITE_MEMORY_MCP_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-sqlite-memory-mcp-"));
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
          return reject(new Error(`sqlite-memory-mcp SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} sqlite-memory-mcp SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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
    id: randomUUID(),
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
