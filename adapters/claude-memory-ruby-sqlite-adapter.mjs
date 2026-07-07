#!/usr/bin/env node
// AMBIENT wire-protocol bridge for codenamev/claude_memory's local SQLite floor.
//
// codenamev/claude_memory is a Ruby gem: Claude Code hooks plus MCP tools
// that read and write a project or global SQLite store at
// .claude/memory.sqlite3 (see db/migrations/*.rb and
// lib/claude_memory/store/schema_manager.rb, SCHEMA_VERSION = 20, in
// https://github.com/codenamev/claude_memory, default branch main).
//
// This adapter targets that SQLite floor directly. It does not shell out to
// the claude-memory Ruby CLI or MCP server and does not require the Ruby
// runtime, the gem, or its embeddings/reflector pipeline to be installed; it
// only needs python3 with the sqlite3 stdlib module.
//
// Confirmed schema (fetched from the migrations below on 2026-07-07):
//   entities(id, type, canonical_name, slug, created_at)
//     db/migrations/001_create_initial_schema.rb
//   facts(id, subject_entity_id, predicate, object_entity_id, object_literal,
//         datatype, polarity, valid_from, valid_to, status, confidence,
//         created_from, created_at, scope, project_path, docid)
//     db/migrations/001_create_initial_schema.rb (base columns)
//     db/migrations/002_add_project_scoping.rb (scope, project_path)
//     db/migrations/009_add_docid.rb (docid)
//   observations(id, body, kind, priority, scope, project_path,
//                source_content_item_id, consolidated_into, token_count,
//                status, session_id, observed_at, created_at, reflected_at,
//                corroboration_count, promoted_at, promoted_fact_id)
//     db/migrations/019_add_observations.rb (base columns)
//     db/migrations/020_add_observation_promotion.rb (corroboration_count,
//       promoted_at, promoted_fact_id)
//   Cross-checked against lib/claude_memory/domain/fact.rb,
//   lib/claude_memory/domain/observation.rb, and
//   lib/claude_memory/store/schema_manager.rb, which agree on every column.
//
// Design decision: write(fact) targets the observations table (the body
// column), not facts. observations is claude_memory's own episodic,
// free-text floor ("what happened", per the migration 019 header comment)
// and takes a plain string with no further resolution. facts is a resolved
// subject-predicate-object triple over the entities table (see
// lib/claude_memory/resolve/resolver.rb upstream); decomposing an arbitrary
// opaque fact string into that triple needs an NLP resolution step this
// floor adapter does not have. ensure_schema still creates entities and
// facts faithfully (matching the confirmed columns above) so the real
// upstream shape is present and probeable, even though this adapter's
// write/query path only touches observations.

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

def now_iso():
    return datetime.now(timezone.utc).isoformat()

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
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_entity_id INTEGER REFERENCES entities(id),
            predicate TEXT NOT NULL,
            object_entity_id INTEGER REFERENCES entities(id),
            object_literal TEXT,
            datatype TEXT,
            polarity TEXT DEFAULT 'positive',
            valid_from TEXT,
            valid_to TEXT,
            status TEXT DEFAULT 'active',
            confidence REAL DEFAULT 1.0,
            created_from TEXT,
            created_at TEXT NOT NULL,
            scope TEXT DEFAULT 'project',
            project_path TEXT,
            docid TEXT
        );

        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            body TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'event',
            priority INTEGER NOT NULL DEFAULT 3,
            scope TEXT NOT NULL DEFAULT 'project',
            project_path TEXT,
            source_content_item_id INTEGER,
            consolidated_into INTEGER,
            token_count INTEGER,
            status TEXT NOT NULL DEFAULT 'active',
            session_id TEXT,
            observed_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reflected_at TEXT,
            corroboration_count INTEGER NOT NULL DEFAULT 1,
            promoted_at TEXT,
            promoted_fact_id INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);
        CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
        CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status);
        CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(scope);
        CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations(observed_at);
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
        session_id = payload.get("id") or ("ambient_" + payload.get("uuid", ""))
        if not session_id or session_id == "ambient_":
            import uuid
            session_id = "ambient_" + str(uuid.uuid4())
        kind = payload.get("kind") or "event"
        ts = now_iso()
        cur = conn.execute(
            """
            INSERT INTO observations
                (body, kind, priority, scope, session_id, observed_at, created_at, status, corroboration_count)
            VALUES (?, ?, 3, 'project', ?, ?, ?, 'active', 1)
            """,
            (fact, kind, session_id, ts, ts),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": cur.lastrowid, "db": str(db_path)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        lower = f"%{question.lower()}%"
        rows = conn.execute(
            """
            SELECT id, body, kind, session_id
            FROM observations
            WHERE status = 'active'
              AND (lower(body) LIKE ? OR lower(kind) LIKE ? OR lower(session_id) LIKE ?)
            ORDER BY id ASC
            LIMIT ?
            """,
            (lower, lower, lower, limit),
        ).fetchall()
        if not rows:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(body) LIKE ? OR lower(kind) LIKE ? OR lower(session_id) LIKE ?" for _ in terms])
                params = []
                for term in terms:
                    v = f"%{term}%"
                    params.extend([v, v, v])
                rows = conn.execute(
                    """
                    SELECT id, body, kind, session_id
                    FROM observations
                    WHERE status = 'active' AND (""" + like_where + """)
                    ORDER BY id ASC
                    LIMIT ?
                    """,
                    tuple(params + [limit]),
                ).fetchall()
        support = []
        provenance = []
        for row in rows:
            if not row["body"]:
                continue
            support.append(row["body"])
            provenance.append({
                "id": row["id"],
                "origin": "external",
                "source": "claude-memory-ruby:observations",
                "kind": row["kind"],
            })
            if len(support) >= limit:
                break
        print(json.dumps({"support": support, "provenance": provenance}))
    elif op == "collection":
        row = conn.execute("SELECT COUNT(*) AS c FROM observations").fetchone()
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

const NAME = "claude-memory-ruby";
const PORT = Number(arg("port", process.env.PORT || "8116"));
const PYTHON = arg("python", process.env.AMBIENT_CLAUDE_MEMORY_RUBY_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_CLAUDE_MEMORY_RUBY_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-claude-memory-ruby-"));
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
  return join(dir, "memory.sqlite3");
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
          return reject(new Error(`claude-memory-ruby helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} claude-memory-ruby helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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
