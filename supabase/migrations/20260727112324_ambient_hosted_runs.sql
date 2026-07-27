create table if not exists public.ambient_hosted_runs (
  id uuid primary key,
  memory_id text not null check (memory_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  memory_name text not null check (char_length(memory_name) between 1 and 100),
  corpus_source text not null check (corpus_source = 'beam'),
  corpus_size text not null check (corpus_size = 'small'),
  item_count integer not null check (item_count = 400),
  score double precision not null check (score between -100 and 100),
  lower95 double precision not null check (lower95 between -100 and 100),
  upper95 double precision not null check (upper95 between -100 and 100),
  baseline double precision not null check (baseline between 0 and 100),
  treatment double precision not null check (treatment between 0 and 100),
  control_key text not null check (control_key ~ '^[0-9a-f]{12}$'),
  reader_provider text not null check (char_length(reader_provider) between 1 and 40),
  reader_model text not null check (char_length(reader_model) between 1 and 160),
  judge_provider text not null check (char_length(judge_provider) between 1 and 40),
  judge_model text not null check (char_length(judge_model) between 1 and 160),
  protocol_fingerprint text not null check (protocol_fingerprint ~ '^[0-9a-f]{64}$'),
  sampling_sha256 text not null check (sampling_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null unique check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  judge_errors integer not null check (judge_errors = 0),
  gullible_count integer not null check (gullible_count >= 0),
  untraced_count integer not null check (untraced_count >= 0),
  not_served_count integer not null check (not_served_count >= 0),
  publication_status text not null default 'hosted' check (publication_status in ('hosted', 'withdrawn')),
  completed_at timestamptz not null,
  published_at timestamptz not null default now(),
  constraint ambient_hosted_interval_order check (lower95 <= score and score <= upper95),
  constraint ambient_hosted_score_identity check (abs(score - (treatment - baseline)) < 0.000000001)
);

comment on table public.ambient_hosted_runs is
  'Automatically recorded complete hosted AMBIENT runs. These rows are unreviewed and separate from evidence-verified submissions.';

alter table public.ambient_hosted_runs enable row level security;

revoke all on table public.ambient_hosted_runs from anon, authenticated;
grant select on table public.ambient_hosted_runs to anon, authenticated;
grant select, insert, update, delete on table public.ambient_hosted_runs to service_role;

drop policy if exists "Public can read completed hosted AMBIENT runs" on public.ambient_hosted_runs;
create policy "Public can read completed hosted AMBIENT runs"
  on public.ambient_hosted_runs
  for select
  to anon, authenticated
  using (publication_status = 'hosted');

create index if not exists ambient_hosted_runs_ranking_idx
  on public.ambient_hosted_runs (control_key, score desc, completed_at asc)
  where publication_status = 'hosted';
