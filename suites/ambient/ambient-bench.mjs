#!/usr/bin/env node
// AMBIENT — the unprompted-contradiction benchmark (L1: explicit value-flip).
//
// Tests the PUSH capability pull-architecture memory systems lack: as facts
// arrive over time, does the store surface — UNPROMPTED — that a new fact
// invalidated a prior belief? Fully deterministic and model-free, so the score
// is the reliability FLOOR, not a model's navigation.
//
// Mechanism under test: a standing `watch` program on a belief-bundle. A
// deterministic value-flip detector links a contradicting fact to the belief on
// admission (evidence.contradicts); the belief's effective confidence collapses;
// the watch program, run each tick, TRIPS — surfacing it with no query.
// Distractors (reinforcements / unrelated facts) are not linked, so the program
// stays quiet (precision). A pull system has no standing program to emit such an
// unqueried signal, so it scores 0 on this axis without re-querying every belief.
//
// See docs/10_SENTINEL_BENCHMARK.md for the full design and difficulty ladder.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit, addHyperedge, addDagOverlay, runProgramCell, analyzeMemory } from "./_recall.mjs";

// Flat proposal matching the current admit() schema. The old nested
// recall.write.v1 shape doesn't exist in the vendored build. contradicts
// (prior cell keys) becomes real `edges: [{relation:"contradicts",target}]`,
// admit()-validated (a dangling target is rejected, not silently dropped).
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

// admit() reports rejection via the return value, not a throw; this is the
// single write path every sub-benchmark below goes through.
function W(prop, store) {
  const result = admit(prop, { store });
  if (!result || result.accepted !== true || !result.cell) {
    throw new Error(`write not admitted: ${prop.title} -> ${JSON.stringify(result?.issues ?? result)}`);
  }
  return result.cell;
}

// A "standing program" is a prg-kind cell whose props.program carries the
// spec (schemaVersion/operation/target/params) — there is no separate
// attach-program call; admitting the cell IS attaching it. target.hyperedge
// references the bundle to watch; runProgramCell ticks it and returns
// {run:{output:{tripped,...}}}.
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
  // runProgramCell wants an ISO string for `now` (stored verbatim as run.createdAt,
  // an sqlite text column) — unlike analyzeMemory below, which wants a Date object.
  return runProgramCell(store, programKey, new Date().toISOString()).run.output;
}

// Deterministic stream generator (no RNG). Each "contradiction" stream contains
// exactly one value-flip; each "distractor" stream contains none (reinforcements
// of the same value + unrelated facts). No reinforcement is placed after a flip,
// so the stream never contradicts itself.
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

export function runSentinel(streamCount = 24, delta = 0.1) {
  const streams = makeStreams(streamCount);
  let trueContradictions = 0, detectedTrips = 0, falseTrips = 0, totalTicks = 0, beliefs = 0;
  const latencies = [];
  for (const stream of streams) {
    // Isolated store per stream: each scenario is independent, and a shared
    // producer's calibration factor must not couple unrelated streams.
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinel-"));
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
        const isContradiction = event.attr === stream.attr && event.value !== knownValue;
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

const r = runSentinel(24);
const pct = (x) => `${Math.round(x * 100)}%`;
console.log("==================== AMBIENT L1 — unprompted contradiction ====================\n");
console.log(`streams: ${r.streams} (half contain one value-flip; half are distractor-only) · true contradictions: ${r.trueContradictions}\n`);
console.log(`detection recall : ${pct(r.recall)} (${r.detectedTrips}/${r.trueContradictions} surfaced unprompted by the watch program)`);
console.log(`precision        : ${pct(r.precision)} (false trips: ${r.falseTrips} — distractors/reinforcements must not trip)`);
console.log(`median latency   : ${r.medLatency} tick(s) from contradictor arrival to surfacing\n`);
console.log("---- surfacing cost (native standing program vs pull bolt-on) ----");
console.log(`native (Recall) : ${r.nativeCost} program-runs — O(writes)`);
console.log(`pull bolt-on    : ${r.boltOnCost} re-queries — O(writes x beliefs=${r.beliefs}) = ${(r.boltOnCost / r.nativeCost).toFixed(1)}x, and only on demand`);
console.log("\nincumbents (no standing-program primitive): score 0 on the push axis by construction.");

// ============================ L3: transitive / holonomy ============================
// Pairwise-plausible, globally-impossible orderings: A>B, B>C, C>A. Each edge is
// believable alone; together they're a contradiction no pairwise check catches.
// The substrate refuses to materialize a cyclic ordering overlay (addDagOverlay
// throws), so the closing edge is rejected at write time. No pull memory system
// has a global-consistency primitive at all.
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

export function runL3(tripleCount = 24) {
  let inconsistentTotal = 0, detected = 0, falseFlags = 0, admits = 0;
  for (const triple of makeTriples(tripleCount)) {
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinel-l3-"));
    const store = new SqliteStore(join(tmp, "d.sqlite3"));
    try {
      const ent = {
        A: W(proposal("entity A", "ent", "A"), store).key,
        B: W(proposal("entity B", "ent", "B"), store).key,
        C: W(proposal("entity C", "ent", "C"), store).key
      };
      if (triple.inconsistent) inconsistentTotal += 1;
      const edges = [];
      let detectedTick = -1;
      triple.orderings.forEach(([from, to], idx) => {
        W(proposal(`${from} > ${to}`, "ord", `${from}${to}`), store);
        edges.push({ source: ent[from], target: ent[to] });
        admits += 1;
        try {
          addDagOverlay(store, { title: `ordering@${idx}`, nodeIds: [ent.A, ent.B, ent.C], edges: edges.slice(), metadata: {} });
        } catch (err) {
          // The vendored build's message is "dag overlay is cyclic: ...", not
          // "...has a cycle..." — /cycle/i doesn't match "cyclic" (diverges at
          // the 5th letter). /cycl/i covers both word forms.
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

const l3 = runL3(24);
console.log("\n==================== AMBIENT L3 — transitive (holonomy) inconsistency ====================\n");
console.log(`triples: ${l3.triples} (half A>B,B>C,C>A inconsistent; half A>B,B>C,A>C consistent) · inconsistent: ${l3.inconsistentTotal}\n`);
console.log(`detection recall : ${pct(l3.recall)} (${l3.detected}/${l3.inconsistentTotal} cyclic orderings rejected at write time)`);
console.log(`precision        : ${pct(l3.precision)} (false rejections of consistent orderings: ${l3.falseFlags})`);
console.log("latency          : caught on the closing edge — pairwise checks never see it");
console.log("\nno pull memory system materializes an ordering overlay and checks global acyclicity -> 0 on this axis by construction.");

// ============================ L2: entailed contradiction ============================
// The contradiction needs an ENTAILMENT step (amoxicillin IS a penicillin), so a
// literal detector can't see it. L2 tests COMPOSITION: a model/Checker (ceiling)
// detects the entailment; the standing program (floor) surfaces it. The KB below
// is a deterministic stand-in for the LLM/Checker; its job is to discriminate
// true entailment-contradictions from superficially-similar non-contradictions.
const PENICILLINS = new Set(["amoxicillin", "ampicillin", "penicillin"]);
const ANIMAL_PRODUCTS = new Set(["cheese", "egg", "omelette", "milk", "steak", "beef", "bacon"]);
const L2_CASES = [
  { b: { type: "allergy", allergen: "penicillin", text: "allergic to penicillin" }, f: { type: "took", drug: "amoxicillin", text: "took amoxicillin and felt fine" }, gold: true },
  { b: { type: "allergy", allergen: "penicillin", text: "allergic to penicillin" }, f: { type: "took", drug: "ibuprofen", text: "took ibuprofen and felt fine" }, gold: false },
  { b: { type: "vegan", text: "is vegan" }, f: { type: "ate", food: "omelette", text: "had a cheese omelette" }, gold: true },
  { b: { type: "vegan", text: "is vegan" }, f: { type: "ate", food: "kale", text: "had a kale salad" }, gold: false },
  { b: { type: "lives", place: "paris", text: "lives in Paris" }, f: { type: "lives", place: "lyon", text: "commutes from her home in Lyon daily" }, gold: true },
  { b: { type: "lives", place: "paris", text: "lives in Paris" }, f: { type: "visited", place: "lyon", text: "visited Lyon for the weekend" }, gold: false },
  { b: { type: "budgetMax", amount: 1000, text: "budget under $1000" }, f: { type: "spent", amount: 1500, text: "spent $1500" }, gold: true },
  { b: { type: "budgetMax", amount: 1000, text: "budget under $1000" }, f: { type: "spent", amount: 800, text: "spent $800" }, gold: false },
  { b: { type: "vegan", text: "is vegan" }, f: { type: "ate", food: "steak", text: "ordered the steak" }, gold: true },
  { b: { type: "allergy", allergen: "penicillin", text: "allergic to penicillin" }, f: { type: "took", drug: "ampicillin", text: "prescribed ampicillin, no reaction" }, gold: true },
  { b: { type: "lives", place: "berlin", text: "lives in Berlin" }, f: { type: "visited", place: "munich", text: "day trip to Munich" }, gold: false },
  { b: { type: "budgetMax", amount: 50, text: "lunch under $50" }, f: { type: "spent", amount: 42, text: "lunch was $42" }, gold: false }
];
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
function l2Score(detect) {
  let tp = 0, fp = 0, fn = 0;
  for (const c of L2_CASES) { const flagged = detect(c.b, c.f); if (flagged && c.gold) tp++; else if (flagged) fp++; else if (c.gold) fn++; }
  return { recall: tp + fn ? tp / (tp + fn) : 1, precision: tp + fp ? tp / (tp + fp) : 1 };
}
function l2Surfacing() {
  let surfaced = 0, total = 0, falseTrips = 0;
  for (const c of L2_CASES) {
    const tmp = mkdtempSync(join(os.tmpdir(), "sentinel-l2-"));
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
const litS = l2Score(l2Literal), entS = l2Score(l2Entail), surfS = l2Surfacing();
const trueN = L2_CASES.filter((c) => c.gold).length;
console.log("\n==================== AMBIENT L2 — entailed contradiction (floor + ceiling) ====================\n");
console.log(`${L2_CASES.length} cases (${trueN} true entailment-contradictions, ${L2_CASES.length - trueN} superficial distractors)\n`);
console.log("DETECTION (ceiling):");
console.log(`  literal baseline (L1-style)  : recall ${pct(litS.recall)} precision ${pct(litS.precision)}  <- cannot see entailments`);
console.log(`  entailment detector (KB/LLM) : recall ${pct(entS.recall)} precision ${pct(entS.precision)}  (amoxicillin vs ibuprofen, lives vs visited)`);
console.log(`SURFACING (floor): recall ${pct(surfS.recall)} (${surfS.total}/${trueN}), false trips ${surfS.falseTrips}`);
console.log("\nL2 needs the ceiling (literal ~0); the floor surfaces model-free once linked. KB stands in for an LLM/Checker.");

// ============================ L4: stale-by-implicit-expiry ============================
// "training for the June marathon" is stale in July — not a value-conflict, an
// expired implicit scope. Floor+ceiling: the ceiling extracts the implicit expiry
// into policy.expires_at; the floor (analyzeMemory) surfaces it as "expired" when
// now passes it, unprompted. Contrast: a naive AGE baseline misses recent-but-
// expired beliefs and false-flags timeless-but-old ones.
const L4_NOW = new Date("2023-07-15T00:00:00.000Z");
const L4_CASES = [
  { text: "training for the June marathon", createdAt: "2023-06-28", gold: true },
  { text: "is vegetarian", createdAt: "2023-05-01", gold: false },
  { text: "attending the March 2023 developer conference", createdAt: "2023-03-01", gold: true },
  { text: "lives in Paris", createdAt: "2023-01-01", gold: false },
  { text: "Q2 budget freeze in effect", createdAt: "2023-04-01", gold: true },
  { text: "subscribed to the annual plan through December 2023", createdAt: "2023-06-01", gold: false },
  { text: "rehearsing for the May recital", createdAt: "2023-05-10", gold: true },
  { text: "planning a vacation in August 2023", createdAt: "2023-07-10", gold: false }
];
const MONTH_END = { january: "01-31", february: "02-28", march: "03-31", april: "04-30", may: "05-31", june: "06-30", july: "07-31", august: "08-31", september: "09-30", october: "10-31", november: "11-30", december: "12-31" };
function extractExpiry(text) {
  const t = text.toLowerCase();
  const year = (t.match(/\b(20\d{2})\b/) || [])[1] || "2023";
  if (/\bq2\b/.test(t)) return `${year}-06-30T23:59:59.000Z`;
  if (/\bq1\b/.test(t)) return `${year}-03-31T23:59:59.000Z`;
  for (const [month, end] of Object.entries(MONTH_END)) if (t.includes(month)) return `${year}-${end}T23:59:59.000Z`;
  return null;
}
function l4Proposal(title, expiresAt) {
  return {
    kind: "obs",
    title,
    body: title,
    confidence: 0.8,
    project: "l4",
    tenant: "local",
    topics: ["belief"],
    entities: ["x"],
    expiresAt,
  };
}
function runL4() {
  const tmp = mkdtempSync(join(os.tmpdir(), "sentinel-l4-"));
  const store = new SqliteStore(join(tmp, "d.sqlite3"));
  const idToCase = new Map();
  try {
    for (const c of L4_CASES) {
      const result = admit(l4Proposal(c.text, extractExpiry(c.text)), { store, now: new Date(c.createdAt).toISOString() });
      if (!result.accepted) throw new Error(`L4 write not admitted: ${c.text} -> ${JSON.stringify(result.issues)}`);
      idToCase.set(result.cell.key, c);
    }
    const expiredIds = new Set(analyzeMemory(store, L4_NOW).stale.filter((s) => s.reason === "expired").map((s) => s.key));
    let exp = { tp: 0, fp: 0, fn: 0 }, age = { tp: 0, fp: 0, fn: 0 };
    for (const [key, c] of idToCase) {
      const sExp = expiredIds.has(key);
      const sAge = (L4_NOW.getTime() - new Date(c.createdAt).getTime()) / 86_400_000 > 30;
      for (const [d, s] of [[exp, sExp], [age, sAge]]) { if (s && c.gold) d.tp++; else if (s) d.fp++; else if (c.gold) d.fn++; }
    }
    const sc = (d) => ({ recall: d.tp + d.fn ? d.tp / (d.tp + d.fn) : 1, precision: d.tp + d.fp ? d.tp / (d.tp + d.fp) : 1 });
    return { exp: sc(exp), age: sc(age), trueN: L4_CASES.filter((c) => c.gold).length };
  } finally { store.close(); rmSync(tmp, { recursive: true, force: true }); }
}
const l4 = runL4();
console.log("\n==================== AMBIENT L4 — stale-by-implicit-expiry (floor + ceiling) ====================\n");
console.log(`${L4_CASES.length} beliefs (${l4.trueN} expired by NOW=2023-07-15, ${L4_CASES.length - l4.trueN} timeless-or-future)\n`);
console.log(`  naive age baseline (flag if old)      : recall ${pct(l4.age.recall)} precision ${pct(l4.age.precision)}  <- misses recent-expired, false-flags timeless-old`);
console.log(`  expiry-aware (ceiling extract + floor): recall ${pct(l4.exp.recall)} precision ${pct(l4.exp.precision)}  (analyzeMemory flags expires_at <= now, unprompted)`);
console.log("\npull memory systems have no staleness model -> return the stale belief on query as if current (0 on this axis).");
