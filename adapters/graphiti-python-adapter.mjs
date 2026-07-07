#!/usr/bin/env node
// AMBIENT wire-protocol bridge for getzep/graphiti.
//
// This bridge does not vendor graphiti. Install it locally, then run:
//   pip install graphiti-core
//   npm run adapter:graphiti -- --port 8112
//
// This is the heaviest-setup adapter in this repo. graphiti needs a running graph
// database plus a live LLM for entity and edge extraction on every write. Before
// starting this bridge:
//   1. Run Neo4j (Desktop, Docker, or Aura) and set NEO4J_URI, NEO4J_USER, and
//      NEO4J_PASSWORD in the environment. NEO4J_URI defaults to
//      bolt://localhost:7687 and NEO4J_USER defaults to neo4j here if unset;
//      there is no safe default for NEO4J_PASSWORD.
//   2. Set OPENAI_API_KEY. graphiti_core's default LLM client and embedder are
//      both OpenAI backed, and add_episode() calls the LLM on every write to
//      extract entities and edges into the graph, so expect slow, billable calls.
//
// For source-checkout testing, pass:
//   --package-path /path/to/graphiti
//
// Isolation: graphiti keeps no per-store local file or directory the way the
// SQLite based adapters in this repo do; everything lives in the shared Neo4j
// database. Each AMBIENT store is isolated instead by a group_id (graphiti's
// graph partition key), derived from the rotating store key below. Neo4j data
// persists across runs and is never dropped here; reset() only rotates the
// group_id, so a reset run cannot read a prior run's facts even though the
// underlying database itself is untouched.

import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const PY_HELPER = String.raw`
import asyncio
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone

from graphiti_core import Graphiti
from graphiti_core.nodes import EpisodeType


def _safe_group_id(scope):
    # graphiti_core.helpers.validate_group_id only allows ASCII letters, digits,
    # dashes, and underscores, and raises GroupIdValidationError otherwise. The
    # AMBIENT store key can contain dots (see safeStoreName in this bridge's JS
    # half), so re-sanitize before using it as a Neo4j group_id.
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", scope or "")
    return cleaned or "ambient"


def _iso(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.isoformat()
    except AttributeError:
        return None


async def _close(client):
    # Guard with getattr/callable in case a future graphiti_core release renames
    # or drops close(); cleanup should never mask a successful op.
    closer = getattr(client, "close", None)
    if callable(closer):
        try:
            await closer()
        except Exception:
            pass


async def main():
    payload = json.loads(sys.argv[1])
    op = payload["op"]
    scope = _safe_group_id(payload.get("scope") or "ambient")

    neo4j_uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
    neo4j_password = os.environ.get("NEO4J_PASSWORD", "")

    client = Graphiti(neo4j_uri, neo4j_user, neo4j_password)
    try:
        try:
            # Neo4j-side index and constraint creation uses IF NOT EXISTS and is
            # already race tolerant, but this helper is a fresh process per call,
            # so guard it anyway: a transient failure here should not fail the
            # write or query itself.
            await client.build_indices_and_constraints()
        except Exception:
            pass

        if op == "write":
            fact = (payload.get("fact") or "").strip()
            if not fact:
                print(json.dumps({"accepted": False, "reason": "empty fact"}))
                return
            episode_name = re.sub(r"\s+", " ", fact).strip()[:80] or "ambient-episode"
            await client.add_episode(
                name=episode_name,
                episode_body=fact,
                source=EpisodeType.text,
                source_description="ambient",
                reference_time=datetime.now(timezone.utc),
                group_id=scope,
            )
            # graphiti has no local db file or receipt id worth surfacing here,
            # so both id and db report the group_id that isolates this store.
            print(json.dumps({"accepted": True, "id": scope, "db": scope}))
        elif op == "query":
            question = payload.get("question") or ""
            limit = int(payload.get("limit") or 8)
            edges = await client.search(question, group_ids=[scope], num_results=limit)
            support = []
            provenance = []
            for edge in edges or []:
                edge_fact = (getattr(edge, "fact", None) or "").strip()
                if not edge_fact:
                    continue
                written_at = getattr(edge, "valid_at", None) or getattr(edge, "created_at", None)
                support.append(edge_fact)
                provenance.append({
                    "id": str(getattr(edge, "uuid", None) or uuid.uuid4()),
                    "origin": "external",
                    "source": "graphiti:edge",
                    "writtenAt": _iso(written_at),
                    # graphiti's basic search() returns EntityEdge objects with no
                    # similarity score attached (unlike the advanced search_()
                    # method), so this stays 0 unless a future release adds one.
                    "score": getattr(edge, "score", 0) or 0,
                })
                if len(support) >= limit:
                    break
            print(json.dumps({"support": support, "provenance": provenance}))
        else:
            raise SystemExit("unsupported op: %s" % op)
    finally:
        await _close(client)


if __name__ == "__main__":
    asyncio.run(main())
`;

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const NAME = "graphiti";
const PORT = Number(arg("port", process.env.PORT || "8112"));
const PYTHON = arg("python", process.env.AMBIENT_GRAPHITI_PYTHON || process.env.PYTHON || "python3");
const PACKAGE_PATH = arg("package-path", process.env.AMBIENT_GRAPHITI_PACKAGE_PATH || "");
const BASE_ROOT = arg("root", process.env.AMBIENT_GRAPHITI_ROOT || "");

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
  if (!allocatedBaseRoot) allocatedBaseRoot = await mkdtemp(join(tmpdir(), "ambient-graphiti-"));
  return allocatedBaseRoot;
}

function storeKey(store = "default") {
  const key = safeStoreName(store);
  if (!storeRuns.has(key)) storeRuns.set(key, 0);
  return `${runId}-${key}-${storeRuns.get(key)}`;
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

async function storeScope(store = "default") {
  // graphiti keeps no local file or directory (all data lives in Neo4j), so
  // there is nothing to place under baseRoot(). It is still called here so
  // --root/AMBIENT_GRAPHITI_ROOT behave the same as every other adapter (fails
  // fast if the path is not creatable), even though this bridge writes nothing
  // under it. The rotating store key is the real isolation unit: PY_HELPER
  // sanitizes it into the Neo4j group_id.
  await baseRoot();
  return storeKey(store);
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
          return reject(new Error(`graphiti returned non-JSON output: ${String(stdout).slice(0, 240)}`));
        }
      }
      reject(new Error(`${PYTHON} graphiti helper exited ${code}: ${stderr || stdout}`.slice(0, 600)));
    });
  });
}

async function writeMemory(b) {
  const scope = await storeScope(b?.store);
  return runPython({
    op: "write",
    scope,
    fact: String(b?.fact ?? ""),
  });
}

async function queryMemory(b) {
  const scope = await storeScope(b?.store);
  return runPython({
    op: "query",
    scope,
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
