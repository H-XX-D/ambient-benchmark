import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = join(HERE, "fixtures", "l4-expiry-v1.json");
export const L4_POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));

// Changing the policy file without an explicit versioned migration must fail. This
// digest is over parsed canonical content, so whitespace-only edits do not create a
// semantic migration. A deliberate rule change gets a new policy file and version.
export const L4_POLICY_DEFINITION_SHA256 = "aa7659becfa2e9cf7a71e24a578a13d0aa722b50398bec98d977139a9c647784";

const MONTHS = new Map([
  ["january", 0], ["february", 1], ["march", 2], ["april", 3],
  ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function expiryPolicyDefinitionHash(policy = L4_POLICY) {
  return createHash("sha256").update(canonical(policy)).digest("hex");
}

function lastMillisecondOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 1) - 1).toISOString();
}

export function extractExpiryV1(text, createdAt) {
  const normalized = String(text ?? "").toLowerCase();
  const explicitYear = (normalized.match(/\b(20\d{2})\b/) || [])[1];
  const createdYear = new Date(createdAt).getUTCFullYear();
  if (!Number.isInteger(createdYear)) throw new Error(`invalid createdAt: ${createdAt}`);
  const year = Number(explicitYear || createdYear);

  if (/\bq1\b/.test(normalized)) return lastMillisecondOfMonth(year, 2);
  if (/\bq2\b/.test(normalized)) return lastMillisecondOfMonth(year, 5);
  for (const [month, index] of MONTHS) {
    if (normalized.includes(month)) return lastMillisecondOfMonth(year, index);
  }
  return null;
}

export function isExpiredV1(expiresAt, evaluationTime) {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt).getTime();
  const now = new Date(evaluationTime).getTime();
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) {
    throw new Error(`invalid expiry comparison: expiresAt=${expiresAt} evaluationTime=${evaluationTime}`);
  }
  return expiry <= now;
}

export function verifyExpiryPolicyV1() {
  const actualHash = expiryPolicyDefinitionHash();
  if (actualHash !== L4_POLICY_DEFINITION_SHA256) {
    throw new Error(
      `L4 expiry definition drift: ${actualHash} !== ${L4_POLICY_DEFINITION_SHA256}; ` +
      "add a new versioned policy instead of mutating l4-expiry.v1",
    );
  }
  const failures = [];
  for (const test of L4_POLICY.extractionCases) {
    const actual = extractExpiryV1(test.text, test.createdAt);
    if (actual !== test.expected) failures.push(`${test.id}: ${actual} !== ${test.expected}`);
  }
  for (const test of L4_POLICY.decisionCases) {
    const actual = isExpiredV1(test.expiresAt, test.evaluationTime);
    if (actual !== test.expected) failures.push(`${test.id}: ${actual} !== ${test.expected}`);
  }
  if (failures.length) throw new Error(`L4 expiry policy witness failed:\n${failures.join("\n")}`);
  return {
    schema: "ambient.l4-expiry-policy-witness.v1",
    policy: L4_POLICY.version,
    definitionSha256: actualHash,
    extractionCases: L4_POLICY.extractionCases.length,
    decisionCases: L4_POLICY.decisionCases.length,
    verified: true,
  };
}
