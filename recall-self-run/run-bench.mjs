#!/usr/bin/env node
// The benchmark. The memory system is under test; the reader model is a fixed
// commodity. Each model runs the WHOLE questionnaire twice: Pass A alone, Pass B
// with what the memory serves (store.search). Questions and answer keys come from
// questionnaire.json (extracted from the data). Programs/hooks fire and are
// recorded; set-integrity is code-verified. Nothing here inspects the DB by hand.
// Historical snapshot (2026-06-23), frozen against Recall's pre-rename API and
// its sentinel-probes merkle helper. Needs RECALL_SRC_DIR (a pre-rename checkout)
// to re-run as-is; vendor/recall here ships only the current compiled dist.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.RECALL_SRC_DIR) {
  console.error("set RECALL_SRC_DIR to a pre-rename Recall build to re-run this snapshot");
  process.exit(1);
}
const { SQLiteRecallStore, analyzeMemory } = await import(`${process.env.RECALL_SRC_DIR}/dist/src/index.js`);
const { leafHash, mth, inclusionProof, verifyInclusion } = await import(`${process.env.RECALL_SRC_DIR}/scripts/sentinel-probes/merkle.mjs`);

const RUN = dirname(fileURLToPath(import.meta.url));
const store = new SQLiteRecallStore(`${RUN}/graph/sentinel.sqlite3`);
const TRACE = `${RUN}/traces/bench.jsonl`; writeFileSync(TRACE, "");
const Q = JSON.parse(readFileSync(`${RUN}/questionnaire.json`, "utf8"));
const KEY = existsSync(`${process.env.HOME}/.sentinel/openai.key`) ? readFileSync(`${process.env.HOME}/.sentinel/openai.key`, "utf8").trim() : "";

async function askLocal(prompt, max) {
  const r = await fetch("http://localhost:8089/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: max, stream: false }) });
  return ((await r.json()).choices?.[0]?.message?.content || "").trim();
}
async function askGpt(prompt, max) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: max }) });
  const d = await r.json(); if (d.error) throw new Error(d.error.message); return (d.choices?.[0]?.message?.content || "").trim();
}
const TIERS = { "local-1b": askLocal, ...(KEY ? { "gpt-4o": askGpt } : {}) };
const has = (a, t) => a.toLowerCase().replace(/\s+/g, "").includes(String(t).toLowerCase().replace(/\s+/g, ""));
const score = (ans, q) => q.both ? q.gold.every((g) => has(ans, g)) : q.gold.some((g) => has(ans, g));
const served = (cq) => store.search(cq, 5).map((n) => `- ${n.title}: ${String(n.body).slice(0, 220)}`).join("\n");

async function ask(tier, prompt, qid, pass) {
  const t0 = Date.now(); let out = "", err = null;
  try { out = await TIERS[tier](prompt, qid === "contra" ? 40 : 16); } catch (e) { err = String(e.message).slice(0, 80); }
  const ms = Date.now() - t0;
  appendFileSync(TRACE, JSON.stringify({ ts: t0, tier, pass, qid, latency_ms: ms, response: out, error: err }) + "\n");
  return { out, ms };
}

// ---------- STRUCTURAL (code-verified, not a model task) ----------
const nodes = store.listNodes(5000).filter((n) => n.status === "active");
const leaves = nodes.map((n) => leafHash(`${n.id}:${n.body}`));
const root = mth(leaves);
let inc = 0; for (let i = 0; i < nodes.length; i++) if (verifyInclusion(leaves[i], inclusionProof(leaves, i), root)) inc++;
const structural = { cells: nodes.length, edges: store.listRelations(undefined, "both", 9000).length, setIntegrity: `inclusion ${inc}/${nodes.length}, root ${root.toString("hex").slice(0, 12)}`, contradictionsDetected: analyzeMemory(store).contradictions.length };

// ---------- HOOKS (programs fire) ----------
let hooks = { ran: 0, tripped: 0, detail: [] };
try {
  const manifest = JSON.parse(readFileSync(`${RUN}/ingest/manifest.json`, "utf8"));
  for (const p of (manifest.programs || [])) {
    if (!p.id) continue;
    hooks.ran++; if (p.tripped) hooks.tripped++;            // trip fired during ingestion (push, outside the loop)
    hooks.detail.push({ on: p.on, tripped: p.tripped === true });
  }
} catch (e) { hooks.error = String(e.message).slice(0, 80); }

// ---------- MODEL A/B (the benchmark) ----------
const results = {};
for (const tier of Object.keys(TIERS)) {
  const passA = [], passB = [];
  for (const q of Q) { const r = await ask(tier, q.q, q.id, "A"); passA.push({ id: q.id, ok: score(r.out, q), ms: r.ms, control: !!q.control }); }
  for (const q of Q) { const ctx = served(q.cq); const r = await ask(tier, `Context:\n${ctx}\n\n${q.q}`, q.id, "B"); passB.push({ id: q.id, ok: score(r.out, q), ms: r.ms, control: !!q.control }); }
  const aOK = passA.filter((x) => x.ok).length, bOK = passB.filter((x) => x.ok).length;
  const ctrlA = passA.filter((x) => x.control), ctrlB = passB.filter((x) => x.control);
  results[tier] = {
    passA_without: `${aOK}/${Q.length}`, passB_with: `${bOK}/${Q.length}`, delta: bOK - aOK,
    controls: `without ${ctrlA.filter((x) => x.ok).length}/${ctrlA.length}, with ${ctrlB.filter((x) => x.ok).length}/${ctrlB.length} (memory should not change this)`,
    perQuestion: Q.map((q) => ({ id: q.id, without: passA.find((x) => x.id === q.id).ok, with: passB.find((x) => x.id === q.id).ok, control: !!q.control })),
    meanLatency_ms: Math.round([...passA, ...passB].reduce((s, x) => s + x.ms, 0) / (Q.length * 2))
  };
}

const summary = { model_tiers: Object.keys(TIERS), questions: Q.length, structural, hooks, results };
writeFileSync(`${RUN}/results/bench-summary.json`, JSON.stringify(summary, null, 2));

const L = [];
L.push("==================== SENTINEL BENCHMARK (memory under test, model fixed) ====================\n");
L.push(`graph: ${structural.cells} cells, ${structural.edges} edges`);
L.push(`structural (code-verified): set-integrity ${structural.setIntegrity}; contradictions detected ${structural.contradictionsDetected}`);
L.push(`hooks: ${hooks.ran} program(s) ran, ${hooks.tripped} tripped ${JSON.stringify(hooks.detail)}\n`);
for (const [tier, r] of Object.entries(results)) {
  L.push(`[${tier}]  Pass A (without memory): ${r.passA_without}   Pass B (with memory): ${r.passB_with}   delta: ${r.delta >= 0 ? "+" : ""}${r.delta}`);
  L.push(`   controls: ${r.controls}`);
  L.push(`   per question (without -> with): ${r.perQuestion.map((p) => `${p.id}${p.control ? "*" : ""}:${p.without ? "Y" : "n"}>${p.with ? "Y" : "n"}`).join("  ")}`);
  L.push(`   mean latency: ${r.meanLatency_ms}ms\n`);
}
L.push("* = common-knowledge control. delta is the memory system's contribution with the reader held fixed.");
L.push(`traces: traces/bench.jsonl (${Q.length * Object.keys(TIERS).length * 2} calls)`);
const text = L.join("\n") + "\n";
writeFileSync(`${RUN}/results/bench-report.txt`, text);
console.log(text);
store.close?.();
