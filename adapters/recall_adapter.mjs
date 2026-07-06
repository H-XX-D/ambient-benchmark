#!/usr/bin/env node
// AMBIENT adapter for Recall (recall-memory-substrate), exposed over the wire protocol so the
// four-tier runner drives it exactly like CogniCore. Wraps Recall 0.12.0: SqliteStore + admit
// (write) and store.search (query, returning full cell bodies with BM25 provenance).
//
// NOTE ON RETRIEVAL: we serve store.search(q, {limit}) bodies, NOT compileContext(). Recall's
// compileContext is a compact mini-index (ids + titles + confidence flags) built for an agent
// that expands handles via inspectCell(); a one-shot benchmark reader cannot expand handles, so
// it needs the full body text that search() carries. See docs/ADAPTER_CONTRACT.md.
//
// Run: node adapters/recall_adapter.mjs --port 8092   (needs Node >=22.13; imports vendor/recall/dist)

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = await import(join(ROOT, "vendor/recall/dist/index.js"));
const { SqliteStore, admit, compileContext, analyzeDagOverlay } = dist;

// Cycle (holonomy) + collection overlays, per store. The firewall registers these at ingest when
// the model detects an ordering that closes a loop (/dag) or a set of same-kind items (/collection).
// Query surfaces the cycle as a note and returns the whole collection for list/count questions.
const cycles = new Map();       // store -> [{ note, entities:[...] }]
const collections = new Map();  // store -> [{ keywords:[...], members:[body] }]
const listFor = (map, store) => { const k = store || "default"; if (!map.has(k)) map.set(k, []); return map.get(k); };

// WRITE FIREWALL: the relation edges are decided by the MODEL at ingest (in the runner, which
// holds the reader) and passed in on the write. The adapter just wires them into Recall's graph:
// a `supersedes` edge auto-marks the prior cell superseded (search then returns head-only); a
// `contradicts` edge surfaces in compileContext.conflicts. Edges carry the lineage id at write, so
// the graph is built one cell at a time as the model reads each turn against the growing store.
// (The earlier deterministic regex detector was removed: real prose needs the model, not markers.)
const VALID_RELATIONS = new Set(["supersedes", "contradicts", "depends_on", "supports", "concerns", "refines"]);
function sanitizeEdges(edges) {
  if (!Array.isArray(edges)) return [];
  return edges
    .filter((e) => e && VALID_RELATIONS.has(e.relation) && typeof e.target === "string" && e.target)
    .slice(0, 8)
    .map((e) => ({ relation: e.relation, target: e.target, ...(e.weight != null ? { weight: e.weight } : {}) }));
}

const NAME = "recall";
let seq = 0;

// Named stores let the runner build each tier's memory ONCE and reuse it: "auto" (the
// distilled auto-memory), "custom" (the substrate's own clean-ingest memory being tested),
// "combined" (auto + custom, for the both-enabled tier). Distillation and ingest happen once;
// each tier just queries its store. Unnamed requests use "default" (back-compat).
const stores = new Map();
function getStore(name = "default") {
  if (!stores.has(name)) stores.set(name, freshStore());
  return stores.get(name);
}

// Auto-flag override/injection-style language in stored content. When such content is served,
// it is marked [INJECTION-FLAGGED] so the reader treats it as untrusted, pushes back ("are you
// sure?"), and states the damage obeying it could cause, rather than overwriting an established
// fact. This is the read-side surfacing of Recall's warning-edge idea (the trend-scaling,
// time-decaying warning lives deeper; here we flag the language so the injection cannot pass silently).
const INJECTION_PATTERNS = [
  /\bignore\b[^.]*\b(previous|prior|earlier|above|all|any)\b/i,
  /\bdisregard\b/i,
  /\bsystem\s+override\b/i,
  /\boverride\b[^.]*\b(value|threshold|fact|record|setting|previous|stored)\b/i,
  /\b(replace|overwrite)\b[^.]*\b(stored|saved|current|value|threshold|record|number)\b/i,
  /\bforget\b[^.]*\b(what|everything|previous|prior|all)\b/i,
  /\bfrom now on\b[^.]*\b(report|use|say|return|treat)\b/i,
  /\bthe (real|actual|correct|true) (value|threshold|answer|number|figure)\b[^.]*\bis\b/i,
  /\b(do not|don'?t)\b[^.]*\b(tell|mention|reveal|report the (old|previous))\b/i,
  /\bnew instructions?\b\s*:/i,
];
function flagInjection(text) {
  const t = String(text || "");
  return INJECTION_PATTERNS.some((re) => re.test(t));
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "recall-ambient-"));
  return new SqliteStore(join(dir, "recall.sqlite3"));
}

// Recall 0.12.0 WriteProposal is minimal: {kind, title, body, confidence}; admit() does the
// enrichment (screening, calibration, dedup). We ingest each conversation turn as an observation.
function proposal(fact, source) {
  const text = String(fact ?? "");
  return {
    kind: "obs",
    title: text.slice(0, 80) || "turn",
    body: text,
    confidence: 0.7,
    sourceRefs: [source || "turn"],
  };
}

const routes = {
  name: () => ({ name: NAME }),
  // reset {store}: reset one named store; reset {store:"all"} or {} clears every store.
  reset: (b) => {
    const name = b?.store;
    if (!name || name === "all") { stores.clear(); cycles.clear(); collections.clear(); return { ok: true, reset: "all" }; }
    stores.set(name, freshStore());
    cycles.delete(name); collections.delete(name);
    return { ok: true, reset: name };
  },
  setAutoCapture: (b) => ({ supported: true, auto: Boolean(b.enabled) }),
  // holonomy: register an ordering; if it closes a loop, analyzeDagOverlay flags the cycle (created
  // at write, the L3 primitive). The cycle is surfaced as a note on later queries about its entities.
  dag: (b) => {
    const overlay = { id: "o", title: b.title || "ordering", nodeIds: b.nodeIds || [], edges: (b.edges || []).map((e) => ({ source: e.source, target: e.target })), metadata: {}, createdAt: "2026-01-01T00:00:00.000Z" };
    const a = analyzeDagOverlay(overlay);
    if (!a.isDag && a.cycles.length) {
      const cyc = a.cycles[0]; // analyzeDagOverlay already closes the loop (…-> start), don't re-append
      const note = "[CYCLE] " + cyc.join(" > ") + " form a closed loop; these cannot all be true (impossible cycle).";
      listFor(cycles, b.store).push({ note, entities: [...new Set(a.cycles.flat())] });
    }
    return { isDag: a.isDag, cycles: a.cycles };
  },
  // enumeration: register a collection of same-kind items; list/count queries get the whole set.
  collection: (b) => {
    listFor(collections, b.store).push({ keywords: (b.keywords || []).map((k) => String(k).toLowerCase()), members: b.members || [] });
    return { ok: true, size: (b.members || []).length };
  },
  write: (b) => {
    const store = getStore(b.store);
    const p = proposal(b.fact, b.source);
    // the model (runner) decided these edges by reading this turn against the growing graph
    const edges = sanitizeEdges(b.edges);
    if (edges.length) p.edges = edges;
    const res = admit(p, { store });
    const cell = res?.cell;
    return {
      id: cell?.key || cell?.handle || "w" + seq++,
      accepted: Boolean(res?.accepted),
      edges: edges.length ? edges.map((e) => e.relation) : undefined,
      issues: res?.accepted ? undefined : (res?.issues || []).slice(0, 3),
    };
  },
  query: (b) => {
    const store = getStore(b.store);
    const q = String(b.question ?? "");
    // search is HEAD-ONLY: superseded cells are excluded, so the reader sees the current value.
    const hits = store.search(q, { limit: b.top_k || 8 }) || [];
    let flags = 0;
    const support = hits
      .map((h) => h?.cell?.body || h?.cell?.title || "")
      .filter(Boolean)
      .map((body) => {
        if (flagInjection(body)) { flags++; return "[INJECTION-FLAGGED] " + body; }
        return body;
      });
    // surface Recall's detected conflicts (from the firewall's contradicts edges) as explicit
    // notes so the reader flags the conflict instead of picking one of the two live values.
    let conflicts = [];
    try { conflicts = compileContext(store, q, { limit: 8 }).conflicts || []; } catch { /* ignore */ }
    const conflictNotes = conflicts.slice(0, 3).map((c) => "[CONFLICT] " + c.replace(/\s*\[contradicts:[^\]]*\]\s*$/, ""));
    const ql = q.toLowerCase();
    // holonomy: surface a registered cycle if the question or served content names its entities
    const cycleNotes = listFor(cycles, b.store)
      .filter((c) => c.entities.some((e) => ql.includes(String(e).toLowerCase()) || support.some((s) => s.toLowerCase().includes(String(e).toLowerCase()))))
      .map((c) => c.note);
    // enumeration: for a list/count/order question, return the WHOLE matching collection (not top-k)
    let collMembers = [];
    if (/\bhow many\b|\blist\b|\ball\b|\bevery\b|\bin order\b|\border\b|\bhow much total\b|\btotal\b/.test(ql)) {
      for (const col of listFor(collections, b.store)) {
        if (!col.keywords.length || col.keywords.some((k) => ql.includes(k))) collMembers.push(...col.members);
      }
    }
    // REACTIVITY: a later fact that concerns/invalidates a retrieved plan points AT it with a
    // `concerns` edge. Reverse-traverse: pull the concerning fact in so the reader sees the update
    // even though it is lexically distant from the question. (Self-describing note; no prompt rule.)
    const hitKeys = new Set(hits.map((h) => h?.cell?.key).filter(Boolean));
    const concernNotes = [];
    if (hitKeys.size) {
      for (const cell of store.active()) {
        for (const e of cell.edgesOut || []) {
          if ((e.relation === "concerns" || e.relation === "invalidates") && hitKeys.has(e.target)) {
            concernNotes.push("[UPDATE] a later fact undercuts an earlier plan above: " + cell.body);
          }
        }
      }
    }
    const merged = [...new Set([...cycleNotes, ...conflictNotes, ...concernNotes, ...collMembers, ...support])];
    return {
      support: merged,
      injectionFlags: flags,
      conflicts: conflicts.length,
      cycles: cycleNotes.length,
      concerns: concernNotes.length,
      collectionMembers: collMembers.length,
      provenance: hits.map((h) => ({
        id: h?.cell?.key || h?.cell?.handle || "r" + seq++,
        origin: "external",
        source: "recall",
        score: Number(h?.score ?? 0),
      })),
    };
  },
  surface: () => ({ supported: false }),
};

const server = createServer(async (req, res) => {
  const send = (o, code = 200) => {
    const s = JSON.stringify(o);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(s);
  };
  const path = (req.url || "").replace(/^\//, "").split("?")[0];
  if (req.method === "GET" && path === "name") return send(routes.name());
  if (req.method !== "POST" || !routes[path]) return send({ error: "not found" }, 404);
  let raw = "";
  for await (const c of req) raw += c;
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { /* empty body ok */ }
  try { send(routes[path](body)); } catch (e) { send({ error: String(e?.message || e) }, 500); }
});

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8092);
server.listen(port, "127.0.0.1", () => console.log("recall adapter on 127.0.0.1:" + port));
