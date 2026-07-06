// The fair bolt-on baseline adapter: a plain keyword/overlap retriever over ingested
// turns. No graph, no push, no auto-capture intelligence, just retrieve-what-matches.
// It implements the AMBIENT MemoryAdapter interface in-process so the tier runner works
// with zero external services. Any real system should beat it; it is the floor.

const STOP = new Set(
  "the a an of to in on at is are was were and or for with as it its this that i you my your me we they them he she his her their our from by be been being have has had do does did not no yes will would can could should if then so out up about into over than".split(" "),
);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function overlap(qTokens, tTokens) {
  if (!qTokens.length || !tTokens.length) return 0;
  const t = new Set(tTokens);
  let hit = 0;
  for (const w of new Set(qTokens)) if (t.has(w)) hit++;
  return hit / new Set(qTokens).size;
}

export class BaselinePull {
  constructor({ topK = 6 } = {}) {
    this.items = [];
    this.topK = topK;
    this.auto = true;
  }

  get name() {
    return "baseline-pull";
  }

  async reset() {
    this.items = [];
  }

  async setAutoCapture(enabled) {
    this.auto = Boolean(enabled);
    return { supported: true, auto: this.auto };
  }

  async write(fact, source = "ingest") {
    const id = "b" + this.items.length;
    this.items.push({ id, text: String(fact), source });
    return { id };
  }

  async query(question) {
    const q = tokens(question);
    const scored = this.items
      .map((it) => ({ it, s: overlap(q, tokens(it.text)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, this.topK);
    return {
      support: scored.map((x) => x.it.text),
      provenance: scored.map((x) => ({ id: x.it.id, origin: "external", source: x.it.source, score: Number(x.s.toFixed(3)) })),
    };
  }

  async surface() {
    return { supported: false }; // pull-only: no unprompted push
  }
}
