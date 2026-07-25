-- ============================================================================
-- Poker Friends — allow confirming attendance during a LIVE fecha (slice 24)
--
-- Forward-fix of rsvp() from 0006. A late arrival should still be able to say
-- "Voy" after the admin has opened the fecha (status='live'), so the existing
-- check-in flow (live + confirmed → check-in button) can pick them up. 0006 is
-- left untouched; this migration `create or replace`s the function in place.
--
-- What changes vs. 0006:
--   • CONFIRM is now allowed while status IN ('scheduled','live'). A late confirm
--     just sets the entry to 'confirmed' — the penalty-free path, exactly like a
--     scheduled confirm (cancel-band penalties live in cancel_rsvp, DECLINE-only).
--   • DECLINE stays scheduled-only: backing out of a running/finished game is
--     meaningless, so a decline on a live/completed fecha raises a clear error.
--   • completed  → both choices raise (the fecha is over).
--   • cancelled  → a soft flag (tournament.cancelled_at, no 'cancelled' status
--     enum value exists); when set, RSVP is closed regardless of status.
--   • Clobber guard: a caller whose entry has already taken its seat / been
--     scored (checked_in / playing / eliminated / no_show / winner) cannot
--     re-RSVP — the upsert only runs for an absent or early entry (invited /
--     confirmed / declined). This is new: 0006 was scheduled-only, where an
--     entry could never be in an advanced state.
--
-- search_path is pinned to `public, pg_temp` (the 0012 hardening convention),
-- tighter than 0006's `public`. Grants are identical to 0006.
-- ============================================================================

create or replace function public.rsvp(p_tournament_id uuid, p_choice text)
returns setof public.entry
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player_id    uuid := public.auth_player_id();
  v_status       public.tournament_status;
  v_cancelled_at timestamptz;
  v_new_status   public.entry_status;
  v_entry_status public.entry_status;
begin
  if v_player_id is null then
    raise exception 'rsvp: current user is not a league member';
  end if;

  if p_choice not in ('confirm', 'decline') then
    raise exception 'rsvp: choice must be confirm or decline (got %)', p_choice;
  end if;

  select t.status, t.cancelled_at
    into v_status, v_cancelled_at
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'rsvp: tournament % not found', p_tournament_id;
  end if;

  -- A cancelled fecha (soft flag) is frozen for RSVP regardless of its status.
  if v_cancelled_at is not null then
    raise exception 'rsvp: tournament % is cancelled, RSVP is closed', p_tournament_id;
  end if;

  -- A completed fecha is over — neither confirm nor decline makes sense.
  if v_status = 'completed' then
    raise exception 'rsvp: tournament % is completed, RSVP is closed', p_tournament_id;
  end if;

  -- DECLINE stays scheduled-only. Declining a live fecha is meaningless (the
  -- field is already set); use cancel_rsvp before the fecha opens instead.
  if p_choice = 'decline' and v_status <> 'scheduled' then
    raise exception
      'rsvp: tournament % is %, declining is locked once the fecha is opened',
      p_tournament_id, v_status;
  end if;
  -- CONFIRM reaches here for status IN ('scheduled','live') — the late-arrival
  -- path. (completed / cancelled already raised above.)

  -- Clobber guard: a player who has already taken their seat or been scored
  -- cannot re-RSVP. Only an absent or early entry is upsertable.
  select e.status into v_entry_status
  from public.entry e
  where e.tournament_id = p_tournament_id and e.player_id = v_player_id;

  if found and v_entry_status not in ('invited', 'confirmed', 'declined') then
    raise exception
      'rsvp: entry is already % — a player already in the game cannot re-RSVP',
      v_entry_status;
  end if;

  v_new_status := case
    when p_choice = 'confirm' then 'confirmed'::public.entry_status
    else 'declined'::public.entry_status
  end;

  -- Upsert (same shape as 0006): a pre-created 'invited' entry (or an earlier
  -- confirm/decline/cancel) is updated in place; a member with no row yet gets
  -- one. Penalty-free path → clear any prior cancellation + stored penalty.
  insert into public.entry (tournament_id, player_id, status, rsvp_at)
  values (p_tournament_id, v_player_id, v_new_status, now())
  on conflict (tournament_id, player_id) do update
    set status        = excluded.status,
        rsvp_at       = now(),
        cancelled_at  = null,
        points_earned = null;

  return query
    select * from public.entry
    where tournament_id = p_tournament_id and player_id = v_player_id;
end;
$$;

-- Grants — identical to 0006 (SECURITY DEFINER with an internal auth_player_id()
-- gate → safe for authenticated; service_role for the integration harness).
revoke all on function public.rsvp(uuid, text) from public;
grant execute on function public.rsvp(uuid, text) to authenticated, service_role;
