#!/usr/bin/env node
// Smoke for adapters/agent-recall-python-adapter.mjs.
//
// Runs the bridge against a local source checkout of mnardit/agent-recall,
// then verifies /write, /query, and reset SQLite DB isolation.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKAGE_PATH = "/tmp/ambient-agent-recall";

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
  const packagePath = process.env.AMBIENT_AGENT_RECALL_TEST_PACKAGE_PATH || DEFAULT_PACKAGE_PATH;
  if (!existsSync(join(packagePath, "agent_recall", "store.py"))) {
    throw new Error(`agent-recall source checkout missing: ${packagePath}`);
  }
  const roots = await mkdtemp(join(tmpdir(), "ambient-agent-recall-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/agent-recall-python-adapter.mjs",
      "--package-path",
      packagePath,
      "--root",
      roots,
      "--port",
      String(port),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForAdapter(port);
    const base = `http://127.0.0.1:${port}`;
    const name = await (await fetch(base + "/name")).json();
    if (name.name !== "agent-recall-python") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "agent-recall keeps local SQLite graph observations with scoped memory",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) throw new Error(`agent-recall DB was not created: ${JSON.stringify(write)}`);

    const hit = await post(base, "/query", { store: "custom", question: "Which memory has scoped graph observations?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("agent-recall"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "agent-recall scoped graph observations", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate SQLite DB: ${JSON.stringify(miss)}`);
    }
    console.log("agent-recall bridge smoke: write/query/reset isolated SQLite DB verified");
  } finally {
    bridge.kill("SIGTERM");
    if (bridge.exitCode == null && !bridge.killed) bridge.kill("SIGKILL");
    await Promise.race([once(bridge, "exit"), new Promise((r) => setTimeout(r, 500))]);
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
