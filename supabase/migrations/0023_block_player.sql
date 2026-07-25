-- ============================================================================
-- Poker Friends — BLOCK a player (Phase 3, admin moderation)
--
-- A BLOCKED player must not be able to log in / bind. We take the NO-ROWS path
-- (not an exception) inside claim_player so the FE reuses the existing unbound
-- "no-player" state (`bindError='no-player'` → the friendly "pedile al admin"
-- message in Login) instead of surfacing a raw RPC error.
--
-- STEP 1 — player.blocked flag (default false; every existing member stays
--   allowed). set_player_blocked (below) is the ONLY writer.
--
-- STEP 2 — claim_player forward-fixed (create-or-replace of 0002; DO NOT edit
--   0002). Identical to 0002 EXCEPT: a matched row with blocked=true returns 0
--   rows and — critically — does NOT bind auth_user_id, so unblocking later
--   still allows a clean first-login bind.
--
-- STEP 3 — set_player_blocked(player_id, blocked): SECURITY DEFINER, pinned
--   search_path, admin-gated (auth_is_admin() OR the service_role JWT, matching
--   the create_player / add_guest_entry guard shape). Guards: an admin can never
--   target their OWN row (would lock themselves out) and can never BLOCK another
--   admin (admins are peers; demoting an admin is a separate deliberate action).
--   Unblocking is always allowed. Grant execute to authenticated.
--
-- NO list_players() RPC: the 0001 "read player" RLS policy
--   (`for select to authenticated using (true)`) is still in force — 0012 dropped
--   only the self-WRITE player policies, never the read — so an authenticated
--   admin can already SELECT the full roster (id, name, email, is_admin,
--   is_guest, blocked) directly. The Jugadores admin tab reads it that way.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) player.blocked — NOT NULL DEFAULT false backfills every existing row.
-- ---------------------------------------------------------------------------
alter table public.player
  add column if not exists blocked boolean not null default false;

-- ---------------------------------------------------------------------------
-- (2) claim_player — forward-fix (0002 logic verbatim + the blocked gate).
--     Still SETOF player, still SECURITY DEFINER + pinned search_path.
-- ---------------------------------------------------------------------------
create or replace function public.claim_player()
returns setof public.player
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text := auth.email();
  v_player public.player;
begin
  if v_uid is null then
    raise exception 'claim_player: no authenticated user';
  end if;

  -- Match a pre-created player by verified email (case-insensitive).
  select p.* into v_player
  from public.player p
  where lower(p.email) = lower(v_email)
  limit 1;

  -- No pre-created player for this email → return 0 rows (empty array) so the UI
  -- can show the friendly "pedile al admin que te agregue" message.
  if not found then
    return;
  end if;

  -- BLOCKED (0023): a blocked member must NOT bind / log in. Return 0 rows so the
  -- UI reuses the same "no-player" state. We deliberately do NOT set auth_user_id
  -- here, so unblocking later still permits a clean first-login bind.
  if v_player.blocked then
    return;
  end if;

  if v_player.auth_user_id is null then
    -- First login: bind this auth user to the pre-created player row.
    update public.player
       set auth_user_id = v_uid
     where id = v_player.id
     returning * into v_player;
  elsif v_player.auth_user_id <> v_uid then
    -- Email already bound to a different auth account — refuse rather than
    -- silently re-point it (would let a re-registered email hijack a member).
    raise exception 'claim_player: email already bound to another account';
  end if;
  -- else: already bound to this same user → idempotent, return as-is.

  return next v_player;
end;
$$;

-- Callable by any signed-in user; the function itself gates on auth.uid().
revoke all on function public.claim_player() from public, anon;
grant execute on function public.claim_player() to authenticated;

-- ---------------------------------------------------------------------------
-- (3) set_player_blocked(player_id, blocked) — admin-only block/unblock.
-- ---------------------------------------------------------------------------
create or replace function public.set_player_blocked(
  p_player_id uuid,
  p_blocked   boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_pid uuid := public.auth_player_id();
  v_target     public.player;
begin
  -- coalesce guards the NULL-role fail-open (auth.role() is NULL without a role
  -- claim; `x or NULL` would skip the raise), matching add_guest_entry (0021).
  if not (public.auth_is_admin() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'bloquear: solo un admin puede bloquear jugadores';
  end if;

  select * into v_target from public.player where id = p_player_id;
  if not found then
    raise exception 'bloquear: el jugador no existe';
  end if;

  -- An admin can never target their OWN row (would lock themselves out).
  if v_caller_pid is not null and p_player_id = v_caller_pid then
    raise exception 'bloquear: no podés bloquearte a vos mismo';
  end if;

  -- ...and can never BLOCK another admin. Unblocking (p_blocked=false) is allowed.
  if p_blocked and v_target.is_admin then
    raise exception 'bloquear: no podés bloquear a otro admin';
  end if;

  update public.player set blocked = p_blocked where id = p_player_id;
end;
$$;

revoke all on function public.set_player_blocked(uuid, boolean) from public, anon;
grant execute on function public.set_player_blocked(uuid, boolean) to authenticated, service_role;
