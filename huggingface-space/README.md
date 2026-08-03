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
scope. The reader is fixed and the generated hard worlds carry exact mechanical
answer oracles. Every run ends with one downloadable evidence bundle.
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
chooses to share one. A complete 260-world bundle is exported only after
all 1,040 mechanically scored tier rows pass the integrity gate.

Run scopes use AMBIENT's hard evaluator from the development worktree: 13
calibration-smoke worlds (one per ability), the complete 52-world calibration
set, or the 260-world candidate-frozen protocol. Every independent world uses
private opaque values, query-coupled cover history, a derivation proof, and an
exact oracle. The UI discloses the rough worst-case single-tier margin and call
count. Repeating a world is not counted as a new datapoint.

The thirteen reader-facing abilities are knowledge update, contradiction
resolution, multi-session reasoning, temporal reasoning, event ordering,
information extraction, preference following, instruction following,
summarization, abstention, trust discrimination, belief-revision audit, and
poisoned-memory quarantine. No LLM judge is used.

Recall's eighteen-area structural profile remains the second AMBIENT capability
axis and is included in the downloadable benchmark. It is kept separate because
concurrency, endurance, federation, set integrity, and related systems behavior
cannot honestly be converted into prose questions and called structural evidence.

This Space uses a Gradio interface around the repository's Node 24 harness.
`app.py` verifies a checksum-pinned official Node binary when the runtime does
not already provide a compatible version, then invokes the same four-tier
pipeline tested in the Docker image.

Source and protocol: [H-XX-D/ambient-benchmark](https://github.com/H-XX-D/ambient-benchmark)
