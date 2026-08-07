#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARD_BEHAVIOR_ABILITIES,
  HARD_SIZE_CONFIG,
  generateHardCorpus,
  validateHardScenario,
} from "./hard-behavior-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const size = process.argv[2] || "small";
if (!HARD_SIZE_CONFIG[size]) throw new Error(`size must be one of ${Object.keys(HARD_SIZE_CONFIG).join(", ")}`);
const countArg = process.argv.indexOf("--per-ability");
const perAbility = countArg >= 0 ? Number(process.argv[countArg + 1]) : HARD_SIZE_CONFIG[size].scenariosPerAbility;
const seedSetArg = process.argv.indexOf("--seed-set");
const seedSet = seedSetArg >= 0 ? process.argv[seedSetArg + 1] : "calibration-v1";
if (!/^[a-z0-9._-]+$/i.test(seedSet)) throw new Error("seed set must contain only letters, digits, dot, underscore, or hyphen");
const scenarios = generateHardCorpus(size, perAbility, seedSet);
const errors = scenarios.flatMap((item) => validateHardScenario(item).map((error) => `${item.id}: ${error}`));
if (errors.length) throw new Error(`hard corpus validation failed:\n${errors.join("\n")}`);

const outputName = seedSet === "calibration-v1" ? size : `${size}-${seedSet}`;
const output = join(ROOT, "corpora", "out", "hard", outputName);
const corpusDir = join(output, "corpus");
rmSync(output, { recursive: true, force: true });
mkdirSync(corpusDir, { recursive: true });

const segments = scenarios.map(({ events, ...item }) => item);
writeFileSync(join(output, "segments.jsonl"), segments.map((item) => JSON.stringify(item)).join("\n") + "\n");
for (const item of scenarios) {
  const name = item.conversationId.replace(/[/:]/g, "_") + ".jsonl";
  writeFileSync(join(corpusDir, name), item.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

console.log(`built ${scenarios.length} hard scenarios across ${HARD_BEHAVIOR_ABILITIES.length} abilities | seed-set=${seedSet} -> corpora/out/hard/${outputName}`);
for (const ability of HARD_BEHAVIOR_ABILITIES) {
  const rows = scenarios.filter((item) => item.ability === ability);
  const avgEvents = Math.round(rows.reduce((sum, item) => sum + item.events.length, 0) / rows.length);
  const avgSessions = Math.round(rows.reduce((sum, item) => sum + item.difficulty.sessions, 0) / rows.length);
  console.log(`  ${ability.padEnd(30)} ${String(rows.length).padStart(4)} worlds  avg-events=${String(avgEvents).padStart(4)}  avg-sessions=${String(avgSessions).padStart(3)}`);
}
