-- The Hugging Face Space is being retired and the submission pipeline moves to
-- the website: upload, automated certification, and placement all happen on
-- ambientbench.org. Certified submissions land in ambient_leaderboard_entries,
-- so tripwire outcomes must be able to attach to an entry as well as to a
-- legacy hosted run. The table is empty at migration time (verified before
-- applying), so the reshape carries no data risk.

alter table public.ambient_tripwire_outcomes
  alter column run_id drop not null;

alter table public.ambient_tripwire_outcomes
  add column if not exists entry_id text references public.ambient_leaderboard_entries (id) on delete cascade;

-- Exactly one parent. A row with both or neither has no single source of
-- truth for its denormalised fields.
alter table public.ambient_tripwire_outcomes
  drop constraint if exists ambient_tripwire_one_parent;
alter table public.ambient_tripwire_outcomes
  add constraint ambient_tripwire_one_parent
  check ((run_id is null) <> (entry_id is null));

-- One row per ability under either parent kind.
create unique index if not exists ambient_tripwire_one_row_per_entry_ability
  on public.ambient_tripwire_outcomes (entry_id, ability)
  where entry_id is not null;

-- The sync trigger now reads whichever parent the row names. Entry statuses
-- (verified/revoked) map onto the child vocabulary (hosted/withdrawn) so the
-- public read filter stays one value.
create or replace function public.ambient_tripwire_outcomes_sync_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.ambient_hosted_runs%rowtype;
  entry public.ambient_leaderboard_entries%rowtype;
begin
  if new.run_id is not null then
    select * into run from public.ambient_hosted_runs where id = new.run_id;
    if not found then
      raise exception 'tripwire outcome references an unknown hosted run: %', new.run_id;
    end if;
    new.memory_name := run.memory_name;
    new.control_key := run.control_key;
    new.completed_at := run.completed_at;
    new.publication_status := run.publication_status;
  else
    select * into entry from public.ambient_leaderboard_entries where id = new.entry_id;
    if not found then
      raise exception 'tripwire outcome references an unknown leaderboard entry: %', new.entry_id;
    end if;
    new.memory_name := entry.system_name;
    new.control_key := entry.control_key;
    new.completed_at := entry.submitted_at;
    new.publication_status := case entry.publication_status when 'verified' then 'hosted' else 'withdrawn' end;
  end if;
  return new;
end;
$$;

-- Revoking an entry hides its tripwire breakdown in the same action.
create or replace function public.ambient_leaderboard_entries_propagate_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.publication_status is distinct from old.publication_status then
    update public.ambient_tripwire_outcomes
      set publication_status = case new.publication_status when 'verified' then 'hosted' else 'withdrawn' end
      where entry_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists ambient_leaderboard_entries_propagate_status on public.ambient_leaderboard_entries;
create trigger ambient_leaderboard_entries_propagate_status
  after update of publication_status on public.ambient_leaderboard_entries
  for each row execute function public.ambient_leaderboard_entries_propagate_status();

-- RLS: readable only while the child is published AND its actual parent is.
drop policy if exists "Public can read published AMBIENT tripwire outcomes" on public.ambient_tripwire_outcomes;
create policy "Public can read published AMBIENT tripwire outcomes"
  on public.ambient_tripwire_outcomes
  for select
  to anon, authenticated
  using (
    publication_status = 'hosted'
    and (
      (
        run_id is not null
        and exists (
          select 1 from public.ambient_hosted_runs as run
          where run.id = ambient_tripwire_outcomes.run_id
            and run.publication_status = 'hosted'
        )
      )
      or (
        entry_id is not null
        and exists (
          select 1 from public.ambient_leaderboard_entries as entry
          where entry.id = ambient_tripwire_outcomes.entry_id
            and entry.publication_status = 'verified'
        )
      )
    )
  );
