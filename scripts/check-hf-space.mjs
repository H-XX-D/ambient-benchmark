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
  "tiers/runner.mjs",
  "tiers/judge.mjs",
  "corpora/out/beam/small/segments.jsonl",
];
for (const path of required) {
  if (!existsSync(join(SPACE, path))) throw new Error(`missing Space artifact: ${path}`);
}

const card = readFileSync(join(SPACE, "README.md"), "utf8");
const launcher = readFileSync(join(SPACE, "app.py"), "utf8");
if (!card.startsWith("---\n") || !card.includes("sdk: gradio") || !card.includes("app_file: app.py") || !card.includes("license: mit")) throw new Error("invalid Hugging Face Space metadata");
if (!card.includes("hf_oauth: true") || !card.includes("hf_oauth_expiration_minutes: 720") || !card.includes("  - inference-api")) throw new Error("least-privilege Hugging Face OAuth metadata is missing");
if (!card.includes("API-key fields") || !card.includes("AMBIENT_SUPABASE_SECRET_KEY")) throw new Error("OAuth and publishing-secret boundaries are missing from the Space card");
if (!launcher.includes('NODE_VERSION = "24.10.0"') || !launcher.includes("expected_sha256") || !launcher.includes("import gradio as gr") || !launcher.includes("@spaces.GPU") || !launcher.includes("subprocess.run")) throw new Error("free Space launcher must register ZeroGPU and execute the verified Node 24 harness");
if (!launcher.includes("hosted-unreviewed") || !launcher.includes("Hugging Face OAuth; short-lived user token; excluded from logs and artifacts")) throw new Error("Gradio evidence boundary is missing");
if (!launcher.includes('HF_INFERENCE_ENDPOINT = "https://router.huggingface.co/v1"') || !launcher.includes("AMBIENT_SUPABASE_SECRET_KEY")) throw new Error("Hugging Face OAuth or publishing-secret configuration is missing");
if (!launcher.includes("gr.LoginButton") || !launcher.includes("oauth_token: gr.OAuthToken") || !launcher.includes("Sign in with Hugging Face before starting a run")) throw new Error("authenticated Gradio runner boundary is missing");
if (launcher.includes("Reader API key") || launcher.includes("Judge API key") || launcher.includes("reader_key_input") || launcher.includes("judge_key_input") || launcher.includes("credential_consent_input") || launcher.includes("PROVIDERS =")) throw new Error("manual credential path remains in the Space launcher");
if (!launcher.includes('api_name="run_benchmark"')) throw new Error("named runner event is missing");
if (!launcher.includes("check-cross-adapter-grades.mjs") || !launcher.includes('"--expect-rows", "1600"') || !launcher.includes("publish_hosted_run")) throw new Error("complete hosted-run publication gate is missing");
if (!launcher.includes("def fetch_hosted_runs") || !launcher.includes("def hosted_leaderboard_html") || !launcher.includes("ambient_hosted_runs") || !launcher.includes("Current leader")) throw new Error("live hosted leaderboard is missing from the Space");
if (!launcher.includes("What is being measured") || !launcher.includes("This is not a model ranking") || launcher.indexOf("What is being measured") > launcher.indexOf('board_output = gr.HTML')) throw new Error("benchmark explanation must appear between the title and leaderboard");
for (const testLabel of ["Abilities", "Isolation", "Retrieval", "Judgment", "Attribution", "Integrity"]) {
  if (!launcher.includes(`<b>${testLabel}</b>`)) throw new Error(`run test list is missing ${testLabel}`);
}
if (!launcher.includes("demo.load(hosted_leaderboard_html") || !launcher.includes("return summary, str(bundle_path), hosted_leaderboard_html()")) throw new Error("leaderboard does not refresh after eligible runs publish");
if (launcher.indexOf('board_output = gr.HTML') > launcher.indexOf('elem_id="ambient-workspace"')) throw new Error("leaderboard must appear before the runner controls");
if (!launcher.includes('gr.DownloadButton("Export evidence bundle"') || launcher.includes("Technical run log") || launcher.includes("gr.Accordion")) throw new Error("result surface must end with one evidence export action and no technical-log panel");
if (launcher.includes("ambient-hero") || launcher.includes("Hold the model fixed")) throw new Error("retired sales-style Space hero remains");
if (!launcher.includes("def redact") || launcher.includes("print(payload)")) throw new Error("credential redaction boundary failed");
if (launcher.includes("AMBIENT_READER_API_KEY") || launcher.includes("AMBIENT_JUDGE_API_KEY") || launcher.includes("HF_TOKEN")) throw new Error("operator model credentials must not be used by the Space");
if (launcher.includes(":preferred")) throw new Error("provider preference suffix must not appear in the default model IDs");

console.log("Hugging Face Space package gate passed");
