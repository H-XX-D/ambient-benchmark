// POST /api/submit: the website's automated verify-and-place endpoint.
//
// Accepts a raw application/zip evidence bundle plus the frozen-corpus
// attestation, runs the same certifier that gates every other publication
// path, and on a clean pass stores the bundle as public evidence and places
// the row (and its tripwire outcomes) on the leaderboard. A bundle that fails
// any check places nothing and gets the full list of failed checks back.
import { MAX_UPLOAD_BYTES, processSubmission, placeSubmission } from "./_lib/submit-core.mjs";

export const config = { api: { bodyParser: false } };

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES + 1024) throw new Error("upload exceeds the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "POST a zip evidence bundle to this endpoint" });
    return;
  }
  const corpusHash = String(req.headers["x-ambient-corpus-sha256"] ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(corpusHash)) {
    send(res, 400, { ok: false, error: "supply the frozen corpus SHA-256 in the x-ambient-corpus-sha256 header" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    send(res, 413, { ok: false, error: error.message });
    return;
  }
  if (body.length === 0) {
    send(res, 400, { ok: false, error: "request body is empty; send the zip bundle as the raw body" });
    return;
  }

  let result;
  try {
    result = processSubmission(body, corpusHash);
  } catch (error) {
    send(res, 422, { ok: false, error: error.message });
    return;
  }
  if (!result.ok) {
    send(res, 422, {
      ok: false,
      error: "the bundle did not certify; nothing was published",
      checks: result.checks.map((check) => ({ name: check.name, message: check.message })),
    });
    return;
  }

  try {
    const placed = await placeSubmission({
      entry: result.entry,
      outcomes: result.outcomes,
      zipBuffer: body,
      env: process.env,
    });
    send(res, 200, {
      ok: true,
      certified: { totalChecks: result.totalChecks, controlKey: result.entry.controlKey },
      placed: {
        id: result.entry.id,
        track: result.entry.track,
        system: result.entry.system,
        evidenceUrl: placed.evidenceUrl,
        tripwireAbilities: result.outcomes.length,
      },
    });
  } catch (error) {
    const conflict = /already (published|on the leaderboard)/.test(error.message);
    send(res, conflict ? 409 : 502, { ok: false, error: error.message });
  }
}
