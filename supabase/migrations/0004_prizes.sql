-- ============================================================================
-- Poker Friends — Pot + prize distribution (slice 6)
--
-- Cash PRIZES are independent of season POINTS (be-contract §Resolved 1). The
-- season carries a percentage `payout_template` (e.g. top-3 [0.60,0.28,0.12]);
-- each tournament's payouts are derived from that template × the live pot,
-- rounded to clean amounts, and stored on `tournament.prizes` (be-contract
-- §Resolved 2 & 8). Admin may override any amount once the pot is final.
--
-- CANONICAL ROUNDING (plan Approach → "Prize rounding", the source of truth for
-- build agents since the external Google Doc is unreadable):
--   each slice = round(pct × pot to the nearest ₡5.000); then the 1st-place
--   slice ABSORBS THE ROUNDING REMAINDER so the payouts sum EXACTLY to the pot.
--   Worked example: pot ₡140.000, template 60/28/12 → raw 84.0/39.2/16.8K →
--   pos2 40K, pos3 15K, pos1 = 140−40−15 = 85K → [85K,40K,15K] = ₡140.000.
--
--   (NOTE: be-contract §Resolved 2's prose says "nearest ₡1.000", but its own
--    example ₡39.2K→₡40K only holds at ₡5.000 granularity, and the plan's
--    canonical block — which the slice brief pins as authoritative — says
--    ₡5.000. We follow ₡5.000; the ₡1.000 figure is treated as a stale typo.)
--
-- OVERRIDE MODEL (documented; the brief asked us to choose one):
--   `tournament.prizes` is a jsonb array of {position, pct, amount, overridden}.
--   `set_prizes_manual(id, amounts)` sets the given positions' amounts and marks
--   them overridden=true (admin's numbers are authoritative — taken as-is, NOT
--   re-rounded and NOT forced to sum to the pot; the admin may intentionally
--   deviate, e.g. add a bounty). `set_prizes(id)` (re)computes AROUND overrides:
--   overridden slices are preserved untouched, and the remaining pot
--   (pot − Σ overridden) is distributed across the non-overridden slices, still
--   rounding to ₡5.000, with the ABSORBER — the lowest-numbered non-overridden
--   position (normally 1st) — taking the remainder so the grand total still
--   equals the pot EXACTLY. With no overrides this reduces to the base rule
--   (absorber = 1st). If every position is overridden there is no absorber and
--   the amounts are left exactly as the admin set them.
--
-- ACCESS: fn_pot is a read helper (authenticated — the live view shows the pot).
--   set_prizes / set_prizes_manual WRITE money → SECURITY DEFINER asserting
--   admin. The guard also admits the service_role JWT so the integration suite
--   can exercise them directly (mirrors slice 5's service-role test path).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- fn_pot(tournament_id) → numeric
--   COALESCE(prize_pool_override, paid_count×buy_in + Σrebuys_count×rebuy_amount)
--   (be-contract "pot" formula). rebuy_amount is nullable → treated as 0.
-- ---------------------------------------------------------------------------
create or replace function public.fn_pot(p_tournament_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    t.prize_pool_override,
    (select count(*) from public.entry e
      where e.tournament_id = t.id and e.paid) * t.buy_in
    + (select coalesce(sum(e.rebuys_count), 0) from public.entry e
        where e.tournament_id = t.id) * coalesce(t.rebuy_amount, 0)
  )
  from public.tournament t
  where t.id = p_tournament_id;
$$;

-- ---------------------------------------------------------------------------
-- set_prizes(tournament_id) → jsonb
--   Computes payouts from season.payout_template × fn_pot, rounds each to the
--   nearest ₡5.000, has the absorber slice take the remainder so the total is
--   EXACTLY the pot, preserves any overridden slices, writes tournament.prizes.
-- ---------------------------------------------------------------------------
create or replace function public.set_prizes(p_tournament_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_step     constant numeric := 5000;    -- rounding granularity (₡5.000)
  v_pot      numeric;
  v_template jsonb;
  v_existing jsonb;
  v_pcts     numeric[];
  v_k        int;
  v_ovr      boolean[];
  v_ovr_amt  numeric[];
  v_amounts  numeric[];
  v_absorber int;                          -- lowest-numbered non-overridden pos
  v_others   numeric := 0;                 -- Σ of every slice except the absorber
  v_result   jsonb := '[]'::jsonb;
  i          int;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'set_prizes: admin only';
  end if;

  select t.prizes, s.payout_template
    into v_existing, v_template
  from public.tournament t
  join public.season s on s.id = t.season_id
  where t.id = p_tournament_id;

  if not found then
    raise exception 'set_prizes: tournament % not found', p_tournament_id;
  end if;

  v_pot := public.fn_pot(p_tournament_id);
  v_existing := coalesce(v_existing, '[]'::jsonb);

  select coalesce(array_agg(val::numeric order by ord), array[]::numeric[])
    into v_pcts
  from jsonb_array_elements_text(coalesce(v_template, '[]'::jsonb))
       with ordinality as x(val, ord);

  v_k := array_length(v_pcts, 1);
  if v_k is null then       -- empty template → no prizes
    update public.tournament set prizes = '[]'::jsonb where id = p_tournament_id;
    return '[]'::jsonb;
  end if;

  -- Pass 1: read the override flag/amount for each position and pick the
  -- absorber (the lowest-numbered position that is NOT overridden).
  for i in 1 .. v_k loop
    v_ovr[i] := coalesce(
      (select (e->>'overridden')::boolean
         from jsonb_array_elements(v_existing) e
        where (e->>'position')::int = i limit 1), false);
    v_ovr_amt[i] := coalesce(
      (select (e->>'amount')::numeric
         from jsonb_array_elements(v_existing) e
        where (e->>'position')::int = i limit 1), 0);
    if not v_ovr[i] and v_absorber is null then
      v_absorber := i;
    end if;
  end loop;

  -- Pass 2: overridden slices keep their amount; every other non-absorber slice
  -- rounds to the nearest ₡5.000. Accumulate everything except the absorber.
  for i in 1 .. v_k loop
    if v_ovr[i] then
      v_amounts[i] := v_ovr_amt[i];
      v_others := v_others + v_amounts[i];
    elsif i = v_absorber then
      v_amounts[i] := 0;                    -- placeholder, set below
    else
      v_amounts[i] := round(v_pcts[i] * v_pot / v_step) * v_step;
      v_others := v_others + v_amounts[i];
    end if;
  end loop;

  -- The absorber takes the remainder so Σ amounts = pot EXACTLY.
  if v_absorber is not null then
    v_amounts[v_absorber] := v_pot - v_others;
  end if;

  for i in 1 .. v_k loop
    v_result := v_result || jsonb_build_object(
      'position',   i,
      'pct',        v_pcts[i],
      'amount',     v_amounts[i],
      'overridden', v_ovr[i]
    );
  end loop;

  update public.tournament set prizes = v_result where id = p_tournament_id;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_prizes_manual(tournament_id, amounts) → jsonb
--   amounts = jsonb array of {position, amount}. Sets those positions' amounts
--   and marks them overridden=true, leaving other slices untouched. Seeds a
--   template baseline via set_prizes() first if no prizes exist yet. Amounts are
--   authoritative (not re-rounded, not reconciled to the pot); a later
--   set_prizes() recompute preserves them and rebalances around them.
-- ---------------------------------------------------------------------------
create or replace function public.set_prizes_manual(
  p_tournament_id uuid,
  p_amounts       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_result   jsonb := '[]'::jsonb;
  elem       jsonb;
  v_pos      int;
  v_new_amt  numeric;
begin
  if not (public.auth_is_admin() or auth.role() = 'service_role') then
    raise exception 'set_prizes_manual: admin only';
  end if;

  select prizes into v_existing from public.tournament where id = p_tournament_id;
  if not found then
    raise exception 'set_prizes_manual: tournament % not found', p_tournament_id;
  end if;

  -- No prizes yet → seed a template baseline (also writes it) before overlaying.
  if v_existing is null then
    v_existing := public.set_prizes(p_tournament_id);
  end if;

  -- Rebuild the array, overlaying an override amount wherever the caller gave a
  -- matching position.
  for elem in select value from jsonb_array_elements(v_existing) loop
    v_pos := (elem->>'position')::int;
    v_new_amt := null;                       -- reset (SELECT INTO leaves prior value on no-row)
    select (a->>'amount')::numeric into v_new_amt
      from jsonb_array_elements(p_amounts) a
     where (a->>'position')::int = v_pos
     limit 1;
    if v_new_amt is not null then
      v_result := v_result || jsonb_build_object(
        'position',   v_pos,
        'pct',        elem->'pct',
        'amount',     v_new_amt,
        'overridden', true
      );
    else
      v_result := v_result || elem;          -- unchanged slice
    end if;
  end loop;

  update public.tournament set prizes = v_result where id = p_tournament_id;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--   * fn_pot: read helper → authenticated + service_role.
--   * set_prizes / set_prizes_manual: SECURITY DEFINER with an internal admin
--     guard, so granting execute to authenticated is safe (non-admins are
--     rejected inside); service_role for the integration suite.
-- ---------------------------------------------------------------------------
revoke all on function public.set_prizes(uuid)                from public;
revoke all on function public.set_prizes_manual(uuid, jsonb)  from public;

grant execute on function public.fn_pot(uuid)                 to authenticated, service_role;
grant execute on function public.set_prizes(uuid)             to authenticated, service_role;
grant execute on function public.set_prizes_manual(uuid, jsonb) to authenticated, service_role;
