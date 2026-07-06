#!/usr/bin/env node
// AMBIENT hard 1b run: the honest version. The easy suite cherry-picked
// unguessable facts (baseline forced to 0) and fed the answer cleanly. This one
// stresses the memory system three ways, holding the model fixed (Llama-3.2-1B):
//   1. KNOWN vs NOVEL: facts the model already knows (memory should add nothing)
//      vs private facts (memory is everything). Honest baseline, not engineered 0.
//   2. POISON: the truth is buried among plausible rumors; can the reader find it.
//   3. MULTI-HOP: the answer needs two stored facts chained, not one copied.
import { fresh, done, reopen, W } from "./probes/_lib.mjs";

const URL = "http://localhost:8089/v1/chat/completions";
async function ask(prompt, max = 24) {
  const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: max, stream: false }) });
  return ((await r.json()).choices?.[0]?.message?.content || "").trim();
}
const has = (ans, tok) => ans.toLowerCase().replace(/\s+/g, "").includes(tok.toLowerCase().replace(/\s+/g, ""));

// 1 KNOWN vs NOVEL
async function knownVsNovel() {
  const known = [
    { q: "What is the chemical symbol for gold? One word.", a: "au" },
    { q: "What is the capital of France? One word.", a: "paris" },
    { q: "How many sides does a triangle have? Number only.", a: "3" },
    { q: "What planet is known as the Red Planet? One word.", a: "mars" },
    { q: "What is the largest ocean on Earth? One word.", a: "pacific" }
  ];
  const s = fresh(); const novel = [];
  for (let i = 0; i < 5; i++) { const v = `KZ-${(i * 733) % 10000}`; novel.push({ i, v, q: `What is the rotor code for turbine ${i}? Reply with only the code.`, text: `the rotor code for turbine ${i} is ${v}` }); }
  try {
    for (const nv of novel) W(s.store, { title: nv.text, body: nv.v, subject: [`tur${nv.i}`], topics: ["nov"] });
    const r = reopen(s);
    let kB = 0, kW = 0, nB = 0, nW = 0;
    for (const k of known) { if (has(await ask(k.q), k.a)) kB++; if (has(await ask(`(general knowledge)\n${k.q}`), k.a)) kW++; }
    for (const nv of novel) { if (has(await ask(nv.q), nv.v)) nB++; if (has(await ask(`Context:\n- ${nv.text}\n${nv.q}`), nv.v)) nW++; }
    return [
      { area: "KNOWN facts (model already knows)", w: kW / 5, wo: kB / 5, extra: "memory should add ~nothing" },
      { area: "NOVEL facts (private to memory)", w: nW / 5, wo: nB / 5, extra: "memory is everything" }
    ];
  } finally { done(s); }
}

// 2 POISON
async function poison(n = 8) {
  const s = fresh(); let w = 0, wo = 0;
  try {
    const items = [];
    for (let i = 0; i < n; i++) {
      const truth = `AUTH-${(i * 911) % 10000}`;
      W(s.store, { title: `OFFICIAL the master key for vault ${i} is ${truth}`, body: truth, subject: [`pv${i}`], topics: ["poison"] });
      for (let p = 0; p < 3; p++) W(s.store, { title: `rumor the master key for vault ${i} might be AUTH-${(i * 911 + p * 13 + 1) % 10000}`, body: "rumor", subject: [`pv${i}`], topics: ["poison"] });
      items.push({ i, truth });
    }
    const r = reopen(s);
    for (const it of items) {
      const ctx = r.search(`master key for vault ${it.i}`, 6).map((nn) => `- ${nn.title}`).join("\n");
      const q = `What is the OFFICIAL master key for vault ${it.i}? Trust only records marked OFFICIAL. Reply with only the code.`;
      if (has(await ask(`Context:\n${ctx}\n${q}`), it.truth)) w++;
      if (has(await ask(q), it.truth)) wo++;
    }
    return { area: "POISON robustness (truth among rumors)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

// 3 MULTI-HOP
async function multiHop(n = 8) {
  const s = fresh(); let w = 0, wo = 0;
  const cities = ["Oslo", "Lima", "Cairo", "Hanoi", "Quito", "Riga", "Accra", "Doha"];
  try {
    const items = [];
    for (let i = 0; i < n; i++) { W(s.store, { title: `engineer E${i} works at company C${i}`, body: `E${i}-C${i}`, subject: [`e${i}`], topics: ["hop"] }); W(s.store, { title: `company C${i} is headquartered in ${cities[i]}`, body: `C${i}-${cities[i]}`, subject: [`c${i}`], topics: ["hop"] }); items.push({ i, city: cities[i] }); }
    const r = reopen(s);
    for (const it of items) {
      const ctx = [...r.search(`engineer E${it.i}`, 3), ...r.search(`company C${it.i}`, 3)].map((nn) => `- ${nn.title}`).join("\n");
      const q = `In which city does engineer E${it.i} work? Reply with only the city.`;
      if (has(await ask(`Context:\n${ctx}\n${q}`), it.city)) w++;
      if (has(await ask(q), it.city)) wo++;
    }
    return { area: "MULTI-HOP (2-fact chain)", w: w / n, wo: wo / n };
  } finally { done(s); }
}

console.log("\n==================== AMBIENT hard 1b run (honest) ====================");
console.log("fixed Llama-3.2-1B; realistic baselines, poisoned context, multi-hop\n");
const rows = [...(await knownVsNovel()), await poison(), await multiHop()];
const wn = Math.max(...rows.map((r) => r.area.length));
console.log(`  ${"AREA".padEnd(wn)}   with    without  delta   note`);
for (const r of rows) {
  const d = r.w - r.wo;
  console.log(`  ${r.area.padEnd(wn)}   ${(r.w * 100).toFixed(0).padStart(3)}%    ${(r.wo * 100).toFixed(0).padStart(3)}%   ${(d >= 0 ? "+" : "") + (d * 100).toFixed(0)}%   ${r.extra || ""}`);
}
console.log("");
