#!/usr/bin/env node
import assert from "node:assert/strict";
import { normalizeExternalSpaceUrl } from "../adapters/external-space-url.mjs";

assert.equal(
  normalizeExternalSpaceUrl("https://alice-memory.hf.space/"),
  "https://alice-memory.hf.space",
);
assert.equal(
  normalizeExternalSpaceUrl("http://127.0.0.1:8091/", { allowInsecureLoopback: true }),
  "http://127.0.0.1:8091",
);

for (const rejected of [
  "http://alice-memory.hf.space/",
  "https://huggingface.co/spaces/alice/memory",
  "https://127.0.0.1/",
  "https://169.254.169.254/",
  "https://alice-memory.hf.space/private",
  "https://alice-memory.hf.space/?token=secret",
  "https://user:secret@alice-memory.hf.space/",
]) {
  assert.throws(() => normalizeExternalSpaceUrl(rejected), Error, rejected);
}

console.log("external Hugging Face memory Space URL gate passed");
