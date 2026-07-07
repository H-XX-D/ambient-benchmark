#!/usr/bin/env node
// AMBIENT wire-protocol bridge for BAI-LAB/MemoryOS (https://github.com/BAI-LAB/MemoryOS).
//
// MemoryOS is an OpenAI-compatible, embedding-backed memory operating system. Install the
// PyPI build (distribution name "memoryos-pro", import name "memoryos"), then run:
//   pip install memoryos-pro
//   npm run adapter:memoryos -- --port 8114
//
// It needs an OpenAI-compatible key in OPENAI_API_KEY, and optionally OPENAI_BASE_URL to
// point at a local or self-hosted OpenAI-compatible endpoint. It also loads a
// sentence-transformers embedding model (library default "all-MiniLM-L6-v2"; override with
// AMBIENT_MEMORYOS_EMBEDDING_MODEL, e.g. "BAAI/bge-m3"); the first run downloads it. The
// chat model can be picked with AMBIENT_MEMORYOS_LLM_MODEL (library default "gpt-4o-mini").
//
// For source-checkout testing, pass:
//   --package-path /path/to/checkout   (a directory that contains the "memoryos" package)
//
// Each AMBIENT store gets an isolated data_storage_path directory. Reset rotates that
// directory, so benchmark runs never mutate a prior store's memory on disk.
//
// Retrieval note (contract-critical): the query path uses MemoryOS's RAW retrieval surface,
// memo.retriever.retrieve_context(...) plus memo.short_term_memory.get_all(). Those return
// stored dialogue pages and extracted knowledge verbatim, so every served item is
// origin:"external" per the AMBIENT contract. We deliberately do NOT call memo.get_response(),
// because that synthesizes an answer with the LLM: a synthesized answer is model-origin, so it
// could never complete a segment. retrieve_context only reads mid-term pages plus long-term
// user/assistant knowledge, so we also read short-term memory, where a just-written fact lives
// before it is evicted into the mid-term tier.

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
import uuid

# MemoryOS and its embedding backend can print progress/info to stdout. Route ALL of that to
# stderr so our real stdout carries exactly one JSON line for the bridge to parse.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

from memoryos import Memoryos


def emit(obj):
    _real_stdout.write(json.dumps(obj))
    _real_stdout.flush()


payload = json.loads(sys.argv[1])
op = payload["op"]
data_path = payload["db"]
scope = payload.get("scope") or "ambient"
top_k = int(payload.get("limit") or 8)


def build_memory():
    kwargs = {
        "user_id": scope,
        "openai_api_key": os.environ.get("OPENAI_API_KEY") or "",
        "data_storage_path": data_path,
        "assistant_id": "ambient",
    }
    base_url = os.environ.get("OPENAI_BASE_URL")
    if base_url:
        kwargs["openai_base_url"] = base_url
    llm_model = os.environ.get("AMBIENT_MEMORYOS_LLM_MODEL")
    if llm_model:
        kwargs["llm_model"] = llm_model
    embedding_model = os.environ.get("AMBIENT_MEMORYOS_EMBEDDING_MODEL")
    if embedding_model:
        kwargs["embedding_model_name"] = embedding_model
    return Memoryos(**kwargs)


def page_text(page):
    if isinstance(page, dict):
        ui = str(page.get("user_input") or "").strip()
        ar = str(page.get("agent_response") or "").strip()
        parts = [p for p in (ui, ar) if p]
        return " ".join(parts) if parts else ""
    return str(page or "").strip()


def page_time(page):
    if isinstance(page, dict):
        return page.get("timestamp") or None
    return None


def knowledge_text(entry):
    if isinstance(entry, dict):
        return str(entry.get("knowledge") or "").strip()
    return str(entry or "").strip()


def knowledge_time(entry):
    if isinstance(entry, dict):
        return entry.get("timestamp") or None
    return None


memo = build_memory()

if op == "write":
    fact = (payload.get("fact") or "").strip()
    if not fact:
        emit({"accepted": False, "reason": "empty fact"})
        sys.exit(0)
    # MemoryOS is conversation-shaped: store the fact as the user turn with an empty agent turn.
    memo.add_memory(user_input=fact, agent_response="")
    emit({"accepted": True, "id": uuid.uuid4().hex, "db": data_path})
elif op == "query":
    question = payload.get("question") or ""
    support = []
    provenance = []
    seen = set()

    def add(text, ident, tier, ts):
        if not text or text in seen:
            return
        seen.add(text)
        support.append(text)
        provenance.append({
            "id": ident,
            "origin": "external",
            "source": "memoryos:" + tier,
            "writtenAt": ts,
            "score": 0,
        })

    # 1) Short-term memory: a just-written fact lives here before eviction to mid-term. Newest
    #    first, so recent writes survive the top_k cap. This is raw stored text, not synthesized.
    try:
        recent = list(memo.short_term_memory.get_all() or [])
    except Exception:
        recent = []
    recent.reverse()
    for i, page in enumerate(recent):
        add(page_text(page), "short_term:" + str(i), "short_term", page_time(page))

    # 2) RAW retrieval over mid-term pages plus long-term user/assistant knowledge. No LLM call.
    try:
        ctx = memo.retriever.retrieve_context(
            user_query=question,
            user_id=scope,
            top_k_sessions=top_k,
            top_k_knowledge=top_k,
        )
    except Exception:
        ctx = {}
    for i, page in enumerate(ctx.get("retrieved_pages") or []):
        add(page_text(page), "mid_term:" + str(i), "mid_term", page_time(page))
    for i, entry in enumerate(ctx.get("retrieved_user_knowledge") or []):
        add(knowledge_text(entry), "user_knowledge:" + str(i), "user_knowledge", knowledge_time(entry))
    for i, entry in enumerate(ctx.get("retrieved_assistant_knowledge") or []):
        add(knowledge_text(entry), "assistant_knowledge:" + str(i), "assistant_knowledge", knowledge_time(entry))

    if top_k and len(support) > top_k:
        support = support[:top_k]
        provenance = provenance[:top_k]

    emit({"support": support, "provenance": provenance})
else:
    raise SystemExit("unsupported op: " + str(op))
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "memoryos";
const PORT = Number(arg("port", process.env.PORT || "8114"));
const PYTHON = arg("python", process.env.AMBIENT_MEMORYOS_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_MEMORYOS_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_MEMORYOS_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-memoryos-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
}

async function storeDb(store = "default") {
  // MemoryOS persists into a data_storage_path directory (not a single file), so each store
  // maps to its own isolated directory here.
  const dir = join(await baseRoot(), storeKey(store));
  await mkdir(dir, { recursive: true });
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
          return reject(new Error(`memoryos returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} memoryos helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
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
