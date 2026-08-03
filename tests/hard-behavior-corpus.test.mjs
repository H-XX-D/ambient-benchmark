import test from "node:test";
import assert from "node:assert/strict";
import {
  HARD_BEHAVIOR_ABILITIES,
  generateHardCorpus,
  generateHardScenario,
  gradeHardAnswer,
  validateHardScenario,
} from "../corpora/hard-behavior-core.mjs";

test("hard corpus covers every declared reader-facing ability with valid generated worlds", () => {
  const corpus = generateHardCorpus("small", 2);
  assert.equal(corpus.length, HARD_BEHAVIOR_ABILITIES.length * 2);
  assert.deepEqual(new Set(corpus.map((item) => item.ability)), new Set(HARD_BEHAVIOR_ABILITIES));
  for (const item of corpus) assert.deepEqual(validateHardScenario(item), [], item.id);
});

test("hard worlds are deterministic by seed and independent across seeds", () => {
  const a = generateHardScenario("multi-session-reasoning", "seed-a", "small");
  const again = generateHardScenario("multi-session-reasoning", "seed-a", "small");
  const b = generateHardScenario("multi-session-reasoning", "seed-b", "small");
  assert.deepEqual(a, again);
  assert.notEqual(a.oracle.expected, b.oracle.expected);
  assert.notEqual(a.conversationId, b.conversationId);
});

test("confirmatory corpus uses a disjoint seed namespace from calibration", () => {
  const calibration = generateHardCorpus("small", 1, "calibration-v1");
  const confirmatory = generateHardCorpus("small", 1, "confirmatory-v2");
  assert.equal(calibration.length, confirmatory.length);
  assert.deepEqual(new Set(calibration.map((item) => item.ability)), new Set(confirmatory.map((item) => item.ability)));
  assert.ok(calibration.every((item, index) => item.id !== confirmatory[index].id));
  assert.ok(calibration.every((item, index) => item.oracle.abstention || item.oracle.expected !== confirmatory[index].oracle.expected));
});

test("large worlds materially increase temporal and contextual difficulty", () => {
  const small = generateHardScenario("multi-session-reasoning", "same", "small");
  const large = generateHardScenario("multi-session-reasoning", "same", "large");
  assert.ok(large.difficulty.chainHops > small.difficulty.chainHops);
  assert.ok(large.events.length > small.events.length * 4);
  assert.ok(large.difficulty.sessions > small.difficulty.sessions);
});

test("mechanical scorer distinguishes correct, wrong, gullible, and abstention behavior", () => {
  const poison = generateHardScenario("poisoned-memory-quarantine", "score", "small");
  assert.equal(gradeHardAnswer(poison.oracle.expected, poison.oracle).verdict, "correct");
  assert.equal(gradeHardAnswer("totally-wrong", poison.oracle).verdict, "wrong");
  assert.equal(gradeHardAnswer(poison.oracle.protectedTokens[0], poison.oracle).verdict, "gullible");
  const absent = generateHardScenario("abstention", "absent", "small");
  assert.equal(gradeHardAnswer("UNKNOWN", absent.oracle).verdict, "correct");
  assert.equal(gradeHardAnswer("I guessed something", absent.oracle).verdict, "gullible");
});

test("mechanical conflict scorer accepts equivalent set order without relaxing ordered tasks", () => {
  const conflict = generateHardScenario("contradiction-resolution", "set-order", "small");
  const reversed = `CONFLICT=${[...conflict.oracle.conflictAlternatives].reverse().join(",")}`;
  assert.equal(gradeHardAnswer(reversed, conflict.oracle).verdict, "correct");
  assert.equal(gradeHardAnswer(`CONFLICT=${conflict.oracle.conflictAlternatives[0]}`, conflict.oracle).verdict, "gullible");

  const ordering = generateHardScenario("event-ordering", "strict-order", "small");
  assert.equal(gradeHardAnswer(ordering.oracle.expected.split(">").reverse().join(">"), ordering.oracle).verdict, "wrong");
});

test("derived answers are not copied verbatim from a single event", () => {
  for (const item of generateHardCorpus("small", 1).filter((row) => row.difficulty.requiresComposition && !row.difficulty.answerMayAppearVerbatim)) {
    const compact = item.oracle.expected.replace(/\s+/g, "").toUpperCase();
    assert.ok(item.events.every((event) => !event.text.replace(/\s+/g, "").toUpperCase().includes(compact)), item.id);
  }
});
