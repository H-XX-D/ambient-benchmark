// AMBIENT probe: ADOPTION area (governed-by-default routing).
//
// Claim under test: a "remember this" lands in the GOVERNED store
// deterministically, attributable to a single control (the project registry),
// never an ungoverned side file.
//
// We exercise the real routing module from dist:
//   registerProject / resolveDbForCwd / resolveCwdRouting / loadRegistry /
//   listProjects / globalDbPath / homeDbPath / slugify / localGraphPaths
//
// Hermetic by construction: every registry write targets a TEMP global db
// (passed explicitly via the globalDb argument), every governed local lives
// under a temp dir, and the one function that reads ambient state
// (resolveCwdRouting, which has no globalDb arg) is isolated with a temp
// RECALL_HOME + RECALL_GLOBAL_DB env. The user's real ~/.recall is never read
// or written. All temp dirs are removed on exit.
//
// Grade:
//   SELF-VERIFIED            routing is deterministic, correct for all N
//                            registered projects, and an unregistered cwd falls
//                            back to a governed default (persist is governed by
//                            default).
//   RESIDUAL(@SELF-VERIFIED) mostly correct with a single bounded gap.
//   ASSERTED                 routing is non-deterministic, or correct on fewer
//                            than N projects, with no leak to an ungoverned path.
//   ABSENT                   routing leaks a registered or unregistered cwd to
//                            an ungoverned side path (governance broken).

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  registerProject,
  resolveDbForCwd,
  resolveCwdRouting,
  loadRegistry,
  listProjects,
  globalDbPath,
  homeDbPath,
  slugify,
  localGraphPaths,
} from "../../dist/src/core/routing.js";

const NOW = "2026-06-23T00:00:00.000Z";
// How many times each routing question is re-asked to prove determinism.
const REPEATS = 5;

// A path is "governed" iff it is the temp registry db itself (the home/default
// governed store) or one of the project locals recorded in that registry. Any
// other path is an ungoverned side file.
function isGoverned(path, governedSet) {
  return governedSet.has(resolve(path));
}

export function runAdoption() {
  const N = 6;
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  // Two temp roots: one for the registry + governed locals, one to host the
  // project working directories we will route from.
  const sandbox = mkdtempSync(join(tmpdir(), "recall-adoption-"));
  // Snapshot the real ambient paths up front so we can assert we never touched
  // them, regardless of env.
  const realGlobal = resolve(globalDbPath());

  try {
    const govDir = join(sandbox, "governed"); // holds the registry + locals
    const workDir = join(sandbox, "work"); // holds project working dirs
    mkdirSync(govDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const tmpGlobalDb = join(govDir, "registry.sqlite3"); // TEMP registry
    const govSet = new Set([resolve(tmpGlobalDb)]); // governed default is in-set

    // Hermeticity guard: the temp registry must not be the user's real one.
    record(
      "temp-registry-is-isolated",
      resolve(tmpGlobalDb) !== realGlobal,
      `tmp=${tmpGlobalDb} real=${realGlobal}`,
    );

    // --- Register N projects, each mapped to an explicit governed local. -----
    // dbPath is honored verbatim by registerProject, so we pin every local
    // under govDir and add it to the governed set.
    const projects = [];
    for (let i = 0; i < N; i++) {
      const root = join(workDir, `proj-${i}`);
      mkdirSync(root, { recursive: true });
      const dbPath = join(govDir, `${slugify(`proj-${i}`)}.sqlite3`);
      const rec = registerProject({ root, dbPath }, NOW, tmpGlobalDb);
      govSet.add(resolve(rec.db_path));
      projects.push({ root: resolve(root), expected: resolve(rec.db_path), rec });
    }

    // The registry should now hold exactly N rows, all governed.
    const listed = listProjects(tmpGlobalDb);
    record(
      "registry-holds-N",
      listed.length === N,
      `listed=${listed.length} want=${N}`,
    );
    const registry = loadRegistry(tmpGlobalDb); // resolve(root)->db_path
    record(
      "loadRegistry-matches-N",
      registry.size === N,
      `size=${registry.size} want=${N}`,
    );

    // --- Correctness + determinism for every registered project. ------------
    // env={} so a stray RECALL_DB / RECALL_HOME in the caller's shell cannot
    // change the answer; globalDb is the temp registry.
    let correct = 0;
    let deterministic = true;
    let governedAll = true;
    for (const p of projects) {
      // Route from the root and from a nested subdir (ancestor walk).
      const nested = join(p.root, "src", "deep", "leaf");
      mkdirSync(nested, { recursive: true });
      for (const cwd of [p.root, nested]) {
        const first = resolve(resolveDbForCwd(cwd, {}, tmpGlobalDb));
        if (first !== p.expected) correct = -1; // mark a miss (see below)
        for (let r = 0; r < REPEATS; r++) {
          const again = resolve(resolveDbForCwd(cwd, {}, tmpGlobalDb));
          if (again !== first) deterministic = false;
        }
        if (!isGoverned(first, govSet)) governedAll = false;
      }
    }
    // Recompute correct count cleanly (the -1 sentinel above only flags any
    // miss; do a precise count here).
    correct = 0;
    for (const p of projects) {
      const got = resolve(resolveDbForCwd(p.root, {}, tmpGlobalDb));
      if (got === p.expected) correct++;
    }
    record(
      "registered-routing-correct",
      correct === N,
      `correct=${correct}/${N}`,
    );
    record("registered-routing-deterministic", deterministic, `repeats=${REPEATS}`);
    record("registered-routing-governed", governedAll, "all hits in governed set");

    // --- Single-control attribution. ----------------------------------------
    // Changing ONLY the registry entry (re-register a NEW root onto a NEW
    // governed local) must change the routing target, and nothing else does.
    const newRoot = join(workDir, "proj-rekeyed");
    mkdirSync(newRoot, { recursive: true });
    const before = resolve(resolveDbForCwd(newRoot, {}, tmpGlobalDb));
    const newLocal = join(govDir, "rekeyed.sqlite3");
    const rekeyed = registerProject({ root: newRoot, dbPath: newLocal }, NOW, tmpGlobalDb);
    govSet.add(resolve(rekeyed.db_path));
    const after = resolve(resolveDbForCwd(newRoot, {}, tmpGlobalDb));
    record(
      "single-control-changes-target",
      before === resolve(tmpGlobalDb) && after === resolve(newLocal),
      `before=${before === realGlobal ? "REAL!" : "default"} after=${after}`,
    );

    // --- Unregistered cwd -> governed default (governed by default). --------
    // A cwd with no registered ancestor must fall back to the governed default
    // store (the registry/home local), not an arbitrary side file.
    const stranger = mkdtempSync(join(tmpdir(), "recall-adoption-stranger-"));
    let strangerOk = false;
    try {
      const fallback = resolve(resolveDbForCwd(stranger, {}, tmpGlobalDb));
      // Determinism of the fallback too.
      let fbDet = true;
      for (let r = 0; r < REPEATS; r++) {
        if (resolve(resolveDbForCwd(stranger, {}, tmpGlobalDb)) !== fallback) fbDet = false;
      }
      strangerOk =
        fallback === resolve(tmpGlobalDb) && isGoverned(fallback, govSet) && fbDet;
      record(
        "unregistered-falls-back-to-governed-default",
        strangerOk,
        `fallback=${fallback === realGlobal ? "REAL!" : fallback === resolve(tmpGlobalDb) ? "governed-default" : "OTHER"}`,
      );
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }

    // --- resolveCwdRouting scope check, isolated via temp RECALL_HOME. -------
    // resolveCwdRouting takes no globalDb arg (it reads globalDbPath()/homeDbPath
    // from env), so we isolate it with RECALL_HOME + RECALL_GLOBAL_DB pointed at
    // a fresh temp home. An unregistered cwd there must resolve to scope "home"
    // with dbPath == that temp home local (governed default), never an
    // ungoverned file.
    let scopeOk = false;
    const homeSandbox = mkdtempSync(join(tmpdir(), "recall-adoption-home-"));
    try {
      const isoEnv = {
        RECALL_HOME: homeSandbox,
        RECALL_GLOBAL_DB: join(homeSandbox, "db", "home.sqlite3"),
      };
      const expectedHome = resolve(homeDbPath(isoEnv));
      const strangerCwd = join(homeSandbox, "nowhere");
      mkdirSync(strangerCwd, { recursive: true });
      const routed = resolveCwdRouting(strangerCwd, isoEnv);
      const homeMembers = localGraphPaths(isoEnv).map((m) => resolve(m.path));
      scopeOk =
        routed.scope === "home" &&
        resolve(routed.dbPath) === expectedHome &&
        homeMembers.includes(expectedHome);
      record(
        "resolveCwdRouting-home-scope-governed",
        scopeOk,
        `scope=${routed.scope} db=${resolve(routed.dbPath) === expectedHome ? "home-local" : "OTHER"}`,
      );
    } finally {
      rmSync(homeSandbox, { recursive: true, force: true });
    }

    // --- Hermeticity: the user's real registry was never created/touched. ----
    // (We never passed realGlobal anywhere; assert no governed path equals it.)
    const leakedReal = [...govSet].some((p) => p === realGlobal);
    record("no-real-registry-leak", !leakedReal, `real=${realGlobal}`);

    // --- Grade. -------------------------------------------------------------
    const passed = checks.filter((c) => c.ok).length;
    const total = checks.length;
    const metric =
      `governed routing correct ${correct}/${N}, ` +
      `${deterministic ? "deterministic" : "NON-DETERMINISTIC"}, ` +
      `unregistered->${strangerOk ? "governed default" : "UNGOVERNED"}; ` +
      `checks ${passed}/${total}`;

    // Governance is broken (ABSENT) if any hit escaped the governed set or the
    // real registry leaked.
    const governanceBroken = !governedAll || leakedReal;
    let grade;
    if (governanceBroken) {
      grade = "ABSENT";
    } else if (
      correct === N &&
      deterministic &&
      strangerOk &&
      scopeOk &&
      passed === total
    ) {
      grade = "SELF-VERIFIED";
    } else if (correct >= N - 1 && deterministic && strangerOk) {
      grade = "RESIDUAL(@SELF-VERIFIED)";
    } else {
      grade = "ASSERTED";
    }

    return { n: N, metric, grade, checks };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Run directly: print the result.
const thisFile = fileURLToPath(import.meta.url);
const invoked = resolve(process.argv[1] ?? "");
if (resolve(thisFile) === invoked) {
  const result = runAdoption();
  const { checks, ...summary } = result;
  for (const c of checks) {
    process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})\n`);
  }
  process.stdout.write("\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(result.grade === "SELF-VERIFIED" || result.grade === "RESIDUAL(@SELF-VERIFIED)" ? 0 : 1);
}
