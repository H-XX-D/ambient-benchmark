// The website submission pipeline is the only path that turns an anonymous
// upload into a public leaderboard row, so each test pins one refusal or one
// exact write. Placement runs against a stub fetch that records requests;
// nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFixtureBundle } from "../fixtures/submission/build-fixture-bundle.mjs";
import { extractZipSafely, processSubmission, placeSubmission } from "../api/_lib/submit-core.mjs";

const PROTOCOL_CORPUS_SHA256 = "5d14c5dbf0eb51d63be1b1cd1c9b6c20a2fa4b256f121b236dcc149addfd55ce";

function fixtureZip() {
  const dir = mkdtempSync(join(tmpdir(), "ambient-zip-"));
  try {
    buildFixtureBundle(dir);
    const zip = new AdmZip();
    zip.addLocalFolder(dir);
    return zip.toBuffer();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stubFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const kind = url.includes("/storage/") ? "storage"
      : url.includes("ambient_leaderboard_entries") ? "entries"
      : "outcomes";
    const status = overrides[kind] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => "stub",
    };
  };
  return { calls, impl };
}

test("a zip entry with a traversal path is refused before anything is written", () => {
  // adm-zip sanitises names on addFile, so an actually-malicious archive has
  // to be forged: write a same-length placeholder name, then patch the raw
  // bytes (the name appears in both the local header and the central
  // directory) into a traversal path.
  const zip = new AdmZip();
  zip.addFile("AA_AA_escape.txt", Buffer.from("out"));
  zip.addFile("submission.json", Buffer.from("{}"));
  let raw = zip.toBuffer();
  const placeholder = Buffer.from("AA_AA_escape.txt");
  const evil = Buffer.from("../../escape.txt");
  assert.equal(placeholder.length, evil.length);
  let at;
  while ((at = raw.indexOf(placeholder)) !== -1) evil.copy(raw, at);
  // Prove the forgery took: the archive must now really carry the traversal.
  assert.ok(new AdmZip(raw).getEntries().some((entry) => entry.rawEntryName.toString().includes("../")));
  const dest = mkdtempSync(join(tmpdir(), "ambient-x-"));
  try {
    assert.throws(() => extractZipSafely(raw, dest), /escapes the extraction directory/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("a zip symlink entry is refused", () => {
  const zip = new AdmZip();
  const entryData = Buffer.from("/etc/passwd");
  zip.addFile("link.json", entryData);
  // Stamp the unix symlink mode into the external attributes.
  zip.getEntries()[0].header.attr = (0xa1ff << 16) >>> 0;
  zip.addFile("submission.json", Buffer.from("{}"));
  const dest = mkdtempSync(join(tmpdir(), "ambient-x-"));
  try {
    assert.throws(() => extractZipSafely(zip.toBuffer(), dest), /link entry/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("garbage bytes are refused as not-a-zip", () => {
  const dest = mkdtempSync(join(tmpdir(), "ambient-x-"));
  try {
    assert.throws(() => extractZipSafely(Buffer.from("not a zip at all"), dest), /not a readable zip/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("a certified fixture bundle processes to an entry plus tripwire outcomes", () => {
  const result = processSubmission(fixtureZip(), PROTOCOL_CORPUS_SHA256);
  assert.equal(result.ok, true, JSON.stringify(result.checks ?? []));
  assert.equal(result.entry.id, "fixture-architecture-run");
  assert.match(result.entry.controlKey, /^[0-9a-f]{12}$/);
  // 30 segments x 3 replicates x 4 tiers per tripwire ability in the fixture.
  assert.deepEqual(result.outcomes.map((o) => `${o.ability}:${o.rows}:${o.gullible}`), [
    "abstention:360:0",
    "contradiction-resolution:360:0",
    "knowledge-update:360:0",
  ]);
});

test("a wrong corpus attestation certifies nothing and names the check", () => {
  const result = processSubmission(fixtureZip(), "f".repeat(64));
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.name === "protocol.corpusAttestation"));
});

test("placement writes storage, entry, and outcomes in order with the service key", async () => {
  const processed = processSubmission(fixtureZip(), PROTOCOL_CORPUS_SHA256);
  const { calls, impl } = stubFetch();
  const placed = await placeSubmission({
    entry: processed.entry,
    outcomes: processed.outcomes,
    zipBuffer: Buffer.from("zipbytes"),
    env: { AMBIENT_SUPABASE_SERVICE_KEY: "svc-key", AMBIENT_SUPABASE_URL: "https://db.example" },
    fetchImpl: impl,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /storage\/v1\/object\/ambient-evidence\/bundles\/fixture-architecture-run\.zip$/);
  assert.match(calls[1].url, /ambient_leaderboard_entries$/);
  assert.match(calls[2].url, /ambient_tripwire_outcomes$/);
  for (const call of calls) {
    assert.equal(call.options.headers.apikey, "svc-key", "every write must carry the service key");
  }
  // The entry row must be exactly what the certifier derived.
  const rows = JSON.parse(calls[1].options.body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "fixture-architecture-run");
  assert.equal(rows[0].publication_status, "verified");
  assert.equal(rows[0].control_key, processed.entry.controlKey);
  assert.equal(rows[0].evidence_url, placed.evidenceUrl);
  // Tripwire rows attach by entry id, never by run id.
  const outcomes = JSON.parse(calls[2].options.body);
  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.entry_id === "fixture-architecture-run" && o.run_id === undefined));
});

test("a duplicate submission id surfaces as already-published, not as success", async () => {
  const processed = processSubmission(fixtureZip(), PROTOCOL_CORPUS_SHA256);
  const { impl } = stubFetch({ storage: 409 });
  await assert.rejects(
    () => placeSubmission({
      entry: processed.entry, outcomes: processed.outcomes, zipBuffer: Buffer.from("z"),
      env: { AMBIENT_SUPABASE_SERVICE_KEY: "svc-key" }, fetchImpl: impl,
    }),
    /already published/,
  );
});

test("a missing service key refuses placement before any request is made", async () => {
  const processed = processSubmission(fixtureZip(), PROTOCOL_CORPUS_SHA256);
  const { calls, impl } = stubFetch();
  await assert.rejects(
    () => placeSubmission({ entry: processed.entry, outcomes: processed.outcomes, zipBuffer: Buffer.from("z"), env: {}, fetchImpl: impl }),
    /AMBIENT_SUPABASE_SERVICE_KEY/,
  );
  assert.equal(calls.length, 0, "no request may be sent without credentials");
});

test("a failed entry insert does not attach tripwire outcomes", async () => {
  const processed = processSubmission(fixtureZip(), PROTOCOL_CORPUS_SHA256);
  const { calls, impl } = stubFetch({ entries: 500 });
  await assert.rejects(
    () => placeSubmission({
      entry: processed.entry, outcomes: processed.outcomes, zipBuffer: Buffer.from("z"),
      env: { AMBIENT_SUPABASE_SERVICE_KEY: "svc-key" }, fetchImpl: impl,
    }),
    /leaderboard insert failed/,
  );
  assert.equal(calls.filter((call) => call.url.includes("tripwire")).length, 0);
});
