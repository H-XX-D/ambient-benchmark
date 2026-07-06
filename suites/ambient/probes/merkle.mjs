// RFC 6962 Merkle tree primitives, pure code (no external anchor).
// Powers SET-INTEGRITY (inclusion + append-only consistency) and ANTERIORITY
// (append-order proof). Inclusion proofs carry an explicit direction per step so a
// verifier needs only (leafHash, proof, root), correct by construction on the
// unbalanced RFC 6962 tree.
import { createHash } from "node:crypto";

const sha = (buf) => createHash("sha256").update(buf).digest();
export const leafHash = (data) => sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(data)]));
const nodeHash = (l, r) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

function largestPow2LessThan(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }

// MTH over an array of leaf hashes (Buffer[]).
export function mth(leaves) {
  const n = leaves.length;
  if (n === 0) return sha(Buffer.alloc(0));
  if (n === 1) return leaves[0];
  const k = largestPow2LessThan(n);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

// Inclusion proof for leaf index m: list of { hash, dir } where dir 'R' means the
// sibling subtree root sits to the RIGHT of the running hash (we are the left).
export function inclusionProof(leaves, m) {
  const n = leaves.length;
  if (n <= 1) return [];
  const k = largestPow2LessThan(n);
  if (m < k) return [...inclusionProof(leaves.slice(0, k), m), { hash: mth(leaves.slice(k)), dir: "R" }];
  return [...inclusionProof(leaves.slice(k), m - k), { hash: mth(leaves.slice(0, k)), dir: "L" }];
}

export function verifyInclusion(leaf, proof, root) {
  let r = leaf;
  for (const { hash, dir } of proof) r = dir === "R" ? nodeHash(r, hash) : nodeHash(hash, r);
  return r.equals(root);
}

// Append-only consistency: the old root (over the first m leaves) must reproduce
// from the prefix of the new leaf set. A verifier recomputes mth(newLeaves[0:m])
// and checks it equals the committed old root.
export function prefixConsistent(newLeaves, m, oldRoot) {
  return mth(newLeaves.slice(0, m)).equals(oldRoot);
}
