# L4 expiry policy and definition drift

L4 tests whether a memory system detects a belief after its semantic expiry. The
system result is reproducible only if the harness's meaning of expiry is stable too.
AMBIENT therefore versions the rule separately from its implementation.

`l4-expiry.v1` defines:

- UTC evaluation;
- expiry at `expiresAt <= evaluationTime` (the equality boundary is expired);
- named months as inclusive through their final millisecond;
- an explicit year when present, otherwise the UTC year of `createdAt`;
- Q1 and Q2 as inclusive through the final millisecond of March and June;
- no expiry for text without recognized temporal scope.

The canonical definition and frozen boundary witnesses live in
`suites/ambient/fixtures/l4-expiry-v1.json`. The verifier hashes parsed canonical
content, checks leap-year, equality, one-millisecond, implicit-year, and timeless
cases, and writes `results/l4-expiry-policy-witness.json`. Mutating v1 makes the
verification fail even if the L4 capability probe still returns 100/100.

A legitimate semantic change creates `l4-expiry-v2.json`, a new implementation and
an explicit migration note. It must not rewrite v1. Git history then records both the
old longitudinal meaning and the point at which the benchmark adopted a new one.
