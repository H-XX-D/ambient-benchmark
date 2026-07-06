const SERIES_LIMIT = 1000;
export function valueSeries(store, target, opts = {}) {
    const cells = opts.topic ? topicReadings(store, target) : lineageReadings(store, target);
    const ordered = cells
        .filter((c) => typeof c.value === "number" && Number.isFinite(c.value))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-(opts.limit ?? SERIES_LIMIT));
    return ordered.map((cell, i) => ({
        at: cell.createdAt,
        value: cell.value,
        delta: i === 0 ? null : round6(cell.value - ordered[i - 1].value),
        key: cell.key,
        title: cell.title,
    }));
}
// The active head plus every ancestor reachable through lineage chains.
function lineageReadings(store, target) {
    const head = store.get(target) ?? store.getByHandle(target);
    if (!head)
        return [];
    const seen = new Map();
    const queue = [head];
    while (queue.length > 0) {
        const cell = queue.pop();
        if (seen.has(cell.key))
            continue;
        seen.set(cell.key, cell);
        for (const ancestor of cell.lineage) {
            const prior = store.get(ancestor);
            if (prior && !seen.has(prior.key))
                queue.push(prior);
        }
    }
    return [...seen.values()];
}
// Every reading (any status: superseded readings are history, not noise)
// tagged with the topic.
function topicReadings(store, topic) {
    return store.all().filter((c) => (c.tags.topics ?? []).includes(topic));
}
export function renderDeltasCsv(rows) {
    const header = "timestamp,value,delta,key,title";
    const lines = rows.map((r) => [r.at, String(r.value), r.delta === null ? "" : String(r.delta), r.key, csvEscape(r.title)].join(","));
    return [header, ...lines].join("\n") + "\n";
}
function csvEscape(value) {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}
