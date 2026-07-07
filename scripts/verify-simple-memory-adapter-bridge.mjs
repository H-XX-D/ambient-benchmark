#!/usr/bin/env node
// No-dependency smoke for adapters/simple-memory-cli-adapter.mjs.
//
// Creates a tiny mock `simple-memory` executable, starts the AMBIENT bridge
// against it, then verifies /write, /query, and reset MEMORY_DB isolation.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

async function makeMockSimpleMemory() {
  const dir = await mkdtemp(join(tmpdir(), "ambient-simple-memory-mock-"));
  const bin = join(dir, "simple-memory");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const db = process.env.MEMORY_DB;
if (!db) {
  console.error("MEMORY_DB required");
  process.exit(2);
}
fs.mkdirSync(path.dirname(db), { recursive: true });
const readRows = () => fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8") || "[]") : [];
const writeRows = (rows) => fs.writeFileSync(db, JSON.stringify(rows, null, 2));
const args = process.argv.slice(2);
const cmd = args[0];
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : "";
};
if (cmd === "store") {
  const content = valueAfter("--content");
  const tags = valueAfter("--tags").split(",").filter(Boolean);
  const rows = readRows();
  const hash = "smem_" + Buffer.from(content).toString("hex").slice(0, 14);
  rows.push({ hash, content, title: content.slice(0, 80), tags, createdAt: "2026-07-06T00:00:00Z" });
  writeRows(rows);
  console.log(JSON.stringify({ data: { store: { success: true, hash } } }));
  process.exit(0);
}
if (cmd === "search") {
  const query = valueAfter("--query").toLowerCase();
  const limit = Number(valueAfter("--limit") || 10);
  const terms = query.split(/\\s+/).filter((w) => w.length > 2);
  const memories = readRows()
    .filter((row) => terms.some((term) => row.content.toLowerCase().includes(term) || row.tags.join(" ").toLowerCase().includes(term)))
    .slice(0, limit)
    .map((row, i) => ({ ...row, relevance: 1 - i / 10 }));
  console.log(JSON.stringify({ data: { memories } }));
  process.exit(0);
}
console.error("unsupported mock command: " + args.join(" "));
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
  const { bin } = await makeMockSimpleMemory();
  const roots = await mkdtemp(join(tmpdir(), "ambient-simple-memory-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/simple-memory-cli-adapter.mjs",
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
    if (name.name !== "simple-memory-cli") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "simple-memory-mcp stores local SQLite keyword memories without cloud services",
      source: "smoke",
    });
    if (!existsSync(write.db)) throw new Error(`mock MEMORY_DB was not created: ${write.db}`);
    const rows = await readFile(write.db, "utf8");
    if (!rows.includes("without cloud services")) throw new Error("mock simple-memory was not written");

    const hit = await post(base, "/query", { store: "custom", question: "Which memory stores local SQLite?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("simple-memory-mcp"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "simple-memory SQLite cloud", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate MEMORY_DB: ${JSON.stringify(miss)}`);
    }
    console.log("simple-memory bridge smoke: write/query/reset isolated MEMORY_DB verified");
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
