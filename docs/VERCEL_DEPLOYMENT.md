# Deploying AMBIENT with Vercel

## Recommended architecture

Deploy the public reading, results, and authenticated-runner link to Vercel. Run the benchmark itself outside Vercel's static deployment, and keep automatic hosted results visibly separate from evidence-reviewed submissions.

The current product uses Vercel for the static publication, leaderboard UI, and direct Space link; Hugging Face Spaces for OAuth-authenticated execution; Supabase for read-only public result tables; and GitHub for the canonical harness and verified-evidence review path. A complete hosted run may enter the separately labeled unreviewed table automatically; it never enters the verified architecture table without repository evidence review.

```text
browser → Vercel static site → Supabase read-only result tables
       ↘ direct link → Hugging Face OAuth → Space → HF Inference Providers
                                                 ↘ temporary evidence bundle
                                           ↘ complete-run metadata → Supabase
GitHub pull request → evidence validation → verified Supabase row
```

This repository is immediately deployable as a dependency-free static Vercel project. `vercel.json` runs `npm run site:build` and publishes `site/`. That build derives the evidence cards and leaderboard from checked repository artifacts, fails closed on malformed submissions, and explicitly marks mock pipeline output as non-publishable.

## Why the runner is not a Serverless Function

The benchmark starts local adapter processes, performs many model calls, writes transcripts, and may run for minutes or hours. Vercel Functions remain request-bound and have plan- and configuration-dependent duration, memory, payload, and bundle limits; those limits continue to evolve. The official limits page currently documents a 4.5 MB request/response payload ceiling. A multi-process benchmark with large evidence bundles is a job, not an HTTP request, even when a small smoke happens to fit inside current duration limits.

Use one of these job paths:

1. **Simple and reproducible:** GitHub Actions or another trusted CI runner executes a pinned commit, uploads the transcript/manifest/verdict bundle, and opens a pull request that updates the public manifest.
2. **Vercel-native interactive runs:** a Vercel Workflow starts a Vercel Sandbox using the Node 24 runtime, checks out the pinned commit, installs only declared dependencies, runs the suite, validates artifacts, stores outputs, and returns an artifact identifier. Sandbox is the Vercel primitive designed for isolated code execution; Workflow supplies durable orchestration across long steps and retries.

Do not put provider secrets into the repository, browser storage, logs, or public artifacts. The static Vercel site does not collect credentials. Hugging Face OAuth supplies the participant's short-lived, inference-scoped token directly inside the execution Space, which publishes only model identifiers and configuration fingerprints.

Primary sources:

- [Vercel Sandbox overview](https://vercel.com/docs/sandbox)
- [Sandbox duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [Vercel Workflows](https://vercel.com/docs/workflows)
- [`vercel.json` project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [`vercel deploy` CLI](https://vercel.com/docs/cli/deploy)

## Static site deployment

Prefer Vercel Git integration for the public project: non-production branches
and pull requests receive immutable preview deployments; the configured
production branch deploys only after merge. The repository-owned `vercel.json`
keeps the build command, output directory, clean URLs, and response headers in
version control. Use the CLI path below for a manual preview or a controlled CI
artifact, not as a substitute for review.

Preflight without exposing secret values:

```bash
npm run site:build
npm run site:check
vercel --version
vercel whoami
```

Link only after confirming the intended Vercel scope and project:

```bash
vercel teams ls
vercel projects ls --scope <team>
vercel link --yes --scope <team> --project <project>
vercel build
vercel deploy --prebuilt
```

Promote the exact validated preview artifact only when an explicit production
release is intended:

```bash
vercel promote <validated-preview-url>
```

The site needs no runtime secrets and includes no Gradio client or key-entry code. The content-security policy permits browser connections only to the read-only Supabase endpoint used by the leaderboard; navigating to Hugging Face is an ordinary external link. Vercel should use Node 24 to match the repository engine. The response headers disable unnecessary browser capabilities and cache versioned assets.

## Vercel-native runner expansion

If the hosted runner later moves from Hugging Face to Vercel-native infrastructure, keep the HTTP layer small:

- `POST /api/runs` validates a public configuration, creates an idempotency key, and starts a workflow.
- The workflow creates an isolated Node 24 sandbox from a pinned snapshot or commit.
- The sandbox receives only run-scoped secrets and cannot write directly to the public results index.
- The benchmark emits its run manifest, transcript, judge manifest, verdicts, and summary.
- A separate validator runs `verify:model-isolation`, artifact schema checks, and the publication gate.
- Valid bundles are stored under a content hash; only then does a signed index point the site at them.
- `GET /api/runs/:id` returns status and artifact hashes, not raw secret-bearing logs.

Use Vercel Blob or another immutable object store for artifacts larger than a Function response. Use a small durable database only for run metadata, idempotency, and state transitions. Never use the Function's local filesystem as durable storage.

### Minimum operating stack

1. **Identity:** GitHub OAuth or a GitHub App identifies submitters and ties each system to a repository and immutable commit.
2. **Run database:** provision Postgres through the Vercel Marketplace. Vercel Postgres is retired; Neon or Supabase are suitable integrations. Store users, systems, submissions, runs, artifacts, publication decisions, and audit events. Enforce a unique idempotency key.
3. **Artifact storage:** use a private Vercel Blob store for raw logs and transcripts. Store bundles under their content hash and treat them as immutable. Expose only validated, redacted evidence through authenticated or deliberately public URLs.
4. **Orchestration:** use Vercel Workflows for the multi-step run lifecycle. A separate Queue is unnecessary at launch because Workflows already provides durable dispatch; add a Queue only when independent consumers or explicit concurrency control are needed.
5. **Execution:** create a fresh Vercel Sandbox per run from a pinned benchmark snapshot. Pro is the practical starting plan when a run may exceed Hobby's 45-minute sandbox limit; current Pro and Enterprise sandboxes can run for up to 24 hours.
6. **Secrets:** if execution later moves to Vercel Sandbox, preserve the current participant-funded boundary with delegated, short-lived authorization. Keep tokens out of storage and logs, restrict egress to allowlisted provider endpoints, and keep the service-owned publishing credential separate.
7. **Abuse controls:** require authentication, set per-user daily run and spend limits, cap wall time/tokens/artifact size, rate-limit `POST /api/runs`, and bound concurrency. Start firewall rules in log mode before enforcing them.
8. **Operations:** record structured step logs, cost, retry count, failure class, benchmark commit, adapter commit, control fingerprint, and artifact hash. Alert on stuck runs, repeated retries, or publication-gate failures.

### Run state machine

```text
submitted → admitted → queued → provisioning → running → validating
                                                       ↘ rejected
validating → review_pending → published
           ↘ failed
```

Only `published` runs enter the verified leaderboard. Automatically recorded complete runs remain in the distinct hosted-results table. Retries must be idempotent, and a corrected result supersedes an earlier immutable entry rather than overwriting its evidence.

### Architecture-track trust boundary

For architecture-only claims, the service owns and pins the corpus, reader, judge, classifier, prompts, budgets, tier schedule, and scoring code. The submitter supplies only the declared memory adapter. Start with reviewed or allowlisted adapters; accepting arbitrary repositories expands the system into a public untrusted-code service and requires stronger egress controls, moderation, and incident response.

Do not compare architecture rows across different control fingerprints. Continue publishing native end-to-end results in a separate track.

## Release checklist

- Preview deployment renders at mobile and desktop widths.
- `site/data/status.json` matches repository evidence.
- No mock-reader or mock-judge score appears as a quality comparison.
- The editorial architecture image is local, cropped to remove upstream interface branding, and has a text alternative.
- Internal GitHub links resolve after the branch is merged.
- Production deployment is an explicit promotion, not an accidental side effect of local testing.
