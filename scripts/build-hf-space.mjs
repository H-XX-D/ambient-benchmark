#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "dist", "hf-space");
const SPACE_SOURCE = join(ROOT, "huggingface-space");

if (!existsSync(join(SPACE_SOURCE, "README.md"))) throw new Error("Hugging Face Space card is missing");
for (const [outputSize, generatorSize, seedSet] of [
  ["small", "small", "calibration-v1"],
  ["medium-confirmatory-v2", "medium", "confirmatory-v2"],
]) {
  if (!existsSync(join(ROOT, "corpora", "out", "hard", outputSize, "segments.jsonl"))) {
    execFileSync(process.execPath, [join(ROOT, "corpora", "build-hard-corpus.mjs"), generatorSize, "--seed-set", seedSet], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
}

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });

for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md", "RULES.md"]) {
  cpSync(join(ROOT, file), join(OUTPUT, file));
}
for (const directory of ["adapters", "model", "tiers", "scripts", "vendor/recall"]) {
  cpSync(join(ROOT, directory), join(OUTPUT, directory), { recursive: true });
}
cpSync(
  join(ROOT, "examples", "huggingface-memory-space"),
  join(OUTPUT, "examples", "huggingface-memory-space"),
  { recursive: true },
);
rmSync(join(OUTPUT, "vendor", "recall", ".DS_Store"), { force: true });
for (const file of ["docs/ATTRIBUTION.md", "docs/EVALUATION_PROTOCOL.md", "docs/HARD_QUESTION_DESIGN.md", "protocols/ambient-hard-hosted-v3.json", "submissions/schema.json"]) {
  const destination = join(OUTPUT, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(ROOT, file), destination);
}
for (const size of ["small", "medium-confirmatory-v2"]) {
  cpSync(join(ROOT, "corpora", "out", "hard", size), join(OUTPUT, "corpora", "out", "hard", size), { recursive: true });
}
for (const file of ["corpora/build-hard-corpus.mjs", "corpora/hard-behavior-core.mjs"]) {
  const destination = join(OUTPUT, file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(ROOT, file), destination);
}
cpSync(join(SPACE_SOURCE, "README.md"), join(OUTPUT, "README.md"));
cpSync(join(SPACE_SOURCE, "app.py"), join(OUTPUT, "app.py"));

console.log("built dist/hf-space as an AMBIENT Gradio-hosted runner Space");
