-- ============================================================================
-- Poker Friends — auto-approve access requests (Phase 3, forward-fixes 0022)
--
-- Adds an OPT-IN "approve everything" switch to the signup gate. When the ACTIVE
-- season has auto_approve_signups = true, a first-time UNKNOWN email is onboarded
-- silently: request_access creates the (non-admin) player right then and returns
-- 'member', so the Login client sends the magic link immediately — no pending
-- queue, no admin tap. When the flag is false the behaviour is unchanged (the
-- 0022 pending-request queue).
--
--   • season.auto_approve_signups — boolean flag, per active season, default off.
--   • request_access(email)        — REPLACES 0022. Adds the auto-approve branch
--       between the member check and the pending-queue path. Still ANON-callable,
--       DEFINER + pinned search_path. create_player is admin-gated, so the auto
--       branch inlines its logic (is_admin=false, name = email local-part) via a
--       direct DEFINER insert that bypasses RLS. NEVER creates an admin.
--   • set_auto_approve(on)         — admin-only DEFINER RPC that flips the flag on
--       the active season (drives the admin Solicitudes switch).
--
-- Security idiom mirrors 0022 / 0012: SECURITY DEFINER + pinned search_path,
-- admin guard via auth_is_admin() (service_role admitted for the integration
-- suite), typed param + no dynamic SQL (injection-safe).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) season.auto_approve_signups — off by default; each season carries its own.
-- ---------------------------------------------------------------------------
alter table public.season
  add column if not exists auto_approve_signups boolean not null default false;

-- ---------------------------------------------------------------------------
-- (2) request_access(email) → 'member' | 'pending' | 'rejected'. ANON-callable.
--     REPLACES the 0022 definition, adding the auto-approve branch. Order:
--       (a) KNOWN member                       → 'member'   (client sends link)
--       (b) active season auto_approve = true  → onboard now, return 'member'
--       (c) otherwise                          → 0022 pending-queue behaviour
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
  v_auto   boolean;
  v_name   text;
begin
  if v_email is null or v_email = '' then
    raise exception 'solicitud: el correo es obligatorio';
  end if;

  -- (a) KNOWN member → the client proceeds to signInWithOtp exactly as before.
  if exists (select 1 from public.player where lower(email) = v_email) then
    return 'member';
  end if;

  -- (b) AUTO-APPROVE. Read the flag off the single active season. When on, the
  --     unknown email is onboarded immediately: create the NON-admin player here
  --     (DEFINER bypasses RLS; create_player itself is admin-gated so we inline
  --     its logic — is_admin=false, name from the email local-part). on conflict
  --     guards a concurrent insert. Any lingering queue row for this email is
  --     retired so it stops showing in the admin Solicitudes list.
  select s.auto_approve_signups into v_auto
  from public.season s
  where s.status = 'active'
  order by s.year desc
  limit 1;

  if coalesce(v_auto, false) then
    v_name := split_part(v_email, '@', 1);

    insert into public.player (name, email, is_admin)
    values (v_name, v_email, false)
    on conflict (email) do nothing;

    update public.signup_request
       set status     = 'approved',
           decided_at = now()
     where email = v_email
       and status <> 'approved';

    return 'member';
  end if;

  -- (c) AUTO-APPROVE OFF — the unchanged 0022 pending-queue behaviour.
  select status into v_status
  from public.signup_request
  where email = v_email;

  if not found then
    insert into public.signup_request (email, status) values (v_email, 'pending');
    return 'pending';
  end if;

  if v_status = 'approved' then
    return 'member';
  elsif v_status = 'rejected' then
    return 'rejected';
  else
    return 'pending';
  end if;
end;
$$;

-- CREATE OR REPLACE preserves grants; re-assert the 0022 posture for clarity.
revoke all on function public.request_access(text) from public;
grant execute on function public.request_access(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (3) set_auto_approve(on) → void. Admin-only. Flips auto_approve_signups on the
--     active season. Guard mirrors approve_request: auth_is_admin() OR (coalesce
--     against the NULL-role fail-open) service_role. authenticated may execute
--     (non-admins are rejected inside); no anon/PUBLIC grant.
-- ---------------------------------------------------------------------------
create or replace function public.set_auto_approve(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not (public.auth_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'solicitud: solo un admin puede cambiar la aprobación automática';
  end if;

  select s.id into v_id
  from public.season s
  where s.status = 'active'
  order by s.year desc
  limit 1;

  if v_id is null then
    raise exception 'solicitud: no hay temporada activa';
  end if;

  update public.season
     set auto_approve_signups = coalesce(p_on, false)
   where id = v_id;
end;
$$;

revoke all on function public.set_auto_approve(boolean) from public, anon;
grant execute on function public.set_auto_approve(boolean) to authenticated, service_role;
