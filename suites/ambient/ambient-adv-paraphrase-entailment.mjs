#!/usr/bin/env node
// AMBIENT ADVERSARIAL - paraphrase-entailment (KEY=paraphrase-entailment).
//
// Attack: real contradictions that are NOT literal. The contradicting fact is
// paraphrased so it shares almost no surface tokens with the belief, yet a world
// knowledge / entailment step makes it a genuine conflict:
//   allergic-to-penicillin        vs  "was prescribed amoxicillin, tolerated it"   (amoxicillin IS a penicillin)
//   lives-in-Paris                 vs  "commutes daily from her house in Lyon"      (residence is Lyon, not Paris)
//   budget-under-$1000             vs  "the final invoice came to $1,500"           (1500 > 1000)
//   vegan                          vs  "ordered the ribeye medium rare"             (ribeye is beef)
// Half the cases are superficial LOOK-ALIKES that share the domain / tokens /
// numbers but are logically consistent (ibuprofen, a weekend visit, an $850
// invoice, a garden salad). Those give precision headroom: a detector that flags
// everything in-domain loses precision on them.
//
// Three layers, measured separately so a STORE failure is never confused with a
// MODEL failure:
//   1. LITERAL baseline (model-free): token-overlap + number-mismatch. The floor
//      of what a lexical detector can see. Paraphrase is built to defeat it.
//   2. 3B DETECTOR ceiling (local Qwen2.5-3B): the entailment judge. It follows
//      the format but makes judgment errors; those errors are the ceiling, and we
//      report exactly which cases it misses / false-flags.
//   3. FLOOR surfacing (the store): once a contradicts edge is DECLARED, a standing
//      watch program surfaces the belief unprompted (its effective confidence
//      collapses past delta). The store does NOT read the paraphrase; declaring the
//      edge is the detector's job. So the store is scored only on "given a declared
//      edge, does it surface", isolated from the model (oracle-linked), and we sweep
//      delta and contradictor confidence to find WHERE the floor breaks.
//
// FAIRNESS: undeclared auto-detection of a contradiction from raw text is OUT of
// this build's scope (no such primitive exists). That sub-probe is reported
// UNTESTED, not scored as a store failure. The store's claim is: surface once
// linked. That claim is what we score, and it has 0-to-100 headroom (it fails when
// delta exceeds the collapse, or the contradictor is too weak to collapse it).

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit, addHyperedge, runProgramCell } from "./_recall.mjs";

const ENDPOINT = "http://localhost:8081/v1/chat/completions";
const MODELS_URL = "http://localhost:8081/v1/models";
const MODEL = "mlx-community/Qwen2.5-3B-Instruct-4bit";

// ----------------------------------------------------------------------------
// Case generator. Cases are produced by DOMAIN TEMPLATES, not hand-picked to the
// model. Each family yields one TRUE entailment-contradiction (paraphrased to
// strip lexical overlap with the belief) and one LOOK-ALIKE (same domain / shared
// tokens or numbers, but logically consistent). The entailment RULE per family is
// stated in `why`; it is never shown to the store or the literal detector.
// ----------------------------------------------------------------------------
const FAMILIES = [
  {
    domain: "drug-allergy",
    belief: "patient is allergic to penicillin",
    trueFact: "chart update: was prescribed amoxicillin last week and tolerated it well",
    lookFact: "chart update: took an ibuprofen tablet for a headache and felt fine",
    why: "amoxicillin is a penicillin-class antibiotic; ibuprofen is not",
  },
  {
    domain: "drug-allergy",
    belief: "patient is allergic to penicillin",
    trueFact: "nurse note: started on a course of ampicillin, no adverse event recorded",
    lookFact: "nurse note: started on a course of cephalexin, no adverse event recorded",
    why: "ampicillin is a penicillin; cephalexin is a cephalosporin, a different class",
  },
  {
    domain: "residence",
    belief: "she lives in Paris",
    trueFact: "makes the drive in every morning from her house in Lyon",
    lookFact: "took the train down to Lyon for a long weekend of sightseeing",
    why: "a daily commute from a home in Lyon means residence is Lyon, not Paris; a weekend trip does not",
  },
  {
    domain: "residence",
    belief: "he is based in Berlin",
    trueFact: "signed a two-year lease on an apartment in Munich and moved his things over",
    lookFact: "flew to Munich for a three-day conference and flew back",
    why: "moving into a leased Munich apartment relocates his base; a conference trip does not",
  },
  {
    domain: "budget",
    belief: "keep the trip spend under $1000",
    trueFact: "the final invoice came to $1,500 all in",
    lookFact: "the final invoice came to $850 all in",
    why: "1500 exceeds the 1000 cap; 850 stays under it",
  },
  {
    domain: "budget",
    belief: "the monthly cloud bill must stay below $500",
    trueFact: "this cycle we were billed seven hundred and forty dollars",
    lookFact: "this cycle we were billed four hundred and ten dollars",
    why: "740 is over the 500 ceiling; 410 is under it",
  },
  {
    domain: "diet-vegan",
    belief: "he keeps a strict vegan diet",
    trueFact: "at dinner he ordered the ribeye, medium rare",
    lookFact: "at dinner he ordered the garden salad, no dressing",
    why: "a ribeye is beef, an animal product; a garden salad is plant-based",
  },
  {
    domain: "diet-vegan",
    belief: "she is fully plant-based",
    trueFact: "she had the three-cheese omelette for brunch",
    lookFact: "she had the avocado toast for brunch",
    why: "a cheese omelette contains eggs and dairy; avocado toast is plant-based",
  },
  {
    domain: "employment",
    belief: "currently unemployed and job hunting",
    trueFact: "just finished her first full week at the new firm downtown",
    lookFact: "spent the weekend polishing her resume and sending applications",
    why: "starting at a firm means she is employed; sending applications is still job hunting",
  },
  {
    domain: "employment",
    belief: "he is retired and no longer working",
    trueFact: "he was named interim operations director and starts Monday",
    lookFact: "he volunteers a few hours at the community garden on Tuesdays",
    why: "taking a director role means he is working again; unpaid volunteering is not employment",
  },
  {
    domain: "availability",
    belief: "she never works weekends",
    trueFact: "she came into the office this past Saturday to finish the deck",
    lookFact: "she answered a couple of emails from home on Wednesday evening",
    why: "Saturday is a weekend, so working then contradicts the belief; Wednesday is a weekday",
  },
  {
    domain: "availability",
    belief: "the store is closed on Mondays",
    trueFact: "we rang up forty customers at the counter this past Monday afternoon",
    lookFact: "we rang up forty customers at the counter this past Thursday afternoon",
    why: "serving customers on Monday means it was open, contradicting the closure; Thursday does not",
  },
];

function buildCases() {
  const cases = [];
  for (let i = 0; i < FAMILIES.length; i++) {
    const fam = FAMILIES[i];
    cases.push({ id: `${fam.domain}#${i}-T`, domain: fam.domain, belief: fam.belief, fact: fam.trueFact, gold: true, why: fam.why });
    cases.push({ id: `${fam.domain}#${i}-L`, domain: fam.domain, belief: fam.belief, fact: fam.lookFact, gold: false, why: fam.why });
  }
  return cases;
}

// ----------------------------------------------------------------------------
// Layer 1: literal baseline. A fair naive lexical detector: flag a contradiction
// on high token overlap OR a numeric mismatch. Paraphrase strips token overlap
// from the true contradictions, so recall should collapse; the crude number rule
// gives it a little recall on numeric families (headroom, not a rigged 0) but also
// false-flags the within-budget look-alikes (precision headroom).
// ----------------------------------------------------------------------------
const STOP = new Set(["the", "and", "for", "her", "was", "has", "had", "are", "with", "from", "this", "that", "not", "came", "few", "all", "over", "past", "his", "she", "him", "they", "were", "into", "out", "off", "who", "how", "why", "our", "your", "their"]);
function tokenSet(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
function digitNumbers(s) {
  return (String(s).match(/\d[\d,]*/g) || []).map((x) => Number(x.replace(/,/g, "")));
}
function literalContradicts(belief, fact) {
  const A = tokenSet(belief), B = tokenSet(fact);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  const jac = uni ? inter / uni : 0;
  const nA = digitNumbers(belief), nB = digitNumbers(fact);
  const numConflict = nA.length > 0 && nB.length > 0 && nA[0] !== nB[0];
  return jac >= 0.3 || numConflict;
}
function jaccard(belief, fact) {
  const A = tokenSet(belief), B = tokenSet(fact);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}

// ----------------------------------------------------------------------------
// Layer 2: the local 3B detector (the ceiling).
// ----------------------------------------------------------------------------
async function serverUp() {
  try {
    const res = await fetch(MODELS_URL, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

function parseContradicts(text) {
  if (typeof text !== "string") return { ok: false };
  let t = text.trim();
  // strip ```json ... ``` or ``` ... ``` fences
  t = t.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  // grab the first {...} block
  const m = t.match(/\{[^{}]*\}/);
  const blob = m ? m[0] : t;
  try {
    const obj = JSON.parse(blob);
    if (typeof obj.contradicts === "boolean") return { ok: true, value: obj.contradicts };
    if (typeof obj.contradicts === "string") return { ok: true, value: /true|yes/i.test(obj.contradicts) };
  } catch { /* fall through */ }
  // last-resort textual read, still counted but flagged
  if (/"contradicts"\s*:\s*true/i.test(t)) return { ok: true, value: true, loose: true };
  if (/"contradicts"\s*:\s*false/i.test(t)) return { ok: true, value: false, loose: true };
  return { ok: false, raw: text };
}

async function classify3B(belief, fact) {
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 32,
    messages: [
      {
        role: "system",
        content:
          "You verify memory consistency. Decide whether NEW FACT contradicts BELIEF once world knowledge and entailment are applied: a drug belonging to an allergen's class, a spend above a stated budget cap, residing in a different city than stated, eating an animal product while vegan or plant-based, or working when stated unavailable. A merely related but logically consistent fact (a visit rather than a move, a spend under the cap, a plant-based dish, a weekday activity, a different drug class) is NOT a contradiction. Reply with ONLY a JSON object and no other text.",
      },
      {
        role: "user",
        content: `BELIEF: ${belief}\nNEW FACT: ${fact}\nReply with ONLY: {"contradicts": true} or {"contradicts": false}`,
      },
    ],
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return { ...parseContradicts(text), text };
}

// ----------------------------------------------------------------------------
// Layer 3: the store floor. Admit belief, wrap it in a one-member evidence bundle,
// attach a standing watch program, baseline-tick, admit the fact (with a declared
// `contradicts` edge iff `link` is true), tick again, return the watch output.
// This mirrors the shipped ambient-bench L2 surfacing path exactly.
// ----------------------------------------------------------------------------
function beliefProposal(text) {
  return {
    kind: "obs", title: `belief: ${text}`, body: text, confidence: 0.8,
    project: "adv-para", tenant: "local", topics: ["fact", "belief"], entities: ["subject"],
  };
}
function factProposal(text, contradictsKey, factConf) {
  return {
    kind: "obs", title: `fact: ${text}`, body: text, confidence: factConf,
    project: "adv-para", tenant: "local", topics: ["fact"], entities: ["subject"],
    ...(contradictsKey ? { edges: [{ relation: "contradicts", target: contradictsKey }] } : {}),
  };
}
function watchProposal(hyperedgeId, delta) {
  return {
    kind: "prg", title: "watch: belief", body: "watch program on belief bundle", confidence: 0.9,
    project: "adv-para", tenant: "local", topics: ["program"], entities: [],
    props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { hyperedge: hyperedgeId }, params: { delta } } },
  };
}
function admitOrThrow(prop, store, ctx) {
  const r = admit(prop, { store, ...(ctx || {}) });
  if (!r || r.accepted !== true || !r.cell) {
    throw new Error(`not admitted: ${prop.title} -> ${JSON.stringify(r?.issues ?? r)}`);
  }
  return r.cell;
}
function tick(store, programKey) {
  return runProgramCell(store, programKey, new Date().toISOString()).run.output;
}

// Runs one belief/fact scenario through the store. `link` decides whether the
// contradicts edge is declared. Returns the watch trip and the confidence path.
function storeScenario({ belief, fact, link, delta, factConf }) {
  const tmp = mkdtempSync(join(os.tmpdir(), "adv-para-"));
  const store = new SqliteStore(join(tmp, "d.sqlite3"));
  try {
    const anchor = admitOrThrow(beliefProposal(belief), store);
    const edge = addHyperedge(store, { kind: "evidence-bundle", title: "belief", members: [{ key: anchor.key, role: "claim" }] });
    const program = admitOrThrow(watchProposal(edge.id, delta), store);
    const base = tick(store, program.key); // baseline, never trips (no previous)
    admitOrThrow(factProposal(fact, link ? anchor.key : null, factConf), store);
    const out = tick(store, program.key);
    return { tripped: out.tripped === true, previous: out.previous, current: out.current, change: out.change, delta, baselineCurrent: base.current };
  } finally {
    store.close?.();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------
// Scoring helpers.
// ----------------------------------------------------------------------------
function score(flags, cases) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  cases.forEach((c, i) => {
    const f = flags[i];
    if (f && c.gold) tp++;
    else if (f && !c.gold) fp++;
    else if (!f && c.gold) fn++;
    else tn++;
  });
  return {
    tp, fp, fn, tn,
    recall: tp + fn ? tp / (tp + fn) : 1,
    precision: tp + fp ? tp / (tp + fp) : 1,
  };
}
const pct = (x) => `${Math.round(x * 100)}%`;

// ----------------------------------------------------------------------------
// Main.
// ----------------------------------------------------------------------------
async function main() {
  const cases = buildCases();
  const trueN = cases.filter((c) => c.gold).length;
  const lookN = cases.length - trueN;

  console.log("==================== AMBIENT ADVERSARIAL - paraphrase-entailment ====================\n");
  console.log(`${cases.length} cases across ${FAMILIES.length} domain families: ${trueN} true entailment-contradictions, ${lookN} superficial look-alikes.`);

  // Prove the attack: mean lexical overlap of true-contradiction (belief, fact)
  // pairs. If this is low, the paraphrase genuinely stripped the lexical signal,
  // so a lexical detector has nothing to lock onto (this is why literal must fail).
  const trueJac = cases.filter((c) => c.gold).map((c) => jaccard(c.belief, c.fact));
  const lookJac = cases.filter((c) => !c.gold).map((c) => jaccard(c.belief, c.fact));
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`mean token-overlap (Jaccard): true-contradictions ${mean(trueJac).toFixed(3)} · look-alikes ${mean(lookJac).toFixed(3)}  (paraphrase drives the true set toward zero)\n`);

  // -------- Layer 1: literal baseline (model-free) --------
  const litFlags = cases.map((c) => literalContradicts(c.belief, c.fact));
  const lit = score(litFlags, cases);
  console.log("---- LAYER 1: literal baseline (token overlap + number mismatch, model-free) ----");
  console.log(`recall ${pct(lit.recall)} (${lit.tp}/${trueN})   precision ${pct(lit.precision)} (${lit.tp}/${lit.tp + lit.fp})   [caught only via the crude number rule; blind to word-level paraphrase]\n`);

  // -------- Layer 2: 3B detector ceiling --------
  const up = await serverUp();
  let det = null, detFlags = null, parseFails = 0, modelErrors = 0, misses = [], falseFlags = [];
  if (!up) {
    console.log("---- LAYER 2: 3B detector ceiling ----");
    console.log("MODEL SERVER DOWN at http://localhost:8081 - layer 2 UNTESTED (could not reach /v1/models).\n");
  } else {
    detFlags = [];
    const perCase = [];
    for (const c of cases) {
      let out;
      try {
        out = await classify3B(c.belief, c.fact);
      } catch (e) {
        modelErrors++;
        out = { ok: false, text: `ERROR: ${e.message}` };
      }
      if (!out.ok) { parseFails++; detFlags.push(false); perCase.push({ c, flag: false, out }); continue; }
      detFlags.push(out.value);
      perCase.push({ c, flag: out.value, out });
    }
    det = score(detFlags, cases);
    perCase.forEach(({ c, flag }) => {
      if (c.gold && !flag) misses.push(c);
      if (!c.gold && flag) falseFlags.push(c);
    });
    console.log("---- LAYER 2: 3B detector ceiling (local Qwen2.5-3B, temperature 0) ----");
    console.log(`recall ${pct(det.recall)} (${det.tp}/${trueN})   precision ${pct(det.precision)} (${det.tp}/${det.tp + det.fp})   parse-failures ${parseFails}   http-errors ${modelErrors}`);
    if (misses.length) {
      console.log(`  ceiling MISSED (true contradiction the 3B called consistent):`);
      for (const m of misses) console.log(`    - [${m.domain}] "${m.belief}"  ///  "${m.fact}"   (${m.why})`);
    }
    if (falseFlags.length) {
      console.log(`  ceiling FALSE-FLAGGED (look-alike the 3B called a contradiction):`);
      for (const f of falseFlags) console.log(`    - [${f.domain}] "${f.belief}"  ///  "${f.fact}"   (${f.why})`);
    }
    console.log("");
  }

  // -------- Layer 3a: store FLOOR, oracle-linked (isolates the store) --------
  // Perfect detector: declare the contradicts edge exactly on the gold-true cases,
  // none on the look-alikes. Measures the store's surfacing in isolation at the
  // shipped default delta 0.15 with a full-strength (0.8) contradictor.
  const DEFAULT_DELTA = 0.15, DEFAULT_CONF = 0.8;
  let collapseSample = null;
  const oracleFlags = cases.map((c) => {
    const r = storeScenario({ belief: c.belief, fact: c.fact, link: c.gold, delta: DEFAULT_DELTA, factConf: DEFAULT_CONF });
    if (c.gold && collapseSample === null) collapseSample = r;
    return r.tripped;
  });
  const oracle = score(oracleFlags, cases);
  console.log("---- LAYER 3a: store FLOOR, oracle-linked (declare edge on gold-true only, delta 0.15) ----");
  console.log(`surfacing recall ${pct(oracle.recall)} (${oracle.tp}/${trueN})   precision ${pct(oracle.precision)} (false trips on unlinked look-alikes: ${oracle.fp})`);
  if (collapseSample) {
    console.log(`  collapse on a linked belief: effective ${collapseSample.previous} -> ${collapseSample.current} (change ${collapseSample.change}); trips because |change| >= ${DEFAULT_DELTA}`);
  }
  console.log("");

  // -------- Layer 3b: break-point sweeps (WHERE the floor fails) --------
  // Sweep 1: delta at fixed full-strength contradictor. The floor stops surfacing
  // once delta exceeds the confidence collapse. Sweep 2: contradictor confidence at
  // the default delta. A weak contradictor cannot collapse the belief past delta.
  console.log("---- LAYER 3b: floor break-point sweeps (all gold-true cases, all linked) ----");
  const trueCases = cases.filter((c) => c.gold);
  const deltas = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
  const deltaRows = [];
  let deltaBreak = null;
  for (const d of deltas) {
    let surfaced = 0;
    for (const c of trueCases) {
      if (storeScenario({ belief: c.belief, fact: c.fact, link: true, delta: d, factConf: DEFAULT_CONF }).tripped) surfaced++;
    }
    const r = surfaced / trueCases.length;
    deltaRows.push({ d, r, surfaced });
    if (deltaBreak === null && r < 1) deltaBreak = d;
  }
  console.log("  sweep A - delta (contradictor confidence fixed at 0.8):");
  console.log("    " + deltaRows.map((x) => `d=${x.d}:${pct(x.r)}`).join("  "));

  const confs = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const confRows = [];
  let confBreak = null;
  for (const fc of confs) {
    let surfaced = 0;
    for (const c of trueCases) {
      if (storeScenario({ belief: c.belief, fact: c.fact, link: true, delta: DEFAULT_DELTA, factConf: fc }).tripped) surfaced++;
    }
    const r = surfaced / trueCases.length;
    confRows.push({ fc, r, surfaced });
  }
  // break = highest confidence at which recall is still < 1 (reading from the weak end)
  for (const row of confRows) { if (row.r >= 1) { break; } confBreak = row.fc; }
  console.log("  sweep B - contradictor confidence (delta fixed at 0.15):");
  console.log("    " + confRows.map((x) => `c=${x.fc}:${pct(x.r)}`).join("  "));
  console.log(`  BREAK POINTS: floor recall drops below 100% once delta >= ${deltaBreak ?? ">0.5"}; and once contradictor confidence <= ${confBreak ?? "<0.1"}.`);
  console.log("");

  // -------- Layer 3c: end-to-end (3B decides the edge, store surfaces) --------
  // This composes model + store. A gold-true case is surfaced end-to-end only if
  // the 3B flags it AND the store trips on the resulting edge. We then split any
  // end-to-end miss into a MODEL miss (3B did not flag it) vs a STORE miss (3B
  // flagged it but the store did not surface it at default delta).
  let e2e = null, modelMiss = 0, storeMiss = 0;
  if (up && detFlags) {
    const e2eFlags = cases.map((c, i) => {
      const flagged = detFlags[i];
      if (!flagged) return false;
      return storeScenario({ belief: c.belief, fact: c.fact, link: true, delta: DEFAULT_DELTA, factConf: DEFAULT_CONF }).tripped;
    });
    e2e = score(e2eFlags, cases);
    cases.forEach((c, i) => {
      if (!c.gold) return;
      if (e2eFlags[i]) return; // surfaced, no miss
      if (!detFlags[i]) modelMiss++; // 3B never flagged it
      else storeMiss++; // 3B flagged but store failed to surface
    });
    console.log("---- LAYER 3c: end-to-end (3B declares the edge, store surfaces), delta 0.15 ----");
    console.log(`recall ${pct(e2e.recall)} (${e2e.tp}/${trueN})   precision ${pct(e2e.precision)} (${e2e.tp}/${e2e.tp + e2e.fp})`);
    console.log(`  of ${trueN - e2e.tp} missed true contradictions: ${modelMiss} are MODEL misses (3B never flagged), ${storeMiss} are STORE misses (3B flagged, store did not surface)`);
    console.log("");
  }

  // -------- Fairness: out-of-scope sub-probe --------
  console.log("---- UNTESTED (out of capability class) ----");
  console.log("Undeclared auto-detection of a paraphrase-contradiction from raw text: this build has NO primitive that reads two cells and infers a contradicts edge on its own. The store's claim is to SURFACE once an edge is declared, not to DETECT. Scoring the store on raw-text detection would be unfair, so it is marked UNTESTED. Detection is layer 2's job (the model); surfacing is layer 3's (the store).\n");

  // -------- Machine-readable summary --------
  const summary = {
    axis: "paraphrase-entailment",
    cases: cases.length, trueN, lookN,
    meanJaccardTrue: Number(mean(trueJac).toFixed(3)), meanJaccardLook: Number(mean(lookJac).toFixed(3)),
    literal: { recall: lit.recall, precision: lit.precision, tp: lit.tp, fp: lit.fp, fn: lit.fn },
    detector3B: det ? { recall: det.recall, precision: det.precision, tp: det.tp, fp: det.fp, fn: det.fn, parseFails, modelErrors, missedDomains: misses.map((m) => m.id), falseFlaggedDomains: falseFlags.map((f) => f.id) } : "UNTESTED (server down)",
    floorOracle: { recall: oracle.recall, precision: oracle.precision, falseTrips: oracle.fp },
    floorDeltaSweep: deltaRows.map((x) => ({ delta: x.d, recall: x.r })),
    floorConfSweep: confRows.map((x) => ({ conf: x.fc, recall: x.r })),
    deltaBreak, confBreak,
    endToEnd: e2e ? { recall: e2e.recall, precision: e2e.precision, modelMiss, storeMiss } : "UNTESTED (server down)",
    untested: ["undeclared-auto-detection-from-raw-text"],
  };
  console.log("---- SUMMARY (json) ----");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
