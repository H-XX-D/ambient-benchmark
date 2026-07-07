#!/usr/bin/env node
// No-key smoke for the substrate-neutral adapter path.
//
// Starts:
//   - the baseline-pull HTTP adapter on an ephemeral local port
//   - a tiny OpenAI-compatible mock model endpoint on an ephemeral local port
// Then drives tiers/runner.mjs through --adapter-url so the runner exercises the
// same wire protocol a real non-Recall memory system must implement.

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

function startMockModel() {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const prompt = body?.messages?.map((m) => m.content || "").join("\n") || "";
    const content = /Relation:/i.test(prompt) ? "NONE" : "I don't know.";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  return listen(server).then((port) => ({ server, port }));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForAdapter(port) {
  const url = `http://127.0.0.1:${port}/name`;
  const deadline = Date.now() + 5000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = new Error(`adapter /name ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error("adapter did not start");
}

async function main() {
  const { server: modelServer, port: modelPort } = await startMockModel();
  const adapterPort = await freePort();
  const adapter = spawn(process.execPath, ["adapters/baseline-pull-server.mjs", "--port", String(adapterPort)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let adapterOutput = "";
  adapter.stdout.on("data", (b) => { adapterOutput += b.toString(); });
  adapter.stderr.on("data", (b) => { adapterOutput += b.toString(); });

  try {
    await waitForAdapter(adapterPort);
    const runner = spawn(
      process.execPath,
      [
        "tiers/runner.mjs",
        "--adapter-url",
        `http://127.0.0.1:${adapterPort}`,
        "--source",
        "beam",
        "--size",
        "small",
        "--limit",
        "2",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          AMBIENT_MODEL_BACKEND: "local",
          AMBIENT_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
          AMBIENT_MODEL: "mock",
          AMBIENT_CHECKER_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
          AMBIENT_CHECKER_MODEL: "mock",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    runner.stdout.on("data", (b) => { output += b.toString(); });
    runner.stderr.on("data", (b) => { output += b.toString(); });
    const [code] = await once(runner, "exit");
    if (code !== 0) {
      throw new Error(`runner exited ${code}\n${output}`);
    }
    if (!/adapter=baseline-pull(?:\+auto)?/.test(output) || !/wrote \d+ rows ->/.test(output)) {
      throw new Error(`runner output did not prove baseline adapter path\n${output}`);
    }
    process.stdout.write(output);
    console.log("\nwire smoke: baseline-pull HTTP adapter path verified with mock model");
  } finally {
    adapter.kill("SIGTERM");
    modelServer.close();
    if (adapter.exitCode == null && !adapter.killed) adapter.kill("SIGKILL");
    if (adapterOutput && process.env.AMBIENT_WIRE_SMOKE_DEBUG) {
      console.error(adapterOutput);
    }
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
