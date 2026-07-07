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
- `harness-automemory.mjs`: the reference auto-memory harness. Used only when a system
  has no native auto-memory, so a bare model can still run the auto tiers (T2, T3); a
  system with its own auto-memory defaults to that. The shared baseline every entrant
  is measured against. See RULES.md.

Rule: optional capabilities a system lacks are graded ABSENT, never FAIL. A system
reports what it cannot do; it is never silently zeroed.
