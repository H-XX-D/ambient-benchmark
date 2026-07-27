create table if not exists public.ambient_leaderboard_entries (
  id text primary key,
  track text not null check (track in ('architecture', 'native-system')),
  system_name text not null check (char_length(system_name) between 1 and 100),
  system_version text not null check (char_length(system_version) between 1 and 100),
  corpus text not null check (char_length(corpus) between 1 and 100),
  item_count integer not null check (item_count > 0),
  score double precision not null check (score between -1 and 1),
  lower95 double precision not null check (lower95 between -1 and 1),
  upper95 double precision not null check (upper95 between -1 and 1),
  baseline double precision check (baseline between 0 and 1),
  treatment double precision check (treatment between 0 and 1),
  control_key text,
  submitted_at timestamptz not null,
  submitted_by text not null check (char_length(submitted_by) between 1 and 100),
  source_commit text not null check (source_commit ~ '^[0-9a-f]{40}$'),
  evidence_url text not null check (evidence_url ~ '^https://'),
  artifact_sha256 jsonb not null default '{}'::jsonb check (jsonb_typeof(artifact_sha256) = 'object'),
  publication_status text not null default 'verified' check (publication_status in ('verified', 'revoked')),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ambient_leaderboard_interval_order check (lower95 <= score and score <= upper95),
  constraint ambient_leaderboard_track_fields check (
    (
      track = 'architecture'
      and baseline is not null
      and treatment is not null
      and control_key ~ '^[0-9a-f]{12}$'
      and abs(score - (treatment - baseline)) < 0.000000001
    )
    or
    (
      track = 'native-system'
      and score between 0 and 1
      and lower95 between 0 and 1
      and upper95 between 0 and 1
    )
  )
);

comment on table public.ambient_leaderboard_entries is
  'Public, evidence-gated AMBIENT leaderboard rows. Benchmark runs occur outside Supabase.';

alter table public.ambient_leaderboard_entries enable row level security;

revoke all on table public.ambient_leaderboard_entries from anon, authenticated;
grant select on table public.ambient_leaderboard_entries to anon, authenticated;
grant select, insert, update, delete on table public.ambient_leaderboard_entries to service_role;

drop policy if exists "Public can read verified AMBIENT results" on public.ambient_leaderboard_entries;
create policy "Public can read verified AMBIENT results"
  on public.ambient_leaderboard_entries
  for select
  to anon, authenticated
  using (publication_status = 'verified');

create index if not exists ambient_leaderboard_public_ranking_idx
  on public.ambient_leaderboard_entries (track, control_key, score desc, submitted_at asc)
  where publication_status = 'verified';
