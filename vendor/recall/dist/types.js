// MAL core types: the v5 cell, its directed signed edges, and the scores legend.
// This is the shared contract every R0 module builds against. Declarations only.
export const KINDS = [
    "dec", "obs", "bel", "tsk", "obj", "rsk", "ref", "ver", "hyp", "prg",
];
export const HANDLE_HEX_LENGTH = 4;
export const HANDLE_SOFT_LENGTH_CAP = 41;
export const RELATIONS = [
    "supports", "contradicts", "concerns", "depends_on", "supersedes", "derived_from",
];
export const STABILITIES = ["ephemeral", "volatile", "stable"];
// Provenance: who produced the cell and how trustworthy the production was.
// producedBy is the actor id calibration keys on; signatureStatus is the
// cryptographic-attestation upgrade path (unsigned by default until a key signs).
export const ORIGINS = ["human", "llm", "daemon", "connector", "program", "external"];
export const VERIFICATIONS = ["unverified", "checked", "tested", "external"];
export const SIGNATURE_STATUSES = ["unsigned", "signed", "verified"];
export const SENSITIVITIES = ["public", "private", "secret"];
export const OPERATIONS = ["create", "update", "supersede", "link", "annex"];
