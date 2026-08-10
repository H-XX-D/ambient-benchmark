// The certifier is a publication gate: its only job is to REJECT bad evidence.
// So every test below takes a bundle that is known-valid and breaks exactly one
// thing, then asserts the certifier catches that specific violation. A test that
// only checked "valid bundle passes" would stay green against a certifier that
// returns ok for everything, which is the failure mode this file exists to stop.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFixtureBundle } from "../fixtures/submission/build-fixture-bundle.mjs";
import { certifySubmission, CORPUS_HASH_CHECK } from "../scripts/certify-submission.mjs";

const PROTOCOL_CORPUS_SHA256 =
  "5d14c5dbf0eb51d63be1b1cd1c9b6c20a2fa4b256f121b236dcc149addfd55ce";

function freshBundle() {
  const dir = mkdtempSync(join(tmpdir(), "ambient-cert-"));
  buildFixtureBundle(dir);
  return dir;
}

// Rewrites submission.json through `mutate`, keeping artifact digests honest
// unless the test is specifically about digest drift.
function mutateSubmission(dir, mutate) {
  const path = join(dir, "submission.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function failureMessages(report) {
  return report.checks.filter((check) => !check.passed).map((check) => check.message).join(" | ");
}

test("a canonical bundle certifies clean", () => {
  const dir = freshBundle();
  try {
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, true, `expected a clean certification, got: ${failureMessages(report)}`);
    // A pass must carry the derived control key forward, otherwise the
    // leaderboard cannot tell which rows are comparable.
    assert.match(report.entry.controlKey, /^[0-9a-f]{12}$/);
    assert.equal(report.entry.track, "architecture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each row: a human-readable violation, and the mutation that introduces it.
const REJECTIONS = [
  ["declares an unknown schema", (v) => { v.schema = "ambient.submission.v2"; }],
  ["claims a track outside the allowed set", (v) => { v.track = "freeform"; }],
  ["reports an unpassed publication gate", (v) => { v.publicationGate = "pending"; }],
  ["carries a malformed source commit", (v) => { v.sourceCommit = "not-a-commit"; }],
  ["uses an id that breaks the id pattern", (v) => { v.id = "A"; }],
  // Nudged by less than the interval half-width, so the score still sits
  // inside its own interval and lower95/upper95 still match the summary.
  // Only the score-versus-summary agreement check can catch this.
  ["overstates the score while staying inside its interval", (v) => { v.result.score += 0.01; }],
  ["places the score outside its own interval", (v) => { v.result.lower95 = v.result.score + 0.01; }],
  ["miscounts unique question segments", (v) => { v.result.items -= 1; }],
  ["claims native completion while on the architecture track", (v) => { v.result.metric = "native-completion"; }],
  ["reports a baseline that differs from the summary", (v) => { v.result.baseline += 0.05; }],
  // summary is the one artifact whose digest nothing else cross-references,
  // so corrupting it isolates the artifact digest check itself.
  ["lies about an artifact digest", (v) => { v.artifactSha256.summary = "0".repeat(64); }],
];

for (const [description, mutate] of REJECTIONS) {
  test(`rejects a submission that ${description}`, () => {
    const dir = freshBundle();
    try {
      mutateSubmission(dir, mutate);
      const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
      assert.equal(report.ok, false, `certifier accepted a bundle that ${description}`);
      assert.ok(
        report.checks.some((check) => !check.passed),
        "a rejection must name at least one failed check",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Artifact-level tampering: the bytes change but the declared digest does not.
test("rejects a transcript edited after its digest was recorded", () => {
  const dir = freshBundle();
  try {
    const path = join(dir, "transcript.jsonl");
    const rows = readFileSync(path, "utf8").trimEnd().split("\n");
    const first = JSON.parse(rows[0]);
    first.ability = "tampered-ability";
    rows[0] = JSON.stringify(first);
    writeFileSync(path, `${rows.join("\n")}\n`);
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a transcript that no longer matches its digest");
    assert.match(failureMessages(report), /SHA-256/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every digest is kept consistent so the ONLY thing wrong with this bundle is
// that a T1 row called the memory store. If the certifier stopped enforcing the
// store-call invariant, this bundle would certify clean.
test("rejects a T1 row that called the memory store, with all digests consistent", () => {
  const dir = freshBundle();
  try {
    const transcriptPath = join(dir, "transcript.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    const t1 = rows.find((row) => row.tier === "T1");
    assert.ok(t1, "fixture must contain a T1 row");
    t1.storeCall = true;
    const transcriptText = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(transcriptPath, transcriptText);
    const transcriptDigest = createSha256(transcriptText);

    // The judge manifest pins the transcript digest, so it has to be re-pinned
    // and re-hashed too, otherwise a digest check would mask the real defect.
    const judgePath = join(dir, "judge-manifest.json");
    const judge = JSON.parse(readFileSync(judgePath, "utf8"));
    judge.transcriptSha256 = transcriptDigest;
    const judgeText = `${JSON.stringify(judge, null, 2)}\n`;
    writeFileSync(judgePath, judgeText);

    mutateSubmission(dir, (v) => {
      v.artifactSha256.transcript = transcriptDigest;
      v.artifactSha256.judgeManifest = createSha256(judgeText);
    });

    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a T1 row that called the store");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(
      failed.includes("transcript.storeCall"),
      `expected transcript.storeCall to fail, instead failed: ${failed.join(", ") || "nothing"}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The artifact exists and its digest is correct; the only violation is that it
// lives outside the bundle. This is the path-traversal guard, isolated.
test("rejects an artifact that resolves outside the bundle directory", () => {
  const dir = freshBundle();
  const outside = mkdtempSync(join(tmpdir(), "ambient-outside-"));
  try {
    const summaryText = readFileSync(join(dir, "summary.json"), "utf8");
    const outsidePath = join(outside, "summary.json");
    writeFileSync(outsidePath, summaryText);
    mutateSubmission(dir, (v) => {
      v.artifacts.summary = relative(dir, outsidePath);
      v.artifactSha256.summary = createSha256(summaryText);
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted an artifact stored outside the bundle");
    // Must be the declared-path guard specifically, not the symlink guard.
    assert.match(failureMessages(report), /declared artifact path escapes its bundle/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// A symlink that lives inside the bundle passes the declared-path guard, so
// only the resolved-real-path guard can catch it.
test("rejects an in-bundle symlink that resolves outside the bundle", () => {
  const dir = freshBundle();
  const outside = mkdtempSync(join(tmpdir(), "ambient-symlink-"));
  try {
    const summaryText = readFileSync(join(dir, "summary.json"), "utf8");
    const outsidePath = join(outside, "summary.json");
    writeFileSync(outsidePath, summaryText);
    const linkPath = join(dir, "linked-summary.json");
    symlinkSync(outsidePath, linkPath);
    mutateSubmission(dir, (v) => {
      v.artifacts.summary = "linked-summary.json";
      v.artifactSha256.summary = createSha256(summaryText);
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier followed a symlink out of the bundle");
    assert.match(failureMessages(report), /symlink resolves outside its bundle/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// The reader must be identical across every compared cell. Drift here means the
// lift is confounded by a model change, so it can never be published.
test("rejects reader fingerprint drift with all digests consistent", () => {
  const dir = freshBundle();
  try {
    const transcriptPath = join(dir, "transcript.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    rows[0].sourceTrace.answer.fingerprint = "reader-fp-DRIFTED";
    const transcriptText = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(transcriptPath, transcriptText);
    const transcriptDigest = createSha256(transcriptText);

    const judgePath = join(dir, "judge-manifest.json");
    const judge = JSON.parse(readFileSync(judgePath, "utf8"));
    judge.transcriptSha256 = transcriptDigest;
    const judgeText = `${JSON.stringify(judge, null, 2)}\n`;
    writeFileSync(judgePath, judgeText);

    mutateSubmission(dir, (v) => {
      v.artifactSha256.transcript = transcriptDigest;
      v.artifactSha256.judgeManifest = createSha256(judgeText);
    });

    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a run whose reader changed mid-transcript");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(failed.includes("reader.fingerprint"), `expected reader.fingerprint to fail, failed: ${failed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Internally consistent bundle that simply does not sample enough questions per
// ability. Only the architecture per-ability floor can reject it.
test("rejects an architecture run with fewer than 30 questions per ability", () => {
  const dir = mkdtempSync(join(tmpdir(), "ambient-thin-"));
  try {
    buildFixtureBundle(dir, { perAbility: 12 });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted an under-sampled architecture run");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(
      failed.includes("architecture.perAbilityFloor"),
      `expected architecture.perAbilityFloor to fail, failed: ${failed.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects judge output that recorded judge errors", () => {
  const dir = freshBundle();
  try {
    const path = join(dir, "judge-manifest.json");
    const judge = JSON.parse(readFileSync(path, "utf8"));
    judge.judgeErrors = 2;
    const text = `${JSON.stringify(judge, null, 2)}\n`;
    writeFileSync(path, text);
    // Keep the digest honest so the failure is attributable to judge errors
    // rather than to a hash mismatch.
    mutateSubmission(dir, (v) => {
      v.artifactSha256.judgeManifest = createSha256(text);
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a run with judge errors");
    assert.match(failureMessages(report), /judge/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The locally-run path: the operator must prove they ran the frozen corpus.
test("rejects a local run whose corpus hash does not match the protocol lock", () => {
  const dir = freshBundle();
  try {
    const report = certifySubmission(dir, { corpusSha256: "f".repeat(64) });
    assert.equal(report.ok, false, "certifier accepted a local run with a foreign corpus hash");
    assert.match(failureMessages(report), /corpus/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a local run that supplies no corpus hash at all", () => {
  const dir = freshBundle();
  try {
    const report = certifySubmission(dir, {});
    assert.equal(report.ok, false, "certifier accepted a local run with no corpus attestation");
    assert.ok(
      report.checks.some((check) => check.name === CORPUS_HASH_CHECK && !check.passed),
      "the corpus attestation check must be the one that fails",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A hosted run is certified by the Space itself, so it carries no operator
// attestation and must still pass.
test("accepts a hosted run without an operator corpus hash", () => {
  const dir = freshBundle();
  try {
    const report = certifySubmission(dir, { origin: "hosted" });
    assert.equal(report.ok, true, `hosted run should not need an attestation: ${failureMessages(report)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports every independent violation rather than stopping at the first", () => {
  const dir = freshBundle();
  try {
    mutateSubmission(dir, (v) => {
      v.publicationGate = "pending";
      v.sourceCommit = "nope";
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((check) => !check.passed);
    assert.ok(failed.length >= 1, "expected at least one failed check");
    // The report is shown to a submitter, so it must be actionable text.
    for (const check of failed) {
      assert.equal(typeof check.message, "string");
      assert.ok(check.message.length > 0, "a failed check must explain itself");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createSha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Rewrites one artifact and re-pins every digest that references it, so the
// resulting bundle is hash-consistent and the only defect is the edit itself.
function rewriteArtifact(dir, name, key, mutate) {
  const path = join(dir, name);
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  mutateSubmission(dir, (v) => { v.artifactSha256[key] = createSha256(text); });
}

test("rejects a judge manifest that pins a different transcript than the one submitted", () => {
  const dir = freshBundle();
  try {
    // A real, well-formed digest that simply is not this transcript's.
    rewriteArtifact(dir, "judge-manifest.json", "judgeManifest", (judge) => {
      judge.transcriptSha256 = createSha256("a different transcript entirely\n");
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a judge manifest pinned to another transcript");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(failed.includes("judge.transcriptDigest"), `expected judge.transcriptDigest to fail, failed: ${failed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a summary that used an unapproved uncertainty method", () => {
  const dir = freshBundle();
  try {
    rewriteArtifact(dir, "summary.json", "summary", (summary) => {
      summary.uncertainty.method = "naive-normal-approximation";
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted an unapproved uncertainty method");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(failed.includes("uncertainty.method"), `expected uncertainty.method to fail, failed: ${failed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a run whose reader answers came from a mock model", () => {
  const dir = freshBundle();
  try {
    const transcriptPath = join(dir, "transcript.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    for (const row of rows) row.sourceTrace.answer.model = "mock-reader";
    const transcriptText = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    writeFileSync(transcriptPath, transcriptText);
    const transcriptDigest = createSha256(transcriptText);
    rewriteArtifact(dir, "judge-manifest.json", "judgeManifest", (judge) => {
      judge.transcriptSha256 = transcriptDigest;
    });
    mutateSubmission(dir, (v) => { v.artifactSha256.transcript = transcriptDigest; });

    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted mock reader output");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(failed.includes("reader.notMock"), `expected reader.notMock to fail, failed: ${failed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A harness failure is not a benchmark result. When the reader backend dies
// mid-run the runner records "[model error: ...]" as the answer and the
// mechanical oracle grades it wrong or gullible, so the run still produces a
// complete, internally consistent, fully hash-honest bundle carrying a score
// that measures downtime rather than memory. Caught by actually running the
// pipeline: a real run lost its reader partway and certified 47/47 with 20 of
// 52 answers being fetch failures.
test("rejects a transcript containing reader backend errors", () => {
  const dir = freshBundle();
  try {
    const transcriptPath = join(dir, "transcript.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    rows[0].answer = "[model error: fetch failed]";
    const transcriptText = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(transcriptPath, transcriptText);
    const transcriptDigest = createSha256(transcriptText);

    // Keep every digest honest so the ONLY defect is the error answer.
    const judgePath = join(dir, "judge-manifest.json");
    const judge = JSON.parse(readFileSync(judgePath, "utf8"));
    judge.transcriptSha256 = transcriptDigest;
    const judgeText = `${JSON.stringify(judge, null, 2)}\n`;
    writeFileSync(judgePath, judgeText);
    mutateSubmission(dir, (v) => {
      v.artifactSha256.transcript = transcriptDigest;
      v.artifactSha256.judgeManifest = createSha256(judgeText);
    });

    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted a run whose reader failed mid-transcript");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(
      failed.includes("reader.noBackendErrors"),
      `expected reader.noBackendErrors to fail, instead failed: ${failed.join(", ") || "nothing"}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a run judged by a mock judge", () => {
  const dir = freshBundle();
  try {
    rewriteArtifact(dir, "judge-manifest.json", "judgeManifest", (judge) => {
      judge.judge = { ...judge.judge, model: "mock-judge" };
    });
    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted mock judge output");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(failed.includes("judge.notMock"), `expected judge.notMock to fail, failed: ${failed.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Drops the T4 cell of a single segment/replicate. Every digest and row count
// is repaired, so only the paired-completeness rule can reject it.
test("rejects a paired cell that is missing a tier, with all counts repaired", () => {
  const dir = freshBundle();
  try {
    const transcriptPath = join(dir, "transcript.jsonl");
    const verdictsPath = join(dir, "verdicts.jsonl");
    const rows = readFileSync(transcriptPath, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    const verdicts = readFileSync(verdictsPath, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

    const victim = rows.findIndex((row) => row.tier === "T4");
    assert.ok(victim >= 0, "fixture must contain a T4 row");
    const { segId, replicate } = rows[victim];
    rows.splice(victim, 1);
    const vIndex = verdicts.findIndex((row) => row.segId === segId && row.tier === "T4" && row.replicate === replicate);
    if (vIndex >= 0) verdicts.splice(vIndex, 1);

    const transcriptText = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const verdictsText = `${verdicts.map((r) => JSON.stringify(r)).join("\n")}\n`;
    writeFileSync(transcriptPath, transcriptText);
    writeFileSync(verdictsPath, verdictsText);
    const transcriptDigest = createSha256(transcriptText);

    rewriteArtifact(dir, "judge-manifest.json", "judgeManifest", (judge) => {
      judge.rows = rows.length;
      judge.transcriptSha256 = transcriptDigest;
    });
    mutateSubmission(dir, (v) => {
      v.artifactSha256.transcript = transcriptDigest;
      v.artifactSha256.verdicts = createSha256(verdictsText);
    });

    const report = certifySubmission(dir, { corpusSha256: PROTOCOL_CORPUS_SHA256 });
    assert.equal(report.ok, false, "certifier accepted an incomplete paired cell");
    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    assert.ok(
      failed.includes("transcript.completePairs"),
      `expected transcript.completePairs to fail, failed: ${failed.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
