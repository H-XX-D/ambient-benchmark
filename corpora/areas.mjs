#!/usr/bin/env node
// Assemble the authored AMBIENT "areas" suite (the 18-area port, expressed as answerable
// datasets) from the area-authoring workflow journals into the standard corpus format the
// four-tier runner consumes:
//   corpora/out/areas/<size>/segments.jsonl        (one segment per scenario)
//   corpora/out/areas/<size>/corpus/<conv>.jsonl   (the scenario's conversation events)
//
// Each authoring agent returned { key, area, scenarios:[{events,question,gold,tag,probe,...}] }.
// Every scenario becomes one segment (ability = the area key) with its own one-conversation corpus.
//
// Usage: node corpora/areas.mjs <size> <journal.jsonl> [<journal.jsonl> ...]

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = process.argv[2] || "small";
const JOURNALS = process.argv.slice(3);
if (!JOURNALS.length) {
  console.error("usage: node corpora/areas.mjs <size> <journal.jsonl> [more...]");
  process.exit(1);
}

const OUT = join(ROOT, "corpora", "out", "areas", SIZE);
const CORPUS = join(OUT, "corpus");

// area key -> canonical ability tag used in segments (stable, lowercase, hyphenated).
// Exact key match first (the authoring workflows set opts.key precisely); substring only
// as a fallback, ordered most-specific-first so "deep-contradiction" never collapses to
// "contradiction".
const EXACT = {
  contradiction: "contradiction",
  temporality: "temporality",
  "deep-contradiction": "deep-contradiction",
  "retrieval-fidelity": "retrieval-fidelity",
  supersession: "supersession",
  adversarial: "adversarial-robustness",
  modality: "modality",
  concurrency: "concurrency",
  endurance: "endurance",
  federation: "federation",
  attribution: "attribution",
  anteriority: "anteriority",
  "set-integrity": "set-integrity",
  calibration: "calibration",
  reactivity: "reactivity",
};
// The frozen-spec area NUMBER is the unambiguous signal (the area free-text can contain
// other areas' trap words, e.g. contradiction's blurb says "no supersession marker").
const BY_NUM = {
  1: "attribution", 2: "anteriority", 3: "attribution", 5: "contradiction",
  6: "set-integrity", 7: "calibration", 8: "reactivity", 9: "concurrency",
  10: "supersession", 11: "temporality", 12: "deep-contradiction",
  13: "retrieval-fidelity", 14: "adversarial-robustness", 15: "endurance",
  16: "federation", 17: "modality",
};
function abilityOf(key = "", area = "") {
  const k = String(key || "").toLowerCase().trim();
  if (EXACT[k]) return EXACT[k];
  const a = String(area || "").toLowerCase();
  // area number wins (first integer in the label, which is the frozen-spec area id)
  const num = (a.match(/\b(\d{1,2})\b/) || [])[1];
  if (num && BY_NUM[Number(num)]) return BY_NUM[Number(num)];
  // name-anchored fallback for numberless labels (SUPERSESSION-INTEGRITY, ATTRIBUTION..., ANTERIORITY, Calibration, Set-integrity)
  const named = ["supersession", "attribution", "anteriority", "set-integrity", "calibration", "reactivity", "temporality", "modality", "concurrency", "endurance", "federation", "deep-contradiction", "retrieval-fidelity", "adversarial", "contradiction"];
  for (const n of named) if (a.startsWith(n) || k.includes(n)) return n === "adversarial" ? "adversarial-robustness" : n;
  return (k || a).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
}

function readResults(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "result" && o.result && Array.isArray(o.result.scenarios)) out.push(o.result);
  }
  return out;
}

// gather all area results across journals
const areas = [];
for (const j of JOURNALS) areas.push(...readResults(j));
if (!areas.length) {
  console.error("no area results found in journals (agents may still be running)");
  process.exit(2);
}

// fresh output dir
rmSync(OUT, { recursive: true, force: true });
mkdirSync(CORPUS, { recursive: true });

const segments = [];
const perAbility = {};
for (const a of areas) {
  const ability = abilityOf(a.key, a.area);
  perAbility[ability] = (perAbility[ability] || 0) + a.scenarios.length;
  a.scenarios.forEach((s, i) => {
    const convId = `areas:${ability}:${i}`;
    const seg = {
      id: convId,
      ability,
      tag: s.tag || "novel",
      conversationId: convId,
      question: s.question,
      gold: s.gold,
      supportIds: null,
      probe: s.probe || "",
    };
    segments.push(seg);
    const events = (s.events || []).map((e, seq) => ({ seq, role: e.role, text: e.text }));
    const file = join(CORPUS, convId.replace(/[/:]/g, "_") + ".jsonl");
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });
}

writeFileSync(join(OUT, "segments.jsonl"), segments.map((s) => JSON.stringify(s)).join("\n") + "\n");

console.log(`assembled ${segments.length} segments across ${Object.keys(perAbility).length} areas -> corpora/out/areas/${SIZE}/`);
for (const [ab, n] of Object.entries(perAbility).sort()) console.log(`  ${ab.padEnd(22)} ${n}`);
