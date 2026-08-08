#!/usr/bin/env node
// Builds a submission bundle that satisfies every publication rule.
// Tests mutate the output of this builder to prove the certifier rejects
// each individual violation, so the builder itself must stay canonical.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TIERS = ["T1", "T2", "T3", "T4"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const READER = { provider: "hosted", model: "Qwen/Qwen3-32B", fingerprint: "reader-fp-1" };
const JUDGE = { provider: "hosted", model: "openai/gpt-oss-120b", fingerprint: "judge-fp-1" };

// 13 abilities x 30 unique segments clears the architecture per-ability floor.
const ABILITIES = [
  "abstention", "contradiction-resolution", "event-ordering", "information-extraction",
  "instruction-following", "knowledge-update", "multi-session-reasoning",
  "preference-following", "summarization", "temporal-reasoning",
  "attribution", "retrieval", "isolation",
];
const DEFAULT_PER_ABILITY = 30;
const DEFAULT_REPEATS = 3;

// Deterministic outcome pattern: T1 is the weak no-memory baseline, T4 the
// strong selected-memory condition, so the lift is positive and reproducible.
const COMPLETED_RATE = { T1: 0.40, T2: 0.55, T3: 0.70, T4: 0.85 };

function segments(perAbility) {
  const rows = [];
  for (const ability of ABILITIES) {
    for (let index = 0; index < perAbility; index += 1) {
      rows.push({ segId: `${ability}-${String(index).padStart(3, "0")}`, ability });
    }
  }
  return rows;
}

// A segment counts as completed in a tier when its index falls under the
// tier rate. Using the index keeps the fixture stable across runs.
function completed(segIndex, tier) {
  return (segIndex % 100) < Math.round(COMPLETED_RATE[tier] * 100);
}

// `options.perAbility` and `options.repeats` let a test build a bundle that is
// internally consistent but violates one architecture-track floor, so the
// certifier's own rule is the only thing that can reject it.
export function buildFixtureBundle(target, options = {}) {
  const { perAbility = DEFAULT_PER_ABILITY, repeats: REPEATS = DEFAULT_REPEATS } = options;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const segs = segments(perAbility);
  const runId = "run-fixture-0001";
  const transcript = [];
  const verdicts = [];
  const byTier = {};

  for (const tier of TIERS) byTier[tier] = { n: 0, completed: 0 };

  segs.forEach((seg, segIndex) => {
    for (let replicate = 0; replicate < REPEATS; replicate += 1) {
      for (const tier of TIERS) {
        const isCompleted = completed(segIndex, tier);
        transcript.push({
          runId,
          segId: seg.segId,
          ability: seg.ability,
          tier,
          replicate,
          storeCall: tier !== "T1",
          served: tier !== "T1",
          sourceTrace: { answer: { model: READER.model, fingerprint: READER.fingerprint } },
        });
        // Mirrors the real attributed-scorer verdict shape: ability and the
        // oracle's protected-token trail ride along with every verdict.
        verdicts.push({
          runId,
          segId: seg.segId,
          tier,
          replicate,
          ability: seg.ability,
          verdict: isCompleted ? "completed" : "wrong",
          oracle: { protectedHits: [] },
        });
      }
    }
  });

  // Tier cells are counted once per unique segment, not per replicate.
  segs.forEach((seg, segIndex) => {
    for (const tier of TIERS) {
      byTier[tier].n += 1;
      if (completed(segIndex, tier)) byTier[tier].completed += 1;
    }
  });

  const uniqueSegments = segs.length;
  const baseline = byTier.T1.completed / byTier.T1.n;
  const treatment = byTier.T4.completed / byTier.T4.n;
  const score = treatment - baseline;

  const abilityCounts = {};
  for (const seg of segs) abilityCounts[seg.ability] = (abilityCounts[seg.ability] ?? 0) + 1;

  const summary = {
    schema: "ambient.summary.v1",
    runId,
    byTier,
    uncertainty: {
      method: "paired-segment-cluster-bootstrap-v2",
      clusterUnit: "segment",
      clusters: uniqueSegments,
      // Stored as percentages; the certifier divides by 100 to compare.
      intervals95: { T4: [(score - 0.02) * 100, (score + 0.02) * 100] },
      completionIntervals95: { T3: [0, 100] },
    },
  };

  const manifest = {
    schema: "ambient.run-manifest.v1",
    runId,
    claimTrack: "architecture",
    models: { reader: READER, classifier: null },
    prompts: { reader: "reader-prompt-v1", judge: "judge-prompt-v1" },
    corpus: { name: "beam-small", segments: uniqueSegments },
    design: {
      repeats: REPEATS,
      tierOrder: "balanced",
      sampling: {
        method: "seeded-stratified-round-robin-v1",
        selectedSegments: uniqueSegments,
        selectedAbilities: ABILITIES.length,
        availableAbilities: ABILITIES.length,
        selectedByAbility: abilityCounts,
      },
    },
    adapter: {
      declaration: { components: { queryGenerativeModel: null, ingestGenerativeModel: null } },
    },
  };

  const transcriptText = `${transcript.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const verdictsText = `${verdicts.map((row) => JSON.stringify(row)).join("\n")}\n`;

  const judgeManifest = {
    schema: "ambient.judge-manifest.v1",
    runId,
    judge: JUDGE,
    rows: transcript.length,
    judgeErrors: 0,
    validForPublication: true,
    transcriptSha256: sha256(transcriptText),
  };

  const files = {
    "run-manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "transcript.jsonl": transcriptText,
    "judge-manifest.json": `${JSON.stringify(judgeManifest, null, 2)}\n`,
    "verdicts.jsonl": verdictsText,
    "summary.json": `${JSON.stringify(summary, null, 2)}\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text);

  const submission = {
    schema: "ambient.submission.v1",
    id: "fixture-architecture-run",
    track: "architecture",
    system: { name: "Fixture Memory", version: "1.0.0" },
    corpus: "beam-small",
    submittedAt: "2026-07-27T00:00:00.000Z",
    sourceCommit: "0".repeat(40),
    submittedBy: "fixture",
    publicationGate: "passed",
    result: {
      items: uniqueSegments,
      metric: "architecture-lift",
      score,
      lower95: score - 0.02,
      upper95: score + 0.02,
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
    artifactSha256: {
      runManifest: sha256(files["run-manifest.json"]),
      transcript: sha256(files["transcript.jsonl"]),
      judgeManifest: sha256(files["judge-manifest.json"]),
      verdicts: sha256(files["verdicts.jsonl"]),
      summary: sha256(files["summary.json"]),
    },
  };
  writeFileSync(join(target, "submission.json"), `${JSON.stringify(submission, null, 2)}\n`);
  return join(target, "submission.json");
}

if (process.argv[1] && process.argv[1].endsWith("build-fixture-bundle.mjs")) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: build-fixture-bundle.mjs <target-dir>");
    process.exit(2);
  }
  console.log(buildFixtureBundle(target));
}
