-- ============================================================================
-- Poker Friends — access requests + admin approval (Phase 3)
--
-- Before this migration a first-time UNKNOWN email hit a dead end: claim_player
-- (0002) only binds an auth user to a PRE-EXISTING player row, so an email the
-- admin never added could authenticate yet never become a member ("pedile al
-- admin"). This adds a self-service request queue:
--
--   • request_access(email)  — ANON-callable. A KNOWN email returns 'member' (the
--       client then sends the magic link as today). An UNKNOWN email is recorded
--       as a PENDING signup_request and returns 'pending' (NO magic link is sent).
--       A previously REJECTED email stays rejected (returns 'rejected') — it does
--       NOT silently re-open (anti-spam); the admin re-adds them via Agregar
--       jugador if they reconsider.
--   • approve_request(id)    — admin-only. Creates the player (reusing
--       create_player) and marks the request approved; RETURNS the email so the
--       client can send the magic link (email is NEVER sent from SQL).
--   • reject_request(id)     — admin-only. Marks the request rejected.
--
-- Security idiom mirrors 0012 / 0021: SECURITY DEFINER + pinned search_path,
-- admin guard via auth_is_admin() (service_role admitted for the integration
-- suite), and all table WRITES go through these DEFINER RPCs — the table itself
-- exposes only admin SELECT/UPDATE under RLS, never anon/public direct access.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) signup_request — the pending-access queue. email is stored NORMALISED
--     (lower/trim by request_access) so the UNIQUE constraint dedupes case /
--     whitespace variants. No citext extension is used anywhere in this schema.
-- ---------------------------------------------------------------------------
create table if not exists public.signup_request (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  name        text,
  status      text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references public.player(id)
);

alter table public.signup_request enable row level security;

-- ---------------------------------------------------------------------------
-- (2) RLS + grants. Admins may SELECT + UPDATE requests (approve/reject flip
--     status via the RPCs, but a direct admin UPDATE is also allowed). No
--     INSERT/DELETE policy → default-deny for direct writes; the anon INSERT
--     path is request_access (DEFINER, bypasses RLS). Anon table grants are
--     revoked outright so the queue is never directly readable/writable by the
--     shipped anon key (matches the 0012 posture on the read RPCs).
-- ---------------------------------------------------------------------------
revoke all on table public.signup_request from anon;

create policy "admin read signup_request" on public.signup_request
  for select to authenticated
  using (public.auth_is_admin());

create policy "admin update signup_request" on public.signup_request
  for update to authenticated
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

-- ---------------------------------------------------------------------------
-- (3) request_access(email) → 'member' | 'pending' | 'rejected'. ANON-callable.
--     KNOWN email → 'member' (caller sends the link). Unknown → upsert a pending
--     request. Never leaks membership beyond the return code (acceptable here).
-- ---------------------------------------------------------------------------
create or replace function public.request_access(p_email text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(trim(p_email));
  v_status text;
begin
  if v_email is null or v_email = '' then
    raise exception 'solicitud: el correo es obligatorio';
  end if;

  -- KNOWN member → the client proceeds to signInWithOtp exactly as before.
  if exists (select 1 from public.player where lower(email) = v_email) then
    return 'member';
  end if;

  -- Existing request? Branch on its current status.
  select status into v_status
  from public.signup_request
  where email = v_email;

  if not found then
    insert into public.signup_request (email, status) values (v_email, 'pending');
    return 'pending';
  end if;

  if v_status = 'approved' then
    -- Approved earlier (a player normally exists → handled by the check above);
    -- treat as a member so a re-login still gets a link.
    return 'member';
  elsif v_status = 'rejected' then
    -- Stays rejected — does NOT re-open on retry.
    return 'rejected';
  else
    -- already pending
    return 'pending';
  end if;
end;
$$;

revoke all on function public.request_access(text) from public;
grant execute on function public.request_access(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (4) approve_request(id) → the approved email. Admin-only. Creates the league
--     member via create_player (name from the request if present, else derived
--     from the email local-part) unless the admin already added that email, then
--     marks the request approved. Returns the email so the CLIENT sends the
--     magic link (signInWithOtp) — SQL never sends email.
-- ---------------------------------------------------------------------------
create or replace function public.approve_request(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_name  text;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'solicitud: solo un admin puede aprobar solicitudes';
  end if;

  select email, name into v_email, v_name
  from public.signup_request
  where id = p_id;
  if not found then
    raise exception 'solicitud: la solicitud % no existe', p_id;
  end if;

  -- Name from the request if present, else the email local-part.
  v_name := coalesce(nullif(trim(v_name), ''), split_part(v_email, '@', 1));

  -- Create the member unless the admin already whitelisted this email (idempotent).
  if not exists (select 1 from public.player where lower(email) = lower(v_email)) then
    perform public.create_player(v_name, v_email);
  end if;

  update public.signup_request
     set status     = 'approved',
         decided_at = now(),
         decided_by = public.auth_player_id()
   where id = p_id;

  return v_email;
end;
$$;

revoke all on function public.approve_request(uuid) from public, anon;
grant execute on function public.approve_request(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (5) reject_request(id). Admin-only. Marks the request rejected (no player is
--     created; the email will keep getting 'rejected' from request_access).
-- ---------------------------------------------------------------------------
create or replace function public.reject_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'solicitud: solo un admin puede rechazar solicitudes';
  end if;

  update public.signup_request
     set status     = 'rejected',
         decided_at = now(),
         decided_by = public.auth_player_id()
   where id = p_id;

  if not found then
    raise exception 'solicitud: la solicitud % no existe', p_id;
  end if;
end;
$$;

revoke all on function public.reject_request(uuid) from public, anon;
grant execute on function public.reject_request(uuid) to authenticated, service_role;
