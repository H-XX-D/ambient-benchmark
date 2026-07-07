#!/usr/bin/env node
// No-dependency smoke for adapters/projectmem-cli-adapter.mjs.
//
// Creates a tiny mock `projectmem` executable, starts the AMBIENT bridge
// against it, then verifies /write, /query, and reset namespace isolation.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

async function makeMockProjectmem() {
  const dir = await mkdtemp(join(tmpdir(), "ambient-projectmem-mock-"));
  const bin = join(dir, "projectmem");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cmd = process.argv[2];
const root = process.cwd();
const mem = path.join(root, ".projectmem");
if (cmd === "init") {
  fs.mkdirSync(path.join(mem, "issues"), { recursive: true });
  fs.writeFileSync(path.join(mem, "config.toml"), "summary_size_limit_kb = 20\\n");
  fs.writeFileSync(path.join(mem, "summary.md"), "# mock projectmem\\n");
  fs.writeFileSync(path.join(mem, "PROJECT_MAP.md"), "# mock map\\n");
  fs.writeFileSync(path.join(mem, "AI_INSTRUCTIONS.md"), "# mock instructions\\n");
  fs.closeSync(fs.openSync(path.join(mem, "events.jsonl"), "a"));
  process.exit(0);
}
if (cmd === "note") {
  fs.mkdirSync(mem, { recursive: true });
  const summary = process.argv[3] || "";
  const atIndex = process.argv.indexOf("--at");
  const location = atIndex >= 0 ? process.argv[atIndex + 1] : undefined;
  const event = {
    id: "evt_" + Math.random().toString(16).slice(2, 14),
    timestamp: "2026-07-06T00:00:00Z",
    type: "note",
    summary,
    ...(location ? { location } : {})
  };
  fs.appendFileSync(path.join(mem, "events.jsonl"), JSON.stringify(event) + "\\n");
  console.log("Recorded note");
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
  const { bin } = await makeMockProjectmem();
  const roots = await mkdtemp(join(tmpdir(), "ambient-projectmem-roots-"));
  const probe = createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(404).end();
  });
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const bridge = spawn(
    process.execPath,
    [
      "adapters/projectmem-cli-adapter.mjs",
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
    if (name.name !== "projectmem-cli") throw new Error(`unexpected name ${JSON.stringify(name)}`);

    await post(base, "/reset", { store: "custom" });
    const write = await post(base, "/write", {
      store: "custom",
      fact: "projectmem captures local developer decisions without telemetry",
      source: "smoke",
    });
    const events = await readFile(join(write.root, ".projectmem", "events.jsonl"), "utf8");
    if (!events.includes("without telemetry")) throw new Error("mock projectmem was not written");

    const hit = await post(base, "/query", { store: "custom", question: "Which developer memory avoids telemetry?", top_k: 3 });
    if (!hit.support.some((s) => s.includes("projectmem"))) {
      throw new Error(`expected support missing: ${JSON.stringify(hit)}`);
    }

    await post(base, "/reset", { store: "custom" });
    const miss = await post(base, "/query", { store: "custom", question: "projectmem telemetry", top_k: 3 });
    if (miss.support.length) {
      throw new Error(`reset did not isolate namespace: ${JSON.stringify(miss)}`);
    }
    console.log("projectmem bridge smoke: write/query/reset isolated project roots verified");
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
