#!/usr/bin/env node
// Automated evidence certifier for AMBIENT leaderboard submissions.
//
// This is the gate that runs BEFORE anything is posted. It re-derives every
// number from the raw artifacts rather than trusting the submitter's summary,
// so a bundle only certifies when the transcript, the manifests and the claimed
// result all agree with each other.
//
// Locally-run submissions additionally have to attest which corpus they ran:
// the operator supplies the frozen corpus digest, and it must equal the digest
// pinned in the protocol lock. A hosted run is certified by the Space itself
// and carries no operator attestation.
//
// Unlike a fail-fast validator this collects every independent violation, so a
// submitter sees the full list instead of fixing one error per round trip.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIERS = ["T1", "T2", "T3", "T4"];
const ARTIFACT_KEYS = ["runManifest", "transcript", "judgeManifest", "verdicts", "summary"];
const DEFAULT_PROTOCOL = join(ROOT, "protocols", "ambient-hard-hosted-v3.json");

export const CORPUS_HASH_CHECK = "protocol.corpusAttestation";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });
}

// Collects named pass/fail results instead of throwing on the first problem.
function collector() {
  const checks = [];
  return {
    checks,
    ok(name, condition, message) {
      const passed = Boolean(condition);
      checks.push({ name, passed, message: passed ? "" : message });
      return passed;
    },
    // Runs a group in isolation so an unexpected throw becomes a reported
    // failure rather than taking the whole certification down.
    group(name, fn) {
      try { return fn(); }
      catch (error) {
        checks.push({ name, passed: false, message: `${name}: ${error.message}` });
        return undefined;
      }
    },
  };
}

function resolveArtifact(bundleDir, declaredPath) {
  if (typeof declaredPath !== "string" || declaredPath.length === 0) throw new Error("artifact path is missing");
  if (isAbsolute(declaredPath)) throw new Error("artifact path must be relative");
  const candidate = resolve(bundleDir, declaredPath);
  const prefix = `${resolve(bundleDir)}${sep}`;
  // Two distinct guards: the declared path must stay inside the bundle, and the
  // resolved real path must too. The second catches a symlink planted inside
  // the bundle that points out of it. Keep the messages distinguishable so a
  // test can prove which guard fired.
  if (!candidate.startsWith(prefix)) throw new Error("declared artifact path escapes its bundle");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error("artifact does not exist");
  if (!realpathSync(candidate).startsWith(`${realpathSync(bundleDir)}${sep}`)) {
    throw new Error("artifact symlink resolves outside its bundle");
  }
  return candidate;
}

function tierRate(summary, tier) {
  const cell = summary?.byTier?.[tier];
  if (!Number.isInteger(cell?.n) || cell.n <= 0) throw new Error(`summary is missing the ${tier} item count`);
  if (!Number.isFinite(cell.completed)) throw new Error(`summary is missing the ${tier} completed count`);
  return cell.completed / cell.n;
}

export function readProtocolCorpusSha256(protocolPath = DEFAULT_PROTOCOL) {
  const lock = JSON.parse(readFileSync(protocolPath, "utf8"));
  const digest = lock?.hashes?.corpus?.sha256;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${protocolPath}: protocol lock has no usable corpus digest`);
  }
  return digest;
}

/**
 * Certify one submission bundle.
 *
 * @param {string} bundleDir directory containing submission.json
 * @param {{corpusSha256?: string, origin?: "local"|"hosted", protocolPath?: string}} options
 * @returns {{ok: boolean, checks: Array<{name: string, passed: boolean, message: string}>, entry: object|null}}
 */
export function certifySubmission(bundleDir, options = {}) {
  const { corpusSha256, origin = "local", protocolPath = DEFAULT_PROTOCOL } = options;
  const c = collector();
  const submissionPath = join(bundleDir, "submission.json");

  if (!existsSync(submissionPath)) {
    c.ok("bundle.submissionPresent", false, "bundle does not contain submission.json");
    return { ok: false, checks: c.checks, entry: null };
  }

  let value;
  try {
    value = JSON.parse(readFileSync(submissionPath, "utf8"));
  } catch (error) {
    c.ok("bundle.submissionParses", false, `submission.json is not valid JSON: ${error.message}`);
    return { ok: false, checks: c.checks, entry: null };
  }

  // --- envelope -----------------------------------------------------------
  c.group("envelope", () => {
    c.ok("envelope.schema", value?.schema === "ambient.submission.v1", "submission declares an unexpected schema");
    c.ok("envelope.id", /^[a-z0-9][a-z0-9._-]{2,79}$/.test(value.id ?? ""), "submission id does not match the required pattern");
    c.ok("envelope.track", ["architecture", "native-system"].includes(value.track), "track must be architecture or native-system");
    c.ok("envelope.systemName", typeof value.system?.name === "string" && value.system.name.length > 0 && value.system.name.length <= 100, "system name is missing or too long");
    c.ok("envelope.systemVersion", typeof value.system?.version === "string" && value.system.version.length > 0 && value.system.version.length <= 100, "system version is missing or too long");
    c.ok("envelope.corpus", typeof value.corpus === "string" && value.corpus.length > 0 && value.corpus.length <= 100, "corpus name is missing or too long");
    c.ok("envelope.submittedAt", Number.isFinite(Date.parse(value.submittedAt)), "submittedAt is not a valid date-time");
    c.ok("envelope.sourceCommit", /^[0-9a-f]{40}$/.test(value.sourceCommit ?? ""), "sourceCommit must be a full 40-character commit id");
    c.ok("envelope.submittedBy", typeof value.submittedBy === "string" && value.submittedBy.length > 0 && value.submittedBy.length <= 100, "submittedBy is missing or too long");
    c.ok("envelope.publicationGate", value.publicationGate === "passed", "publicationGate must be 'passed' before submission");
  });

  // --- artifacts: existence, containment, and digest agreement ------------
  const files = {};
  for (const key of ARTIFACT_KEYS) {
    c.group(`artifact.${key}`, () => {
      const path = resolveArtifact(bundleDir, value.artifacts?.[key]);
      files[key] = path;
      const digest = sha256(readFileSync(path));
      c.ok(
        `artifact.${key}.sha256`,
        value.artifactSha256?.[key] === digest,
        `${key}: declared SHA-256 does not match the file on disk`,
      );
    });
  }

  const haveAllArtifacts = ARTIFACT_KEYS.every((key) => files[key]);
  let entry = null;

  if (haveAllArtifacts) {
    let manifest;
    let judgeManifest;
    let summary;
    let transcript;
    let verdicts;

    const parsed = c.group("artifacts.parse", () => {
      manifest = JSON.parse(readFileSync(files.runManifest, "utf8"));
      judgeManifest = JSON.parse(readFileSync(files.judgeManifest, "utf8"));
      summary = JSON.parse(readFileSync(files.summary, "utf8"));
      transcript = jsonl(files.transcript);
      verdicts = jsonl(files.verdicts);
      return true;
    });

    if (parsed) {
      // --- manifests ----------------------------------------------------
      c.group("manifest", () => {
        c.ok("manifest.schema", manifest.schema === "ambient.run-manifest.v1", "run manifest declares an unexpected schema");
        c.ok("manifest.track", manifest.claimTrack === value.track, "run manifest track differs from the submission track");
        c.ok("judge.schema", judgeManifest.schema === "ambient.judge-manifest.v1", "judge manifest declares an unexpected schema");
        c.ok("judge.publishable", judgeManifest.judgeErrors === 0 && judgeManifest.validForPublication === true, "judge manifest reports judge errors or is not marked publishable");
        c.ok("judge.rowCount", judgeManifest.rows === transcript.length, "judge row count differs from the transcript length");
        c.ok("judge.transcriptDigest", judgeManifest.transcriptSha256 === value.artifactSha256?.transcript, "judge manifest references a different transcript digest");
        c.ok("verdicts.rowCount", verdicts.length === transcript.length, "verdict row count differs from the transcript length");
        c.ok("verdicts.noJudgeErrors", !verdicts.some((row) => row.verdict === "judge-error" || row.error), "verdicts contain judge errors");
        c.ok("judge.notMock", !/mock/i.test(judgeManifest.judge?.model ?? ""), "a mock judge cannot be ranked");
        c.ok("reader.notMock", !transcript.some((row) => /mock/i.test(row.sourceTrace?.answer?.model ?? "")), "mock reader output cannot be ranked");
        c.ok("transcript.runId", transcript.every((row) => row.runId === manifest.runId), "transcript rows reference a different runId than the manifest");
        c.ok("reader.fingerprint", transcript.every((row) => row.sourceTrace?.answer?.fingerprint === manifest.models?.reader?.fingerprint), "reader fingerprint drifts across the transcript");
      });

      // --- transcript structure ------------------------------------------
      const paired = new Map();
      const replicates = new Map();
      const abilityBySegment = new Map();
      c.group("transcript", () => {
        let tierValid = true;
        let storeCallValid = true;
        let duplicateFree = true;
        let abilityStable = true;
        for (const row of transcript) {
          if (!TIERS.includes(row.tier)) { tierValid = false; continue; }
          if (row.tier === "T1" ? row.storeCall !== false : row.storeCall !== true) storeCallValid = false;
          const key = `${row.segId}:${row.replicate ?? 0}`;
          const set = paired.get(key) ?? new Set();
          if (set.has(row.tier)) duplicateFree = false;
          set.add(row.tier);
          paired.set(key, set);
          const perSegment = replicates.get(row.segId) ?? new Set();
          perSegment.add(row.replicate ?? 0);
          replicates.set(row.segId, perSegment);
          if (abilityBySegment.has(row.segId)) {
            if (abilityBySegment.get(row.segId) !== row.ability) abilityStable = false;
          } else if (typeof row.ability === "string" && row.ability) {
            abilityBySegment.set(row.segId, row.ability);
          } else {
            abilityStable = false;
          }
        }
        c.ok("transcript.tiers", tierValid, "transcript contains a row with an unknown tier");
        c.ok("transcript.storeCall", storeCallValid, "store-call invariant failed: T1 must not call the store and every other tier must");
        c.ok("transcript.noDuplicateCells", duplicateFree, "transcript contains a duplicate paired cell");
        c.ok("transcript.abilityStable", abilityStable, "a segment changes ability across the transcript");
        c.ok("transcript.completePairs", [...paired.values()].every((tiers) => TIERS.every((tier) => tiers.has(tier))), "transcript contains an incomplete paired cell");

        const uniqueSegments = replicates.size;
        const repeats = manifest.design?.repeats;
        c.ok("design.repeats", Number.isInteger(repeats) && repeats >= 1, "manifest repeat count is invalid");
        if (Number.isInteger(repeats)) {
          c.ok("design.pairedCount", paired.size === uniqueSegments * repeats, "paired cell count differs from unique segments multiplied by repeats");
        }
        c.ok("result.items", uniqueSegments === value.result?.items, "result.items must equal the number of unique question segments");
      });

      // --- statistics -----------------------------------------------------
      c.group("statistics", () => {
        const uniqueSegments = replicates.size;
        const uncertainty = summary.uncertainty;
        c.ok("uncertainty.method", uncertainty?.method === "paired-segment-cluster-bootstrap-v2", "uncertainty must use the paired segment-cluster bootstrap v2");
        c.ok("uncertainty.clusterUnit", uncertainty?.clusterUnit === "segment", "uncertainty cluster unit must be segment");
        c.ok("uncertainty.clusters", uncertainty?.clusters === uniqueSegments, "uncertainty cluster count differs from the unique segment count");

        const interval = value.track === "architecture"
          ? uncertainty?.intervals95?.T4
          : uncertainty?.completionIntervals95?.T3;
        const intervalOk = Array.isArray(interval) && interval.length === 2 && interval.every(Number.isFinite);
        c.ok("uncertainty.interval", intervalOk, "the reported 95% interval is missing from the summary");

        const baseline = tierRate(summary, "T1");
        const treatment = tierRate(summary, value.track === "architecture" ? "T4" : "T3");
        const expectedMetric = value.track === "architecture" ? "architecture-lift" : "native-completion";
        const expectedScore = value.track === "architecture" ? treatment - baseline : treatment;
        c.ok("result.metric", value.result?.metric === expectedMetric, `result.metric must be ${expectedMetric} for this track`);

        const numeric = ["score", "lower95", "upper95"].every((key) => Number.isFinite(value.result?.[key]));
        c.ok("result.numeric", numeric, "score, lower95 and upper95 must all be finite numbers");
        if (numeric) {
          const minimum = value.track === "architecture" ? -1 : 0;
          c.ok("result.range", ["score", "lower95", "upper95"].every((key) => value.result[key] >= minimum && value.result[key] <= 1), "a reported result value lies outside its valid range");
          c.ok("result.ordering", value.result.lower95 <= value.result.score && value.result.score <= value.result.upper95, "the score lies outside its own 95% interval");
          c.ok("result.scoreAgrees", Math.abs(value.result.score - expectedScore) < 1e-9, "the reported score differs from the score derived from the summary");
          if (intervalOk) {
            c.ok("result.lowerAgrees", Math.abs(value.result.lower95 - interval[0] / 100) < 1e-9, "lower95 differs from the summary interval");
            c.ok("result.upperAgrees", Math.abs(value.result.upper95 - interval[1] / 100) < 1e-9, "upper95 differs from the summary interval");
          }
        }
        if (value.track === "architecture") {
          c.ok("result.baselineAgrees", Math.abs((value.result?.baseline ?? NaN) - baseline) < 1e-9, "the reported T1 baseline differs from the summary");
          c.ok("result.treatmentAgrees", Math.abs((value.result?.treatment ?? NaN) - treatment) < 1e-9, "the reported T4 treatment differs from the summary");
        }
      });

      // --- architecture-track specific rules -------------------------------
      if (value.track === "architecture") {
        c.group("architecture", () => {
          const uniqueSegments = replicates.size;
          c.ok("architecture.tierOrder", manifest.design?.tierOrder === "balanced", "the architecture track requires a balanced tier order");
          c.ok("architecture.repeats", Number.isInteger(manifest.design?.repeats) && manifest.design.repeats >= 3, "the architecture track requires at least three repeats");
          c.ok("architecture.queryModel", manifest.adapter?.declaration?.components?.queryGenerativeModel === null, "the architecture adapter must declare a null query model");
          c.ok("architecture.ingestModel", manifest.adapter?.declaration?.components?.ingestGenerativeModel === null, "the architecture adapter must declare a null ingest model");

          const sampling = manifest.design?.sampling;
          c.ok("architecture.samplingMethod", sampling?.method === "seeded-stratified-round-robin-v1", "the architecture track requires seeded stratified round-robin sampling");
          c.ok("architecture.samplingSegments", sampling?.selectedSegments === uniqueSegments, "the sampled segment count differs from the transcript");

          const abilityCounts = {};
          for (const ability of abilityBySegment.values()) abilityCounts[ability] = (abilityCounts[ability] ?? 0) + 1;
          const abilityNames = Object.keys(abilityCounts);
          c.ok("architecture.samplingAbilities", sampling?.selectedAbilities === abilityNames.length, "the sampled ability count differs from the transcript");
          c.ok("architecture.coversAllAbilities", sampling?.selectedAbilities === sampling?.availableAbilities, "the architecture track must cover every corpus ability");
          c.ok("architecture.perAbilityFloor", abilityNames.length > 0 && Math.min(...Object.values(abilityCounts)) >= 30, "the architecture track requires at least 30 unique questions per ability");
          c.ok("architecture.abilityDistribution", JSON.stringify(stable(sampling?.selectedByAbility)) === JSON.stringify(stable(abilityCounts)), "the declared ability distribution differs from the transcript");
          c.ok("architecture.replicateCounts", [...replicates.values()].every((seen) => seen.size === manifest.design?.repeats), "a segment's replicate count differs from the manifest");
        });
      }

      // --- derived control key --------------------------------------------
      c.group("controlKey", () => {
        const control = {
          reader: manifest.models?.reader,
          judge: judgeManifest.judge,
          classifier: manifest.models?.classifier,
          prompts: manifest.prompts,
          corpus: manifest.corpus,
          design: manifest.design,
        };
        entry = {
          id: value.id,
          track: value.track,
          system: value.system,
          corpus: value.corpus,
          submittedAt: value.submittedAt,
          submittedBy: value.submittedBy,
          sourceCommit: value.sourceCommit,
          result: value.result,
          controlKey: sha256(JSON.stringify(stable(control))).slice(0, 12),
          artifactSha256: value.artifactSha256,
        };
      });
    }
  }

  // --- corpus attestation for locally-run submissions ---------------------
  c.group(CORPUS_HASH_CHECK, () => {
    if (origin === "hosted") {
      c.ok(CORPUS_HASH_CHECK, true, "");
      return;
    }
    const expected = readProtocolCorpusSha256(protocolPath);
    if (typeof corpusSha256 !== "string" || corpusSha256.length === 0) {
      c.ok(CORPUS_HASH_CHECK, false, "a locally-run submission must supply the frozen corpus SHA-256; run the corpus digest command and paste the value");
      return;
    }
    c.ok(
      CORPUS_HASH_CHECK,
      corpusSha256.trim().toLowerCase() === expected,
      "the supplied corpus SHA-256 does not match the protocol lock, so this run did not use the frozen answer set",
    );
  });

  const ok = c.checks.every((check) => check.passed);
  return { ok, checks: c.checks, entry: ok ? entry : null };
}

/** Recompute the corpus digest the way the protocol lock defines it. */
export function computeCorpusSha256(corpusDir) {
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) files.push(path);
    }
  };
  walk(corpusDir);
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(corpusDir, path).split(sep).join("/"));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return { sha256: digest.digest("hex"), files: files.length };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log("usage: certify-submission.mjs <bundle-dir> [--corpus-hash <sha256>] [--hosted] [--json]");
    return 2;
  }
  const bundleDir = args[0];
  const hashIndex = args.indexOf("--corpus-hash");
  const options = {
    corpusSha256: hashIndex === -1 ? undefined : args[hashIndex + 1],
    origin: args.includes("--hosted") ? "hosted" : "local",
  };
  const report = certifySubmission(bundleDir, options);
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  for (const check of report.checks) {
    if (!check.passed) console.error(`FAIL  ${check.name}: ${check.message}`);
  }
  const failed = report.checks.filter((check) => !check.passed).length;
  console.log(report.ok
    ? `certified: ${report.checks.length} checks passed, control key ${report.entry.controlKey}`
    : `not certified: ${failed} of ${report.checks.length} checks failed`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("certify-submission.mjs")) {
  process.exit(main(process.argv));
}
