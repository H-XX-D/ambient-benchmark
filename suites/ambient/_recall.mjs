// Single point of truth for importing the vendored Recall build from anywhere
// under suites/ambient/. Vendored dist is flat (vendor/recall/dist/*.js, no
// src/ or core/ subfolders) and symlinked at suites/dist -> ../vendor/recall/dist.
// index.js already re-exports federated-store.js, so this one line covers both.
export * from "../dist/index.js";
