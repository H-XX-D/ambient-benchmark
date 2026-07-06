// R5 routing: deterministic residency for home/project SQLite locals.
//
// Two distinct files live under RECALL_HOME/db: home.sqlite3 is the default
// writable local (the home graph's own store), and registry.sqlite3 holds
// only the projects table. They used to be one file, which meant a corrupt
// home store also blinded listProjects to every registered project; the
// split keeps the registry readable no matter what happens to home's graph.
// A registered project gets a central DB under RECALL_HOME/db, and cwd
// routing chooses the deepest registered ancestor unless RECALL_DB
// explicitly overrides.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
const PROJECTS_DDL = `CREATE TABLE IF NOT EXISTS projects (
  root_path TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  db_path TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
)`;
export function recallHomeDir(env = process.env) {
    const override = env.RECALL_HOME?.trim();
    return override ? override : join(homedir(), ".recall");
}
export function homeDbPath(env = process.env) {
    return join(recallHomeDir(env), "db", "home.sqlite3");
}
export function registryDbPath(env = process.env) {
    return join(recallHomeDir(env), "db", "registry.sqlite3");
}
export function globalDbPath(env = process.env) {
    return homeDbPath(env);
}
// home.sqlite3 and registry.sqlite3 are claimed by the router itself, so a
// project slugged "home" or "registry" gets a project- prefixed filename.
const RESERVED_DB_FILENAMES = new Set(["home", "registry"]);
export function projectDbPath(slug, env = process.env) {
    const normalized = slugify(slug);
    const filename = RESERVED_DB_FILENAMES.has(normalized) ? `project-${normalized}` : normalized;
    return join(recallHomeDir(env), "db", `${filename}.sqlite3`);
}
export function slugify(text) {
    const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return slug || "project";
}
export function registerProject(input, nowIso = new Date().toISOString(), registryDb = registryDbPath()) {
    const rootPath = canonicalPath(input.root);
    mkdirSync(dirname(registryDb), { recursive: true });
    migrateLegacyRegistry(registryDb);
    const db = new DatabaseSync(registryDb);
    try {
        ensureProjectsTable(db);
        const existing = getProjectByRoot(db, rootPath);
        if (existing) {
            const description = input.description ?? existing.description;
            db.prepare("UPDATE projects SET description = ? WHERE root_path = ?").run(description, rootPath);
            return { ...existing, description };
        }
        const baseSlug = slugify(input.slug ?? basename(rootPath) ?? "project");
        const slug = uniqueSlug(db, baseSlug, rootPath);
        const filename = RESERVED_DB_FILENAMES.has(slug) ? `project-${slug}` : slug;
        const dbPath = input.dbPath ? resolve(input.dbPath) : join(dirname(registryDb), `${filename}.sqlite3`);
        db.prepare("INSERT INTO projects(root_path, slug, db_path, description, created_at) VALUES(?,?,?,?,?)").run(rootPath, slug, dbPath, input.description ?? null, nowIso);
        return { slug, rootPath, dbPath, description: input.description ?? null, createdAt: nowIso };
    }
    finally {
        db.close();
    }
}
export function listProjects(registryDb = registryDbPath()) {
    try {
        migrateLegacyRegistry(registryDb);
        const db = new DatabaseSync(registryDb, { readOnly: true });
        try {
            const rows = db
                .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects ORDER BY created_at, slug")
                .all();
            return rows.map(rowToRecord);
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}
export function loadRegistry(registryDb = registryDbPath()) {
    const byRoot = new Map();
    for (const project of listProjects(registryDb)) {
        byRoot.set(canonicalPath(project.rootPath), project);
    }
    return byRoot;
}
export function resolveDbForSlug(slug, registryDb = registryDbPath()) {
    try {
        migrateLegacyRegistry(registryDb);
        const db = new DatabaseSync(registryDb, { readOnly: true });
        try {
            const row = db.prepare("SELECT db_path FROM projects WHERE slug = ?").get(slug);
            return row?.db_path ?? null;
        }
        finally {
            db.close();
        }
    }
    catch {
        return null;
    }
}
export function resolveDbForCwd(cwd, env = process.env, registryDb = registryDbPath(env), homeDb = homeDbPath(env)) {
    return whereProject(cwd, env, registryDb, homeDb).dbPath;
}
export function whereProject(cwd, env = process.env, registryDb = registryDbPath(env), homeDb = homeDbPath(env)) {
    const explicit = env.RECALL_DB?.trim();
    if (explicit) {
        return { scope: "explicit", dbPath: explicit, reason: "RECALL_DB env override" };
    }
    const project = findProjectForCwd(cwd, listProjects(registryDb));
    if (project) {
        return {
            scope: "project",
            dbPath: project.dbPath,
            reason: `project root ${project.rootPath}`,
            project,
        };
    }
    return { scope: "home", dbPath: homeDb, reason: "no registered project ancestor" };
}
export function localGraphPaths(env = process.env, registryDb = registryDbPath(env), homeDb = homeDbPath(env)) {
    const members = [{ graph: "home", path: homeDb, root: "home" }];
    for (const project of listProjects(registryDb)) {
        members.push({ graph: project.slug, path: project.dbPath, root: project.rootPath });
    }
    const seenPath = new Set();
    const seenGraph = new Set();
    const out = [];
    for (const member of members) {
        const pathKey = resolve(member.path);
        if (seenPath.has(pathKey))
            continue;
        seenPath.add(pathKey);
        let graph = member.graph;
        while (seenGraph.has(graph)) {
            graph = `${member.graph}-${rootHash(`${member.root}:${pathKey}`)}`;
        }
        seenGraph.add(graph);
        out.push({ graph, path: member.path });
    }
    return out;
}
function ensureProjectsTable(db) {
    db.exec(PROJECTS_DDL);
}
// Registry layouts before the home/registry split kept the projects table
// inside home.sqlite3. When the registry file is missing but a sibling
// legacy home.sqlite3 holds project rows, copy them over once so an
// upgraded install keeps every registration. The copy is non-destructive:
// the legacy rows stay in place, so an older binary pointed at the same
// RECALL_HOME keeps working, and nothing on the new layout reads them.
function migrateLegacyRegistry(registryDb) {
    if (registryDb === ":memory:" || existsSync(registryDb))
        return;
    const legacy = join(dirname(registryDb), "home.sqlite3");
    if (resolve(legacy) === resolve(registryDb) || !existsSync(legacy))
        return;
    let rows;
    try {
        const source = new DatabaseSync(legacy, { readOnly: true });
        try {
            rows = source
                .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects")
                .all();
        }
        finally {
            source.close();
        }
    }
    catch {
        return; // no projects table, or an unreadable legacy file: nothing to migrate
    }
    if (rows.length === 0)
        return;
    const db = new DatabaseSync(registryDb);
    try {
        ensureProjectsTable(db);
        const insert = db.prepare("INSERT OR IGNORE INTO projects(root_path, slug, db_path, description, created_at) VALUES(?,?,?,?,?)");
        for (const row of rows) {
            insert.run(row.root_path, row.slug, row.db_path, row.description, row.created_at);
        }
    }
    finally {
        db.close();
    }
}
function getProjectByRoot(db, rootPath) {
    const row = db
        .prepare("SELECT slug, root_path, db_path, description, created_at FROM projects WHERE root_path = ?")
        .get(rootPath);
    return row ? rowToRecord(row) : undefined;
}
function uniqueSlug(db, baseSlug, rootPath) {
    let candidate = baseSlug;
    if (candidate === "home" || slugOwnedByDifferentRoot(db, candidate, rootPath)) {
        const prefix = candidate === "home" ? "project-home" : candidate;
        candidate = `${prefix}-${rootHash(rootPath)}`;
    }
    while (candidate === "home" || slugOwnedByDifferentRoot(db, candidate, rootPath)) {
        candidate = `${baseSlug}-${rootHash(`${rootPath}:${candidate}`)}`;
    }
    return candidate;
}
function slugOwnedByDifferentRoot(db, slug, rootPath) {
    const row = db.prepare("SELECT root_path FROM projects WHERE slug = ?").get(slug);
    return row !== undefined && canonicalPath(row.root_path) !== rootPath;
}
function findProjectForCwd(cwd, projects) {
    const byRoot = new Map(projects.map((project) => [canonicalPath(project.rootPath), project]));
    let dir = canonicalPath(cwd);
    for (;;) {
        const hit = byRoot.get(dir);
        if (hit)
            return hit;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
function rowToRecord(row) {
    return {
        slug: row.slug,
        rootPath: canonicalPath(row.root_path),
        dbPath: row.db_path,
        description: row.description,
        createdAt: row.created_at,
    };
}
function canonicalPath(path) {
    const resolved = resolve(path);
    try {
        return realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
function rootHash(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 6);
}
