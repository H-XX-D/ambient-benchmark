# adapters/

The fairness layer. A memory system competes in AMBIENT by implementing the
MemoryAdapter contract here, so every system is driven through one interface over
the same corpus and questions with the same fixed model.

- `contract.mjs`: the MemoryAdapter interface and the reference segment scorer. The
  one mandatory method is query-with-provenance; a segment scores only when the
  answer is correct and its support traces outside the model. See
  `docs/ADAPTER_CONTRACT.md` and `docs/ATTRIBUTION.md`.
- `recall.mjs` (to build): Recall behind the contract, the first system tested.
- `baseline-pull.mjs` (to build): a plain vector or RAG incumbent, the fair bolt-on
  baseline.
- `harness-automemory.mjs`: the reference auto-memory harness. Used only when a system
  has no native auto-memory, so a bare model can still run the auto tiers (T2, T3); a
  system with its own auto-memory defaults to that. The shared baseline every entrant
  is measured against. See RULES.md.

Rule: optional capabilities a system lacks are graded ABSENT, never FAIL. A system
reports what it cannot do; it is never silently zeroed.
