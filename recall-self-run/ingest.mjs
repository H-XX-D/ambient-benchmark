#!/usr/bin/env node
// Ingest diverse data shapes into the fresh benchmark graph with real edges and
// stand up programs. Logs the full data stream to traces/ingest-stream.jsonl.
// Historical snapshot (2026-06-23), frozen against Recall's pre-rename API
// (SQLiteRecallStore/admitWriteProposal). vendor/recall now ships the current
// SqliteStore/admit API; this needs a local pre-rename build to re-run as-is.
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.RECALL_SRC_DIR) {
  console.error("set RECALL_SRC_DIR to a pre-rename Recall build (dist/src/index.js) to re-run this snapshot");
  process.exit(1);
}
const { SQLiteRecallStore, admitWriteProposal } = await import(`${process.env.RECALL_SRC_DIR}/dist/src/index.js`);

const RUN = dirname(fileURLToPath(import.meta.url));
const DB = `${RUN}/graph/sentinel.sqlite3`;
const STREAM = `${RUN}/traces/ingest-stream.jsonl`;
writeFileSync(STREAM, "");
const store = new SQLiteRecallStore(DB);

let seq = 0, edges = 0;
const byShape = {};
function P(o) {
  return {
    schema_version: "recall.write.v1", actor: { kind: "connector", id: "ingest", display: "Ingest" },
    intent: { kind: o.kind || "observation", operation: o.operation || "create" },
    content: { title: o.title.slice(0, 180), body: (o.body ?? o.title).slice(0, 8000), summary: (o.summary ?? o.title).slice(0, 400) },
    scope: { project: "sentinel-bench", path: ".", tenant: "local" },
    tags: { category: ["memory"], type: [o.kind || "observation"], subject: o.subject || [o.title.slice(0, 40)], project: ["sentinel-bench"],
      idea: [o.shape], timestamp: [o.createdAt || "2026-06-23"], topics: o.topics || [o.shape], entities: o.entities || [],
      identities: ["connector:ingest"], rings: ["adapter"], lifecycle: ["active"], quality: ["source-grounded"], sensitivity: ["public"], permission: ["read"] },
    evidence: { source_refs: o.source_refs || [], depends_on: o.depends_on || [], supports: o.supports || [], contradicts: o.contradicts || [], concerns: [] },
    confidence: { value: o.confidence ?? 0.75, uncertainty: 0.1, concern: 0.05, source_quality: "high", stability: "stable" },
    provenance: { created_at: new Date(o.createdAt || "2026-06-23").toISOString(), origin: "connector", produced_by: o.shape, verification: "checked", signature_status: "unsigned" },
    policy: { sensitivity: "public", allow_background_use: true, requires_review: false, expires_at: null, reverify_after: null }
  };
}
let rejected = 0;
function W(o) {
  const res = admitWriteProposal(P(o), store, o.createdAt ? { now: new Date(o.createdAt) } : {});
  if (!res.accepted || !res.node) {
    rejected++;
    appendFileSync(STREAM, JSON.stringify({ ts: Date.now(), shape: o.shape, rejected: true, title: o.title.slice(0, 60), issues: (res.issues || []).map((i) => i.code) }) + "\n");
    return null;
  }
  const node = res.node;
  seq++; byShape[o.shape] = (byShape[o.shape] || 0) + 1;
  const e = (res.relations || []).length; edges += e;
  appendFileSync(STREAM, JSON.stringify({ seq, ts: Date.now(), shape: o.shape, kind: o.kind || "observation", id: node.id, title: o.title.slice(0, 80), edges: e }) + "\n");
  return node;
}

// ---- 1 CODEBASES (Recall-Personal + AURA-main), with depends_on edges ----
function ingestCode(dir, label, cap) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => /\.(ts|py|js|mjs)$/.test(f)).slice(0, cap);
  const parsed = files.map((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    const imports = [...src.matchAll(/from\s+["']\.\/([^"']+?)(?:\.js)?["']/g)].map((m) => m[1]);
    return { f, src, imports };
  });
  parsed.sort((a, b) => a.imports.length - b.imports.length); // leaves first so depends_on resolves
  const pathToId = new Map();
  for (const { f, src, imports } of parsed) {
    const baseNoExt = f.replace(/\.(ts|py|js|mjs)$/, "");
    const dep = imports.map((i) => pathToId.get(i)).filter(Boolean);
    const head = src.split("\n").slice(0, 40).join("\n");
    const node = W({ shape: "code", kind: "artifact", title: `${label}/${f}`, body: head, summary: `source file ${f} (${imports.length} local imports)`,
      topics: ["code", label, f.endsWith(".py") ? "python" : "typescript"], entities: imports, subject: [`${label}:${baseNoExt}`], depends_on: dep });
    if (node) pathToId.set(baseNoExt, node.id);
  }
}
ingestCode(`${process.env.RECALL_SRC_DIR}/src/core`, "recall-core", 22);
if (process.env.AURA_SRC_DIR) ingestCode(process.env.AURA_SRC_DIR, "aura", 8);

// ---- 2 DATASET (penguins.csv) ----
if (existsSync(`${RUN}/ingest/penguins.csv`)) {
  const rows = readFileSync(`${RUN}/ingest/penguins.csv`, "utf8").trim().split("\n");
  const cols = rows[0].split(",");
  const data = rows.slice(1).map((r) => r.split(","));
  const masses = data.map((r) => Number(r[5])).filter((x) => !Number.isNaN(x));
  const avg = Math.round(masses.reduce((a, b) => a + b, 0) / masses.length);
  W({ shape: "dataset", kind: "artifact", title: "dataset penguins.csv", body: `columns: ${cols.join(", ")}. ${data.length} rows. mean body_mass_g = ${avg}.`,
    topics: ["dataset", "tabular", "penguins"], entities: cols, subject: ["dataset:penguins"] });
  // a few row cells + a dataset-stat belief the program will score
  for (let i = 0; i < 6; i++) { const r = data[i]; if (r) W({ shape: "dataset", title: `penguin row ${i}: ${r[0]} on ${r[1]}, mass ${r[5]}g`, body: r.join(","), topics: ["dataset", "row"], subject: ["dataset:penguins"], entities: [r[0]] }); }
  W({ shape: "dataset", kind: "belief_update", title: `metric mean body_mass_g is ${avg}`, body: `${avg}`, topics: ["dataset", "metric"], subject: ["metric:body_mass"], confidence: 0.8 });
}

// ---- 3 WEB ARTICLES (wikipedia summaries) ----
for (const f of readdirSync(`${RUN}/ingest`).filter((x) => x.startsWith("wiki_"))) {
  try { const j = JSON.parse(readFileSync(`${RUN}/ingest/${f}`, "utf8"));
    W({ shape: "web", kind: "source", title: `article ${j.title}`, body: j.extract || j.description || j.title, summary: j.description || "",
      topics: ["web", "wikipedia", String(j.title || "").toLowerCase().replace(/\s+/g, "-")], subject: [`web:${j.title}`], entities: [j.title] });
  } catch {}
}

// ---- 4 ARXIV PREPRINTS (abstracts from atom) ----
if (existsSync(`${RUN}/ingest/arxiv.atom`)) {
  const atom = readFileSync(`${RUN}/ingest/arxiv.atom`, "utf8");
  const entries = atom.split("<entry>").slice(1);
  for (const e of entries.slice(0, 6)) {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, " ").trim() || "untitled";
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, " ").trim() || "";
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).slice(0, 4);
    W({ shape: "arxiv", kind: "source", title: `preprint ${title}`, body: summary, summary: summary.slice(0, 300), topics: ["arxiv", "preprint", "cs.ai"], subject: [`arxiv:${title.slice(0, 30)}`], entities: authors });
  }
}

// ---- 5 PDFS (extracted text) + a supports edge to the RAG article ----
let attentionId = null;
for (const f of readdirSync(`${RUN}/ingest/pdfs`).filter((x) => x.endsWith(".txt"))) {
  const text = readFileSync(`${RUN}/ingest/pdfs/${f}`, "utf8");
  const title = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 8 && !/arxiv|google|permission/i.test(l))[0] || f;
  const node = W({ shape: "pdf", kind: "source", title: `paper ${title.slice(0, 80)}`, body: text, summary: title.slice(0, 200), topics: ["pdf", "paper", "transformers"], subject: [`pdf:${f}`], entities: ["transformer", "attention"] });
  if (/attention/i.test(title)) attentionId = node.id;
}

// ---- 6 JSON (package.json) ----
if (existsSync(`${RUN}/ingest/package.json`)) {
  const pkg = JSON.parse(readFileSync(`${RUN}/ingest/package.json`, "utf8"));
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  W({ shape: "json", kind: "artifact", title: `config ${pkg.name}@${pkg.version}`, body: `name ${pkg.name} version ${pkg.version}. scripts: ${Object.keys(pkg.scripts || {}).join(", ")}. deps: ${deps.join(", ")}`,
    topics: ["json", "config", "manifest"], subject: ["json:package"], entities: deps });
}

// ---- 7 LOG (app.log) with a PLANTED CONTRADICTION + a watch program ----
let healthyId = null, errorId = null;
if (existsSync(`${RUN}/ingest/app.log`)) {
  for (const line of readFileSync(`${RUN}/ingest/app.log`, "utf8").trim().split("\n")) {
    const level = (line.match(/\b(INFO|WARN|ERROR)\b/) || [])[1] || "INFO";
    const node = W({ shape: "log", kind: "observation", title: line.slice(0, 100), body: line, topics: ["log", level.toLowerCase()], subject: ["service:api-status"], entities: ["api"] });
    if (/healthy/i.test(line)) healthyId = node.id;
    if (/ERROR/i.test(line)) errorId = node.id;
  }
}

// ---- PROGRAMS stood up where they go ----
const programs = [];
try {
  if (healthyId) {
    const edge = store.addHyperedge({ kind: "evidence-bundle", title: "watch:api-status", members: [{ nodeId: healthyId, role: "claim" }] });
    const prog = store.attachProgram(edge.id, { schemaVersion: "recall.program.v1", operation: "watch", params: { delta: 0.1 } });
    store.runProgram(prog.id); // baseline while the belief "api healthy" still stands
    // inject the contradicting fact AFTER the baseline so the watch trips on the drop
    W({ shape: "log", kind: "observation", title: "service api is DOWN due to db timeout", body: "api down", contradicts: [healthyId], subject: ["service:api-status"], entities: ["api"], topics: ["log", "status"] });
    const out = store.runProgram(prog.id).output;
    programs.push({ on: "api-status (log)", operation: "watch", id: prog.id, tripped: out?.tripped === true });
  }
} catch (e) { programs.push({ error: String(e.message).slice(0, 80) }); }

const manifest = { db: DB, cells: seq, edges, rejected, byShape, programs, generatedFor: "SENTINEL full run" };
writeFileSync(`${RUN}/ingest/manifest.json`, JSON.stringify(manifest, null, 2));
console.log("INGEST COMPLETE");
console.log("cells:", seq, "edges:", edges);
console.log("by shape:", JSON.stringify(byShape));
console.log("programs:", JSON.stringify(programs));
store.close?.();
