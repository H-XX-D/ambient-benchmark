# Local/Free Agent Memory Layer Candidates

Pulled from GitHub on 2026-07-06 as candidate non-Recall substrates for AMBIENT
adapter work. Filter: local or self-hostable, free/open-source license, and no
hosted-only memory service requirement. Stars/forks are point-in-time GitHub API
values and should be treated as discovery signals, not benchmark results.

| candidate | repo | shape | language | license | stars | adapter fit |
|---|---|---|---|---|---:|---|
| Mem0 | <https://github.com/mem0ai/mem0> | drop-in long-term memory layer for agents and apps | Python | Apache-2.0 | 60,228 | Strong first real adapter if run in OSS/self-hosted mode with local model/vector backends. |
| Graphiti / Zep | <https://github.com/getzep/graphiti> | temporal context graph engine for AI agents | Python | Apache-2.0 | 28,429 | Best structural comparison to Recall if run against local graph/vector/LLM services. |
| Cognee | <https://github.com/topoteretes/cognee> | open-source AI memory platform with self-hosted knowledge graph | Python | Apache-2.0 | 27,250 | Good graph-memory incumbent: remember/recall/forget API maps cleanly to AMBIENT write/query. |
| LangMem | <https://github.com/langchain-ai/langmem> | memory primitives and managers for LangGraph-backed agents | Python | MIT | 1,542 | Good framework-native comparison if backed by local storage and local model calls. |
| MemoryOS | <https://github.com/BAI-LAB/MemoryOS> | hierarchical memory OS for personalized AI agents | Python | Apache-2.0 | 1,500 | Research-style local/free candidate for hierarchical storage, updating, retrieval, and generation. |

## Underground Developer Systems

These are smaller local-first systems worth testing after the mainstream shortlist.
They are especially relevant for Codex/Claude/Cursor-style developer agents because
most expose MCP, HTTP, CLI, or plain local storage.

| candidate | repo | shape | language | license | stars | adapter fit |
|---|---|---|---|---|---:|---|
| ai-memory-mcp | <https://github.com/alphaonedev/ai-memory-mcp> | SQLite FTS5 MCP/HTTP/CLI memory for any assistant | Rust | Apache-2.0 | 34 | Very good AMBIENT fit: simple local write/query service with no cloud dependency. |
| projectmem | <https://github.com/riponcm/projectmem> | local-first coding-agent memory for issues, attempts, decisions, gotchas | Python | MIT | 136 | Bridge implemented in `adapters/projectmem-cli-adapter.mjs`; explicitly 100% local, no cloud, no telemetry. |
| total-agent-memory | <https://github.com/vbcherepanov/total-agent-memory> | local memory for Claude Code/Codex with KG, embeddings, visualization | Python | MIT | 60 | Bridge implemented in `adapters/total-agent-memory-sqlite-adapter.mjs` for the local `memory.db` knowledge/FTS floor; full MCP/enrichment stack remains heavier follow-up. |
| agent-recall | <https://github.com/mnardit/agent-recall> | SQLite-backed knowledge graph with MCP server | Python | MIT | 13 | Bridge implemented in `adapters/agent-recall-python-adapter.mjs`; lightweight SQLite graph-memory comparison. |
| simple-memory-mcp | <https://github.com/chrisribe/simple-memory-mcp> | no-config SQLite MCP memory server | TypeScript | MIT | 8 | Bridge implemented in `adapters/simple-memory-cli-adapter.mjs`; minimal local keyword-memory floor above baseline. |
| claude-memory-mcp | <https://github.com/WhenMoon-afk/claude-memory-mcp> | local continuity journal with snapshots, decisions, graph nodes, CLI, and MCP | TypeScript | MIT | 68 | Bridge implemented in `adapters/claude-memory-mcp-cli-adapter.mjs`; isolated `CLAUDE_MEMORY_DB_PATH` per AMBIENT store. |
| mcp-local-memory | <https://github.com/Beledarian/mcp-local-memory> | zero-Docker local MCP memory with semantic search, FTS5, entities, and relations | TypeScript | MIT | 46 | Bridge implemented in `adapters/mcp-local-memory-sqlite-adapter.mjs` for the local `MEMORY_DB_PATH` SQLite/FTS floor; full semantic MCP runtime remains a heavier follow-up. |
| sqlite-memory-mcp | <https://github.com/RMANOV/sqlite-memory-mcp> | governed SQLite MCP memory with WAL, FTS5, sessions, tasks, bridge sync, and provenance workflows | Python | MIT | 12 | Bridge implemented in `adapters/sqlite-memory-mcp-sqlite-adapter.mjs` for the local `SQLITE_MEMORY_DB` core graph/FTS floor; full FastMCP micro-server stack remains a heavier follow-up. |
| mcp-memory-keeper | <https://github.com/mkreyman/mcp-memory-keeper> | persistent context/checkpoint memory for Claude coding sessions | TypeScript | MIT | 128 | Bridge implemented in `adapters/mcp-memory-keeper-sqlite-adapter.mjs` for the local `DATA_DIR/context.db` context-item floor; full MCP server/checkpoint workflow remains a heavier follow-up. |
| local-memory-mcp | <https://github.com/cunicopia-dev/local-memory-mcp> | local persistent MCP memory with SQLite+FAISS and PostgreSQL+pgvector variants | Python | MIT | 12 | Bridge implemented in `adapters/local-memory-mcp-sqlite-adapter.mjs` for the local `MCP_DATA_DIR/memory.db` SQLite floor; FAISS/Ollama and PostgreSQL/pgvector remain heavier follow-ups. |
| mcp-memory-sqlite | <https://github.com/Daichi-Kudo/mcp-memory-sqlite> | SQLite/WAL drop-in replacement for the official MCP memory knowledge graph | JavaScript | MIT | 3 | Bridge implemented in `adapters/mcp-memory-sqlite-adapter.mjs` for the local graph tables (`entities`, `observations`, `relations`); full MCP transport remains a follow-up. |
| agent-memory | <https://github.com/baiXfeng/agent-memory> | SQLite/libSQL MCP memory with FTS5 trigram search, categories, keywords, CRUD, and backups | TypeScript | MIT | 1 | Bridge implemented in `adapters/agent-memory-sqlite-adapter.mjs` for the storage-directory `memory.db` SQLite/FTS floor; full MCP transport and backup behavior remain follow-ups. |
| agent-memory-mcp | <https://github.com/mikeylong/agent-memory-mcp> | local cross-agent memory for Codex/Claude/Xcode with scoped SQLite, lexical fallback, importers, and optional Ollama embeddings | TypeScript | MIT | 3 | Bridge implemented in `adapters/agent-memory-mcp-sqlite-adapter.mjs` for the `AGENT_MEMORY_HOME/memory.db` scoped SQLite/FTS floor; MCP tools, importers, automations, and embeddings remain heavier follow-ups. |

## Second-Wave Underground Candidates

These are additional local/free developer-memory systems found after the first five
bridges. They are not benchmark results; they are adapter targets worth keeping in
the queue.

| candidate | repo | shape | language | license | stars | adapter fit |
|---|---|---|---|---|---:|---|
| engram | <https://github.com/Gentleman-Programming/engram> | agent-agnostic coding-agent memory with SQLite, FTS5, MCP, HTTP, CLI, and TUI | Go | MIT | 4,932 | Bridge implemented in `adapters/engram-cli-adapter.mjs`; isolated `ENGRAM_DATA_DIR` per AMBIENT store. |

## Fresh Underground Candidates

Found on 2026-07-07 after the original underground queue was exhausted.

| candidate | repo | shape | language | license | stars | adapter fit |
|---|---|---|---|---|---:|---|
| local-memory-mcp-rust | <https://github.com/chriswessells/local-memory-mcp> | one-binary Rust MCP server with SQLite, FTS5, sqlite-vec, short/long-term memory, graph, namespaces, checkpoints, and branches | Rust | MIT | 0 | Strong local/free substrate; direct schema bridge looks feasible but heavier because the store supports 29 tools and vector tables. |
| claude_memory | <https://github.com/codenamev/claude_memory> | Claude Code hooks plus MCP tools over project/global SQLite fact and observation stores | Ruby | MIT | 22 | Useful Claude-Code-native comparison; bridge could target `.claude/memory.sqlite3` and global `~/.claude/memory.sqlite3`. |
| mcp-memory-sqlite-personal | <https://github.com/spences10/mcp-memory-sqlite> | personal knowledge graph and memory system for MCP assistants using SQLite text search | TypeScript | MIT | 13 | Similar graph-memory floor to Daichi-Kudo's package; worth inspecting for schema/API differences before another bridge. |

## Suggested Order

1. `mem0ai/mem0`: likely fastest useful adapter because the public surface is closest
   to AMBIENT's mandatory `write` and `query` calls.
2. `topoteretes/cognee`: good graph-memory comparison target if the goal is a
   self-hosted substrate with explicit remember/recall semantics.
3. `getzep/graphiti`: strongest architectural comparison, but likely heavier setup
   because temporal graph extraction and backing services must be configured.
4. `langchain-ai/langmem`: useful when the benchmark wants to test memory manager
   behavior inside LangGraph rather than a standalone memory service.
5. `BAI-LAB/MemoryOS`: useful after the API-shaped systems because it tests a more
   hierarchical memory design.
6. Underground local bridges now exist for `alphaonedev/ai-memory-mcp`,
  `riponcm/projectmem`, `chrisribe/simple-memory-mcp`, `mnardit/agent-recall`,
  the TAM-compatible SQLite floor from `vbcherepanov/total-agent-memory`,
  `WhenMoon-afk/claude-memory-mcp`, `Gentleman-Programming/engram`, and
  the `MEMORY_DB_PATH` SQLite floor from `Beledarian/mcp-local-memory`,
  the `SQLITE_MEMORY_DB` core graph floor from `RMANOV/sqlite-memory-mcp`,
  the `DATA_DIR/context.db` floor from `mkreyman/mcp-memory-keeper`,
  the `MCP_DATA_DIR/memory.db` floor from `cunicopia-dev/local-memory-mcp`,
  the graph tables from `Daichi-Kudo/mcp-memory-sqlite`, and the
  storage-directory `memory.db` floor from `baiXfeng/agent-memory`, and the
  `AGENT_MEMORY_HOME/memory.db` floor from `mikeylong/agent-memory-mcp`;
  fresh discovery has more underground candidates above.

## AMBIENT Adapter Questions

- Does the system expose one observable query call whose served context can be traced
  as external support?
- Can write/query run locally without a hosted account, or does the adapter need a
  cloud-key mode?
- Does it support isolated store namespaces for T1-T4 runs, or should AMBIENT create
  separate local databases/projects per tier?
- Does retrieval return raw source text/provenance, or only synthesized answers?
- Does the system have native auto-capture, or should AMBIENT use the reference
  auto-memory harness for T2/T3?
