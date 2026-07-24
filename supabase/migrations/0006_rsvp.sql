-- ============================================================================
-- Poker Friends — RSVP + graduated late-cancel (slice 9)
--
-- Two player-facing SECURITY DEFINER RPCs. The caller is identified as the
-- authenticated league member via auth_player_id() (bypassing RLS to write the
-- caller's own entry atomically). Both are locked to status='scheduled': once an
-- admin opens the fecha (open_tournament flips it to 'live', slice 7) RSVP and
-- cancel are frozen — the field is set and check-in/play takes over.
--
-- ── rsvp(tournament_id, choice) ────────────────────────────────────────────
-- choice ∈ 'confirm' | 'decline'. Upserts the caller's entry to
-- confirmed/declined and stamps rsvp_at. This is the penalty-FREE path — a
-- plain "Voy / No voy" while the fecha is still open for RSVP. Re-confirming or
-- switching a plain decline clears any prior cancelled_at + points_earned so a
-- member who backed out and came back is not carrying a stale penalty.
--
-- ── cancel_rsvp(tournament_id) ─────────────────────────────────────────────
-- Backing out of a CONFIRMED slot late costs season points on a graduated band
-- read from season.cancel_bands (jsonb [{hours_before, penalty}]). The band is
-- the one with the LARGEST hours_before that is still <= the hours remaining
-- until scheduled_at (default bands: >24h→0, 24–12h→−5, 12–6h→−10, <6h→−15).
-- The penalty is stored as a NEGATIVE points_earned on the entry so completion /
-- leaderboard already see it. Idempotent-safe: only a 'confirmed' entry is
-- penalized+flipped; a second call (already 'declined') is a no-op that returns
-- the row without double-charging.
--
-- Both admit service_role (grant) so the integration suite can drive fixtures;
-- the acting player, however, is always auth_player_id(), so the RSVP/cancel
-- calls themselves are exercised by a signed-in test user.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rsvp(tournament_id, choice) → the caller's upserted entry row
-- ---------------------------------------------------------------------------
create or replace function public.rsvp(p_tournament_id uuid, p_choice text)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id  uuid := public.auth_player_id();
  v_status     public.tournament_status;
  v_new_status public.entry_status;
begin
  if v_player_id is null then
    raise exception 'rsvp: current user is not a league member';
  end if;

  if p_choice not in ('confirm', 'decline') then
    raise exception 'rsvp: choice must be confirm or decline (got %)', p_choice;
  end if;

  select t.status into v_status
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'rsvp: tournament % not found', p_tournament_id;
  end if;

  -- RSVP is locked once the fecha is opened (live) or done (completed).
  if v_status <> 'scheduled' then
    raise exception
      'rsvp: tournament % is %, RSVP is locked once the fecha is opened',
      p_tournament_id, v_status;
  end if;

  v_new_status := case
    when p_choice = 'confirm' then 'confirmed'::public.entry_status
    else 'declined'::public.entry_status
  end;

  -- Upsert: a pre-created 'invited' entry (or an earlier confirm/decline/cancel)
  -- is updated in place; a member with no row yet gets one. Penalty-free path →
  -- clear any prior cancellation + stored penalty.
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

-- ---------------------------------------------------------------------------
-- cancel_rsvp(tournament_id) → the caller's entry row (penalty in points_earned)
-- ---------------------------------------------------------------------------
create or replace function public.cancel_rsvp(p_tournament_id uuid)
returns setof public.entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id    uuid := public.auth_player_id();
  v_status       public.tournament_status;
  v_scheduled_at timestamptz;
  v_season_id    uuid;
  v_bands        jsonb;
  v_hours        numeric;
  v_penalty      int;
  v_entry_status public.entry_status;
begin
  if v_player_id is null then
    raise exception 'cancel_rsvp: current user is not a league member';
  end if;

  select t.status, t.scheduled_at, t.season_id
    into v_status, v_scheduled_at, v_season_id
  from public.tournament t
  where t.id = p_tournament_id;

  if not found then
    raise exception 'cancel_rsvp: tournament % not found', p_tournament_id;
  end if;

  -- Same lock as rsvp: no cancelling once the fecha is opened.
  if v_status <> 'scheduled' then
    raise exception
      'cancel_rsvp: tournament % is %, cancellation is locked once the fecha is opened',
      p_tournament_id, v_status;
  end if;

  select e.status into v_entry_status
  from public.entry e
  where e.tournament_id = p_tournament_id and e.player_id = v_player_id;

  if not found then
    raise exception 'cancel_rsvp: no entry to cancel for this fecha';
  end if;

  -- Idempotent-safe: only a still-confirmed entry is penalized + flipped. A
  -- repeat call (already declined) returns the row untouched — no double charge.
  if v_entry_status = 'confirmed' then
    -- Graduated band: hours remaining until start (clamped at 0 for past-due /
    -- last-minute), then the band with the largest hours_before <= that value.
    v_hours := greatest(extract(epoch from (v_scheduled_at - now())) / 3600.0, 0);

    select s.cancel_bands into v_bands
    from public.season s where s.id = v_season_id;

    select (b->>'penalty')::int into v_penalty
    from jsonb_array_elements(v_bands) b
    where (b->>'hours_before')::numeric <= v_hours
    order by (b->>'hours_before')::numeric desc
    limit 1;

    v_penalty := coalesce(v_penalty, 0);

    update public.entry
       set status        = 'declined',
           cancelled_at   = now(),
           points_earned  = v_penalty
     where tournament_id = p_tournament_id and player_id = v_player_id;
  end if;

  return query
    select * from public.entry
    where tournament_id = p_tournament_id and player_id = v_player_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Both are SECURITY DEFINER with an internal auth_player_id() gate, so
-- granting execute to authenticated is safe; service_role for the test harness.
-- ---------------------------------------------------------------------------
revoke all on function public.rsvp(uuid, text) from public;
grant execute on function public.rsvp(uuid, text) to authenticated, service_role;

revoke all on function public.cancel_rsvp(uuid) from public;
grant execute on function public.cancel_rsvp(uuid) to authenticated, service_role;
