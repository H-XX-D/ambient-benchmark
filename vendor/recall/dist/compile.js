import { renderMiniIndexLine } from "./render.js";
import { quoteString } from "./address.js";
import { degreeMap, fuseCandidates, TASK_CONTEXT_KIND_FACTOR, } from "./retrieval.js";
import { analyzeMemory } from "./analysis.js";
import { programSpecFromCell } from "./programs.js";
import { cellReferenceView, parseCellReference, previewReferenceValue, resolveCellReference, } from "./references.js";
export function compile(store, query, opts = {}) {
    const limit = opts.limit ?? 10;
    const hits = store.search(query, { limit });
    const lines = hits.map((h) => renderMiniIndexLine(h.cell, { expand: h.cell.flags.requiresReview }));
    return { hits, lines };
}
export function compileContext(store, objective, opts = {}, now = new Date()) {
    const limit = opts.limit ?? 10;
    const budget = Math.max(80, opts.budgetWords ?? 900);
    // Wide candidate pool: fetch 30 hits so fusion has room to reorder.
    const wideHits = store.search(objective, { limit: 30 });
    const allKeys = wideHits.map((h) => h.cell.key);
    const dm = degreeMap(store, allKeys);
    const candidates = wideHits.map((h) => ({
        cell: h.cell,
        bm25: h.score,
        degree: dm.get(h.cell.key) ?? 0,
    }));
    const fusedHits = fuseCandidates(candidates, limit, now, { kindLexicalFactor: TASK_CONTEXT_KIND_FACTOR });
    const stats = store.stats();
    const packet = {
        objective: trimWords(objective, 40),
        compilerState: [
            `retrieval=${stats.lexicalBackend}; query="${trimWords(objective, 24)}"; selected_cells=${fusedHits.length}; budget_words=${budget}`,
            `graph=cells:${stats.cells}, active:${stats.activeCells}, edges:${stats.edges}, indexed:${stats.indexedCells}`,
            "policy=ids-first; use expansion_handles with inspectCell() for exact fields",
        ],
        relevantMemory: [],
        activeBeliefs: [],
        conflicts: [],
        dependencies: [],
        risks: [],
        tasks: [],
        cellState: [],
        standingPrograms: [],
        translatedReferences: [],
        referenceParameters: [],
        staleOrLowTrust: [],
        suggestedNextActions: [],
        expansionHandles: [],
        expansionIndex: [],
        wordCount: 0,
    };
    const seenChallenges = new Set();
    for (const hit of fusedHits) {
        placeHit(packet, hit);
        pushUnique(packet.cellState, cellStateLine(store, hit.cell));
        pushUnique(packet.expansionHandles, hit.cell.key);
        if (opts.includeConflicts !== false) {
            surfaceIncomingChallenges(packet, store, hit.cell, seenChallenges);
        }
        surfaceDependencies(packet, store, hit.cell);
        surfaceStandingPrograms(packet, store, hit.cell);
        surfaceTranslatedReferences(packet, store, hit.cell, {
            inlineReferenceValues: opts.inlineReferenceValues === true,
            includeReferenceParameters: opts.includeReferenceParameters === true,
        });
        // Surface challenged cells (effective < conf * 0.5) as low-trust, in
        // addition to the existing requiresReview / expiry checks.
        surfaceLowTrust(packet, hit.cell, hit.challenged);
        packet.wordCount = countPacketWords(packet);
        if (packet.wordCount >= budget)
            break;
    }
    // Health signals run analyzeMemory ONCE per compile (not per hit). It is
    // O(active pool) and acceptable at the current scale.
    if (opts.includeHealth !== false) {
        surfaceHealth(packet, store, now, seenChallenges, opts.includeNextActions !== false);
    }
    if (opts.includeNextActions !== false && packet.suggestedNextActions.length === 0) {
        packet.suggestedNextActions.push("Expand only the handles needed for exact evidence before writing durable claims.");
    }
    packet.expansionIndex = buildExpansionIndex(store, packet.expansionHandles);
    trimPacket(packet, budget);
    return packet;
}
// Categorized, human-scannable view of expansionHandles: the raw key list
// stays machine-readable while this index carries what each key IS, so a
// reader never has to expand blind. Stable sort keeps ranking order within a
// category.
const EXPANSION_CATEGORY = {
    dec: "decisions",
    bel: "beliefs",
    tsk: "tasks",
    obj: "objectives",
    rsk: "risks",
    obs: "observations",
    ver: "verifications",
    ref: "references",
    hyp: "hypotheses",
    prg: "programs",
};
const EXPANSION_ORDER = ["dec", "bel", "tsk", "obj", "rsk", "obs", "ver", "ref", "hyp", "prg"];
function buildExpansionIndex(store, keys) {
    const rank = (cell) => cell ? EXPANSION_ORDER.indexOf(cell.kind) : EXPANSION_ORDER.length;
    return keys
        .map((key) => ({ key, cell: store.get(key) }))
        .sort((a, b) => rank(a.cell) - rank(b.cell))
        .map(({ key, cell }) => cell
        ? `${EXPANSION_CATEGORY[cell.kind]}: ${cell.handle} ${quoteString(trimWords(cell.title, 12))} [${key}]`
        : key);
}
export function formatContextPacket(packet) {
    return [
        `objective:\n${packet.objective}`,
        section("compiler_state", packet.compilerState),
        section("relevant_memory", packet.relevantMemory),
        section("active_beliefs", packet.activeBeliefs),
        section("conflicts", packet.conflicts),
        section("dependencies", packet.dependencies),
        section("risks", packet.risks),
        section("tasks", packet.tasks),
        section("cell_state", packet.cellState),
        section("standing_programs", packet.standingPrograms),
        section("translated_references", packet.translatedReferences),
        section("reference_parameters", packet.referenceParameters),
        section("stale_or_low_trust", packet.staleOrLowTrust),
        section("suggested_next_actions", packet.suggestedNextActions),
        section("expansion_handles", packet.expansionIndex.length > 0 ? packet.expansionIndex : packet.expansionHandles),
    ].join("\n\n");
}
function placeHit(packet, hit) {
    const line = `${renderMiniIndexLine(hit.cell, { expand: needsExpansion(hit.cell) })} score(${round2(hit.score)}) [${hit.cell.kind}:${hit.cell.key}]`;
    switch (hit.cell.kind) {
        case "bel":
            pushUnique(packet.activeBeliefs, line);
            break;
        case "rsk":
            pushUnique(packet.risks, line);
            break;
        case "tsk":
        case "obj":
            pushUnique(packet.tasks, line);
            break;
        default:
            pushUnique(packet.relevantMemory, line);
            break;
    }
}
function cellStateLine(store, cell) {
    const inCount = store.neighbors(cell.key).filter((link) => link.direction === "in").length;
    const outCount = cell.edgesOut.length;
    const tags = [
        tagsSummary("topics", cell.tags.topics),
        tagsSummary("entities", cell.tags.entities),
        tagsSummary("lifecycle", cell.tags.lifecycle),
        tagsSummary("quality", cell.tags.quality),
        tagsSummary("subject", cell.tags.subject),
    ].filter(Boolean).join("|");
    const policy = [
        cell.policy.sensitivity !== "public" ? `sensitivity:${cell.policy.sensitivity}` : "",
        cell.policy.expiresAt ? `expires:${cell.policy.expiresAt}` : "",
        cell.policy.reverifyAfter ? `reverify:${cell.policy.reverifyAfter}` : "",
        cell.flags.requiresReview ? "review_required" : "",
    ].filter(Boolean).join(",");
    return `${cell.kind}:${cell.key}; handle=${cell.handle}; state=${cell.status}/conf:${round2(cell.scores.conf)}/eff:${round2(cell.scores.effective)}/unc:${round2(cell.scores.uncertainty)}/concern:${round2(cell.scores.concern)}/curr:${round2(cell.scores.currency)}/sal:${round2(cell.scores.salience)}; facets=${tags || "none"}; rel=in:${inCount},out:${outCount}${policy ? `; policy=${policy}` : ""}`;
}
function surfaceIncomingChallenges(packet, store, cell, seen) {
    for (const link of store.neighbors(cell.key)) {
        if (link.direction !== "in")
            continue;
        if (link.edge.relation !== "contradicts" && link.edge.relation !== "concerns")
            continue;
        if (link.cell.status !== "active")
            continue;
        const key = `${link.edge.relation}:${link.cell.key}->${cell.key}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        pushUnique(packet.conflicts, `${trimWords(link.cell.title, 12)} ${link.edge.relation} ${trimWords(cell.title, 12)} [${key}]`);
        pushUnique(packet.expansionHandles, link.cell.key);
    }
}
// depends_on is weight-0 (inert in the mass/score walks), so it never surfaces
// through the challenge path. Surface it here as read-side context: what this
// cell rests on, flagged when a dependency is no longer active (superseded/etc),
// which is the signal that a plan is built on a retracted foundation.
function surfaceDependencies(packet, store, cell) {
    for (const e of cell.edgesOut) {
        if (e.relation !== "depends_on")
            continue;
        const target = store.get(e.target) ?? store.getByHandle(e.target);
        if (!target)
            continue;
        const flag = target.status !== "active" ? ` [${target.status}]` : "";
        pushUnique(packet.dependencies, `${trimWords(cell.title, 12)} depends_on ${trimWords(target.title, 12)}${flag} [depends_on:${cell.key}->${target.key}]`);
        pushUnique(packet.expansionHandles, target.key);
    }
}
// Standing programs (R3): for each program key the cell records in
// cell.programs, resolve the prg cell and, when it carries a valid spec, render
// what it guards. paramsSummary shows the operation's salient tuning knobs.
function surfaceStandingPrograms(packet, store, cell) {
    for (const programKey of cell.programs) {
        const program = store.get(programKey);
        if (!program || program.status !== "active" || program.kind !== "prg")
            continue;
        let spec;
        try {
            spec = programSpecFromCell(program);
        }
        catch {
            spec = undefined;
        }
        if (!spec)
            continue;
        pushUnique(packet.standingPrograms, `${spec.operation}${paramsSummary(spec)} guards "${trimWords(program.title, 8)}" covering ${cell.kind}:${cell.key} [program:${program.handle}]`);
    }
}
function paramsSummary(spec) {
    const params = spec.params ?? {};
    switch (spec.operation) {
        case "watch":
        case "drift":
            return `(delta ${numParam(params.delta, 0.15)})`;
        case "quorum":
            return `(k ${numParam(params.k, 2)}, minEff ${numParam(params.minEff, 0.7)})`;
        case "trend":
            return `(window ${numParam(params.window, 8)}, delta ${numParam(params.delta, 0.1)})`;
        default:
            return "";
    }
}
function numParam(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
// The relation order in which translated references are walked. depends_on
// first, then supports, contradicts, concerns.
const TRANSLATED_RELATION_ORDER = ["depends_on", "supports", "contradicts", "concerns"];
const TRANSLATED_REFERENCE_CAP = 6;
// Translated references (per fused hit): render each outgoing edge (in relation
// order) as a resolved or unresolved reference line, capped at 6 with an
// overflow line; then fold in any sourceRefs that carry a "#" path. With
// includeReferenceParameters, resolved path references also emit a detailed
// reference_parameters line.
function surfaceTranslatedReferences(packet, store, cell, opts) {
    const ordered = [...cell.edgesOut].sort((a, b) => relationRank(a.relation) - relationRank(b.relation));
    const lines = [];
    for (const edge of ordered) {
        if (relationRank(edge.relation) === TRANSLATED_RELATION_ORDER.length)
            continue;
        const target = store.get(edge.target) ?? store.getByHandle(edge.target);
        if (target) {
            lines.push(`${trimWords(cell.title, 12)} ${edge.relation} ${trimWords(target.title, 12)}; handle=${target.handle}`);
            pushUnique(packet.expansionHandles, target.key);
        }
        else {
            lines.push(`${trimWords(cell.title, 12)} ${edge.relation} unresolved reference ${edge.target} [${cell.key}->${edge.target}]`);
        }
    }
    // Fold in any sourceRef that carries a "#" path, resolving via references.ts.
    for (const ref of cell.sourceRefs) {
        if (!ref.includes("#"))
            continue;
        const parsed = parseCellReference(ref);
        const resolved = resolveCellReference(ref, store);
        if (!resolved.cell)
            continue;
        const target = resolved.cell;
        let line = `${trimWords(cell.title, 12)} ref ${trimWords(target.title, 12)}; handle=${target.handle}`;
        if (parsed.path && opts.inlineReferenceValues) {
            const view = cellReferenceView(target, ref);
            line += `; value=${JSON.stringify(previewReferenceValue(view.value))}`;
        }
        lines.push(line);
        pushUnique(packet.expansionHandles, target.key);
        if (opts.includeReferenceParameters && parsed.path) {
            const view = cellReferenceView(target, ref);
            const v = view.value;
            const valueKind = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
            pushUnique(packet.referenceParameters, `${trimWords(cell.title, 12)} ref ${trimWords(target.title, 12)}; handle=${target.key}#${parsed.path}; value_kind=${valueKind}; value=${trimWords(String(JSON.stringify(previewReferenceValue(v))), 28)}; target_state=${target.kind}/${target.status}/conf:${round2(target.scores.conf)}`);
        }
    }
    const capped = lines.slice(0, TRANSLATED_REFERENCE_CAP);
    for (const line of capped)
        pushUnique(packet.translatedReferences, line);
    if (lines.length > TRANSLATED_REFERENCE_CAP) {
        pushUnique(packet.translatedReferences, `${trimWords(cell.title, 12)} has ${lines.length} more references; expand ${cell.key} for the rest`);
    }
}
function relationRank(relation) {
    const idx = TRANSLATED_RELATION_ORDER.indexOf(relation);
    return idx === -1 ? TRANSLATED_RELATION_ORDER.length : idx;
}
// Health signals: run analyzeMemory once and merge its top findings into the
// existing packet sections. Contradictions dedup against the same challenge-key
// set surfaceIncomingChallenges uses, so a health-sourced conflict never
// duplicates one already surfaced from the graph walk.
function surfaceHealth(packet, store, now, seenChallenges, includeNextActions) {
    const report = analyzeMemory(store, now);
    const pressured = report.beliefs.filter((b) => b.recommendation !== "trust").length;
    packet.compilerState.push(`health=beliefs:${pressured}, contradictions:${report.contradictions.length}, stale:${report.stale.length}, warnings:${report.criticalWarnings.length}`);
    for (const belief of report.beliefs.filter((b) => b.recommendation !== "trust").slice(0, 6)) {
        pushUnique(packet.activeBeliefs, `${trimWords(belief.title, 12)}: recommendation=${belief.recommendation}, confidence=${belief.conf}, contradiction=${belief.contradiction} [bel:${belief.key}]`);
    }
    for (const contradiction of report.contradictions.slice(0, 6)) {
        const key = `${contradiction.relation}:${contradiction.sourceKey}->${contradiction.targetKey}`;
        if (seenChallenges.has(key))
            continue;
        seenChallenges.add(key);
        pushUnique(packet.conflicts, `${trimWords(contradiction.sourceTitle, 12)} ${contradiction.relation} ${trimWords(contradiction.targetTitle, 12)} [${key}]`);
    }
    for (const finding of report.stale.slice(0, 6)) {
        pushUnique(packet.staleOrLowTrust, `${trimWords(finding.title, 12)}: ${finding.reason}; severity=${finding.severity} [stale:${finding.key}]`);
    }
    if (includeNextActions) {
        for (const action of report.nextActions.slice(0, 4)) {
            pushUnique(packet.suggestedNextActions, action);
        }
    }
}
function surfaceLowTrust(packet, cell, challenged) {
    const effectiveCollapsed = challenged ?? cell.scores.effective < cell.scores.conf * 0.5;
    if (!needsExpansion(cell) && !effectiveCollapsed)
        return;
    const reasons = [
        cell.flags.requiresReview ? "requires_review" : "",
        effectiveCollapsed ? "effective_confidence_collapsed" : "",
        cell.policy.reverifyAfter ? `reverify_after:${cell.policy.reverifyAfter}` : "",
        cell.policy.expiresAt ? `expires_at:${cell.policy.expiresAt}` : "",
    ].filter(Boolean);
    pushUnique(packet.staleOrLowTrust, `${cell.handle}: ${reasons.join(",")} [${cell.kind}:${cell.key}]`);
}
function needsExpansion(cell) {
    return cell.flags.requiresReview || Boolean(cell.policy.reverifyAfter || cell.policy.expiresAt);
}
// Hints teach the writer what kind of cell or edge fills a section that came
// back empty; sections without a hint keep the bare "- none".
const SECTION_HINTS = {
    active_beliefs: "populated by bel cells",
    conflicts: "populated by contradicts edges",
    dependencies: "populated by depends_on edges",
    risks: "populated by rsk cells",
    tasks: "populated by tsk cells",
};
function section(name, lines) {
    if (lines.length === 0) {
        const hint = SECTION_HINTS[name];
        return `${name}:\n- none${hint ? ` (${hint})` : ""}`;
    }
    return `${name}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
function tagsSummary(label, values) {
    if (!values || values.length === 0)
        return "";
    return `${label}:${values.slice(0, 2).join(",")}`;
}
function pushUnique(lines, line) {
    if (!lines.includes(line))
        lines.push(line);
}
function trimPacket(packet, budget) {
    // Trim order is load-bearing (legacy-verified): referenceParameters pops
    // FIRST; conflicts is absent so it survives longest; standingPrograms is
    // deliberately absent and is NEVER popped.
    const sections = [
        "referenceParameters",
        "cellState",
        "translatedReferences",
        "relevantMemory",
        "activeBeliefs",
        "tasks",
        "risks",
        "dependencies",
        "staleOrLowTrust",
        "suggestedNextActions",
        "expansionIndex",
    ];
    while (countPacketWords(packet) > budget) {
        const key = sections.find((name) => packet[name].length > 1);
        if (!key)
            break;
        packet[key].pop();
    }
    packet.wordCount = countPacketWords(packet);
}
function countPacketWords(packet) {
    return [
        packet.objective,
        ...packet.compilerState,
        ...packet.relevantMemory,
        ...packet.activeBeliefs,
        ...packet.conflicts,
        ...packet.dependencies,
        ...packet.risks,
        ...packet.tasks,
        ...packet.cellState,
        ...packet.standingPrograms,
        ...packet.translatedReferences,
        ...packet.referenceParameters,
        ...packet.staleOrLowTrust,
        ...packet.suggestedNextActions,
        ...(packet.expansionIndex.length > 0 ? packet.expansionIndex : packet.expansionHandles),
    ].reduce((sum, line) => sum + countWords(line), 0);
}
function countWords(value) {
    return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}
function trimWords(value, maxWords) {
    const words = value.trim().split(/\s+/).filter(Boolean);
    if (words.length <= maxWords)
        return value.trim();
    return `${words.slice(0, maxWords).join(" ")}...`;
}
function round2(value) {
    return Math.round(value * 100) / 100;
}
