-- ============================================================================
-- Poker Friends — guests can join a fecha by themselves (2026-09)
--
-- Until now a guest could only be added by an admin from the Consola
-- (add_guest_entry, 0021: name only, no login). This lets a newcomer who
-- receives the fecha link sign up as a GUEST on their own:
--
--   • tournament.guests_open (default false) — the admin opts a fecha in from
--     the fecha form ("Invitados pueden unirse con el enlace").
--   • guest_join(email, name, tournament_id) — ANON-callable. On an open fecha
--     it creates a guest player (is_guest = true, real email so claim_player
--     binds them after the magic link) and a CONFIRMED entry, then returns
--     'guest'; the client sends the magic link. A KNOWN member email returns
--     'member' (no guest row; the client sends the link and they RSVP as
--     usual). Repeat calls are idempotent. A pending signup_request for the
--     same email is marked approved so a later admin approval can't collide.
--   • promote_guest(player_id) — admin-only. Flips is_guest off: the person
--     becomes a full member (email/login unchanged) and their past nights start
--     counting on the Tabla (points_earned was always computed; only the Tabla
--     projection filtered guests out).
--   • fecha_preview now also returns guests_open so the login screen can offer
--     "Voy como invitado" only when the linked fecha accepts guests.
--
-- Guests never appear on the Tabla (0021 filter unchanged) but play, check in
-- and get notifications like anyone else.
-- ============================================================================

alter table public.tournament
  add column if not exists guests_open boolean not null default false;

-- ---------------------------------------------------------------------------
-- fecha_preview(uuid) — add guests_open (return type changes → drop + create).
-- ---------------------------------------------------------------------------
drop function if exists public.fecha_preview(uuid);
create function public.fecha_preview(p_id uuid)
returns table (
  name         text,
  scheduled_at timestamptz,
  status       public.tournament_status,
  cancelled    boolean,
  confirmed    int,
  guests_open  boolean
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
    t.guests_open and t.cancelled_at is null and t.status in ('scheduled', 'live')
  from public.tournament t
  where t.id = p_id;
$$;
revoke all on function public.fecha_preview(uuid) from public;
grant execute on function public.fecha_preview(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- guest_join(email, name, tournament_id) → 'guest' | 'member'
-- ---------------------------------------------------------------------------
create or replace function public.guest_join(
  p_email         text,
  p_name          text,
  p_tournament_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_name   text := trim(coalesce(p_name, ''));
  v_t      public.tournament;
  v_p      public.player;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invitado: correo inválido';
  end if;
  if v_name = '' or length(v_name) > 40 then
    raise exception 'invitado: el nombre es obligatorio (máx. 40 letras)';
  end if;

  select * into v_t from public.tournament where id = p_tournament_id;
  if not found
     or not v_t.guests_open
     or v_t.cancelled_at is not null
     or v_t.status not in ('scheduled', 'live') then
    raise exception 'invitado: esta fecha no acepta invitados por enlace';
  end if;

  select * into v_p from public.player where lower(email) = v_email;
  if found then
    if v_p.blocked then
      raise exception 'invitado: esta cuenta no puede entrar. Hablar con el admin';
    end if;
    -- A real member: nothing to create — they log in and RSVP as usual.
    if not v_p.is_guest then
      return 'member';
    end if;
  else
    insert into public.player (name, email, is_guest)
    values (v_name, v_email, true)
    returning * into v_p;
    -- If they had asked for access before, that request is now moot.
    update public.signup_request
       set status = 'approved', decided_at = now()
     where lower(email) = v_email and status = 'pending';
  end if;

  -- Confirmed for this fecha. A repeat call keeps an existing checked-in /
  -- playing row untouched and only re-confirms an invited / declined one.
  insert into public.entry (tournament_id, player_id, status, rsvp_at)
  values (v_t.id, v_p.id, 'confirmed', now())
  on conflict (tournament_id, player_id) do update
    set status = case
                   when public.entry.status in ('invited', 'declined') then 'confirmed'::public.entry_status
                   else public.entry.status
                 end,
        rsvp_at = case
                    when public.entry.status in ('invited', 'declined') then now()
                    else public.entry.rsvp_at
                  end,
        cancelled_at = null;

  return 'guest';
end;
$$;
revoke all on function public.guest_join(text, text, uuid) from public;
grant execute on function public.guest_join(text, text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- promote_guest(player_id) — admin-only: guest → full member.
-- ---------------------------------------------------------------------------
create or replace function public.promote_guest(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.auth_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'invitado: solo un admin puede hacer miembro a un invitado';
  end if;
  update public.player set is_guest = false where id = p_player_id and is_guest;
  if not found then
    raise exception 'invitado: el jugador % no es un invitado', p_player_id;
  end if;
end;
$$;
revoke all on function public.promote_guest(uuid) from public, anon;
grant execute on function public.promote_guest(uuid) to authenticated, service_role;
