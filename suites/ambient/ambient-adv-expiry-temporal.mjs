#!/usr/bin/env node
// AMBIENT-ADV expiry-temporal: an adversarial attack on the expiry floor.
//
// FLOOR UNDER TEST (model-free, deterministic):
//   extractExpiryV1(text, createdAt)  ->  cell.policy.expiresAt
//   analyzeMemory(store, NOW).stale[reason==="expired"]  flags expiresAt <= NOW
// So the "expiry floor" is extraction plus the staleFinding threshold. No model
// mediates; the score is a reliability floor, not a model's navigation.
//
// FAIRNESS (all four honored):
//  1. Both-direction headroom. Buckets that SHOULD flag and buckets that should
//     NOT. Score sweeps from ~100 (early NOW) to a precision collapse (late NOW),
//     so the test can land anywhere in 0..100, it is not rigged to 100.
//  2. Input and mechanism are NOT authored to match. Each belief is generated
//     from a structured intent; its surface text AND its independent true expiry
//     are computed from that intent, NOT by running extractExpiryV1. The
//     adversarial rule (embed a month token as a substring of a non-temporal
//     word) STRESSES the substring matcher by construction.
//  3. Same-capability-class. The policy fixture claims: named calendar month,
//     implicit-year-from-createdAt, Q1 and Q2 quarters, and "no recognized scope
//     yields no expiry". We score only those. Q3/Q4 recognition, standalone
//     year-scope expiry, point-in-time as-of reconstruction, and interval
//     queries are NOT claimed or not present, so they are reported UNTESTED with
//     the reason, never scored as failures.
//  4. We report WHERE it breaks: the extraction-level divergence per bucket, and
//     the NOW-curve at which staleness mis-fires.
//
// The ground-truth oracle (trueExpiry) is the human-intended calendar scope of
// each phrasing. It is deliberately independent of the extractor: the extractor
// may agree or diverge, and where it diverges is the finding.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit, analyzeMemory } from "./_recall.mjs";
import { extractExpiryV1, verifyExpiryPolicyV1 } from "./l4-expiry-policy.mjs";

// ----------------------------------------------------------------------------
// Calendar helpers (UTC, matching the policy semantics exactly).
// ----------------------------------------------------------------------------
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
function lastMs(year, monthIndex) {
  // Final millisecond of the named calendar month, UTC.
  return new Date(Date.UTC(year, monthIndex + 1, 1) - 1).toISOString();
}
function firstDayIso(year, monthIndex, day = 1) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString();
}

// Which month tokens the extractor's substring scan would SEE in a text, and
// whether it would see q1/q2. Used only for self-validation of the corpus, not
// for scoring (scoring uses the independent oracle below).
function monthSubstringsIn(text) {
  const t = String(text).toLowerCase();
  const found = new Set();
  for (let i = 0; i < MONTH_NAMES.length; i++) if (t.includes(MONTH_NAMES[i])) found.add(MONTH_NAMES[i]);
  return found;
}
function hasQ(text) {
  const t = String(text).toLowerCase();
  return { q1: /\bq1\b/.test(t), q2: /\bq2\b/.test(t), q3: /\bq3\b/.test(t), q4: /\bq4\b/.test(t) };
}

// ----------------------------------------------------------------------------
// Corpus generator. Structured intent -> {text, createdAt, trueExpiry}. The
// trueExpiry is computed from the intent, never from extractExpiryV1.
// ----------------------------------------------------------------------------
const CREATED_DEFAULT = "2023-01-15T00:00:00.000Z";
const corpus = [];
let seq = 0;
function add(bucket, text, createdAt, trueExpiry, scored, note) {
  corpus.push({ id: `b${String(seq++).padStart(3, "0")}`, bucket, text, createdAt, trueExpiry, scored: scored !== false, note: note ?? "" });
}

// A. CLEAR_EXPLICIT: one named month with an explicit 2023 year. Single month
//    token, correct extraction expected. Flips unexpired -> expired at month end.
for (let m = 0; m < 12; m++) {
  const name = MONTH_NAMES[m].replace(/^./, (c) => c.toUpperCase());
  add("CLEAR_EXPLICIT", `attending the ${name} 2023 developer conference`, firstDayIso(2023, m, 2), lastMs(2023, m), true);
}

// B. IMPLICIT_YEAR: named month, NO year in text; policy claims the createdAt
//    UTC year governs. createdAt is inside that month of 2023.
const implicitMonths = [1, 3, 5, 7, 9, 11]; // Feb, Apr, Jun, Aug, Oct, Dec
for (const m of implicitMonths) {
  const name = MONTH_NAMES[m].replace(/^./, (c) => c.toUpperCase());
  add("IMPLICIT_YEAR", `prepping for the ${name} showcase`, firstDayIso(2023, m, 6), lastMs(2023, m), true);
}

// C. TIMELESS_CLEAN: no calendar scope, NO month substring. trueExpiry null.
//    These SHOULD never be flagged: they are the guaranteed-pass headroom.
const timelessClean = [
  "is vegetarian",
  "lives in Paris",
  "prefers an aisle seat",
  "is allergic to shellfish",
  "speaks fluent German",
  "uses a standing desk",
  "owns a red bicycle",
  "works in the accounting department",
  "drinks tea not coffee",
  "keeps the thermostat at twenty degrees",
];
for (const text of timelessClean) add("TIMELESS_CLEAN", text, CREATED_DEFAULT, null, true);

// D. AMBIGUOUS (adversarial core): a month token embedded as a SUBSTRING of a
//    non-temporal word. No reasonable reader sees a calendar month, so
//    trueExpiry is null. The substring matcher over-fires. Rule of generation:
//    take a month token, embed it inside a real English word, put it in a
//    sentence with zero temporal intent.
const ambiguous = [
  // "may" carriers
  ["the team was dismayed by the outage", "may"],
  ["there was mayhem at the product launch", "may"],
  ["the mayor approved the new budget", "may"],
  ["maybe we ship in the next cycle", "may"],
  ["he refuses to eat mayonnaise", "may"],
  ["she is writing a thesis on Mayan glyphs", "may"],
  // "march" carriers (embedded, not the bare verb)
  ["the marching band rehearses on weekends", "march"],
  ["the veterans marched past the town hall", "march"],
  // "june" carriers
  ["she relocated to Juneau last winter", "june"],
  ["the office is closed for Juneteenth", "june"],
  // "august" carriers
  ["Augustus founded the empire", "august"],
  ["he is reading about Saint Augustine", "august"],
  ["it is an august and venerable institution", "august"],
  // "april" carrier (brand token, not the month)
  ["the Aprilia is his favorite motorcycle", "april"],
];
for (const [text, carrier] of ambiguous) add("AMBIGUOUS", text, CREATED_DEFAULT, null, true, `carrier=${carrier}`);

// E. FUTURE_SCOPED: named month with an explicit FUTURE year (2024). Not expired
//    at any 2023 NOW (pass headroom), flips in 2024.
const futureMonths = [0, 2, 4, 6, 8, 10]; // Jan..Nov of 2024
for (const m of futureMonths) {
  const name = MONTH_NAMES[m].replace(/^./, (c) => c.toUpperCase());
  add("FUTURE_SCOPED", `the ${name} 2024 platform rollout`, firstDayIso(2023, 5, 1), lastMs(2024, m), true);
}

// F. MULTI_MONTH: an interval "from <earlier> through <later> 2023". The policy
//    claims "through <month>" governs the expiry, so the true scope is the LATER
//    month. The extractor returns the FIRST month in Jan..Dec iteration order
//    (the earlier one), so it expires PREMATURELY. Scored, flagged adversarial.
const multi = [
  ["valid from March through October 2023", 2, 9],
  ["the freeze runs from February through November 2023", 1, 10],
  ["campaign live from April through September 2023", 3, 8],
  ["access granted from May through August 2023", 4, 7],
];
for (const [text, earlyIdx, lateIdx] of multi) {
  add("MULTI_MONTH", text, firstDayIso(2023, 0, 5), lastMs(2023, lateIdx), true, `earlyIdx=${earlyIdx} lateIdx=${lateIdx}`);
}

// G. Q_RECALL: Q1 and Q2 are explicitly claimed. Should extract correctly.
add("Q_RECALL", "Q1 2023 hiring freeze in effect", firstDayIso(2023, 0, 10), lastMs(2023, 2), true);
add("Q_RECALL", "Q2 2023 budget freeze in effect", firstDayIso(2023, 3, 10), lastMs(2023, 5), true);

// H. Q34_OUTOFSCOPE: Q3/Q4 are NOT in the claimed capability. Measured but NOT
//    scored (UNTESTED, out of declared scope).
add("Q34_OUTOFSCOPE", "Q3 2023 spending freeze in effect", firstDayIso(2023, 6, 10), lastMs(2023, 8), false, "Q3 not claimed");
add("Q34_OUTOFSCOPE", "Q4 2023 spending freeze in effect", firstDayIso(2023, 9, 10), lastMs(2023, 11), false, "Q4 not claimed");

// ----------------------------------------------------------------------------
// Corpus self-validation. Asserts the generator built what it claims, so the
// scoring is honest. If any assert fails the harness aborts loudly.
// ----------------------------------------------------------------------------
const selfCheck = [];
function check(cond, msg) { if (!cond) selfCheck.push(msg); }
for (const b of corpus) {
  const ms = monthSubstringsIn(b.text);
  const q = hasQ(b.text);
  if (b.bucket === "TIMELESS_CLEAN") {
    check(ms.size === 0 && !q.q1 && !q.q2, `TIMELESS_CLEAN carries a month/quarter token: ${b.id} "${b.text}" -> ${[...ms].join(",")}`);
  }
  if (b.bucket === "AMBIGUOUS") {
    const carrier = b.note.replace("carrier=", "");
    check(ms.has(carrier), `AMBIGUOUS missing intended carrier ${carrier}: ${b.id} "${b.text}"`);
    check(ms.size === 1, `AMBIGUOUS should carry exactly one month token: ${b.id} "${b.text}" -> ${[...ms].join(",")}`);
    check(b.trueExpiry === null, `AMBIGUOUS trueExpiry must be null: ${b.id}`);
    check(!q.q1 && !q.q2, `AMBIGUOUS carries a q token: ${b.id}`);
  }
}
if (selfCheck.length) {
  console.error("CORPUS SELF-CHECK FAILED:\n" + selfCheck.join("\n"));
  process.exit(2);
}

// ----------------------------------------------------------------------------
// Drift guard. If the policy definition changed, refuse to score.
// ----------------------------------------------------------------------------
const witness = verifyExpiryPolicyV1();

// ----------------------------------------------------------------------------
// Admit the whole corpus into one store. extractExpiryV1 fills expiresAt; the
// admit `now` sets createdAt only and does not affect expired detection.
// ----------------------------------------------------------------------------
function proposal(b, expiresAt) {
  return {
    kind: "obs",
    title: `${b.id}: ${b.text}`,
    body: b.text,
    confidence: 0.8,
    project: "adv-expiry",
    tenant: "local",
    topics: ["belief"],
    entities: ["x"],
    expiresAt,
  };
}
const tmp = mkdtempSync(join(os.tmpdir(), "adv-expiry-"));
const store = new SqliteStore(join(tmp, "d.sqlite3"));
const keyToBelief = new Map();
const beliefToExtracted = new Map(); // id -> extracted expiry (what the floor stored)
try {
  for (const b of corpus) {
    const extracted = extractExpiryV1(b.text, b.createdAt);
    beliefToExtracted.set(b.id, extracted);
    const r = admit(proposal(b, extracted), { store, now: b.createdAt });
    if (!r.accepted) throw new Error(`not admitted: ${b.id} ${b.text} -> ${JSON.stringify(r.issues)}`);
    keyToBelief.set(r.cell.key, b);
  }

  // --------------------------------------------------------------------------
  // (1) EXTRACTION-LEVEL DIVERGENCE (NOW-independent). Compares the extractor's
  //     stored expiry to the independent oracle. This isolates the floor's
  //     mis-fire from the threshold.
  // --------------------------------------------------------------------------
  const extractionByBucket = new Map();
  for (const b of corpus) {
    if (!b.scored) continue;
    const got = beliefToExtracted.get(b.id);
    const want = b.trueExpiry;
    const agree = (got === want) || (got !== null && want !== null && Date.parse(got) === Date.parse(want));
    const stat = extractionByBucket.get(b.bucket) || { n: 0, agree: 0, falsePos: 0, falseNeg: 0, wrongVal: 0 };
    stat.n += 1;
    if (agree) stat.agree += 1;
    else if (want === null && got !== null) stat.falsePos += 1;   // invented an expiry
    else if (want !== null && got === null) stat.falseNeg += 1;   // missed a real expiry
    else stat.wrongVal += 1;                                      // wrong expiry value
    extractionByBucket.set(b.bucket, stat);
  }

  // --------------------------------------------------------------------------
  // (2) NOW SWEEP over staleness. For each NOW, score analyzeMemory's expired
  //     set against the oracle. Overall + per-bucket + ambiguous FP curve.
  // --------------------------------------------------------------------------
  const nowPoints = [];
  for (let y = 2023; y <= 2024; y++) {
    const maxM = y === 2024 ? 5 : 11; // through 2024-06
    for (let m = 0; m <= maxM; m++) nowPoints.push(new Date(lastMs(y, m)));
  }
  const scored = corpus.filter((b) => b.scored);
  const ambiguous_ids = new Set(corpus.filter((b) => b.bucket === "AMBIGUOUS").map((b) => b.id));

  function scoreAt(now) {
    const report = analyzeMemory(store, now);
    const expired = new Set(report.stale.filter((s) => s.reason === "expired").map((s) => s.key));
    let tp = 0, fp = 0, fn = 0, tn = 0, ambigFP = 0;
    const buckets = new Map();
    for (const [key, b] of keyToBelief) {
      if (!b.scored) continue;
      const pred = expired.has(key);
      const gold = b.trueExpiry !== null && Date.parse(b.trueExpiry) <= now.getTime();
      if (pred && gold) tp++; else if (pred && !gold) { fp++; if (ambiguous_ids.has(b.id)) ambigFP++; }
      else if (!pred && gold) fn++; else tn++;
      const bk = buckets.get(b.bucket) || { tp: 0, fp: 0, fn: 0, tn: 0 };
      if (pred && gold) bk.tp++; else if (pred && !gold) bk.fp++; else if (!pred && gold) bk.fn++; else bk.tn++;
      buckets.set(b.bucket, bk);
    }
    const recall = tp + fn ? tp / (tp + fn) : 1;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    return { now, tp, fp, fn, tn, recall, precision, ambigFP, ambigTotal: ambiguous_ids.size, buckets };
  }

  const sweep = nowPoints.map(scoreAt);

  // --------------------------------------------------------------------------
  // (3) BOUNDARY PROBE on the <= edge, exercising the exact decisionCases claim.
  //     Use the June-2023 CLEAR_EXPLICIT belief (index 5).
  // --------------------------------------------------------------------------
  const juneBelief = corpus.find((b) => b.bucket === "CLEAR_EXPLICIT" && b.trueExpiry === lastMs(2023, 5));
  const juneExpiry = Date.parse(juneBelief.trueExpiry);
  const boundary = [juneExpiry - 1, juneExpiry, juneExpiry + 1].map((t) => {
    const now = new Date(t);
    const rep = analyzeMemory(store, now);
    const key = [...keyToBelief].find(([, b]) => b.id === juneBelief.id)[0];
    const flagged = new Set(rep.stale.filter((s) => s.reason === "expired").map((s) => s.key)).has(key);
    const gold = juneExpiry <= t;
    return { at: now.toISOString(), flagged, gold, ok: flagged === gold };
  });

  // --------------------------------------------------------------------------
  // Headroom verdicts.
  // --------------------------------------------------------------------------
  const canPass = sweep.some((s) => s.recall === 1 && s.precision === 1 && s.tp > 0);
  const canFail = sweep.some((s) => s.precision < 1);
  const firstBreak = sweep.find((s) => s.precision < 1);

  // ==========================================================================
  // REPORT
  // ==========================================================================
  const pct = (x) => `${Math.round(x * 100)}%`;
  const iso = (d) => d.toISOString().slice(0, 10);
  console.log("==================== AMBIENT-ADV expiry-temporal ====================\n");
  console.log(`policy drift guard : ${witness.verified ? "PASS" : "FAIL"} (${witness.policy}, ${witness.extractionCases} extraction + ${witness.decisionCases} decision witness cases)`);
  console.log(`corpus             : ${corpus.length} beliefs (${scored.length} scored, ${corpus.length - scored.length} UNTESTED out-of-scope)`);
  const bucketCounts = {};
  for (const b of corpus) bucketCounts[b.bucket] = (bucketCounts[b.bucket] || 0) + 1;
  console.log(`buckets            : ${Object.entries(bucketCounts).map(([k, v]) => `${k}=${v}`).join("  ")}\n`);

  console.log("---- (1) EXTRACTION vs independent oracle (NOW-independent, isolates the floor) ----");
  console.log("bucket            n   agree  falsePos  falseNeg  wrongVal   note");
  const bucketNote = {
    CLEAR_EXPLICIT: "explicit-year month, should agree",
    IMPLICIT_YEAR: "createdAt-year month, should agree",
    TIMELESS_CLEAN: "no scope, should stay null",
    AMBIGUOUS: "substring month, should stay null <- attack",
    FUTURE_SCOPED: "future explicit-year month, should agree",
    MULTI_MONTH: "through-month scope <- attack (picks earlier month)",
    Q_RECALL: "Q1/Q2 claimed, should agree",
  };
  for (const [bucket, s] of extractionByBucket) {
    console.log(
      `${bucket.padEnd(16)} ${String(s.n).padStart(2)}   ${String(s.agree).padStart(4)}   ${String(s.falsePos).padStart(6)}    ${String(s.falseNeg).padStart(6)}    ${String(s.wrongVal).padStart(6)}   ${bucketNote[bucket] || ""}`,
    );
  }

  console.log("\n---- (2) NOW sweep: staleness recall/precision + AMBIGUOUS false-positive curve ----");
  console.log("NOW          overall_recall  overall_precision   ambigFP/tot   MULTI(fp)");
  for (const s of sweep) {
    const mb = s.buckets.get("MULTI_MONTH") || { fp: 0 };
    console.log(
      `${iso(s.now)}   ${pct(s.recall).padStart(6)}          ${pct(s.precision).padStart(6)}            ${String(s.ambigFP).padStart(2)}/${s.ambigTotal}         ${mb.fp}`,
    );
  }

  console.log("\n---- (3) boundary probe on the <= edge (June-2023 CLEAR belief) ----");
  for (const p of boundary) console.log(`  NOW=${p.at}  flagged=${p.flagged}  gold=${p.gold}  ${p.ok ? "OK" : "WRONG"}`);

  console.log("\n---- headroom / breakpoint ----");
  console.log(`canPass (a NOW scores recall=100% precision=100% with TP>0): ${canPass}`);
  console.log(`canFail (a NOW scores precision<100%)                      : ${canFail}`);
  if (firstBreak) {
    const offenders = [];
    // Recompute offenders at firstBreak for the report.
    const rep = analyzeMemory(store, firstBreak.now);
    const expired = new Set(rep.stale.filter((s) => s.reason === "expired").map((s) => s.key));
    for (const [key, b] of keyToBelief) {
      if (!b.scored) continue;
      const gold = b.trueExpiry !== null && Date.parse(b.trueExpiry) <= firstBreak.now.getTime();
      if (expired.has(key) && !gold) offenders.push(`${b.id}[${b.bucket}] "${b.text}"`);
    }
    console.log(`first precision break at NOW=${iso(firstBreak.now)} (precision ${pct(firstBreak.precision)}), false positives:`);
    for (const o of offenders) console.log(`   - ${o}`);
  }

  console.log("\n---- UNTESTED (out of declared capability class) ----");
  console.log("  Q3/Q4 quarter recognition : policy claims only Q1 and Q2. Q3/Q4 beliefs");
  console.log("    are admitted with expiresAt=null (extractor returns null) and never flag.");
  for (const b of corpus.filter((x) => x.bucket === "Q34_OUTOFSCOPE")) {
    console.log(`      ${b.id} "${b.text}" -> extracted=${beliefToExtracted.get(b.id)}`);
  }
  console.log("  standalone year-scope expiry: extractor triggers only on a month/quarter;");
  console.log("    a year-only scope (e.g. \"the 2024 annual report\") has no expiry rule. Not claimed.");
  console.log("  point-in-time as-of reconstruction: no asOf/attime/snapshotAt API in the build.");
  console.log("  interval / between-two-times query : analyzeMemory takes a single NOW only; no interval API.");

  // Final machine-readable summary line for the orchestrator to parse if needed.
  const worst = sweep.reduce((a, s) => (s.precision < a.precision ? s : a), sweep[0]);
  console.log(`\nSUMMARY ambigFP_peak=${Math.max(...sweep.map((s) => s.ambigFP))}/${ambiguous_ids.size} worst_precision=${pct(worst.precision)}@${iso(worst.now)} canPass=${canPass} canFail=${canFail}`);
} finally {
  store.close?.();
  rmSync(tmp, { recursive: true, force: true });
}
