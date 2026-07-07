#!/usr/bin/env node
// No-dependency smoke for adapters/engram-cli-adapter.mjs.
//
// Creates a tiny mock `engram` executable, starts the AMBIENT bridge against it,
// then verifies /write, /query, and reset ENGRAM_DATA_DIR isolation.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function makeMockEngram() {
  const dir = await mkdtemp(join(tmpdir(), "ambient-engram-mock-"));
  const bin = join(dir, "engram");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dataDir = process.env.ENGRAM_DATA_DIR;
if (!dataDir) {
  console.error("ENGRAM_DATA_DIR required");
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
const db = path.join(dataDir, "engram.json");
let state = [];
if (fs.existsSync(db)) state = JSON.parse(fs.readFileSync(db, "utf8") || "[]");
const cmd = process.argv[2];
function flag(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : "";
}
if (cmd === "save") {
  const title = process.argv[3] || "";
  const content = process.argv[4] || "";
  const type = flag("type") || "manual";
  const project = flag("project") || "";
  const scope = flag("scope") || "project";
  const id = state.length + 1;
  state.push({ id, type, title, content, project, scope, created: "2026-07-06 00:00" });
  fs.writeFileSync(db, JSON.stringify(state, null, 2));
  console.log("Memory saved: #" + id + " \\"" + title + "\\" (" + type + ")");
  process.exit(0);
}
if (cmd === "search") {
  const queryParts = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) { i++; continue; }
    queryParts.push(process.argv[i]);
  }
  const q = queryParts.join(" ").toLowerCase();
  const project = flag("project");
  const scope = flag("scope");
  const limit = Number(flag("limit") || 10);
  const terms = q.match(/[a-z0-9_.-]{3,}/g) || [];
  const hits = state.filter((row) => {
    if (project && row.project !== project) return false;
    if (scope && row.scope !== scope) return false;
    const hay = [row.title, row.content].join(" ").toLowerCase();
    return terms.length === 0 || terms.every((t) => hay.includes(t));
  }).slice(0, limit);
  if (!hits.length) {
    console.log("No memories found for: " + JSON.stringify(q));
    process.exit(0);
  }
  console.log("Found " + hits.length + " memories:\\n");
  hits.forEach((row, idx) => {
    console.log("[" + (idx + 1) + "] #" + row.id + " (" + row.type + ") — " + row.title);
    console.log("    " + row.content);
    console.log("    " + row.created + " | project: " + row.project + " | scope: " + row.scope + "\\n");
  });
  process.exit(0);
}
console.error("unsupported mock command: " + process.argv.slice(2).join(" "));
process.exit(2);
`, "utf8");
  await chmod(bin, 0o755);
  return { dir, bin };
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
  const { bin } = await makeMockEngram();
  const roots = await mkdtemp(join(tmpdir(), "ambient-engram-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/engram-cli-adapter.mjs",
      "--bin",
      bin,
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
    if (name.name !== "engram-cli") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "engram stores local coding-agent memories in SQLite with FTS search",
      source: "smoke",
    });
    const db = join(write.dataDir, "engram.json");
    if (!write.accepted || !existsSync(db)) {
      throw new Error(`mock engram DB was not created: ${JSON.stringify(write)}`);
    }
    const stored = await readFile(db, "utf8");
    if (!stored.includes("SQLite with FTS search")) throw new Error("mock engram DB was not written");

    const hit = await post(base, "/query", { store: "custom", question: "Which memory has FTS search?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("engram"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "engram FTS search", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate ENGRAM_DATA_DIR: ${JSON.stringify(miss)}`);
    }
    console.log("engram bridge smoke: write/query/reset isolated ENGRAM_DATA_DIR verified");
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
