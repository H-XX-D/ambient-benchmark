#!/usr/bin/env node
// Publishes per-ability tripwire outcomes for a CERTIFIED evidence bundle.
//
// Flow: certify the bundle (fail-closed, same gate as everything else), derive
// the per-ability counts from the raw verdicts, then either print the payload
// (default, a dry run) or insert it into ambient_tripwire_outcomes through
// PostgREST with a service key. The rows attach to an existing hosted-run id;
// this script never invents a parent run, because the hosted-runs table has
// its own publication path and constraints.
//
// The Space is forbidden from carrying any publish path (check-hf-space.mjs
// enforces that), so this runs operator-side only, with credentials that never
// live in the Space.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { certifySubmission } from "./certify-submission.mjs";

// Must match the CHECK constraint in
// supabase/migrations/20260808094749_ambient_tripwire_outcomes.sql and the
// corpus generators; check-site.mjs verifies the whole chain.
export const TRIPWIRE_ABILITIES = [
  "abstention",
  "contradiction-resolution",
  "knowledge-update",
  "belief-revision-audit",
  "trust-discrimination",
  "poisoned-memory-quarantine",
];

/**
 * Reduce verdict rows to one {ability, rows, gullible} entry per tripwire
 * ability, in canonical ability order.
 *
 * A decoy hit is the scorer's "gullible" verdict: the answer asserted
 * something it was led to. The oracle's protectedHits trail must agree with
 * that verdict; a row carrying a protected hit under any other verdict means
 * the scorer and the evidence trail disagree, and publishing either number
 * would misstate the run, so the derivation refuses instead of choosing.
 */
export function deriveTripwireOutcomes(verdictRows) {
  const counts = new Map();
  for (const [index, row] of verdictRows.entries()) {
    if (typeof row?.ability !== "string" || row.ability.length === 0) {
      throw new Error(`verdict row ${index} has no ability field`);
    }
    const hits = row.oracle?.protectedHits ?? [];
    if (hits.length > 0 && row.verdict !== "gullible") {
      throw new Error(
        `verdict row ${index} (${row.segId ?? "unknown"}/${row.tier ?? "?"}) is inconsistent: ` +
        `oracle recorded protectedHits ${JSON.stringify(hits)} but the verdict is "${row.verdict}"`,
      );
    }
    if (!TRIPWIRE_ABILITIES.includes(row.ability)) continue;
    const entry = counts.get(row.ability) ?? { rows: 0, gullible: 0 };
    entry.rows += 1;
    if (row.verdict === "gullible") entry.gullible += 1;
    counts.set(row.ability, entry);
  }
  return TRIPWIRE_ABILITIES
    .filter((ability) => counts.has(ability))
    .map((ability) => ({ ability, ...counts.get(ability) }));
}

function jsonl(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`); }
  });
}

async function insertRows(rows, { runId, supabaseUrl, serviceKey }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/ambient_tripwire_outcomes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "apikey": serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      // No upsert: the unique (run_id, ability) constraint should reject a
      // double publication rather than quietly overwrite one.
      "Prefer": "return=representation",
    },
    body: JSON.stringify(rows.map((entry) => ({
      run_id: runId,
      // Denormalised fields are overwritten from the parent by the DB
      // trigger; placeholders satisfy the not-null constraints on the wire.
      memory_name: "pending",
      control_key: "000000000000",
      completed_at: new Date(0).toISOString(),
      ability: entry.ability,
      rows: entry.rows,
      gullible: entry.gullible,
    }))),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`insert failed: HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body);
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log([
      "usage: publish-tripwire-outcomes.mjs <bundle-dir> [options]",
      "",
      "  --corpus-hash <sha256>   frozen corpus attestation (required for local runs)",
      "  --hosted                 bundle was produced by the Space (skips attestation)",
      "  --run-id <uuid>          existing ambient_hosted_runs id to attach to",
      "  --publish                actually insert; default is a dry run that prints the payload",
      "",
      "Publishing requires AMBIENT_SUPABASE_URL (optional, has a default) and",
      "AMBIENT_SUPABASE_SERVICE_KEY in the environment. The service key is never",
      "read from a file and never travels to the Space.",
    ].join("\n"));
    return 2;
  }

  const bundleDir = args[0];
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

  // Gate first. Nothing derived from an uncertified bundle may be published.
  const report = certifySubmission(bundleDir, {
    corpusSha256: flag("--corpus-hash"),
    origin: args.includes("--hosted") ? "hosted" : "local",
  });
  if (!report.ok) {
    for (const check of report.checks.filter((c) => !c.passed)) {
      console.error(`FAIL  ${check.name}: ${check.message}`);
    }
    console.error("bundle did not certify; nothing was derived or published");
    return 1;
  }

  const submission = JSON.parse(readFileSync(join(bundleDir, "submission.json"), "utf8"));
  const verdicts = jsonl(join(bundleDir, submission.artifacts.verdicts));
  const outcomes = deriveTripwireOutcomes(verdicts);

  if (outcomes.length === 0) {
    console.error("bundle contains no tripwire-ability rows; nothing to publish");
    return 1;
  }

  const payload = {
    system: report.entry.system,
    controlKey: report.entry.controlKey,
    outcomes,
  };

  if (!args.includes("--publish")) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`dry run: ${outcomes.length} ability rows derived; pass --publish with --run-id to insert`);
    return 0;
  }

  const runId = flag("--run-id");
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    console.error("--publish requires --run-id <uuid> of an existing ambient_hosted_runs row");
    return 1;
  }
  const serviceKey = process.env.AMBIENT_SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    console.error("--publish requires AMBIENT_SUPABASE_SERVICE_KEY in the environment");
    return 1;
  }
  const supabaseUrl = (process.env.AMBIENT_SUPABASE_URL ?? "https://nasxywilptctmfdbfpdw.supabase.co").replace(/\/$/, "");

  const inserted = await insertRows(outcomes, { runId, supabaseUrl, serviceKey });
  console.log(`published ${inserted.length} tripwire rows for run ${runId} (${inserted[0]?.memory_name ?? "?"})`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("publish-tripwire-outcomes.mjs")) {
  main(process.argv).then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
