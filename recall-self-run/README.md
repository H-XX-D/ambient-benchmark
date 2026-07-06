# AMBIENT run (2026-06-23), formerly named SENTINEL

End-to-end benchmark run against a freshly built, dedicated graph. Your production
`substrate-v2` graph was not touched.

## What happened
1. Built a fresh graph (`graph/sentinel.sqlite3`) and ingested 7 data shapes.
2. Connected them with real edges and stood up a watch program.
3. Found and fixed a product bug: the secret firewall was hard-rejecting source
   code (it even rejected its own file). Code is a first-class input, so the
   name-based heuristics now WARN instead of blocking; only real vendor credentials
   reject. Committed to Recall-Personal (`4c1e232`), 264 tests pass.
4. Ran the gauntlet: structural checks in code over the real cells, plus a fixed
   1b model (Llama-3.2-1B) answering questions about the ingested data, with vs
   without what the substrate serves. Captured the full stream, traces, timings.

## The graph
- 48 active cells, 21 edges, 1 watch program (`api-status`).
- Shapes: code 22 (Recall-Personal/src/core + AURA-main), dataset 8 (penguins.csv),
  web 4 (Wikipedia), arxiv 6 (cs.AI abstracts), pdf 2 (Attention, BERT), json 1
  (package.json), log 5 (with a planted contradiction).

## Results
STRUCTURAL (code-verified over the real graph):
- set-integrity: RFC 6962 inclusion 48/48 verified, tamper detected, root recomputable.
- contradiction: 1 detected live (the planted "api healthy" vs "api DOWN" conflict).

MODEL-DRIVEN (fixed 1b; with = served from the graph, without = bare model):
- with-substrate 5/7, without 2/7, mean latency ~261ms/call.
- Memory-attributable wins (model could not know without the graph): dataset mean
  body_mass, log port 9347, package name. The 2 "without" hits (paper is about
  attention, what a knowledge graph is) are common knowledge: memory adds nothing
  there, honestly.
- Honest misses: CODE-dependency (retrieval/extraction), CONTRADICTION-articulation
  (the weak 1b cannot enumerate both conflicting states even when both are served).

## Files
- `graph/sentinel.sqlite3`   the populated benchmark graph
- `ingest/`                  raw acquired data (pdfs, wiki json, arxiv atom, csv, code, log) + `manifest.json`
- `traces/ingest-stream.jsonl`   every cell written during ingestion
- `traces/gauntlet.jsonl`        every model call: prompt, response, latency_ms
- `results/report.txt`           human-readable run report
- `results/summary.json`         structured results + timings
- `results/structural-18-area.txt`  the isolated 18-area structural profile
- `ingest.mjs`, `run-gauntlet.mjs`  the reproducible scripts

## Reproduce
```
llama-server -hf unsloth/Llama-3.2-1B-Instruct-GGUF:Q4_K_M --port 8089 -ngl 99 --no-webui
node ingest.mjs && node run-gauntlet.mjs
```
