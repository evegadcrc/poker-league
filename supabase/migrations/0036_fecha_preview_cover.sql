-- ============================================================================
-- Poker Friends — fecha link preview carries the portada (2026-09)
--
-- fecha_preview(uuid) gains cover_url so the WhatsApp / iMessage card for a
-- shared /fechas/:id shows the fecha's own cover photo when the admin set one
-- (api/preview.mjs falls back to the generic branded card otherwise). Return
-- type changes → drop + create; grants unchanged (anon + authenticated).
-- ============================================================================
drop function if exists public.fecha_preview(uuid);
create function public.fecha_preview(p_id uuid)
returns table (
  name         text,
  scheduled_at timestamptz,
  status       public.tournament_status,
  cancelled    boolean,
  confirmed    int,
  guests_open  boolean,
  cover_url    text
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
    ),
    t.guests_open and t.cancelled_at is null and t.status in ('scheduled', 'live'),
    t.cover_url
  from public.tournament t
  where t.id = p_id;
$$;
revoke all on function public.fecha_preview(uuid) from public;
grant execute on function public.fecha_preview(uuid) to anon, authenticated;
