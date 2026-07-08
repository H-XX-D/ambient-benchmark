# AMBIENT

Agentic Memory: Baseline-Isolated Evaluation, Normalized Tiers.

It doesn't measure what a model can't do. It measures what your memory layer
actually does for the agent.

AMBIENT measures what an agentic memory system adds to a model, with the model held
fixed and the memory's contribution isolated so no result is mis-credited. It is
substrate-neutral: any memory system can enter (a graph store, a vector index, a
flat log, a hosted service). Recall is only the first system tested, not the
definition.

You attach a memory system to a model, let it build a store from provided
information, then grade capability across four ablation tiers. AMBIENT's core test
suite (the L1 to L4 contradiction and staleness ladder plus an 18-area profile,
formerly named SENTINEL) is the capability axis; the tiers are the attribution axis.

## The rules, short form

Full text in [RULES.md](RULES.md).

1. To enter, a system must expose a store call the harness can route through and watch
   (query, information back, response). The harness traces the call; the model never
   cites itself. That is the only requirement.
2. Same corpus, same questions, same fixed model for every system.
3. Score correct, wrong, or gullible. The harness confirms the info came from a store
   call (not the model's weights), then grades the answer. Correct with no store call
   is the model knowing it, not the memory.
4. Four tiers (a 2x2 ablation of auto-capture by curated store). Report lift and
   the interaction, never one number.
5. Shadow memory is detected via a known-versus-novel split, not assumed away.
6. Score ability, not mechanism: how well a system does the task, never whether it
   owns a particular lever (push hook, graph). No bonus for having one, no penalty
   for lacking one.
7. Every number ships with its served context, transcript, and a recompute script.

## The four tiers

| tier | auto-capture | curated store | isolates |
|------|--------------|---------------|----------|
| T1 baseline      | off | off | raw model capability |
| T2 auto only     | on  | off | automatic capture alone |
| T3 auto + custom | on  | on  | full stack |
| T4 custom only   | off | on  | curated memory alone |

All four cells run, so beyond four scores you get the interaction. If custom-only
(T4) matches both (T3), the automatic capture earned nothing. If T3 beats the sum
of the T2 and T4 gains over baseline, auto and curation are synergistic. That
interaction is the thing a ranking cannot show, and the reason the tiers exist.

A bare model with no memory of its own runs the auto tiers (T2 and T3) through a
reference auto-memory harness that AMBIENT supplies, identical for every entrant, so
lever-less systems can still be placed on the ladder. See [RULES.md](RULES.md).

## Where the questions come from

AMBIENT does not invent a new corpus to make its point. Most of the question content
is absorbed from established, licensed long-term-memory benchmarks, reconstructed
from their official releases at run time (`corpora/reconstruct.py`), never
redistributed: **BEAM** (arXiv:2510.27246, CC BY-SA 4.0, scales 100K to 10M tokens)
and **LongMemEval** (arXiv:2410.10813, MIT, carries its own answer-session
provenance). LoCoMo was evaluated and excluded: its CC BY-NC license blocks
commercial or monetized-leaderboard use, and LongMemEval already covers the same
small-tier pull-plus-attribution role under MIT. See
[corpora/LICENSES.md](corpora/LICENSES.md) and
[corpora/sources.json](corpora/sources.json) for the full attribution.

A smaller, purpose-authored 92-segment / 15-ability corpus (`corpora/areas.mjs`)
supplements this for structural abilities the absorbed corpora don't target directly:
supersession lineage, holonomy (cyclic ordering), reactivity, and calibration.

What's actually novel here isn't the question content, it's the harness: the entry
bar is loosened to Rule 1 (any system exposing one traceable store call, substrate-
neutral) rather than requiring a specific mechanism, and the scoring is different
from how these corpora are normally graded, reader held constant across four
ablation tiers, correct/wrong/gullible instead of a single accuracy number, so the
result is attributable to the memory system rather than the reader.

## The capability suite

The capability axis, what memory can do: L1 unprompted value-flip, L2 entailed
contradiction, L3 transitive inconsistency, L4 stale-by-expiry, plus an 18-area
profile. This suite was formerly named SENTINEL; it is AMBIENT's core. The tiers are
the attribution axis, how much the memory contributed. Run a capability test across
the four tiers and you get a normalized lift you can honestly attribute to the memory
system. See [docs/00_AMBIENT.md](docs/00_AMBIENT.md) and
[docs/10_AMBIENT_SUITE.md](docs/10_AMBIENT_SUITE.md).

## Status

The full pipeline is built and running end to end against Recall, the first system
tested: adapter contract, four-tier runner, reference auto-memory harness, an
ingest-time write firewall, and a 92-segment / 15-ability capability corpus.

**Deterministic core** (model-free, Node 24, no keys, no network):
- L1 unprompted contradiction: recall 100%, precision 100%, 0-tick latency
- L3 transitive inconsistency: recall 100%, precision 100% (cyclic ordering
  rejected at write time)
- L2 entailed contradiction: literal baseline 0% vs entailment detector 100%
- L4 stale-by-expiry: naive age 75/50 vs expiry-aware 100/100

**Prompt-injection resistance** (LLM-mediated ingest, Gemini key required):
- Splices attacker turns into real BEAM/LongMemEval conversations without mixing
  injected content into the original gold answers.
- Measures store-side policy weakening and agent-side answer hijacking separately.
- Current hardened small run, reverified after the Recall `0.12.0` sync on
  2026-07-06: 6/6 scenarios resistant, 0 vulnerable, 0/2 clean controls
  false-flagged, against the patched vendored Recall gate (`ver_8922`).

**Write-time model firewall**: relations (supersedes, contradicts, concerns,
ordering, collection membership) are decided by a model reading each turn against
the growing store at write time, not by regex. A regex-marker detector was tried
first and kept breaking on real prose; replacing it with model classification is
what made the harder abilities (reactivity, holonomy, enumeration) tractable at all.
See [docs/00_AMBIENT.md](docs/00_AMBIENT.md).

**The ceiling test**: to separate "the memory graph is missing something" from "the
reader can't use what it's given," we hand-constructed an ideal graph for 30
scenarios across the 15-ability corpus (no classifier noise) and ran the same served
context through two readers. A fixed 32B reader scored 20/30 (67%); a frontier
reader (gpt-4.1) on the byte-identical context scored 30/30 (100%). Every one of the
32B's misses, including a case that looked like a genuine temporal-reasoning gap,
cleared under the stronger reader. Conclusion: for this corpus, the residual gap is
reader capability, not a missing memory primitive. This is also why the fixed-reader
design is a lever, not a limitation: a mid-capability reader surfaces memory-graph
seams that a weak reader fails too broadly to isolate and a frontier reader quietly
papers over. See [docs/10_AMBIENT_SUITE.md](docs/10_AMBIENT_SUITE.md).

Open items: a fast ingest-time classifier backend (the write firewall currently rides
on the same 32B reader, which is slow at scale), the medium/large corpus sizes, and
full cross-adapter capability grading with served-context transcripts and goldens.
See [ROADMAP.md](ROADMAP.md).

## Quickstart

Requires Node >= 24. No dependencies. The deterministic arms need no API keys; the
model-driven arms need a reader backend (see below).

```
npm run bench                 # L1 to L4 deterministic core
npm run bench:suite           # 18-area capability profile
npm run bench:contradiction   # admission-time contradiction gate
npm run verify                # full local/free gate: clean pass + artifact validation
npm run verify:clean          # one local/free clean pass: syntax, benches, adapter smokes
npm run verify:clean:artifact # validate the last clean-verification summary artifact
npm run verify:clean:loop     # retry clean passes until success; default cap is 25 attempts
npm run verify:mal:standing-programs # smoke named MAL standing programs: addf watch0/drift0/etc tick
npm run verify:adapters:matrix # ten-adapter no-key runner matrix with transcript row checks
npm run verify:adapters:matrix:artifact # validate the last cross-adapter matrix + transcripts
npm run verify:adapters:matrix:extended # also try Recall plus CLI/daemon bridges; skip missing prereqs
npm run verify:adapters:prereqs # report optional CLI/daemon prerequisites for wider benching
npm run judge:adapters:matrix # judge every passed matrix transcript into one grade artifact
npm run judge:adapters:matrix:artifact # validate a cross-adapter grade summary artifact
npm run verify:adapters:judge # smoke the judge wrapper against a local mock judge
npm run verify:adapters:grade:pipeline # run matrix -> mock judge -> grade artifact checker
npm run corpus:injection      # build the prompt-injection resistance corpus
npm run bench:injection       # run the LLM-mediated injection suite; needs GEMINI_API_KEY
npm run adapter:baseline      # expose the non-Recall keyword baseline on :8091
npm run adapter:recall        # expose the vendored Recall adapter on :8092
npm run adapter:ai-memory     # bridge local alphaonedev/ai-memory-mcp serve daemon on :8093
npm run adapter:projectmem    # bridge local riponcm/projectmem CLI install on :8094
npm run adapter:simple-memory # bridge local chrisribe/simple-memory-mcp CLI on :8095
npm run adapter:tree-ring     # bridge local TerminallyLazy/Tree_Ring_Memory CLI on :8107
npm run adapter:agent-recall  # bridge local mnardit/agent-recall Python package on :8096
npm run adapter:total-agent-memory # bridge TAM-compatible local SQLite memory.db on :8097
npm run adapter:claude-memory-mcp # bridge local @whenmoon-afk/memory-mcp CLI on :8098
npm run adapter:engram       # bridge local Gentleman-Programming/engram CLI on :8099
npm run adapter:mcp-local-memory # bridge mcp-local-memory MEMORY_DB_PATH SQLite floor on :8100
npm run adapter:sqlite-memory-mcp # bridge sqlite-memory-mcp SQLITE_MEMORY_DB core graph on :8101
npm run adapter:mcp-memory-keeper # bridge mcp-memory-keeper DATA_DIR/context.db on :8102
npm run adapter:local-memory-mcp # bridge local-memory-mcp MCP_DATA_DIR/memory.db on :8103
npm run adapter:mcp-memory-sqlite # bridge mcp-memory-sqlite local graph DB on :8104
npm run adapter:agent-memory # bridge baiXfeng/agent-memory storage-dir memory.db on :8105
npm run adapter:agent-memory-mcp # bridge agent-memory-mcp AGENT_MEMORY_HOME memory.db on :8106
npm run verify:adapter:baseline # no-key smoke for runner -> HTTP adapter -> mock model
npm run verify:adapter:ai-memory # no-key smoke for ai-memory bridge -> mock target
npm run verify:adapter:projectmem # no-key smoke for projectmem CLI bridge
npm run verify:adapter:simple-memory # no-key smoke for simple-memory CLI bridge
npm run verify:adapter:tree-ring # no-key smoke for Tree Ring CLI bridge
npm run verify:adapter:agent-recall # smoke for agent-recall Python bridge
npm run verify:adapter:total-agent-memory # smoke for TAM-compatible SQLite bridge
npm run verify:adapter:claude-memory-mcp # no-key smoke for claude-memory-mcp CLI bridge
npm run verify:adapter:engram # no-key smoke for engram CLI bridge
npm run verify:adapter:mcp-local-memory # smoke for mcp-local-memory SQLite bridge
npm run verify:adapter:sqlite-memory-mcp # smoke for sqlite-memory-mcp SQLite bridge
npm run verify:adapter:mcp-memory-keeper # smoke for mcp-memory-keeper SQLite bridge
npm run verify:adapter:local-memory-mcp # smoke for local-memory-mcp SQLite bridge
npm run verify:adapter:mcp-memory-sqlite # smoke for mcp-memory-sqlite graph bridge
npm run verify:adapter:agent-memory # smoke for baiXfeng/agent-memory SQLite bridge
npm run verify:adapter:agent-memory-mcp # smoke for agent-memory-mcp SQLite bridge
node tiers/runner.mjs         # the four-tier ablation runner (T1-T4), full corpus
```

`verify:clean` and `verify:clean:loop` intentionally stay local/free by default.
Add `-- --include-injection` to include the Gemini-backed injection suite, or
`-- --include-model` to include the local 1B reader suites. Both commands refresh
`results/clean-verification.json` with the exact command list, scope, runtime, and
pass/fail status.
`verify:adapters:matrix` is also local/free, but separate from the clean loop: it
starts ten local adapters plus a mock OpenAI-compatible reader/checker, runs
`tiers/runner.mjs --source beam --size small --limit 2` through each, and writes
`results/cross-adapter-matrix.json`.
`verify:adapters:matrix:extended` adds optional real runtime bridges for
`recall`, `ai-memory-search`, `projectmem-cli`, `simple-memory-cli`,
`tree-ring-cli`, `claude-memory-mcp-cli`, and `engram-cli`. Missing optional
CLIs/daemons are recorded as skipped unless you run the matrix without
`--allow-skips`.
`verify:adapters:prereqs` writes `results/optional-adapter-prereqs.json` with
the exact missing binary, daemon, env var, or install/start command for those
optional targets.
`judge:adapters:matrix` reads the last matrix, runs `tiers/judge.mjs` over each
passed transcript, and writes `results/cross-adapter-grade-summary.json`. It uses
`AMBIENT_JUDGE_ENDPOINT`, `AMBIENT_JUDGE_MODEL`, and `AMBIENT_JUDGE_KEY`; add
`-- --strict` when a row-level judge error should fail the command.
`judge:adapters:matrix:artifact` validates the grade summary plus referenced
verdict and per-transcript summary files. `verify:adapters:judge` proves the full
wrapper/checker path locally with a mock OpenAI-compatible judge and writes smoke
artifacts under `results/judge-smoke-*`. `verify:adapters:grade:pipeline` runs the
full ten-adapter local/free matrix, grades it with a mock judge, and validates
`results/cross-adapter-grade-pipeline-summary.json`.

Named MAL standing programs use numeric instance ids. The suffix keeps multiple
programs of the same base operation separate while still executing the base op:

```
addf watch0 tick [query: payment gateway outage] [measure: effective_confidence] [delta: 0.15] [concernTarget: checkout]
addf watch1 tick [topics: api-status] [measure: effective_confidence] [delta: 0.20]
addf drift0 tick [topics: api-status] [measure: effective_confidence] [delta: 0.30]
addf trend0 tick [topics: api-status] [measure: effective_confidence] [delta: 0.10]
addf score0 tick [topics: api-status]
setp watch0.delta 0.25
```

To run the four-tier runner through the substrate-neutral wire protocol instead of
the in-process baseline, start an adapter in one shell and point the runner at it:

```
npm run adapter:baseline -- --port 8091
node tiers/runner.mjs --adapter-url http://127.0.0.1:8091 --source beam --size small --limit 12
```

For a local/free underground memory layer, start `ai-memory serve` separately,
then bridge it into AMBIENT:

```
ai-memory serve --host 127.0.0.1 --port 9077
npm run adapter:ai-memory -- --target http://127.0.0.1:9077 --port 8093
node tiers/runner.mjs --adapter-url http://127.0.0.1:8093 --source beam --size small --limit 12
```

For `projectmem`, install the local/free CLI and let the bridge create isolated
temporary project roots for AMBIENT stores:

```
pip install projectmem
npm run adapter:projectmem -- --port 8094
node tiers/runner.mjs --adapter-url http://127.0.0.1:8094 --source beam --size small --limit 12
```

For `simple-memory-mcp`, install the local/free CLI and let the bridge create
isolated `MEMORY_DB` files for AMBIENT stores:

```
npm install -g simple-memory-mcp
npm run adapter:simple-memory -- --port 8095
node tiers/runner.mjs --adapter-url http://127.0.0.1:8095 --source beam --size small --limit 12
```

For `tree-ring`, install the local/free CLI from a local
`TerminallyLazy/Tree_Ring_Memory` clone and let the bridge create isolated Tree
Ring roots for AMBIENT stores:

```
cargo install --path /path/to/Tree_Ring_Memory/crates/tree-ring-memory-cli
npm run adapter:tree-ring -- --port 8107
node tiers/runner.mjs --adapter-url http://127.0.0.1:8107 --source beam --size small --limit 12
```

For `agent-recall`, install the local/free Python package and let the bridge
create isolated SQLite DBs for AMBIENT stores:

```
pip install agent-recall
npm run adapter:agent-recall -- --port 8096
node tiers/runner.mjs --adapter-url http://127.0.0.1:8096 --source beam --size small --limit 12
```

For `total-agent-memory`, AMBIENT can exercise the local/free `memory.db`
knowledge/FTS floor that `tam-lookup` reads without starting the full embedding,
dashboard, and enrichment runtime:

```
npm run adapter:total-agent-memory -- --port 8097
node tiers/runner.mjs --adapter-url http://127.0.0.1:8097 --source beam --size small --limit 12
```

For `claude-memory-mcp`, install the local/free CLI and let the bridge create
isolated `CLAUDE_MEMORY_DB_PATH` continuity databases for AMBIENT stores:

```
npm install -g @whenmoon-afk/memory-mcp
npm run adapter:claude-memory-mcp -- --port 8098
node tiers/runner.mjs --adapter-url http://127.0.0.1:8098 --source beam --size small --limit 12
```

For `engram`, install the local/free Go binary and let the bridge create isolated
`ENGRAM_DATA_DIR` databases for AMBIENT stores:

```
brew install gentleman-programming/tap/engram
npm run adapter:engram -- --port 8099
node tiers/runner.mjs --adapter-url http://127.0.0.1:8099 --source beam --size small --limit 12
```

For `mcp-local-memory`, AMBIENT can exercise the local/free `MEMORY_DB_PATH`
SQLite/FTS floor without starting the full MCP server or downloading embedding
models:

```
npm run adapter:mcp-local-memory -- --port 8100
node tiers/runner.mjs --adapter-url http://127.0.0.1:8100 --source beam --size small --limit 12
```

For `sqlite-memory-mcp`, AMBIENT can exercise the local/free
`SQLITE_MEMORY_DB` core graph/FTS floor without starting the FastMCP
micro-server stack:

```
npm run adapter:sqlite-memory-mcp -- --port 8101
node tiers/runner.mjs --adapter-url http://127.0.0.1:8101 --source beam --size small --limit 12
```

For `mcp-memory-keeper`, AMBIENT can exercise the local/free
`DATA_DIR/context.db` context-item floor without starting the full MCP server:

```
npm run adapter:mcp-memory-keeper -- --port 8102
node tiers/runner.mjs --adapter-url http://127.0.0.1:8102 --source beam --size small --limit 12
```

For `local-memory-mcp`, AMBIENT can exercise the local/free
`MCP_DATA_DIR/memory.db` SQLite memory floor without starting FastMCP, FAISS,
Ollama, or PostgreSQL:

```
npm run adapter:local-memory-mcp -- --port 8103
node tiers/runner.mjs --adapter-url http://127.0.0.1:8103 --source beam --size small --limit 12
```

For `mcp-memory-sqlite`, AMBIENT can exercise the local/free
`MEMORY_DB_PATH`-style SQLite knowledge graph floor without starting the MCP
stdio/HTTP server:

```
npm run adapter:mcp-memory-sqlite -- --port 8104
node tiers/runner.mjs --adapter-url http://127.0.0.1:8104 --source beam --size small --limit 12
```

For `agent-memory`, AMBIENT can exercise the local/free storage-directory
`memory.db` SQLite/FTS floor without starting the MCP stdio server:

```
npm run adapter:agent-memory -- --port 8105
node tiers/runner.mjs --adapter-url http://127.0.0.1:8105 --source beam --size small --limit 12
```

For `agent-memory-mcp`, AMBIENT can exercise the local/free
`AGENT_MEMORY_HOME/memory.db` scoped SQLite/FTS floor without starting the MCP
server or Ollama embeddings:

```
npm run adapter:agent-memory-mcp -- --port 8106
node tiers/runner.mjs --adapter-url http://127.0.0.1:8106 --source beam --size small --limit 12
```

The reader backend is local by default (a llama-server on port 8089) or an online
OpenAI-compatible API, chosen by `AMBIENT_MODEL_BACKEND=local|online` (see
`model/README.md`). The ingest-time write firewall's classifier is independently
configurable via `AMBIENT_CHECKER_*`, so it can run on a fast small model while the
reader stays fixed.

## Layout

```
RULES.md          the participation rules (substrate-neutral)
docs/             AMBIENT spec, capability-suite spec, attribution, adapter contracts,
                   and local/free memory-layer adapter candidates
suites/ambient/   the AMBIENT capability suite (scripts + probes); dist symlink to the vendored build
adapters/         the fairness layer: MemoryAdapter contract (http-client.mjs), per-system adapters
                   (recall_adapter.mjs, baseline-pull-server.mjs,
                   ai-memory-http-adapter.mjs, projectmem-cli-adapter.mjs,
                   simple-memory-cli-adapter.mjs, tree-ring-cli-adapter.mjs,
                   agent-recall-python-adapter.mjs,
                   total-agent-memory-sqlite-adapter.mjs,
                   claude-memory-mcp-cli-adapter.mjs,
                   engram-cli-adapter.mjs,
                   mcp-local-memory-sqlite-adapter.mjs,
                   sqlite-memory-mcp-sqlite-adapter.mjs,
                   mcp-memory-keeper-sqlite-adapter.mjs,
                   local-memory-mcp-sqlite-adapter.mjs,
                   mcp-memory-sqlite-adapter.mjs,
                   agent-memory-sqlite-adapter.mjs,
                   agent-memory-mcp-sqlite-adapter.mjs), reference auto-memory
                   harness (harness-automemory.mjs)
tiers/            the four-tier ablation runner (runner.mjs) and the hand-constructed
                   quality-graph ceiling test (quality-graph.mjs)
corpora/          the 15-ability / 92-segment capability corpus (areas.mjs assembles it)
model/            the fixed reader backend: local llama-server or an online API by key
recall-self-run/  historical single-system empirical run (Recall only); neutral runs
                   now go through adapters/ and tiers/runner.mjs
vendor/recall/    Recall's pinned build (the first system tested); the current core runs on it
```
