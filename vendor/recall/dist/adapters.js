// R6 adapters/import-export. External memories normalize to thin v5
// WriteProposals and enter through admission; portable archives preserve exact
// Cell JSON for backup/restore without inventing a second database format.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { admit } from "./admission.js";
import { contentKey } from "./store.js";
export const EXPORT_SCHEMA_VERSION = "recall.cells.export.v1";
export const EXPORT_SCHEMA_VERSION_V2 = "recall.cells.export.v2";
export const MAX_IMPORT_BYTES = 134_217_728;
export const MAX_BODY_CHARS = 32_768;
export const MAX_PRIOR_VERSIONS = 1000;
// Explicit large limit for the bounded listers (listHyperedges, listDagOverlays,
// listProgramRuns, listEvalRuns, listOperatorRuns), so a full archive export
// is not silently truncated to each lister's small default page size.
export const ARCHIVE_LIST_LIMIT = 1_000_000;
export function readJsonFile(file, label = "json", maxBytes = MAX_IMPORT_BYTES) {
    let size;
    try {
        size = statSync(file).size;
    }
    catch {
        throw new Error(`${label}: cannot read file: ${file}`);
    }
    if (size > maxBytes) {
        throw new Error(`${label}: file too large (${size} bytes > ${maxBytes})`);
    }
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        throw new Error(`${label}: file is not valid JSON: ${file}`);
    }
}
export function clampBody(text) {
    return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}
export function importCellKey(fingerprint) {
    return `drv_import_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
}
export function importItems(store, source, items, opts = {}) {
    const apply = opts.apply ?? false;
    const now = opts.now ?? new Date().toISOString();
    const result = [];
    const admittedThisBatch = new Map();
    const fingerprintsThisBatch = new Set();
    let created = 0;
    let superseded = 0;
    let skipped = 0;
    const byFingerprint = new Map();
    const byEntity = new Map();
    for (const cell of store.all()) {
        const fingerprint = stringValue(toRecord(cell.props.import).fingerprint);
        if (fingerprint)
            byFingerprint.set(fingerprint, cell);
        if (cell.status === "active") {
            for (const entity of cell.tags.entities) {
                const bucket = byEntity.get(entity);
                if (bucket)
                    bucket.push(cell);
                else
                    byEntity.set(entity, [cell]);
            }
        }
    }
    for (const item of items) {
        const key = importCellKey(item.fingerprint);
        if (fingerprintsThisBatch.has(item.fingerprint) || store.get(key) || byFingerprint.get(item.fingerprint)) {
            skipped += 1;
            result.push({ ref: item.ref, action: "skip", reason: "unchanged" });
            continue;
        }
        const priorTags = [item.sourceTag, ...(item.supersedesTags ?? [])];
        const priorKeys = unique([
            ...priorTags.flatMap((tag) => (byEntity.get(tag) ?? []).map((cell) => cell.key)),
            ...(item.supersedesTags ?? []).flatMap((tag) => admittedThisBatch.get(tag) ?? []),
        ]).slice(0, MAX_PRIOR_VERSIONS);
        const proposal = item.proposal(priorKeys);
        const predicted = admit(proposal, { now });
        if (!predicted.accepted) {
            skipped += 1;
            result.push({
                ref: item.ref,
                action: "skip",
                reason: `rejected: ${predicted.issues[0]?.message ?? "admission"}`,
            });
            continue;
        }
        if (!apply) {
            // Predict admission's content dedup without giving admit a store: a
            // storeless admit call would let the placeholder `dry-run:<ref>`
            // supersede targets reach store-aware edge resolution, which must
            // never happen in dry-run. Probe findByContentKey directly instead.
            const kind = proposal.kind;
            const dupCandidate = store.findByContentKey(kind, contentKey(kind, proposal.title));
            if (dupCandidate && dupCandidate.body === proposal.body) {
                skipped += 1;
                result.push({ ref: item.ref, action: "skip", reason: `content-duplicate of ${dupCandidate.key}` });
                fingerprintsThisBatch.add(item.fingerprint);
                continue;
            }
            if (priorKeys.length > 0) {
                superseded += 1;
                result.push({ ref: item.ref, action: "supersede", supersedes: priorKeys });
            }
            else {
                created += 1;
                result.push({ ref: item.ref, action: "create" });
            }
            admittedThisBatch.set(item.sourceTag, `dry-run:${item.ref}`);
            fingerprintsThisBatch.add(item.fingerprint);
            continue;
        }
        const admission = admit(proposal, { store, now, key });
        if (!admission.accepted || !admission.cell) {
            skipped += 1;
            result.push({
                ref: item.ref,
                action: "skip",
                reason: `rejected: ${admission.issues[0]?.message ?? "admission"}`,
            });
            continue;
        }
        // Content dedup: admit() returned the pre-existing active cell as-is
        // (before store.put and before the supersede loop ran) rather than
        // admitting at the requested key. Nothing was written, so this must not
        // be counted as create or supersede, and it must not enter
        // admittedThisBatch or priors would be believed superseded when they
        // are still active.
        const isContentDuplicate = admission.warnings.some((w) => w.startsWith("deduplicated:")) || admission.cell.key !== key;
        if (isContentDuplicate) {
            skipped += 1;
            result.push({ ref: item.ref, action: "skip", reason: `content-duplicate of ${admission.cell.key}` });
            fingerprintsThisBatch.add(item.fingerprint);
            continue;
        }
        admittedThisBatch.set(item.sourceTag, admission.cell.key);
        fingerprintsThisBatch.add(item.fingerprint);
        if (priorKeys.length > 0) {
            superseded += 1;
            result.push({ ref: item.ref, action: "supersede", cellKey: admission.cell.key, supersedes: priorKeys });
        }
        else {
            created += 1;
            result.push({ ref: item.ref, action: "create", cellKey: admission.cell.key });
        }
    }
    return { source, dryRun: !apply, created, superseded, skipped, items: result };
}
export function importedRecordToItem(record, now = new Date().toISOString()) {
    const sourceTag = record.sourceTag ?? `${record.source}-src:${sha12(record.ref)}`;
    const fingerprint = `${record.source}:${sha12(record.ref)}:${sha12(record.body)}`;
    return {
        ref: record.ref,
        sourceTag,
        fingerprint,
        supersedesTags: record.supersedesTags,
        proposal: (priorKeys) => importedRecordToProposal(record, { sourceTag, fingerprint, priorKeys, now }),
    };
}
export function importedRecordToProposal(record, opts) {
    const kind = record.kind ?? "obs";
    const title = record.title.trim() || titleFrom(record.body);
    const confidence = probability(record.confidence ?? 0.6, 0.6);
    return {
        kind,
        title,
        body: clampBody(record.body),
        summary: record.summary ?? title,
        confidence,
        owner: record.owner ?? `${record.source}-adapter`,
        topics: unique([record.source, "imported", ...(record.topics ?? [])]),
        entities: unique([opts.sourceTag, ...(record.entities ?? [])]),
        ...(record.lifecycle !== undefined ? { lifecycle: record.lifecycle } : {}),
        ...(record.quality !== undefined ? { quality: record.quality } : {}),
        ...(record.subject !== undefined ? { subject: record.subject } : {}),
        sourceRefs: unique([`${record.source}:${record.ref}`, ...(record.sourceRefs ?? [])]),
        edges: opts.priorKeys.map((target) => ({ relation: "supersedes", target })),
        project: record.project ?? "Recall",
        tenant: record.tenant ?? "local",
        origin: "connector",
        verification: "checked",
        sensitivity: "private",
        stability: "stable",
        props: {
            ...record.props,
            import: {
                source: record.source,
                ref: record.ref,
                sourceTag: opts.sourceTag,
                fingerprint: opts.fingerprint,
                importedAt: opts.now,
                createdAt: record.createdAt ?? null,
            },
        },
    };
}
export function parseMem0Export(json) {
    return extractRows(json, ["memories", "results", "data"]).map((row) => {
        const rec = toRecord(row);
        const meta = toRecord(rec.metadata);
        const categories = stringArray(rec.categories);
        return {
            id: stringValue(rec.id),
            content: firstString(rec.memory, rec.content, rec.text) ?? "",
            categories: categories.length > 0 ? categories : stringArray(meta.categories),
            createdAt: stringValue(rec.created_at, rec.createdAt),
            updatedAt: stringValue(rec.updated_at, rec.updatedAt),
        };
    });
}
export function mem0ImportItems(json, opts = {}) {
    const project = opts.project ?? "Recall";
    const items = [];
    const preSkips = [];
    for (const mem of parseMem0Export(json)) {
        if (!mem.id) {
            preSkips.push({ ref: "(no id)", action: "skip", reason: "malformed: missing id" });
            continue;
        }
        if (mem.content.trim() === "") {
            preSkips.push({ ref: mem.id, action: "skip", reason: "empty" });
            continue;
        }
        items.push(importedRecordToItem({
            ref: mem.id,
            source: "mem0",
            title: titleFrom(mem.content),
            body: mem.content,
            topics: mem.categories,
            entities: mem.id ? [`mem0-id:${mem.id}`] : [],
            createdAt: mem.createdAt,
            project,
        }, opts.now));
    }
    return { items, preSkips };
}
export function importMem0(store, json, opts = {}) {
    const { items, preSkips } = mem0ImportItems(json, opts);
    const summary = importItems(store, "mem0", items, opts);
    return {
        ...summary,
        skipped: summary.skipped + preSkips.length,
        items: [...preSkips, ...summary.items],
    };
}
export function parseAutoMemoryFile(content) {
    const text = content.replace(/\r\n/g, "\n");
    const fence = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (!fence)
        return { body: text.trim() };
    const front = {};
    for (const line of fence[1].split("\n")) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (match && ["name", "description", "type"].includes(match[1])) {
            front[match[1]] = match[2].trim().slice(0, 2000);
        }
    }
    return {
        name: front.name,
        description: front.description,
        type: front.type,
        body: text.slice(fence[0].length).trim(),
    };
}
export function discoverAutoMemoryFiles(root) {
    if (!existsSync(root))
        return [];
    const out = [];
    for (const slug of readdirSync(root)) {
        const slugDir = join(root, slug);
        if (!safeIsDir(slugDir))
            continue;
        const memoryDir = join(slugDir, "memory");
        if (!safeIsDir(memoryDir))
            continue;
        for (const entry of readdirSync(memoryDir)) {
            if (!entry.endsWith(".md") || entry === "MEMORY.md")
                continue;
            const filePath = join(memoryDir, entry);
            if (safeIsFile(filePath))
                out.push({ slug, project: slug, filePath });
        }
    }
    return out.sort((a, b) => a.filePath.localeCompare(b.filePath));
}
export function autoMemoryImportItems(root, opts = {}) {
    const items = [];
    const preSkips = [];
    for (const file of discoverAutoMemoryFiles(root)) {
        let size = 0;
        try {
            size = statSync(file.filePath).size;
        }
        catch {
            preSkips.push({ ref: file.filePath, action: "skip", reason: "unreadable" });
            continue;
        }
        if (size > 1_000_000) {
            preSkips.push({ ref: file.filePath, action: "skip", reason: `too-large (${size} bytes)` });
            continue;
        }
        let raw;
        try {
            raw = readFileSync(file.filePath, "utf8");
        }
        catch {
            preSkips.push({ ref: file.filePath, action: "skip", reason: "unreadable" });
            continue;
        }
        const parsed = parseAutoMemoryFile(raw);
        if (!parsed.name?.trim() && parsed.body.trim() === "") {
            preSkips.push({ ref: file.filePath, action: "skip", reason: "empty" });
            continue;
        }
        const title = parsed.name?.trim() || basename(file.filePath);
        items.push(importedRecordToItem({
            ref: file.filePath,
            source: "auto-memory",
            title,
            body: parsed.body || parsed.description || title,
            summary: parsed.description ?? title,
            kind: autoMemoryKind(parsed.type),
            topics: ["auto-memory", parsed.type ?? "note"],
            entities: [opts.project ?? file.project],
            sourceRefs: [file.filePath],
            project: opts.project ?? file.project,
        }, opts.now));
    }
    return { items, preSkips };
}
export function importAutoMemory(store, root, opts = {}) {
    const { items, preSkips } = autoMemoryImportItems(root, opts);
    const summary = importItems(store, "auto-memory", items, opts);
    return {
        ...summary,
        skipped: summary.skipped + preSkips.length,
        items: [...preSkips, ...summary.items],
    };
}
export function parseZepExport(json) {
    return extractRows(json, ["edges", "facts", "data"]).map((row) => {
        const rec = toRecord(row);
        return {
            uuid: stringValue(rec.uuid, rec.id),
            fact: firstString(rec.fact, rec.content) ?? "",
            relation: firstString(rec.name, rec.relation, rec.predicate) ?? "",
            source: firstString(rec.source_node, rec.source, rec.source_node_name) ?? "",
            target: firstString(rec.target_node, rec.target, rec.target_node_name) ?? "",
            validAt: stringValue(rec.valid_at, rec.validAt),
            invalidAt: stringValue(rec.invalid_at, rec.expired_at, rec.invalidAt),
            createdAt: stringValue(rec.created_at, rec.createdAt),
        };
    });
}
export function zepImportItems(json, opts = {}) {
    const project = opts.project ?? "Recall";
    const preSkips = [];
    const groups = new Map();
    for (const fact of parseZepExport(json)) {
        if (!fact.uuid) {
            preSkips.push({ ref: "(no uuid)", action: "skip", reason: "malformed: missing uuid" });
            continue;
        }
        if (fact.fact.trim() === "") {
            preSkips.push({ ref: fact.uuid, action: "skip", reason: "empty" });
            continue;
        }
        const key = JSON.stringify([fact.source, fact.relation]);
        (groups.get(key) ?? groups.set(key, []).get(key)).push(fact);
    }
    const items = [];
    for (const group of groups.values()) {
        group.sort(byZepTime);
        group.forEach((fact, index) => {
            const previous = group[index - 1];
            const sourceTag = `zep-src:${sha12(fact.uuid)}`;
            const supersedesTags = previous?.invalidAt ? [`zep-src:${sha12(previous.uuid)}`] : undefined;
            items.push(importedRecordToItem({
                ref: fact.uuid,
                source: "zep",
                sourceTag,
                title: titleFrom(fact.fact),
                body: fact.fact,
                topics: ["zep", fact.relation].filter(Boolean),
                entities: [fact.source, fact.target, `zep-uuid:${fact.uuid}`].filter(Boolean),
                // Legacy semantics: a fact with an invalid_at is expired, else active.
                lifecycle: [fact.invalidAt ? "expired" : "active"],
                createdAt: fact.validAt ?? fact.createdAt,
                project,
                supersedesTags,
                // props.zep.invalidAt stays as the raw datum (dry-run/apply predecessor
                // supersede lookups and the exported archive read it directly).
                // Known legacy limitation, carried over unchanged: the import
                // fingerprint below hashes only source:sha12(ref):sha12(body), so a
                // fact whose text is unchanged but which GAINED invalid_at (e.g. it
                // just expired) still re-skips on reimport as "unchanged" even though
                // its lifecycle tag would now differ.
                props: { zep: { relation: fact.relation, source: fact.source, target: fact.target, invalidAt: fact.invalidAt ?? null } },
            }, opts.now));
        });
    }
    return { items, preSkips };
}
export function importZep(store, json, opts = {}) {
    const { items, preSkips } = zepImportItems(json, opts);
    const summary = importItems(store, "zep", items, opts);
    return {
        ...summary,
        skipped: summary.skipped + preSkips.length,
        items: [...preSkips, ...summary.items],
    };
}
export function exportCellArchive(store, now = new Date().toISOString()) {
    const archive = {
        schemaVersion: EXPORT_SCHEMA_VERSION_V2,
        exportedAt: now,
        stats: store.stats(),
        cells: store.all(),
        hyperedges: store.listHyperedges(ARCHIVE_LIST_LIMIT),
        dagOverlays: store.listDagOverlays(ARCHIVE_LIST_LIMIT),
        semanticVectors: store
            .listSemanticVectorIds()
            .map((id) => store.getSemanticVector(id))
            .filter((v) => v !== undefined),
    };
    // Ledger sections (programRuns/evalRuns/operatorRuns) live only on
    // SqliteStore, not the base Store interface, so they are feature-detected
    // here; a plain Store double omits them entirely (undefined, not []).
    if (typeof store.listProgramRuns === "function") {
        archive.programRuns = store.listProgramRuns({
            limit: ARCHIVE_LIST_LIMIT,
        });
    }
    if (typeof store.listEvalRuns === "function") {
        archive.evalRuns = store.listEvalRuns(ARCHIVE_LIST_LIMIT);
    }
    if (typeof store.listOperatorRuns === "function") {
        archive.operatorRuns = store.listOperatorRuns(ARCHIVE_LIST_LIMIT);
    }
    return archive;
}
// NOTE (partial-merge caveat): importing a partial archive rewrites each
// imported cell's edgesOut to the archived snapshot via store.put, which
// replaces the cell wholesale. This is not a merge of edge lists with
// whatever the target store already has for that key, it is an overwrite.
export function importCellArchive(store, archive, opts = {}) {
    const parsed = parseCellArchive(archive);
    const apply = opts.apply ?? false;
    const items = [];
    let imported = 0;
    let skipped = 0;
    // Cells first, so hyperedge members / vector nodeIds / overlay nodeIds
    // resolve against restored cells when the sections below are applied.
    for (const cell of parsed.cells) {
        const existing = store.get(cell.key);
        if (existing && JSON.stringify(existing) === JSON.stringify(cell)) {
            skipped += 1;
            items.push({ key: cell.key, action: "skip", reason: "unchanged" });
            continue;
        }
        imported += 1;
        items.push({ key: cell.key, action: "import" });
        if (apply)
            store.put(cell);
    }
    const hyperedges = importUpsertSection(parsed.hyperedges, (id) => store.getHyperedge(id), (record) => store.putHyperedge(record), (record) => record.id, apply);
    const semanticVectors = importUpsertSection(parsed.semanticVectors, (id) => store.getSemanticVector(id), (record) => store.putSemanticVector(record), (record) => record.nodeId, apply);
    const dagOverlays = importUpsertSection(parsed.dagOverlays, (id) => store.getDagOverlay(id), (record) => store.putDagOverlay(record), (record) => record.id, apply);
    // Ledger sections: feature-detect the record*/get* methods on the store
    // (SqliteStore-only, not on the base Store interface). Existence check via
    // get* first makes re-import idempotent (skip rather than re-record).
    const programRuns = importLedgerSection(parsed.programRuns, (id) => store.getProgramRun?.(id), (record) => store.recordProgramRun?.(record), (record) => record.id, typeof store.recordProgramRun === "function", apply);
    const evalRuns = importLedgerSection(parsed.evalRuns, (id) => store.getEvalRun?.(id), (record) => store.recordEvalRun?.(record), (record) => record.id, typeof store.recordEvalRun === "function", apply);
    // Restoring more than 1000 operator runs will self-truncate to the newest
    // 1000: recordOperatorRun prunes to its `keep` cap (default 1000) after
    // each insert, so a very large archived operator_runs section will not
    // fully survive an import.
    const operatorRuns = importLedgerSection(parsed.operatorRuns, (id) => store.getOperatorRun?.(id), (record) => store.recordOperatorRun?.(record), (record) => record.id, typeof store.recordOperatorRun === "function", apply);
    return {
        dryRun: !apply,
        imported,
        skipped,
        items,
        hyperedges,
        semanticVectors,
        dagOverlays,
        programRuns,
        evalRuns,
        operatorRuns,
    };
}
// Shared upsert-section logic for hyperedges/semanticVectors/dagOverlays: the
// interface putters are INSERT OR REPLACE upserts, so "import" (action) means
// the id is new or the stored JSON differs from what is already there;
// "skip" means byte-identical (compared via JSON.stringify).
function importUpsertSection(records, getExisting, put, idOf, apply) {
    let imported = 0;
    let skipped = 0;
    for (const record of records ?? []) {
        const existing = getExisting(idOf(record));
        if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(record)) {
            skipped += 1;
            continue;
        }
        imported += 1;
        if (apply)
            put(record);
    }
    return { imported, skipped };
}
// Shared ledger-section logic for programRuns/evalRuns/operatorRuns: these
// are feature-detected (SqliteStore-only), and existence (not content
// equality) gates the import, since a ledger row is immutable once recorded.
function importLedgerSection(records, getExisting, record, idOf, supported, apply) {
    let imported = 0;
    let skipped = 0;
    if (!supported)
        return { imported, skipped };
    for (const value of records ?? []) {
        const existing = getExisting(idOf(value));
        if (existing !== undefined) {
            skipped += 1;
            continue;
        }
        imported += 1;
        if (apply)
            record(value);
    }
    return { imported, skipped };
}
export function parseCellArchive(input) {
    if (!isRecord(input)) {
        throw new Error(`archive schemaVersion must be ${EXPORT_SCHEMA_VERSION} or ${EXPORT_SCHEMA_VERSION_V2}`);
    }
    const schemaVersion = input.schemaVersion;
    if (schemaVersion !== EXPORT_SCHEMA_VERSION && schemaVersion !== EXPORT_SCHEMA_VERSION_V2) {
        throw new Error(`archive schemaVersion must be ${EXPORT_SCHEMA_VERSION} or ${EXPORT_SCHEMA_VERSION_V2}`);
    }
    if (!Array.isArray(input.cells))
        throw new Error("archive cells must be an array");
    const archive = {
        schemaVersion,
        exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date(0).toISOString(),
        stats: isRecord(input.stats)
            ? input.stats
            : { cells: 0, activeCells: 0, edges: 0, indexedCells: 0, lexicalBackend: "like" },
        cells: input.cells.map(assertCell),
    };
    if (Array.isArray(input.hyperedges))
        archive.hyperedges = input.hyperedges;
    if (Array.isArray(input.semanticVectors))
        archive.semanticVectors = input.semanticVectors;
    if (Array.isArray(input.dagOverlays))
        archive.dagOverlays = input.dagOverlays;
    if (Array.isArray(input.programRuns))
        archive.programRuns = input.programRuns;
    if (Array.isArray(input.evalRuns))
        archive.evalRuns = input.evalRuns;
    if (Array.isArray(input.operatorRuns))
        archive.operatorRuns = input.operatorRuns;
    return archive;
}
function assertCell(value) {
    if (!isRecord(value) || typeof value.key !== "string" || typeof value.handle !== "string" || typeof value.kind !== "string") {
        throw new Error("archive cell is malformed");
    }
    return value;
}
function extractRows(json, keys) {
    if (Array.isArray(json))
        return json;
    if (isRecord(json)) {
        for (const key of keys) {
            if (Array.isArray(json[key]))
                return json[key];
        }
    }
    return [];
}
function titleFrom(content) {
    const trimmed = content.trim() || "imported memory";
    const words = trimmed.split(/\s+/);
    return words.length <= 20 ? trimmed : words.slice(0, 20).join(" ");
}
function autoMemoryKind(type) {
    switch ((type ?? "").toLowerCase()) {
        case "project":
        case "decision":
        case "architecture":
            return "dec";
        default:
            return "obs";
    }
}
function safeIsDir(path) {
    try {
        return lstatSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function safeIsFile(path) {
    try {
        return lstatSync(path).isFile();
    }
    catch {
        return false;
    }
}
function byZepTime(a, b) {
    const av = a.validAt ?? a.createdAt ?? "";
    const bv = b.validAt ?? b.createdAt ?? "";
    if (av !== bv)
        return av < bv ? -1 : 1;
    return (a.uuid ?? "").localeCompare(b.uuid ?? "");
}
function sha12(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim() !== "")
            return value;
    }
    return undefined;
}
function stringValue(...values) {
    return firstString(...values);
}
function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
}
function probability(value, fallback) {
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}
function unique(values) {
    return [...new Set(values.filter((value) => value.trim() !== ""))];
}
function toRecord(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
