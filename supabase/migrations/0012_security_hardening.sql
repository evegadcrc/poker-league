-- ============================================================================
-- Poker Friends — security hardening (review iter 1, backend/security lens)
-- Closes the RLS privilege-escalation / integrity holes on player + entry,
-- restores the admin onboarding path lost by dropping self-insert, locks anon
-- out of the read RPCs, fixes the chop-strand bug in complete_tournament, and
-- pins search_path on the new/replaced SECURITY DEFINER functions.
--
-- Root cause of the Criticals: Supabase default privileges already grant
-- INSERT/UPDATE/DELETE on public tables to `authenticated`, so RLS is the ONLY
-- gate. The self-write policies had no column restriction → a player could set
-- their own player.is_admin=true (full admin escalation) or rewrite any column
-- of their own entry (paid/chips/final_position/points_earned/status), defeating
-- the SECURITY DEFINER RPC layer. Every legitimate player write already goes
-- through a DEFINER RPC (rsvp / cancel_rsvp / check_in / self_bust / — new —
-- update_own_profile), so the direct-table write policies are pure attack
-- surface. Players keep SELECT only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) CRITICAL — drop player self-write policies (is_admin escalation +
--     stranger self-provisions an admin row). Players keep "read player".
-- ---------------------------------------------------------------------------
drop policy if exists "player self insert" on public.player;
drop policy if exists "player self update" on public.player;
drop policy if exists "player self delete" on public.player;

-- ---------------------------------------------------------------------------
-- (2) CRITICAL — drop entry self-write policies (arbitrary entry mutation:
--     paid/chips/points_earned/final_position/status). Players keep "read
--     entry"; every entry write goes through rsvp / cancel_rsvp / check_in /
--     self_bust (all SECURITY DEFINER, bypass RLS).
-- ---------------------------------------------------------------------------
drop policy if exists "entry self insert" on public.entry;
drop policy if exists "entry self update" on public.entry;
drop policy if exists "entry self delete" on public.entry;

-- ---------------------------------------------------------------------------
-- (3) update_own_profile(name, avatar_url) — the ONLY player-facing write on
--     the player row now that self-UPDATE is gone. Updates name + avatar_url on
--     the CALLER's own row only; cannot touch is_admin / email / auth_user_id.
--     coalesce → passing null for a field leaves it unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.update_own_profile(
  p_name       text default null,
  p_avatar_url text default null
)
returns setof public.player
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pid uuid := public.auth_player_id();
begin
  if v_pid is null then
    raise exception 'perfil: no sos miembro de la liga';
  end if;

  update public.player
     set name       = coalesce(p_name, name),
         avatar_url = coalesce(p_avatar_url, avatar_url)
   where id = v_pid;

  return query select * from public.player where id = v_pid;
end;
$$;

-- ---------------------------------------------------------------------------
-- (4) create_player(name, email) — admin-only onboarding path (restores the
--     flow lost by dropping "player self insert"). Always is_admin=false; a
--     new member binds auth_user_id on first magic-link login via claim_player.
--     service_role admitted for the integration suite (matches the other admin
--     RPCs' guard shape).
-- ---------------------------------------------------------------------------
create or replace function public.create_player(p_name text, p_email text)
returns setof public.player
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.player;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'crear jugador: solo un admin puede crear jugadores';
  end if;

  insert into public.player (name, email, is_admin)
  values (p_name, p_email, false)
  returning * into v_row;

  return next v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- (5) REQUIRED — revoke anon/PUBLIC execute on the SECURITY DEFINER read RPCs.
--     They bypass RLS, so a caller holding the shipped anon key could read the
--     full roster / points / pot without a session. Re-assert authenticated +
--     service_role (the only intended callers).
-- ---------------------------------------------------------------------------
revoke all on function public.leaderboard(uuid)            from public, anon;
revoke all on function public.player_profile(uuid, uuid)   from public, anon;
revoke all on function public.fn_pot(uuid)                 from public, anon;
revoke all on function public.fn_final_table_size(int, uuid) from public, anon;

grant execute on function public.leaderboard(uuid)            to authenticated, service_role;
grant execute on function public.player_profile(uuid, uuid)   to authenticated, service_role;
grant execute on function public.fn_pot(uuid)                 to authenticated, service_role;
grant execute on function public.fn_final_table_size(int, uuid) to authenticated, service_role;

-- New RPC grants (admin-gate is internal; authenticated is safe, non-members
-- are rejected inside). No anon/PUBLIC grant.
revoke all on function public.update_own_profile(text, text) from public, anon;
revoke all on function public.create_player(text, text)      from public, anon;
grant execute on function public.update_own_profile(text, text) to authenticated, service_role;
grant execute on function public.create_player(text, text)      to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (6) REQUIRED — complete_tournament: a chop of K must not strand the >K
--     players still in play. REPLACES 0009's definition. New step (0b): after
--     the chopped co-champions take positions 1..K, the remaining in-play (not
--     chopped) players are eliminated into positions K+1.. (chip-leader first),
--     so they finish ranked below the co-champions instead of at
--     final_position NULL → 0 points. Pinned chop rule preserved: choppers are
--     co-champions sharing the top; everyone else ranks below. search_path
--     upgraded to public, pg_temp.
-- ---------------------------------------------------------------------------
create or replace function public.complete_tournament(
  p_tournament_id  uuid,
  p_chop_entry_ids uuid[] default null
)
returns setof public.tournament
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.tournament_status;
  v_k      int;
  v_group  int;
  v_size   int;
begin
  select t.status into v_status from public.tournament t where t.id = p_tournament_id;
  if not found then
    raise exception 'completar: la fecha % no existe', p_tournament_id;
  end if;
  if not public.fn_is_tournament_admin(p_tournament_id) then
    raise exception 'completar: solo un admin puede completar la fecha';
  end if;
  if v_status = 'completed' then
    raise exception 'completar: la fecha ya está completada';
  end if;

  -- (0) CHOP: the final K players split the top positions 1..K as co-champions.
  if p_chop_entry_ids is not null and array_length(p_chop_entry_ids, 1) >= 1 then
    v_k := array_length(p_chop_entry_ids, 1);

    if exists (
      select 1 from unnest(p_chop_entry_ids) cid
      where not exists (
        select 1 from public.entry e
        where e.id = cid
          and e.tournament_id = p_tournament_id
          and e.status in ('playing', 'checked_in', 'winner')
      )
    ) then
      raise exception 'chop: todos los jugadores del chop deben estar en juego en esta fecha';
    end if;

    select coalesce(max(e.chop_group), 0) + 1 into v_group
    from public.entry e where e.tournament_id = p_tournament_id;

    update public.entry e
       set chopped          = true,
           chop_group       = v_group,
           status           = 'winner',
           final_position   = arr.ord::int,
           made_final_table = true,
           eliminated_at    = null
      from (
        select u.cid, u.ord
        from unnest(p_chop_entry_ids) with ordinality as u(cid, ord)
      ) arr
     where e.id = arr.cid and e.tournament_id = p_tournament_id;

    -- (0b) Non-chopped players still in play rank BELOW the co-champions.
    --   Assign positions K+1, K+2, … (chip leader first) and eliminate them so
    --   completion never leaves an in-play entry at final_position NULL → 0 pts.
    with remaining as (
      select e.id,
             v_k + row_number() over (
               order by e.chips desc nulls last, e.created_at asc, e.id asc
             ) as pos
      from public.entry e
      where e.tournament_id = p_tournament_id
        and e.status in ('playing', 'checked_in')
        and e.chop_group is null
    )
    update public.entry e
       set status         = 'eliminated',
           final_position  = r.pos,
           eliminated_at   = now()
      from remaining r
     where e.id = r.id;
  end if;

  -- (1) confirmed-but-never-checked-in → no_show (ghosts; fn → −15).
  update public.entry
     set status = 'no_show'
   where tournament_id = p_tournament_id
     and status = 'confirmed'
     and checked_in_at is null;

  -- (2) refresh mesa-final size from real turnout BEFORE points (slice-7 cadence).
  v_size := public.recompute_final_table_size(p_tournament_id);

  -- (2b) re-derive made_final_table from the FINAL size. At completion every
  --      seated player has a final_position, so "reached the final table" is
  --      exactly final_position ≤ size.
  update public.entry e
     set made_final_table = (e.final_position is not null and e.final_position <= v_size)
   where e.tournament_id = p_tournament_id;

  -- (3) points.
  perform public.fn_tournament_points(p_tournament_id);

  -- (4) completed.
  update public.tournament set status = 'completed' where id = p_tournament_id;

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- complete_tournament grant is preserved by CREATE OR REPLACE; re-assert for clarity.
revoke all on function public.complete_tournament(uuid, uuid[]) from public, anon;
grant execute on function public.complete_tournament(uuid, uuid[]) to authenticated, service_role;
