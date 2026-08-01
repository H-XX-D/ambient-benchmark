#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = join(ROOT, "dist", "hf-space");
const required = [
  "README.md",
  "app.py",
  "scripts/verify-cross-adapter-grade-pipeline.mjs",
  "scripts/check-cross-adapter-grades.mjs",
  "adapters/external-space-url.mjs",
  "adapters/http-client.mjs",
  "examples/huggingface-memory-space/app.py",
  "examples/huggingface-memory-space/README.md",
  "examples/huggingface-memory-space/requirements.txt",
  "tiers/runner.mjs",
  "tiers/judge.mjs",
  "corpora/out/areas/small/segments.jsonl",
];
for (const path of required) {
  if (!existsSync(join(SPACE, path))) throw new Error(`missing Space artifact: ${path}`);
}

const card = readFileSync(join(SPACE, "README.md"), "utf8");
const launcher = readFileSync(join(SPACE, "app.py"), "utf8");
const externalUrlGate = readFileSync(join(SPACE, "adapters/external-space-url.mjs"), "utf8");
const adapterClient = readFileSync(join(SPACE, "adapters/http-client.mjs"), "utf8");
const areasSegments = readFileSync(join(SPACE, "corpora/out/areas/small/segments.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const starterApp = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "app.py"), "utf8");
const starterReadme = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "README.md"), "utf8");
const starterRequirements = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "requirements.txt"), "utf8");
if (!card.startsWith("---\n") || !card.includes("sdk: gradio") || !card.includes("app_file: app.py") || !card.includes("license: mit")) throw new Error("invalid Hugging Face Space metadata");
const expectedAbilities = ["adversarial-robustness", "anteriority", "attribution", "calibration", "concurrency", "contradiction", "deep-contradiction", "endurance", "federation", "modality", "reactivity", "retrieval-fidelity", "set-integrity", "supersession", "temporality"];
const packagedAbilities = [...new Set(areasSegments.map((segment) => segment.ability))].sort();
if (areasSegments.length !== 92 || JSON.stringify(packagedAbilities) !== JSON.stringify(expectedAbilities)) throw new Error("packaged new AMBIENT corpus must contain 92 questions across the exact 15 abilities");
if (!card.includes("hf_oauth: true") || !card.includes("hf_oauth_expiration_minutes: 720") || !card.includes("  - inference-api")) throw new Error("least-privilege Hugging Face OAuth metadata is missing");
if (!card.includes("API-key fields") || !card.includes("does not operate a leaderboard") || !card.includes("complete 92-question") || !card.includes("participant-owned Hugging Face memory Space")) throw new Error("OAuth, bring-your-own-memory, no-leaderboard, or new-suite disclosure is missing from the Space card");
if (!launcher.includes('NODE_VERSION = "24.10.0"') || !launcher.includes("expected_sha256") || !launcher.includes("import gradio as gr") || !launcher.includes("@spaces.GPU") || !launcher.includes("subprocess.run")) throw new Error("free Space launcher must register ZeroGPU and execute the verified Node 24 harness");
if (!launcher.includes('"publicationStatus": "unreviewed"') || !launcher.includes("Hugging Face OAuth; short-lived user token; excluded from logs and artifacts")) throw new Error("Gradio evidence boundary is missing");
if (!launcher.includes('HF_INFERENCE_ENDPOINT = "https://router.huggingface.co/v1"') || !launcher.includes('FIXED_READER_MODEL = "Qwen/Qwen3-32B"') || !launcher.includes('FIXED_JUDGE_MODEL = "openai/gpt-oss-120b"')) throw new Error("fixed Hugging Face inference controls are missing");
if (!launcher.includes("gr.LoginButton") || !launcher.includes("oauth_token: gr.OAuthToken") || !launcher.includes("Sign in with Hugging Face before starting a run")) throw new Error("authenticated Gradio runner boundary is missing");
if (launcher.includes("Reader API key") || launcher.includes("Judge API key") || launcher.includes("reader_key_input") || launcher.includes("judge_key_input") || launcher.includes("credential_consent_input") || launcher.includes("PROVIDERS =")) throw new Error("manual credential path remains in the Space launcher");
if (!launcher.includes('api_name="run_benchmark"')) throw new Error("named runner event is missing");
if (!launcher.includes("check-cross-adapter-grades.mjs") || !launcher.includes('"--expect-rows", "368"') || !launcher.includes("Checking complete-run integrity")) throw new Error("complete-run integrity gate is missing");
if (launcher.includes("hosted_leaderboard") || launcher.includes("ambient_hosted_runs") || launcher.includes("SUPABASE") || launcher.includes("publish_hosted_run") || launcher.includes("board_output")) throw new Error("hosted leaderboard or automatic publication code remains in the Space");
if (!launcher.includes("What is being measured") || !launcher.includes("This is not a model ranking") || !launcher.includes("does not operate a leaderboard or publish results automatically")) throw new Error("benchmark and no-publication explanation is missing");
for (const testLabel of ["Bring yours", "Questions", "Abilities", "Isolation", "Retrieval", "Judgment", "Attribution", "Integrity"]) {
  if (!launcher.includes(`<b>${testLabel}</b>`)) throw new Error(`run test list is missing ${testLabel}`);
}
for (const ability of ["adversarial robustness", "anteriority", "attribution", "calibration", "concurrency", "contradiction", "deep contradiction", "endurance", "federation", "modality", "reactivity", "retrieval fidelity", "set integrity", "supersession", "temporality"]) {
  if (!launcher.includes(ability)) throw new Error(`AMBIENT ability disclosure is missing ${ability}`);
}
if (!launcher.includes('"--source", "areas"') || !launcher.includes('"--limit", "0"') || !launcher.includes('command.extend(["--per-ability", str(scope["per_ability"])])')) throw new Error("hosted runner is not wired to the new AMBIENT areas corpus");
if (!launcher.includes('label="AMBIENT ability questions"') || launcher.includes("Unique BEAM questions") || launcher.includes("The BEAM runner covers 10 categories")) throw new Error("old BEAM runner UI remains");
if (launcher.includes("reader_model_input") || launcher.includes("judge_model_input") || launcher.includes('label="Fixed reader model"') || launcher.includes('label="Independent judge model"')) throw new Error("model selectors remain in the memory-first runner");
if (!launcher.includes("reader = oauth_provider_config(FIXED_READER_MODEL") || !launcher.includes("judge = oauth_provider_config(FIXED_JUDGE_MODEL") || !launcher.includes("inputs=[\n            memory_input,\n            memory_space_url_input,\n            sample_input,")) throw new Error("runner callback does not enforce fixed controls and memory-Space input");
if (!launcher.includes('"external-space": "My Hugging Face memory Space"') || !launcher.includes('value="external-space"') || !launcher.includes('label="Your memory Space URL"') || !launcher.includes('command.extend(["--external-adapter-url", external_adapter_url])')) throw new Error("bring-your-own memory Space path is missing");
if (!launcher.includes("def normalize_memory_space_url") || !launcher.includes("hf\\.space") || !launcher.includes("Memory Space URL must be the Space origin with no path")) throw new Error("Python memory Space URL gate is missing");
if (!externalUrlGate.includes("HF_SPACE_HOST") || !externalUrlGate.includes("public https://…hf.space origin") || !externalUrlGate.includes("url.pathname !== \"/\"")) throw new Error("Node memory Space URL gate is missing");
if (!adapterClient.includes('redirect: "error"') || !adapterClient.includes('"X-AMBIENT-Run-ID": randomUUID()')) throw new Error("external adapter redirect or run-isolation guard is missing");
if (!starterApp.includes("X-AMBIENT-Run-ID") || !/Hugging Face.*Space/s.test(starterReadme) || !starterRequirements.includes("gradio")) throw new Error("memory Space starter is incomplete");
if (!card.includes("never forwarded to\nthe participant's memory Space") || launcher.includes("AMBIENT_MEMORY_SPACE_TOKEN")) throw new Error("OAuth-to-memory-Space credential boundary is missing");
if (!launcher.includes('gr.DownloadButton("Export evidence bundle"') || launcher.includes("Technical run log") || launcher.includes("gr.Accordion")) throw new Error("result surface must end with one evidence export action and no technical-log panel");
if (launcher.includes("ambient-hero") || launcher.includes("Hold the model fixed")) throw new Error("retired sales-style Space hero remains");
if (!launcher.includes("def redact") || launcher.includes("print(payload)")) throw new Error("credential redaction boundary failed");
if (launcher.includes("AMBIENT_READER_API_KEY") || launcher.includes("AMBIENT_JUDGE_API_KEY") || launcher.includes("HF_TOKEN")) throw new Error("operator model credentials must not be used by the Space");
if (launcher.includes(":preferred")) throw new Error("provider preference suffix must not appear in the default model IDs");

console.log("Hugging Face Space package gate passed");
