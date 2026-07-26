-- ============================================================================
-- Poker Friends — rebuy: drop the blind-level cutoff, block only once a winner
-- exists (forward-fix of 0013's add_rebuy)
--
-- Two rule changes to the re-entry gate. This `create or replace`s add_rebuy
-- from 0013 (do NOT edit 0013 or 0009), changing ONLY the timing guards:
--
--   1. REMOVE the blind-level cutoff. The old rule closed rebuys once the clock
--      passed rebuy_until_level (`current_level > rebuy_until_level`, or the
--      level being 0/null). A player who busts near the window edge could not
--      re-enter after the blind advanced. That guard is now gone entirely — a
--      rebuy is allowed regardless of the current blind level.
--
--   2. ADD a winner guard. Once any entry in the fecha reaches status 'winner'
--      (heads-up is over, the night is decided) a rebuy would resurrect a
--      knocked-out player after someone was crowned. That is now rejected.
--
-- EVERYTHING else is copied verbatim from 0013: the admin gate, the
-- status = 'eliminated' requirement (still rejects playing / checked_in and any
-- non-eliminated status), the update (status→playing, clear final_position /
-- eliminated_at, +1 rebuys_count, fresh starting_stack of chips), and the
-- trailing set_prizes(tid) that refreshes the pot. Signature is unchanged so
-- `create or replace` binds cleanly. SECURITY DEFINER + pinned search_path;
-- grants re-asserted (revoke from public, grant authenticated + service_role).
-- ============================================================================
create or replace function public.add_rebuy(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid    uuid;
  v_status public.entry_status;
  v_stack  int;
begin
  select e.tournament_id, e.status, coalesce(t.starting_stack, 0)
    into v_tid, v_status, v_stack
  from public.entry e
  join public.tournament t on t.id = e.tournament_id
  where e.id = p_entry_id;

  if not found then
    raise exception 'recompra: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'recompra: solo un admin puede registrar recompras';
  end if;

  -- Rebuy = re-entry: never while the player is still playing.
  if v_status in ('playing', 'checked_in') then
    raise exception 'recompra: no se permite recompra mientras juega';
  end if;
  if v_status <> 'eliminated' then
    raise exception 'recompra: solo se puede recomprar tras una eliminación';
  end if;

  -- Winner guard (mig 0029): once the fecha is decided (someone crowned), a
  -- rebuy would resurrect a busted player after the night is over → reject.
  -- The blind-level cutoff that used to live here is intentionally removed:
  -- a rebuy is now allowed regardless of the current blind level.
  if exists (
    select 1 from public.entry e
    where e.tournament_id = v_tid and e.status = 'winner'
  ) then
    raise exception 'recompra: la fecha ya terminó (hay ganador), no se permite recompra';
  end if;

  update public.entry
     set status         = 'playing',
         final_position = null,
         eliminated_at  = null,
         rebuys_count   = rebuys_count + 1,
         chips          = v_stack
   where id = p_entry_id;

  -- The pot just grew by this re-entry → refresh prizes (preserves overrides;
  -- no-ops to '[]' if the season template is empty). verify-ui Tier 4.
  perform public.set_prizes(v_tid);

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves existing privileges; re-asserted here for
-- clarity (mirrors 0009 / 0013). add_rebuy is SECURITY DEFINER with an internal
-- admin guard, so granting execute to authenticated is safe (non-admins are
-- rejected inside); service_role is admitted for the integration suite.
-- ---------------------------------------------------------------------------
revoke all on function public.add_rebuy(uuid) from public;
grant execute on function public.add_rebuy(uuid) to authenticated, service_role;
