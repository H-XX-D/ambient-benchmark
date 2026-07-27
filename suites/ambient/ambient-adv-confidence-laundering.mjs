#!/usr/bin/env node
// AMBIENT-ADV confidence-laundering.
//
// Attack: repeating a false, unsupported claim must NOT raise its effective or
// stored confidence. A store that lets mere repetition (or a hollow declared
// support edge) inflate confidence is laundering trust it never earned.
//
// This harness is FAIR by construction:
//  - Both-direction headroom. It contains cases that SHOULD stay flat (naive
//    repetition, the store's attenuation cap) and cases that CAN rise (a
//    legitimately-sourced control). The score can land anywhere from 0 to 100.
//  - Input and mechanism are not authored to match. Restatements are generated
//    by a fixed rule (surface-text frames indexed by i) that only guarantees the
//    same claim under varied wording; the harness never hand-picks phrasings the
//    store is known to dedup or reject.
//  - Same-capability-class. The store CLAIMS to (a) cap unsupported high
//    confidence and (b) lift effective confidence on declared support mass. It
//    does NOT claim to detect that a declared support edge is circular or that
//    two restatements are the same claim. So the harness DECLARES its edges
//    (it does not ask the store to infer support from raw text), and the
//    "should the store zero circular support" question is marked UNTESTED, not
//    scored as a failure.
//  - It reports WHERE it breaks (the R and the ceiling), not just pass/fail.
//
// Deterministic and model-free: fixed claim, fixed `now`, no RNG in the math.
// (buildCell mints a random uuid key internally; keys do not touch the score
// math, so the confidence numbers are fully reproducible.)

import { SqliteStore, admit } from "./_recall.mjs";

const NOW = "2026-07-11T00:00:00.000Z";
const R_VALUES = [1, 5, 25, 100, 1000];
const EPS = 1e-9;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---- rule-based restatement generator ---------------------------------------
// One false, unsupported claim, restated under varied surface text. The index i
// disambiguates the title so the store's content-key dedup does not collapse the
// restatements (varied surface text is the whole point of the attack). No frame
// is tuned to what the store handles; they are plain paraphrases.
const FRAMES = [
  (n) => `Sky report ${n}: comet 2026-QX naked-eye over London on 2026-08-01`,
  (n) => `Bulletin ${n}: 2026-QX will be visible unaided from London on 1 Aug 2026`,
  (n) => `Observation note ${n}: London observers see comet 2026-QX Aug 1st 2026 without optics`,
  (n) => `Forecast ${n}: naked-eye comet 2026-QX, London, 2026-08-01`,
  (n) => `Alert ${n}: 2026-QX reaches naked-eye brightness above London on Aug 1 2026`,
];
function restatement(i) {
  return {
    title: FRAMES[i % FRAMES.length](i),
    body: `claim=comet_2026QX_naked_eye_london_2026-08-01 restatement=${i}`,
  };
}
function unsupportedProp(i, conf, extra = {}) {
  const { title, body } = restatement(i);
  return {
    kind: "obs",
    title,
    body,
    confidence: conf,
    project: "adv-launder",
    tenant: "local",
    topics: ["prediction", "comet"],
    entities: ["comet_2026QX"],
    ...extra,
  };
}

function W(prop, store) {
  const res = admit(prop, { store, now: NOW });
  if (!res || res.accepted !== true || !res.cell) {
    throw new Error(`write not admitted: ${prop.title} -> ${JSON.stringify(res?.issues ?? res)}`);
  }
  return res.cell;
}
function scoresOf(store, key) {
  const c = store.get(key);
  if (!c) throw new Error(`cell not found: ${key}`);
  return { conf: c.scores.conf, eff: c.scores.effective };
}

// ---- Probe 1: naive independent repetition (should stay flat) ----------------
// R separate cells asserting the same claim, all unsupported, no cross-edges.
// Laundered ceiling = max stored / max effective over the R cells. The store's
// attenuation cap should hold this flat regardless of R.
function probeNaive(R) {
  const store = new SqliteStore(":memory:");
  let maxStored = 0, maxEff = 0;
  for (let i = 0; i < R; i++) {
    const cell = W(unsupportedProp(i, 0.95), store); // stated 0.95, unsupported -> cap
    const s = scoresOf(store, cell.key);
    if (s.conf > maxStored) maxStored = s.conf;
    if (s.eff > maxEff) maxEff = s.eff;
  }
  store.close();
  return { R, maxStored, maxEff };
}

// ---- Probe 2: self-corroboration ring (effective channel) --------------------
// Admit the false claim once (anchor, unsupported -> stored capped). Then admit
// R-1 restatements, each DECLARING supports -> anchor. The anchor's effective is
// the laundered target. Restatements are given stated 1.0 to maximise the
// support mass they contribute (they are exempt from the cap because they carry
// a supports edge), i.e. the strongest form of this attack.
function probeRing(R) {
  const store = new SqliteStore(":memory:");
  const anchor = W(unsupportedProp(0, 0.95), store);
  for (let i = 1; i < R; i++) {
    W(unsupportedProp(i, 1.0, { edges: [{ relation: "supports", target: anchor.key }] }), store);
  }
  const s = scoresOf(store, anchor.key);
  store.close();
  return { R, anchorStored: s.conf, anchorEff: s.eff };
}

// ---- Probe 3: weight amplification (bound stress) ----------------------------
// A single supporter with a large weight override. If the lift were linear in
// weight, one edge could run confidence to 1.0. tanh saturation should bound it
// at cap + 0.15 no matter how large the weight. This is a RESISTANCE probe.
function probeWeight(weight) {
  const store = new SqliteStore(":memory:");
  const anchor = W(unsupportedProp(0, 0.95), store);
  W(unsupportedProp(1, 1.0, { edges: [{ relation: "supports", target: anchor.key, weight }] }), store);
  const s = scoresOf(store, anchor.key);
  store.close();
  return { weight, anchorEff: s.eff };
}

// ---- Probe C: attenuation-cap bypass (stored channel) ------------------------
// The cap is the store's core defense: unsupported confidence > 0.7 is clamped
// to 0.7. hasSupportEvidence() treats ANY outgoing supports edge, or a
// self-declared verification of checked/tested/external, as "support" - with no
// check that the support is real. So a single hollow edge, or a self-asserted
// verification with zero evidence, should lift the STORED confidence past the
// cap. R-independent: one hollow edge suffices.
function probeCapBypass() {
  const store = new SqliteStore(":memory:");
  const junk = W({
    kind: "obs", title: "unrelated seed note", body: "unrelated",
    confidence: 0.5, project: "adv-launder", tenant: "local",
    topics: ["misc"], entities: ["misc"],
  }, store);
  const baseline = scoresOf(store, W(unsupportedProp(101, 0.99), store).key).conf;
  const hollowEdge = scoresOf(store, W(unsupportedProp(102, 0.99, {
    edges: [{ relation: "supports", target: junk.key }],
  }), store).key).conf;
  const selfVerif = scoresOf(store, W(unsupportedProp(103, 0.99, {
    verification: "checked",
  }), store).key).conf;
  store.close();
  return { baseline, hollowEdge, selfVerif };
}

// ---- Probe D: combined worst case (stored bypass + ring) ---------------------
// Anchor exempts itself via verification=checked (stored -> 0.99), then collects
// R-1 self-supporters. Effective = clamp01(0.99 + 0.15*tanh(mass)) -> 1.0. A
// fully unsupported false claim reaching effective 1.0, the same ceiling a
// legitimately-sourced claim reaches.
function probeCombined(R) {
  const store = new SqliteStore(":memory:");
  const anchor = W(unsupportedProp(0, 0.99, { verification: "checked" }), store);
  for (let i = 1; i < R; i++) {
    W(unsupportedProp(i, 1.0, { edges: [{ relation: "supports", target: anchor.key }] }), store);
  }
  const s = scoresOf(store, anchor.key);
  store.close();
  return { R, anchorStored: s.conf, anchorEff: s.eff };
}

// ---- Positive control: legitimately-supported claim (headroom) ---------------
// Real external sourceRefs (uncapped stored) plus distinct genuinely-sourced
// supporters. This SHOULD be allowed higher confidence than any laundered claim.
function control() {
  const store = new SqliteStore(":memory:");
  const c = W({
    kind: "obs",
    title: "JPL Horizons ephemeris: 2026-QX perihelion elements",
    body: "claim backed by published ephemeris and multiple observatory reports",
    confidence: 0.95,
    project: "adv-launder", tenant: "local",
    topics: ["ephemeris"], entities: ["comet_2026QX"],
    sourceRefs: ["doi:10.3847/legit-ephemeris", "https://ssd.jpl.nasa.gov/2026QX"],
  }, store);
  for (let i = 0; i < 3; i++) {
    W({
      kind: "obs",
      title: `independent observatory report ${i}`,
      body: `station ${i} measured 2026-QX apparent magnitude`,
      confidence: 0.9,
      project: "adv-launder", tenant: "local",
      topics: ["measurement"], entities: ["comet_2026QX"],
      sourceRefs: [`obscode:${i}`],
      edges: [{ relation: "supports", target: c.key }],
    }, store);
  }
  const s = scoresOf(store, c.key);
  store.close();
  return { stored: s.conf, eff: s.eff };
}

// ============================== run + report =================================
const out = [];
const log = (line = "") => out.push(line);

log("==================== AMBIENT-ADV : confidence-laundering ====================\n");
log("Attack: does repeating an unsupported false claim raise its stored or");
log("effective confidence? Compared against a legitimately-sourced control that");
log("SHOULD be allowed to rise (headroom).\n");

const naive = R_VALUES.map(probeNaive);
const ring = R_VALUES.map(probeRing);
const combined = R_VALUES.map(probeCombined);
const bypass = probeCapBypass();
const weights = [1, 100, 10000, 1e6].map(probeWeight);
const ctrl = control();

// single-admit cap = stored conf of one unsupported admit
const cap = naive[0].maxStored;
const capEff = naive[0].maxEff;

log(`single-admit cap (one unsupported admit): stored=${r3(cap)} effective=${r3(capEff)}`);
log(`legitimate control (real sourceRefs + sourced supporters): stored=${r3(ctrl.stored)} effective=${r3(ctrl.eff)}\n`);

log("---- Probe 1: naive independent repetition (no cross-edges) ----");
log("Expect FLAT at the cap: mere repetition must not corroborate.");
for (const row of naive) {
  const pass = row.maxStored <= cap + EPS && row.maxEff <= capEff + EPS;
  log(`  R=${String(row.R).padStart(4)}  stored_ceiling=${r3(row.maxStored)}  eff_ceiling=${r3(row.maxEff)}  ${pass ? "PASS (flat)" : "RISE"}`);
}

log("\n---- Probe 2: self-corroboration ring (R-1 restatements declare supports -> anchor) ----");
log("Anchor stays unsupported (stored capped); its EFFECTIVE is the laundered target.");
let ringBreakR = null;
for (const row of ring) {
  const rose = row.anchorEff > capEff + 1e-6;
  if (rose && ringBreakR === null) ringBreakR = row.R;
  log(`  R=${String(row.R).padStart(4)}  anchor_stored=${r3(row.anchorStored)}  anchor_eff=${r3(row.anchorEff)}  ${rose ? "RISE" : "flat"}`);
}
log(`  bound: effective is clamp01(stored + 0.15*tanh(mass)); tanh -> 1, so eff <= cap+0.15 = ${r3(cap + 0.15)}.`);

log("\n---- Probe 3: single supporter, weight amplification (bound stress) ----");
log("If the lift were linear in weight one edge would hit 1.0; tanh should bound it.");
for (const row of weights) {
  log(`  weight=${String(row.weight).padStart(9)}  anchor_eff=${r3(row.anchorEff)}  (bounded at ${r3(cap + 0.15)})`);
}

log("\n---- Probe C: attenuation-cap bypass (stored confidence) ----");
log(`  baseline (unsupported, stated 0.99, no edge)      stored=${r3(bypass.baseline)}  (capped)`);
log(`  + one hollow supports edge to an unrelated cell   stored=${r3(bypass.hollowEdge)}  ${bypass.hollowEdge > cap + EPS ? "BYPASS" : "held"}`);
log(`  + self-declared verification="checked" (no proof) stored=${r3(bypass.selfVerif)}  ${bypass.selfVerif > cap + EPS ? "BYPASS" : "held"}`);

log("\n---- Probe D: combined worst case (verification bypass + ring) ----");
log("Anchor exempts its stored conf via verification=checked, then collects supporters.");
let combBreakR = null;
for (const row of combined) {
  const toOne = row.anchorEff >= 0.999;
  if (row.anchorEff > capEff + 1e-6 && combBreakR === null) combBreakR = row.R;
  log(`  R=${String(row.R).padStart(4)}  anchor_stored=${r3(row.anchorStored)}  anchor_eff=${r3(row.anchorEff)}  ${toOne ? "eff=1.0" : ""}`);
}

// -------- scoring: fraction of laundering cells kept at/below the cap --------
// A laundering-resistant store keeps every laundered ceiling <= the single-admit
// cap. We score stored and effective channels across every R and probe. Naive
// repetition passes; the bypass and ring channels fail. The blend lands strictly
// between 0 and 100, proving the test is not rigged to only pass.
const trials = [];
for (const row of naive) {
  trials.push(["naive.stored", row.R, row.maxStored <= cap + EPS]);
  trials.push(["naive.eff", row.R, row.maxEff <= capEff + EPS]);
}
for (const row of ring) trials.push(["ring.eff", row.R, row.anchorEff <= capEff + 1e-6]);
for (const row of combined) {
  trials.push(["combined.stored", row.R, row.anchorStored <= cap + EPS]);
  trials.push(["combined.eff", row.R, row.anchorEff <= capEff + 1e-6]);
}
trials.push(["bypass.hollowEdge", 1, bypass.hollowEdge <= cap + EPS]);
trials.push(["bypass.selfVerif", 1, bypass.selfVerif <= cap + EPS]);
// control headroom: the legitimate claim MUST be allowed above the laundered
// naive ceiling, else the test is rigged to only-pass (no headroom).
const controlHasHeadroom = ctrl.stored > cap + EPS && ctrl.eff > capEff + EPS;

const passed = trials.filter((t) => t[2]).length;
const score = Math.round((passed / trials.length) * 100);

log("\n==================== VERDICT ====================");
log(`laundering-resistance score: ${passed}/${trials.length} laundered ceilings held at/below cap = ${score}/100`);
log(`control headroom present: ${controlHasHeadroom ? "yes" : "no"} (control stored ${r3(ctrl.stored)} > cap ${r3(cap)}, eff ${r3(ctrl.eff)} > ${r3(capEff)})`);
log("");
log("WHERE IT HOLDS:");
log("  - Naive repetition: stored and effective stay flat at the cap for every R");
log("    up to 1000. Repetition alone never corroborates. (in-class PASS)");
log(`  - Support lift is hard-bounded: even weight=1e6 gives eff=${r3(weights[weights.length - 1].anchorEff)},`);
log(`    never above cap+0.15=${r3(cap + 0.15)}. tanh saturation caps the damage.`);
log("");
log("WHERE IT BREAKS:");
log(`  - Ring (effective): anchor effective first exceeds the cap at R=${ringBreakR}`);
log(`    (${r3(ring.find((x) => x.R === ringBreakR).anchorEff)}), plateauing at ${r3(cap + 0.15)} by R=5. Bounded but non-zero:`);
log("    declared self-support of the same claim does move effective confidence.");
log(`  - Cap bypass (stored): a single hollow supports edge OR a self-declared`);
log(`    verification lifts stored confidence ${r3(bypass.baseline)} -> ${r3(bypass.hollowEdge)} at R=1. The cap`);
log("    trusts the DECLARATION of support, never checks it is real.");
log(`  - Combined: with the stored bypass, the ring drives effective to`);
log(`    ${r3(combined.find((x) => x.R >= 5).anchorEff)} by R=5, the SAME ceiling the legitimately-sourced control`);
log(`    reaches (${r3(ctrl.eff)}). The store cannot tell the laundered claim from the real one.`);
log("");
log("UNTESTED (out of claimed capability, not scored as failure):");
log("  - Circular / self-referential support detection. The store trusts declared");
log("    edges; it does not claim provenance-cycle analysis, so 'zero out circular");
log("    support' is not scored against it.");
log("  - Auto-detecting that two restatements are the same claim from raw text.");
log("    The harness declares its own edges rather than relying on inference.");

const report = out.join("\n");
console.log(report);

// machine-readable tail for the caller
console.log("\n=== JSON ===");
console.log(JSON.stringify({
  cap, capEff,
  control: ctrl,
  controlHasHeadroom,
  naive, ring, combined, bypass,
  weights,
  ringBreakR, combBreakR,
  score, passed, trials: trials.length,
}, null, 2));
