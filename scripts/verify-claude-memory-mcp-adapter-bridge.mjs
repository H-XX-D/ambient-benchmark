#!/usr/bin/env node
// No-dependency smoke for adapters/claude-memory-mcp-cli-adapter.mjs.
//
// Creates a tiny mock `claude-memory-mcp` executable, starts the AMBIENT bridge
// against it, then verifies /write, /query, and reset DB isolation.

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

async function makeMockMemoryBin() {
  const dir = await mkdtemp(join(tmpdir(), "ambient-claude-memory-mock-"));
  const bin = join(dir, "claude-memory-mcp");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const db = process.env.CLAUDE_MEMORY_DB_PATH;
if (!db) {
  console.error("CLAUDE_MEMORY_DB_PATH required");
  process.exit(2);
}
fs.mkdirSync(path.dirname(db), { recursive: true });
let state = [];
if (fs.existsSync(db)) state = JSON.parse(fs.readFileSync(db, "utf8") || "[]");
const cmd = process.argv[2];
function flag(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : "";
}
if (cmd === "save") {
  const type = flag("type") || "snapshot";
  const title = flag("title");
  const summary = flag("summary");
  const project = flag("project");
  const id = (type === "decision" ? "dec-" : "snap-") + (state.length + 1);
  state.push({ id, type, title, summary, project });
  fs.writeFileSync(db, JSON.stringify(state, null, 2));
  console.log("Saved " + id + " (" + title + ")");
  process.exit(0);
}
if (cmd === "search") {
  const q = process.argv.slice(3).join(" ").toLowerCase();
  const terms = q.match(/[a-z0-9_-]{3,}/g) || [];
  const hits = state.filter((row) => {
    const hay = [row.title, row.summary, row.project].join(" ").toLowerCase();
    return terms.length === 0 || terms.some((t) => hay.includes(t));
  });
  if (!hits.length) {
    console.log("No continuity artifacts found.");
    process.exit(0);
  }
  for (const row of hits) {
    console.log(row.id + " " + row.type + " " + row.title + " :: " + row.summary + (row.project ? " [project:" + row.project + "]" : ""));
  }
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
  const { bin } = await makeMockMemoryBin();
  const roots = await mkdtemp(join(tmpdir(), "ambient-claude-memory-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/claude-memory-mcp-cli-adapter.mjs",
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
    if (name.name !== "claude-memory-mcp-cli") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "claude-memory-mcp keeps local continuity snapshots in SQLite",
      source: "smoke",
    });
    if (!write.accepted || !existsSync(write.db)) {
      throw new Error(`mock continuity DB was not created: ${JSON.stringify(write)}`);
    }
    const stored = await readFile(write.db, "utf8");
    if (!stored.includes("local continuity snapshots")) throw new Error("mock continuity DB was not written");

    const hit = await post(base, "/query", { store: "custom", question: "Which memory keeps continuity snapshots?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("claude-memory-mcp"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "continuity snapshots", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate DB path: ${JSON.stringify(miss)}`);
    }
    console.log("claude-memory-mcp bridge smoke: write/query/reset isolated continuity DB verified");
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
