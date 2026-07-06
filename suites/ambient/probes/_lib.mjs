// Shared helpers for the self-built AMBIENT probes.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { SQLiteRecallStore, admitWriteProposal } from "../../dist/src/index.js";

export function fresh() {
  const dir = mkdtempSync(join(os.tmpdir(), "sentinel-probe-"));
  const path = join(dir, "d.sqlite3");
  return { store: new SQLiteRecallStore(path), path, dir };
}
export function done(s) { try { s.store.close?.(); } finally { rmSync(s.dir, { recursive: true, force: true }); } }
export function reopen(s) { s.store.close?.(); s.store = new SQLiteRecallStore(s.path); return s.store; }

export function mkProposal(o = {}) {
  const createdAt = o.createdAt || "2024-01-01";
  return {
    schema_version: "recall.write.v1", actor: { kind: "llm", id: "probe", display: "Probe" },
    intent: { kind: o.kind || "observation", operation: o.operation || "create" },
    content: { title: o.title, body: o.body ?? o.title, summary: o.summary ?? o.title },
    scope: { project: "probe", path: ".", tenant: "local" },
    tags: {
      category: ["memory"], type: [o.kind || "observation"], subject: o.subject || ["fact"], project: ["probe"],
      idea: ["probe"], timestamp: [createdAt], topics: o.topics || ["fact"], entities: o.entities || ["x"],
      identities: ["agent:probe"], rings: ["adapter"], lifecycle: ["active"], quality: ["source-grounded"],
      sensitivity: ["public"], permission: ["read"]
    },
    evidence: { source_refs: [], depends_on: [], supports: o.supports || [], contradicts: o.contradicts || [], concerns: [] },
    confidence: { value: o.confidence ?? 0.8, uncertainty: 0.1, concern: 0.05, source_quality: o.sourceQuality || "high", stability: "stable" },
    provenance: { created_at: new Date(createdAt).toISOString(), origin: "llm", produced_by: "probe", verification: o.verification || "checked", signature_status: "unsigned" },
    policy: { sensitivity: "public", allow_background_use: true, requires_review: false, expires_at: o.expiresAt ?? null, reverify_after: null }
  };
}
export function W(store, o) { return admitWriteProposal(mkProposal(o), store).node; }
