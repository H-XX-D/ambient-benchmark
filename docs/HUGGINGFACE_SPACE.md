# Hugging Face Space runner

Live Space: <https://huggingface.co/spaces/tjhendrix/ambient-benchmark>

AMBIENT uses a **Gradio Space around the Node harness** as an ephemeral execution backend. A visitor
opens the Space, signs in with Hugging Face, connects a public Hugging Face
memory Space, and chooses a run scope. The reader and independent judge remain fixed controls. Gradio injects the participant's
short-lived OAuth token into the callback. The Space executes the same four-tier
harness as the repository and returns a downloadable evidence bundle.

The connected memory Space must implement `docs/ADAPTER_CONTRACT.md`. The runner
accepts only a root `https://…hf.space` origin, blocks redirects, and sends an
opaque `X-AMBIENT-Run-ID` header for per-run namespace isolation. It never
executes uploaded code and never forwards the participant's OAuth token to the
memory Space. A working Gradio/FastAPI starter is in
`examples/huggingface-memory-space/`.

## Hosting split

- **Vercel:** protocol, evidence disclosures, and a direct link to the Space.
- **Hugging Face Spaces:** transient benchmark execution and bundle download.
- **GitHub:** canonical harness, protocol, adapter contract, evidence bundles,
  and integrity review.

Every Space bundle is marked `unreviewed` and nothing is published automatically.
A complete 92-question bundle is exported only after all 368 tier rows pass
the artifact validator with zero judge errors and the sampling manifest proves
coverage of all fifteen AMBIENT abilities.

The hosted scopes are 15, 45, and 92 unique questions from the authored AMBIENT
areas corpus. Sampling is seeded and stratified over all fifteen abilities; the
evidence manifest records the per-ability counts and selection hash. The 15-question
scope is a smoke only, the 45-question scope is a pilot, and 92 is the complete
areas corpus. None becomes
publishable merely by being large: the architecture publication gate separately
requires at least 30 unique questions per ability, three balanced repeats, a
component declaration, a real independent judge, and a segment-cluster interval.

Each unique question produces four reader answers and four judge calls, plus
ingest/checker calls. Large scopes can therefore be slow and expensive; the user
is responsible for provider charges.

## Authentication and token handling

The Space card enables Hugging Face OAuth. Hugging Face always includes the
standard `openid profile` sign-in scopes; the only additional scope requested
is `inference-api`. The UI contains no API-key fields. Gradio supplies a short-lived
`gr.OAuthToken` directly to the benchmark callback, which fails closed when no
authenticated token is present. The callback calls only the fixed
OpenAI-compatible `https://router.huggingface.co/v1` endpoint, passes the token
to the child process only for the active run, redacts it from captured errors,
and omits it from logs, manifests, browser results, and evidence bundles.

Routed inference uses the participant's Hugging Face account, credits, and
quota. The Space owner supplies orchestration compute but no model-provider
credential and does not fund participant inference calls.

Completed job files are kept on the Space’s ephemeral disk for at most 30
minutes.

## Why the Space is configured as Gradio

The `tjhendrix` account creation screen currently marks Docker as paid and
offers Gradio on ZeroGPU. Hugging Face documents a limited free-personal-account
exception for Gradio Spaces on ZeroGPU. ZeroGPU requires at least one registered
`@spaces.GPU` function, so the app registers a one-second hidden probe while all
benchmark work remains CPU/network work in the ordinary Gradio job.

The benchmark itself remains Node 24 code. `app.py` uses a compatible installed
Node when present; otherwise it downloads the official Node 24.10.0 archive for
the runtime architecture, verifies its pinned SHA-256, and invokes the same
four-tier Node pipeline from the Gradio callback.

## Build and verify

```bash
npm run space:build
npm run space:check
```

The upload-ready Gradio Space is written to `dist/hf-space/`.

## Create and publish

```bash
hf auth login
hf repo create <namespace>/ambient-benchmark --repo-type space --space_sdk gradio
hf upload <namespace>/ambient-benchmark dist/hf-space . --repo-type space --commit-message "Publish AMBIENT hosted runner"
```

Gradio exposes the named `/run_benchmark` event, but OAuth remains enforced in
the callback even when an unauthenticated caller invokes that event directly.
Runtime storage is ephemeral, which matches the runner’s token and artifact-retention boundary.

References:

- [Spaces overview and hardware](https://huggingface.co/docs/hub/spaces-overview)
- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/en/index)
- [OAuth for Hugging Face Spaces](https://huggingface.co/docs/hub/en/spaces-oauth)
- [Gradio OAuth](https://www.gradio.app/guides/sharing-your-app)
- [ZeroGPU Spaces](https://huggingface.co/docs/hub/spaces-zerogpu)
- [Handling Space dependencies](https://huggingface.co/docs/hub/spaces-dependencies)
- [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [Spaces disk storage](https://huggingface.co/docs/hub/spaces-storage)
- [Uploading to the Hub](https://huggingface.co/docs/huggingface_hub/guides/upload)
