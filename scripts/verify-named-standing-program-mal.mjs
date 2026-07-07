#!/usr/bin/env node
// Smoke-test named MAL standing-program instances such as `addf watch0 tick`.

import {
  parseNetlist,
  loadNetlist,
  PROGRAM_OPERATIONS,
  runStandingPrograms,
  SqliteStore,
} from "../vendor/recall/dist/index.js";

const configByOperation = {
  allocate: "[query: benchmark priorities] [limit: 3]",
  drift: "[topics: api-status] [measure: effective_confidence] [delta: 0.20]",
  emit_witness: "[topics: api-status]",
  quorum: "[topics: api-status]",
  reflex: "[topics: api-status] [personality: 1]",
  score: "[topics: api-status]",
  tag_projection: "[topics: api-status] [family: topics]",
  trend: "[topics: api-status] [measure: effective_confidence] [delta: 0.10]",
  watch: "[query: payment gateway outage] [measure: effective_confidence] [delta: 0.15] [concernTarget: checkout]",
};

const scheduleLines = PROGRAM_OPERATIONS.map((operation) => {
  const config = configByOperation[operation] || "[topics: api-status]";
  return `addf ${operation}0 tick ${config}`;
});

const text = [
  ...scheduleLines,
  "setp watch0.delta 0.25",
  "setp drift0.delta 0.30",
].join("\n");

const store = new SqliteStore(":memory:");
const parsed = parseNetlist(text);
if (parsed.errors.length) {
  throw new Error(`MAL parse errors: ${JSON.stringify(parsed.errors)}`);
}

const loaded = loadNetlist(parsed.nodes, store);
if (loaded.unsupported.length) {
  throw new Error(`named standing-program form unsupported: ${JSON.stringify(loaded.unsupported)}`);
}
if (loaded.programsCreated.length !== PROGRAM_OPERATIONS.length) {
  throw new Error(`expected ${PROGRAM_OPERATIONS.length} named programs, got ${loaded.programsCreated.length}`);
}
if (loaded.paramsSet.length !== 2) {
  throw new Error(`expected two setp updates, got ${loaded.paramsSet.length}`);
}

const programs = store.active()
  .filter((cell) => cell.kind === "prg")
  .sort((a, b) => a.props.program.operation.localeCompare(b.props.program.operation));
const operations = programs.map((cell) => cell.props.program.operation);
const expectedOperations = PROGRAM_OPERATIONS.map((operation) => `${operation}0`).sort();
if (operations.join(",") !== expectedOperations.join(",")) {
  throw new Error(`unexpected named operations: ${operations.join(",")}`);
}

const watch0 = programs.find((cell) => cell.props.program.operation === "watch0");
if (watch0.props.program.params.delta !== 0.25) {
  throw new Error("setp watch0.delta did not update the named instance");
}
const drift0 = programs.find((cell) => cell.props.program.operation === "drift0");
if (drift0.props.program.params.delta !== 0.30) {
  throw new Error("setp drift0.delta did not update the named instance");
}

const runs = runStandingPrograms(store, new Date().toISOString()).runs;
const runOperations = runs.map((run) => run.operation).sort();
if (runOperations.join(",") !== expectedOperations.join(",")) {
  throw new Error(`expected standing runs for all named programs, got ${runOperations.join(",")}`);
}

const baseOutputs = new Map(runs.map((run) => [run.operation, run.output.operation]));
for (const operation of PROGRAM_OPERATIONS) {
  const named = `${operation}0`;
  if (baseOutputs.get(named) !== operation) {
    throw new Error(`${named} must execute base operation ${operation}, got ${baseOutputs.get(named)}`);
  }
}

console.log(`named MAL standing-program smoke: ${PROGRAM_OPERATIONS.map((op) => `${op}0`).join(", ")} verified`);
