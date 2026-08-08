#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { certifySubmission } from "./certify-submission.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUBMISSIONS_ROOT = join(ROOT, "submissions");
const EVIDENCE_REPO = "https://github.com/H-XX-D/ambient-benchmark";
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && entry.name === "submission.json" ? [path] : [];
  });
}

const clean = readJson("results/clean-verification.json");
const smoke = readJson("results/cross-adapter-grade-pipeline-summary.json");

// The site build and the Space now share one gate. Publishing anything the
// certifier would reject is the failure this indirection exists to prevent, so
// a rejected bundle fails the build rather than being skipped.
function certifyForPublication(submissionPath) {
  const bundleDir = dirname(submissionPath);
  const declared = JSON.parse(readFileSync(submissionPath, "utf8"));
  const report = certifySubmission(bundleDir, {
    corpusSha256: declared.corpusSha256,
    origin: declared.origin === "hosted" ? "hosted" : "local",
  });
  if (!report.ok) {
    const failed = report.checks.filter((check) => !check.passed)
      .map((check) => `  ${check.name}: ${check.message}`).join("\n");
    throw new Error(`${relative(ROOT, submissionPath)} did not certify:\n${failed}`);
  }
  return { ...report.entry, bundlePath: relative(ROOT, bundleDir).split(sep).join("/") };
}

const entries = walk(SUBMISSIONS_ROOT).sort().map(certifyForPublication);
const ids = new Set();
for (const entry of entries) {
  assert(!ids.has(entry.id), `duplicate submission id: ${entry.id}`);
  ids.add(entry.id);
}
entries.sort((a, b) => a.track.localeCompare(b.track) || a.corpus.localeCompare(b.corpus) || a.controlKey.localeCompare(b.controlKey) || b.result.score - a.result.score || a.submittedAt.localeCompare(b.submittedAt));

let commit = null;
try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
catch { /* Vercel source archives may omit .git. */ }
const status = {
  schema: "ambient.site-status.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: commit,
  release: {
    code: clean.status === "passed" ? "verified-pre-release" : "verification-failed",
    label: clean.status === "passed"
      ? `Verified pre-release · ${entries.length} validated submission${entries.length === 1 ? "" : "s"}`
      : "Verification currently failing",
  },
  verification: {
    status: clean.status,
    generatedAt: clean.generatedAt,
    steps: clean.totals?.completed ?? 0,
    copy: clean.status === "passed"
      ? `${clean.totals?.completed ?? 0} deterministic and local checks passed in the latest recorded clean run.`
      : "The latest recorded clean run did not pass; inspect the repository artifact before relying on results.",
  },
  adapterSmoke: {
    kind: "mock-reader-mock-judge-pipeline-smoke",
    generatedAt: smoke.generatedAt,
    adapters: smoke.totals?.passed ?? 0,
    publishableAsQualityResult: false,
  },
  publicEvidence: {
    publishableComparisons: entries.length,
    copy: entries.length > 0
      ? `${entries.length} community submission${entries.length === 1 ? " has" : "s have"} passed the static evidence publication gate.`
      : "No comparative score is published. Passing mock output remains pipeline evidence only, never a ranking.",
  },
};

// bundlePath is an internal repository path; the published row carries a
// browsable evidence URL instead so a reader can go straight to the artifacts.
const evidenceRef = commit || "master";
const leaderboard = {
  schema: "ambient.leaderboard.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: commit,
  entryCount: entries.length,
  ranking: {
    architecture: "paired T4 − T1 attributed completion; descending within a common control key",
    nativeSystem: "T3 end-to-end attributed completion; descending and reported separately",
  },
  tripwireAbilities: [
    "abstention",
    "contradiction-resolution",
    "knowledge-update",
    "belief-revision-audit",
    "trust-discrimination",
    "poisoned-memory-quarantine",
  ],
  entries: entries.map(({ bundlePath, ...entry }) => ({
    ...entry,
    evidenceUrl: `${EVIDENCE_REPO}/tree/${evidenceRef}/${bundlePath}`,
  })),
};

for (const [path, value] of [["site/data/status.json", status], ["site/data/leaderboard.json", leaderboard]]) {
  const out = join(ROOT, path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`built ${path} from repository evidence`);
}
