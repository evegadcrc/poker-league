-- ============================================================================
-- Poker Friends — auto-materialize prizes from the season payout_template
-- (verify-ui Tier 4 fix; decisions.md 2026-07-24)
--
-- DECISION: prizes must materialize AUTOMATICALLY from the season
-- `payout_template` (prizes = template × pot, rounded to ₡5.000, summing exactly
-- to the pot — the canonical rule already implemented in `set_prizes`, 0004) so
-- the live-view **Premios** block and the **chop money split** show real amounts
-- instead of ₡0. No admin "Editar premios" tap is required. An admin override
-- (`set_prizes_manual`, 0004) MUST still survive these auto-refreshes.
--
-- HOW: `set_prizes(tournament_id)` (0004) is the single source of truth for the
-- computation — it already (a) computes template × pot with ₡5.000 rounding +
-- 1st-absorbs-remainder, (b) preserves `overridden` slices untouched and
-- rebalances the absorber around them, and (c) no-ops gracefully to '[]' when the
-- season template is null/empty. This migration only wires a `set_prizes` call
-- into the three RPCs that change the pot, so `tournament.prizes` tracks it:
--   • open_tournament  — prizes materialize when the fecha goes live.
--   • confirm_payment  — a newly-paid entry grows the pot → prizes refresh.
--   • add_rebuy        — a re-entry grows the pot → prizes refresh.
-- `set_prizes` is left UNCHANGED (its override-preservation is what makes the
-- refresh safe); the three functions below are byte-for-byte their prior bodies
-- (0005 / 0009) with a single trailing `perform public.set_prizes(...)` added.
--
-- GUARD SAFETY: `set_prizes` gates on `auth_is_admin() OR service_role`. Every
-- caller that reaches these RPCs is already an admin, and since `create_tournament`
-- (0010) is itself gated to `auth_is_admin() OR service_role`, a tournament's
-- `created_by` is always a global admin — so the nested `set_prizes` guard always
-- passes for the same principal (global admin, or service_role in tests). No
-- owner-but-not-global-admin principal can reach these RPCs in Phase 1, so the
-- inner guard introduces no regression.
--
-- FE: none. `src/lib/live.ts` / `Live.tsx` (Premios) and `src/lib/admin.ts`
-- (chopPreview) already read `tournament.prizes[].amount`; materializing the
-- column fixes both automatically.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- open_tournament(tournament_id) — unchanged body (0005) + trailing set_prizes.
--   After the scheduled→live flip, clock init and provisional final_table_size,
--   materialize prizes from the current pot (paid entries so far).
-- ---------------------------------------------------------------------------
create or replace function public.open_tournament(p_tournament_id uuid)
returns setof public.tournament
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_by  uuid;
  v_status      public.tournament_status;
  v_level1_secs int;
begin
  select t.created_by, t.status,
         (select bl.duration_seconds
            from public.blind_level bl
           where bl.structure_id = t.blind_structure_id
             and bl.level_number = 1
           limit 1)
    into v_created_by, v_status, v_level1_secs
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'open_tournament: tournament % not found', p_tournament_id;
  end if;

  -- Admin-only. The created_by clause is null-guarded so an unauthenticated /
  -- non-admin caller can never slip through on NULL = NULL logic.
  if not (
       public.auth_is_admin()
    or (v_created_by is not null and v_created_by = public.auth_player_id())
    or auth.role() = 'service_role'
  ) then
    raise exception 'open_tournament: admin only';
  end if;

  -- Only a scheduled tournament may be opened (reject live / completed clearly).
  if v_status <> 'scheduled' then
    raise exception
      'open_tournament: tournament % is %, only a scheduled tournament can be opened',
      p_tournament_id, v_status;
  end if;

  -- Flip to live + initialize the clock PAUSED at level 1 (see 0005 header).
  update public.tournament
     set status                   = 'live',
         current_level            = 1,
         level_started_at         = now(),
         is_paused                = true,
         paused_remaining_seconds = v_level1_secs
   where id = p_tournament_id;

  -- Store the provisional final-table size from current turnout (kept fresh by
  -- slices 10/12 — see the CADENCE note in the 0005 header).
  perform public.recompute_final_table_size(p_tournament_id);

  -- Auto-materialize prizes from the season template × current pot (verify-ui
  -- Tier 4). Preserves any admin override; no-ops to '[]' if the template is empty.
  perform public.set_prizes(p_tournament_id);

  return query select * from public.tournament where id = p_tournament_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_payment(entry_id) — unchanged body (0009) + trailing set_prizes.
--   Marking an entry paid grows the pot → refresh prizes so they track it.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_payment(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid uuid;
begin
  select e.tournament_id into v_tid from public.entry e where e.id = p_entry_id;
  if not found then
    raise exception 'pago: la inscripción % no existe', p_entry_id;
  end if;
  if not public.fn_is_tournament_admin(v_tid) then
    raise exception 'pago: solo un admin puede confirmar pagos';
  end if;

  update public.entry set paid = true, status = 'playing' where id = p_entry_id;

  -- The pot just grew by this buy-in → refresh prizes (preserves overrides;
  -- no-ops to '[]' if the season template is empty). verify-ui Tier 4.
  perform public.set_prizes(v_tid);

  return query select * from public.entry where id = p_entry_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_rebuy(entry_id) — unchanged body (0009) + trailing set_prizes.
--   A re-entry bumps rebuys_count → the pot grows → refresh prizes.
-- ---------------------------------------------------------------------------
create or replace function public.add_rebuy(p_entry_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tid    uuid;
  v_status public.entry_status;
  v_cur    int;
  v_until  int;
  v_stack  int;
begin
  select e.tournament_id, e.status, t.current_level, t.rebuy_until_level,
         coalesce(t.starting_stack, 0)
    into v_tid, v_status, v_cur, v_until, v_stack
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
  -- rebuy_until_level null/0 → rebuys disabled; past the period → closed.
  if coalesce(v_until, 0) = 0 or v_cur > v_until then
    raise exception 'recompra: el período de recompra ya cerró';
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
-- clarity (mirrors 0005 / 0009). Each RPC is SECURITY DEFINER with an internal
-- admin guard, so granting execute to authenticated is safe.
-- ---------------------------------------------------------------------------
grant execute on function public.open_tournament(uuid) to authenticated, service_role;
grant execute on function public.confirm_payment(uuid) to authenticated, service_role;
grant execute on function public.add_rebuy(uuid)       to authenticated, service_role;
