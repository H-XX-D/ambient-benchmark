#!/usr/bin/env node
// Run the gauntlet against the POPULATED benchmark graph and save the full data
// stream, response timings, and traces. Structural checks run in code over the real
// cells; the model-driven part asks a fixed 1b model questions answerable from the
// ingested data, WITH vs WITHOUT what the substrate serves, logging every call.
// Historical snapshot (2026-06-23), frozen against Recall's pre-rename API and
// its sentinel-probes merkle helper. Needs RECALL_SRC_DIR (a pre-rename checkout)
// to re-run as-is; vendor/recall here ships only the current compiled dist.
import { writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.RECALL_SRC_DIR) {
  console.error("set RECALL_SRC_DIR to a pre-rename Recall build to re-run this snapshot");
  process.exit(1);
}
const { SQLiteRecallStore, analyzeMemory } = await import(`${process.env.RECALL_SRC_DIR}/dist/src/index.js`);
const { leafHash, mth, inclusionProof, verifyInclusion, prefixConsistent } = await import(`${process.env.RECALL_SRC_DIR}/scripts/sentinel-probes/merkle.mjs`);

const RUN = dirname(fileURLToPath(import.meta.url));
const store = new SQLiteRecallStore(`${RUN}/graph/sentinel.sqlite3`);
const TRACE = `${RUN}/traces/gauntlet.jsonl`; writeFileSync(TRACE, "");
const URL = "http://localhost:8089/v1/chat/completions";

async function ask(prompt, area, arm, max = 48) {
  const t0 = Date.now();
  let out = "", err = null;
  try {
    const r = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: max, stream: false }) });
    out = ((await r.json()).choices?.[0]?.message?.content || "").trim();
  } catch (e) { err = String(e.message); }
  const ms = Date.now() - t0;
  appendFileSync(TRACE, JSON.stringify({ ts: t0, area, arm, latency_ms: ms, prompt_chars: prompt.length, prompt, response: out, error: err }) + "\n");
  return { out, ms };
}
const has = (a, t) => a.toLowerCase().replace(/\s+/g, "").includes(String(t).toLowerCase().replace(/\s+/g, ""));
const served = (q, k = 5) => store.search(q, k).map((n) => `- ${n.title}: ${String(n.body).slice(0, 240)}`).join("\n");

// ---------- STRUCTURAL (in code, over the real graph) ----------
const structural = {};
const nodes = store.listNodes(5000).filter((n) => n.status === "active");
const leaves = nodes.map((n) => leafHash(`${n.id}:${n.body}`));
const root = mth(leaves);
let inc = 0; for (let i = 0; i < nodes.length; i++) if (verifyInclusion(leaves[i], inclusionProof(leaves, i), root)) inc++;
const tampered = leaves.slice(); tampered[3] = leafHash("tampered"); const tamperDetected = !mth(tampered).equals(root);
structural.setIntegrity = { cells: nodes.length, inclusionVerified: `${inc}/${nodes.length}`, merkleRoot: root.toString("hex").slice(0, 16) + "...", tamperDetected };
const contradictions = analyzeMemory(store).contradictions;
structural.contradiction = { detected: contradictions.length, sample: contradictions.slice(0, 2).map((c) => (c.sourceTitle || c.sourceId || "").slice(0, 40)) };
structural.edges = store.listRelations(undefined, "both", 5000).length;

// ---------- MODEL-DRIVEN (fixed 1b over real ingested data) ----------
// derive the dataset mean from the populated graph
const dsCell = nodes.find((n) => /mean body_mass_g/.test(n.title) || /mean body_mass_g/.test(n.body));
const dsMean = (String(dsCell?.body || dsCell?.title || "").match(/(\d{3,5})/) || [])[1] || "";

const tasks = [
  { area: "RECALL dataset-mean", q: "What is the mean body_mass_g in the penguins dataset? Reply with only the number.", ctxq: "mean body_mass penguins dataset", gold: dsMean },
  { area: "RECALL log-port", q: "What port did the api service start on? Reply with only the number.", ctxq: "service api started port", gold: "9347" },
  { area: "RECALL paper-title", q: "What is the title of the paper about attention mechanisms? Reply briefly.", ctxq: "attention paper transformer", gold: "attention" },
  { area: "RECALL package-name", q: "What is the name of the software package in the config? Reply with only the name.", ctxq: "config package name version", gold: "recall-memory-substrate" },
  { area: "CODE dependency", q: "Name one module the recall-core admission file imports. Reply with one word.", ctxq: "recall-core/admission.ts imports", gold: ["schema", "firewall", "references", "cells", "store", "types"] },
  { area: "CONTRADICTION api-status", q: "List every status that has been recorded for the api service.", ctxq: "service api status", gold: ["healthy", "down"] },
  { area: "ARTICLE knowledge-graph", q: "In one sentence, what is a knowledge graph?", ctxq: "knowledge graph article", gold: ["graph", "entit"] }
];

const rows = [];
for (const t of tasks) {
  const ctx = served(t.ctxq);
  const w = await ask(`Context:\n${ctx}\n\n${t.q}`, t.area, "with");
  const wo = await ask(t.q, t.area, "without");
  const golds = Array.isArray(t.gold) ? t.gold : [t.gold];
  const okW = t.area.startsWith("CONTRADICTION") ? golds.every((g) => has(w.out, g)) : golds.some((g) => g && has(w.out, g));
  const okWo = t.area.startsWith("CONTRADICTION") ? golds.every((g) => has(wo.out, g)) : golds.some((g) => g && has(wo.out, g));
  rows.push({ area: t.area, with: okW, without: okWo, ms_with: w.ms, ms_without: wo.ms });
}

// ---------- SAVE ----------
const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
const summary = {
  generatedFor: "SENTINEL full run on populated graph",
  model: "Llama-3.2-1B-Instruct Q4_K_M (local llama.cpp)",
  graph: { cells: nodes.length, edges: structural.edges },
  structural,
  modelDriven: rows,
  withAccuracy: `${rows.filter((r) => r.with).length}/${rows.length}`,
  withoutAccuracy: `${rows.filter((r) => r.without).length}/${rows.length}`,
  latency_ms: { mean: avg(rows.flatMap((r) => [r.ms_with, r.ms_without])), p50_with: avg(rows.map((r) => r.ms_with)) }
};
writeFileSync(`${RUN}/results/summary.json`, JSON.stringify(summary, null, 2));

const lines = [];
lines.push("==================== SENTINEL FULL RUN (populated graph + 1b) ====================\n");
lines.push(`graph: ${nodes.length} active cells, ${structural.edges} edges, model: Llama-3.2-1B\n`);
lines.push("STRUCTURAL (code-verified over the real graph):");
lines.push(`  set-integrity: inclusion ${structural.setIntegrity.inclusionVerified} verified, tamper ${structural.setIntegrity.tamperDetected ? "detected" : "MISSED"}, root ${structural.setIntegrity.merkleRoot}`);
lines.push(`  contradiction: ${structural.contradiction.detected} detected over the live graph ${JSON.stringify(structural.contradiction.sample)}`);
lines.push("\nMODEL-DRIVEN (fixed 1b; with = served from the graph, without = bare model):");
lines.push(`  ${"AREA".padEnd(26)} with  without  latency(with)`);
for (const r of rows) lines.push(`  ${r.area.padEnd(26)} ${r.with ? " OK " : "miss"}   ${r.without ? "OK" : "--"}     ${r.ms_with}ms`);
lines.push(`\n  with-substrate ${summary.withAccuracy}, without ${summary.withoutAccuracy}, mean latency ${summary.latency_ms.mean}ms`);
lines.push(`\n  traces: traces/gauntlet.jsonl (${rows.length * 2} model calls), ingest stream: traces/ingest-stream.jsonl`);
const text = lines.join("\n") + "\n";
writeFileSync(`${RUN}/results/report.txt`, text);
console.log(text);
store.close?.();
