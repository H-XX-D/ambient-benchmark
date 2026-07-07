#!/usr/bin/env node
// No-dependency smoke for adapters/ai-memory-http-adapter.mjs.
//
// Starts a tiny mock of alphaonedev/ai-memory-mcp's HTTP API, starts the
// AMBIENT bridge against it, then verifies AMBIENT /write and /query map to
// /api/v1/memories and /api/v1/search with per-store namespace isolation.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function readJson(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

function send(res, body, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockAiMemory() {
  const rows = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/v1/health") {
      return send(res, { status: "ok", service: "ai-memory" });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/memories") {
      const body = await readJson(req);
      const row = { id: `m${rows.length}`, created_at: "2026-07-06T00:00:00Z", ...body };
      rows.push(row);
      return send(res, { id: row.id, tier: row.tier, namespace: row.namespace, title: row.title }, 201);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const namespace = url.searchParams.get("namespace") || "";
      const limit = Number(url.searchParams.get("limit") || "20");
      const terms = q.split(/\s+/).filter((w) => w.length > 2);
      const results = rows
        .filter((r) => r.namespace === namespace)
        .filter((r) => terms.some((t) => `${r.title} ${r.content}`.toLowerCase().includes(t)))
        .slice(0, limit)
        .map((r, i) => ({ ...r, score: 1 - i / 10 }));
      return send(res, { results, count: results.length, query: q });
    }
    return send(res, { error: "not found" }, 404);
  });
  const port = await listen(server);
  return { server, port };
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return data;
}

async function waitForAdapter(port) {
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/name`);
      if (res.ok) return;
      lastErr = new Error(`/name ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error("adapter did not start");
}

async function main() {
  const { server: target, port: targetPort } = await startMockAiMemory();
  const bridgeServer = createServer();
  const bridgePort = await listen(bridgeServer);
  await new Promise((resolve) => bridgeServer.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/ai-memory-http-adapter.mjs",
      "--target",
      `http://127.0.0.1:${targetPort}`,
      "--port",
      String(bridgePort),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForAdapter(bridgePort);
    const base = `http://127.0.0.1:${bridgePort}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "ai-memory-search") throw new Error(`unexpected name ${JSON.stringify(name)}`);
    await post(base, "/reset", { store: "custom" });
    await post(base, "/write", { store: "custom", fact: "projectmem is local-first and has no telemetry", source: "smoke" });
    const hit = await post(base, "/query", { store: "custom", question: "Which memory has telemetry?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("projectmem"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }
    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "projectmem telemetry", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate namespace: ${JSON.stringify(miss)}`);
    }
    console.log("ai-memory bridge smoke: write/query/reset namespace isolation verified");
  } finally {
    bridge.kill("SIGTERM");
    target.close();
    if (bridge.exitCode == null && !bridge.killed) bridge.kill("SIGKILL");
    await Promise.race([once(bridge, "exit"), new Promise((r) => setTimeout(r, 500))]);
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
