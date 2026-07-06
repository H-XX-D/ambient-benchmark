// SqliteStore: the R2 Store contract over node:sqlite. The cell persists as a
// JSON blob (minus its edges) plus indexed columns; edges live only in the
// edges table and are rehydrated on read.
import { existsSync, statSync } from "node:fs";
import { openDb } from "./db.js";
import { buildFtsMatchQuery } from "./retrieval.js";
import { salienceBump } from "./scores.js";
import { normalizeHyperedgeMembers } from "./hyperedges.js";
// Content fingerprint for dedup: kind + normalized title. Stable, not relational,
// so it is safe to store and index (it is a content key, not derived graph state).
export function contentKey(kind, title) {
    return `${kind}:${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
}
export function searchTerms(query) {
    return query
        .toLowerCase()
        .split(/[^a-z0-9_:-]+/g)
        .filter((term) => term.length > 1)
        .slice(0, 8);
}
export class SqliteStore {
    path;
    db;
    ftsEnabled;
    constructor(path = ":memory:") {
        this.path = path;
        this.db = openDb(path);
        this.ftsEnabled = this.ensureFts();
    }
    put(cell) {
        const { edgesOut, ...rest } = cell; // edges go to their own table, not the blob
        const json = JSON.stringify(rest);
        this.db
            .prepare(`INSERT OR REPLACE INTO cells (key, handle, kind, content_key, status, json)
         VALUES (?, ?, ?, ?, ?, ?)`)
            .run(cell.key, cell.handle, cell.kind, contentKey(cell.kind, cell.title), cell.status, json);
        this.db.prepare(`DELETE FROM edges WHERE source = ?`).run(cell.key);
        const ins = this.db.prepare(`INSERT OR REPLACE INTO edges (source, relation, target, weight) VALUES (?, ?, ?, ?)`);
        for (const e of edgesOut) {
            ins.run(e.source, e.relation, e.target, e.weight);
        }
        this.indexCell(cell);
    }
    // Retrieval bump: the one place salience accumulates. A genuine single-cell
    // read (cell show / recall_cell) reinforces attention. Preserves updatedAt so
    // currency (freshness) is untouched; salience is anchored to lastSalientAt
    // instead. Feature-detected by callers with "touchSalience" in store, and a
    // no-op on an unknown key. Not part of the Store interface: a SqliteStore-only
    // extension, so read-only surfaces (the federated store) never bump.
    touchSalience(key, now, gain) {
        const cell = this.get(key);
        if (!cell)
            return undefined;
        const seed = salienceBump(cell.scores.salienceSeed, gain);
        const updated = {
            ...cell,
            scores: { ...cell.scores, salienceSeed: seed, salience: seed },
            lastSalientAt: now,
        };
        this.put(updated);
        return updated;
    }
    get(key) {
        const row = this.db.prepare(`SELECT key, json FROM cells WHERE key = ?`).get(key);
        return row ? this.hydrate(row) : undefined;
    }
    getByHandle(handle) {
        const row = this.db
            .prepare(`SELECT key, json FROM cells WHERE handle = ?`)
            .get(handle);
        return row ? this.hydrate(row) : undefined;
    }
    all() {
        const rows = this.db.prepare(`SELECT key, json FROM cells`).all();
        return rows.map((r) => this.hydrate(r));
    }
    active() {
        const rows = this.db
            .prepare(`SELECT key, json FROM cells WHERE status = 'active'`)
            .all();
        return rows.map((r) => this.hydrate(r));
    }
    // Temporal query pushed down to the indexed created_at generated column: no
    // scan-and-parse, SQLite filters and orders. Backs the "what changed since"
    // read without loading the whole graph into app memory.
    cellsCreatedSince(iso, limit = 100) {
        const rows = this.db
            .prepare(`SELECT key, json FROM cells WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`)
            .all(iso, limit);
        return rows.map((r) => this.hydrate(r));
    }
    // SqliteStore only (NOT on the Store interface, NOT FederatedReadStore):
    // subgraph.ts feature-detects with "activeWhere" in store to take this fast
    // path instead of filtering store.active() app-side. Pushes status='active'
    // plus kind/project/since down into SQL against the real `kind` column and
    // the indexed `project`/`updated_at` generated columns, newest-updated first,
    // key ascending as a deterministic tie-break for equal updated_at values (SQLite
    // gives no ordering guarantee among tied rows otherwise); sortNewestFirst in
    // subgraph.ts applies the same tie-break so both paths agree.
    // LIMIT is applied only when the caller passes it: subgraphCells omits it
    // whenever tag families (topics/entities/lifecycle/quality/subject) are also
    // present, since app-side tag filtering after a SQL LIMIT would under-fill.
    activeWhere(opts) {
        const clauses = [`status = 'active'`];
        const params = [];
        if (opts.kinds !== undefined && opts.kinds.length > 0) {
            clauses.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
            params.push(...opts.kinds);
        }
        if (opts.project !== undefined) {
            clauses.push(`project = ?`);
            params.push(opts.project);
        }
        if (opts.since !== undefined) {
            clauses.push(`updated_at >= ?`);
            params.push(opts.since);
        }
        let sql = `SELECT key, json FROM cells WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, key ASC`;
        if (opts.limit !== undefined) {
            sql += ` LIMIT ?`;
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((r) => this.hydrate(r));
    }
    // SqliteStore only (NOT on the Store interface, NOT FederatedReadStore):
    // pages.ts feature-detects with "activeByProject" in store to seed the cell
    // pool for a project-filtered page instead of filtering store.active()
    // app-side. Thin wrapper over activeWhere (Task 12): same status='active'
    // predicate, same ORDER BY updated_at DESC, key ASC. LIMIT is intentionally
    // not exposed here as a SQL LIMIT because pages.ts always applies topics
    // filtering and the kind remap after seeding, and a SQL LIMIT before that
    // app-side filtering would under-fill; callers that want LIMIT pass it
    // through opts and it stays app-side downstream.
    activeByProject(project, opts = {}) {
        return this.activeWhere({ project, since: opts.since, limit: opts.limit });
    }
    neighbors(key) {
        const links = [];
        const out = this.db
            .prepare(`SELECT source, relation, target, weight FROM edges WHERE source = ?`)
            .all(key);
        for (const e of out) {
            const cell = this.get(e.target);
            if (cell)
                links.push({ edge: this.toEdge(e), cell, direction: "out" });
        }
        const inc = this.db
            .prepare(`SELECT source, relation, target, weight FROM edges WHERE target = ?`)
            .all(key);
        for (const e of inc) {
            const cell = this.get(e.source);
            if (cell)
                links.push({ edge: this.toEdge(e), cell, direction: "in" });
        }
        return links;
    }
    findByContentKey(kind, ck) {
        const row = this.db
            .prepare(`SELECT key, json FROM cells WHERE kind = ? AND content_key = ? AND status = 'active' LIMIT 1`)
            .get(kind, ck);
        return row ? this.hydrate(row) : undefined;
    }
    putHyperedge(h) {
        this.db.prepare(`INSERT OR REPLACE INTO hyperedges (id, kind, title, members_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(h.id, h.kind, h.title, JSON.stringify(h.members), JSON.stringify(h.metadata), h.createdAt);
    }
    listHyperedges(limit = 100) {
        const rows = this.db
            .prepare(`SELECT * FROM hyperedges ORDER BY created_at DESC LIMIT ?`)
            .all(limit);
        return rows.map((r) => this.hydrateHyperedge(r));
    }
    getHyperedge(id) {
        const resolved = this.resolveStoredId("hyperedges", id);
        if (resolved === null)
            return undefined;
        const row = this.db.prepare(`SELECT * FROM hyperedges WHERE id = ?`).get(resolved);
        return row ? this.hydrateHyperedge(row) : undefined;
    }
    // Prefilters with a LIKE on the raw members_json (cheap, index-friendly on the
    // needle substring) then confirms with an exact JS equality check on the
    // normalized member keys, so a key that only appears as a JSON-string
    // substring of another key never false-positives.
    hyperedgesForCell(key, limit = 50) {
        const needle = `%${escapeLike(JSON.stringify(key))}%`;
        const rows = this.db
            .prepare(`SELECT * FROM hyperedges WHERE members_json LIKE ? ESCAPE '\\' ORDER BY created_at DESC`)
            .all(needle);
        const out = [];
        for (const row of rows) {
            const hyperedge = this.hydrateHyperedge(row);
            if (hyperedge.members.some((m) => m.key === key)) {
                out.push(hyperedge);
                if (out.length >= limit)
                    break;
            }
        }
        return out;
    }
    putSemanticVector(v) {
        this.db.prepare(`INSERT OR REPLACE INTO semantic_index (node_id, backend, dims, vector_json, indexed_at) VALUES (?, ?, ?, ?, ?)`)
            .run(v.nodeId, v.backend, v.dims, JSON.stringify(v.vector), v.indexedAt);
    }
    getSemanticVector(nodeId) {
        const r = this.db.prepare(`SELECT * FROM semantic_index WHERE node_id = ?`).get(nodeId);
        return r ? { nodeId: r.node_id, backend: r.backend, dims: r.dims, vector: JSON.parse(r.vector_json), indexedAt: r.indexed_at } : undefined;
    }
    listSemanticVectorIds() {
        const rows = this.db.prepare(`SELECT node_id FROM semantic_index`).all();
        return rows.map((r) => r.node_id);
    }
    putDagOverlay(d) {
        this.db.prepare(`INSERT OR REPLACE INTO dag_overlays (id, title, node_ids_json, edges_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(d.id, d.title, JSON.stringify(d.nodeIds), JSON.stringify(d.edges), JSON.stringify(d.metadata), d.createdAt);
    }
    // Prefix-tolerant via resolveStoredId, a deliberate upgrade over legacy
    // exact-only lookup: a unique id prefix resolves the same way getHyperedge
    // resolves one.
    getDagOverlay(id) {
        const resolved = this.resolveStoredId("dag_overlays", id);
        if (resolved === null)
            return undefined;
        const row = this.db.prepare(`SELECT * FROM dag_overlays WHERE id = ?`).get(resolved);
        return row ? this.hydrateDagOverlay(row) : undefined;
    }
    listDagOverlays(limit = 100) {
        const rows = this.db.prepare(`SELECT * FROM dag_overlays ORDER BY created_at DESC LIMIT ?`).all(limit);
        return rows.map((r) => this.hydrateDagOverlay(r));
    }
    // Durable run ledger for standing programs. SqliteStore-only (NOT on the Store
    // interface): programs.ts feature-detects with "recordProgramRun" in store
    // before calling, so runProgramCell keeps working against any plain Store.
    recordProgramRun(run) {
        this.db
            .prepare(`INSERT OR REPLACE INTO program_runs (id, program_key, operation, output_json, member_keys_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(run.id, run.programKey, run.operation, JSON.stringify(run.output), JSON.stringify(run.memberKeys), run.createdAt);
    }
    // Prefix-tolerant via resolveStoredId, same convention as getHyperedge/getDagOverlay.
    getProgramRun(id) {
        const resolved = this.resolveStoredId("program_runs", id);
        if (resolved === null)
            return undefined;
        const row = this.db.prepare(`SELECT * FROM program_runs WHERE id = ?`).get(resolved);
        return row ? this.hydrateProgramRun(row) : undefined;
    }
    listProgramRuns(opts = {}) {
        const limit = opts.limit ?? 20;
        const rows = opts.programKey
            ? this.db
                .prepare(`SELECT * FROM program_runs WHERE program_key = ? ORDER BY created_at DESC LIMIT ?`)
                .all(opts.programKey, limit)
            : this.db
                .prepare(`SELECT * FROM program_runs ORDER BY created_at DESC LIMIT ?`)
                .all(limit);
        return rows.map((r) => this.hydrateProgramRun(r));
    }
    // Durable eval ledger, same convention as recordProgramRun: SqliteStore-only
    // (NOT on the Store interface), feature-detected by callers with
    // "recordEvalRun" in store before calling.
    recordEvalRun(run) {
        this.db
            .prepare(`INSERT OR REPLACE INTO eval_runs (id, name, result_json, created_at) VALUES (?, ?, ?, ?)`)
            .run(run.id, run.name, JSON.stringify(run.result), run.createdAt);
    }
    // Prefix-tolerant via resolveStoredId, same convention as getProgramRun.
    getEvalRun(id) {
        const resolved = this.resolveStoredId("eval_runs", id);
        if (resolved === null)
            return undefined;
        const row = this.db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(resolved);
        return row ? this.hydrateEvalRun(row) : undefined;
    }
    listEvalRuns(limit = 20) {
        const rows = this.db
            .prepare(`SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?`)
            .all(limit);
        return rows.map((r) => this.hydrateEvalRun(r));
    }
    // Durable operator-tick ledger, same convention as recordProgramRun/recordEvalRun:
    // SqliteStore-only (NOT on the Store interface), feature-detected by callers with
    // "recordOperatorRun" in store. The Stop hook fires a cycle on every turn (best
    // effort), so rows are pruned to `keep` newest immediately after insert to keep
    // the ledger bounded; 1000 covers weeks of turns.
    recordOperatorRun(run, keep = 1000) {
        this.db
            .prepare(`INSERT OR REPLACE INTO operator_runs (id, status, summary, result_json, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(run.id, run.status, run.summary, JSON.stringify(run.result), run.createdAt);
        this.db
            .prepare(`DELETE FROM operator_runs WHERE id NOT IN (SELECT id FROM operator_runs ORDER BY created_at DESC LIMIT ?)`)
            .run(keep);
        return run;
    }
    // Prefix-tolerant via resolveStoredId, same convention as getProgramRun/getEvalRun.
    getOperatorRun(id) {
        const resolved = this.resolveStoredId("operator_runs", id);
        if (resolved === null)
            return undefined;
        const row = this.db.prepare(`SELECT * FROM operator_runs WHERE id = ?`).get(resolved);
        return row ? this.hydrateOperatorRun(row) : undefined;
    }
    listOperatorRuns(limit = 20) {
        const rows = this.db
            .prepare(`SELECT * FROM operator_runs ORDER BY created_at DESC LIMIT ?`)
            .all(limit);
        return rows.map((r) => this.hydrateOperatorRun(r));
    }
    search(query, opts = {}) {
        const limit = opts.limit ?? 10;
        const terms = searchTerms(query);
        if (limit <= 0 || terms.length === 0)
            return [];
        if (this.ftsEnabled) {
            const match = buildFtsMatchQuery(terms);
            if (match) {
                try {
                    const rows = this.db
                        .prepare(`SELECT cells.key, cells.json, bm25(cells_fts, 4.0, 3.0, 2.0, 1.0, 1.0) AS rank
               FROM cells_fts
               JOIN cells ON cells.key = cells_fts.key
               WHERE cells_fts MATCH ? AND cells.status = 'active'
               ORDER BY rank ASC
               LIMIT ?`)
                        .all(match, limit);
                    return rows.map((row) => ({
                        cell: this.hydrate(row),
                        score: Math.max(0, -row.rank),
                        backend: "fts5-bm25",
                    }));
                }
                catch {
                    // Bad MATCH syntax or a runtime FTS issue should degrade to LIKE.
                }
            }
        }
        return this.searchLike(terms, limit);
    }
    lexicalBackend() {
        return this.ftsEnabled ? "fts5-bm25" : "like";
    }
    stats() {
        return {
            cells: this.count("cells"),
            activeCells: this.count("cells", "status = 'active'"),
            edges: this.count("edges"),
            indexedCells: this.ftsEnabled ? this.count("cells_fts") : 0,
            lexicalBackend: this.lexicalBackend(),
        };
    }
    // SqliteStore only (NOT on the Store interface, same convention as
    // recordProgramRun/recordEvalRun/recordOperatorRun): every metric is a SQL
    // aggregate, never an app-side scan. databaseBytes adds the -wal and -shm
    // sidecar files to the main file size (db.ts sets WAL mode, so a lot of live
    // data can sit in the sidecars rather than the main file); undefined for
    // ":memory:" and for a missing on-disk file.
    storageStats() {
        const tables = {
            cells: this.count("cells"),
            edges: this.count("edges"),
            hyperedges: this.count("hyperedges"),
            semanticVectors: this.count("semantic_index"),
            dagOverlays: this.count("dag_overlays"),
            programRuns: this.count("program_runs"),
            evalRuns: this.count("eval_runs"),
            operatorRuns: this.count("operator_runs"),
        };
        // length() on TEXT counts characters, not bytes, so a CAST to BLOB is
        // required here to get true UTF-8 byte counts for multibyte content.
        const avgRow = this.db
            .prepare(`SELECT AVG(length(CAST(json AS BLOB))) AS average FROM cells`)
            .get();
        const averageCellBytes = avgRow.average === null ? 0 : Math.round(avgRow.average);
        const maxRow = this.db
            .prepare(`SELECT key, handle, json_extract(json, '$.title') AS title, length(CAST(json AS BLOB)) AS bytes
         FROM cells
         ORDER BY length(CAST(json AS BLOB)) DESC, key ASC
         LIMIT 1`)
            .get();
        const maximumCell = maxRow
            ? { key: maxRow.key, handle: maxRow.handle, title: maxRow.title ?? "", bytes: maxRow.bytes }
            : null;
        return {
            databasePath: this.path === ":memory:" ? undefined : this.path,
            databaseBytes: this.databaseBytes(),
            tables,
            averageCellBytes,
            maximumCell,
        };
    }
    close() {
        this.db.close();
    }
    ensureFts() {
        try {
            this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cells_fts USING fts5(
          key UNINDEXED,
          handle,
          title,
          tags,
          summary,
          body,
          tokenize = 'porter unicode61'
        )
      `);
            const cells = this.count("cells");
            const indexed = this.count("cells_fts");
            if (cells !== indexed) {
                this.rebuildFts();
            }
            return true;
        }
        catch {
            return false;
        }
    }
    rebuildFts() {
        this.db.exec("DELETE FROM cells_fts");
        const rows = this.db.prepare(`SELECT key, json FROM cells`).all();
        const insert = this.db.prepare(`INSERT INTO cells_fts (key, handle, title, tags, summary, body) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const row of rows) {
            const cell = this.hydrate(row);
            insert.run(cell.key, cell.handle, cell.title, indexTags(cell), cell.summary ?? "", cell.body);
        }
    }
    indexCell(cell) {
        if (!this.ftsEnabled)
            return;
        this.db.prepare(`DELETE FROM cells_fts WHERE key = ?`).run(cell.key);
        this.db
            .prepare(`INSERT INTO cells_fts (key, handle, title, tags, summary, body) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(cell.key, cell.handle, cell.title, indexTags(cell), cell.summary ?? "", cell.body);
    }
    searchLike(terms, limit) {
        if (terms.length === 0)
            return [];
        const clauses = terms
            .map(() => `(handle LIKE ? ESCAPE '\\' OR json LIKE ? ESCAPE '\\')`)
            .join(" OR ");
        const score = terms
            .map(() => `(CASE WHEN handle LIKE ? ESCAPE '\\' THEN 3 WHEN json LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
            .join(" + ");
        const clauseParams = terms.flatMap((term) => {
            const pattern = `%${escapeLike(term)}%`;
            return [pattern, pattern];
        });
        const scoreParams = [...clauseParams];
        const rows = this.db
            .prepare(`SELECT key, json, (${score}) AS rank
         FROM cells
         WHERE status = 'active' AND (${clauses})
         ORDER BY rank DESC, key ASC
         LIMIT ?`)
            .all(...scoreParams, ...clauseParams, limit);
        return rows.map((row) => ({
            cell: this.hydrate(row),
            score: row.rank,
            backend: "like",
        }));
    }
    count(table, where) {
        const sql = where ? `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS count FROM ${table}`;
        const row = this.db.prepare(sql).get();
        return row.count;
    }
    // Main file size plus the -wal and -shm sidecars, if present (db.ts sets WAL
    // mode, so a legacy stat of the main file alone undercounts live bytes).
    // undefined for ":memory:" or when the main file itself does not exist.
    databaseBytes() {
        if (this.path === ":memory:")
            return undefined;
        if (!existsSync(this.path))
            return undefined;
        let total = statSync(this.path).size;
        for (const suffix of ["-wal", "-shm"]) {
            const sidecar = `${this.path}${suffix}`;
            if (existsSync(sidecar))
                total += statSync(sidecar).size;
        }
        return total;
    }
    hydrate(row) {
        const cell = JSON.parse(row.json);
        const edgeRows = this.db
            .prepare(`SELECT source, relation, target, weight FROM edges WHERE source = ?`)
            .all(row.key);
        return { ...cell, edgesOut: edgeRows.map((e) => this.toEdge(e)) };
    }
    hydrateHyperedge(row) {
        return {
            id: row.id,
            kind: row.kind,
            title: row.title,
            members: normalizeHyperedgeMembers(JSON.parse(row.members_json)),
            metadata: JSON.parse(row.metadata_json),
            createdAt: row.created_at,
        };
    }
    hydrateDagOverlay(row) {
        return {
            id: row.id,
            title: row.title,
            nodeIds: JSON.parse(row.node_ids_json),
            edges: JSON.parse(row.edges_json),
            metadata: JSON.parse(row.metadata_json),
            createdAt: row.created_at,
        };
    }
    hydrateProgramRun(row) {
        return {
            id: row.id,
            programKey: row.program_key,
            operation: row.operation,
            createdAt: row.created_at,
            memberKeys: JSON.parse(row.member_keys_json),
            output: JSON.parse(row.output_json),
        };
    }
    hydrateEvalRun(row) {
        return {
            id: row.id,
            name: row.name,
            result: JSON.parse(row.result_json),
            createdAt: row.created_at,
        };
    }
    hydrateOperatorRun(row) {
        return {
            id: row.id,
            status: row.status,
            summary: row.summary,
            result: JSON.parse(row.result_json),
            createdAt: row.created_at,
        };
    }
    // Resolves a stored id: exact match wins. Otherwise, if the value looks like a
    // (partial) hex/uuid id, we try it as a unique prefix, LIMIT 2 so we can tell
    // "exactly one match" from "ambiguous" without scanning the whole table.
    resolveStoredId(table, id) {
        const exact = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
        if (exact)
            return exact.id;
        if (!(id.length >= 6 && id.length < 36 && /^[0-9a-fA-F-]+$/.test(id))) {
            return null;
        }
        const pattern = `${escapeLike(id)}%`;
        const rows = this.db
            .prepare(`SELECT id FROM ${table} WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
            .all(pattern);
        return rows.length === 1 ? rows[0].id : null;
    }
    toEdge(e) {
        return {
            relation: e.relation,
            source: e.source,
            target: e.target,
            weight: e.weight,
        };
    }
}
function indexTags(cell) {
    return [
        cell.owner,
        cell.scope.project,
        cell.scope.tenant,
        ...cell.tags.topics,
        ...cell.tags.entities,
        ...(cell.tags.lifecycle ?? []),
        ...(cell.tags.quality ?? []),
        ...(cell.tags.subject ?? []),
        ...cell.sourceRefs,
    ].join(" ");
}
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
