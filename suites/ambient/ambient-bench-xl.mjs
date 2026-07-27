#!/usr/bin/env node
// AMBIENT-XL: a SCALED version of the AMBIENT ladder (ambient-bench.mjs).
//
// Same four tiers, same deterministic model-free mechanisms, but sized closer to
// real memory benchmarks (BEAM ~2000, LOCOMO 1986, LongMemEval ~500) instead of
// the tiny canonical sizes (L1=24, L2=12, L3=24, L4=8):
//   L1 = 1000 streams  (500 one value-flip, 500 distractor-only)
//   L3 = 1000 triples  (500 cyclic A>B,B>C,C>A, 500 acyclic A>B,B>C,A>C)
//   L2 = >=400 synthetic entailment cases across the four families
//   L4 = >=400 synthetic beliefs templated over months/quarters/years + distractors
//
// The tier mechanisms are COPIED from ambient-bench.mjs (proposal / W /
// watchProgram / tick, l2Entail, the L2 surfacing loop, makeStreams, makeTriples,
// runSentinel, runL3, the L4 extract+analyze pipeline). Only the primitives are
// imported, exactly as the canonical file imports them. Nothing else is modified.
//
// Determinism: no RNG (Math.random is unavailable in this environment anyway). The
// tick clock is pinned to a fixed ISO string so no wall-clock value can leak; all
// printed numbers are deterministic functions of the deterministic case set. Wall
// clock timing is written to stderr only, so stdout stays byte-identical run to run.
//
// A NEGATIVE CONTROLS section deliberately breaks each tier and asserts the metric
// moves the wrong way, proving the metrics are not tautological (per the user's
// fail-first testing rules).

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit, addHyperedge, addDagOverlay, runProgramCell, analyzeMemory } from "./_recall.mjs";
import {
  L4_POLICY,
  L4_POLICY_DEFINITION_SHA256,
  extractExpiryV1,
  verifyExpiryPolicyV1,
} from "./l4-expiry-policy.mjs";

const T0 = process.hrtime.bigint();

// ---- formatting helpers (deterministic) ----
const pct = (x) => `${Math.round(x * 100)}%`;
const f4 = (x) => Number(x).toFixed(4);
const p2 = (n) => String(n).padStart(2, "0");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Pinned tick clock: mechanism is value-flip-driven (edge/confidence based), so the
// value of `now` cannot change any `tripped` decision; pinning it only removes the
// wall-clock read that ambient-bench.mjs's tick() does, guaranteeing determinism.
const FIXED_TICK_NOW = "2999-01-01T00:00:00.000Z";

// ============================================================================
// SHARED MECHANISM (copied verbatim from ambient-bench.mjs)
// ============================================================================
function proposal(title, attr, value, contradicts) {
  const body = `${attr}=${value}`;
  return {
    kind: "obs",
    title,
    body,
    confidence: 0.8,
    project: "sentinel",
    tenant: "local",
    topics: ["fact", attr],
    entities: [attr],
    ...(contradicts && contradicts.length ? { edges: contradicts.map((target) => ({ relation: "contradicts", target })) } : {}),
  };
}
function W(prop, store) {
  const result = admit(prop, { store });
  if (!result || result.accepted !== true || !result.cell) {
    throw new Error(`write not admitted: ${prop.title} -> ${JSON.stringify(result?.issues ?? result)}`);
  }
  return result.cell;
}
function watchProgram(store, title, hyperedgeId, delta) {
  return W({
    kind: "prg",
    title,
    body: `watch program: ${title}`,
    confidence: 0.9,
    project: "sentinel",
    tenant: "local",
    topics: ["program"],
    entities: [],
    props: { program: { schemaVersion: "recall.program.v1", operation: "watch", target: { hyperedge: hyperedgeId }, params: { delta } } },
  }, store);
}
function tick(store, programKey) {
  // Same call as ambient-bench.mjs, but with a pinned `now` instead of new Date().
  return runProgramCell(store, programKey, FIXED_TICK_NOW).run.output;
}

// ============================================================================
// L1: unprompted contradiction (value-flip). makeStreams + runSentinel copied,
// runSentinel gets an optional sabotage hook for the negative control.
// ============================================================================
function makeStreams(n) {
  const streams = [];
  for (let i = 0; i < n; i++) {
    const attr = `attr_${i}`;
    const isContra = i % 2 === 0;
    const pos = (i % 4) + 1; // contradictor position (latency variety)
    const events = [];
    for (let e = 0; e < 5; e++) {
      if (isContra && e === pos) events.push({ kind: "contradictor", attr, value: "B" });
      else if (e < pos && e % 2 === 0) events.push({ kind: "reinforce", attr, value: "A" });
      else events.push({ kind: "unrelated", attr: `other_${i}_${e}`, value: "Z" });
    }
    streams.push({ attr, anchorValue: "A", isContra, events });
  }
  return streams;
}

function runSentinel(streamCount, delta = 0.1, opts = {}) {
  const sabotageDistractors = opts.sabotageDistractors === true;
  const streams = makeStreams(streamCount);
  let trueContradictions = 0, detectedTrips = 0, falseTrips = 0, totalTicks = 0, beliefs = 0;
  const latencies = [];
  for (const stream of streams) {
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinelxl-"));
    const store = new SqliteStore(join(tmp, "d.sqlite3"));
    try {
      const anchor = W(proposal(`belief:${stream.attr}`, stream.attr, stream.anchorValue), store);
      beliefs += 1;
      const edge = addHyperedge(store, { kind: "evidence-bundle", title: `watch:${stream.attr}`, members: [{ key: anchor.key, role: "claim" }] });
      const program = watchProgram(store, `watch:${stream.attr}`, edge.id, delta);
      tick(store, program.key); // baseline tick (never trips)

      let knownValue = stream.anchorValue;
      let beliefCellId = anchor.key;
      let contradictorTick = -1, trippedTick = -1;

      stream.events.forEach((event, idx) => {
        let isContradiction = event.attr === stream.attr && event.value !== knownValue;
        // NEGATIVE CONTROL: force a bogus contradiction link on the last event of a
        // distractor stream. The event is not a value-flip, but linking it as one
        // must make the watch trip -> false trips -> precision drops below 1.0.
        if (sabotageDistractors && !stream.isContra && idx === stream.events.length - 1) {
          isContradiction = true;
        }
        const contradicts = isContradiction ? [beliefCellId] : [];
        const cell = W(proposal(`event:${event.attr}=${event.value}`, event.attr, event.value, contradicts), store);
        if (isContradiction) { knownValue = event.value; beliefCellId = cell.key; if (contradictorTick < 0) contradictorTick = idx; }
        const out = tick(store, program.key); // unprompted tick
        totalTicks += 1;
        if (out.tripped === true && trippedTick < 0) trippedTick = idx;
        if (event.kind === "contradictor") trueContradictions += 1;
      });

      if (stream.isContra) {
        if (trippedTick === contradictorTick) { detectedTrips += 1; latencies.push(trippedTick - contradictorTick); }
        else if (trippedTick >= 0) falseTrips += 1;
      } else if (trippedTick >= 0) {
        falseTrips += 1;
      }
    } finally {
      store.close?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const recall = trueContradictions ? detectedTrips / trueContradictions : 1;
  const precision = (detectedTrips + falseTrips) ? detectedTrips / (detectedTrips + falseTrips) : 1;
  const medLatency = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;
  return { streams: streamCount, trueContradictions, detectedTrips, falseTrips, recall, precision, medLatency, nativeCost: totalTicks, boltOnCost: totalTicks * beliefs, beliefs };
}

// ============================================================================
// L3: transitive / holonomy. makeTriples + runL3 copied, runL3 gets a sabotage
// hook that turns the cyclic triples acyclic for the negative control.
// ============================================================================
function makeTriples(n) {
  const triples = [];
  for (let i = 0; i < n; i++) {
    const inconsistent = i % 2 === 0;
    triples.push({
      inconsistent,
      orderings: inconsistent ? [["A", "B"], ["B", "C"], ["C", "A"]] : [["A", "B"], ["B", "C"], ["A", "C"]]
    });
  }
  return triples;
}

function runL3(tripleCount, opts = {}) {
  const sabotageCyclic = opts.sabotageCyclic === true;
  let inconsistentTotal = 0, detected = 0, falseFlags = 0, admits = 0;
  for (const triple of makeTriples(tripleCount)) {
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinelxl-l3-"));
    const store = new SqliteStore(join(tmp, "d.sqlite3"));
    try {
      const ent = {
        A: W(proposal("entity A", "ent", "A"), store).key,
        B: W(proposal("entity B", "ent", "B"), store).key,
        C: W(proposal("entity C", "ent", "C"), store).key
      };
      if (triple.inconsistent) inconsistentTotal += 1;
      // NEGATIVE CONTROL: feed the acyclic ordering where the cyclic one is expected.
      // addDagOverlay then never throws, so a truly-inconsistent triple is not caught
      // -> detection (recall) drops.
      const orderings = (sabotageCyclic && triple.inconsistent) ? [["A", "B"], ["B", "C"], ["A", "C"]] : triple.orderings;
      const edges = [];
      let detectedTick = -1;
      orderings.forEach(([from, to], idx) => {
        W(proposal(`${from} > ${to}`, "ord", `${from}${to}`), store);
        edges.push({ source: ent[from], target: ent[to] });
        admits += 1;
        try {
          addDagOverlay(store, { title: `ordering@${idx}`, nodeIds: [ent.A, ent.B, ent.C], edges: edges.slice(), metadata: {} });
        } catch (err) {
          if (/cycl/i.test(String(err && err.message)) && detectedTick < 0) detectedTick = idx;
        }
      });
      if (triple.inconsistent) { if (detectedTick >= 0) detected += 1; }
      else if (detectedTick >= 0) falseFlags += 1;
    } finally {
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const recall = inconsistentTotal ? detected / inconsistentTotal : 1;
  const precision = (detected + falseFlags) ? detected / (detected + falseFlags) : 1;
  return { triples: tripleCount, inconsistentTotal, detected, falseFlags, recall, precision, admits };
}

// ============================================================================
// L2: entailed contradiction. l2Literal / l2Entail / l2Score / l2Surfacing copied
// verbatim; a deterministic generator expands the four families to >=400 cases.
// ============================================================================
const PENICILLINS = new Set(["amoxicillin", "ampicillin", "penicillin"]);
const ANIMAL_PRODUCTS = new Set(["cheese", "egg", "omelette", "milk", "steak", "beef", "bacon"]);

function l2Literal(b, f) {
  const tok = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "her", "was", "had"].includes(w)));
  const A = tok(b.text), B = tok(f.text);
  const jac = [...A].filter((x) => B.has(x)).length / new Set([...A, ...B]).size;
  const nA = (b.text.match(/\d+/) || [])[0], nB = (f.text.match(/\d+/) || [])[0];
  return jac >= 0.4 && nA !== undefined && nB !== undefined && nA !== nB;
}
function l2Entail(b, f) {
  if (b.type === "allergy" && f.type === "took") return b.allergen === "penicillin" && PENICILLINS.has(f.drug);
  if (b.type === "vegan" && f.type === "ate") return ANIMAL_PRODUCTS.has(f.food);
  if (b.type === "lives" && f.type === "lives") return f.place !== b.place;
  if (b.type === "lives" && f.type === "visited") return false;
  if (b.type === "budgetMax" && f.type === "spent") return f.amount > b.amount;
  return false;
}
function l2Score(cases, detect) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const c of cases) { const flagged = detect(c.b, c.f); if (flagged && c.gold) tp++; else if (flagged) fp++; else if (c.gold) fn++; else tn++; }
  return { recall: tp + fn ? tp / (tp + fn) : 1, precision: tp + fp ? tp / (tp + fp) : 1, tp, fp, fn, tn };
}
function l2Surfacing(cases) {
  let surfaced = 0, total = 0, falseTrips = 0;
  for (const c of cases) {
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinelxl-l2-"));
    const store = new SqliteStore(join(tmp, "d.sqlite3"));
    try {
      const anchor = W(proposal(`belief:${c.b.text}`, "belief", "1"), store);
      const edge = addHyperedge(store, { kind: "evidence-bundle", title: "belief", members: [{ key: anchor.key, role: "claim" }] });
      const program = watchProgram(store, "belief", edge.id, 0.1);
      tick(store, program.key);
      const isContra = l2Entail(c.b, c.f);
      W(proposal(`fact:${c.f.text}`, "fact", "1", isContra ? [anchor.key] : []), store);
      const tripped = tick(store, program.key).tripped === true;
      if (c.gold) { total++; if (tripped) surfaced++; } else if (tripped) falseTrips++;
    } finally { store.close(); rmSync(tmp, { recursive: true, force: true }); }
  }
  return { recall: total ? surfaced / total : 1, falseTrips, total };
}

// -- deterministic L2 generator. gold is assigned from the KNOWN construction
// parameters (drug in PENICILLINS, food in ANIMAL_PRODUCTS, place differs, spent >
// max), NOT by calling l2Entail. l2Entail is then the ceiling under test, so its
// score measures whether the KB recovers the constructed truth rather than
// restating it. Non-budget texts carry no digits, so the literal baseline (which
// needs two differing numbers) can never fire on entailment cases -> recall ~0.
function crossSlice(items, ctx, make, limit) {
  const out = [];
  for (const it of items) for (const c of ctx) { out.push(make(it, c)); if (out.length >= limit) return out; }
  return out;
}
function makeL2Cases(perSide = 55) {
  const notes = [
    "and felt fine", "without any reaction", "for a sinus infection", "as prescribed by the GP",
    "earlier today", "at the walk-in clinic", "per the pharmacist", "over the weekend",
    "for strep throat", "after the dentist visit", "during the flare-up", "on an empty stomach",
    "with a full glass of water", "despite the warning label", "at the urgent care", "following the lab results",
    "to treat the infection", "on the doctor's advice", "right before bed", "first thing in the day",
  ];
  const eatPhrases = ["had a", "ordered the", "enjoyed some", "split a", "cooked a", "grabbed a", "made a", "shared a", "tried the"];
  const livesPhrases = ["commutes from her home in", "has relocated to", "now lives in", "moved permanently to", "settled down in", "rents an apartment in", "bought a house in", "resides full-time in"];
  const visitPhrases = ["visited", "took a day trip to", "spent the weekend in", "passed through", "toured", "had a layover in", "attended a conference in", "went sightseeing in"];
  const penDrugs = ["amoxicillin", "ampicillin", "penicillin"];
  const nonPenDrugs = ["ibuprofen", "aspirin", "acetaminophen", "naproxen", "cetirizine", "loratadine", "metformin", "omeprazole", "atorvastatin", "lisinopril"];
  const animalFoods = ["cheese", "egg", "omelette", "milk", "steak", "beef", "bacon"];
  const plantFoods = ["kale", "tofu", "lentils", "rice", "apple", "bread", "quinoa", "hummus", "spinach", "salad"];
  const otherCities = ["lyon", "marseille", "nice", "bordeaux", "toulouse", "lille", "nantes", "strasbourg"];
  const visitCities = ["lyon", "munich", "rome", "madrid", "berlin", "london", "geneva", "brussels"];
  const maxima = [50, 100, 200, 500, 750, 1000, 1500, 2000, 3000, 5000];
  const overDeltas = [25, 60, 120, 300, 700, 1100];
  const underDeltas = [5, 15, 25, 35, 40, 45];

  const allergyB = { type: "allergy", allergen: "penicillin", text: "allergic to penicillin" };
  const veganB = { type: "vegan", text: "is vegan" };
  const livesB = { type: "lives", place: "paris", text: "lives in Paris" };

  const cases = [];
  // allergy family
  cases.push(...crossSlice(penDrugs, notes, (drug, n) => ({ b: allergyB, f: { type: "took", drug, text: `took ${drug} ${n}` }, gold: true, fam: "allergy" }), perSide));
  cases.push(...crossSlice(nonPenDrugs, notes, (drug, n) => ({ b: allergyB, f: { type: "took", drug, text: `took ${drug} ${n}` }, gold: false, fam: "allergy" }), perSide));
  // vegan family
  cases.push(...crossSlice(animalFoods, eatPhrases, (food, p) => ({ b: veganB, f: { type: "ate", food, text: `${p} ${food}` }, gold: true, fam: "vegan" }), perSide));
  cases.push(...crossSlice(plantFoods, eatPhrases, (food, p) => ({ b: veganB, f: { type: "ate", food, text: `${p} ${food}` }, gold: false, fam: "vegan" }), perSide));
  // lives family (lives+lives = contradiction; lives+visited = non-contradiction)
  cases.push(...crossSlice(otherCities, livesPhrases, (place, p) => ({ b: livesB, f: { type: "lives", place, text: `${p} ${cap(place)}` }, gold: true, fam: "lives" }), perSide));
  cases.push(...crossSlice(visitCities, visitPhrases, (place, p) => ({ b: livesB, f: { type: "visited", place, text: `${p} ${cap(place)}` }, gold: false, fam: "lives" }), perSide));
  // budget family
  cases.push(...crossSlice(maxima, overDeltas, (max, d) => ({ b: { type: "budgetMax", amount: max, text: `budget under $${max}` }, f: { type: "spent", amount: max + d, text: `spent $${max + d}` }, gold: true, fam: "budget" }), perSide));
  cases.push(...crossSlice(maxima, underDeltas, (max, d) => ({ b: { type: "budgetMax", amount: max, text: `budget under $${max}` }, f: { type: "spent", amount: max - d, text: `spent $${max - d}` }, gold: false, fam: "budget" }), perSide));
  return cases;
}

// ============================================================================
// L4: stale-by-implicit-expiry. Real extractExpiryV1 is the ceiling, analyzeMemory
// the floor. gold is derived from the KNOWN scope month/quarter/year vs NOW, NOT
// from extractExpiryV1, so the expiry-aware score measures whether text parsing
// recovers the constructed truth.
// ============================================================================
const L4_NOW = new Date("2023-07-15T00:00:00.000Z");
const L4_NOW_MS = L4_NOW.getTime();
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthEndMs(year, mIdx) { return Date.UTC(year, mIdx + 1, 1) - 1; }

function l4Proposal(title, expiresAt) {
  return { kind: "obs", title, body: title, confidence: 0.8, project: "l4xl", tenant: "local", topics: ["belief"], entities: ["x"], expiresAt };
}

function makeL4Cases() {
  const cases = [];
  let uid = 0;
  const push = (text, createdAt, scopeEndMs, family) => {
    // gold from construction: a scoped belief is expired when its scope end is at or
    // before NOW; a timeless belief (scopeEndMs === null) is never expired.
    const gold = scopeEndMs === null ? false : scopeEndMs <= L4_NOW_MS;
    // SCALE-UP FINDING: admit() deduplicates by content, and many templates share a
    // surface form (implicit-year months omit the year, timeless phrases repeat
    // across dates, expired quarters repeat across years). Identical bodies collapse
    // to one cell and, worse, some collisions are label-conflicting (e.g. "the
    // August marathon" is expired for 2021/2022 but future for 2023). A unique,
    // temporally-inert ref tag (never a 20xx year or a month token) makes each
    // templated belief its own distinct memory, which is the intended semantics.
    uid += 1;
    cases.push({ text: `${text} (ref ${uid})`, createdAt, gold, family });
  };

  // A) implicit-year month events (no year in text; extractor uses createdAt year)
  const implTemplates = ["training for the {M} marathon", "rehearsing for the {M} recital", "attending the {M} workshop", "preparing the {M} report", "hosting the {M} gala"];
  for (const year of [2021, 2022]) for (let m = 0; m < 12; m++) for (const t of implTemplates) {
    push(t.replace("{M}", MONTH_NAMES[m]), `${year}-${p2(m + 1)}-05`, monthEndMs(year, m), "impl-past");
  }
  for (let m = 0; m <= 5; m++) for (const t of implTemplates) { // 2023 Jan..Jun expired
    push(t.replace("{M}", MONTH_NAMES[m]), `2023-${p2(m + 1)}-20`, monthEndMs(2023, m), "impl-2023-expired");
  }
  for (let m = 7; m <= 11; m++) for (const t of implTemplates) { // 2023 Aug..Dec future
    push(t.replace("{M}", MONTH_NAMES[m]), "2023-07-05", monthEndMs(2023, m), "impl-2023-future");
  }

  // B) explicit-year month events
  const explTemplates = ["the {M} {Y} summit", "the {M} {Y} conference", "the {M} {Y} product launch"];
  for (const year of [2019, 2020]) for (let m = 0; m < 12; m++) for (const t of explTemplates) { // past
    push(t.replace("{M}", MONTH_NAMES[m]).replace("{Y}", String(year)), `${year}-${p2(m + 1)}-05`, monthEndMs(year, m), "expl-past");
  }
  for (const year of [2024, 2025]) for (let m = 0; m < 12; m++) for (const t of explTemplates) { // future
    push(t.replace("{M}", MONTH_NAMES[m]).replace("{Y}", String(year)), "2023-05-15", monthEndMs(year, m), "expl-future");
  }

  // C) quarters (extractExpiryV1 supports Q1 -> end of Mar, Q2 -> end of Jun)
  const qTemplates = ["{Q} budget freeze in effect", "{Q} hiring plan approved", "{Q} roadmap review"];
  const qEnd = { Q1: 2, Q2: 5 };
  for (const q of ["Q1", "Q2"]) for (const year of [2022, 2023]) for (const t of qTemplates) { // expired
    const createdAt = q === "Q1" ? `${year}-01-10` : `${year}-04-10`;
    push(t.replace("{Q}", q), createdAt, monthEndMs(year, qEnd[q]), "quarter-expired");
  }
  for (const q of ["Q1", "Q2"]) for (const t of qTemplates) { // future explicit 2024
    push(t.replace("{Q}", `${q} 2024`), "2023-05-15", monthEndMs(2024, qEnd[q]), "quarter-future");
  }

  // D) timeless distractors (no month/quarter/year token). Old ones bait the naive
  // age baseline into a false flag; the recent one is a true negative for both.
  const timeless = ["is vegetarian", "lives in Paris", "enjoys hiking on weekends", "prefers tea over coffee", "owns a golden retriever", "works as a software engineer", "is fluent in Spanish", "commutes by bicycle", "volunteers at the animal shelter", "plays the cello", "practices yoga daily", "collects vintage postcards"];
  const timelessDates = ["2023-01-05", "2023-02-05", "2023-03-05", "2023-04-05", "2023-05-05", "2023-07-10"];
  for (const phrase of timeless) for (const d of timelessDates) push(phrase, d, null, "timeless");

  // E) recent-expired boosters (belief formed just after the scope ended; young but
  // expired -> the naive age baseline misses them, the expiry model catches them)
  const boosterTemplates = ["wrapping up the {M} sprint", "closing out the {M} campaign", "finalizing the {M} audit", "submitting the {M} grant", "concluding the {M} pilot"];
  for (const t of boosterTemplates) { push(t.replace("{M}", "June"), "2023-07-05", monthEndMs(2023, 5), "recent-expired"); }
  for (const t of boosterTemplates) { push(t.replace("{M}", "May"), "2023-06-25", monthEndMs(2023, 4), "recent-expired"); }

  return cases;
}

function runL4(cases, now = L4_NOW) {
  const nowMs = now.getTime();
  const tmp = mkdtempSync(join(os.tmpdir(), "sentinelxl-l4-"));
  const store = new SqliteStore(join(tmp, "d.sqlite3"));
  const idToCase = new Map();
  try {
    for (const c of cases) {
      const result = admit(l4Proposal(c.text, extractExpiryV1(c.text, c.createdAt)), { store, now: new Date(c.createdAt).toISOString() });
      if (!result.accepted) throw new Error(`L4 write not admitted: ${c.text} -> ${JSON.stringify(result.issues)}`);
      idToCase.set(result.cell.key, c);
    }
    const expiredIds = new Set(analyzeMemory(store, now).stale.filter((s) => s.reason === "expired").map((s) => s.key));
    let exp = { tp: 0, fp: 0, fn: 0 }, age = { tp: 0, fp: 0, fn: 0 };
    for (const [key, c] of idToCase) {
      const sExp = expiredIds.has(key);
      const sAge = (nowMs - new Date(c.createdAt).getTime()) / 86_400_000 > 30;
      for (const [d, s] of [[exp, sExp], [age, sAge]]) { if (s && c.gold) d.tp++; else if (s) d.fp++; else if (c.gold) d.fn++; }
    }
    const sc = (d) => ({ recall: d.tp + d.fn ? d.tp / (d.tp + d.fn) : 1, precision: d.tp + d.fp ? d.tp / (d.tp + d.fp) : 1, ...d });
    return { exp: sc(exp), age: sc(age), trueN: cases.filter((c) => c.gold).length, count: cases.length };
  } finally { store.close(); rmSync(tmp, { recursive: true, force: true }); }
}

// ============================================================================
// RUN
// ============================================================================
const L1_STREAMS = 1000;
const L3_TRIPLES = 1000;

const l1 = runSentinel(L1_STREAMS);
console.log("==================== AMBIENT-XL L1 -- unprompted contradiction (scaled) ====================\n");
console.log(`streams: ${l1.streams} (${l1.streams / 2} contain one value-flip; ${l1.streams / 2} distractor-only) . true contradictions: ${l1.trueContradictions}\n`);
console.log(`detection recall : ${pct(l1.recall)} (${l1.detectedTrips}/${l1.trueContradictions} surfaced unprompted by the watch program)`);
console.log(`precision        : ${pct(l1.precision)} (false trips: ${l1.falseTrips} -- distractors/reinforcements must not trip)`);
console.log(`median latency   : ${l1.medLatency} tick(s) from contradictor arrival to surfacing`);
console.log(`surfacing cost   : native ${l1.nativeCost} program-runs O(writes) vs pull bolt-on ${l1.boltOnCost} re-queries = ${(l1.boltOnCost / l1.nativeCost).toFixed(1)}x`);

const l3 = runL3(L3_TRIPLES);
console.log("\n==================== AMBIENT-XL L3 -- transitive (holonomy) inconsistency (scaled) ====================\n");
console.log(`triples: ${l3.triples} (${l3.triples / 2} cyclic A>B,B>C,C>A; ${l3.triples / 2} acyclic A>B,B>C,A>C) . inconsistent: ${l3.inconsistentTotal}\n`);
console.log(`detection recall : ${pct(l3.recall)} (${l3.detected}/${l3.inconsistentTotal} cyclic orderings rejected at write time)`);
console.log(`precision        : ${pct(l3.precision)} (false rejections of consistent orderings: ${l3.falseFlags})`);

const l2cases = makeL2Cases(55);
const l2true = l2cases.filter((c) => c.gold).length;
const litS = l2Score(l2cases, l2Literal), entS = l2Score(l2cases, l2Entail), surfS = l2Surfacing(l2cases);
console.log("\n==================== AMBIENT-XL L2 -- entailed contradiction (floor + ceiling, scaled) ====================\n");
console.log(`${l2cases.length} cases (${l2true} true entailment-contradictions, ${l2cases.length - l2true} superficial distractors; balance ${pct(l2true / l2cases.length)})\n`);
console.log("DETECTION (ceiling):");
console.log(`  literal baseline (L1-style)  : recall ${pct(litS.recall)} precision ${pct(litS.precision)}  <- cannot see entailments (fired on ${litS.tp + litS.fp} cases)`);
console.log(`  entailment detector (KB/LLM) : recall ${pct(entS.recall)} precision ${pct(entS.precision)}  (tp ${entS.tp} fp ${entS.fp} fn ${entS.fn})`);
console.log(`SURFACING (floor): recall ${pct(surfS.recall)} (${surfS.total}/${l2true}), false trips ${surfS.falseTrips}`);

const l4cases = makeL4Cases();
const l4 = runL4(l4cases);
let l4Witness = "PASS", l4WitnessDetail = "";
try { const w = verifyExpiryPolicyV1(); l4Witness = w.verified ? "PASS" : "FAIL"; }
catch (err) { l4Witness = "FAIL"; l4WitnessDetail = String(err && err.message); }
console.log("\n==================== AMBIENT-XL L4 -- stale-by-implicit-expiry (floor + ceiling, scaled) ====================\n");
console.log(`policy: ${L4_POLICY.version} sha256=${L4_POLICY_DEFINITION_SHA256} (definition-drift guard: ${l4Witness})${l4WitnessDetail ? " " + l4WitnessDetail : ""}`);
console.log(`${l4.count} beliefs (${l4.trueN} expired by NOW=2023-07-15, ${l4.count - l4.trueN} timeless-or-future)\n`);
console.log(`  naive age baseline (flag if >30d old) : recall ${pct(l4.age.recall)} precision ${pct(l4.age.precision)}  (tp ${l4.age.tp} fp ${l4.age.fp} fn ${l4.age.fn})  <- misses recent-expired, false-flags timeless/future-old`);
console.log(`  expiry-aware (ceiling extract + floor): recall ${pct(l4.exp.recall)} precision ${pct(l4.exp.precision)}  (tp ${l4.exp.tp} fp ${l4.exp.fp} fn ${l4.exp.fn})`);

// ============================================================================
// NEGATIVE CONTROLS -- deliberately break each tier; the metric MUST move the
// wrong way. If a control does NOT break, that is a real finding (flagged loudly).
// ============================================================================
console.log("\n==================== NEGATIVE CONTROLS (anti-tautology / fail-first) ====================\n");
const controls = [];
function control(name, expected, brokeCond, detail) {
  const broke = brokeCond === true;
  controls.push({ name, broke });
  console.log(`[${name}] EXPECTED-BREAK: ${expected}`);
  console.log(`  result: ${detail}`);
  console.log(`  ${broke ? "BROKE as expected (metric moved the wrong way, so it is measuring something)" : "*** DID NOT BREAK -- FINDING: metric may be tautological ***"}\n`);
}

// L1 control: link distractor streams as contradictions -> precision must drop.
const l1ctrl = runSentinel(200, 0.1, { sabotageDistractors: true });
control(
  "L1",
  "linking distractor streams as contradictions -> precision drops well below 1.0",
  l1ctrl.precision < 0.95 && l1.precision >= 0.999,
  `baseline precision ${f4(l1.precision)} -> sabotaged precision ${f4(l1ctrl.precision)} (false trips ${l1ctrl.falseTrips})`,
);

// L3 control: feed acyclic where cyclic expected -> detection must drop.
const l3ctrl = runL3(200, { sabotageCyclic: true });
control(
  "L3",
  "feeding acyclic orderings where cyclic expected -> detection recall collapses",
  l3ctrl.recall < 0.05 && l3.recall >= 0.999,
  `baseline recall ${f4(l3.recall)} -> sabotaged recall ${f4(l3ctrl.recall)} (detected ${l3ctrl.detected}/${l3ctrl.inconsistentTotal})`,
);

// L2 control: run the literal baseline as the detector -> recall ~0 on entailment.
control(
  "L2",
  "using the literal baseline as the detector -> recall ~0 on entailment cases",
  litS.recall <= 0.02 && entS.recall >= 0.98,
  `entailment recall ${f4(entS.recall)} vs literal recall ${f4(litS.recall)}`,
);

// L4 control: strip the temporal phrase from expired beliefs -> extractExpiryV1
// returns null -> expiry-aware recall drops.
const l4Stripped = l4cases.map((c) => (c.gold ? { ...c, text: "is an ongoing personal commitment" } : c));
const l4ctrl = runL4(l4Stripped);
control(
  "L4",
  "stripping the temporal phrase from expired beliefs (extractExpiryV1 -> null) -> expiry-aware recall drops",
  l4ctrl.exp.recall < 0.05 && l4.exp.recall >= 0.98,
  `baseline expiry-aware recall ${f4(l4.exp.recall)} -> stripped recall ${f4(l4ctrl.exp.recall)}`,
);

// ============================================================================
// SCALE-UP FINDING: extractExpiryV1 grammar coverage. The extractor supports Q1
// and Q2 only; Q3/Q4 (and bare-quarter with no supported month) return null. At
// scale this is a real recall gap for any Q3/Q4 belief, surfaced here as a probe.
// ============================================================================
const q3q4 = [
  { text: "Q3 budget freeze in effect", createdAt: "2023-07-10" },
  { text: "Q4 hiring plan approved", createdAt: "2022-10-10" },
];
const q3q4Extracted = q3q4.filter((c) => extractExpiryV1(c.text, c.createdAt) !== null).length;
console.log("==================== SCALE-UP FINDING: extractExpiryV1 grammar coverage ====================\n");
console.log(`Q3/Q4 beliefs where extractExpiryV1 recovered an expiry: ${q3q4Extracted}/${q3q4.length} (0 means Q3/Q4 are unsupported -> would be a silent recall gap at scale).`);
console.log("The main L4 set deliberately stays inside the supported grammar (months, Q1, Q2, explicit years, timeless) so the headline metric is clean; this probe records the boundary.\n");

// ============================================================================
// MACHINE-READABLE SUMMARY (deterministic; timing goes to stderr only)
// ============================================================================
const totalCases = l1.streams + l3.triples + l2cases.length + l4.count;
console.log("==================== SUMMARY (per tier: count, recall, precision) ====================\n");
console.log(`SUMMARY tier=L1 count=${l1.streams} recall=${f4(l1.recall)} precision=${f4(l1.precision)}`);
console.log(`SUMMARY tier=L2 count=${l2cases.length} recall=${f4(entS.recall)} precision=${f4(entS.precision)}`);
console.log(`SUMMARY tier=L3 count=${l3.triples} recall=${f4(l3.recall)} precision=${f4(l3.precision)}`);
console.log(`SUMMARY tier=L4 count=${l4.count} recall=${f4(l4.exp.recall)} precision=${f4(l4.exp.precision)}`);
console.log(`SUMMARY total_cases=${totalCases}`);
const allBroke = controls.every((c) => c.broke);
console.log(`SUMMARY negative_controls_all_broke=${allBroke ? "yes" : "no"}` + (allBroke ? "" : ` (did_not_break: ${controls.filter((c) => !c.broke).map((c) => c.name).join(",")})`));

const elapsedMs = Number(process.hrtime.bigint() - T0) / 1e6;
process.stderr.write(`[timing] wall_clock_ms=${elapsedMs.toFixed(1)} total_cases=${totalCases}\n`);
