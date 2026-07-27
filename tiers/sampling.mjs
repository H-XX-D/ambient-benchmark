import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableSegmentOrder(seed, ability, left, right) {
  const leftKey = sha256(`${seed}:${ability}:${left.id}`);
  const rightKey = sha256(`${seed}:${ability}:${right.id}`);
  return leftKey.localeCompare(rightKey) || String(left.id).localeCompare(String(right.id));
}

export function approximateTierMargin95Points(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.round((98 / Math.sqrt(n)) * 10) / 10;
}

export function selectStratifiedSegments(all, options = {}) {
  const limit = Number(options.limit ?? 0);
  const perAbility = Number(options.perAbility ?? 0);
  const seed = String(options.seed ?? "ambient-v1");
  if (!Array.isArray(all) || all.length === 0) throw new Error("segment corpus is empty");
  if (!Number.isInteger(limit) || limit < 0) throw new Error("sample limit must be a non-negative integer");
  if (!Number.isInteger(perAbility) || perAbility < 0) throw new Error("per-ability sample must be a non-negative integer");

  const ids = new Set();
  const grouped = new Map();
  for (const segment of all) {
    if (!segment?.id || !segment?.ability) throw new Error("every segment needs an id and ability");
    if (ids.has(segment.id)) throw new Error(`duplicate segment id: ${segment.id}`);
    ids.add(segment.id);
    if (!grouped.has(segment.ability)) grouped.set(segment.ability, []);
    grouped.get(segment.ability).push(segment);
  }

  const abilities = [...grouped.keys()].sort();
  for (const ability of abilities) {
    grouped.get(ability).sort((left, right) => stableSegmentOrder(seed, ability, left, right));
  }

  const selected = [];
  const selectedByAbility = Object.fromEntries(abilities.map((ability) => [ability, 0]));
  const availableByAbility = Object.fromEntries(abilities.map((ability) => [ability, grouped.get(ability).length]));
  const globalTarget = limit || all.length;
  const abilityCap = perAbility || Number.POSITIVE_INFINITY;

  for (let round = 0; selected.length < globalTarget; round += 1) {
    let added = 0;
    for (const ability of abilities) {
      if (selected.length >= globalTarget) break;
      if (round >= abilityCap) continue;
      const segment = grouped.get(ability)[round];
      if (!segment) continue;
      selected.push(segment);
      selectedByAbility[ability] += 1;
      added += 1;
    }
    if (added === 0) break;
  }

  const coveredCounts = Object.values(selectedByAbility).filter((count) => count > 0);
  const selectedIds = selected.map((segment) => segment.id);
  return {
    segments: selected,
    metadata: {
      method: "seeded-stratified-round-robin-v1",
      seed,
      requestedLimit: limit,
      requestedPerAbility: perAbility,
      availableSegments: all.length,
      availableAbilities: abilities.length,
      availableByAbility,
      selectedSegments: selected.length,
      selectedAbilities: coveredCounts.length,
      selectedByAbility,
      minPerAbility: coveredCounts.length ? Math.min(...coveredCounts) : 0,
      maxPerAbility: coveredCounts.length ? Math.max(...coveredCounts) : 0,
      selectionSha256: sha256(selectedIds.join("\n")),
      approximateWorstCaseTierMargin95Points: approximateTierMargin95Points(selected.length),
    },
  };
}
