-- 0008_realtime.sql — enable Supabase Realtime for the En Vivo view (slice 11)
--
-- The live view subscribes (postgres_changes) to the live tournament row
-- (clock / status / prizes) and its entries (standings). postgres_changes only
-- fans out rows for tables in the `supabase_realtime` publication, and the
-- client filters on non-PK columns (`entry.tournament_id`), so we also set
-- REPLICA IDENTITY FULL — that surfaces every column (and makes the filter work
-- on DELETE, not just INSERT/UPDATE). The timer is STATE-based: only state
-- changes are written, never per-tick updates, so this stays low-traffic.

alter table public.tournament replica identity full;
alter table public.entry replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tournament'
    ) then
      alter publication supabase_realtime add table public.tournament;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'entry'
    ) then
      alter publication supabase_realtime add table public.entry;
    end if;
  end if;
end $$;
