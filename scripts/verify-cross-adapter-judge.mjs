#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function repoPath(value) {
  return path.join(ROOT, value);
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
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

const sourceTranscript = repoPath("results/transcript-beam-small-baseline-pull+auto.jsonl");
if (!existsSync(sourceTranscript)) {
  throw new Error(
    "missing results/transcript-beam-small-baseline-pull+auto.jsonl; run npm run verify:adapters:matrix first",
  );
}

const smokeTranscript = repoPath("results/judge-smoke-transcript-baseline.jsonl");
const smokeMatrix = repoPath("results/judge-smoke-matrix.json");
const smokeOut = repoPath("results/judge-smoke-grade-summary.json");

await writeFile(smokeTranscript, await readFile(sourceTranscript, "utf8"));
const transcriptRows = (await readFile(smokeTranscript, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean).length;

await writeFile(
  smokeMatrix,
  `${JSON.stringify(
    {
      schema: "ambient.cross-adapter-matrix.v1",
      source: "beam",
      size: "small",
      limit: 2,
      adapters: [
        {
          id: "baseline-pull",
          status: "passed",
          rows: transcriptRows,
          transcript: "results/judge-smoke-transcript-baseline.jsonl",
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const mockJudge = await startMockJudge();
try {
  const proc = await runNode(
    [
      "--disable-warning=ExperimentalWarning",
      "scripts/judge-cross-adapter-matrix.mjs",
      "--matrix",
      "results/judge-smoke-matrix.json",
      "--out",
      "results/judge-smoke-grade-summary.json",
      "--strict",
    ],
    {
      ...process.env,
      AMBIENT_JUDGE_ENDPOINT: mockJudge.endpoint,
      AMBIENT_JUDGE_MODEL: "mock-judge",
      AMBIENT_JUDGE_KEY: "mock-key",
    },
  );

  if (proc.code !== 0) {
    throw new Error(`judge wrapper failed\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  }

  const artifact = JSON.parse(await readFile(smokeOut, "utf8"));
  if (artifact.schema !== "ambient.cross-adapter-grades.v1") {
    throw new Error(`unexpected schema: ${artifact.schema}`);
  }
  if (artifact.totals.adapters !== 1 || artifact.totals.passed !== 1) {
    throw new Error(`unexpected totals: ${JSON.stringify(artifact.totals)}`);
  }
  if (artifact.totals.failed !== 0 || artifact.totals.judgeErrors !== 0) {
    throw new Error(`unexpected failures: ${JSON.stringify(artifact.totals)}`);
  }

  const entry = artifact.adapters[0];
  if (entry.id !== "baseline-pull" || entry.status !== "passed") {
    throw new Error(`unexpected adapter entry: ${JSON.stringify(entry)}`);
  }
  if (!entry.verdicts || !existsSync(repoPath(entry.verdicts))) {
    throw new Error(`missing verdict artifact: ${entry.verdicts}`);
  }
  if (!entry.summary || !existsSync(repoPath(entry.summary))) {
    throw new Error(`missing summary artifact: ${entry.summary}`);
  }

  console.log(
    `adapter judge wrapper smoke passed: rows=${transcriptRows} out=results/judge-smoke-grade-summary.json`,
  );
} finally {
  await mockJudge.close();
}
