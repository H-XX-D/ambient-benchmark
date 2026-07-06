// Shared helpers for the self-built AMBIENT probes.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SqliteStore, admit } from "../_recall.mjs";

// Compat shim: the probes that use this file were written against a store
// with a `getNode(id)` method; real SqliteStore only has get(key)/getByHandle.
// Attach a thin alias rather than hand-patch every call site across probes
// this file didn't author the changes for.
function withCompat(store) {
  store.getNode = (id) => {
    const cell = store.get(id) ?? store.getByHandle(id);
    return cell ? { ...cell, id: cell.key } : undefined;
  };
  return store;
}

export function fresh() {
  const dir = mkdtempSync(join(os.tmpdir(), "sentinel-probe-"));
  const path = join(dir, "d.sqlite3");
  return { store: withCompat(new SqliteStore(path)), path, dir };
}
export function done(s) { try { s.store.close(); } finally { rmSync(s.dir, { recursive: true, force: true }); } }
export function reopen(s) { s.store.close(); s.store = withCompat(new SqliteStore(s.path)); return s.store; }

// Flat proposal matching the current admit() schema. o.kind here is whatever
// callers historically passed (e.g. "observation"); map the handful of long
// forms used across these probes to the real short KINDS codes. supports/
// contradicts (arrays of prior node ids) become real edges declared at write
// time — the only contradiction mechanism the public admit() API has; it has
// no separate auto-detection step (see ROADMAP: AMBIENT gap notes).
const KIND_MAP = { observation: "obs", belief: "bel", decision: "dec", task: "tsk", objective: "obj", risk: "rsk" };
function shortKind(k) { return KIND_MAP[k] || (k && k.length <= 4 ? k : "obs"); }

export function mkProposal(o = {}) {
  const createdAt = o.createdAt || "2024-01-01";
  const edges = [
    ...(o.supports || []).map((target) => ({ relation: "supports", target })),
    ...(o.contradicts || []).map((target) => ({ relation: "contradicts", target })),
  ];
  return {
    kind: shortKind(o.kind),
    title: o.title,
    body: o.body ?? o.title,
    summary: o.summary ?? o.title,
    confidence: o.confidence ?? 0.8,
    project: "probe",
    tenant: "local",
    topics: o.topics || ["fact"],
    entities: o.entities || ["x"],
    ...(edges.length ? { edges } : {}),
  };
}
export function W(store, o) {
  const result = admit(mkProposal(o), { store });
  if (!result || result.accepted !== true || !result.cell) {
    throw new Error(`write not admitted: ${o.title} -> ${JSON.stringify(result?.issues ?? result)}`);
  }
  // .id alias: probes built against the old store address written cells by
  // .id, real cells carry .key. Same value under both names.
  return { ...result.cell, id: result.cell.key };
}
