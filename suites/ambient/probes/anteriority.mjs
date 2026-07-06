// ANTERIORITY (area 2): prove a fact predates another without minting the time
// yourself. Internal version: an append-only Merkle log. For an early cell A and a
// later cell B, prove A is included in the log root captured right after A was
// appended, that B's leaf is absent from that prefix, and that the prefix is
// consistent with the full log. That proves A predates B relative to the log to
// anyone who trusts its append-only property. Binding the epoch root to an external
// chain (Bitcoin/OTS) would lift this to EXTERNALLY-ANCHORED; that anchor is the
// open residual.
import { fileURLToPath } from "node:url";
import { fresh, done, reopen, W } from "./_lib.mjs";
import { leafHash, mth, inclusionProof, verifyInclusion, prefixConsistent } from "./merkle.mjs";

const canon = (node) => leafHash(`${node.id} ${node.body}`);

export function runAnteriority(total = 30, pairs = 10) {
  const s = fresh();
  try {
    const log = [];
    for (let i = 0; i < total; i++) log.push(W(s.store, { title: `log entry ${i}`, body: `entry-${i}`, topics: ["ant"] }));
    const reader = reopen(s);
    const nodes = log.map((e) => reader.getNode(e.id));
    const leaves = nodes.map(canon);

    let proven = 0;
    for (let p = 0; p < pairs; p++) {
      const a = p; // early
      const b = total - 1 - p; // late
      if (a >= b) break;
      const prefix = leaves.slice(0, a + 1); // log state right after A appended
      const rootA = mth(prefix);
      const aIncluded = verifyInclusion(canon(nodes[a]), inclusionProof(prefix, a), rootA);
      const bAbsentAtRootA = !prefix.some((lh) => lh.equals(canon(nodes[b]))); // B did not exist at rootA
      const prefixOk = prefixConsistent(leaves, a + 1, rootA); // rootA is a real prefix of the full log
      if (aIncluded && bAbsentAtRootA && prefixOk) proven++;
    }
    const ok = proven === pairs;
    return {
      n: total,
      metric: `append-order proof ${proven}/${pairs} (A in epoch-A root, B absent, prefix-consistent); external anchor pending`,
      grade: ok ? "RESIDUAL(@EXTERNALLY-ANCHORED)" : "ASSERTED"
    };
  } finally { done(s); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(runAnteriority());
