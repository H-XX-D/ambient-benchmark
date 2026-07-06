// R6 derivation core: deterministic derived-write keys with a duplicate
// short-circuit. The legacy system tracked idempotency in a derivation_index
// side table; MAL instead makes the deterministic hash the CELL KEY itself
// (admission.ts's AdmitContext already accepts key?, and buildCell uses
// opts.key ?? randomUUID()). deriveAdmit probes store.get(key) first: if an
// active cell already sits at that key, the write is a no-op duplicate and
// nothing is touched; otherwise it admits normally, pinning the cell to the
// derived key.
import { createHash } from "node:crypto";
import { admit } from "./admission.js";
// Recursively rebuilds objects with sorted keys so structurally identical
// values serialize identically regardless of property insertion order.
// Arrays are mapped element-wise (order is significant and preserved).
export function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (value !== null && typeof value === "object") {
        const record = value;
        const sorted = {};
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortJson(record[key]);
        }
        return sorted;
    }
    return value;
}
// The legacy hash recipe: sort keys, then stringify with a 2-space indent.
// The indentation is part of the hashed bytes, not a formatting nicety; it
// stays so documented key examples remain reproducible byte-for-byte.
export function stableJson(value) {
    return JSON.stringify(sortJson(value), null, 2);
}
// A clean break from the legacy `<kind>:<hex24>` key format: derivation_index
// rows were never migrated, and a colon in the id is ambiguous once a graph
// prefix (`graph:`) is layered on top under federation. Only the hash recipe
// carries over from legacy; the format (drv_<kind>_<hex24>, no colon) is new.
export function derivationHash(kind, value) {
    const digest = createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
    return `drv_${kind}_${digest}`;
}
// Probes the store at the derived key first. An existing active cell there
// means this exact derivation already landed: return a side-effect-free
// duplicate result (no put, no supersede walk, no semantic indexing). Only
// when the key is unoccupied does the proposal actually admit, pinned to
// that key so the next identical derivation collides with it.
//
// A non-active occupant (superseded or annexed) must never be overwritten:
// store.put is INSERT OR REPLACE, so pinning a new cell to that key would
// silently destroy the historical row and its lineage. In that case admit
// without a key override, so the re-derivation lands under a fresh random
// key instead, mirroring the legacy re-derive-under-a-new-id semantics.
export function deriveAdmit(store, proposal, key, now) {
    const existing = store.get(key);
    if (existing && existing.status === "active") {
        return {
            accepted: true,
            cell: existing,
            duplicateOf: key,
            issues: [],
            warnings: ["derivation key already admitted: " + key],
            attenuations: [],
        };
    }
    if (existing) {
        return admit(proposal, { store, now });
    }
    return admit(proposal, { store, now, key });
}
// id and createdAt are deliberately excluded: two runs of the same program
// with the same programKey and output are the same derivation, so identical
// re-runs (e.g. a watch program tripping the same way twice) collide on the
// same key instead of stacking a new witness cell each time.
export function programRunDerivationKey(run) {
    return derivationHash("program_run", { programKey: run.programKey, output: run.output });
}
// Bucketed by calendar day (UTC, from the ISO date slice), not by report
// content: two health --derive runs on the same day collide on this key even
// if the underlying report changed, so only the first re-derive of the day
// lands a witness cell. This is deliberate legacy cadence semantics, not a
// bug: memory health is a daily pulse, not a per-change witness.
export function memoryHealthDerivationKey(now, project) {
    return derivationHash("memory_health", { bucket: now.toISOString().slice(0, 10), project: project ?? null });
}
// Maps a DAG analysis into deterministically keyed write proposals: one obs
// witness per holonomy witness, an additional rsk concern proposal for
// witnesses at or above the concern threshold, and one rsk proposal per
// detected cycle. Callers run each through deriveAdmit so repeated identical
// analyses collide instead of re-admitting duplicate cells.
export function dagAnalysisToKeyedProposals(analysis, opts = {}) {
    const threshold = opts.concernThreshold ?? 0.5;
    const proposals = [];
    for (const witness of analysis.witnesses) {
        proposals.push({
            key: derivationHash("dag_witness", { overlayId: analysis.overlayId, witness }),
            proposal: witnessProposal(analysis.overlayId, witness, opts),
        });
        if (witness.concern >= threshold) {
            proposals.push({
                key: derivationHash("dag_concern", { overlayId: analysis.overlayId, witness }),
                proposal: concernProposal(analysis.overlayId, witness, opts),
            });
        }
    }
    for (const cycle of analysis.cycles) {
        proposals.push({
            key: derivationHash("dag_cycle", { overlayId: analysis.overlayId, cycle }),
            proposal: cycleProposal(analysis.overlayId, cycle, opts),
        });
    }
    return proposals;
}
function witnessProposal(overlayId, witness, opts) {
    return {
        kind: "obs",
        title: `DAG holonomy: ${witness.from} to ${witness.to} disagrees on ${witness.signatures.length} signature(s)`,
        body: `Path signatures observed: ${witness.signatures.join(", ")}. Path count: ${witness.pathCount}.`,
        confidence: Math.max(0.05, 1 - witness.concern / 2),
        topics: ["dag", "holonomy"],
        sourceRefs: [`recall://dag/${overlayId}`],
        project: opts.project,
        tenant: opts.tenant,
    };
}
function concernProposal(overlayId, witness, opts) {
    return {
        kind: "rsk",
        title: `DAG holonomy concern: ${witness.from} to ${witness.to}`,
        body: `Holonomy witness concern ${witness.concern} at or above threshold between ${witness.from} and ${witness.to}.`,
        confidence: Math.max(0.05, 1 - witness.concern / 2),
        concern: witness.concern,
        topics: ["dag", "holonomy"],
        sourceRefs: [`recall://dag/${overlayId}`],
        edges: [
            { relation: "concerns", target: witness.from },
            { relation: "concerns", target: witness.to },
        ],
        stability: "volatile",
        project: opts.project,
        tenant: opts.tenant,
    };
}
function cycleProposal(overlayId, cycle, opts) {
    return {
        kind: "rsk",
        title: `DAG cycle: ${cycle.join(" -> ")}`,
        body: `Cycle detected among ${cycle.length} node(s): ${cycle.join(" -> ")}.`,
        confidence: 0.95,
        concern: 0.95,
        topics: ["dag", "cycle"],
        sourceRefs: [`recall://dag/${overlayId}`],
        edges: cycle.map((member) => ({ relation: "concerns", target: member })),
        stability: "volatile",
        project: opts.project,
        tenant: opts.tenant,
    };
}
