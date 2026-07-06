#!/usr/bin/env node
// Build the connective edges over the already-ingested cells: mentions edges
// between cells sharing an entity, supports edges from papers/preprints to the
// related articles. Direct relation inserts so existing cells get connected.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(RUN, "graph/sentinel.sqlite3"));
const rows = db.prepare("SELECT id, tags_json, title, kind FROM graph_nodes WHERE status='active'").all();
const parsed = rows.map((n) => {
  const t = JSON.parse(n.tags_json || "{}");
  return { id: n.id, title: n.title, kind: n.kind, ent: (t.entities || []).map((x) => String(x).toLowerCase()), top: (t.topics || []).map((x) => String(x).toLowerCase()) };
});
const now = new Date().toISOString();
const ins = db.prepare("INSERT INTO graph_relations(id,kind,source_id,target_id,data_json,created_at) VALUES(?,?,?,?,?,?)");
const seen = new Set(db.prepare("SELECT source_id||'|'||target_id||'|'||kind k FROM graph_relations").all().map((r) => r.k));
let added = 0;
function edge(kind, s, t) {
  if (s === t) return;
  const k = `${s}|${t}|${kind}`; if (seen.has(k)) return; seen.add(k);
  ins.run(randomUUID(), kind, s, t, "{}", now); added++;
}
// mentions: link cells that share a meaningful entity (chain, capped)
const byEnt = new Map();
for (const p of parsed) for (const e of p.ent) { if (e.length < 2) continue; (byEnt.get(e) || byEnt.set(e, []).get(e)).push(p.id); }
for (const [, ids] of byEnt) { for (let i = 1; i < ids.length && i < 6; i++) edge("mentions", ids[i], ids[i - 1]); }
// supports: papers + preprints support the related articles
const articles = parsed.filter((p) => p.top.some((t) => /wikipedia|web/.test(t)));
const papers = parsed.filter((p) => p.top.some((t) => /pdf|arxiv|paper|preprint/.test(t)));
for (const pap of papers) for (const a of articles.slice(0, 2)) edge("supports", pap.id, a.id);
// derived_from: code files derive from the package config
const cfg = parsed.find((p) => p.kind === "artifact" && /config/.test(p.title));
if (cfg) for (const c of parsed.filter((p) => /recall-core|aura/.test(p.title)).slice(0, 8)) edge("derived_from", c.id, cfg.id);

const total = db.prepare("SELECT count(*) c FROM graph_relations").get().c;
const kinds = db.prepare("SELECT kind, count(*) c FROM graph_relations GROUP BY kind").all();
console.log("added", added, "edges; total", total);
console.log("by kind:", JSON.stringify(kinds));
db.close();
