#!/usr/bin/env node
// AMBIENT wire-protocol bridge for baiXfeng/agent-memory's SQLite floor.
//
// The upstream package exposes an MCP server with a storage-directory argument.
// Its local substrate is:
//   <storage-dir>/memory.db
//
// This adapter writes directly to the stable memories table and queries through
// the same FTS5 + LIKE fallback shape, without starting the MCP stdio server or
// requiring the npm package at benchmark time.

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

def fts_query(q):
    parts = []
    for tok in query_terms(q):
        parts.append('"' + tok.replace('"', '""') + '"')
    return " OR ".join(parts) or '""'

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            content TEXT NOT NULL,
            keywords TEXT,
            category TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    """)
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                title,
                summary,
                keywords,
                content,
                category,
                content_id UNINDEXED,
                tokenize = 'trigram'
            )
        """)
    except sqlite3.OperationalError:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                title,
                summary,
                keywords,
                content,
                category,
                content_id UNINDEXED
            )
        """)
    conn.executescript("""
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, title, summary, keywords, content, category, content_id)
            VALUES (new.id, new.title, new.summary, new.keywords, new.content, new.category, new.id);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id;
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
            DELETE FROM memories_fts WHERE rowid = old.id;
            INSERT INTO memories_fts(rowid, title, summary, keywords, content, category, content_id)
            VALUES (new.id, new.title, new.summary, new.keywords, new.content, new.category, new.id);
        END;

        CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
        CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
    """)
    conn.commit()

def decode_keywords(value):
    try:
        parsed = json.loads(value or "[]")
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []

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
        title = (payload.get("title") or fact[:80] or "AMBIENT memory").strip()
        summary = (payload.get("summary") or fact[:240]).strip()
        keywords = payload.get("keywords") or query_terms(fact)[:8] or ["ambient"]
        category = payload.get("category") or payload.get("source") or "ambient"
        cur = conn.execute(
            """
            INSERT INTO memories (title, summary, content, keywords, category)
            VALUES (?, ?, ?, ?, ?)
            """,
            (title, summary, fact, json.dumps(keywords), category),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": int(cur.lastrowid), "db": str(db_path), "storageDir": str(db_path.parent)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        rows = []
        try:
            rows = conn.execute(
                """
                SELECT m.id, m.title, m.summary, m.keywords, m.category,
                       m.content, m.updated_at, m.created_at, fts.rank AS score
                FROM memories_fts fts
                JOIN memories m ON m.id = fts.rowid
                WHERE memories_fts MATCH ?
                ORDER BY fts.rank ASC
                LIMIT ?
                """,
                (fts_query(question), limit),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join([
                    "lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(keywords) LIKE ? OR lower(content) LIKE ? OR lower(category) LIKE ?"
                    for _ in terms
                ])
                score_expr = " + ".join([
                    "CASE WHEN lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(keywords) LIKE ? OR lower(content) LIKE ? OR lower(category) LIKE ? THEN 1 ELSE 0 END"
                    for _ in terms
                ])
                score_params = []
                where_params = []
                for term in terms:
                    v = f"%{term}%"
                    score_params.extend([v, v, v, v, v])
                    where_params.extend([v, v, v, v, v])
                rows = conn.execute(
                    "SELECT id, title, summary, keywords, category, content, updated_at, created_at, "
                    "(" + score_expr + ") AS score "
                    "FROM memories WHERE " + like_where + " "
                    "ORDER BY score DESC, updated_at DESC LIMIT ?",
                    tuple(score_params + where_params + [limit]),
                ).fetchall()
        support = []
        provenance = []
        for row in rows:
            support.append(row["content"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "agent-memory:memories",
                "title": row["title"],
                "summary": row["summary"],
                "keywords": decode_keywords(row["keywords"]),
                "category": row["category"],
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

const NAME = "agent-memory-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8105"));
const PYTHON = arg("python", process.env.AMBIENT_AGENT_MEMORY_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_AGENT_MEMORY_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-agent-memory-"));
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
          return reject(new Error(`agent-memory SQLite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} agent-memory SQLite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
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

