#!/usr/bin/env node
// AMBIENT wire-protocol bridge for mem0ai/mem0.
//
// This bridge does not vendor mem0. Install it locally, then run:
//   pip install mem0ai
//   npm run adapter:mem0 -- --port 8110
//
// mem0 needs a backend to run its llm plus embedder plus vector store. Pick one:
//   1. Default: set OPENAI_API_KEY and let mem0 use its built in OpenAI llm and
//      embedder and its default local vector store (Memory()).
//   2. Local or OSS: set MEM0_CONFIG_JSON to a full mem0 config dict encoded as
//      JSON, for example
//        {"llm":{"provider":"ollama","config":{...}},
//         "embedder":{"provider":"ollama","config":{...}},
//         "vector_store":{"provider":"chroma","config":{"path":"db"}}}
//      It is handed straight to Memory.from_config(...). No OPENAI_API_KEY needed.
//
// Each AMBIENT store gets its own directory. In config mode the store's vector
// store path and history db are templated into that directory, so separate runs
// never share on disk state. In default mode mem0 keeps its own fixed on disk
// location, so we cannot template it. There we isolate by per store user_id and
// rotate that user_id on reset, so a reset run cannot read a prior run's memories.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import json
import os
import sys

from mem0 import Memory


def build_memory(store_dir):
    config_json = os.environ.get("MEM0_CONFIG_JSON")
    if config_json:
        config = json.loads(config_json)
        # Isolate this AMBIENT store on disk when feasible by templating any
        # configured vector store path and the history db into store_dir.
        try:
            os.makedirs(store_dir, exist_ok=True)
            vs = config.get("vector_store")
            if isinstance(vs, dict):
                vs_config = vs.get("config")
                if isinstance(vs_config, dict) and "path" in vs_config:
                    vs_config["path"] = os.path.join(store_dir, "vector")
            # history_db_path is a top level MemoryConfig field in current mem0.
            config["history_db_path"] = os.path.join(store_dir, "history.db")
        except Exception:
            pass
        return Memory.from_config(config)
    # Default backend. Needs OPENAI_API_KEY. On disk isolation is not feasible
    # here (no config to template), so we lean on the rotating user_id instead.
    return Memory()


def to_results(payload):
    # add() and search() return {"results": [...]} in current mem0. Some older
    # releases return a bare list. Normalize both to a list.
    if isinstance(payload, dict):
        return payload.get("results") or []
    if isinstance(payload, list):
        return payload
    return []


def run_search(memory, question, scope, limit):
    # Current mem0 (2.x) takes filters={"user_id": ...} plus top_k. Older
    # releases took user_id= plus limit=. Try current first, then fall back.
    try:
        return memory.search(question, filters={"user_id": scope}, top_k=limit)
    except TypeError:
        return memory.search(question, user_id=scope, limit=limit)


payload = json.loads(sys.argv[1])
op = payload["op"]
store_dir = payload["db"]
scope = payload.get("scope") or "ambient"

memory = build_memory(store_dir)

if op == "write":
    fact = (payload.get("fact") or "").strip()
    if not fact:
        print(json.dumps({"accepted": False, "reason": "empty fact"}))
        sys.exit(0)
    added = to_results(memory.add(fact, user_id=scope))
    first_id = None
    if added and isinstance(added[0], dict):
        first_id = added[0].get("id")
    print(json.dumps({"accepted": True, "id": first_id, "db": store_dir}))
elif op == "query":
    question = payload.get("question") or ""
    limit = int(payload.get("limit") or 8)
    found = to_results(run_search(memory, question, scope, limit))
    support = []
    provenance = []
    for item in found:
        if not isinstance(item, dict):
            continue
        text = item.get("memory") or ""
        if not text:
            continue
        support.append(text)
        provenance.append({
            "id": str(item.get("id") or ""),
            "origin": "external",
            "source": "mem0:memory",
            "writtenAt": None,
            "score": item.get("score"),
        })
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

const NAME = "mem0";
const PORT = Number(arg("port", process.env.PORT || "8110"));
const PYTHON = arg("python", process.env.AMBIENT_MEM0_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_MEM0_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_MEM0_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-mem0-"));
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
  // mem0 keeps a directory per store (vector store plus history db), not a
  // single file, so the store's isolation unit is this directory.
  return dir;
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
          return reject(new Error(`mem0 returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} mem0 helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "write",
    db,
    scope: storeKey(b?.store),
    fact: String(b?.fact ?? ""),
  });
}

async function queryMemory(b) {
  const db = await storeDb(b?.store);
  return runPython({
    op: "query",
    db,
    scope: storeKey(b?.store),
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
