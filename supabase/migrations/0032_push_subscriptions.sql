-- ============================================================================
-- Poker Friends — Web Push for RSVP events (2026-09)
--
-- (1) push_subscription — one row per browser/device subscription (Web Push
--     endpoint + keys), owned by a player. The FE (lib/push.ts) upserts it when
--     the admin turns "Avisos de la fecha" on in Perfil and deletes it when off.
-- (2) A trigger on `entry` that, whenever a player's status BECOMES confirmed /
--     declined / checked_in, POSTs a small event to the `push-notify` Edge
--     Function through pg_net. The function fans out to every admin's
--     subscriptions (except the actor's own) and prunes dead endpoints.
--
-- Config lives in Vault, NOT in this file: `push_webhook_url` (the function URL)
-- and `push_webhook_secret` (shared secret the function checks). When either is
-- missing the trigger is a no-op, so local / test databases work without any
-- push setup. Set them per environment with:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/push-notify', 'push_webhook_url');
--   select vault.create_secret('<random>', 'push_webhook_secret');
-- ============================================================================

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- (1) push_subscription
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscription (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.player(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_push_subscription_player on public.push_subscription(player_id);

alter table public.push_subscription enable row level security;

-- Owner-only, all verbs. The Edge Function reads every admin's row with the
-- service role (bypasses RLS); no player can see another player's endpoints.
drop policy if exists "push_subscription owner select" on public.push_subscription;
drop policy if exists "push_subscription owner insert" on public.push_subscription;
drop policy if exists "push_subscription owner update" on public.push_subscription;
drop policy if exists "push_subscription owner delete" on public.push_subscription;
create policy "push_subscription owner select" on public.push_subscription
  for select to authenticated
  using (player_id = public.auth_player_id());
create policy "push_subscription owner insert" on public.push_subscription
  for insert to authenticated
  with check (player_id = public.auth_player_id());
create policy "push_subscription owner update" on public.push_subscription
  for update to authenticated
  using (player_id = public.auth_player_id())
  with check (player_id = public.auth_player_id());
create policy "push_subscription owner delete" on public.push_subscription
  for delete to authenticated
  using (player_id = public.auth_player_id());

-- ---------------------------------------------------------------------------
-- (2) entry → push-notify webhook
-- ---------------------------------------------------------------------------
create or replace function public.fn_entry_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
  v_event  text;
begin
  -- Only the transitions the admins care about, and only when the status
  -- actually changed (an UPDATE that rewrites other columns must not re-fire).
  if new.status not in ('confirmed', 'declined', 'checked_in') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;
  v_event := new.status::text;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_webhook_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
  if v_url is null or v_secret is null then
    return new;  -- push not configured in this environment
  end if;

  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object(
      'event',             v_event,
      'entry_id',          new.id,
      'tournament_id',     new.tournament_id,
      'subject_player_id', new.player_id,
      -- Who performed the action (null for service-role / system writes): the
      -- function skips this player's own devices.
      'actor_player_id',   public.auth_player_id()
    ),
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-webhook-secret', v_secret
    ),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  -- Never let a notification problem break the RSVP / check-in itself.
  raise warning 'fn_entry_push_notify: %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.fn_entry_push_notify() from public, anon, authenticated;

drop trigger if exists trg_entry_push_notify on public.entry;
create trigger trg_entry_push_notify
  after insert or update of status on public.entry
  for each row execute function public.fn_entry_push_notify();
