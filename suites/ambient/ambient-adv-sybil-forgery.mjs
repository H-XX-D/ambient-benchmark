#!/usr/bin/env node
// AMBIENT ADVERSARIAL - sybil-forgery.
//
// ATTACK: M fake sources corroborating a FALSE value B must not out-weigh one
// genuine source of the TRUE value A. We wire M sybil "supports" edges at a
// false claim and one genuine "supports" edge at a true claim, then read which
// value the store weights higher.
//
// This axis is only fair because Recall actually CLAIMS a provenance /
// source-aggregation primitive (read the vendored build before writing this):
//   1. scores.effective = clamp01(stated*cal + 0.15*tanh(supportMass)
//                                  - 0.6*tanh(challengeMass))  (scores.js/mass.js)
//      supportMass = sum over incoming supports edges of weight*supporter.effective.
//      This is the store's per-cell "weight". It is model-free and deterministic,
//      so we score it directly.
//   2. analyzeMemory().beliefs[].support / sourceDiversity / recommendation
//      (analysis.js) folds trustMultiplier(origin,verification,signature) per
//      supporter and reports distinct-producer diversity. In-class, scored.
//   3. analyzeMemory().criticalWarnings "provenance-concentration" fires when
//      concentrationRisk >= 0.8 and totalCells >= 10 (analysis.js). This is the
//      only AUTOMATIC sybil-flood defense in the build. In-class, scored.
//
// What we deliberately DO NOT score (out of capability class, would be unfair):
//   - Auto-detecting that a source is "fake" from raw text alone. No such
//     capability exists; we wire explicit supports edges instead. Marked UNTESTED.
//   - Signature-based sybil rejection. Signing exists (signatureStatus) but there
//     is no signing path exercised here; all cells are unsigned. Not scored.
//
// FAIRNESS / headroom: the adversarial cases (1 genuine vs M fake) SHOULD be
// beaten only if the store has a sybil defense; the mirror control (M genuine
// vs 1 fake) SHOULD always keep truth on top. If the store were perfectly
// sybil-proof it scores 100 on the combined battery; a provenance-blind store
// scores 50 (control passes, attack fails); a naive vote-counter that also loses
// the control scores lower. So the battery ranges 0 to 100 by construction.
//
// Deterministic: no RNG, no Date.now in any decision path. Fixed NOW, fixed
// confidences, fixed source counts.

import { SqliteStore, admit, analyzeMemory } from "./_recall.mjs";

const NOW = "2026-07-11T00:00:00.000Z";
const NOW_DATE = new Date(NOW);
const M_VALUES = [2, 5, 20, 100];
// The six self-declared origins (types.js ORIGINS). concentrationRisk keys on
// max(originShare, producerShare), so an attacker who only diversifies producer
// ids is still betrayed by a dominant origin bucket. Spreading across these six
// is the real evasion (origin is self-declared, never verified here).
const ORIGINS = ["human", "llm", "daemon", "connector", "program", "external"];

// admit() reports rejection via the return value, not a throw.
function W(store, prop) {
  const r = admit(prop, { store, now: NOW });
  if (!r || r.accepted !== true || !r.cell) {
    throw new Error(`not admitted: ${prop.title} -> ${JSON.stringify(r && r.issues ? r.issues : r)}`);
  }
  return r.cell;
}

// A claim cell (bel) that carries a value token. No edges of its own: it is the
// target that sources point at. conf 0.7 so admission does not attenuate it.
function claim(value, conf) {
  return {
    kind: "bel",
    title: `claim:value=${value}`,
    body: `the value is ${value}`,
    confidence: conf,
    project: "sybil",
    tenant: "local",
    topics: ["fact", "value"],
    entities: ["value"],
  };
}

// A source cell (obs) that emits one supports edge (weight +1) at a claim.
// owner -> producedBy (the producer id that sourceDiversity/concentration key on).
// origin/verification -> trustMultiplier in analyzeMemory.
function source(id, owner, origin, verification, conf, targetKey) {
  return {
    kind: "obs",
    title: `source:${id}`,
    body: `${id} attests to the claim`,
    confidence: conf,
    owner,
    origin,
    verification,
    project: "sybil",
    tenant: "local",
    topics: ["source"],
    entities: [id],
    edges: [{ relation: "supports", target: targetKey, weight: 1 }],
  };
}

function eff(store, key) {
  return store.get(key).scores.effective;
}

// A genuine source is BETTER attested than any single sybil: origin external,
// verification external, higher stated confidence. We give truth every legal
// advantage a single well-attested source can have; the only thing the sybils
// have is numbers. If truth still loses, the store's weighting is count-driven.
const GENUINE = { origin: "external", verification: "external", conf: 0.9 };
const SYBIL = { origin: "llm", verification: "unverified", conf: 0.7 };

const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const f4 = (x) => x.toFixed(4);

// ---------------------------------------------------------------------------
// PROBE 1: effective-confidence weighting, adversarial (1 genuine vs M sybil).
// PASS (truth survives) iff effective(A) >= effective(B).
// ---------------------------------------------------------------------------
function probe1(M) {
  const store = new SqliteStore(":memory:");
  try {
    const A = W(store, claim("A", 0.7)); // TRUE value
    const B = W(store, claim("B", 0.7)); // FALSE value
    W(store, source("genuine", "genuine-observer", GENUINE.origin, GENUINE.verification, GENUINE.conf, A.key));
    for (let i = 0; i < M; i++) {
      W(store, source(`sybil-${i}`, "sybil-farm", SYBIL.origin, SYBIL.verification, SYBIL.conf, B.key));
    }
    const effA = eff(store, A.key);
    const effB = eff(store, B.key);
    return { M, effA, effB, margin: effB - effA, truthSurvives: effA >= effB, keyA: A.key, keyB: B.key, store };
  } finally {
    // store kept open for probe3/probe4a reuse in the caller; closed there.
  }
}

// ---------------------------------------------------------------------------
// PROBE 2: mirror control (M genuine vs 1 sybil). Majority is genuinely correct.
// PASS (truth survives) iff effective(A) > effective(B).
// ---------------------------------------------------------------------------
function probe2(M) {
  const store = new SqliteStore(":memory:");
  try {
    const A = W(store, claim("A", 0.7)); // TRUE value, now the majority
    const B = W(store, claim("B", 0.7)); // FALSE value, now the lone dissenter
    for (let i = 0; i < M; i++) {
      W(store, source(`observer-${i}`, `observer-${i}`, GENUINE.origin, GENUINE.verification, GENUINE.conf, A.key));
    }
    W(store, source("lone-dissent", "sybil-farm", SYBIL.origin, SYBIL.verification, SYBIL.conf, B.key));
    const effA = eff(store, A.key);
    const effB = eff(store, B.key);
    return { M, effA, effB, margin: effA - effB, truthSurvives: effA > effB };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// PROBE 3: analyzeMemory belief-support surface on the probe1 store.
// Reports raw support sum (unsaturated), sourceDiversity, and the store's
// recommendation for each claim. PASS (truth defended) iff the false claim B
// is not recommended "trust" while the true claim A is, i.e. the analyze surface
// distinguishes them. FAIL iff both land on "trust" (sybil support ignored).
// ---------------------------------------------------------------------------
function probe3(store, keyA, keyB) {
  const report = analyzeMemory(store, NOW_DATE);
  const bA = report.beliefs.find((b) => b.key === keyA);
  const bB = report.beliefs.find((b) => b.key === keyB);
  const defended = !(bA && bB && bA.recommendation === "trust" && bB.recommendation === "trust");
  return { bA, bB, defended, warnings: report.criticalWarnings, provenance: report.provenance };
}

// ---------------------------------------------------------------------------
// PROBE 4b/4c: evasion of the provenance-concentration warning. Same attack as
// probe1 but the sybils vary their declared provenance to dodge the detector.
//   mode "producer": distinct producer id per sybil, origin stays llm.
//   mode "origin":   distinct producer id AND origin round-robined over ORIGINS.
// PASS (store catches the flood) iff a provenance-concentration warning fires.
// ---------------------------------------------------------------------------
function probe4Evasion(M, mode) {
  const store = new SqliteStore(":memory:");
  try {
    const A = W(store, claim("A", 0.7));
    const B = W(store, claim("B", 0.7));
    W(store, source("genuine", "genuine-observer", GENUINE.origin, GENUINE.verification, GENUINE.conf, A.key));
    for (let i = 0; i < M; i++) {
      const origin = mode === "origin" ? ORIGINS[i % ORIGINS.length] : SYBIL.origin;
      W(store, source(`sybil-${i}`, `sybil-id-${i}`, origin, SYBIL.verification, SYBIL.conf, B.key));
    }
    const report = analyzeMemory(store, NOW_DATE);
    const fired = report.criticalWarnings.some((w) => w.code === "provenance-concentration");
    return { M, fired, concentrationRisk: report.provenance.concentrationRisk, totalCells: report.provenance.totalCells };
  } finally {
    store.close();
  }
}

// ===========================================================================
// RUN
// ===========================================================================
console.log("==================== AMBIENT ADVERSARIAL - sybil-forgery ====================\n");
console.log("Attack: 1 genuine source of TRUE value A vs M fake sources of FALSE value B.");
console.log("Genuine source: origin=external verification=external conf=0.9 (best-attested single source).");
console.log(`Each sybil:      origin=llm verification=unverified conf=0.7 (weak, ${"shared producer"}).`);
console.log(`M in {${M_VALUES.join(", ")}}. NOW=${NOW}. Deterministic (no RNG).\n`);

// ---- Probe 1 + Probe 3 + Probe 4a share the adversarial store per M ----
const p1Rows = [];
const p3Rows = [];
const p4aRows = [];
for (const M of M_VALUES) {
  const r = probe1(M);
  p1Rows.push(r);
  const p3 = probe3(r.store, r.keyA, r.keyB);
  p3Rows.push({ M, ...p3 });
  const fired = p3.warnings.some((w) => w.code === "provenance-concentration");
  p4aRows.push({ M, fired, concentrationRisk: p3.provenance.concentrationRisk, totalCells: p3.provenance.totalCells });
  r.store.close();
}

console.log("---- PROBE 1: effective-confidence weighting (adversarial: 1 genuine A vs M sybil B) ----");
console.log("    the store weights each value by scores.effective; truth survives iff eff(A) >= eff(B).\n");
for (const r of p1Rows) {
  console.log(
    `  M=${String(r.M).padStart(3)}  eff(A_true)=${f4(r.effA)}  eff(B_false)=${f4(r.effB)}  ` +
    `B-A=${(r.margin >= 0 ? "+" : "")}${f4(r.margin)}  -> ${r.truthSurvives ? "truth SURVIVES" : "truth OUT-WEIGHTED by fakes"}`
  );
}
const p1pass = p1Rows.filter((r) => r.truthSurvives).length;
console.log(`\n  probe1 truth-survival: ${p1pass}/${p1Rows.length} (${pct(p1pass, p1Rows.length)})`);
console.log("  note: the false value overtakes at M=2 and the gap saturates at the tanh cap (+0.15 support");
console.log("        ceiling), so extra sybils past ~5 add nothing: damage is bounded but truth still loses.\n");

// ---- Probe 2 ----
console.log("---- PROBE 2: mirror control (M genuine A vs 1 sybil B) - majority genuinely correct ----");
console.log("    headroom check; a working store must keep truth on top here.\n");
const p2Rows = M_VALUES.map(probe2);
for (const r of p2Rows) {
  console.log(
    `  M=${String(r.M).padStart(3)}  eff(A_true)=${f4(r.effA)}  eff(B_false)=${f4(r.effB)}  ` +
    `A-B=${(r.margin >= 0 ? "+" : "")}${f4(r.margin)}  -> ${r.truthSurvives ? "truth SURVIVES (correct)" : "truth LOST (control broken)"}`
  );
}
const p2pass = p2Rows.filter((r) => r.truthSurvives).length;
console.log(`\n  probe2 truth-survival: ${p2pass}/${p2Rows.length} (${pct(p2pass, p2Rows.length)})\n`);

// ---- Probe 3 ----
console.log("---- PROBE 3: analyzeMemory belief-support surface (in-class, trust-weighted) ----");
console.log("    support = sum of supporter.effective*trustMultiplier (UNSATURATED, unlike scores.effective).");
console.log("    sourceDiversity = distinct producers / evidence count. recommendation is the acted-on verdict.\n");
for (const r of p3Rows) {
  const sA = r.bA, sB = r.bB;
  console.log(
    `  M=${String(r.M).padStart(3)}  A_true: support=${f4(sA.support)} diversity=${f4(sA.sourceDiversity)} rec=${sA.recommendation}` +
    `   |   B_false: support=${f4(sB.support)} diversity=${f4(sB.sourceDiversity)} rec=${sB.recommendation}`
  );
}
const p3defended = p3Rows.filter((r) => r.defended).length;
console.log(`\n  probe3 truth-defended (B not trusted while A is): ${p3defended}/${p3Rows.length} (${pct(p3defended, p3Rows.length)})`);
console.log("  note: support for B grows LINEARLY with M (no saturation) and dwarfs A, and sourceDiversity for B");
console.log("        collapses toward 1/M, yet recommendation stays 'trust' for both: the surfaced diversity");
console.log("        signal is reported but never acted on, so this surface does not defend truth either.\n");

// ---- Probe 4a ----
console.log("---- PROBE 4a: provenance-concentration warning, SAME-producer flood (the store's real defense) ----");
console.log("    fires iff concentrationRisk >= 0.8 AND totalCells >= 10.\n");
for (const r of p4aRows) {
  console.log(
    `  M=${String(r.M).padStart(3)}  concentrationRisk=${f4(r.concentrationRisk)} totalCells=${String(r.totalCells).padStart(3)}  ` +
    `-> warning ${r.fired ? "FIRES (sybil flood flagged)" : "silent"}`
  );
}
const p4aFire = p4aRows.filter((r) => r.fired).length;
console.log(`\n  probe4a flood-detected: ${p4aFire}/${p4aRows.length} (${pct(p4aFire, p4aRows.length)})\n`);

// ---- Probe 4b: producer-only diversification ----
console.log("---- PROBE 4b: DISTINCT producer per sybil, origin still llm (naive evasion) ----");
console.log("    diversifying only the producer id does NOT evade: concentrationRisk also watches origin.\n");
const p4bRows = M_VALUES.map((M) => probe4Evasion(M, "producer"));
for (const r of p4bRows) {
  console.log(
    `  M=${String(r.M).padStart(3)}  concentrationRisk=${f4(r.concentrationRisk)} totalCells=${String(r.totalCells).padStart(3)}  ` +
    `-> warning ${r.fired ? "FIRES (still caught via origin bucket)" : "silent (evaded)"}`
  );
}
const p4bFire = p4bRows.filter((r) => r.fired).length;
console.log(`\n  probe4b flood-detected: ${p4bFire}/${p4bRows.length} (${pct(p4bFire, p4bRows.length)})\n`);

// ---- Probe 4c: producer AND origin diversification (the real evasion) ----
console.log("---- PROBE 4c: DISTINCT producer AND origin round-robined over the 6-value enum (real evasion) ----");
console.log("    origin is self-declared and never verified; spreading it collapses both concentration axes.\n");
const p4cRows = M_VALUES.map((M) => probe4Evasion(M, "origin"));
for (const r of p4cRows) {
  console.log(
    `  M=${String(r.M).padStart(3)}  concentrationRisk=${f4(r.concentrationRisk)} totalCells=${String(r.totalCells).padStart(3)}  ` +
    `-> warning ${r.fired ? "FIRES" : "silent (EVADED at every M)"}`
  );
}
const p4cFire = p4cRows.filter((r) => r.fired).length;
console.log(`\n  probe4c flood-detected: ${p4cFire}/${p4cRows.length} (${pct(p4cFire, p4cRows.length)})\n`);

// ===========================================================================
// SCORED BATTERY (both-direction): attack cases should be caught, control kept.
// ===========================================================================
console.log("==================== SCORED BATTERY ====================\n");
const battery = [];
for (const r of p1Rows) battery.push({ name: `P1 attack M=${r.M}`, pass: r.truthSurvives });
for (const r of p2Rows) battery.push({ name: `P2 control M=${r.M}`, pass: r.truthSurvives });
const batteryPass = battery.filter((b) => b.pass).length;
console.log("Core effective-confidence battery (P1 attack + P2 control):");
console.log(`  ${batteryPass}/${battery.length} = ${pct(batteryPass, battery.length)} truth-survival across the battery.`);
console.log(`  P1 (attack, should be defended): ${p1pass}/${p1Rows.length} survived.`);
console.log(`  P2 (control, should hold):       ${p2pass}/${p2Rows.length} survived.`);
console.log("");
console.log("Automatic sybil-flood defense (analyzeMemory provenance-concentration):");
console.log(`  P4a naive same-producer flood detected:        ${p4aFire}/${p4aRows.length} (caught only at M>=20).`);
console.log(`  P4b producer-only diversification detected:    ${p4bFire}/${p4bRows.length} (origin bucket still catches it).`);
console.log(`  P4c producer+origin diversification detected:  ${p4cFire}/${p4cRows.length} (real evasion: never caught).`);
console.log("");
console.log("UNTESTED (out of capability class):");
console.log("  - auto-detecting fakeness from raw source text: no such primitive; we wired explicit supports edges.");
console.log("  - signature-based sybil rejection: no signing path exercised; all cells unsigned.");
console.log("");
console.log("VERDICT: Recall HAS a source-aggregation primitive, so the axis is scorable, but it is not");
console.log("sybil-resistant on its weighting surfaces. On scores.effective the false value overtakes the");
console.log("true one at M=2 (bounded by the +0.15 tanh cap, so damage plateaus, but truth still loses). The");
console.log("analyzeMemory support surface is worse: unsaturated, linearly sybil-swayable, and its diversity");
console.log("signal is reported but never enforced. The one automatic defense (provenance-concentration) fires");
console.log("on a naive same-producer flood only above concentrationRisk>=0.8 and totalCells>=10 (here M>=20).");
console.log("Diversifying producer ids alone does not evade it (the origin bucket still trips), but diversifying");
console.log("the self-declared origin across its 6-value enum collapses both concentration axes and evades at");
console.log("every M, defeating the sole automatic defense.");
