import { randomUUID } from "node:crypto";
export function analyzeDagOverlay(overlay) {
    const nodes = new Set(overlay.nodeIds);
    for (const edge of overlay.edges) {
        nodes.add(edge.source);
        nodes.add(edge.target);
    }
    const outgoing = new Map();
    const incomingCount = new Map();
    for (const node of nodes) {
        outgoing.set(node, []);
        incomingCount.set(node, 0);
    }
    for (const edge of overlay.edges) {
        outgoing.get(edge.source).push(edge);
        incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    }
    // Kahn's algorithm with a sorted ready queue: the order in which zero
    // in-degree nodes become ready is not otherwise deterministic, so the
    // queue is re-sorted on every push to keep topologicalOrder stable.
    const queue = [...nodes].filter((node) => (incomingCount.get(node) ?? 0) === 0).sort();
    const topologicalOrder = [];
    while (queue.length > 0) {
        const node = queue.shift();
        topologicalOrder.push(node);
        for (const edge of outgoing.get(node) ?? []) {
            const next = (incomingCount.get(edge.target) ?? 0) - 1;
            incomingCount.set(edge.target, next);
            if (next === 0) {
                queue.push(edge.target);
                queue.sort();
            }
        }
    }
    const isDag = topologicalOrder.length === nodes.size;
    return {
        overlayId: overlay.id,
        isDag,
        topologicalOrder: isDag ? topologicalOrder : [],
        cycles: isDag ? [] : findCycles([...nodes], outgoing),
        witnesses: isDag ? holonomyWitnesses([...nodes], outgoing) : [],
    };
}
function holonomyWitnesses(nodes, outgoing) {
    const witnesses = [];
    for (const from of nodes) {
        const paths = collectPaths(from, outgoing, 6);
        const grouped = new Map();
        for (const path of paths) {
            if (path.nodes.length < 2) {
                continue;
            }
            const to = path.nodes[path.nodes.length - 1];
            const key = `${from}->${to}`;
            const values = grouped.get(key) ?? [];
            values.push(path.labels.join("/"));
            grouped.set(key, values);
        }
        for (const [key, signatures] of grouped) {
            const unique = [...new Set(signatures)];
            if (signatures.length > 1 && unique.length > 1) {
                const [, to] = key.split("->");
                witnesses.push({
                    from,
                    to: to,
                    pathCount: signatures.length,
                    signatures: unique.sort(),
                    concern: Math.min(1, unique.length / Math.max(2, signatures.length)),
                });
            }
        }
    }
    return witnesses.sort((a, b) => b.concern - a.concern);
}
function collectPaths(start, outgoing, maxDepth) {
    const results = [];
    const visit = (node, nodes, labels) => {
        results.push({ nodes, labels });
        if (labels.length >= maxDepth) {
            return;
        }
        for (const edge of outgoing.get(node) ?? []) {
            if (nodes.includes(edge.target)) {
                continue;
            }
            visit(edge.target, [...nodes, edge.target], [...labels, edge.label ?? "edge"]);
        }
    };
    visit(start, [start], []);
    return results;
}
function findCycles(nodes, outgoing) {
    const cycles = [];
    const stack = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (node) => {
        if (visiting.has(node)) {
            const index = stack.indexOf(node);
            cycles.push(stack.slice(index).concat(node));
            return;
        }
        if (visited.has(node)) {
            return;
        }
        visiting.add(node);
        stack.push(node);
        for (const edge of outgoing.get(node) ?? []) {
            visit(edge.target);
        }
        stack.pop();
        visiting.delete(node);
        visited.add(node);
    };
    for (const node of nodes) {
        visit(node);
    }
    return cycles;
}
// Builds and persists a DagOverlay from a thin input. Every nodeId and edge
// endpoint is resolved against the store (by key, falling back to handle) so
// an overlay can never point at a cell that does not exist; the first
// unresolved reference is named in the thrown error to make the bad
// reference easy to find. A cyclic candidate overlay is rejected at insert
// (legacy behavior): analyzeDagOverlay runs first and, when the candidate is
// not a DAG, the cycles are listed in the thrown message.
export function addDagOverlay(store, input, now) {
    const resolve = (ref) => {
        const cell = store.get(ref) ?? store.getByHandle(ref);
        if (!cell)
            throw new Error(`dag overlay reference not found: ${ref}`);
        return cell.key;
    };
    const nodeIds = input.nodeIds.map(resolve);
    const edges = input.edges.map((edge) => ({
        ...edge,
        source: resolve(edge.source),
        target: resolve(edge.target),
    }));
    const candidate = {
        id: input.id ?? randomUUID(),
        title: input.title,
        nodeIds,
        edges,
        metadata: input.metadata ?? {},
        createdAt: input.createdAt ?? now ?? new Date().toISOString(),
    };
    const analysis = analyzeDagOverlay(candidate);
    if (!analysis.isDag) {
        const cycles = analysis.cycles.map((cycle) => cycle.join(" -> ")).join("; ");
        throw new Error(`dag overlay is cyclic: ${cycles}`);
    }
    store.putDagOverlay(candidate);
    return candidate;
}
