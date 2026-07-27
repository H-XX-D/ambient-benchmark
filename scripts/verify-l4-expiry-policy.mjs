#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExpiryPolicyV1 } from "../suites/ambient/l4-expiry-policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const witness = verifyExpiryPolicyV1();
const out = join(ROOT, "results", "l4-expiry-policy-witness.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(witness, null, 2)}\n`);
console.log(
  `L4 expiry policy stable: ${witness.policy} ${witness.definitionSha256} ` +
  `(${witness.extractionCases + witness.decisionCases} frozen boundary cases)`,
);
