// SET-INTEGRITY (area 6): a served item is provably in the anchored set, and the
// log is append-only. Builds an RFC 6962 Merkle log over the cells (append order),
// proves inclusion for every served item, detects tampering, and verifies
// append-only consistency between two epochs. Recomputable by any third party from
// the store contents with commodity sha256, hence INDEPENDENTLY-VERIFIED. (Binding
// the root to an external chain would lift this to EXTERNALLY-ANCHORED.)
import { fileURLToPath } from "node:url";
import { fresh, done, reopen, W } from "./_lib.mjs";
import { leafHash, mth, inclusionProof, verifyInclusion, prefixConsistent } from "./merkle.mjs";

const canon = (node) => leafHash(`${node.id}:${node.body}`);

export function runSetIntegrity(n = 40, appended = 12) {
  const s = fresh();
  try {
    const epoch1 = [];
    for (let i = 0; i < n; i++) epoch1.push(W(s.store, { title: `set cell ${i}`, body: `payload-${i}`, topics: ["seti"] }));
    const reader = reopen(s);
    const nodes1 = epoch1.map((e) => reader.getNode(e.id));
    const leaves1 = nodes1.map(canon);
    const root1 = mth(leaves1);

    // inclusion: every served item proves membership in the epoch-1 root
    let included = 0;
    for (let i = 0; i < nodes1.length; i++) {
      if (verifyInclusion(canon(nodes1[i]), inclusionProof(leaves1, i), root1)) included++;
    }

    // tamper: a single byte change must change the root and break the old proof
    const tampered = leaves1.slice();
    tampered[5] = leafHash(`${nodes1[5].id}:payload-TAMPERED`);
    const rootT = mth(tampered);
    const tamperDetected = !rootT.equals(root1) && !verifyInclusion(tampered[5], inclusionProof(leaves1, 5), root1);

    // append-only: epoch 2 extends epoch 1; the first n leaves must reproduce root1
    const epoch2 = epoch1.slice();
    for (let i = 0; i < appended; i++) epoch2.push(W(s.store, { title: `set cell ${n + i}`, body: `payload-${n + i}`, topics: ["seti"] }));
    const r2 = reopen(s);
    const leaves2 = epoch2.map((e) => canon(r2.getNode(e.id)));
    const appendOnly = prefixConsistent(leaves2, n, root1);

    const ok = included === n && tamperDetected && appendOnly;
    return {
      n: n + appended,
      metric: `inclusion ${included}/${n} verified, tamper ${tamperDetected ? "detected" : "MISSED"}, append-only ${appendOnly ? "consistent" : "BROKEN"}`,
      grade: ok ? "INDEPENDENTLY-VERIFIED" : included > 0 ? "RESIDUAL(@INDEPENDENTLY-VERIFIED)" : "ABSENT"
    };
  } finally { done(s); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(runSetIntegrity());
