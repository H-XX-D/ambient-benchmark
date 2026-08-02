---
title: AMBIENT Agentic memory baseline isolated evaluation w/ Neutral Tiers
emoji: 🧠
colorFrom: gray
colorTo: red
sdk: gradio
app_file: app.py
pinned: false
license: mit
short_description: Test memory architecture around a fixed reader model.
hf_oauth: true
hf_oauth_expiration_minutes: 720
hf_oauth_scopes:
  - inference-api
---

# AMBIENT Space runner

The Space asks for a participant-owned Hugging Face memory Space and a run
scope. The reader and independent judge are fixed benchmark controls, not
participant selections. Every run ends with one downloadable evidence bundle.
The Space does not operate a leaderboard or publish a participant's result
automatically.

The participant's memory Space implements AMBIENT's small HTTP adapter contract.
The runner calls that public `https://…hf.space` origin; it does not upload or
execute participant code. Redirects, credentials in URLs, paths, and non-Hugging
Face hosts are rejected. A random run ID namespaces simultaneous tests. The
starter adapter lives at
[`examples/huggingface-memory-space`](https://huggingface.co/spaces/tjhendrix/ambient-benchmark/tree/main/examples/huggingface-memory-space).

Participants sign in with Hugging Face. Beyond Hugging Face's standard
`openid profile` sign-in scopes, the Space requests only `inference-api`, and
Gradio injects a short-lived user token into the run callback. There are no
API-key fields. The token is used only with Hugging
Face Inference Providers, held only for the active run, redacted from captured
errors, and excluded from logs and evidence artifacts. It is never forwarded to
the participant's memory Space.

Hugging Face Inference uses the OpenAI-compatible
`https://router.huggingface.co/v1` endpoint, so inference usage is charged to
the signed-in participant's Hugging Face account rather than the Space owner.

All scopes remain private to their exported bundles unless the participant
chooses to share one. A complete 110-question bundle is exported only after
all 440 judged tier rows pass the integrity gate.

Run scopes use the authored AMBIENT areas corpus: 18 smoke questions (one
per area), 54 pilot questions (three per area), or the complete 110-question
corpus. The UI discloses the rough worst-case single-tier margin and call count.
Repeating a question is not counted as a new datapoint.

The eighteen areas are adoption, attribution, anteriority, authority, reader
independence, contradiction, set integrity, calibration, reactivity,
concurrency, supersession integrity, temporality, deep contradiction, retrieval
fidelity, adversarial robustness, endurance, federation, and modality. These
are real memory problems that every participant system faces. The hosted corpus
scores observable answers and traced support, not whether a system implements
Recall's internal mechanisms.

This Space uses a Gradio interface around the repository's Node 24 harness.
`app.py` verifies a checksum-pinned official Node binary when the runtime does
not already provide a compatible version, then invokes the same four-tier
pipeline tested in the Docker image.

Source and protocol: [H-XX-D/ambient-benchmark](https://github.com/H-XX-D/ambient-benchmark)
