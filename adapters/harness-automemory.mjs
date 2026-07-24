// AMBIENT reference auto-ingestion harness.
//
// Purpose: give a model with no native auto-memory a fair, identical auto-capture
// behavior so it can run the auto tiers (T2, T3). AMBIENT prefers a system's NATIVE
// auto-memory when it has one; this harness is the fallback and the fair baseline for
// systems that lack one. The same reader model builds the memory store before the
// benchmark questions begin, so the comparison stays on the memory layer rather than
// on a different ingestion model. It is identical for every entrant, so a native
// system scores only by beating it, never by out-engineering its own harness. See
// RULES.md ("Testing a bare model").
//
// WHAT AUTO-MEMORY IS (and why this is not "store every turn"): real auto-memory is
// MODEL-DECIDED. As the conversation streams by, the model judges what is durable and
// worth keeping and writes only that. The store ends up holding a lossy, model-curated
// SUBSET of the stream, not a verbatim copy. That selectivity is the whole point, and it
// is what makes the auto tier (T2, distilled subset) genuinely different from the curated
// tier (T4, the deliberate full record). This harness reproduces that behavior with a
// windowed extraction pass driven by the reader model.
//
// SHAPE: a capture DECORATOR over any MemoryAdapter. It governs WHAT is written (the
// auto-capture policy); the wrapped substrate still owns storage and retrieval. So the
// same harness gives Recall, CogniCore, or the baseline store identical auto-capture.

const DEFAULT_WINDOW = 8;      // turns per extraction call (per-turn would be infeasible on a slow local reader)
const DEFAULT_MAX_FACTS = 6;   // cap facts per window so a chatty window cannot dominate the store
const DEFAULT_PER_TURN = 800;  // cap each turn's length in the excerpt: a 1500-token essay-turn makes the
                               // extraction prompt huge and slow, and real auto-memory distills salient
                               // points from the opening rather than ingesting the whole essay verbatim.
const NONE = "NONE";

const EXTRACT_SYS =
  "You are the memory of an assistant. You are shown an excerpt of a conversation. " +
  "Extract only the DURABLE facts a memory system should keep to answer later questions: " +
  "decisions, values, dates, numbers, stated preferences, commitments, and changes to earlier facts. " +
  "Write each as ONE standalone sentence that resolves pronouns and context (e.g. 'The user's first " +
  "sprint ends on March 29', not 'it ends March 29'). Skip pleasantries, meta-talk, and anything not " +
  "worth remembering. Output a plain list, one fact per line, no numbering or bullets. If nothing in " +
  "the excerpt is worth remembering, output exactly: " + NONE;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseFacts(text, maxFacts) {
  const t = (text || "").trim();
  if (!t || t.toUpperCase().startsWith(NONE)) return [];
  return t
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()) // strip stray bullets/numbers
    .filter((l) => l.length > 3 && l.toUpperCase() !== NONE)
    .slice(0, maxFacts);
}

/**
 * Wrap a base MemoryAdapter with model-driven auto-capture.
 *   base : the substrate adapter (Recall/CogniCore/baseline) that stores + retrieves
 *   ask  : async ({system,user,maxTokens}) => string  (the reader/extraction model)
 * The decorator only changes capture; query() delegates to the substrate.
 */
export class ReferenceAutoMemory {
  constructor(base, ask, { window = DEFAULT_WINDOW, maxFacts = DEFAULT_MAX_FACTS, perTurn = DEFAULT_PER_TURN, topK = 8 } = {}) {
    this.base = base;
    this.ask = ask;
    this.window = window;
    this.maxFacts = maxFacts;
    this.perTurn = perTurn;
    this.topK = topK;
    this._auto = true;
    this._cache = new Map(); // conversationId -> distilled facts (a conversation distills once, reused across tiers/segments)
  }

  get name() {
    return `${this.base?.name ?? "store"}+auto`;
  }

  async init() {
    if (typeof this.base.init === "function") await this.base.init();
    return this;
  }

  async reset() {
    return this.base.reset();
  }

  async setAutoCapture(enabled) {
    this._auto = Boolean(enabled);
    return { supported: true, auto: this._auto };
  }

  // Model-decided capture over a whole conversation. Memoized by cacheKey so the
  // extraction pass runs once per conversation, not once per tier/segment.
  async distill(events, cacheKey) {
    if (cacheKey && this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const facts = [];
    for (const win of chunk(events, this.window)) {
      const excerpt = win
        .map((e) => {
          const text = e.text.length > this.perTurn ? e.text.slice(0, this.perTurn) + "…" : e.text;
          return `${e.role}: ${text}`;
        })
        .join("\n");
      let out = "";
      try {
        out = await this.ask({ system: EXTRACT_SYS, user: "Excerpt:\n" + excerpt, maxTokens: 220 });
      } catch {
        out = ""; // a failed window contributes nothing rather than aborting capture
      }
      facts.push(...parseFacts(out, this.maxFacts));
    }
    if (cacheKey) this._cache.set(cacheKey, facts);
    return facts;
  }

  // Auto tiers call this: distill the stream, then write the model-selected facts to the
  // substrate. No-op when auto is off (the curated tier writes its own record).
  async observe(events, cacheKey) {
    if (!this._auto) return { captured: 0 };
    const facts = await this.distill(events, cacheKey);
    for (const f of facts) await this.base.write(f, "auto");
    return { captured: facts.length };
  }

  // Curated writes (T4/T3 full-record path) pass straight through to the substrate.
  async write(fact, source = "curated") {
    return this.base.write(fact, source);
  }

  async query(question, topK = this.topK) {
    return this.base.query(question, topK);
  }

  async surface(newFact) {
    return typeof this.base.surface === "function" ? this.base.surface(newFact) : { supported: false };
  }
}
