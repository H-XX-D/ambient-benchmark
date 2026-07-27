# Community leaderboard submissions

AMBIENT publishes community results only from complete, reviewable evidence
bundles. Runs may happen on contributor-controlled infrastructure or through
the optional Hugging Face Space. The Vercel site does not execute benchmarks or
accept credentials. The hosted runner accepts scoped reader and judge keys only
for the active run and produces an unreviewed bundle; it never publishes a row.

## Bundle layout

Create `submissions/<system>/<run-id>/` containing:

- `submission.json` conforming to `submissions/schema.json`;
- the run manifest;
- the raw transcript;
- the judge manifest and verdicts;
- the generated summary; and
- any adapter declaration required by the architecture track.

Every path in `submission.json.artifacts` is relative to the bundle directory.
Record the SHA-256 of every artifact in `submission.json.artifactSha256`; the
site build recomputes each digest before publishing an entry. On macOS or Linux,
`shasum -a 256 <file>` prints the required value.
Do not submit API keys, authorization headers, private conversations, hidden
prompts you are not permitted to publish, or personal data.

## Publication requirements

1. Use `track: "architecture"` only when the model-isolation gate passes across
   the comparison. Otherwise use `track: "native-system"`.
2. Include all four tiers for every paired item and replicate. `result.items` is
   the number of unique question segments; repeats are not additional items.
3. Include a judge manifest with zero judge errors.
4. For the architecture track, report the paired attributed-completion lift
   `T4 − T1`, its paired 95% interval, and both cell scores. For the native track,
   report T3 end-to-end attributed completion and its 95% interval. Raw answer
   accuracy is not a memory-architecture score.
5. Pin the repository commit and system version.
6. Set `publicationGate` to `passed` only after the repository checks succeed.
7. Open a pull request containing the complete bundle. Review may reproduce the
   run, request corrections, or decline publication.

The site generator fails closed: malformed entries, missing or hash-mismatched
artifacts, path escapes, incomplete four-tier pairs, reader drift, mock reader
or judge output, judge errors, metric/summary disagreement, and non-passing
publication gates stop the build rather than silently producing a row.

Architecture entries additionally require seeded stratified coverage of every
corpus ability with at least 30 unique questions per ability, balanced tier order,
at least three repeats, and no adapter-side ingest or query generative model. The leaderboard
displays a control fingerprint derived from the pinned reader, judge,
classifier, prompts, corpus, and design; architecture rows are comparable only
when that fingerprint matches.
