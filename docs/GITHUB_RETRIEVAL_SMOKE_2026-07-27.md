# GitHub retrieval smoke — 2026-07-27

This is an adapter compatibility check, not an AMBIENT quality score and not a
leaderboard submission. It tests the memory-tool boundary directly, without
using model fluency as a proxy for retrieval quality.

## Selected projects

| project | upstream commit | license | why selected |
|---|---|---|---|
| [Engram](https://github.com/Gentleman-Programming/engram) | `763a6ba432713725d6ce82a2416eec6cbd9ec94e` | MIT | Local SQLite/FTS5 memory with a real CLI, MCP server, and HTTP API. |
| [projectmem](https://github.com/riponcm/projectmem) | `65eb70ba02439d976e9e1449b485a8c705948ea1` | MIT | Local event-log memory with a real CLI and MCP server, requiring no hosted model or database. |

The projects were selected from live GitHub repository metadata. Popularity was
used only as a discovery signal; it is not evidence of memory quality.

## What passed

Each upstream checkout was built or installed in an isolated temporary directory
and driven through its AMBIENT HTTP adapter. The same smoke wrote one target fact
and two plausible distractors, then verified:

1. the target fact ranked first for the target query;
2. every served support item had aligned provenance;
3. the target was marked as externally served memory evidence;
4. the fact did not cross into another store namespace; and
5. reset removed the fact from subsequent retrieval.

Both Engram and projectmem passed all five checks. The fixture paths also passed,
so adding the live-binary option did not regress the existing no-dependency test.

Reproduction after building or installing the upstream executables:

```sh
npm run verify:adapter:engram -- --bin /absolute/path/to/engram
npm run verify:adapter:projectmem -- --bin /absolute/path/to/projectmem
```

## Full-run observation

projectmem also completed the existing small cross-adapter runner matrix. Engram's
direct retrieval smoke passed, but its current CLI-per-operation bridge exceeded
the matrix's 180-second timeout. That is an integration-throughput limitation in
the current AMBIENT bridge, not a failed retrieval result and not evidence that
Engram's memory quality is poor. A persistent Engram HTTP or MCP bridge is the
appropriate follow-up before a full benchmark.
