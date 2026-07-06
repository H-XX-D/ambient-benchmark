// AMBIENT MemoryAdapter contract (v0 draft).
//
// The ONE mandatory capability is an observable query: query() returns, for a
// question, the information the system served. The harness invokes this call, so it
// watches the round trip (query, information back, response) and knows the content came
// from outside the model without the system citing itself. An answer scores only when
// it is correct AND the harness watched a store call supply the support (see
// docs/ATTRIBUTION.md and RULES.md). Per-item provenance below is recommended, not
// required.

/**
 * @typedef {Object} ProvenanceItem
 * @property {string} id          stable id of the served item in the store
 * @property {"external"|"model"} origin
 *   "external" marks store-served context (the only kind that can complete a
 *   segment); "model" marks context the system attributes to the model's own
 *   knowledge, which never completes a segment.
 * @property {string} [source]    source document or stream the item came from
 * @property {string} [writtenAt] when it entered the store (ISO 8601)
 */

/**
 * @typedef {Object} Served
 * @property {string[]} support             context passages/facts served for the question
 * @property {ProvenanceItem[]} provenance  where each served item originated.
 *   REQUIRED: without external-origin provenance a correct answer cannot complete
 *   a segment.
 */

export class MemoryAdapter {
  /** system name, e.g. "recall", "mem0", "baseline-pull" */
  get name() {
    throw new Error("adapter must set name");
  }

  /** ingest one fact/event; return a receipt id. */
  async write(fact) {
    throw new Error("not implemented");
  }

  /**
   * answer-support for a question, WITH provenance marking external vs model origin.
   * @returns {Promise<Served>}  MANDATORY. This is the entry requirement.
   */
  async query(question) {
    throw new Error("not implemented");
  }

  /**
   * OPTIONAL push hook: given a newly written fact, does the system surface,
   * unprompted, that it invalidates a prior belief? Systems without a push axis
   * return {supported:false} and are graded ABSENT on push rungs, never FAILED.
   */
  async surface(newFact) {
    return { supported: false };
  }

  /** OPTIONAL: toggle automatic capture for the tier ablation (T2/T3 vs T4). */
  async setAutoCapture(enabled) {
    return { supported: false };
  }
}

/**
 * scoreSegment - reference scorer. A segment completes iff the answer is correct
 * AND at least one served item traces to origin "external". Correct with only
 * model-origin support is UNTRACED (shadow/model knowledge), not credited to the
 * memory. Wrong or unserved is MISSED.
 *
 * @param {{ correct: boolean, served: Served }} attempt
 * @returns {"COMPLETED"|"UNTRACED"|"MISSED"}
 */
export function scoreSegment({ correct, served }) {
  if (!correct) return "MISSED";
  const external = served?.provenance?.some((p) => p.origin === "external");
  return external ? "COMPLETED" : "UNTRACED";
}
