// The operator: the between-turn deterministic tick (HAL's "thread"). No LLM.
// Each tick decays currency from the anchor (updatedAt, not the last tick, so it
// never compounds) and recomputes effective from current neighbor masses. Pinned
// cells are exempt from currency decay. Computed from a pre-tick snapshot of
// neighbor effectives, then written, so a tick is order-independent.
import { randomUUID } from "node:crypto";
import { currency, effectiveConfidence, salienceDecay } from "./scores.js";
import { neighborMass } from "./mass.js";
import { runStandingPrograms } from "./programs.js";
const TAU_DAYS = {
    stable: 3650,
    volatile: 30,
    ephemeral: 7,
};
const DAY_MS = 86_400_000;
function recompute(store, cell, now) {
    const scores = { ...cell.scores };
    if (!cell.flags.pinned) {
        const dt = Math.max(0, (Date.parse(now) - Date.parse(cell.updatedAt)) / DAY_MS);
        scores.currency = currency({
            c0: cell.scores.currencyC0,
            dt,
            tau: TAU_DAYS[cell.stability],
            cFloor: 0.1,
        });
        // Salience leaks from its own anchor (last retrieval, else updatedAt), so
        // attention fades on idle without touching the currency/freshness anchor.
        const dtSal = Math.max(0, (Date.parse(now) - Date.parse(cell.lastSalientAt ?? cell.updatedAt)) / DAY_MS);
        scores.salience = salienceDecay({ seed: cell.scores.salienceSeed, dt: dtSal });
    }
    const m = neighborMass(store, cell.key);
    scores.effective = effectiveConfidence({
        stated: cell.scores.conf,
        calibration: cell.scores.actorCalibration,
        supportMass: m.supportMass,
        challengeMass: m.challengeMass,
    });
    return { ...cell, scores }; // updatedAt preserved: a tick is not a reinforcement
}
// Tick a single cell (currency decay + effective recompute).
export function tickCell(store, key, now) {
    const cell = store.get(key);
    if (cell)
        store.put(recompute(store, cell, now));
}
// Tick every active cell from a pre-tick snapshot. Returns the count ticked.
export function tick(store, now) {
    const cells = store.active();
    const updated = cells.map((c) => recompute(store, c, now)); // reads pre-tick state
    for (const u of updated)
        store.put(u);
    return updated.length;
}
// Run one deterministic operator cycle: tick active cell scores, then run
// standing `prg` cells. Derived program witnesses re-enter through admission.
export function runOperatorCycle(store, now, opts = {}) {
    const before = store.stats();
    const ticked = tick(store, now);
    const programsEnabled = opts.programs ?? true;
    const programs = programsEnabled ? runStandingPrograms(store, now, { derive: opts.derive }) : { runs: [], derived: [] };
    const after = store.stats();
    // A duplicate re-derivation still has accepted true (it short-circuited onto
    // the existing cell), so derivedAccepted counts non-duplicate accepted results
    // only: accepted && !duplicateOf. Otherwise the count would double-report
    // witnesses that were already recorded on an earlier cycle.
    const derivedAccepted = programs.derived.filter((d) => d.accepted && !d.duplicateOf).length;
    const result = {
        status: "ran",
        createdAt: now,
        ticked,
        programs: {
            enabled: programsEnabled,
            runs: programs.runs,
            derived: programs.derived,
        },
        stats: {
            before,
            after,
        },
    };
    if ("recordOperatorRun" in store) {
        const run = store.recordOperatorRun({
            id: randomUUID(),
            status: "ran",
            summary: `ticked ${ticked}; programs ${programs.runs.length}; derived ${derivedAccepted}`,
            result: { ticked, programRuns: programs.runs.length, derivedAccepted, stats: after },
            createdAt: now,
        });
        result.ledger = { id: run.id };
    }
    return result;
}
