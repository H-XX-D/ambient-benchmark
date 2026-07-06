// Runner-side client for a MemoryAdapter exposed over the AMBIENT wire protocol
// (docs/ADAPTER_CONTRACT.md). Any system, in any language, that speaks these endpoints
// can be driven by the four-tier runner: this is what makes AMBIENT cross-system.
//   POST /write {fact, source} -> {id}
//   POST /query {question, top_k} -> {support:[...], provenance:[...]}
//   POST /surface {newFact} -> {supported}
//   POST /setAutoCapture {enabled} -> {supported, auto}
//   POST /reset -> {ok}
//   GET  /name -> {name}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`adapter ${path} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

export class HttpAdapter {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, "");
    this._name = "http";
  }

  get name() {
    return this._name;
  }

  async init() {
    try {
      const r = await (await fetch(this.base + "/name")).json();
      if (r?.name) this._name = r.name;
    } catch {
      // name is cosmetic; ignore if unavailable
    }
    return this;
  }

  // Optional `store` names the target store (auto/custom/combined) for build-once/query-many.
  // Adapters that ignore it fall back to a single store (back-compat).
  async reset(store) {
    return post(this.base, "/reset", store ? { store } : {});
  }

  async setAutoCapture(enabled) {
    return post(this.base, "/setAutoCapture", { enabled });
  }

  async write(fact, source = "ingest", store, edges) {
    return post(this.base, "/write", { fact, source, store, edges });
  }

  async query(question, topK = 8, store) {
    return post(this.base, "/query", { question, top_k: topK, store });
  }

  // holonomy: register an ordering overlay; a closing edge is caught as a cycle (created at write).
  async dag(store, title, nodeIds, edges) {
    return post(this.base, "/dag", { store, title, nodeIds, edges });
  }

  // enumeration: register a collection of same-kind items; list/count queries get the whole set.
  async collection(store, keywords, members) {
    return post(this.base, "/collection", { store, keywords, members });
  }

  async surface(newFact) {
    return post(this.base, "/surface", { newFact });
  }
}
