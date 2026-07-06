#!/usr/bin/env node
// AMBIENT contradiction corpus (area 5: unprompted contradiction detection).
//
// This entire file measured src/core/contradiction-detect.ts's
// detectAndLinkUnpromptedContradictions — an admission-time auto-detector
// that does not exist anywhere in the vendored public Recall build, and does
// not exist under any name in the current live Recall repo either (checked
// against source, not a grep miss). Public Recall has no unprompted lexical/
// polarity contradiction detection: only an explicit `contradicts` relation
// a writer can declare at admit time (see ROADMAP.md, step 3/3b notes).
//
// Per AMBIENT's own stated policy ("areas that need external fixtures are
// reported UNTESTED with the reason, never silently passed"), this reports
// UNTESTED rather than crashing on the missing import, silently passing, or
// fabricating a stand-in detector — that would be redesigning the test
// around a capability gap, not measuring what's actually there.
//
// Usage: node suites/ambient/ambient-contradiction-corpus.mjs [--tier lite|full|hard]

const tier = (() => {
  const i = process.argv.indexOf("--tier");
  return i >= 0 ? process.argv[i + 1] : "full";
})();

console.log(`\n==================== AMBIENT contradiction corpus, tier=${tier} ====================\n`);
console.log("UNTESTED: no unprompted lexical/polarity contradiction detector exists in public Recall.");
console.log("Contradiction is writer-declared via an explicit `contradicts` edge at admit time,");
console.log("not auto-detected from raw text. See area 5 CONTRADICTION in ambient-suite.mjs and");
console.log("ROADMAP.md for the full note.\n");

// Not a failure: an honestly-reported capability gap is not the same as a
// broken or regressed test. Exit 0.
process.exit(0);
