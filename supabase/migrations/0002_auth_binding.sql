-- ============================================================================
-- Poker Friends — first-login player binding (slice 4)
--
-- Auth ↔ player mapping (be-contract §"Resolved" 9): an admin pre-creates
-- `player` rows (name/email); the FIRST magic-link login binds
-- `player.auth_user_id = auth.uid()` by matching the caller's verified email.
--
-- WHY A SECURITY DEFINER RPC: slice-2 RLS only lets a player UPDATE their own
-- row *once* `auth_user_id` is already set (`auth_user_id = auth.uid()`), so a
-- freshly-authenticated user whose row is still unbound cannot write it under
-- RLS — a chicken-and-egg. `claim_player()` runs as the definer (bypassing RLS)
-- to perform exactly that one privileged bind, then returns the bound row.
-- ============================================================================

-- Returns SETOF (not a scalar composite) on purpose: a scalar `public.player`
-- would surface a no-match as an all-null object over PostgREST, not JSON null.
-- SETOF yields an empty array for "no pre-created player", one row when bound.
create or replace function public.claim_player()
returns setof public.player
language plpgsql
security definer
set search_path = public
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
grant execute on function public.claim_player() to authenticated;
