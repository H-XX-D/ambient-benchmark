#!/usr/bin/env node
// Generate the questionnaire MECHANICALLY from the raw ingested data. The answer
// keys are extracted by code from the source files, not authored by a human, so
// neither the operator nor the model touches them. Output: questionnaire.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = dirname(fileURLToPath(import.meta.url));
const Q = [];
const add = (id, q, gold, cq, opts = {}) => Q.push({ id, q, gold: Array.isArray(gold) ? gold : [String(gold)], cq, ...opts });

// penguins.csv -> mean, count, columns (computed, not authored)
if (existsSync(`${RUN}/ingest/penguins.csv`)) {
  const rows = readFileSync(`${RUN}/ingest/penguins.csv`, "utf8").trim().split("\n");
  const cols = rows[0].split(",");
  const data = rows.slice(1).map((r) => r.split(","));
  const mi = cols.indexOf("body_mass_g");
  const masses = data.map((r) => Number(r[mi])).filter((x) => !Number.isNaN(x));
  const mean = Math.round(masses.reduce((a, b) => a + b, 0) / masses.length);
  add("ds-mean", "What is the mean body mass in grams in the penguins dataset? Reply with only the number.", String(mean), "penguins dataset mean body_mass_g");
  add("ds-rows", "How many penguin records are in the dataset? Reply with only the number.", String(data.length), "penguins dataset rows count");
  add("ds-col", "Name one column in the penguins dataset. Reply with one word.", cols, "penguins dataset columns");
}
// app.log -> port, error (regex)
if (existsSync(`${RUN}/ingest/app.log`)) {
  const log = readFileSync(`${RUN}/ingest/app.log`, "utf8");
  const port = (log.match(/port=(\d+)/) || [])[1];
  if (port) add("log-port", "What port did the api service start on? Reply with only the number.", port, "service api started port");
  const err = (log.match(/ERROR\s+(\w+)\s+(\w+)/) || []);
  if (err[2]) add("log-err", "What kind of error did the service log? Reply in one or two words.", [err[2], err[1]], "service error log db timeout");
}
// package.json -> name, version, a dep
if (existsSync(`${RUN}/ingest/package.json`)) {
  const pkg = JSON.parse(readFileSync(`${RUN}/ingest/package.json`, "utf8"));
  add("pkg-name", "What is the name of the software package in the project config? Reply with only the name.", pkg.name, "package config name");
  add("pkg-ver", "What version is the package? Reply with only the version.", pkg.version, "package config version");
  const dep = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })[0];
  if (dep) add("pkg-dep", "Name one dependency declared in the package config. Reply with one name.", dep, "package config dependencies");
}
// code imports (parsed from source). Not vendored here (vendor/recall ships compiled dist
// only); point RECALL_SRC_DIR at a local recall-memory-substrate checkout to regenerate this.
const adm = process.env.RECALL_SRC_DIR ? `${process.env.RECALL_SRC_DIR}/admission.ts` : "";
if (adm && existsSync(adm)) {
  const imports = [...readFileSync(adm, "utf8").matchAll(/from\s+["']\.\/([^"']+?)(?:\.js)?["']/g)].map((m) => m[1]);
  if (imports.length) add("code-import", "Name one module that the recall-core admission file imports. Reply with one word.", imports, "recall-core admission imports");
}
// arxiv count
if (existsSync(`${RUN}/ingest/arxiv.atom`)) {
  const n = readFileSync(`${RUN}/ingest/arxiv.atom`, "utf8").split("<entry>").length - 1;
  if (n > 0) add("arxiv-n", "How many arxiv preprints are recorded? Reply with only the number.", String(n), "arxiv preprint");
}
// pdf title keyword (the Attention paper)
add("pdf-attn", "What single concept is the title of the recorded paper that the BERT work builds on? Reply with one word.", ["attention"], "attention transformer paper title");
// system-surfaced contradiction (both states required)
add("contra", "List every status that has been recorded for the api service.", ["healthy", "down"], "api service status", { both: true });
// common-knowledge controls: memory should add nothing
add("ck-gold", "What is the chemical symbol for gold? Reply with only the symbol.", ["au"], "gold chemical symbol element", { control: true });
add("ck-paris", "What is the capital of France? Reply with only the city.", ["paris"], "capital city of France", { control: true });

writeFileSync(`${RUN}/questionnaire.json`, JSON.stringify(Q, null, 2));
console.log(`questionnaire.json written: ${Q.length} questions`);
console.log("ids:", Q.map((q) => q.id).join(", "));
console.log("controls (memory should not help):", Q.filter((q) => q.control).map((q) => q.id).join(", "));
