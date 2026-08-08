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
  "scripts/verify-hosted-hard-protocol.mjs",
  "adapters/external-space-url.mjs",
  "adapters/http-client.mjs",
  "examples/huggingface-memory-space/app.py",
  "examples/huggingface-memory-space/README.md",
  "examples/huggingface-memory-space/requirements.txt",
  "tiers/runner.mjs",
  "tiers/score-hard-attributed.mjs",
  "corpora/build-hard-corpus.mjs",
  "corpora/hard-behavior-core.mjs",
  "corpora/out/hard/small/segments.jsonl",
  "corpora/out/hard/medium-confirmatory-v2/segments.jsonl",
  "protocols/ambient-hard-hosted-v3.json",
];
for (const path of required) {
  if (!existsSync(join(SPACE, path))) throw new Error(`missing Space artifact: ${path}`);
}

const card = readFileSync(join(SPACE, "README.md"), "utf8");
const launcher = readFileSync(join(SPACE, "app.py"), "utf8");
const externalUrlGate = readFileSync(join(SPACE, "adapters/external-space-url.mjs"), "utf8");
const adapterClient = readFileSync(join(SPACE, "adapters/http-client.mjs"), "utf8");
const calibrationSegments = readFileSync(join(SPACE, "corpora/out/hard/small/segments.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const candidateSegments = readFileSync(join(SPACE, "corpora/out/hard/medium-confirmatory-v2/segments.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const starterApp = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "app.py"), "utf8");
const starterReadme = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "README.md"), "utf8");
const starterRequirements = readFileSync(join(SPACE, "examples", "huggingface-memory-space", "requirements.txt"), "utf8");
if (!card.startsWith("---\n") || !card.includes("sdk: gradio") || !card.includes("app_file: app.py") || !card.includes("license: mit")) throw new Error("invalid Hugging Face Space metadata");
const expectedAbilities = ["abstention", "belief-revision-audit", "contradiction-resolution", "event-ordering", "information-extraction", "instruction-following", "knowledge-update", "multi-session-reasoning", "poisoned-memory-quarantine", "preference-following", "summarization", "temporal-reasoning", "trust-discrimination"];
for (const [label, segments, expectedCount] of [["calibration", calibrationSegments, 52], ["candidate", candidateSegments, 260]]) {
  const packagedAbilities = [...new Set(segments.map((segment) => segment.ability))].sort();
  if (segments.length !== expectedCount || JSON.stringify(packagedAbilities) !== JSON.stringify(expectedAbilities)) throw new Error(`packaged ${label} hard corpus must contain ${expectedCount} worlds across the exact 13 abilities`);
  if (segments.some((segment) => segment.oracle?.schema !== "ambient.mechanical-answer.v1" || !segment.proof?.rule)) throw new Error(`packaged ${label} hard corpus is missing an exact oracle or derivation proof`);
}
if (!card.includes("hf_oauth: true") || !card.includes("hf_oauth_expiration_minutes: 720") || !card.includes("  - inference-api")) throw new Error("least-privilege Hugging Face OAuth metadata is missing");
if (!card.includes("API-key fields") || !card.includes("never publishes a\nparticipant's result automatically") || !card.includes("clear the automated\ncertifier") || !card.includes("complete 260-world") || !card.includes("participant-owned Hugging Face memory Space")) throw new Error("OAuth, bring-your-own-memory, certifier-gate, or hard-evaluator disclosure is missing from the Space card");
if (!launcher.includes('NODE_VERSION = "24.10.0"') || !launcher.includes("expected_sha256") || !launcher.includes("import gradio as gr") || !launcher.includes("@spaces.GPU") || !launcher.includes("subprocess.run")) throw new Error("free Space launcher must register ZeroGPU and execute the verified Node 24 harness");
if (!launcher.includes('"publicationStatus": "unreviewed"') || !launcher.includes("Hugging Face OAuth; short-lived user token; excluded from logs and artifacts")) throw new Error("Gradio evidence boundary is missing");
if (!launcher.includes('HF_INFERENCE_ENDPOINT = "https://router.huggingface.co/v1"') || !launcher.includes('FIXED_READER_MODEL = "Qwen/Qwen3-32B"') || launcher.includes("FIXED_JUDGE_MODEL")) throw new Error("fixed reader or judge-free control is incorrect");
if (!launcher.includes("gr.LoginButton") || !launcher.includes("oauth_token: gr.OAuthToken") || !launcher.includes("Sign in with Hugging Face before starting a run")) throw new Error("authenticated Gradio runner boundary is missing");
if (launcher.includes("Reader API key") || launcher.includes("Judge API key") || launcher.includes("reader_key_input") || launcher.includes("judge_key_input") || launcher.includes("credential_consent_input") || launcher.includes("PROVIDERS =")) throw new Error("manual credential path remains in the Space launcher");
if (!launcher.includes('api_name="run_benchmark"')) throw new Error("named runner event is missing");
if (!launcher.includes("check-cross-adapter-grades.mjs") || !launcher.includes('"--expect-rows", "1040"') || !launcher.includes("Checking complete-run integrity")) throw new Error("complete-run integrity gate is missing");
// The Space may DISPLAY a certified leaderboard, but it must never write to
// one. Enforce the property that actually matters: read-only access to the
// results table, and no automatic publication path of any kind.
if (launcher.includes("publish_hosted_run") || launcher.includes("post_hosted_run") || /requests?\.post|method\s*=\s*"POST"|"Prefer":/.test(launcher)) throw new Error("automatic publication path remains in the Space");
if (launcher.includes("SUPABASE_SERVICE") || launcher.includes("SUPABASE_SECRET") || launcher.includes("service_role")) throw new Error("the Space must never hold a privileged Supabase key");
if (!launcher.includes('"publication_status": "eq.hosted"') || !launcher.includes("SUPABASE_PUBLISHABLE_KEY")) throw new Error("hosted board must read gate-passed rows through the publishable key only");
// The submission path is only trustworthy if the certifier is what gates it.
if (!launcher.includes("certify-submission.mjs") || !launcher.includes('api_name="certify_bundle"')) throw new Error("submission certifier is not wired into the Space");
if (!launcher.includes("protocol_corpus_sha256") || !launcher.includes("--corpus-hash")) throw new Error("locally-run corpus attestation is missing from the Space");
if (!launcher.includes("extract_bundle") || !launcher.includes("escapes the extraction directory")) throw new Error("uploaded bundles must be extracted with a path-traversal guard");
// Hugging Face serves the Space in an iframe with scrolling="no", and Gradio's
// container defaults to overflow-y:hidden, so without an explicit scroll owner
// nothing below the fold can be reached. Verified by A/B: reverting these two
// declarations leaves every scroll container at 0 and strands the submit panel.
if (!/\.gradio-container\s*\{[^}]*max-height:\s*100vh/.test(launcher) || !/\.gradio-container\s*\{[^}]*overflow-y:\s*auto\s*!important/.test(launcher)) throw new Error("the Space must own its scrolling; Hugging Face embeds it in a scrolling=\"no\" iframe");
if (!launcher.includes("What is being measured") || !launcher.includes("This is not a model ranking") || !launcher.includes("never publishes a result automatically")) throw new Error("benchmark and no-publication explanation is missing");
for (const testLabel of ["Bring yours", "Worlds", "Abilities", "18 areas", "Isolation", "Retrieval", "Scoring", "Attribution", "Integrity"]) {
  if (!launcher.includes(`<b>${testLabel}</b>`)) throw new Error(`run test list is missing ${testLabel}`);
}
for (const ability of ["knowledge update", "contradiction resolution", "multi-session reasoning", "temporal reasoning", "event ordering", "information extraction", "preference following", "instruction following", "summarization", "abstention", "trust discrimination", "belief-revision audit", "poisoned-memory quarantine"]) {
  if (!launcher.includes(ability)) throw new Error(`AMBIENT ability disclosure is missing ${ability}`);
}
if (!launcher.includes('"--source", "hard"') || !launcher.includes('"--mechanical-hard"') || !launcher.includes('"--limit", "0"') || !launcher.includes('command.extend(["--per-ability", str(scope["per_ability"])])')) throw new Error("hosted runner is not wired to the hard mechanical evaluator");
if (!launcher.includes('label="AMBIENT hard worlds"') || launcher.includes("AMBIENT 18-area questions") || launcher.includes("Unique BEAM questions")) throw new Error("old hosted runner UI remains");
if (launcher.includes("reader_model_input") || launcher.includes("judge_model_input") || launcher.includes('label="Fixed reader model"') || launcher.includes('label="Independent judge model"')) throw new Error("model selectors remain in the memory-first runner");
if (!launcher.includes("reader = oauth_provider_config(FIXED_READER_MODEL") || launcher.includes("judge = oauth_provider_config") || !launcher.includes("inputs=[\n            memory_input,\n            memory_space_url_input,\n            sample_input,")) throw new Error("runner callback does not enforce fixed reader, deterministic scoring, and memory-Space input");
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
