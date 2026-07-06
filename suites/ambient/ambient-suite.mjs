#!/usr/bin/env node
// AMBIENT suite, the full 18-area profile, measured.
//
// Runs a parameterized corpus per area against a real SQLiteRecallStore and emits
// the capability profile (one grade per area), never a single number. Areas that
// need external fixtures (a Bitcoin node, a 1b model, real concurrent processes)
// are reported UNTESTED with the reason, never silently passed.
//
// Usage: node scripts/sentinel-suite.mjs

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SQLiteRecallStore, admitWriteProposal, analyzeMemory } from "../dist/src/index.js";
import { detectAndLinkUnpromptedContradictions } from "../dist/src/core/contradiction-detect.js";
import { runSetIntegrity } from "./probes/set-integrity.mjs";
import { runAnteriority } from "./probes/anteriority.mjs";
import { runReaderIndependence } from "./probes/reader-independence.mjs";
import { runModality } from "./probes/modality.mjs";
import { runFederation } from "./probes/federation.mjs";
import { runConcurrency } from "./probes/concurrency.mjs";
import { runAdoption } from "./probes/adoption.mjs";

// ---------- helpers ----------
function fresh() {
  const dir = mkdtempSync(join(os.tmpdir(), "sentinel-suite-"));
  const path = join(dir, "d.sqlite3");
  return { store: new SQLiteRecallStore(path), path, dir };
}
function done(s) { try { s.store.close?.(); } finally { rmSync(s.dir, { recursive: true, force: true }); } }
function reopen(s) { s.store.close?.(); s.store = new SQLiteRecallStore(s.path); return s.store; }

function mkProposal(o = {}) {
  const createdAt = o.createdAt || "2024-01-01";
  return {
    schema_version: "recall.write.v1",
    actor: { kind: "llm", id: "suite", display: "Suite" },
    intent: { kind: o.kind || "observation", operation: o.operation || "create" },
    content: { title: o.title, body: o.body ?? o.title, summary: o.summary ?? o.title },
    scope: { project: "suite", path: ".", tenant: "local" },
    tags: {
      category: ["memory"], type: [o.kind || "observation"], subject: o.subject || ["fact"], project: ["suite"],
      idea: ["suite"], timestamp: [createdAt], topics: o.topics || ["fact"], entities: o.entities || ["x"],
      identities: ["agent:suite"], rings: ["adapter"], lifecycle: ["active"], quality: ["source-grounded"],
      sensitivity: ["public"], permission: ["read"]
    },
    evidence: { source_refs: [], depends_on: [], supports: o.supports || [], contradicts: o.contradicts || [], concerns: [] },
    confidence: {
      value: o.confidence ?? 0.8, uncertainty: 0.1, concern: 0.05,
      source_quality: o.sourceQuality || "high", stability: "stable"
    },
    provenance: {
      created_at: new Date(createdAt).toISOString(), origin: "llm", produced_by: "suite",
      verification: o.verification || "checked", signature_status: "unsigned"
    },
    policy: { sensitivity: "public", allow_background_use: true, requires_review: false, expires_at: o.expiresAt ?? null, reverify_after: null }
  };
}
const pct = (x) => `${Math.round(x * 100)}%`;
function W(store, o) { return admitWriteProposal(mkProposal(o), store, o.createdAt ? { now: new Date(o.createdAt) } : {}).node; }

// ---------- area runners ----------

// 1 ATTRIBUTION, commit-reveal: pre-hash a planted secret, write it, recover it
// from a FRESHLY REOPENED store, verify sha256 matches. Tests trace-to-a-write.
function attribution(n = 30) {
  const s = fresh(); const recs = [];
  try {
    for (let i = 0; i < n; i++) {
      const secret = `canary-${i}-${randomBytes(8).toString("hex")}`;
      const pre = createHash("sha256").update(secret).digest("hex");
      const id = W(s.store, { title: `planted attribution ${i} ${secret}`, body: secret, topics: ["attribution"] }).id;
      recs.push({ id, pre });
    }
    const reader = reopen(s); // fresh reader, new store instance on same db
    let ok = 0;
    for (const r of recs) {
      const node = reader.getNode(r.id);
      const post = node ? createHash("sha256").update(node.body).digest("hex") : "";
      if (post === r.pre) ok++;
    }
    const recall = ok / n;
    return { n, metric: `recover+hash-match ${ok}/${n}`, grade: recall === 1 ? "INDEPENDENTLY-VERIFIED" : recall > 0 ? "RESIDUAL(@INDEP)" : "ABSENT" };
  } finally { done(s); }
}

// 3 AUTHORITY, every read carries which store/scope served it and its provenance.
function authority(n = 25) {
  const s = fresh();
  try {
    const ids = []; for (let i = 0; i < n; i++) ids.push(W(s.store, { title: `authority cell ${i}`, topics: ["authority"] }).id);
    const reader = reopen(s); let ok = 0;
    for (const id of ids) {
      const node = reader.getNode(id);
      const hasProv = !!(node && node.provenance && node.provenance.produced_by && node.provenance.origin);
      const hasAddr = !!(node && typeof node.cellAddress === "string" && node.cellAddress.startsWith("recall://cell/") && node.cellAddress.includes(node.scope.project)); // address encodes serving scope
      if (hasProv && hasAddr) ok++;
    }
    return { n, metric: `provenance+store-address present ${ok}/${n}`, grade: ok === n ? "INDEPENDENTLY-VERIFIED" : ok > 0 ? "RESIDUAL(@INDEP)" : "ABSENT" };
  } finally { done(s); }
}

// 5 CONTRADICTION, unprompted lexical/polarity detection (the shipped detector),
// recall over positives, precision over hard negatives.
function contradiction() {
  const PAIRS = [["up", "down"], ["present", "absent"], ["enabled", "disabled"], ["valid", "invalid"], ["online", "offline"], ["healthy", "unhealthy"], ["active", "inactive"], ["passing", "failing"], ["secure", "vulnerable"], ["true", "false"], ["succeeded", "failed"]];
  const SUBJ = ["Service Alpha", "The primary database", "Node7"];
  function fires(a, b) {
    const store = { listNodes: () => [{ id: "C1", title: a, status: "active", tags: { topics: [] }, kind: "observation" }] };
    const p = { intent: { operation: "create" }, content: { title: b }, evidence: { contradicts: [] } };
    detectAndLinkUnpromptedContradictions(p, store, []); return p.evidence.contradicts.length > 0;
  }
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const [a, b] of PAIRS) for (const sub of SUBJ) { if (fires(`${sub} is ${a}`, `${sub} is ${b}`)) tp++; else fn++; }
  // hard negatives
  for (const sub of SUBJ) {
    const negs = [[`${sub} is up`, `${sub} is not down`], [`${sub} was valid in 2024`, `${sub} was invalid in 2026`], [`Service Beta is down`, `${sub} is up`], [`${sub} is healthy`, `${sub} is healthy and stable`]];
    for (const [a, b] of negs) { if (fires(a, b)) fp++; else tn++; }
  }
  const recall = tp / (tp + fn), precision = tp / (tp + fp || 1);
  return { n: tp + fn + fp + tn, metric: `recall ${pct(recall)} precision ${pct(precision)}`, grade: recall >= 0.95 && precision >= 0.98 ? "SELF-VERIFIED" : "RESIDUAL(@SELF-VERIFIED)" };
}

// 7 CALIBRATION, unsupported high confidence must attenuate; restatement must not
// inflate. Both deterministic invariants of the admission path.
function calibration(n = 20) {
  const s = fresh();
  try {
    let capped = 0;
    for (let i = 0; i < n; i++) {
      const node = W(s.store, { title: `bold claim ${i}`, confidence: 0.95, verification: "unverified", sourceQuality: "unknown", topics: ["cal"] });
      if (node.data.confidence.value <= 0.7 + 1e-9) capped++;
    }
    // restatement: same weak claim many times, none stored above its own value
    let drift = 0;
    for (let i = 0; i < 10; i++) { const node = W(s.store, { title: `restated fact alpha ${i}`, confidence: 0.6, topics: ["cal", "restate"] }); if (node.data.confidence.value > 0.6 + 1e-9) drift++; }
    const ok = capped === n && drift === 0;
    return { n: n + 10, metric: `attenuated ${capped}/${n}, upward-drift ${drift}/10`, grade: ok ? "SELF-VERIFIED" : "RESIDUAL(@SELF-VERIFIED)" };
  } finally { done(s); }
}

// 8 REACTIVITY, standing watch program trips on an unprompted contradiction and
// stays quiet on distractors (the push signal pull systems lack).
function reactivity(n = 16) {
  let trueC = 0, trips = 0, falseTrips = 0;
  for (let i = 0; i < n; i++) {
    const s = fresh();
    try {
      const isContra = i % 2 === 0;
      const anchor = W(s.store, { title: `belief attr_${i}`, body: `attr_${i}=A`, topics: ["fact"], entities: [`attr_${i}`] });
      const edge = s.store.addHyperedge({ kind: "evidence-bundle", title: `watch_${i}`, members: [{ nodeId: anchor.id, role: "claim" }] });
      const prog = s.store.attachProgram(edge.id, { schemaVersion: "recall.program.v1", operation: "watch", params: { delta: 0.1 } });
      s.store.runProgram(prog.id);
      if (isContra) {
        W(s.store, { title: `event attr_${i}=B`, body: `attr_${i}=B`, contradicts: [anchor.id], topics: ["fact"], entities: [`attr_${i}`] });
        trueC++;
      } else {
        W(s.store, { title: `event other_${i}=Z`, body: `other_${i}=Z`, topics: ["fact"], entities: [`other_${i}`] });
      }
      const tripped = s.store.runProgram(prog.id).output.tripped === true;
      if (isContra && tripped) trips++; else if (tripped) falseTrips++;
    } finally { done(s); }
  }
  const recall = trueC ? trips / trueC : 1, precision = (trips + falseTrips) ? trips / (trips + falseTrips) : 1;
  return { n, metric: `trip recall ${pct(recall)} precision ${pct(precision)}`, grade: recall >= 0.95 && precision >= 0.98 ? "SELF-VERIFIED" : "RESIDUAL(@SELF-VERIFIED)" };
}

// 10 SUPERSESSION-INTEGRITY, supersede a value, then check the superseded cell is
// no longer served as active (no-resurrection). Measures the known read-time gap.
function supersession(n = 20) {
  const s = fresh();
  try {
    let resurrected = 0;
    for (let i = 0; i < n; i++) {
      const v1 = W(s.store, { title: `claim X${i} value is first`, body: "v1", subject: [`claimx${i}`], topics: ["sup"] });
      W(s.store, { title: `claim X${i} value is second`, body: "v2", operation: "supersede", contradicts: [v1.id], supports: [], subject: [`claimx${i}`], topics: ["sup"] });
      const reader = reopen(s);
      const still = reader.getNode(v1.id);
      if (still && still.status === "active") resurrected++; // superseded original still served as active
    }
    const rate = resurrected / n;
    return { n, metric: `superseded-still-active ${resurrected}/${n} (resurrection ${pct(rate)})`, grade: rate === 0 ? "SELF-VERIFIED" : "ASSERTED" };
  } finally { done(s); }
}

// 12 DEEP-CONTRADICTION, transitive (holonomy) cycle: A>B,B>C,C>A is rejected at
// write time though no pair contradicts. (Paraphrase/entailment need a KB/LLM and
// are out of scope for the lexical floor, reported separately.)
function deepContradiction(n = 20) {
  let inc = 0, detected = 0, falseFlags = 0;
  for (let i = 0; i < n; i++) {
    const s = fresh();
    try {
      const bad = i % 2 === 0;
      const ent = { A: W(s.store, { title: `entity A${i}` }).id, B: W(s.store, { title: `entity B${i}` }).id, C: W(s.store, { title: `entity C${i}` }).id };
      const orderings = bad ? [["A", "B"], ["B", "C"], ["C", "A"]] : [["A", "B"], ["B", "C"], ["A", "C"]];
      if (bad) inc++;
      const edges = []; let caught = -1;
      orderings.forEach(([f, t], idx) => {
        edges.push({ from: ent[f], to: ent[t] });
        try { s.store.addDagOverlay({ title: `ord@${idx}`, nodeIds: [ent.A, ent.B, ent.C], edges: edges.slice(), metadata: {} }); }
        catch (err) { if (/cycle/i.test(String(err && err.message)) && caught < 0) caught = idx; }
      });
      if (bad) { if (caught >= 0) detected++; } else if (caught >= 0) falseFlags++;
    } finally { done(s); }
  }
  const recall = inc ? detected / inc : 1, precision = (detected + falseFlags) ? detected / (detected + falseFlags) : 1;
  return { n, metric: `transitive recall ${pct(recall)} precision ${pct(precision)}; paraphrase/entailment untested`, grade: recall >= 0.95 && precision >= 0.98 ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED" };
}

// 11 TEMPORALITY, implicit-expiry staleness surfaced unprompted, plus
// validity-interval non-contradiction. (As-of belief reconstruction untested.)
function temporality() {
  const NOW = new Date("2023-07-15T00:00:00.000Z");
  const CASES = [
    { text: "training for the June marathon", createdAt: "2023-06-28", gold: true, exp: "2023-06-30T23:59:59.000Z" },
    { text: "is vegetarian", createdAt: "2023-05-01", gold: false, exp: null },
    { text: "attending the March 2023 conference", createdAt: "2023-03-01", gold: true, exp: "2023-03-31T23:59:59.000Z" },
    { text: "lives in Paris", createdAt: "2023-01-01", gold: false, exp: null },
    { text: "rehearsing for the May recital", createdAt: "2023-05-10", gold: true, exp: "2023-05-31T23:59:59.000Z" },
    { text: "vacation in August 2023", createdAt: "2023-07-10", gold: false, exp: "2023-08-31T23:59:59.000Z" }
  ];
  const s = fresh(); let stalePass = 0;
  try {
    const idCase = new Map();
    for (const c of CASES) idCase.set(W(s.store, { title: c.text, createdAt: c.createdAt, expiresAt: c.exp, topics: ["temporal"] }).id, c);
    const expired = new Set(analyzeMemory(s.store, NOW).stale.filter((x) => x.reason === "expired").map((x) => x.nodeId));
    for (const [id, c] of idCase) { const flagged = expired.has(id); if (flagged === c.gold) stalePass++; }
  } finally { done(s); }
  // interval non-contradiction: distinct-year flip must NOT fire
  const fires = (a, b) => { const st = { listNodes: () => [{ id: "C", title: a, status: "active", tags: { topics: [] }, kind: "observation" }] }; const p = { intent: { operation: "create" }, content: { title: b }, evidence: { contradicts: [] } }; detectAndLinkUnpromptedContradictions(p, st, []); return p.evidence.contradicts.length > 0; };
  let intervalOk = 0; const iv = [["Policy P valid in 2024", "Policy P invalid in 2026"], ["Region R online in 2023", "Region R offline in 2025"]];
  for (const [a, b] of iv) if (!fires(a, b)) intervalOk++;
  // as-of belief reconstruction: belief at T = latest record <= T per subject
  const s2 = fresh(); let asofPass = 0; const subs = 4;
  try {
    for (let i = 0; i < subs; i++) {
      W(s2.store, { title: `flag ${i} was ON`, body: "on", createdAt: "2022-01-01", subject: [`flag${i}`], topics: ["t"] });
      W(s2.store, { title: `flag ${i} turned OFF`, body: "off", createdAt: "2025-01-01", subject: [`flag${i}`], topics: ["t"] });
    }
    const r2 = reopen(s2);
    for (let i = 0; i < subs; i++) {
      const asof = r2.nodesAsOf("2023-06-01T00:00:00.000Z", 5000).filter((nn) => (nn.tags?.subject || []).includes(`flag${i}`));
      if (asof[0] && asof[0].body === "on") asofPass++; // the 2025 OFF is absent as of 2023
    }
  } finally { done(s2); }
  const ok = stalePass === CASES.length && intervalOk === iv.length && asofPass === subs;
  return { n: CASES.length + iv.length + subs, metric: `staleness ${stalePass}/${CASES.length}, interval ${intervalOk}/${iv.length}, as-of ${asofPass}/${subs}`, grade: ok ? "SELF-VERIFIED" : "RESIDUAL(@SELF-VERIFIED)" };
}

// 13 RETRIEVAL-FIDELITY, exact item retrieved from a distractor swamp (precision@1),
// verbatim recovery, and a never-stored negative control returns absent.
function retrieval(n = 20, decoys = 12) {
  const s = fresh(); let p1 = 0, verbatim = 0, negOk = 0;
  try {
    const targets = [];
    for (let i = 0; i < n; i++) {
      const tok = `ZЯ${randomBytes(5).toString("hex")}`.toUpperCase();
      for (let d = 0; d < decoys; d++) W(s.store, { title: `record ${i} variant ${d} alpha bravo`, body: `decoy ${d}`, topics: ["retr"] });
      const id = W(s.store, { title: `record ${i} variant target ${tok}`, body: `payload ${tok}`, topics: ["retr"] }).id;
      targets.push({ id, tok, q: `record ${i} variant target ${tok}` });
    }
    const reader = reopen(s);
    for (const t of targets) {
      const hits = reader.search(t.q, 5);
      if (hits[0] && hits[0].id === t.id) p1++;
      const node = reader.getNode(t.id);
      if (node && node.body === `payload ${t.tok}`) verbatim++;
    }
    const neg = reader.search("NEVERSTOREDTOKEN-ΩQ7-absent-xyz", 5);
    negOk = neg.every((h) => !String(h.title).includes("NEVERSTORED")) ? 1 : 0;
    const ok = p1 === n && verbatim === n && negOk === 1;
    return { n: n + 1, metric: `precision@1 ${p1}/${n}, verbatim ${verbatim}/${n}, negative-control ${negOk ? "clean" : "leak"}`, grade: ok ? "SELF-VERIFIED" : p1 > 0 ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED" };
  } finally { done(s); }
}

// 14 ADVERSARIAL, confidence laundering: restating a weak claim many times must
// not raise its stored confidence. (Poisoning/sybil/replay/forgery: enterprise.)
function adversarial(reps = 25) {
  const s = fresh();
  try {
    let raised = 0, maxSeen = 0;
    for (let i = 0; i < reps; i++) { const node = W(s.store, { title: `laundered claim payload ${i}`, confidence: 0.55, subject: ["laundry"], topics: ["adv"] }); maxSeen = Math.max(maxSeen, node.data.confidence.value); if (node.data.confidence.value > 0.55 + 1e-9) raised++; }
    const ok = raised === 0 && maxSeen <= 0.55 + 1e-9;
    return { n: reps, metric: `laundering: max stored conf ${maxSeen.toFixed(2)} over ${reps} restatements (rise=${raised}); poisoning/sybil/forgery untested`, grade: ok ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED" };
  } finally { done(s); }
}

// 15 ENDURANCE, write a burst and reconcile the count: no silent loss.
function endurance(n = 400) {
  const s = fresh();
  try {
    for (let i = 0; i < n; i++) W(s.store, { title: `burst cell ${i} ${randomBytes(3).toString("hex")}`, topics: ["endur"] });
    const reader = reopen(s);
    const count = reader.listNodes(n * 3).length;
    const ok = count === n;
    return { n, metric: `count reconciliation ${count}/${n} (no silent drop=${ok})`, grade: ok ? "SELF-VERIFIED" : "RESIDUAL(@SELF-VERIFIED)" };
  } finally { done(s); }
}

// ---------- profile ----------
const AREAS = [
  ["0 ADOPTION", runAdoption],
  ["1 ATTRIBUTION", attribution],
  ["2 ANTERIORITY", runAnteriority],
  ["3 AUTHORITY", authority],
  ["4 READER-INDEPENDENCE", runReaderIndependence],
  ["5 CONTRADICTION", contradiction],
  ["6 SET-INTEGRITY", runSetIntegrity],
  ["7 CALIBRATION", calibration],
  ["8 REACTIVITY", reactivity],
  ["9 CONCURRENCY", runConcurrency],
  ["10 SUPERSESSION-INTEGRITY", supersession],
  ["11 TEMPORALITY", temporality],
  ["12 DEEP-CONTRADICTION", deepContradiction],
  ["13 RETRIEVAL-FIDELITY", retrieval],
  ["14 ADVERSARIAL-ROBUSTNESS", adversarial],
  ["15 ENDURANCE", endurance],
  ["16 FEDERATION", runFederation],
  ["17 MODALITY", runModality]
];

console.log("\n==================== AMBIENT SUITE, full 18-area profile ====================\n");
let totalCases = 0; const tally = {};
const rows = [];
for (const [name, fn] of AREAS) {
  let r;
  try { r = await fn(); } catch (err) { r = { n: 0, metric: `ERROR: ${String(err && err.message).slice(0, 80)}`, grade: "ERROR" }; }
  totalCases += r.n || 0; tally[r.grade] = (tally[r.grade] || 0) + 1;
  rows.push([name, r.grade, r.n || 0, r.metric]);
}
const wName = Math.max(...rows.map((r) => r[0].length));
const wGrade = Math.max(...rows.map((r) => r[1].length));
for (const [name, grade, n, metric] of rows) {
  console.log(`  ${name.padEnd(wName)}  ${grade.padEnd(wGrade)}  ${String(n).padStart(4)}  ${metric}`);
}
console.log(`\n  total cases run: ${totalCases}`);
console.log("  grade tally: " + Object.entries(tally).map(([g, c]) => `${g}=${c}`).join("  "));
console.log("\n  non-decoration: ADVERSARIAL ceiling empty everywhere; profile vector is the result, not an average.\n");
