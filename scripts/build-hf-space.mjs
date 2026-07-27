#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "dist", "hf-space");
const SPACE_SOURCE = join(ROOT, "huggingface-space");

if (!existsSync(join(SPACE_SOURCE, "README.md"))) throw new Error("Hugging Face Space card is missing");
if (!existsSync(join(ROOT, "corpora", "out", "beam", "small", "segments.jsonl"))) throw new Error("hosted-runner corpus is missing");

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });

for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md", "RULES.md"]) {
  cpSync(join(ROOT, file), join(OUTPUT, file));
}
for (const directory of ["adapters", "model", "tiers", "scripts", "vendor/recall"]) {
  cpSync(join(ROOT, directory), join(OUTPUT, directory), { recursive: true });
}
rmSync(join(OUTPUT, "vendor", "recall", ".DS_Store"), { force: true });
for (const file of ["docs/ATTRIBUTION.md", "docs/EVALUATION_PROTOCOL.md", "submissions/schema.json"]) {
  const destination = join(OUTPUT, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(ROOT, file), destination);
}
cpSync(join(ROOT, "corpora", "out", "beam", "small"), join(OUTPUT, "corpora", "out", "beam", "small"), { recursive: true });
cpSync(join(SPACE_SOURCE, "README.md"), join(OUTPUT, "README.md"));
cpSync(join(SPACE_SOURCE, "app.py"), join(OUTPUT, "app.py"));

console.log("built dist/hf-space as an AMBIENT Gradio-hosted runner Space");
