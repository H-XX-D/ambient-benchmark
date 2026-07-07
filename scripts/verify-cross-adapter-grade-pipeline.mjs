#!/usr/bin/env node
// End-to-end local/free smoke for matrix -> judge -> grade artifact validation.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ADAPTERS = [
  "baseline-pull",
  "total-agent-memory-sqlite",
  "mcp-local-memory-sqlite",
  "sqlite-memory-mcp-sqlite",
  "agent-memory-sqlite",
  "agent-recall-python",
  "mcp-memory-keeper-sqlite",
  "local-memory-mcp-sqlite",
  "mcp-memory-sqlite",
  "agent-memory-mcp-sqlite",
];

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const ix = args.indexOf(name);
  if (ix === -1) return fallback;
  if (ix + 1 >= args.length) throw new Error(`missing value for ${name}`);
  return args[ix + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function runNode(nodeArgs, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runStep(label, nodeArgs, env, timeoutMs) {
  console.log(`\n=== ${label} ===`);
  const proc = await runNode(nodeArgs, env, timeoutMs);
  if (proc.code !== 0 || proc.timedOut) {
    const status = proc.timedOut ? `timed out after ${timeoutMs}ms` : `exited ${proc.code}`;
    throw new Error(`${label} ${status}${proc.signal ? ` (${proc.signal})` : ""}`);
  }
  return proc;
}

async function startMockJudge() {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict: "correct",
                    reason: "mock judge accepted response",
                  }),
                },
              },
            ],
          }),
        );
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const matrixPath = argValue("--matrix", "results/cross-adapter-grade-pipeline-matrix.json");
const outPath = argValue("--out", "results/cross-adapter-grade-pipeline-summary.json");
const adapters = argValue("--adapters", DEFAULT_ADAPTERS.join(","));
const source = argValue("--source", "beam");
const size = argValue("--size", "small");
const limit = argValue("--limit", "2");
const perAbility = argValue("--per-ability", "0");
const skipMatrix = hasFlag("--skip-matrix");
const useExternalModel = hasFlag("--use-external-model");
const useExternalJudge = hasFlag("--use-external-judge");
const judgeModel = argValue("--judge-model", process.env.AMBIENT_JUDGE_MODEL || "gpt-5.4-nano");
const judgeEndpoint = process.env.AMBIENT_JUDGE_ENDPOINT || "https://api.openai.com/v1";
const judgeKey = process.env.AMBIENT_JUDGE_KEY || process.env.OPENAI_API_KEY || "";
const matrixTimeoutMs = Number(argValue("--matrix-timeout-ms", useExternalModel ? "7200000" : "600000"));
const judgeTimeoutMs = Number(argValue("--judge-timeout-ms", useExternalJudge ? "1800000" : "120000"));

if (!skipMatrix) {
  const matrixArgs = [
    "--disable-warning=ExperimentalWarning",
    "scripts/verify-cross-adapter-matrix.mjs",
    "--source",
    source,
    "--size",
    size,
    "--limit",
    limit,
    "--adapters",
    adapters,
    "--out",
    matrixPath,
  ];
  if (Number(perAbility)) matrixArgs.push("--per-ability", perAbility);
  if (useExternalModel) matrixArgs.push("--use-external-model");
  await runStep(
    "cross-adapter matrix",
    matrixArgs,
    process.env,
    matrixTimeoutMs,
  );
}

if (useExternalJudge && !judgeKey) {
  throw new Error("external judge needs AMBIENT_JUDGE_KEY or OPENAI_API_KEY in the environment");
}

const mockJudge = useExternalJudge ? null : await startMockJudge();
const judgeEnv = useExternalJudge
  ? {
      ...process.env,
      AMBIENT_JUDGE_ENDPOINT: judgeEndpoint,
      AMBIENT_JUDGE_MODEL: judgeModel,
      AMBIENT_JUDGE_KEY: judgeKey,
    }
  : {
      ...process.env,
      AMBIENT_JUDGE_ENDPOINT: mockJudge.endpoint,
      AMBIENT_JUDGE_MODEL: "mock-judge",
      AMBIENT_JUDGE_KEY: "mock-key",
    };

try {
  await runStep(
    "cross-adapter judge",
    [
      "--disable-warning=ExperimentalWarning",
      "scripts/judge-cross-adapter-matrix.mjs",
      "--matrix",
      matrixPath,
      "--out",
      outPath,
      "--strict",
    ],
    judgeEnv,
    judgeTimeoutMs,
  );

  const matrix = JSON.parse(await readFile(path.isAbsolute(matrixPath) ? matrixPath : path.join(ROOT, matrixPath), "utf8"));
  const expectedRows = String(matrix.adapters?.[0]?.rows || "");
  await runStep(
    "cross-adapter grade artifact",
    [
      "--disable-warning=ExperimentalWarning",
      "scripts/check-cross-adapter-grades.mjs",
      "--artifact",
      outPath,
      "--expect-adapters",
      adapters,
      "--expect-model",
      useExternalJudge ? judgeModel : "mock-judge",
      ...(expectedRows ? ["--expect-rows", expectedRows] : []),
      "--require-all-passed",
    ],
    process.env,
    30000,
  );

  console.log(`\ncross-adapter grade pipeline smoke passed: matrix=${matrixPath} grades=${outPath}`);
} finally {
  await mockJudge?.close();
}
