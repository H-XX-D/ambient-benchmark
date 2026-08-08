// The publisher turns a certified bundle's verdicts into the rows that the
// ambient_tripwire_outcomes table stores. The numbers it emits become public,
// so every test pins an observable count against a hand-computable fixture and
// each fixture isolates one way the derivation could lie.
import test from "node:test";
import assert from "node:assert/strict";

import { deriveTripwireOutcomes, TRIPWIRE_ABILITIES } from "../scripts/publish-tripwire-outcomes.mjs";

const row = (ability, verdict, extra = {}) => ({
  segId: `${ability}-000`,
  tier: "T4",
  ability,
  verdict,
  oracle: { protectedHits: verdict === "gullible" ? ["DECOY-1"] : [] },
  ...extra,
});

test("the exported tripwire list matches the schema constraint exactly", () => {
  assert.deepEqual([...TRIPWIRE_ABILITIES].sort(), [
    "abstention",
    "belief-revision-audit",
    "contradiction-resolution",
    "knowledge-update",
    "poisoned-memory-quarantine",
    "trust-discrimination",
  ]);
});

test("counts rows and gullible verdicts per tripwire ability", () => {
  const out = deriveTripwireOutcomes([
    row("abstention", "correct"),
    row("abstention", "gullible"),
    row("abstention", "wrong"),
    row("trust-discrimination", "gullible"),
    row("trust-discrimination", "gullible"),
  ]);
  assert.deepEqual(out, [
    { ability: "abstention", rows: 3, gullible: 1 },
    { ability: "trust-discrimination", rows: 2, gullible: 2 },
  ]);
});

test("wrong is not gullible: only the gullible verdict counts as a decoy hit", () => {
  const out = deriveTripwireOutcomes([
    row("knowledge-update", "wrong"),
    row("knowledge-update", "wrong"),
    row("knowledge-update", "correct"),
  ]);
  assert.deepEqual(out, [{ ability: "knowledge-update", rows: 3, gullible: 0 }]);
});

test("non-tripwire abilities contribute nothing at all", () => {
  const out = deriveTripwireOutcomes([
    row("summarization", "gullible"),
    row("event-ordering", "gullible"),
    row("abstention", "correct"),
  ]);
  assert.deepEqual(out, [{ ability: "abstention", rows: 1, gullible: 0 }]);
});

test("abilities are reported in the canonical order, not first-seen order", () => {
  const out = deriveTripwireOutcomes([
    row("poisoned-memory-quarantine", "correct"),
    row("abstention", "correct"),
    row("knowledge-update", "correct"),
  ]);
  assert.deepEqual(out.map((entry) => entry.ability), [
    "abstention",
    "knowledge-update",
    "poisoned-memory-quarantine",
  ]);
});

test("an ability with no rows is omitted rather than emitted as zero over zero", () => {
  const out = deriveTripwireOutcomes([row("abstention", "gullible")]);
  assert.equal(out.length, 1, "only abilities that were actually scored may appear");
  assert.equal(out[0].ability, "abstention");
});

test("a decoy hit recorded by the oracle without a gullible verdict fails loudly", () => {
  // If the scorer and the protected-hit trail disagree, publishing either
  // number silently would misstate the run; the publisher must refuse.
  const inconsistent = row("abstention", "wrong");
  inconsistent.oracle = { protectedHits: ["DECOY-1"] };
  assert.throws(
    () => deriveTripwireOutcomes([row("abstention", "correct"), inconsistent]),
    /protectedHits|inconsisten/i,
  );
});

test("rows missing an ability field fail loudly instead of vanishing", () => {
  const broken = row("abstention", "correct");
  delete broken.ability;
  assert.throws(() => deriveTripwireOutcomes([broken]), /ability/i);
});
