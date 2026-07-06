import { programSpecFromCell, selectProgramMembers } from "./programs.js";
const ATTENUATION_WARNING = "unsupported high confidence was attenuated";
const MAX_CANDIDATES = 3;
const RECURRING_TOPIC_MIN = 5;
const TASK_POOL_MIN = 4;
const VALUE_SERIES_MIN = 3;
const MAX_SUGGESTIONS = 2;
const KIND_HINTS = [
    {
        kinds: ["obs", "dec"],
        re: /\b(todo|need(s)? to|should (add|fix|update|make|write)|next step|remaining work)\b/i,
        hint: "this reads like an open action; kind tsk would surface it in the compile tasks section",
    },
    {
        kinds: ["obs", "dec"],
        re: /\b(probably|likely|seems|appears|i think|we believe|hypothes)/i,
        hint: "this reads like a claim to confirm or refute later; kind bel (or hyp) lets support and contradiction act on it",
    },
    {
        kinds: ["obs", "dec"],
        re: /\b(risk|danger|fragile|could break|may fail|single point of failure)\b/i,
        hint: "this reads like a hazard; kind rsk would surface it in the compile risks section",
    },
];
export function buildWriteGuidance(store, cell, admission, opts = {}) {
    return {
        candidateEdges: candidateEdges(store, cell, opts.maxCandidates ?? MAX_CANDIDATES),
        matchingPrograms: matchingPrograms(store, cell),
        kindHint: kindHint(cell),
        evidenceHint: admission.warnings.includes(ATTENUATION_WARNING)
            ? "confidence was capped at 0.7; supply verification (checked, tested, external), sourceRefs, or a weighted supports edge to keep higher confidence"
            : undefined,
        programSuggestions: opts.suggestPrograms !== false ? programSuggestions(store, cell) : [],
    };
}
// Existing standing programs whose target already selects the new cell: the
// writer learns what will watch this cell without naming anything, and can
// attach explicitly (proposal.programs) when the match should be durable.
const MAX_MATCHING_PROGRAMS = 5;
function matchingPrograms(store, cell) {
    const out = [];
    for (const prg of store.active()) {
        if (prg.kind !== "prg" || cell.programs.includes(prg.key))
            continue;
        try {
            const spec = programSpecFromCell(prg);
            if (!spec)
                continue;
            if (selectProgramMembers(store, prg, spec).some((m) => m.key === cell.key)) {
                out.push({ key: prg.key, handle: prg.handle, title: prg.title, operation: spec.operation });
                if (out.length >= MAX_MATCHING_PROGRAMS)
                    break;
            }
        }
        catch {
            // A malformed spec must never break the write path; operate reports it.
        }
    }
    return out;
}
function candidateEdges(store, cell, max) {
    const query = [cell.title, ...(cell.tags.topics ?? [])].join(" ").trim();
    if (query.length === 0)
        return [];
    const linked = new Set(cell.edgesOut.map((e) => e.target));
    const out = [];
    for (const hit of store.search(query, { limit: max * 4 })) {
        const target = hit.cell;
        if (target.key === cell.key || target.status !== "active" || target.kind === "prg")
            continue;
        if (linked.has(target.key) || linked.has(target.handle))
            continue;
        out.push({
            target: target.key,
            handle: target.handle,
            title: target.title,
            kind: target.kind,
            ...suggestRelation(cell, target),
            score: hit.score,
        });
        if (out.length >= max)
            break;
    }
    return out;
}
function suggestRelation(cell, target) {
    if (target.kind === cell.kind && nearIdenticalTitle(cell.title, target.title)) {
        return { relation: "supersedes", reason: "same kind with a near-identical title; if this replaces it, a supersedes edge preserves the lineage" };
    }
    if (target.kind === "bel" || target.kind === "hyp") {
        return { relation: "supports", reason: "evidence for this claim raises its effective confidence (use contradicts instead if it disputes it)" };
    }
    if (cell.kind === "tsk" && (target.kind === "obj" || target.kind === "tsk")) {
        return { relation: "depends_on", reason: "linking open work to what it serves populates the compile dependencies section" };
    }
    return { relation: "supports", reason: "related active cell; a supports edge records why they belong together" };
}
function nearIdenticalTitle(a, b) {
    const na = a.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const nb = b.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
    if (na.length === 0 || nb.length === 0)
        return false;
    return na === nb || na.includes(nb) || nb.includes(na);
}
function kindHint(cell) {
    const text = `${cell.title} ${cell.body}`;
    for (const rule of KIND_HINTS) {
        if (rule.kinds.includes(cell.kind) && rule.re.test(text))
            return rule.hint;
    }
    return undefined;
}
function programSuggestions(store, cell) {
    const active = store.active();
    const existing = activeProgramSpecs(active);
    const out = [];
    for (const topic of cell.tags.topics ?? []) {
        if (out.length >= MAX_SUGGESTIONS)
            break;
        const sharing = active.filter((c) => c.kind !== "prg" && (c.tags.topics ?? []).includes(topic));
        const openTasks = sharing.filter((c) => c.kind === "tsk");
        const valued = sharing.filter((c) => typeof c.value === "number" && Number.isFinite(c.value));
        if (openTasks.length >= TASK_POOL_MIN && !covered(existing, "allocate", topic)) {
            out.push(suggestion("allocate", topic, `${openTasks.length} open tasks share topic "${topic}"; an allocate program ranks them by pressure on every operator pass`, { topics: [topic], kinds: ["tsk"] }));
        }
        else if (typeof cell.value === "number" && Number.isFinite(cell.value) &&
            valued.length >= VALUE_SERIES_MIN && !covered(existing, "trend", topic)) {
            // The writer is recording a numeric reading onto a topic that already
            // accumulates them: a trend program flags a sustained rise or fall in the
            // measured value over operator passes (distinct from watch's single-step
            // move on effective confidence).
            out.push(suggestion("trend", topic, `${valued.length} cells on topic "${topic}" carry a numeric value; a trend program flags a sustained rise or fall in that value across operator passes`, { topics: [topic] }, { measure: "value" }));
        }
        else if (sharing.length >= RECURRING_TOPIC_MIN && !covered(existing, "watch", topic)) {
            out.push(suggestion("watch", topic, `${sharing.length} active cells share topic "${topic}"; a watch program trips when their average effective confidence moves`, { topics: [topic] }));
        }
    }
    for (const edge of cell.edgesOut) {
        if (out.length >= MAX_SUGGESTIONS)
            break;
        if (edge.relation !== "contradicts")
            continue;
        const target = store.get(edge.target) ?? store.getByHandle(edge.target);
        if (!target || (target.kind !== "bel" && target.kind !== "hyp"))
            continue;
        if (existing.some((s) => s.operation === "quorum" && (s.target?.keys ?? []).includes(target.key)))
            continue;
        out.push(suggestion("quorum", target.handle, `"${target.title}" is now contested; a quorum program requires distinct actors to agree before treating it as settled`, { keys: [target.key] }));
    }
    return out.slice(0, MAX_SUGGESTIONS);
}
function activeProgramSpecs(active) {
    // Admission validates props but not the spec inside it, so a prg cell may
    // carry a null or malformed program; anything but an object covers nothing.
    return active
        .filter((c) => c.kind === "prg" && typeof c.props.program === "object" && c.props.program !== null)
        .map((c) => c.props.program);
}
function covered(existing, operation, topic) {
    return existing.some((s) => s.operation === operation && (s.target?.topics ?? []).includes(topic));
}
function suggestion(operation, label, reason, target, params) {
    return {
        operation,
        reason,
        proposal: {
            kind: "prg",
            title: `${operation} program: ${label}`,
            body: reason,
            confidence: 0.6,
            topics: ["recall-programs"],
            props: {
                program: {
                    schemaVersion: "recall.program.v1",
                    operation,
                    target,
                    ...(params ? { params } : {}),
                },
            },
        },
    };
}
