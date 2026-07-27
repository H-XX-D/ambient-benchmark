# Hugging Face Space runner

Live Space: <https://huggingface.co/spaces/tjhendrix/ambient-benchmark>

AMBIENT uses a **Gradio Space around the Node harness** as an ephemeral execution backend. A visitor
opens the Space, signs in with Hugging Face, and chooses the memory adapter,
reader, independent judge, and run scope. Gradio injects the participant's
short-lived OAuth token into the callback. The Space executes the same four-tier
harness as the repository and returns a downloadable evidence bundle.

## Hosting split

- **Vercel:** protocol, evidence disclosures, public leaderboard UI, and a direct link to the Space.
- **Supabase:** verified submissions and a separate complete-hosted-run table.
  Browser access is read-only under Row Level Security.
- **Hugging Face Spaces:** transient benchmark execution and bundle download.
- **GitHub:** canonical harness, protocol, adapter contract, evidence bundles,
  review, and publication history.

Every hosted bundle is marked `unreviewed`. A complete 400-question run is
automatically inserted into the separately labeled hosted-results table only
after all 1,600 tier rows pass the artifact validator with zero judge errors and
the sampling manifest proves 40 unique items in each of ten abilities.
Repository validation remains the gate for the verified architecture table.

The hosted scopes are 10, 100, 200, and 400 unique BEAM-small questions. Sampling
is seeded and stratified over all ten abilities; the evidence manifest records
the per-ability counts and selection hash. The 10-question scope is a smoke only.
The 100- and 200-question scopes are progressively more informative development
runs. The 400-question scope is the complete BEAM-small question set. None becomes
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

The server separately reads `AMBIENT_SUPABASE_SECRET_KEY` from a Hugging Face
Space Secret for complete-run publication and the non-secret
`AMBIENT_SUPABASE_URL` Variable. That operator secret never enters the browser.
Completed job files are kept on the Space’s ephemeral disk for at most 30
minutes. The public site uses a publishable Supabase key constrained by read-only
Row Level Security policies.

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
