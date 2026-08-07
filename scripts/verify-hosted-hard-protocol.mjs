#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "protocols", "ambient-hard-hosted-v3.json");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function treeDigest(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

if (!existsSync(MANIFEST)) throw new Error(`missing protocol manifest: ${MANIFEST}`);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
function lockedPath(path) {
  const direct = join(ROOT, path);
  if (existsSync(direct)) return direct;
  if (path === "huggingface-space/app.py" && existsSync(join(ROOT, "app.py"))) return join(ROOT, "app.py");
  throw new Error(`missing locked protocol file: ${path}`);
}
const actual = {
  files: Object.fromEntries(manifest.lockedFiles.map((path) => [path, sha256(readFileSync(lockedPath(path)))])),
  corpus: treeDigest(join(ROOT, manifest.corpus.path)),
};

if (process.argv.includes("--print")) {
  console.log(JSON.stringify(actual, null, 2));
  process.exit(0);
}

const failures = [];
for (const [path, digest] of Object.entries(actual.files)) {
  if (manifest.hashes.files[path] !== digest) failures.push(`${path}: expected ${manifest.hashes.files[path]} got ${digest}`);
}
if (manifest.hashes.corpus.files !== actual.corpus.files || manifest.hashes.corpus.sha256 !== actual.corpus.sha256) {
  failures.push(`corpus: expected ${JSON.stringify(manifest.hashes.corpus)} got ${JSON.stringify(actual.corpus)}`);
}
if (failures.length) {
  console.error(`AMBIENT hosted hard protocol lock FAILED (${failures.length} mismatch(es)):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`AMBIENT hosted hard protocol ${manifest.protocol} lock verified: ${Object.keys(actual.files).length} files + ${actual.corpus.files} corpus files`);
