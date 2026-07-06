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
import { SqliteStore, admit, analyzeMemory, addHyperedge, addDagOverlay, runProgramCell } from "./_recall.mjs";
import { runSetIntegrity } from "./probes/set-integrity.mjs";
import { runAnteriority } from "./probes/anteriority.mjs";
import { runReaderIndependence } from "./probes/reader-independence.mjs";
import { runModality } from "./probes/modality.mjs";
import { runFederation } from "./probes/federation.mjs";
import { runConcurrency } from "./probes/concurrency.mjs";
import { runAdoption } from "./probes/adoption.mjs";

// detectAndLinkUnpromptedContradictions, cellAddress, and nodesAsOf do not
// exist anywhere in the vendored build (confirmed against source, not just a
// grep miss) — capabilities the "Recall-Personal" build these areas were
// written against apparently had, that the public open-source Recall does
// not. Per AMBIENT's own stated policy ("areas that need external fixtures
// are reported UNTESTED with the reason, never silently passed"), the
// sub-checks that depend on them are marked UNTESTED-BY-GAP below rather than
// silently dropped or faked. Not yet redesigned around what public Recall
// actually offers.
const GAP = (reason) => ({ untested: true, reason });

// ---------- helpers ----------
function fresh() {
  const dir = mkdtempSync(join(os.tmpdir(), "sentinel-suite-"));
  const path = join(dir, "d.sqlite3");
  return { store: withCompat(new SqliteStore(path)), path, dir };
}
function done(s) { try { s.store.close(); } finally { rmSync(s.dir, { recursive: true, force: true }); } }
function reopen(s) { s.store.close(); s.store = withCompat(new SqliteStore(s.path)); return s.store; }
// getNode(id): probes here were written against a store with this method;
// real SqliteStore only has get(key)/getByHandle(handle). .id alias matches W().
function withCompat(store) {
  store.getNode = (id) => { const c = store.get(id) ?? store.getByHandle(id); return c ? { ...c, id: c.key } : undefined; };
  return store;
}

// Flat proposal matching the current admit() schema. o.operation === "supersede"
// with o.contradicts targets means "supersedes", not "contradicts" — the old
// schema used an intent.operation flag alongside evidence.contradicts to say
// which; the real API expresses both as a real edge relation.
function mkProposal(o = {}) {
  const rel = o.operation === "supersede" ? "supersedes" : "contradicts";
  const edges = [
    ...(o.supports || []).map((target) => ({ relation: "supports", target })),
    ...(o.contradicts || []).map((target) => ({ relation: rel, target })),
  ];
  return {
    kind: o.kind && o.kind !== "observation" ? o.kind : "obs",
    title: o.title,
    body: o.body ?? o.title,
    confidence: o.confidence ?? 0.8,
    project: "suite",
    tenant: "local",
    topics: o.topics || ["fact"],
    entities: o.entities || ["x"],
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.expiresAt !== undefined ? { expiresAt: o.expiresAt } : {}),
    ...(edges.length ? { edges } : {}),
    ...(o.props ? { props: o.props } : {}),
  };
}
const pct = (x) => `${Math.round(x * 100)}%`;
function W(store, o) {
  const createdAt = o.createdAt || "2024-01-01";
  const result = admit(mkProposal(o), { store, now: new Date(createdAt).toISOString() });
  if (!result || result.accepted !== true || !result.cell) {
    throw new Error(`write not admitted: ${o.title} -> ${JSON.stringify(result?.issues ?? result)}`);
  }
  // .id alias (real cells carry .key) and .data.confidence.value alias (real
  // cells carry .scores.conf — the attenuated stated confidence) for the
  // calibration/adversarial checks below, which read the old field path.
  return { ...result.cell, id: result.cell.key, data: { confidence: { value: result.cell.scores.conf } } };
}
function watchProgram(store, title, hyperedgeId, delta) {
  return W(store, {
    title, body: `watch program: ${title}`, confidence: 0.9, topics: ["program"], entities: [], kind: "prg",
    props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { hyperedge: hyperedgeId }, params: { delta } } },
  });
}
function tick(store, programKey) {
  return runProgramCell(store, programKey, new Date().toISOString()).run.output;
}

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
      const hasProv = !!(node && node.provenance && node.provenance.producedBy && node.provenance.origin);
      if (hasProv) ok++;
    }
    // cellAddress (a recall://cell/... URI encoding serving scope) does not exist
    // on real cells — GAP, not silently dropped.
    return { n, metric: `provenance present ${ok}/${n}; store-address encoding UNTESTED (${GAP("cellAddress not in public Recall").reason})`, grade: ok === n ? "RESIDUAL(@INDEPENDENTLY-VERIFIED)" : ok > 0 ? "RESIDUAL(@INDEP)" : "ABSENT" };
  } finally { done(s); }
}

// 5 CONTRADICTION, unprompted lexical/polarity detection. GAP: this measured
// detectAndLinkUnpromptedContradictions, an auto-detection step that does not
// exist in the public Recall build (only an explicit contradicts relation a
// writer can declare at admit time — see ROADMAP). Reporting UNTESTED rather
// than silently passing or faking a detector.
function contradiction() {
  return { n: 0, metric: `UNTESTED: no unprompted lexical/polarity contradiction detector in public Recall (contradiction is writer-declared via edges, not auto-detected)`, grade: "UNTESTED" };
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
      const edge = addHyperedge(s.store, { kind: "evidence-bundle", title: `watch_${i}`, members: [{ key: anchor.key, role: "claim" }] });
      const prog = watchProgram(s.store, `watch_${i}`, edge.id, 0.1);
      tick(s.store, prog.key);
      if (isContra) {
        W(s.store, { title: `event attr_${i}=B`, body: `attr_${i}=B`, contradicts: [anchor.key], topics: ["fact"], entities: [`attr_${i}`] });
        trueC++;
      } else {
        W(s.store, { title: `event other_${i}=Z`, body: `other_${i}=Z`, topics: ["fact"], entities: [`other_${i}`] });
      }
      const tripped = tick(s.store, prog.key).tripped === true;
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
        edges.push({ source: ent[f], target: ent[t] });
        try { addDagOverlay(s.store, { title: `ord@${idx}`, nodeIds: [ent.A, ent.B, ent.C], edges: edges.slice(), metadata: {} }); }
        // real message is "dag overlay is cyclic", not "...cycle..." — /cycl/i covers both.
        catch (err) { if (/cycl/i.test(String(err && err.message)) && caught < 0) caught = idx; }
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
    for (const c of CASES) idCase.set(W(s.store, { title: c.text, createdAt: c.createdAt, expiresAt: c.exp, topics: ["temporal"] }).key, c);
    const expired = new Set(analyzeMemory(s.store, NOW).stale.filter((x) => x.reason === "expired").map((x) => x.key));
    for (const [key, c] of idCase) { const flagged = expired.has(key); if (flagged === c.gold) stalePass++; }
  } finally { done(s); }
  // interval non-contradiction and as-of belief reconstruction both depend on
  // capabilities that do not exist in public Recall (no unprompted lexical
  // contradiction detector; no point-in-time nodesAsOf query) — GAP, not
  // silently dropped or faked.
  const iv = [["Policy P valid in 2024", "Policy P invalid in 2026"], ["Region R online in 2023", "Region R offline in 2025"]];
  const subs = 4;
  const ok = stalePass === CASES.length;
  return {
    n: CASES.length,
    metric: `staleness ${stalePass}/${CASES.length} (unprompted expiry, analyzeMemory); interval (${iv.length} cases) and as-of reconstruction (${subs} subjects) UNTESTED — no unprompted contradiction detector or point-in-time query in public Recall`,
    grade: ok ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED",
  };
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
      // search() returns hits shaped {cell, score}, not the cell directly.
      const hits = reader.search(t.q, { limit: 5 });
      if (hits[0] && hits[0].cell.key === t.id) p1++;
      const node = reader.getNode(t.id);
      if (node && node.body === `payload ${t.tok}`) verbatim++;
    }
    const neg = reader.search("NEVERSTOREDTOKEN-ΩQ7-absent-xyz", { limit: 5 });
    negOk = neg.every((h) => !String(h.cell.title).includes("NEVERSTORED")) ? 1 : 0;
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
    const count = reader.active().length;
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
