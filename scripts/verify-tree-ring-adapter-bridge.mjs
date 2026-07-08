#!/usr/bin/env node
// No-dependency smoke for adapters/tree-ring-cli-adapter.mjs.
//
// Creates a tiny mock `tree-ring` executable, starts the AMBIENT bridge against
// it, then verifies /write, /query, and reset root isolation.

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

async function makeMockTreeRing() {
  const dir = await mkdtemp(join(tmpdir(), "ambient-tree-ring-mock-"));
  const bin = join(dir, "tree-ring");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const valueAfter = (flag, def = "") => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const valuesAfter = (flag) => {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
};
const positional = () => {
  const out = [];
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const needsValue = !["--json", "--include-sensitive"].includes(args[i]);
      if (needsValue) i += 1;
    } else {
      out.push(args[i]);
    }
  }
  return out;
};
const cmd = args[0];
const root = valueAfter("--root");
if (!root) {
  console.error("--root required");
  process.exit(2);
}
const db = path.join(root, "memory.json");
fs.mkdirSync(root, { recursive: true });
const readRows = () => fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, "utf8") || "[]") : [];
const writeRows = (rows) => fs.writeFileSync(db, JSON.stringify(rows, null, 2));
if (cmd === "init") {
  writeRows(readRows());
  console.log(JSON.stringify({ ok: true, root, sqlite_path: path.join(root, "memory.sqlite") }));
  process.exit(0);
}
if (cmd === "remember") {
  const fact = positional().join(" ");
  if (/secret-like/i.test(fact)) {
    console.error("secret-like memory is blocked by policy");
    process.exit(2);
  }
  const rows = readRows();
  const id = "mem_" + Buffer.from(fact).toString("hex").slice(0, 16);
  const event = {
    id,
    created_at: "2026-07-06T00:00:00Z",
    project: valueAfter("--project"),
    scope: valueAfter("--scope", "eval"),
    event_type: valueAfter("--event-type", "observation"),
    summary: fact,
    details: "",
    tags: valuesAfter("--tag")
  };
  rows.push(event);
  writeRows(rows);
  console.log(JSON.stringify(event));
  process.exit(0);
}
if (cmd === "recall") {
  const query = positional().join(" ").toLowerCase();
  const project = valueAfter("--project");
  const limit = Number(valueAfter("--limit", "8"));
  const terms = query.split(/\\s+/).filter((w) => w.length > 2);
  const rows = readRows()
    .filter((row) => !project || row.project === project)
    .filter((row) => terms.some((term) => row.summary.toLowerCase().includes(term)))
    .slice(0, limit)
    .map((memory, i) => ({ memory, ranking: {}, score: 1 - i / 10 }));
  console.log(JSON.stringify(rows));
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
  const { bin } = await makeMockTreeRing();
  const roots = await mkdtemp(join(tmpdir(), "ambient-tree-ring-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/tree-ring-cli-adapter.mjs",
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
    if (name.name !== "tree-ring-cli") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "Tree Ring stores portable local agent memory with source tags",
      source: "smoke",
    });
    if (!existsSync(join(write.root, "memory.json"))) throw new Error(`mock Tree Ring root was not created: ${write.root}`);
    const rows = await readFile(join(write.root, "memory.json"), "utf8");
    if (!rows.includes("portable local agent memory")) throw new Error("mock tree-ring was not written");

    const hit = await post(base, "/query", { store: "custom", question: "Which memory stores source tags?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("Tree Ring"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }
    if (!hit.provenance.some((p) => p.source === "tree-ring:observation")) {
      throw new Error(`expected provenance missing: ${JSON.stringify(hit)}`);
    }

    const refused = await post(base, "/write", {
      store: "custom",
      fact: "secret-like fixture should be refused by policy",
      source: "smoke",
    });
    if (refused.accepted !== false || !/blocked by policy/i.test(refused.reason || "")) {
      throw new Error(`expected policy refusal response: ${JSON.stringify(refused)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "Tree Ring source tags", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate Tree Ring root: ${JSON.stringify(miss)}`);
    }
    console.log("tree-ring bridge smoke: write/query/reset isolated roots verified");
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
