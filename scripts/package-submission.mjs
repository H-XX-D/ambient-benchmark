#!/usr/bin/env node
// Packages a completed run's artifacts into a submission bundle the website
// certifier accepts, then certifies it locally before writing the zip. The
// packager never invents a number: every result field is read back from the
// run's own summary, and the local certification pass is the proof that the
// assembled bundle is publishable before it ever leaves the machine.
import AdmZip from "adm-zip";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { certifySubmission } from "./certify-submission.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const source = arg("--source", "hard");
const size = arg("--size", "medium-confirmatory-v2");
const adapter = arg("--adapter");
const systemName = arg("--system-name");
const systemVersion = arg("--system-version", "0.0.0");
const submittedBy = arg("--submitted-by", "ambient-maintainer");
const track = arg("--track", "native-system");
const id = arg("--id");
const outZip = arg("--out");

if (!adapter || !systemName || !id || !outZip) {
  console.error("usage: package-submission.mjs --adapter <id> --system-name <name> --id <submission-id> --out <bundle.zip> [--source hard] [--size medium-confirmatory-v2] [--system-version v] [--submitted-by who] [--track native-system]");
  process.exit(2);
}

const key = `${source}-${size}-${adapter}+auto`;
const artifacts = {
  runManifest: `results/manifest-${key}.json`,
  transcript: `results/transcript-${key}.jsonl`,
  judgeManifest: `results/judge-manifest-${key}.json`,
  verdicts: `results/verdicts-${key}.jsonl`,
  summary: `results/verdicts-${key}-summary.json`,
};
for (const [label, path] of Object.entries(artifacts)) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`missing run artifact for ${label}: ${path}`);
    process.exit(1);
  }
}

const summary = JSON.parse(readFileSync(join(ROOT, artifacts.summary), "utf8"));
const manifest = JSON.parse(readFileSync(join(ROOT, artifacts.runManifest), "utf8"));

const tierRate = (tier) => {
  const cell = summary.byTier?.[tier];
  if (!Number.isInteger(cell?.n) || cell.n <= 0) throw new Error(`summary has no ${tier} cell`);
  return cell.completed / cell.n;
};

const baseline = tierRate("T1");
const treatment = tierRate(track === "architecture" ? "T4" : "T3");
const interval = track === "architecture"
  ? summary.uncertainty?.intervals95?.T4
  : summary.uncertainty?.completionIntervals95?.T3;
if (!Array.isArray(interval) || interval.length !== 2) {
  throw new Error("summary is missing the required 95% interval for this track");
}

const transcriptRows = readFileSync(join(ROOT, artifacts.transcript), "utf8").split(/\r?\n/).filter(Boolean);
const uniqueSegments = new Set(transcriptRows.map((line) => JSON.parse(line).segId)).size;

const submission = {
  schema: "ambient.submission.v1",
  id,
  track,
  system: { name: systemName, version: systemVersion },
  corpus: `${source}-${size}`,
  submittedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  submittedBy,
  publicationGate: "passed",
  result: {
    items: uniqueSegments,
    metric: track === "architecture" ? "architecture-lift" : "native-completion",
    score: track === "architecture" ? treatment - baseline : treatment,
    lower95: interval[0] / 100,
    upper95: interval[1] / 100,
    baseline,
    treatment,
  },
  artifacts: {
    runManifest: "run-manifest.json",
    transcript: "transcript.jsonl",
    judgeManifest: "judge-manifest.json",
    verdicts: "verdicts.jsonl",
    summary: "summary.json",
  },
  artifactSha256: {},
};

const stage = join(ROOT, "output", `bundle-${id}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const names = { runManifest: "run-manifest.json", transcript: "transcript.jsonl", judgeManifest: "judge-manifest.json", verdicts: "verdicts.jsonl", summary: "summary.json" };
for (const [label, path] of Object.entries(artifacts)) {
  copyFileSync(join(ROOT, path), join(stage, names[label]));
  submission.artifactSha256[label] = sha256(readFileSync(join(stage, names[label])));
}
writeFileSync(join(stage, "submission.json"), `${JSON.stringify(submission, null, 2)}\n`);

// Certify before zipping; an uncertifiable bundle must never leave this script.
const lock = JSON.parse(readFileSync(join(ROOT, "protocols", "ambient-hard-hosted-v3.json"), "utf8"));
const report = certifySubmission(stage, { corpusSha256: lock.hashes.corpus.sha256, origin: "local" });
if (!report.ok) {
  for (const check of report.checks.filter((c) => !c.passed)) console.error(`FAIL  ${check.name}: ${check.message}`);
  console.error("assembled bundle did not certify; no zip written");
  process.exit(1);
}

const zip = new AdmZip();
zip.addLocalFolder(stage);
zip.writeZip(outZip);
console.log(JSON.stringify({
  certified: report.checks.length,
  controlKey: report.entry.controlKey,
  track,
  items: uniqueSegments,
  score: submission.result.score,
  interval: [submission.result.lower95, submission.result.upper95],
  manifestTrack: manifest.claimTrack,
  zip: outZip,
}, null, 2));
