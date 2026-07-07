#!/usr/bin/env node
// AMBIENT wire-protocol bridge for topoteretes/cognee.
//
// This bridge does not vendor cognee. Install it locally, then run:
//   pip install cognee
//   npm run adapter:cognee -- --port 8111
//
// cognee needs an LLM configured. Set LLM_API_KEY (or OPENAI_API_KEY), or point it
// at a local model per the cognee docs (https://docs.cognee.ai). cognify() is
// LLM-heavy: it runs the model to build a knowledge graph on every write, so expect
// slow, billable calls.
//
// For source-checkout testing, pass:
//   --package-path /path/to/cognee
//
// Each AMBIENT store gets isolated cognee data + system directories. Reset rotates
// those directories, so benchmark runs do not mutate a shared cognee graph on disk.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import asyncio
import json
import sys
import uuid

import cognee


def _extract_text(item):
    # cognee search results (SearchType.CHUNKS) are payload dicts with a "text"
    # key, but may also arrive as objects with a .payload dict or as plain
    # strings. Extract defensively across all of those shapes.
    if item is None:
        return ""
    if isinstance(item, str):
        return item.strip()
    keys = ("text", "chunk", "content", "value", "answer", "name", "description")
    if isinstance(item, dict):
        for key in keys:
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        payload = item.get("payload")
        if isinstance(payload, dict):
            for key in keys:
                val = payload.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
        return ""
    for key in keys:
        val = getattr(item, key, None)
        if isinstance(val, str) and val.strip():
            return val.strip()
    payload = getattr(item, "payload", None)
    if isinstance(payload, dict):
        for key in keys:
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    text = str(item).strip()
    return text


def _extract_id(item, fallback):
    id_keys = ("id", "chunk_id", "uuid", "document_id", "node_id")
    if isinstance(item, dict):
        for key in id_keys:
            val = item.get(key)
            if val:
                return str(val)
        payload = item.get("payload")
        if isinstance(payload, dict):
            for key in id_keys:
                val = payload.get(key)
                if val:
                    return str(val)
    else:
        for key in id_keys:
            val = getattr(item, key, None)
            if val:
                return str(val)
        payload = getattr(item, "payload", None)
        if isinstance(payload, dict):
            for key in id_keys:
                val = payload.get(key)
                if val:
                    return str(val)
    return fallback


def _extract_score(item):
    score_keys = ("score", "distance", "similarity", "relevance")
    if isinstance(item, dict):
        for key in score_keys:
            val = item.get(key)
            if isinstance(val, (int, float)):
                return val
        payload = item.get("payload")
        if isinstance(payload, dict):
            for key in score_keys:
                val = payload.get(key)
                if isinstance(val, (int, float)):
                    return val
    else:
        for key in score_keys:
            val = getattr(item, key, None)
            if isinstance(val, (int, float)):
                return val
    return 0


async def _search(question, limit):
    # Prefer CHUNKS (raw retrieval). Fall back to INSIGHTS when it exists in this
    # cognee version and CHUNKS returned nothing. Both are guarded so an empty or
    # uninitialized store returns [] instead of raising.
    for type_name in ("CHUNKS", "INSIGHTS"):
        query_type = getattr(cognee.SearchType, type_name, None)
        if query_type is None:
            continue
        try:
            results = await cognee.search(query_text=question, query_type=query_type)
        except Exception:
            results = []
        support = []
        provenance = []
        for item in results or []:
            text = _extract_text(item)
            if not text:
                continue
            support.append(text)
            provenance.append({
                "id": _extract_id(item, str(uuid.uuid4())),
                "origin": "external",
                "source": "cognee:chunk",
                "writtenAt": None,
                "score": _extract_score(item),
            })
            if len(support) >= limit:
                break
        if support:
            return support, provenance
    return [], []


async def main():
    payload = json.loads(sys.argv[1])
    op = payload["op"]
    scope = payload.get("scope") or "ambient"
    data_dir = payload.get("data")
    system_dir = payload.get("system")
    db_path = payload.get("db")

    # Isolate this store on disk: cognee reads these globally, and each helper
    # invocation is a fresh process, so per-store dirs keep graphs from mixing.
    if data_dir:
        cognee.config.data_root_directory(data_dir)
    if system_dir:
        cognee.config.system_root_directory(system_dir)

    if op == "write":
        fact = (payload.get("fact") or "").strip()
        if not fact:
            print(json.dumps({"accepted": False, "reason": "empty fact"}))
            return
        await cognee.add(fact, dataset_name=scope)
        await cognee.cognify([scope])
        print(json.dumps({"accepted": True, "id": str(uuid.uuid4()), "db": db_path}))
    elif op == "query":
        question = payload.get("question") or ""
        limit = int(payload.get("limit") or 8)
        support, provenance = await _search(question, limit)
        print(json.dumps({"support": support, "provenance": provenance}))
    else:
        raise SystemExit("unsupported op: %s" % op)


if __name__ == "__main__":
    asyncio.run(main())
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "cognee";
const PORT = Number(arg("port", process.env.PORT || "8111"));
const PYTHON = arg("python", process.env.AMBIENT_COGNEE_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_COGNEE_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_COGNEE_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-cognee-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeDirs(store = "default") {
  const dir = join(await baseRoot(), storeKey(store));
  const data = join(dir, "data");
  const system = join(dir, "system");
  await mkdir(data, { recursive: true });
  await mkdir(system, { recursive: true });
  return { dir, data, system };
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
          return reject(new Error(`cognee returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} cognee helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const { dir, data, system } = await storeDirs(b?.store);
  return runPython({
    op: "write",
    db: dir,
    data,
    system,
    scope: safeStoreName(b?.store),
    fact: String(b?.fact ?? ""),
  });
}

async function queryMemory(b) {
  const { dir, data, system } = await storeDirs(b?.store);
  return runPython({
    op: "query",
    db: dir,
    data,
    system,
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
