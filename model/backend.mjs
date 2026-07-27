// AMBIENT fixed reader backend. One model, held constant across systems and tiers.
// Backend is local (llama-server) or online (OpenAI-compatible API by key), chosen by
// env. No key is ever committed; it is read from AMBIENT_API_KEY or a local key file
// outside the repo. See model/README.md and docs/ATTRIBUTION.md.

import { createHash } from "node:crypto";

const ENV = (k, d) => globalThis.process?.env?.[k] ?? d;

export const MODEL_REQUEST_PARAMS = Object.freeze({
  temperature: 0,
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicModelSpec(config, role) {
  const spec = {
    role,
    backend: config.backend,
    endpoint: config.endpoint,
    model: config.model || "local",
    temperature: MODEL_REQUEST_PARAMS.temperature,
    noThink: Boolean(ENV("AMBIENT_NO_THINK", "")),
  };
  return {
    ...spec,
    fingerprint: createHash("sha256").update(stableJson(spec)).digest("hex"),
  };
}

export function resolveBackend() {
  const backend = ENV("AMBIENT_MODEL_BACKEND", "local");
  const endpoint = ENV(
    "AMBIENT_MODEL_ENDPOINT",
    backend === "local" ? "http://localhost:8089/v1" : "https://api.openai.com/v1",
  );
  const model = ENV("AMBIENT_MODEL", backend === "local" ? "Llama-3.2-1B" : "");
  const apiKey = ENV("AMBIENT_API_KEY", backend === "local" ? "no-key" : "");
  if (backend === "online" && !apiKey) {
    throw new Error("online backend needs AMBIENT_API_KEY (never commit it)");
  }
  return { backend, endpoint, model, apiKey };
}

// The ingest-firewall CLASSIFIER backend. Independently configurable so it can be a small FAST
// model (local :8090 or an API) while the answer reader stays the constant 32B. Defaults to the
// reader backend, so with no AMBIENT_CHECKER_* set the firewall just uses the reader.
export function resolveClassifier() {
  const rb = resolveBackend();
  return {
    backend: ENV("AMBIENT_CHECKER_BACKEND", rb.backend),
    endpoint: ENV("AMBIENT_CHECKER_ENDPOINT", rb.endpoint),
    model: ENV("AMBIENT_CHECKER_MODEL", rb.model),
    apiKey: ENV("AMBIENT_CHECKER_KEY", rb.apiKey),
  };
}

// One OpenAI-compatible completion against a given backend config (local llama-server or online API).
async function complete(cfg, turn) {
  const messages = [];
  if (turn.system) messages.push({ role: "system", content: turn.system });
  const noThink = ENV("AMBIENT_NO_THINK", "");
  messages.push({ role: "user", content: noThink ? turn.user + "\n/no_think" : turn.user });
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey && cfg.apiKey !== "no-key") headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${cfg.endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model || "local",
      messages,
      temperature: MODEL_REQUEST_PARAMS.temperature,
      max_tokens: turn.maxTokens ?? 128,
    }),
  });
  if (!res.ok) throw new Error(`model backend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return content;
}

/**
 * ask - one completion against the fixed reader (held constant across systems and tiers).
 * @param {{ system?: string, user: string, maxTokens?: number }} turn
 */
export async function ask(turn) {
  return complete(resolveBackend(), turn);
}

// askClassifier - the ingest firewall's relation classifier. Same shape as ask, but its own backend.
export async function askClassifier(turn) {
  return complete(resolveClassifier(), turn);
}

// Prove a fresh local-reader boundary when llama-server exposes its slot API.
// A new HTTP request alone does not prove that server-side KV state was erased.
// Online APIs remain request-isolated but their slot state is not observable.
export async function resetReaderSession(options = {}) {
  const cfg = resolveBackend();
  const requireProof = options.requireProof ?? ENV("AMBIENT_REQUIRE_SLOT_RESET", "") === "1";
  if (cfg.backend !== "local") {
    if (requireProof) {
      throw new Error("slot-reset proof is only available for a local llama-server backend");
    }
    return {
      mode: "fresh-http-request",
      proven: false,
      reason: "online backend slot state is not observable",
    };
  }

  const origin = new URL(cfg.endpoint).origin;
  try {
    const listed = await fetch(`${origin}/slots`);
    if (!listed.ok) throw new Error(`slot listing returned ${listed.status}`);
    const payload = await listed.json();
    const slots = Array.isArray(payload) ? payload : payload?.slots ?? [];
    const ids = slots
      .map((slot) => slot?.id ?? slot?.slot_id)
      .filter((id) => id !== undefined && id !== null);
    if (ids.length === 0) throw new Error("slot listing returned no slot IDs");

    const erased = [];
    for (const id of ids) {
      const response = await fetch(`${origin}/slots/${encodeURIComponent(id)}?action=erase`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`erase slot ${id} returned ${response.status}`);
      erased.push(id);
    }
    return { mode: "llama-slot-erase", proven: erased.length === ids.length, listed: ids, erased };
  } catch (error) {
    if (requireProof) throw new Error(`fresh-session proof failed: ${error.message}`);
    return { mode: "fresh-http-request", proven: false, reason: error.message };
  }
}
