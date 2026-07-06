const DEFAULT_LIMIT = 50;
// true when the filter carries at least one app-side tag family. When any of
// these are present, a SQL LIMIT applied before tag filtering could under-fill
// the result (rows within the SQL LIMIT window might not pass the tag check),
// so the limit must be applied only after all app-side filtering completes.
function hasTagFamilies(filter) {
    return ((filter.topics?.length ?? 0) > 0 ||
        (filter.entities?.length ?? 0) > 0 ||
        (filter.lifecycle?.length ?? 0) > 0 ||
        (filter.quality?.length ?? 0) > 0 ||
        (filter.subject?.length ?? 0) > 0);
}
// Every listed value in an array family must be present on the cell (AND
// within the family), matching legacy conjunction semantics. undefined/empty
// filter values are a no-op (not a constraint).
function matchesAll(have, want) {
    if (want === undefined || want.length === 0)
        return true;
    if (have === undefined || have.length === 0)
        return false;
    const haveSet = new Set(have);
    return want.every((v) => haveSet.has(v));
}
function matchesTagFamilies(cell, filter) {
    return (matchesAll(cell.tags.topics, filter.topics) &&
        matchesAll(cell.tags.entities, filter.entities) &&
        matchesAll(cell.tags.lifecycle, filter.lifecycle) &&
        matchesAll(cell.tags.quality, filter.quality) &&
        matchesAll(cell.tags.subject, filter.subject));
}
// Newest updatedAt first; ties break on key ascending so this matches
// SqliteStore.activeWhere's `ORDER BY updated_at DESC, key ASC` exactly,
// keeping the SQL fast path and the app-side fallback path in agreement.
function sortNewestFirst(cells) {
    return [...cells].sort((a, b) => {
        const byDate = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (byDate !== 0)
            return byDate;
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
}
// AND across families: kinds, project, since (all push-down-eligible) AND
// topics/entities/lifecycle/quality/subject (app-side tag families), every
// provided value in every family must match. Sorts updatedAt descending,
// slices to limit ?? 50. Uses activeWhere when the store supports it (the
// SqliteStore fast path), else filters store.active() app-side; both paths
// must produce identical results.
export function subgraphCells(store, filter) {
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const tagged = hasTagFamilies(filter);
    let candidates;
    if ("activeWhere" in store) {
        // Push LIMIT into SQL only when there are no tag families to apply
        // afterward; otherwise a SQL LIMIT would cut the candidate set before
        // app-side tag filtering runs and could under-fill the final result.
        candidates = store.activeWhere({
            kinds: filter.kinds,
            project: filter.project,
            since: filter.since,
            limit: tagged ? undefined : limit,
        });
    }
    else {
        candidates = store.active().filter((c) => {
            if (filter.kinds !== undefined && filter.kinds.length > 0 && !filter.kinds.includes(c.kind)) {
                return false;
            }
            if (filter.project !== undefined && c.scope.project !== filter.project)
                return false;
            if (filter.since !== undefined && Date.parse(c.updatedAt) < Date.parse(filter.since)) {
                return false;
            }
            return true;
        });
        candidates = sortNewestFirst(candidates);
    }
    const filtered = tagged ? candidates.filter((c) => matchesTagFamilies(c, filter)) : candidates;
    const ordered = tagged ? sortNewestFirst(filtered) : filtered;
    return ordered.slice(0, limit);
}
