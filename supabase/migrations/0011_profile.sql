-- ============================================================================
-- Poker Friends — Player profile RPC + avatar Storage bucket (slice 14)
--
-- player_profile(player_id[, season_id]) → one row of that player's season
-- stats for the Perfil screen:
--   * total_points / games_played / wins(títulos) / podiums — the SAME
--     aggregation the slice-5 `leaderboard` RPC uses (sum of the already-computed
--     entry.points_earned; wins/podiums keyed off final_position / chopped).
--   * points_history — cumulative points over the season's COMPLETED tournaments,
--     ordered oldest→newest (drives the profile sparkline). jsonb array of
--     {scheduled_at, points, cumulative}. The final `cumulative` equals
--     total_points, so the sparkline ends exactly on the "Puntos" stat.
--   * form — the FULL result-tier array (champion|podium|final|out), most-recent
--     FIRST (index 0 = latest game), same tier rules as `leaderboard`. The FE
--     reverses it for display (newest-on-the-right).
--
-- History set: entries in COMPLETED tournaments of the season where the player
--   was ranked (final_position not null) OR carried a non-zero penalty
--   (no-show / late-cancel). Pure-zero non-participation (invited, never played)
--   is excluded so the sparkline stays meaningful; excluding zeros does not
--   change the sum, so total_points still matches the leaderboard total.
--
-- season_id is OPTIONAL: null → the single active season (what the FE passes,
--   matching the be-contract `player_profile(player_id)` signature). Tests pass
--   an explicit (archived) season id to stay isolated from the shared seed.
-- ============================================================================

create or replace function public.player_profile(
  p_player_id uuid,
  p_season_id uuid default null
) returns table (
  player_id      uuid,
  player_name    text,
  avatar_url     text,
  total_points   int,
  games_played   int,
  wins           int,
  podiums        int,
  points_history jsonb,
  form           text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select coalesce(
      p_season_id,
      (select id from public.season where status = 'active' order by year desc limit 1)
    ) as season_id
  ),
  hist as (
    select e.id, e.final_position, e.chopped, e.made_final_table,
           e.points_earned, t.scheduled_at
    from public.entry e
    join public.tournament t on t.id = e.tournament_id
    join active a on a.season_id = t.season_id
    where e.player_id = p_player_id
      and t.status = 'completed'
      and e.points_earned is not null
      and (e.final_position is not null or e.points_earned <> 0)
  ),
  hist_cum as (
    select scheduled_at,
           points_earned,
           sum(points_earned) over (
             order by scheduled_at asc, id asc
             rows between unbounded preceding and current row
           ) as cumulative
    from hist
  ),
  form_rows as (
    select
      case
        when final_position = 1 or chopped    then 'champion'
        when final_position between 2 and 3    then 'podium'
        when made_final_table                  then 'final'
        else 'out'
      end as tier,
      scheduled_at, id
    from hist
    where final_position is not null
  )
  select
    p.id,
    p.name,
    p.avatar_url,
    coalesce((select sum(points_earned) from hist), 0)::int,
    coalesce((select count(*) from hist where final_position is not null), 0)::int,
    coalesce((select count(*) from hist where final_position = 1 or chopped), 0)::int,
    coalesce((select count(*) from hist where chopped or final_position between 1 and 3), 0)::int,
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'scheduled_at', scheduled_at,
                 'points',       points_earned,
                 'cumulative',   cumulative
               )
               order by scheduled_at asc
             )
      from hist_cum
    ), '[]'::jsonb),
    coalesce((
      select array_agg(tier order by scheduled_at desc, id desc)
      from form_rows
    ), array[]::text[])
  from public.player p
  where p.id = p_player_id;
$$;

-- Read-only, per-player → safe for any signed-in user + tests.
grant execute on function public.player_profile(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- Storage: `avatars` bucket (public read) + owner-only write policies.
--   Objects are keyed by player id: path = "<player_id>/<file>". A signed-in
--   member may create/replace/delete only objects under their own player-id
--   folder (auth_player_id()); everyone may read (public bucket).
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "avatars public read"   on storage.objects;
drop policy if exists "avatars owner insert"   on storage.objects;
drop policy if exists "avatars owner update"   on storage.objects;
drop policy if exists "avatars owner delete"   on storage.objects;

create policy "avatars public read" on storage.objects
  for select to public
  using (bucket_id = 'avatars');

create policy "avatars owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.auth_player_id()::text
  );

create policy "avatars owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.auth_player_id()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.auth_player_id()::text
  );

create policy "avatars owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.auth_player_id()::text
  );
