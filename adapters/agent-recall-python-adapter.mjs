#!/usr/bin/env node
// AMBIENT wire-protocol bridge for mnardit/agent-recall.
//
// This bridge does not vendor agent-recall. Install it locally, then run:
//   pip install agent-recall
//   npm run adapter:agent-recall -- --port 8096
//
// For source-checkout testing, pass:
//   --package-path /path/to/agent-recall
//
// Each AMBIENT store gets an isolated SQLite DB path. Reset rotates that path,
// so benchmark runs do not mutate the user's ~/.agent-recall/frames.db.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import json
import sys

from agent_recall.store import MemoryStore

payload = json.loads(sys.argv[1])
op = payload["op"]
db_path = payload["db"]
scope = payload.get("scope") or "ambient"

with MemoryStore(db_path) as store:
    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            sys.exit(0)
        entity_name = payload.get("entity") or "__ambient_memory__"
        entity_id = store.resolve_entity(entity_name, "ambient_store")
        observation_id = store.add_observation(entity_id, fact, scope=scope)
        print(json.dumps({"accepted": True, "id": observation_id, "entity": entity_name, "db": db_path}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        found = store.search(question, limit=limit)
        support = []
        provenance = []
        for entity in found:
            observations = store.get_observations(entity["id"])
            for obs in observations:
                text = obs.get("text") or ""
                if not text:
                    continue
                support.append(text)
                provenance.append({
                    "id": str(obs.get("id") or entity["id"]),
                    "origin": "external",
                    "source": "agent-recall:observation",
                    "writtenAt": obs.get("created_at"),
                    "score": 0,
                })
                if len(support) >= limit:
                    break
            if len(support) >= limit:
                break
        print(json.dumps({"support": support, "provenance": provenance}))
    else:
        raise SystemExit(f"unsupported op: {op}")
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "agent-recall-python";
const PORT = Number(arg("port", process.env.PORT || "8096"));
const PYTHON = arg("python", process.env.AMBIENT_AGENT_RECALL_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_AGENT_RECALL_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_AGENT_RECALL_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-agent-recall-"));
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
  return join(dir, "frames.db");
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
    const env = { ...process.env };
    if (PACKAGE_PATH) {
      env.PYTHONPATH = env.PYTHONPATH ? `${PACKAGE_PATH}:${env.PYTHONPATH}` : PACKAGE_PATH;
    }
    const child = spawn(PYTHON, ["-c", PY_HELPER, JSON.stringify(payload)], {
      env,
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
        } catch (e) {
          return reject(new Error(`agent-recall returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} agent-recall helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    scope: safeStoreName(b?.store),
    fact: String(b?.fact ?? ""),
    entity: "__ambient_memory__",
  });
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "query",
    db,
    scope: safeStoreName(b?.store),
    question: String(b?.question ?? ""),
    limit: Number(b?.top_k || 8),
  });
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
  collection: async () => ({ supported: false, size: 0 }),
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
  const pkg = PACKAGE_PATH ? ` package=${PACKAGE_PATH}` : "";
  console.log(`${NAME} adapter on 127.0.0.1:${PORT} using ${PYTHON}${pkg}`);
});
