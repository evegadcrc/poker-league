-- ============================================================================
-- Poker Friends — public link-preview data for a fecha (2026-09)
--
-- Chat apps (WhatsApp, iMessage, Telegram…) fetch a shared link WITHOUT a
-- session, so the Vercel function that renders the Open Graph tags for
-- /fechas/:id (api/preview.ts) needs a way to read a fecha anonymously. This
-- SECURITY DEFINER function exposes ONLY what the card shows — name, date,
-- status, cancelled flag and the confirmed count — looked up by the fecha's
-- unguessable uuid. No entries, players, venue or money leave the database,
-- and no service-role key has to live on Vercel.
-- ============================================================================
create or replace function public.fecha_preview(p_id uuid)
returns table (
  name         text,
  scheduled_at timestamptz,
  status       public.tournament_status,
  cancelled    boolean,
  confirmed    int
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    t.name,
    t.scheduled_at,
    t.status,
    t.cancelled_at is not null,
    (
      select count(*)::int
      from public.entry e
      where e.tournament_id = t.id
        and e.status in ('confirmed', 'checked_in', 'playing')
    )
  from public.tournament t
  where t.id = p_id;
$$;

revoke all on function public.fecha_preview(uuid) from public;
grant execute on function public.fecha_preview(uuid) to anon, authenticated;
