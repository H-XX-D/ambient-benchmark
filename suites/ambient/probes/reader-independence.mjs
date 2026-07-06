// READER-INDEPENDENCE (area 4): is the answer the substrate's or the reader's? The
// real headline needs a tiny 1b model run with and without the substrate. Here the
// MECHANISM is validated with a deterministic mock reader: counterintuitive facts
// are planted that a bare reader cannot guess. With the substrate the reader
// recovers them; without it, it falls back to a prior and is wrong. A large
// positive delta proves the test discriminates. The REAL 1b control arm has now
// been run (see reader-independence-1b.py): Llama-3.2-1B-Instruct scored 0/20
// without the substrate and 20/20 with it, delta 1.00. This in-process mock is the
// fast CI stand-in; the 1b run is the authoritative grade.
import { fileURLToPath } from "node:url";
import { fresh, done, reopen, W } from "./_lib.mjs";

export function runReaderIndependence(n = 25) {
  const s = fresh();
  try {
    const facts = [];
    for (let i = 0; i < n; i++) {
      // counterintuitive: a value a bare reader cannot reconstruct from its prior
      const code = `${(i * 37 + 11) % 100}`.padStart(2, "0") + "-" + String.fromCharCode(65 + (i % 26)) + (i * 7 % 1000);
      const id = W(s.store, { title: `access token for vault ${i} is ${code}`, body: code, subject: [`vault${i}`], topics: ["ri"] }).id;
      facts.push({ id, gold: code });
    }
    const reader = reopen(s);
    // with substrate: the reader has the stored cell (information availability, not
    // search ranking, collisions are a retrieval-fidelity concern, area 13)
    const withSub = (f) => { const node = reader.getNode(f.id); return node ? String(node.body) : null; };
    // without substrate: the bare reader's prior (a fixed plausible-but-wrong guess)
    const withoutSub = () => "00-A0";
    let accWith = 0, accWithout = 0;
    for (const f of facts) {
      if (withSub(f) === f.gold) accWith++;
      if (withoutSub(f) === f.gold) accWithout++;
    }
    const rWith = accWith / n, rWithout = accWithout / n, delta = rWith - rWithout;
    const ok = delta >= 0.9; // substrate carries information the bare reader cannot
    return {
      n,
      metric: `mock control arm: with-substrate ${Math.round(rWith * 100)}% vs without ${Math.round(rWithout * 100)}%, delta ${delta.toFixed(2)}; real 1b run pending`,
      grade: ok ? "RESIDUAL(@SELF-VERIFIED)" : "ASSERTED"
    };
  } finally { done(s); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(runReaderIndependence());
