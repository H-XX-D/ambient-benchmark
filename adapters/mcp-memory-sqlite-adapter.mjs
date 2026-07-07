#!/usr/bin/env node
// AMBIENT wire-protocol bridge for Daichi-Kudo/mcp-memory-sqlite's SQLite floor.
//
// The upstream package is a drop-in replacement for
// @modelcontextprotocol/server-memory, backed by a local SQLite knowledge graph.
// This adapter targets the stable MEMORY_DB_PATH-style schema directly:
//   entities(name, entity_type)
//   observations(entity_name, content)
//   relations(from_entity, to_entity, relation_type)
//
// It gives AMBIENT deterministic write/query/reset coverage without starting an
// MCP stdio/HTTP server or requiring the npm package to be installed.

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

def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entities (
            name TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_name TEXT NOT NULL,
            content TEXT NOT NULL,
            FOREIGN KEY (entity_name) REFERENCES entities(name) ON DELETE CASCADE,
            UNIQUE(entity_name, content)
        );

        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_entity TEXT NOT NULL,
            to_entity TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            FOREIGN KEY (from_entity) REFERENCES entities(name) ON DELETE CASCADE,
            FOREIGN KEY (to_entity) REFERENCES entities(name) ON DELETE CASCADE,
            UNIQUE(from_entity, to_entity, relation_type)
        );

        CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_name);
        CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
        CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
    """)
    conn.commit()

def entity_rows_for_names(conn, names):
    if not names:
        return []
    placeholders = ",".join(["?" for _ in names])
    return conn.execute(
        f"""
        SELECT e.name, e.entity_type, o.id AS observation_id, o.content
        FROM entities e
        LEFT JOIN observations o ON e.name = o.entity_name
        WHERE e.name IN ({placeholders})
        ORDER BY e.name ASC, o.id ASC
        """,
        tuple(names),
    ).fetchall()

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
        entity_name = payload.get("id") or "ambient_" + payload.get("uuid", "")
        if not entity_name or entity_name == "ambient_":
            import uuid
            entity_name = "ambient_" + str(uuid.uuid4())
        entity_type = payload.get("entityType") or "AmbientMemory"
        conn.execute(
            "INSERT OR IGNORE INTO entities (name, entity_type) VALUES (?, ?)",
            (entity_name, entity_type),
        )
        conn.execute(
            "INSERT OR IGNORE INTO observations (entity_name, content) VALUES (?, ?)",
            (entity_name, fact),
        )
        conn.commit()
        print(json.dumps({"accepted": True, "id": entity_name, "db": str(db_path)}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        lower = f"%{question.lower()}%"
        names = [
            row["name"]
            for row in conn.execute(
                """
                SELECT DISTINCT e.name
                FROM entities e
                LEFT JOIN observations o ON e.name = o.entity_name
                WHERE lower(e.name) LIKE ?
                   OR lower(e.entity_type) LIKE ?
                   OR lower(o.content) LIKE ?
                ORDER BY e.name ASC
                LIMIT ?
                """,
                (lower, lower, lower, limit),
            ).fetchall()
        ]
        if not names:
            terms = query_terms(question)
            if terms:
                like_where = " OR ".join(["lower(e.name) LIKE ? OR lower(e.entity_type) LIKE ? OR lower(o.content) LIKE ?" for _ in terms])
                params = []
                for term in terms:
                    v = f"%{term}%"
                    params.extend([v, v, v])
                names = [
                    row["name"]
                    for row in conn.execute(
                        """
                        SELECT DISTINCT e.name
                        FROM entities e
                        LEFT JOIN observations o ON e.name = o.entity_name
                        WHERE """ + like_where + """
                        ORDER BY e.name ASC
                        LIMIT ?
                        """,
                        tuple(params + [limit]),
                    ).fetchall()
                ]
        rows = entity_rows_for_names(conn, names)
        support = []
        provenance = []
        seen_obs = set()
        for row in rows:
            content = row["content"]
            if not content or row["observation_id"] in seen_obs:
                continue
            seen_obs.add(row["observation_id"])
            support.append(content)
            provenance.append({
                "id": row["observation_id"],
                "entity": row["name"],
                "origin": "external",
                "source": "mcp-memory-sqlite:observations",
                "entityType": row["entity_type"],
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

const NAME = "mcp-memory-sqlite";
const PORT = Number(arg("port", process.env.PORT || "8104"));
const PYTHON = arg("python", process.env.AMBIENT_MCP_MEMORY_SQLITE_PYTHON || process.env.PYTHON || "python3");
const BASE_ROOT = arg("root", process.env.AMBIENT_MCP_MEMORY_SQLITE_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-mcp-memory-sqlite-"));
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
          return reject(new Error(`mcp-memory-sqlite helper returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} mcp-memory-sqlite helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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

