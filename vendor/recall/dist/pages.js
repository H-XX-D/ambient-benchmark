// MAL kind remap per page (reviewed correctness points from task brief):
//   reflections   -> ['ref']
//   objectives    -> ['obj', 'tsk', 'rsk']
//   workbench     -> ['hyp', 'bel', 'rsk']
//   witnesses     -> ['obs']               (all obs; lifecycle gate lives on handoffs)
//   handoffs      -> ['obs'] gated on tags.lifecycle includes 'handoff'|'session'
//   team-metrics  -> ['ver', 'bel']
//   agent-profile -> ['bel'] gated on tags.entities non-empty
//   user-profile  -> ['bel'] gated on tags.entities non-empty
const KIND_MAP = {
    reflections: ["ref"],
    objectives: ["obj", "tsk", "rsk"],
    workbench: ["hyp", "bel", "rsk"],
    witnesses: ["obs"],
    handoffs: ["obs"],
    "team-metrics": ["ver", "bel"],
    "agent-profile": ["bel"],
    "user-profile": ["bel"],
};
// topCounts: count by a string key extracted from each item, return sorted descending.
export function topCounts(items, key, limit = 10) {
    const tally = {};
    for (const item of items) {
        const k = key(item);
        tally[k] = (tally[k] ?? 0) + 1;
    }
    return Object.entries(tally)
        .sort(([, a], [, b]) => b - a)
        .slice(0, limit)
        .map(([value, count]) => ({ value, count }));
}
function kindCount(cells) {
    const result = {};
    for (const cell of cells) {
        result[cell.kind] = (result[cell.kind] ?? 0) + 1;
    }
    return result;
}
// Apply PageFilter to a flat list of active cells (all filtering is app-side).
// since filters on updatedAt (last-modified), NOT createdAt.
function applyFilter(cells, filter) {
    const sinceMs = filter.since ? Date.parse(filter.since) : Number.NaN;
    let out = cells.filter((c) => {
        if (filter.project !== undefined && c.scope.project !== filter.project) {
            return false;
        }
        if (filter.topics !== undefined && filter.topics.length > 0) {
            const hasTopic = filter.topics.some((t) => c.tags.topics.includes(t));
            if (!hasTopic)
                return false;
        }
        if (!Number.isNaN(sinceMs) && Date.parse(c.updatedAt) < sinceMs) {
            return false;
        }
        return true;
    });
    // Sort newest updatedAt first.
    out = out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (filter.limit !== undefined)
        out = out.slice(0, filter.limit);
    return out;
}
// Select cells for a named page applying the kind remap and any page-specific gates.
function selectPage(name, cells) {
    const kinds = KIND_MAP[name];
    const kindSet = new Set(kinds);
    return cells.filter((c) => {
        if (!kindSet.has(c.kind))
            return false;
        switch (name) {
            case "handoffs":
                // Gate: obs with lifecycle containing 'handoff' or 'session'.
                return (Array.isArray(c.tags.lifecycle) &&
                    c.tags.lifecycle.some((l) => l === "handoff" || l === "session"));
            case "agent-profile":
            case "user-profile":
                // Gate: bel cells that have at least one entity tag.
                return c.tags.entities.length > 0;
            default:
                return true;
        }
    });
}
export function buildPageIndex(store, now = new Date()) {
    const cells = store.active();
    const kc = kindCount(cells);
    const topProjects = topCounts(cells, (c) => c.scope.project)
        .map(({ value, count }) => ({ project: value, count }));
    const topTopics = topCounts(cells.flatMap((c) => c.tags.topics), (t) => t)
        .map(({ value, count }) => ({ topic: value, count }));
    return {
        createdAt: now.toISOString(),
        stats: store.stats(),
        kindCounts: kc,
        topProjects,
        topTopics,
        plannerHint: "",
    };
}
export function getRecallPage(name, store, filter = {}, now = new Date()) {
    if (name === "index") {
        const idx = buildPageIndex(store, now);
        return {
            name,
            createdAt: now.toISOString(),
            filter,
            summary: `Recall page index. ${idx.stats.activeCells} active cells.`,
            cells: [],
        };
    }
    // When filter.project is set and the store supports the push-down, seed
    // the pool from activeByProject instead of store.active(): SQL narrows to
    // that project's active cells (newest-updated first) before the kind
    // remap and topics filtering run app-side. LIMIT stays app-side (passed
    // through applyFilter below) because it must apply after selectPage/topics
    // narrow the pool further, or it would under-fill.
    const active = filter.project !== undefined && "activeByProject" in store
        ? store.activeByProject(filter.project, { since: filter.since })
        : store.active();
    const selected = selectPage(name, active);
    const filtered = applyFilter(selected, filter);
    return {
        name,
        createdAt: now.toISOString(),
        filter,
        summary: pageSummary(name, filtered),
        cells: filtered,
    };
}
function pageSummary(name, cells) {
    switch (name) {
        case "reflections":
            return `${cells.length} reflection cell(s).`;
        case "objectives":
            return `${cells.length} objective/task/risk cell(s) for operational continuity.`;
        case "workbench":
            return `${cells.length} epistemic workbench cell(s) (hypotheses, beliefs, risks).`;
        case "witnesses":
            return `${cells.length} observation/witness cell(s).`;
        case "handoffs":
            return `${cells.length} handoff/session cell(s) gated on lifecycle.`;
        case "team-metrics":
            return `${cells.length} verification/belief cell(s) for team metrics.`;
        case "agent-profile":
            return `${cells.length} agent-identity belief cell(s).`;
        case "user-profile":
            return `${cells.length} user-identity belief cell(s).`;
        default:
            return `${cells.length} cell(s).`;
    }
}
