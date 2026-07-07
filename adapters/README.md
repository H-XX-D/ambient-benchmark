# adapters/

The fairness layer. A memory system competes in AMBIENT by implementing the
MemoryAdapter contract here, so every system is driven through one interface over
the same corpus and questions with the same fixed model.

- `contract.mjs`: the MemoryAdapter interface and the reference segment scorer. The
  one mandatory method is query-with-provenance; a segment scores only when the
  answer is correct and its support traces outside the model. See
  `docs/ADAPTER_CONTRACT.md` and `docs/ATTRIBUTION.md`.
- `recall_adapter.mjs`: Recall behind the HTTP contract, the first system tested.
- `baseline-pull.mjs` / `baseline-pull-server.mjs`: the plain keyword floor and
  HTTP wrapper for no-memory pull retrieval.
- `ai-memory-http-adapter.mjs`: local/free bridge for alphaonedev/ai-memory-mcp's
  HTTP daemon.
- `projectmem-cli-adapter.mjs`: local/free bridge for riponcm/projectmem's CLI and
  append-only event log.
- `simple-memory-cli-adapter.mjs`: local/free bridge for chrisribe/simple-memory-mcp's
  CLI and isolated SQLite `MEMORY_DB` files.
- `agent-recall-python-adapter.mjs`: local/free bridge for mnardit/agent-recall's
  Python `MemoryStore` API and isolated SQLite graph DBs.
- `total-agent-memory-sqlite-adapter.mjs`: local/free bridge for total-agent-memory's
  TAM-compatible `memory.db` knowledge/FTS floor, isolated per AMBIENT store.
- `claude-memory-mcp-cli-adapter.mjs`: local/free bridge for
  WhenMoon-afk/claude-memory-mcp's continuity CLI and isolated SQLite DB paths.
- `engram-cli-adapter.mjs`: local/free bridge for Gentleman-Programming/engram's
  `save`/`search` CLI and isolated `ENGRAM_DATA_DIR` databases.
- `mcp-local-memory-sqlite-adapter.mjs`: local/free bridge for
  Beledarian/mcp-local-memory's `MEMORY_DB_PATH` SQLite/FTS floor, isolated per
  AMBIENT store.
- `sqlite-memory-mcp-sqlite-adapter.mjs`: local/free bridge for
  RMANOV/sqlite-memory-mcp's `SQLITE_MEMORY_DB` core graph/FTS floor, isolated
  per AMBIENT store.
- `mcp-memory-keeper-sqlite-adapter.mjs`: local/free bridge for
  mkreyman/mcp-memory-keeper's `DATA_DIR/context.db` context-item floor,
  isolated per AMBIENT store.
- `local-memory-mcp-sqlite-adapter.mjs`: local/free bridge for
  cunicopia-dev/local-memory-mcp's `MCP_DATA_DIR/memory.db` SQLite floor,
  isolated per AMBIENT store.
- `mcp-memory-sqlite-adapter.mjs`: local/free bridge for
  Daichi-Kudo/mcp-memory-sqlite's SQLite knowledge-graph floor, isolated per
  AMBIENT store.
- `agent-memory-sqlite-adapter.mjs`: local/free bridge for
  baiXfeng/agent-memory's storage-directory `memory.db` SQLite/FTS floor,
  isolated per AMBIENT store.
- `agent-memory-mcp-sqlite-adapter.mjs`: local/free bridge for
  mikeylong/agent-memory-mcp's `AGENT_MEMORY_HOME/memory.db` scoped SQLite/FTS
  floor, isolated per AMBIENT store.

The mainstream shortlist (model-backed Python systems, from
`docs/AGENT_MEMORY_LAYER_CANDIDATES.md`). Each bridges the system's documented
local/OSS API and needs its backend configured (LLM, embeddings, or Neo4j); the
matching verify script skips, never fails, when the package or backend is absent.

- `mem0-http-adapter.mjs`: bridge for mem0ai/mem0's `Memory.add`/`Memory.search`
  API, isolated per AMBIENT store by `user_id` (and by on-disk vector/history path
  when run with `MEM0_CONFIG_JSON`). Needs `OPENAI_API_KEY` or a local backend.
- `cognee-python-adapter.mjs`: bridge for topoteretes/cognee's async
  `add`/`cognify`/`search` graph API, isolated per store via `data_root_directory`
  and `system_root_directory`. Needs an LLM (`LLM_API_KEY`); cognify is LLM-heavy.
- `graphiti-python-adapter.mjs`: bridge for getzep/graphiti's async
  `add_episode`/`search` temporal graph, isolated per store by `group_id`. Needs a
  running Neo4j (`NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD`) and `OPENAI_API_KEY`.
- `langmem-python-adapter.mjs`: bridge for langchain-ai/langmem's LangGraph memory
  store floor (semantic `put`/`search`), isolated per store by namespace and a
  persisted snapshot. Needs an embeddings backend (`OPENAI_API_KEY` or
  `LANGMEM_EMBEDDER`); the full manager with LLM extraction is a heavier follow-up.
- `memoryos-python-adapter.mjs`: bridge for BAI-LAB/MemoryOS's `add_memory` plus
  raw context retrieval (not the synthesizing `get_response`, which would be
  model-origin), isolated per store by `data_storage_path`. Needs an
  OpenAI-compatible key (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`).
- `harness-automemory.mjs`: the reference auto-memory harness. Used only when a system
  has no native auto-memory, so a bare model can still run the auto tiers (T2, T3); a
  system with its own auto-memory defaults to that. The shared baseline every entrant
  is measured against. See RULES.md.

Rule: optional capabilities a system lacks are graded ABSENT, never FAIL. A system
reports what it cannot do; it is never silently zeroed.
