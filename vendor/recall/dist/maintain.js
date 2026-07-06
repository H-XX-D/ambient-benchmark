// R9 maintenance pass: a single composed sweep over the four existing
// engines (operator tick, eval, memory health, semantic reindex), run either
// against the routed store or, via maintainAll, against every local graph
// (home plus every registered project) in one call. This is composition
// only: no new engine logic lives here.
//
// Per-leg error capture: each of the four legs runs in its own try/catch. A
// failing leg records `{ error: string }` in that leg's result slot instead
// of the leg's normal shape, and the pass continues to the next leg. A
// maintenance pass must not die halfway: a broken eval suite should not
// prevent the operator tick, health witness, or reindex from running.
import { resolve } from "node:path";
import { analyzeMemory, memoryHealthToProposal } from "./analysis.js";
import { memoryHealthDerivationKey, deriveAdmit } from "./derivation.js";
import { defaultEvalSuite, runEvalAndDerive } from "./evals.js";
import { runOperatorCycle } from "./operator.js";
import { localGraphPaths } from "./routing.js";
import { reindexSemantic } from "./semantic.js";
import { SqliteStore } from "./store.js";
// Runs the fixed engine order (operator -> eval -> health -> reindex) over a
// single store, each leg isolated so one engine's failure cannot prevent the
// others from running. reindexed defaults to 0 when its own leg throws,
// since MaintainResult declares it as a plain number, not an error union
// (the reindex leg has no other structured output to fall back to).
export function maintainStore(store, graph, now) {
    const nowIso = now.toISOString();
    let operator;
    try {
        const cycle = runOperatorCycle(store, nowIso, { derive: true });
        const derivedAccepted = cycle.programs.derived.filter((d) => d.accepted && !d.duplicateOf).length;
        operator = {
            ticked: cycle.ticked,
            programRuns: cycle.programs.runs.length,
            derivedAccepted,
            ledgerId: cycle.ledger?.id,
        };
    }
    catch (error) {
        operator = { error: errorMessage(error) };
    }
    let evalLeg;
    try {
        // Same graph-to-project convention as the health leg below: the eval
        // witness dedups per day per suite per project, so a project graph's
        // witness must not collide with home's.
        const project = graph === "home" ? undefined : graph;
        const { result, derived } = runEvalAndDerive(store, defaultEvalSuite(), now, { project });
        evalLeg = {
            passed: result.passed,
            score: result.score,
            duplicateOf: derived.duplicateOf,
        };
    }
    catch (error) {
        evalLeg = { error: errorMessage(error) };
    }
    let health;
    try {
        const project = graph === "home" ? null : graph;
        const report = analyzeMemory(store, now);
        const proposal = memoryHealthToProposal(report, { project: project ?? undefined });
        const derived = deriveAdmit(store, proposal, memoryHealthDerivationKey(now, project), nowIso);
        health = { accepted: derived.accepted, duplicateOf: derived.duplicateOf };
    }
    catch (error) {
        health = { error: errorMessage(error) };
    }
    let reindexed = 0;
    try {
        reindexed = reindexSemantic(store, { onlyMissing: true });
    }
    catch {
        reindexed = 0;
    }
    return {
        graph,
        dbPath: store.path,
        operator,
        eval: evalLeg,
        health,
        reindexed,
    };
}
// Iterates localGraphPaths (home plus every registered project), deduped by
// resolved path, opening and closing a SqliteStore per graph. A single
// graph's store failing to open no longer aborts the whole call: the open
// itself is wrapped in its own try/catch, distinct from the per-leg error
// capture inside maintainStore (which only covers the four engines once a
// store is already open). On an open failure this pushes a result carrying
// openError and moves on to the next graph, so one corrupt or locked project
// database cannot take down maintenance for every other graph, home
// included, in an unattended sweep.
export function maintainAll(env, now) {
    const graphs = localGraphPaths(env);
    const seen = new Set();
    const results = [];
    for (const { graph, path } of graphs) {
        const resolved = resolve(path);
        if (seen.has(resolved))
            continue;
        seen.add(resolved);
        let store;
        try {
            store = new SqliteStore(path);
        }
        catch (error) {
            results.push({ graph, dbPath: path, openError: errorMessage(error) });
            continue;
        }
        try {
            results.push(maintainStore(store, graph, now));
        }
        finally {
            store.close();
        }
    }
    return results;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
