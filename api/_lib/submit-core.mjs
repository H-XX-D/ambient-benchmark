// Core of the website submission pipeline: extract an uploaded bundle safely,
// certify it, derive its tripwire outcomes, and place it on the leaderboard.
//
// This module is pure with respect to the network: placement receives a fetch
// implementation so tests exercise the exact request shapes without touching
// the real database. The HTTP handler in ../submit.mjs is a thin wrapper.
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { certifySubmission } from "../../scripts/certify-submission.mjs";
import { deriveTripwireOutcomes } from "../../scripts/publish-tripwire-outcomes.mjs";

export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024; // storage bucket caps at 50 MB
export const MAX_UPLOAD_ENTRIES = 5000;

/**
 * Extract an uploaded zip without letting it escape `destination`.
 * Uploaded bundles are attacker-controlled input: cap counts and sizes,
 * contain every path, and refuse links before touching the certifier.
 */
export function extractZipSafely(zipBuffer, destination) {
  if (zipBuffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`bundle is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit`);
  }
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error("upload is not a readable zip archive");
  }
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error("zip archive is empty");
  if (entries.length > MAX_UPLOAD_ENTRIES) throw new Error("zip archive contains too many entries");

  const root = resolve(destination);
  mkdirSync(root, { recursive: true });
  let total = 0;
  for (const entry of entries) {
    const target = resolve(root, entry.entryName);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`zip entry escapes the extraction directory: ${entry.entryName}`);
    }
    // Unix mode rides in the top 16 bits; 0xA000 marks a symlink.
    if (((entry.header.attr >>> 16) & 0xf000) === 0xa000) {
      throw new Error(`zip archive contains a link entry: ${entry.entryName}`);
    }
    if (entry.isDirectory) continue;
    const data = entry.getData();
    total += data.length;
    if (total > MAX_UPLOAD_BYTES) throw new Error("zip archive expands beyond the upload limit");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }

  const direct = join(root, "submission.json");
  try { readFileSync(direct); return root; } catch { /* look one level down */ }
  for (const entry of entries) {
    if (entry.entryName.endsWith("submission.json")) {
      return dirname(resolve(root, entry.entryName));
    }
  }
  throw new Error("bundle does not contain submission.json");
}

/**
 * Certify an uploaded bundle and derive what placement needs.
 * Returns {ok:false, checks} when the certifier refuses; nothing is derived
 * from an uncertified bundle.
 */
export function processSubmission(zipBuffer, corpusSha256) {
  const workspace = join(tmpdir(), `ambient-submit-${createHash("sha256").update(zipBuffer).digest("hex").slice(0, 16)}`);
  rmSync(workspace, { recursive: true, force: true });
  try {
    const bundleDir = extractZipSafely(zipBuffer, workspace);
    const report = certifySubmission(bundleDir, { corpusSha256, origin: "local" });
    if (!report.ok) {
      return { ok: false, checks: report.checks.filter((check) => !check.passed) };
    }
    const submission = JSON.parse(readFileSync(join(bundleDir, "submission.json"), "utf8"));
    const verdicts = readFileSync(join(bundleDir, submission.artifacts.verdicts), "utf8")
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return { ok: true, entry: report.entry, outcomes: deriveTripwireOutcomes(verdicts), totalChecks: report.checks.length };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Place a certified submission: store the bundle as public evidence, insert
 * the leaderboard row, then attach its tripwire outcomes.
 * All writes carry the service key and run server-side only.
 */
export async function placeSubmission({ entry, outcomes, zipBuffer, env, fetchImpl = fetch }) {
  const supabaseUrl = (env.AMBIENT_SUPABASE_URL ?? "https://nasxywilptctmfdbfpdw.supabase.co").replace(/\/$/, "");
  const serviceKey = env.AMBIENT_SUPABASE_SERVICE_KEY;
  if (!serviceKey) throw new Error("placement is not configured: AMBIENT_SUPABASE_SERVICE_KEY is missing");

  const auth = { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` };
  const objectPath = `bundles/${entry.id}.zip`;

  const stored = await fetchImpl(`${supabaseUrl}/storage/v1/object/ambient-evidence/${objectPath}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/zip", "x-upsert": "false" },
    body: zipBuffer,
  });
  if (stored.status === 409) throw new Error(`a bundle for submission id "${entry.id}" is already published`);
  if (!stored.ok) throw new Error(`evidence storage refused the bundle: HTTP ${stored.status}`);

  const evidenceUrl = `${supabaseUrl}/storage/v1/object/public/ambient-evidence/${objectPath}`;

  const inserted = await fetchImpl(`${supabaseUrl}/rest/v1/ambient_leaderboard_entries`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify([{
      id: entry.id,
      track: entry.track,
      system_name: entry.system.name,
      system_version: entry.system.version,
      corpus: entry.corpus,
      item_count: entry.result.items,
      score: entry.result.score,
      lower95: entry.result.lower95,
      upper95: entry.result.upper95,
      baseline: entry.result.baseline ?? null,
      treatment: entry.result.treatment ?? null,
      control_key: entry.controlKey,
      submitted_at: entry.submittedAt,
      submitted_by: entry.submittedBy,
      source_commit: entry.sourceCommit,
      evidence_url: evidenceUrl,
      artifact_sha256: entry.artifactSha256,
      publication_status: "verified",
    }]),
  });
  if (inserted.status === 409) throw new Error(`submission id "${entry.id}" is already on the leaderboard`);
  if (!inserted.ok) throw new Error(`leaderboard insert failed: HTTP ${inserted.status}: ${(await inserted.text()).slice(0, 300)}`);

  if (outcomes.length > 0) {
    const attached = await fetchImpl(`${supabaseUrl}/rest/v1/ambient_tripwire_outcomes`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(outcomes.map((outcome) => ({
        entry_id: entry.id,
        // Overwritten from the parent entry by the database trigger.
        memory_name: "pending",
        control_key: "000000000000",
        completed_at: new Date(0).toISOString(),
        ability: outcome.ability,
        rows: outcome.rows,
        gullible: outcome.gullible,
      }))),
    });
    if (!attached.ok) throw new Error(`tripwire attach failed: HTTP ${attached.status}: ${(await attached.text()).slice(0, 300)}`);
  }

  return { evidenceUrl };
}
