// MODALITY (area 17): separate considered/hypothetical from happened/actual. The
// substrate has no automatic modal inference, but it can carry an explicit modal
// tag and isolate on it. This probe measures both: tag-based isolation works
// (hypotheticals never returned under an actuals filter), while automatic inference
// of modality from phrasing ("if ... then") is absent. Automatic modal inference is
// the open residual.
import { fileURLToPath } from "node:url";
import { fresh, done, reopen, W } from "./_lib.mjs";

export function runModality(n = 12) {
  const s = fresh();
  try {
    for (let i = 0; i < n; i++) {
      W(s.store, { title: `we shipped feature ${i}`, topics: ["modal:actual", "ship"], subject: [`feat${i}`] });
      W(s.store, { title: `if we ship feature ${i} then traffic rises`, topics: ["modal:hypothetical", "ship"], subject: [`feat${i}`] });
    }
    const reader = reopen(s);
    const all = reader.active();
    const actuals = all.filter((nd) => (nd.tags?.topics || []).includes("modal:actual"));
    const hypos = all.filter((nd) => (nd.tags?.topics || []).includes("modal:hypothetical"));
    const isolationOk = actuals.length === n && hypos.length === n && actuals.every((a) => !(a.tags.topics || []).includes("modal:hypothetical"));

    // untagged "if ... then": no modal inference means it is returned as a plain match
    const untagged = W(s.store, { title: `if we deploy on Friday then latency drops`, topics: ["deploy"], subject: ["deployq"] });
    const r2 = reopen(s);
    // search() returns hits shaped {cell, score}, not the cell directly.
    const autoInferenceAbsent = r2.search("deploy on Friday", { limit: 5 }).some((h) => h.cell.key === untagged.id);

    return {
      n: n * 2 + 1,
      metric: `tag-based modal isolation ${isolationOk ? `${n}/${n}` : "incomplete"}; automatic modal inference ${autoInferenceAbsent ? "absent" : "present"}`,
      grade: isolationOk ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED"
    };
  } finally { done(s); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(runModality());
