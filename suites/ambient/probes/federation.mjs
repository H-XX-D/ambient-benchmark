// AMBIENT benchmark probe: FEDERATION area of the Recall memory substrate.
//
// Question under test: when two independent substrates are merged for READING
// via a FederatedReadStore (read-union), does the union surface cells from both
// members, preserve a genuine cross-store conflict (A says "UP", B says "DOWN")
// instead of collapsing to last-writer-wins, keep per-cell provenance so the
// owning member is recoverable, and stay order-independent (members [A,B] vs
// [B,A] yield the same id set)?
//
// FederatedMember is { graph, path } (see src/core/federated-store.ts): the
// union opens each path itself and re-addresses every returned node id as
// `graph:id`, so the graph prefix IS the provenance signal we read back.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteStore, admit, FederatedReadStore } from "../_recall.mjs";

// Flat proposal matching the current admit() schema (schema.js): kind must be
// one of the short KINDS codes, confidence a plain number in (0,1]. The old
// nested recall.write.v1 shape (actor/intent/content/scope/tags/evidence/
// provenance/policy) doesn't exist in the vendored build; this is what admit()
// actually validates.
function mkProposal(title, body = "b", project = "memA") {
  return {
    kind: "obs",
    title,
    body,
    confidence: 0.8,
    project,
    tenant: "local",
    topics: ["fact"],
    entities: ["x"],
  };
}

// The federation layer re-addresses ids as `graph:id`; the prefix is provenance.
function graphOf(prefixedId) {
  const idx = prefixedId.indexOf(":");
  return idx < 0 ? undefined : prefixedId.slice(0, idx);
}

// Write a batch of titles into a freshly opened local, then close it so the
// union can re-open the same path cleanly.
function seedMember(path, project, titles) {
  const store = new SqliteStore(path);
  try {
    for (const title of titles) {
      const result = admit(mkProposal(title, "b", project), { store });
      if (!result || result.accepted !== true || !result.cell) {
        throw new Error(`write not admitted into ${project}: ${title} -> ${JSON.stringify(result?.issues ?? result)}`);
      }
    }
  } finally {
    store.close();
  }
}

// Collect every cell key the union exposes, scanning both active() (a full
// scan, so nothing is paged out) and a search for the conflicting subject.
// active() returns raw cells (.key/.title); search() returns hits shaped
// {..., cell}, not the cell itself.
function unionIds(members) {
  const union = new FederatedReadStore(members);
  try {
    const ids = new Set();
    for (const cell of union.active()) ids.add(cell.key);
    for (const hit of union.search("Service S", { limit: 1000 })) ids.add(hit.cell.key);
    return ids;
  } finally {
    union.close();
  }
}

export function runFederation() {
  const root = mkdtempSync(join(tmpdir(), "sentinel-fed-"));
  const pathA = join(root, "memA.sqlite");
  const pathB = join(root, "memB.sqlite");
  const graphA = "memA";
  const graphB = "memB";

  try {
    // Member A and member B: a real cross-store conflict on "Service S", plus
    // one shared/agreeing fact (same title in both) and one fact unique to each.
    seedMember(pathA, graphA, ["Service S is UP", "Shared agreeing fact", "Unique to A only"]);
    seedMember(pathB, graphB, ["Service S is DOWN", "Shared agreeing fact", "Unique to B only"]);

    // Unique total across both members: A has UP + shared + uniqueA (3),
    // B has DOWN + shared + uniqueB (3). The shared title exists in BOTH stores
    // as distinct cells (no cross-store dedup by design), so the union should
    // expose 6 distinct prefixed ids.
    const uniqueTotal = 6;

    const membersAB = [
      { graph: graphA, path: pathA },
      { graph: graphB, path: pathB },
    ];
    const membersBA = [
      { graph: graphB, path: pathB },
      { graph: graphA, path: pathA },
    ];

    const union = new FederatedReadStore(membersAB);
    let nodes, searchHits;
    try {
      nodes = union.active();
      // Search the conflicting subject across the union.
      searchHits = union.search("Service S", { limit: 1000 });
    } finally {
      union.close();
    }

    const allTitles = nodes.map((n) => n.title);
    const searchTitles = searchHits.map((h) => h.cell.title);

    // (1) reads across the union surface cells from BOTH members.
    const graphsSeen = new Set(nodes.map((n) => graphOf(n.key)).filter(Boolean));
    const bothMembersPresent = graphsSeen.has(graphA) && graphsSeen.has(graphB);
    const distinctIds = new Set(nodes.map((n) => n.key));
    const countOk = distinctIds.size >= uniqueTotal;

    // (2) the cross-store conflict is observable: BOTH "UP" and "DOWN" survive.
    const upPresent =
      allTitles.includes("Service S is UP") || searchTitles.includes("Service S is UP");
    const downPresent =
      allTitles.includes("Service S is DOWN") || searchTitles.includes("Service S is DOWN");
    const conflictPreserved = upPresent && downPresent;

    // (3) provenance: each returned cell still tells you which member it came
    // from. Confirm the UP cell is attributed to A and the DOWN cell to B.
    const upNode = nodes.find((n) => n.title === "Service S is UP");
    const downNode = nodes.find((n) => n.title === "Service S is DOWN");
    const upProvOk = !!upNode && graphOf(upNode.key) === graphA;
    const downProvOk = !!downNode && graphOf(downNode.key) === graphB;
    // Every surfaced cell carries an attributable graph prefix.
    const allProvenanced = nodes.every((n) => graphOf(n.key) !== undefined);
    const provenanceKept = upProvOk && downProvOk && allProvenanced;

    // (4) order-independence: [A,B] vs [B,A] yield the same set of ids.
    const idsAB = unionIds(membersAB);
    const idsBA = unionIds(membersBA);
    const orderIndependent =
      idsAB.size === idsBA.size && [...idsAB].every((id) => idsBA.has(id));

    const n = distinctIds.size;

    let grade;
    if (
      bothMembersPresent &&
      countOk &&
      conflictPreserved &&
      provenanceKept &&
      orderIndependent
    ) {
      grade = "SELF-VERIFIED";
    } else if (conflictPreserved && bothMembersPresent && countOk) {
      // Conflict surfaces and both members are present, but provenance or
      // order-independence is incomplete.
      grade = "RESIDUAL(@SELF-VERIFIED)";
    } else if (bothMembersPresent && countOk) {
      // Both members surface but the conflict did not (one side silently lost):
      // the union effectively merged/dropped the conflict.
      grade = "ASSERTED";
    } else {
      // The union failed to surface both members at all.
      grade = "ABSENT";
    }

    const metric =
      `union surfaces both members (${graphsSeen.size}/2 graphs, ${n} cells, >= ${uniqueTotal} unique=${countOk}); ` +
      `cross-store conflict ${conflictPreserved ? "preserved (UP@A + DOWN@B both returned)" : "LOST"}; ` +
      `provenance ${provenanceKept ? "kept (every cell graph-attributable)" : "incomplete"}; ` +
      `${orderIndependent ? "order-independent ([A,B]==[B,A] id set)" : "order-dependent"}`;

    return { n, metric, grade };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Print when run directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runFederation();
  console.log(JSON.stringify(result, null, 2));
}
