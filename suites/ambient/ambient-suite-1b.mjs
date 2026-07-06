#!/usr/bin/env node
// AMBIENT model-driven suite: hold the model FIXED and weak (Llama-3.2-1B) so the
// score is attributable to the MEMORY SYSTEM, not model capability. For each
// reader-facing area the same 1b model answers a memory task WITH the context the
// substrate actually serves (store.search output, including its supersession and
// contradiction behavior) vs WITHOUT. The substrate's value is the delta.
//
// Run: llama-server -hf unsloth/Llama-3.2-1B-Instruct-GGUF:Q4_K_M --port 8089 -ngl 99 --no-webui
//      node scripts/sentinel-suite-1b.mjs
import { fresh, done, reopen, W } from "./probes/_lib.mjs";
import { analyzeMemory } from "../dist/src/index.js";

const URL = "http://localhost:8089/v1/chat/completions";
async function ask(prompt, max = 40) {
  const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: max, stream: false }) });
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || "").trim();
}
const has = (ans, tok) => ans.toLowerCase().replace(/\s+/g, "").includes(tok.toLowerCase().replace(/\s+/g, ""));
// what the memory system surfaces for a query (its real read path)
const served = (store, q, k = 6) => store.search(q, k).map((n) => `- ${n.title} (${n.body})`).join("\n");

// 1 RECALL/ATTRIBUTION: planted unguessable facts
async function recall(n = 10) {
  const s = fresh(); let w = 0, wo = 0;
  try {
    const facts = [];
    for (let i = 0; i < n; i++) { const code = `QX-${(i * 7919 + 13) % 10000}-${String.fromCharCode(65 + i % 26)}`; W(s.store, { title: `vault ${i} access code is ${code}`, body: code, topics: ["vault"], subject: [`v${i}`] }); facts.push({ i, code }); }
    const r = reopen(s);
    for (const f of facts) {
      const q = `What is the access code for vault ${f.i}? Reply with only the code.`;
      if (has(await ask(`Context:\n${served(r, `vault ${f.i} access code`)}\n\n${q}`), f.code)) w++;
      if (has(await ask(q), f.code)) wo++;
    }
    return { area: "RECALL (attribution)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 10 SUPERSESSION: current value. served = what the store gives (stale+current, the
// bug). ideal = head only. The served-vs-ideal gap is the reader-facing cost.
async function supersession(n = 8) {
  const s = fresh(); let served_ok = 0, ideal_ok = 0, wo = 0;
  try {
    const items = [];
    for (let i = 0; i < n; i++) {
      const oldv = `ep-old-${i}`, newv = `ep-new-${i}`;
      const v1 = W(s.store, { title: `the current endpoint for service ${i} is ${oldv}`, body: oldv, subject: [`svc${i}`], topics: ["ep"] });
      W(s.store, { title: `the current endpoint for service ${i} is ${newv}`, body: newv, operation: "supersede", contradicts: [v1.id], subject: [`svc${i}`], topics: ["ep"] });
      items.push({ i, oldv, newv });
    }
    const r = reopen(s);
    for (const it of items) {
      const q = `What is the CURRENT endpoint for service ${it.i}? Reply with only the value.`;
      const a1 = await ask(`Context:\n${served(r, `current endpoint for service ${it.i}`)}\n\n${q}`);
      if (has(a1, it.newv) && !has(a1, it.oldv)) served_ok++;
      const a2 = await ask(`Context:\n- the current endpoint for service ${it.i} is ${it.newv} (${it.newv})\n\n${q}`);
      if (has(a2, it.newv) && !has(a2, it.oldv)) ideal_ok++;
      if (has(await ask(q), it.newv)) wo++;
    }
    return { area: "SUPERSESSION (current value)", w: served_ok / n, wo: wo / n, extra: `ideal head-only ${Math.round(ideal_ok / n * 100)}% vs store-served ${Math.round(served_ok / n * 100)}% = resurrection gap cost` };
  } finally { done(s); }
}

// 5 CONTRADICTION surfacing: does the served context let the model see the conflict
async function contradiction(n = 6) {
  const s = fresh(); let w = 0, wo = 0;
  const pairs = [["up", "down"], ["enabled", "disabled"], ["online", "offline"], ["healthy", "broken"], ["valid", "invalid"], ["passing", "failing"]];
  try {
    for (let i = 0; i < n; i++) {
      const [a, b] = pairs[i];
      W(s.store, { title: `service ${i} is ${a}`, body: a, subject: [`s${i}`], topics: ["c"] });
      W(s.store, { title: `service ${i} is ${b}`, body: b, subject: [`s${i}`], topics: ["c"] });
    }
    const r = reopen(s);
    // the memory system's own detected conflicts (contradicts edges flagged at write)
    const flagged = analyzeMemory(r).contradictions.length;
    let rawOnly = 0;
    for (let i = 0; i < n; i++) {
      const [a, b] = pairs[i];
      const q = `Is the recorded state of service ${i} consistent or conflicting? Name every state mentioned.`;
      const ctx = served(r, `service ${i} state`);
      // faithful read: the system DID detect the conflict, so surface that flag
      const flag = flagged > 0 ? "\n[memory system flag: these records are recorded as conflicting]" : "";
      const ans = await ask(`Context:\n${ctx}${flag}\n\n${q}`, 60);
      if (has(ans, a) && has(ans, b)) w++;
      const rawAns = await ask(`Context:\n${ctx}\n\n${q}`, 60);
      if (has(rawAns, a) && has(rawAns, b)) rawOnly++;
      const ans2 = await ask(q, 60);
      if (has(ans2, a) && has(ans2, b)) wo++;
    }
    return { area: "CONTRADICTION (surfacing)", w: w / n, wo: wo / n, extra: `raw-search-only ${Math.round(rawOnly / n * 100)}% vs with-system-flag ${Math.round(w / n * 100)}% (detector flagged ${flagged})` };
  } finally { done(s); }
}

// 13 RETRIEVAL: exact item from a distractor swamp via the store
async function retrieval(n = 8, decoys = 10) {
  const s = fresh(); let w = 0, wo = 0;
  try {
    const tgt = [];
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < decoys; d++) W(s.store, { title: `release ${i} note ${d} general info`, body: `misc-${d}`, topics: ["rel"] });
      const fp = `FP-${(i * 911) % 10000}`;
      W(s.store, { title: `release ${i} signing fingerprint is ${fp}`, body: fp, topics: ["rel"] });
      tgt.push({ i, fp });
    }
    const r = reopen(s);
    for (const t of tgt) {
      const q = `What is the signing fingerprint for release ${t.i}? Reply with only the fingerprint.`;
      if (has(await ask(`Context:\n${served(r, `release ${t.i} signing fingerprint`)}\n\n${q}`), t.fp)) w++;
      if (has(await ask(q), t.fp)) wo++;
    }
    return { area: "RETRIEVAL (distractor)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 11 TEMPORALITY as-of: answer about a past state using the served temporal cells
async function temporality(n = 6) {
  const s = fresh(); let w = 0, wo = 0;
  try {
    const items = [];
    for (let i = 0; i < n; i++) {
      W(s.store, { title: `in 2022 the billing mode for account ${i} was prepaid`, body: "prepaid", createdAt: "2022-01-01", subject: [`acct${i}`], topics: ["t"] });
      W(s.store, { title: `in 2025 the billing mode for account ${i} became postpaid`, body: "postpaid", createdAt: "2025-01-01", subject: [`acct${i}`], topics: ["t"] });
      items.push({ i, asof2023: "prepaid", asof2026: "postpaid" });
    }
    const r = reopen(s);
    for (const it of items) {
      const q = `As of the year 2023, what was the billing mode for account ${it.i}? Reply with one word.`;
      if (has(await ask(`Context:\n${served(r, `billing mode for account ${it.i}`)}\n\n${q}`), it.asof2023)) w++;
      if (has(await ask(q), it.asof2023)) wo++;
    }
    return { area: "TEMPORALITY (as-of)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 17 MODALITY: not misled by a hypothetical when asked what ACTUALLY happened
async function modality(n = 6) {
  const s = fresh(); let w = 0, wo = 0;
  const actuals = ["mysql", "redis", "kafka", "sqlite", "mongo", "nginx"];
  const hypos = ["postgres", "memcached", "rabbitmq", "duckdb", "couch", "envoy"];
  try {
    for (let i = 0; i < n; i++) {
      W(s.store, { title: `if we migrate service ${i} to ${hypos[i]} then latency would drop`, body: `hypothetical ${hypos[i]}`, subject: [`m${i}`], topics: ["m"] });
      W(s.store, { title: `we actually migrated service ${i} to ${actuals[i]}`, body: `actual ${actuals[i]}`, subject: [`m${i}`], topics: ["m"] });
    }
    const r = reopen(s);
    for (let i = 0; i < n; i++) {
      const q = `Which system did we ACTUALLY migrate service ${i} to? Reply with one word.`;
      const a1 = await ask(`Context:\n${served(r, `migrate service ${i}`)}\n\n${q}`);
      if (has(a1, actuals[i]) && !has(a1, hypos[i])) w++;
      const a2 = await ask(q);
      if (has(a2, actuals[i]) && !has(a2, hypos[i])) wo++;
    }
    return { area: "MODALITY (actual vs hypothetical)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 0 ADOPTION: a "remember this" only helps the reader if routed to the GOVERNED
// store. governed arm = fact in the store (recallable); ungoverned arm = fact left
// in a side store the reader cannot see.
async function adoption(n = 10) {
  const s = fresh(); let gov = 0, ungov = 0;
  try {
    const facts = [];
    for (let i = 0; i < n; i++) { const v = `ZK-${(i * 5281) % 10000}`; W(s.store, { title: `the badge id for employee ${i} is ${v}`, body: v, subject: [`emp${i}`], topics: ["adopt"] }); facts.push({ i, v }); }
    const r = reopen(s);
    for (const f of facts) {
      const q = `What is the badge id for employee ${f.i}? Reply with only the id.`;
      if (has(await ask(`Context:\n${served(r, `badge id for employee ${f.i}`)}\n\n${q}`), f.v)) gov++;
      if (has(await ask(`Context:\n(no governed memory available)\n\n${q}`), f.v)) ungov++;
    }
    return { area: "ADOPTION (governed routing)", w: gov / n, wo: ungov / n };
  } finally { done(s); }
}

// 2 ANTERIORITY: which fact predates the other, from the recorded order the
// substrate surfaces (createdAt).
async function anteriority(n = 8) {
  const s = fresh(); let w = 0, wo = 0;
  try {
    const items = [];
    for (let i = 0; i < n; i++) {
      // non-ordered token names + randomized order, so the label does not leak which
      // came first; the model MUST use the recorded dates the substrate surfaces.
      const A = `VKR-${(i * 131) % 1000}`, B = `VKR-${(i * 977 + 7) % 1000}`;
      const aFirst = i % 2 === 0;
      W(s.store, { title: `record ${i} value set to ${aFirst ? A : B}`, body: aFirst ? A : B, createdAt: `${2015 + (i % 5)}-01-01`, subject: [`r${i}`], topics: ["ant"] });
      W(s.store, { title: `record ${i} value set to ${aFirst ? B : A}`, body: aFirst ? B : A, createdAt: `${2022 + (i % 4)}-01-01`, subject: [`r${i}`], topics: ["ant"] });
      items.push({ i, A, B, first: aFirst ? A : B });
    }
    const r = reopen(s);
    for (const it of items) {
      const ctx = r.search(`record ${it.i} value`, 6).map((nn) => `- ${nn.title} [recorded ${String(nn.createdAt).slice(0, 10)}]`).join("\n");
      const q = `Which value was recorded EARLIER for record ${it.i}, ${it.A} or ${it.B}? Reply with only one.`;
      if (has(await ask(`Context:\n${ctx}\n\n${q}`), it.first)) w++;
      if (has(await ask(q), it.first)) wo++;
    }
    return { area: "ANTERIORITY (which first)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 3 AUTHORITY: which source recorded a fact, from the provenance the read carries.
async function authority(n = 8) {
  const s = fresh(); let w = 0, wo = 0;
  const sources = ["SENSOR-NORTH", "SENSOR-EAST", "AUDIT-LOG", "FIELD-TEAM", "API-FEED", "MANUAL-ENTRY", "SCANNER-7", "RELAY-9"];
  try {
    for (let i = 0; i < n; i++) W(s.store, { title: `per ${sources[i]}, the reading for site ${i} is nominal`, body: sources[i], subject: [`site${i}`], topics: ["auth"] });
    const r = reopen(s);
    for (let i = 0; i < n; i++) {
      const q = `Which source reported the reading for site ${i}? Reply with only the source name.`;
      if (has(await ask(`Context:\n${served(r, `reading for site ${i}`)}\n\n${q}`), sources[i])) w++;
      if (has(await ask(q), sources[i])) wo++;
    }
    return { area: "AUTHORITY (source of claim)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 12 DEEP-CONTRADICTION (entailment): the MODEL does the world-knowledge entailment
// a lexical detector cannot (amoxicillin IS a penicillin).
async function deepContra() {
  const cases = [
    { b: "the patient is allergic to penicillin", f: "the patient was given amoxicillin and recovered", gold: true },
    { b: "the patient is allergic to penicillin", f: "the patient was given ibuprofen and recovered", gold: false },
    { b: "the customer is strictly vegan", f: "the customer ordered the cheese omelette", gold: true },
    { b: "the customer is strictly vegan", f: "the customer ordered the kale salad", gold: false },
    { b: "the budget cap is 1000 dollars", f: "the team spent 1500 dollars", gold: true },
    { b: "the budget cap is 1000 dollars", f: "the team spent 800 dollars", gold: false },
    { b: "she lives permanently in Paris", f: "she commutes daily from her home in Lyon", gold: true },
    { b: "she lives permanently in Paris", f: "she visited Lyon once for a weekend", gold: false }
  ];
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const c of cases) {
    const q = `Records:\n- ${c.b}\n- ${c.f}\nDo these two records conflict with each other? Answer strictly yes or no.`;
    const ans = (await ask(q, 10)).toLowerCase();
    const says = ans.includes("yes");
    if (c.gold && says) tp++; else if (c.gold && !says) fn++; else if (!c.gold && says) fp++; else tn++;
  }
  const recall = tp + fn ? tp / (tp + fn) : 1, precision = tp + fp ? tp / (tp + fp) : 1;
  return { area: "DEEP-CONTRADICTION (entailment)", w: (recall + precision) / 2, wo: 0, extra: `model-as-checker recall ${Math.round(recall * 100)}% precision ${Math.round(precision * 100)}% (no records -> reader cannot know)` };
}

// 16 FEDERATION: do two independent stores agree? the union read must surface the
// cross-store conflict to the reader.
async function federation(n = 6) {
  let w = 0, wo = 0;
  const a = fresh(), b = fresh();
  try {
    const items = [];
    for (let i = 0; i < n; i++) { W(a.store, { title: `status of node ${i} is HEALTHY`, body: "healthy", subject: [`n${i}`], topics: ["fed"] }); W(b.store, { title: `status of node ${i} is FAILED`, body: "failed", subject: [`n${i}`], topics: ["fed"] }); items.push({ i }); }
    const ra = reopen(a), rb = reopen(b);
    for (const it of items) {
      // union read across the two independent stores (union mechanics proven in the
      // structural suite; here we test whether the reader sees the cross-store conflict)
      const ctx = [...ra.search(`status of node ${it.i}`, 3), ...rb.search(`status of node ${it.i}`, 3)].map((nn) => `- ${nn.title}`).join("\n");
      const q = `List every status that has been reported for node ${it.i}.`;
      const ans = (await ask(`Records:\n${ctx}\n${q}`, 40)).toLowerCase();
      if (ans.includes("healthy") && ans.includes("failed")) w++;   // saw both sources -> conflict surfaced
      const ans2 = (await ask(q, 40)).toLowerCase();
      if (ans2.includes("healthy") && ans2.includes("failed")) wo++;
    }
    return { area: "FEDERATION (cross-store conflict)", w: w / n, wo: wo / n };
  } finally { done(a); done(b); }
}

const runners = [adoption, recall, anteriority, authority, contradiction, deepContra, retrieval, temporality, supersession, modality, federation];
console.log("\n==================== AMBIENT model-driven suite (fixed 1b model) ====================");
console.log("model held constant (Llama-3.2-1B); score attributable to the MEMORY SYSTEM\n");
const rows = [];
for (const fn of runners) { try { rows.push(await fn()); } catch (e) { rows.push({ area: fn.name, w: 0, wo: 0, extra: `ERROR ${String(e.message).slice(0, 60)}` }); } }
const wn = Math.max(...rows.map((r) => r.area.length));
console.log(`  ${"AREA".padEnd(wn)}   with    without  delta   note`);
for (const r of rows) {
  const d = (r.w - r.wo);
  console.log(`  ${r.area.padEnd(wn)}   ${(r.w * 100).toFixed(0).padStart(3)}%    ${(r.wo * 100).toFixed(0).padStart(3)}%   ${(d >= 0 ? "+" : "") + (d * 100).toFixed(0)}%   ${r.extra || ""}`);
}
console.log("\n  delta = the weak model's gain from the memory system. High with-substrate + large");
console.log("  delta = the memory system carries the task. A small delta means the system adds little.");
console.log("\n  4 areas are NOT model-facing by nature (a 1b cannot verify them, only parrot a verdict):");
console.log("  SET-INTEGRITY (Merkle proof = sha256 arithmetic), REACTIVITY (fires without the model in");
console.log("  the loop), CONCURRENCY and ENDURANCE (systems properties measured by counting). Those stay");
console.log("  code-verified in sentinel-suite.mjs and are model-independent by construction.\n");
