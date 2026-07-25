-- ============================================================================
-- Poker Friends — Scoring v2 (Phase 3)
--
-- New season scoring model for the ACTIVE Liga:
--
--   Points = (N − P) × 5
--          + attendance    (+15, if paid)
--          + final_table   (+10, if made_final_table)
--          + top4_graduated(1st +20 / 2nd +15 / 3rd +10 / 4th +5 / 5th+ = 0)
--          − no_show_penalty (−15, unchanged)
--
-- What changed vs 0009's fn_tournament_points:
--   • points_multiplier 10 → 5          (base weight of each finishing place)
--   • bonus_attendance   2 → 15
--   • bonus_final_table  5 → 10
--   • the FLAT bonus_top3 (≤3 → +8) is REPLACED by a GRADUATED top-4 bonus read
--     from the new `season.top_finish_bonuses` jsonb ([20,15,10,5], index 0 =
--     1st place). final_position 1..4 → the matching element; 5th+ → 0.
--   • no-show penalty (−15) and the cancel-band logic are UNCHANGED.
--   • final-table SIZE (fn_final_table_size, ≤10 → 5 / >10 → 10) is UNCHANGED.
--
-- The legacy `season.bonus_top3` column is INTENTIONALLY KEPT (other read paths
-- still reference it); the points engine simply no longer reads it.
--
-- This migration: (1) adds top_finish_bonuses, (2) moves the column DEFAULTS so
-- NEW seasons are born on v2, (3) backfills the live/active season(s) so a prod
-- `db push` flips the running Liga to v2, and (4) re-creates fn_tournament_points
-- with the graduated top-4 term. Idempotent + grants preserved.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) New column — graduated top-finish bonuses. index 0 = 1st place.
--     NOT NULL DEFAULT '[20,15,10,5]' backfills every existing row automatically.
-- ---------------------------------------------------------------------------
alter table public.season
  add column if not exists top_finish_bonuses jsonb not null default '[20,15,10,5]'::jsonb;

-- ---------------------------------------------------------------------------
-- (2) Move the base column DEFAULTS to the v2 values so future seasons inherit
--     them (0001 defaults were mult 10 / final-table 5 / attendance 2).
-- ---------------------------------------------------------------------------
alter table public.season alter column points_multiplier set default 5;
alter table public.season alter column bonus_final_table set default 10;
alter table public.season alter column bonus_attendance  set default 15;

-- ---------------------------------------------------------------------------
-- (3) Backfill the ACTIVE season(s) so the live Liga adopts v2 on db push.
--     Archived seasons keep their historical config (and their frozen scores).
-- ---------------------------------------------------------------------------
update public.season
   set points_multiplier  = 5,
       bonus_final_table   = 10,
       bonus_attendance    = 15,
       top_finish_bonuses  = '[20,15,10,5]'::jsonb
 where status = 'active';

-- ---------------------------------------------------------------------------
-- (4) fn_tournament_points(tournament_id) — REPLACES 0009's definition.
--   Same signature / branches / idempotency / no-show + cancel handling. The
--   ONLY change is the top-finish term: the flat `bonus_top3 [if P≤3]` becomes
--   the GRADUATED `top_finish_bonuses ->> (final_position−1)` for P in 1..4
--   (5th+ → 0). search_path stays pinned to `public` (matches the 0009 def).
-- ---------------------------------------------------------------------------
create or replace function public.fn_tournament_points(
  p_tournament_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_sched     timestamptz;
  v_mult      int;
  v_bmf       int;    -- bonus_final_table
  v_batt      int;    -- bonus_attendance
  v_noshow    int;    -- no_show_penalty (stored negative)
  v_bands     jsonb;  -- cancel_bands [{hours_before, penalty}]
  v_topbonus  jsonb;  -- top_finish_bonuses [20,15,10,5] (index 0 = 1st)
  v_n         int;    -- field size N (finishers)
begin
  select t.season_id, t.scheduled_at,
         s.points_multiplier, s.bonus_final_table,
         s.bonus_attendance, s.no_show_penalty, s.cancel_bands,
         s.top_finish_bonuses
    into v_season_id, v_sched, v_mult, v_bmf, v_batt, v_noshow, v_bands, v_topbonus
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if v_season_id is null then
    raise exception 'fn_tournament_points: tournament % not found', p_tournament_id;
  end if;

  -- N = number of ranked finishers (entries with a final_position).
  select count(*) into v_n
  from public.entry
  where tournament_id = p_tournament_id and final_position is not null;

  -- (1) Regular finishers (not part of a chop): full v2 formula. The graduated
  --     top-4 bonus reads element (final_position − 1) of top_finish_bonuses.
  update public.entry e
     set points_earned =
           (v_n - e.final_position) * v_mult
         + case when e.made_final_table then v_bmf else 0 end
         + case when e.final_position between 1 and 4
                then coalesce((v_topbonus ->> (e.final_position - 1))::int, 0)
                else 0 end
         + case when e.paid then v_batt else 0 end
   where e.tournament_id = p_tournament_id
     and e.final_position is not null
     and e.chop_group is null;

  -- (2) Chop co-champions: average the v2 point-value across the group, then
  --     round once. Each member brings their own final_table / paid eligibility
  --     and their own graduated top-4 bonus.
  with grp as (
    select e.chop_group,
           round(avg(
               (v_n - e.final_position) * v_mult
             + case when e.made_final_table then v_bmf else 0 end
             + case when e.final_position between 1 and 4
                    then coalesce((v_topbonus ->> (e.final_position - 1))::int, 0)
                    else 0 end
             + case when e.paid then v_batt else 0 end
           ))::int as pts
    from public.entry e
    where e.tournament_id = p_tournament_id
      and e.chop_group is not null
    group by e.chop_group
  )
  update public.entry e
     set points_earned = grp.pts
    from grp
   where e.tournament_id = p_tournament_id
     and e.chop_group = grp.chop_group;

  -- (3) No-shows: −15, BUT preserve an admin-set value (excused 0 / already −15).
  update public.entry e
     set points_earned = coalesce(e.points_earned, v_noshow)
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status = 'no_show';

  -- (4) Cancellations: preserve a penalty already applied, else derive the band.
  update public.entry e
     set points_earned = coalesce(
       e.points_earned,
       coalesce(
         (select (b->>'penalty')::int
            from jsonb_array_elements(v_bands) b
           where extract(epoch from (v_sched - e.cancelled_at)) / 3600.0
                 >= (b->>'hours_before')::numeric
           order by (b->>'hours_before')::numeric desc
           limit 1),
         (select (b->>'penalty')::int
            from jsonb_array_elements(v_bands) b
           order by (b->>'hours_before')::numeric asc
           limit 1)
       )
     )
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status <> 'no_show'
     and e.cancelled_at is not null;

  -- (5) Everyone else: 0.
  update public.entry e
     set points_earned = 0
   where e.tournament_id = p_tournament_id
     and e.final_position is null
     and e.chop_group is null
     and e.status <> 'no_show'
     and e.cancelled_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. CREATE OR REPLACE preserves existing privileges; re-asserted here to
-- mirror 0003 / 0009 — fn_tournament_points WRITES scores, so service_role only.
--
-- SECURITY: `revoke ... from public` alone does NOT strip the implicit
-- anon/authenticated grants Supabase attaches at first CREATE (0003) and that
-- CREATE OR REPLACE preserves — so anon/authenticated remained EXECUTE-able and
-- could clobber admin point overrides. fn_tournament_points is an INTERNAL writer
-- (called only by complete_tournament and friends, which run as their own
-- definer), so revoke anon+authenticated explicitly. service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.fn_tournament_points(uuid) from public, anon, authenticated;
grant execute on function public.fn_tournament_points(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Forward-fix for 0005: recompute_final_table_size (SECURITY DEFINER, writes
-- tournament.final_table_size, NO internal auth guard) is the SAME class of bug —
-- its 0005 grant used `revoke ... from public` only, so anon/authenticated kept
-- their implicit EXECUTE and could force-recompute the final-table size. It is an
-- INTERNAL helper (called only by open_tournament / check_in / complete_tournament
-- as their own definer), so strip anon+authenticated here (0005 is shipped — cannot
-- edit in place). service_role grant from 0005 is retained.
-- ---------------------------------------------------------------------------
revoke execute on function public.recompute_final_table_size(uuid) from public, anon, authenticated;
