// AMBIENT fixed reader backend. One model, held constant across systems and tiers.
// Backend is local (llama-server) or online (OpenAI-compatible API by key), chosen by
// env. No key is ever committed; it is read from AMBIENT_API_KEY or a local key file
// outside the repo. See model/README.md and docs/ATTRIBUTION.md.

const ENV = (k, d) => globalThis.process?.env?.[k] ?? d;

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
      temperature: 0,
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
