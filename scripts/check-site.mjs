#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "site/index.html",
  "site/run.html",
  "site/styles.css",
  "site/app.js",
  "site/leaderboard.html",
  "site/leaderboard.js",
  "site/assets/ambient-architecture.png",
  "site/assets/ambient-four-channel.png",
  "site/data/status.json",
  "site/data/leaderboard.json",
  "site/privacy.html",
  "site/terms.html",
  "site/license.html",
  "submissions/README.md",
  "submissions/schema.json",
  "supabase/migrations/20260727082205_ambient_leaderboard.sql",
  "supabase/migrations/20260727112324_ambient_hosted_runs.sql",
  "THIRD_PARTY_NOTICES.md",
  "vercel.json",
];
for (const path of required) {
  if (!existsSync(join(ROOT, path))) throw new Error(`missing site artifact: ${path}`);
}
const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
const status = JSON.parse(readFileSync(join(ROOT, "site/data/status.json"), "utf8"));
const leaderboard = JSON.parse(readFileSync(join(ROOT, "site/data/leaderboard.json"), "utf8"));
if (!html.includes('aria-label="Baseline Isolated Evaluation, Normalized Tiers."')) throw new Error("publication title is missing");
if ((html.match(/class="acronym-letter"/g) || []).length !== 7) throw new Error("AMBIENT title must expose seven emphasized acronym letters");
if ((html.match(/class="acronym-line"/g) || []).length !== 7) throw new Error("AMBIENT title must align all seven words on separate lines");
if (!html.includes("Agentic Memory: Baseline Isolated Evaluation, Normalized Tiers.")) throw new Error("AMBIENT expansion is missing");
if (html.includes("Baseline-Isolated") || html.includes("Baseline-isolated")) throw new Error("retired hyphenated AMBIENT expansion remains");
if (html.includes("One reader. Four conditions.") || html.includes("Current public evidence")) throw new Error("retired redundant design or evidence section remains");
if (!html.includes("GitHub repository") || !html.includes("canonical protocol, full local runner")) throw new Error("GitHub repository distribution is missing");
if (!html.includes('<a href="/leaderboard.html">Board</a>') || html.includes('<a href="/leaderboard.html">Results</a>')) throw new Error("primary navigation must label the leaderboard as Board");
if (!html.includes("Bring the model. Choose the memory.") || !html.includes("This is not a model leaderboard")) throw new Error("hosted runner purpose is not explicit");
if (!html.includes("automatically recorded on the separate hosted-results board")) throw new Error("hosted run publication boundary is missing");
if (!html.includes("Read the ability guide") || !html.includes("docs/10_AMBIENT_SUITE.md")) throw new Error("ability documentation link is missing");
if (html.includes("definitions")) throw new Error("retired definitions wording remains on the homepage");
const measuresIndex = html.indexOf('id="measures"');
const runIndex = html.indexOf('id="run"');
if (!(measuresIndex >= 0 && measuresIndex < runIndex)) throw new Error("ability inventory must sit before execution choices");
if (html.includes('id="question"') || html.includes("Did memory make the answer possible?") || html.includes("What the score means")) throw new Error("retired research-question section remains");
const measureSection = html.slice(measuresIndex, runIndex);
if ((measureSection.match(/<article>/g) || []).length !== 15) throw new Error("ability inventory must contain fifteen explained abilities");
if (!measureSection.includes("Declines when the record cannot support an answer") || !measureSection.includes("Proves served items belong to the recorded set")) throw new Error("ability inventory explanations are missing");
if (!html.includes('href="#run"') || !html.includes('id="run"')) throw new Error("main-page run and download section is missing");
const instrumentIndex = html.indexOf('class="instrument-scroll"');
const runSection = html.slice(runIndex, instrumentIndex);
if (!runSection.includes("Download it.<br />Or run it from<br />a HF Space.")) throw new Error("primary execution introduction or required line breaks are missing");
const distributionIndex = html.indexOf('id="distribution"');
const distributionSection = html.slice(distributionIndex, html.indexOf("</main>"));
if (!(distributionIndex > html.indexOf('id="reporting"')) || !distributionSection.includes("Bring the model. Choose the memory.") || !distributionSection.includes("complete 400-question run") || !distributionSection.includes("canonical protocol, full local runner")) throw new Error("hosted-run explanation is not in the final distribution section");
if ((html.match(/Bring the model\. Choose the memory\./g) || []).length !== 1) throw new Error("distribution explanation is duplicated");
if (html.includes('aria-label="Result interpretation"') || html.includes("T3 reports the complete system and is not used for that attribution")) throw new Error("retired oversized result-interpretation block remains");
if (html.includes("status-ledger")) throw new Error("retired release-status ledger remains");
if (!html.includes("Does the memory help?")) throw new Error("outcome-focused result framing is missing");
if (!html.includes("Correct because memory served it") || !html.includes("Correct but untraced · zero memory credit")) throw new Error("memory-attribution scoring example is missing");
if (html.includes("Results are divided into two tracks") || html.includes("track-table")) throw new Error("redundant reporting-track explainer remains");
if ((html.match(/data-credit-example/g) || []).length !== 3 || (html.match(/data-no-credit-example/g) || []).length !== 3) throw new Error("scoring section must show three credit and three no-credit examples");
if (html.includes("The site is on Vercel")) throw new Error("public copy must remain hosting-provider neutral");
const retiredProvider = ["Higgs", "field"].join("");
if (html.includes(retiredProvider) || html.includes("ambient-hero-")) throw new Error("retired hero provenance remains in public copy");
if (!html.includes('src="/assets/ambient-architecture.png"')) throw new Error("editorial architecture plate is missing");
if (!html.includes('href="/privacy.html"') || !html.includes('href="/terms.html"')) throw new Error("legal footer links are missing");
if (!html.includes('href="/leaderboard.html"') || !html.includes('href="/license.html"')) throw new Error("leaderboard or MIT license link is missing");
if (html.includes("github.com/H-XX-D/ambient-benchmark/blob/main/")) throw new Error("GitHub links must use the repository default branch");
if (status.adapterSmoke?.publishableAsQualityResult !== false) throw new Error("mock adapter smoke must not be publishable as quality evidence");
if (status.schema !== "ambient.site-status.v1") throw new Error(`unexpected site status schema ${status.schema}`);
if (leaderboard.schema !== "ambient.leaderboard.v1") throw new Error(`unexpected leaderboard schema ${leaderboard.schema}`);
if (!Array.isArray(leaderboard.entries) || leaderboard.entryCount !== leaderboard.entries.length) throw new Error("leaderboard entry count is inconsistent");
if (!leaderboard.ranking?.architecture?.includes("T4 − T1")) throw new Error("architecture leaderboard metric is not explicit");
if (status.publicEvidence?.publishableComparisons !== leaderboard.entries.length) throw new Error("site status and leaderboard count disagree");
const privacy = readFileSync(join(ROOT, "site/privacy.html"), "utf8");
const terms = readFileSync(join(ROOT, "site/terms.html"), "utf8");
const runHtml = readFileSync(join(ROOT, "site/run.html"), "utf8");
const boardHtml = readFileSync(join(ROOT, "site/leaderboard.html"), "utf8");
const boardJs = readFileSync(join(ROOT, "site/leaderboard.js"), "utf8");
const migration = readFileSync(join(ROOT, "supabase/migrations/20260727082205_ambient_leaderboard.sql"), "utf8");
const hostedMigration = readFileSync(join(ROOT, "supabase/migrations/20260727112324_ambient_hosted_runs.sql"), "utf8");
const vercel = readFileSync(join(ROOT, "vercel.json"), "utf8");
const licenseHtml = readFileSync(join(ROOT, "site/license.html"), "utf8");
const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const styles = readFileSync(join(ROOT, "site/styles.css"), "utf8");
if (!styles.includes(".publication-title .kicker") || !styles.includes("font-size: clamp(3.3rem, 7.4vw, 8rem)")) throw new Error("Agentic Memory is not scaled with the AMBIENT title stack");
if (!styles.includes(".acronym-letter { color: var(--signal); font-weight: 800; }") || !styles.includes("font-size: clamp(1.8rem, 9.4vw, 3.1rem)")) throw new Error("AMBIENT acronym emphasis or mobile fit guard is missing");
if (!styles.includes(".attribution-grid .attribution-good > span { color: #277045; }")) throw new Error("memory-credit label must use the positive green color");
if (!privacy.includes("does not receive, proxy, or store a Hugging Face OAuth token") || !privacy.includes("inference-api") || !privacy.includes("AMBIENT_SUPABASE_SECRET_KEY")) throw new Error("hosted runner OAuth disclosure is missing");
if (!privacy.includes("leaderboard reads public result rows from Supabase")) throw new Error("Supabase privacy disclosure is missing");
if (!terms.includes("Hosted and local runs") || !terms.includes("MIT License")) throw new Error("terms distribution or license disclosure is missing");
if (!terms.includes("complete 400-question run") || !terms.includes("separately labeled hosted-results board")) throw new Error("terms publication boundary is missing");
if (!terms.includes("verified architecture leaderboard still requires a complete evidence bundle")) throw new Error("terms leaderboard disclosure is missing");
if (!boardHtml.includes("Leaderboard<br />qualifications.") || boardHtml.includes("definitions")) throw new Error("leaderboard qualifications heading is missing or retired definitions wording remains");
if (!boardHtml.includes("What qualifies for each board") || !boardHtml.includes("1,600 judged rows") || !boardHtml.includes("at least 30 unique questions") || !boardHtml.includes("Native capture, embeddings, rerankers, and query-time models are allowed")) throw new Error("leaderboard qualification gates are incomplete");
if (!boardHtml.includes("What a leaderboard run involves") || !boardHtml.includes("Expose an observable memory query") || !boardHtml.includes("Run every question four ways") || !boardHtml.includes("Keep the full evidence trail") || !boardHtml.includes("Match the right board")) throw new Error("leaderboard participant expectations are incomplete");
if (!boardHtml.includes("Inside the 400-question hosted test") || !boardHtml.includes("40 unique questions in each of ten memory families") || !boardHtml.includes("producing 1,600 judged rows")) throw new Error("hosted test composition is incomplete");
if ((boardHtml.match(/data-test-spec/g) || []).length !== 10 || (boardHtml.match(/<dt>What it tests<\/dt>/g) || []).length !== 10 || (boardHtml.match(/<dt>Why it’s difficult<\/dt>/g) || []).length !== 10) throw new Error("leaderboard test difficulty grid must explain all ten hosted families");
for (const ability of ["Knowledge update", "Contradiction resolution", "Multi-session reasoning", "Temporal reasoning", "Event ordering", "Information extraction", "Preference following", "Instruction following", "Summarization", "Abstention"]) {
  if (!boardHtml.includes(`<h3>${ability}</h3>`)) throw new Error(`leaderboard test grid is missing ${ability}`);
}
if (!boardHtml.includes("T4 bespoke agentic memory minus T1 no-memory baseline") || !boardHtml.includes("Native system track")) throw new Error("leaderboard track disclosure is missing");
if (!boardHtml.includes("Complete hosted runs") || !boardHtml.includes("automatic and unreviewed")) throw new Error("hosted leaderboard disclosure is missing");
if (!boardJs.includes("textContent") || boardJs.includes("innerHTML")) throw new Error("leaderboard renderer must use safe text nodes");
if (!runHtml.includes("Download from GitHub") || !runHtml.includes("Run in Hugging Face") || !runHtml.includes("github.com/H-XX-D/ambient-benchmark") || !runHtml.includes("tjhendrix-ambient-benchmark.hf.space")) throw new Error("GitHub download or Hugging Face execution path is missing");
if (runHtml.includes("Baseline-Isolated")) throw new Error("retired hyphenated AMBIENT expansion remains on the run page");
if (runHtml.includes('type="password"') || runHtml.includes("API key or token") || runHtml.includes("credential_consent") || runHtml.includes("/run.js")) throw new Error("manual credential collection remains in the public runner page");
if (!boardJs.includes("sb_publishable_") || !boardJs.includes("publication_status")) throw new Error("live Supabase leaderboard configuration is missing");
if (boardJs.includes("sb_secret_") || boardJs.includes("service_role")) throw new Error("privileged Supabase credentials must not appear in browser code");
if (!migration.includes("enable row level security") || !migration.includes("to anon, authenticated") || !migration.includes("publication_status = 'verified'")) throw new Error("leaderboard RLS migration is incomplete");
if (!hostedMigration.includes("enable row level security") || !hostedMigration.includes("to anon, authenticated") || !hostedMigration.includes("publication_status = 'hosted'") || !hostedMigration.includes("item_count = 400")) throw new Error("hosted leaderboard RLS or completion gate is incomplete");
if (!vercel.includes("https://nasxywilptctmfdbfpdw.supabase.co")) throw new Error("required Supabase origin is missing from the content security policy");
if (!vercel.includes('"source": "/run"') || !vercel.includes('"destination": "/#run"')) throw new Error("retired standalone run page does not redirect to the main-page execution section");
if (vercel.includes("wss://tjhendrix-ambient-benchmark.hf.space") || vercel.includes("connect-src 'self' https://nasxywilptctmfdbfpdw.supabase.co https://huggingface.co")) throw new Error("obsolete Hugging Face browser-client origins remain in the content security policy");
if (!license.startsWith("MIT License\n")) throw new Error("root license is not MIT");
if (!licenseHtml.includes("Copyright (c) 2026 hendrixx-cnc")) throw new Error("served MIT license does not match the repository license");
if (packageJson.license !== "MIT") throw new Error("package license is not MIT");
if (packageJson.dependencies?.["@gradio/client"] || packageJson.devDependencies?.esbuild) throw new Error("obsolete browser runner dependencies remain installed");
console.log("site evidence and disclosure gate passed");
