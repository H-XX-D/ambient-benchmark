#!/usr/bin/env node
// AMBIENT judge pass. Reads a four-tier transcript (from tiers/runner.mjs) and scores
// every answer correct / wrong / gullible, then aggregates per-tier completion, gullible
// rate, and the attribution deltas (T2/T4/T3 vs the T1 baseline).
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

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

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
      temperature: 0,
      max_tokens: 120,
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

function aggregate(verdicts) {
  const byTier = {};
  const byAbility = {};
  for (const v of verdicts) {
    const t = (byTier[v.tier] ??= { correct: 0, wrong: 0, gullible: 0, n: 0 });
    t[v.verdict]++;
    t.n++;
    const a = (byAbility[v.ability] ??= {});
    const at = (a[v.tier] ??= { correct: 0, gullible: 0, n: 0 });
    at.n++;
    if (v.verdict === "correct") at.correct++;
    if (v.verdict === "gullible") at.gullible++;
  }
  const pct = (c, n) => (n ? Math.round((100 * c) / n) : 0);
  const comp = (t) => pct((byTier[t] || {}).correct || 0, (byTier[t] || {}).n || 0);
  const d = (t) => comp(t) - comp("T1");
  return {
    byTier,
    byAbility,
    completion: Object.fromEntries(["T1", "T2", "T3", "T4"].map((t) => [t, comp(t)])),
    deltas: { T2: d("T2"), T4: d("T4"), T3: d("T3"), interaction: d("T3") - (d("T2") + d("T4")) },
  };
}

async function main() {
  const rows = readFileSync(TRANSCRIPT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
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
    verdicts.push({ segId: r.segId, tier: r.tier, ability: r.ability, tag: r.tag, storeCall: r.storeCall, ...v });
    process.stdout.write(`\r  ${++done}/${rows.length}`);
  }
  console.log("");

  const agg = aggregate(verdicts);
  console.log("\nTIER   completion  gullible  n");
  for (const t of ["T1", "T2", "T3", "T4"]) {
    const s = agg.byTier[t] || { correct: 0, gullible: 0, n: 0 };
    const pct = (c) => (s.n ? Math.round((100 * c) / s.n) : 0);
    console.log(`  ${t}   ${(pct(s.correct) + "%").padStart(7)}  ${(pct(s.gullible) + "%").padStart(7)}  ${String(s.n).padStart(3)}`);
  }
  console.log("\nAttribution (completion vs T1 baseline):");
  console.log(`  T2 auto only   : ${agg.deltas.T2 >= 0 ? "+" : ""}${agg.deltas.T2} pts`);
  console.log(`  T4 custom only : ${agg.deltas.T4 >= 0 ? "+" : ""}${agg.deltas.T4} pts`);
  console.log(`  T3 auto+custom : ${agg.deltas.T3 >= 0 ? "+" : ""}${agg.deltas.T3} pts`);
  console.log(`  interaction    : ${agg.deltas.interaction >= 0 ? "+" : ""}${agg.deltas.interaction} pts`);

  const out = TRANSCRIPT.replace(/transcript-/, "verdicts-");
  writeFileSync(out, verdicts.map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(out.replace(/\.jsonl$/, "-summary.json"), JSON.stringify(agg, null, 2));
  console.log(`\nwrote ${basename(out)} + summary`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
