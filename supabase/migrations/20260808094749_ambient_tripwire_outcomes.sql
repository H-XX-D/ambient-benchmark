-- Per-ability tripwire outcomes for a completed hosted AMBIENT run.
--
-- Six of the thirteen hard abilities plant a decoy in the memory store that a
-- retrieval-only system will happily surface. The mechanical oracle records
-- which decoy an answer emitted (oracle.protectedHits) and grades that answer
-- "gullible", which is kept separate from "wrong": wrong means the system
-- missed, gullible means it was led. This table publishes that breakdown so the
-- board can report a decoy-hit rate independently of the lift score, because
-- the two can move in opposite directions.
--
-- One row per (hosted run, ability). Counts are stored raw so the reader
-- recomputes the rate; a stored rate could be written independently of the
-- counts the certifier actually derived.

create table if not exists public.ambient_tripwire_outcomes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ambient_hosted_runs (id) on delete cascade,

  -- Denormalised from the parent run so the public board can group and label
  -- rows in one request without a join. Kept in step with the parent by
  -- ambient_tripwire_outcomes_sync_parent below.
  memory_name text not null check (char_length(memory_name) between 1 and 100),
  control_key text not null check (control_key ~ '^[0-9a-f]{12}$'),

  -- Must stay identical to the generator names in corpora/hard-behavior-core.mjs
  -- and to tripwireAbilities in site/data/leaderboard.json. check-site.mjs
  -- fails the build if these three drift apart.
  ability text not null check (ability in (
    'abstention',
    'contradiction-resolution',
    'knowledge-update',
    'belief-revision-audit',
    'trust-discrimination',
    'poisoned-memory-quarantine'
  )),

  -- "rows" is the number of scored tier rows for this ability in this run.
  -- ROWS is a non-reserved keyword in PostgreSQL, so it is legal unquoted, and
  -- the public board selects it under this exact name.
  rows integer not null check (rows > 0),
  gullible integer not null check (gullible >= 0),

  -- Emitting a decoy is proof the store fed the answer, so the hit count can
  -- never exceed the rows that were scored.
  constraint ambient_tripwire_hits_within_rows check (gullible <= rows),

  publication_status text not null default 'hosted' check (publication_status in ('hosted', 'withdrawn')),
  completed_at timestamptz not null,
  published_at timestamptz not null default now(),

  -- A run reports each ability at most once; a second row would silently
  -- double the denominator of the published rate.
  constraint ambient_tripwire_one_row_per_ability unique (run_id, ability)
);

comment on table public.ambient_tripwire_outcomes is
  'Per-ability decoy-hit counts for completed hosted AMBIENT runs. A gullible answer emitted a planted decoy, which is distinct from a merely wrong answer. Unreviewed, like the hosted runs they belong to.';
comment on column public.ambient_tripwire_outcomes.rows is
  'Scored tier rows for this ability in this run; the denominator of the published rate.';
comment on column public.ambient_tripwire_outcomes.gullible is
  'Rows whose answer contained a planted decoy token.';

alter table public.ambient_tripwire_outcomes enable row level security;

revoke all on table public.ambient_tripwire_outcomes from anon, authenticated;
grant select on table public.ambient_tripwire_outcomes to anon, authenticated;
grant select, insert, update, delete on table public.ambient_tripwire_outcomes to service_role;

-- Readable only while BOTH this row and its parent run are published. Checking
-- the parent as well means withdrawing a run hides its tripwire breakdown in
-- the same action, even if the denormalised status on the child is stale.
drop policy if exists "Public can read published AMBIENT tripwire outcomes" on public.ambient_tripwire_outcomes;
create policy "Public can read published AMBIENT tripwire outcomes"
  on public.ambient_tripwire_outcomes
  for select
  to anon, authenticated
  using (
    publication_status = 'hosted'
    and exists (
      select 1
      from public.ambient_hosted_runs as run
      where run.id = ambient_tripwire_outcomes.run_id
        and run.publication_status = 'hosted'
    )
  );

-- The denormalised columns are a read convenience, not a second source of
-- truth: they are always taken from the parent run rather than from the
-- caller, so a writer cannot attribute a run to a different system or control.
create or replace function public.ambient_tripwire_outcomes_sync_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.ambient_hosted_runs%rowtype;
begin
  select * into parent from public.ambient_hosted_runs where id = new.run_id;
  if not found then
    raise exception 'tripwire outcome references an unknown hosted run: %', new.run_id;
  end if;
  new.memory_name := parent.memory_name;
  new.control_key := parent.control_key;
  new.completed_at := parent.completed_at;
  new.publication_status := parent.publication_status;
  return new;
end;
$$;

drop trigger if exists ambient_tripwire_outcomes_sync_parent on public.ambient_tripwire_outcomes;
create trigger ambient_tripwire_outcomes_sync_parent
  before insert or update on public.ambient_tripwire_outcomes
  for each row execute function public.ambient_tripwire_outcomes_sync_parent();

-- Withdrawing a run must withdraw its breakdown too, otherwise the child rows
-- keep their stale 'hosted' status and only the RLS parent check hides them.
create or replace function public.ambient_hosted_runs_propagate_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.publication_status is distinct from old.publication_status then
    update public.ambient_tripwire_outcomes
      set publication_status = new.publication_status
      where run_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists ambient_hosted_runs_propagate_status on public.ambient_hosted_runs;
create trigger ambient_hosted_runs_propagate_status
  after update of publication_status on public.ambient_hosted_runs
  for each row execute function public.ambient_hosted_runs_propagate_status();

-- Serves the board's read: filter by status, group by system and control.
create index if not exists ambient_tripwire_outcomes_public_idx
  on public.ambient_tripwire_outcomes (memory_name, control_key, ability)
  where publication_status = 'hosted';

create index if not exists ambient_tripwire_outcomes_run_idx
  on public.ambient_tripwire_outcomes (run_id);
