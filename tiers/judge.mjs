#!/usr/bin/env node
// AMBIENT judge pass. Reads a four-tier transcript (from tiers/runner.mjs) and scores
// every answer correct / wrong / gullible. A deterministic second stage combines that
// semantic verdict with the harness trace, then aggregates answer accuracy separately
// from memory completion and attribution deltas (T2/T4/T3 vs T1).
//
// THE JUDGE IS A FRONTIER MODEL, NOT THE LOCAL READER. Judging runs through a quality API
// or a subscription harness (Claude, GPT, Gemini), separate from the fixed reader: a model
// must not grade its own output, and a weak local reader cannot judge reliably (BEAM uses a
// gpt-4o nugget judge). Pin the judge model + version for reproducibility. STRICT RUBRIC: a
// decline on an answerable question is WRONG, not correct; crediting a non-answer destroys
// the ablation (this alone flipped a run from -9 to +16 pts).
//
// Verdicts:
//   correct  - conveys the gold's key content; for an abstention row, correctly declines.
//   gullible - fooled: answered an abstention row, or asserted one side of a flagged
//              contradiction, or swallowed misleading/absent input.
//   wrong    - incorrect on an answerable question, or declined when the record answers.
//
// Configure the judge model via env (keep it stronger than the reader):
//   AMBIENT_JUDGE_ENDPOINT (default http://localhost:8089/v1)
//   AMBIENT_JUDGE_MODEL, AMBIENT_JUDGE_KEY
//
// Usage: node tiers/judge.mjs results/transcript-<source>-<size>.jsonl

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { aggregateAttributedVerdicts, attributedVerdict } from "./attribution.mjs";

const TRANSCRIPT = process.argv[2];
if (!TRANSCRIPT) {
  console.error("usage: node tiers/judge.mjs <transcript.jsonl>");
  process.exit(1);
}
const ENV = (k, d) => globalThis.process?.env?.[k] ?? d;
const JUDGE = {
  endpoint: ENV("AMBIENT_JUDGE_ENDPOINT", "http://localhost:8089/v1"),
  model: ENV("AMBIENT_JUDGE_MODEL", "judge"),
  key: ENV("AMBIENT_JUDGE_KEY", "no-key"),
};
const JUDGE_PARAMS = { temperature: 0, maxTokens: 120 };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const RUBRIC =
  "You are the AMBIENT judge. Given a benchmark row, output STRICT JSON " +
  '{"verdict":"correct|wrong|gullible","reason":"<short>"}. ' +
  "correct: the answer conveys the gold's key content (nugget/semantic match); for an " +
  "abstention row (tag=abstention, the record has no answer) correct means the model " +
  "declined or said it does not know. gullible: the model was fooled - it answered an " +
  "abstention row instead of declining, or asserted one side of a flagged contradiction, " +
  "or swallowed misleading/absent input. wrong: incorrect on an answerable question, or " +
  "it declined when the record can answer.";

async function judgeOne(row) {
  const user =
    `tag: ${row.tag}\nquestion: ${row.question}\ngold: ${row.gold}\nanswer: ${row.answer}\n\n` +
    "Verdict as strict JSON only.";
  const headers = { "Content-Type": "application/json" };
  if (JUDGE.key && JUDGE.key !== "no-key") headers.Authorization = `Bearer ${JUDGE.key}`;
  const res = await fetch(`${JUDGE.endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: JUDGE.model,
      messages: [
        { role: "system", content: RUBRIC },
        { role: "user", content: user },
      ],
      temperature: JUDGE_PARAMS.temperature,
      max_tokens: JUDGE_PARAMS.maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const txt = (await res.json()).choices?.[0]?.message?.content ?? "";
  return parseVerdict(txt);
}

function parseVerdict(txt) {
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      if (["correct", "wrong", "gullible"].includes(o.verdict)) return { verdict: o.verdict, reason: o.reason ?? "" };
    }
  } catch {
    // fall through to keyword scan
  }
  const t = txt.toLowerCase();
  const v = /gullible/.test(t) ? "gullible" : /correct/.test(t) ? "correct" : "wrong";
  return { verdict: v, reason: "parsed-from-text" };
}

async function main() {
  const transcriptBytes = readFileSync(TRANSCRIPT);
  const rows = transcriptBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`judging ${rows.length} rows | judge model=${JUDGE.model} @ ${JUDGE.endpoint}`);
  const verdicts = [];
  let done = 0;
  for (const r of rows) {
    let v;
    try {
      v = await judgeOne(r);
    } catch (e) {
      v = { verdict: "wrong", reason: "judge error: " + e.message };
    }
    const attributed = attributedVerdict(r, v);
    verdicts.push({
      runId: r.runId ?? null,
      replicate: r.replicate ?? 0,
      segId: r.segId,
      tier: r.tier,
      ability: r.ability,
      tag: r.tag,
      storeCall: r.storeCall,
      servedCount: r.servedCount,
      verdict: attributed.semanticVerdict,
      ...attributed,
    });
    process.stdout.write(`\r  ${++done}/${rows.length}`);
  }
  console.log("");

  const agg = aggregateAttributedVerdicts(verdicts);
  console.log("\nTIER   answer-accuracy  memory-completion  gullible  untraced  not-served  n");
  for (const t of ["T1", "T2", "T3", "T4"]) {
    const s = agg.byTier[t] || { correct: 0, completed: 0, gullible: 0, untraced: 0, notServed: 0, n: 0 };
    const pct = (c) => (s.n ? Math.round((100 * c) / s.n) : 0);
    console.log(
      `  ${t}   ${(pct(s.correct) + "%").padStart(15)}  ${(pct(s.completed) + "%").padStart(17)}  ` +
      `${(pct(s.gullible) + "%").padStart(8)}  ${(pct(s.untraced) + "%").padStart(9)}  ` +
      `${(pct(s.notServed) + "%").padStart(10)}  ${String(s.n).padStart(3)}`,
    );
  }
  console.log("\nAttribution (completion vs T1 baseline):");
  console.log(`  T2 auto only   : ${agg.deltas.T2 >= 0 ? "+" : ""}${agg.deltas.T2} pts`);
  console.log(`  T4 custom only : ${agg.deltas.T4 >= 0 ? "+" : ""}${agg.deltas.T4} pts`);
  console.log(`  T3 auto+custom : ${agg.deltas.T3 >= 0 ? "+" : ""}${agg.deltas.T3} pts`);
  console.log(`  interaction    : ${agg.deltas.interaction >= 0 ? "+" : ""}${agg.deltas.interaction} pts`);

  const out = TRANSCRIPT.replace(/transcript-/, "verdicts-");
  writeFileSync(out, verdicts.map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(out.replace(/\.jsonl$/, "-summary.json"), JSON.stringify(agg, null, 2));
  const judgeErrors = verdicts.filter((row) => String(row.reason).startsWith("judge error:")).length;
  const runIds = [...new Set(rows.map((row) => row.runId).filter(Boolean))];
  const judgeSpec = {
    endpoint: JUDGE.endpoint,
    model: JUDGE.model,
    ...JUDGE_PARAMS,
    rubricSha256: sha256(RUBRIC),
  };
  judgeSpec.fingerprint = sha256(JSON.stringify(judgeSpec));
  const judgeManifest = {
    schema: "ambient.judge-manifest.v1",
    generatedAt: new Date().toISOString(),
    transcript: TRANSCRIPT,
    transcriptSha256: sha256(transcriptBytes),
    runIds,
    rows: rows.length,
    judge: judgeSpec,
    judgeErrors,
    validForPublication: judgeErrors === 0 && runIds.length === 1,
  };
  const judgeManifestOut = out.replace(/verdicts-/, "judge-manifest-").replace(/\.jsonl$/, ".json");
  writeFileSync(judgeManifestOut, JSON.stringify(judgeManifest, null, 2) + "\n");
  console.log(`\nwrote ${basename(out)} + summary + ${basename(judgeManifestOut)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
