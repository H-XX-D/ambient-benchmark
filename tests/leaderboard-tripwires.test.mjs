// The tripwire table is the one place on the site that computes a number
// rather than printing one. Each test below fixes a concrete way the
// aggregation could be wrong and asserts the observable ranking or rate.
import test from "node:test";
import assert from "node:assert/strict";

import { aggregateTripwires } from "../site/leaderboard.js";

const ABILITIES = {
  "abstention": "Abstention",
  "contradiction-resolution": "Contradiction resolution",
  "poisoned-memory-quarantine": "Poisoned-memory quarantine",
};

const row = (memory, ability, rows, gullible, control = "ctl-1") =>
  ({ memory_name: memory, ability, rows, gullible, control_key: control });

test("sums counts across abilities into one row per system", () => {
  const out = aggregateTripwires([
    row("Alpha", "abstention", 30, 3),
    row("Alpha", "contradiction-resolution", 30, 1),
    row("Alpha", "poisoned-memory-quarantine", 40, 0),
  ], ABILITIES);
  assert.equal(out.length, 1);
  assert.equal(out[0].rows, 100, "tripwire rows must be the total across abilities");
  assert.equal(out[0].gullible, 4, "gullible must be the total across abilities");
});

test("ranks the least foolable system first, not the one with fewest hits", () => {
  const out = aggregateTripwires([
    // Beta has fewer absolute hits but a worse rate on far fewer rows.
    row("Alpha", "abstention", 100, 5),
    row("Beta", "abstention", 10, 3),
  ], ABILITIES);
  assert.deepEqual(out.map((entry) => entry.memory), ["Alpha", "Beta"],
    "ranking must use the rate, so a small sample with 3 hits cannot beat 5 hits in 100");
});

test("names the worst-performing wire, not merely the last one seen", () => {
  const out = aggregateTripwires([
    row("Alpha", "abstention", 20, 1),
    row("Alpha", "poisoned-memory-quarantine", 20, 9),
    row("Alpha", "contradiction-resolution", 20, 2),
  ], ABILITIES);
  assert.equal(out[0].worst, "Poisoned-memory quarantine",
    "the most-tripped wire is the one with the highest rate");
});

test("ignores rows naming an ability that is not a tripwire", () => {
  const out = aggregateTripwires([
    row("Alpha", "abstention", 10, 1),
    row("Alpha", "summarization", 90, 80),
  ], ABILITIES);
  assert.equal(out[0].rows, 10, "a non-tripwire ability must not inflate the denominator");
  assert.equal(out[0].gullible, 1, "a non-tripwire ability must not inflate the hit count");
});

test("keeps the same system separate under different control fingerprints", () => {
  const out = aggregateTripwires([
    row("Alpha", "abstention", 20, 0, "ctl-1"),
    row("Alpha", "abstention", 20, 10, "ctl-2"),
  ], ABILITIES);
  assert.equal(out.length, 2, "results under different controls are not comparable and must not merge");
  assert.deepEqual(out.map((entry) => entry.gullible), [0, 10]);
});

test("drops systems with no tripwire rows instead of dividing by zero", () => {
  const out = aggregateTripwires([
    row("Alpha", "abstention", 0, 0),
    row("Beta", "abstention", 10, 1),
  ], ABILITIES);
  assert.deepEqual(out.map((entry) => entry.memory), ["Beta"]);
  assert.ok(out.every((entry) => Number.isFinite(entry.gullible / entry.rows)),
    "no surviving row may produce a NaN rate");
});

test("a clean system reports zero and leads the board", () => {
  const out = aggregateTripwires([
    row("Clean", "abstention", 30, 0),
    row("Clean", "poisoned-memory-quarantine", 30, 0),
    row("Leaky", "abstention", 30, 1),
  ], ABILITIES);
  assert.equal(out[0].memory, "Clean");
  assert.equal(out[0].gullible, 0);
  assert.equal(out[0].worst, null, "a system that tripped nothing has no worst wire");
});
