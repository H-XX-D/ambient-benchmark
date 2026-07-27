---
title: AMBIENT Runner
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

# AMBIENT hosted runner

Choose a memory adapter, reader, independent judge, and run scope. The Space
runs the same four-tier AMBIENT harness used by the public repository and
returns a downloadable evidence bundle. The public website links directly to
this authenticated runner.

Participants sign in with Hugging Face. Beyond Hugging Face's standard
`openid profile` sign-in scopes, the Space requests only `inference-api`, and
Gradio injects a short-lived user token into the run callback. There are no
API-key fields. The token is used only with Hugging
Face Inference Providers, held only for the active run, redacted from captured
errors, and excluded from logs and evidence artifacts.

The only operator credential is `AMBIENT_SUPABASE_SECRET_KEY`, used server-side
to publish metadata for eligible complete runs. It is never returned to the
browser. Hugging Face Inference uses the OpenAI-compatible
`https://router.huggingface.co/v1` endpoint, so inference usage is charged to
the signed-in participant's Hugging Face account rather than the Space owner.

All runs remain unreviewed until their evidence bundle passes repository review.
A complete 400-question run is also recorded automatically on a separate hosted
results table after structural validation; it is never presented as a verified
architecture submission.

Run scopes use unique, seeded, stratified BEAM questions: 10 smoke (1 per
ability), 100 pilot (10 per ability), 200 extended (20 per ability), or the
complete 400-question BEAM-small corpus (40 per ability). The UI discloses the
rough worst-case single-tier margin and call count. Repeating a question is not
counted as a new datapoint.

This Space uses a Gradio interface around the repository's Node 24 harness.
`app.py` verifies a checksum-pinned official Node binary when the runtime does
not already provide a compatible version, then invokes the same four-tier
pipeline tested in the Docker image.

Source and protocol: [H-XX-D/ambient-benchmark](https://github.com/H-XX-D/ambient-benchmark)
