-- ============================================================================
-- Poker Friends — push on "nueva fecha" + shared webhook helper (2026-09)
--
-- Adds a second push event: when an admin creates a fecha, every subscribed
-- player (not just admins) gets "🃏 Nueva fecha: …". The pg_net call is
-- factored into public.fn_push_webhook(event, tournament, subject) — reading
-- the Vault config (push_webhook_url / push_webhook_secret) and no-op'ing when
-- absent — and the 0032 entry trigger is re-pointed at it. Recipient selection
-- (admins vs everyone) lives in the push-notify Edge Function.
-- ============================================================================

create or replace function public.fn_push_webhook(
  p_event      text,
  p_tournament uuid,
  p_subject    uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_webhook_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
  if v_url is null or v_secret is null then
    return;  -- push not configured in this environment
  end if;

  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object(
      'event',             p_event,
      'tournament_id',     p_tournament,
      'subject_player_id', p_subject,
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
exception when others then
  -- Never let a notification problem break the write that triggered it.
  raise warning 'fn_push_webhook(%): %', p_event, sqlerrm;
end;
$$;
revoke all on function public.fn_push_webhook(text, uuid, uuid) from public, anon, authenticated;

-- Entry trigger (0032) now delegates to the helper. Same transitions.
create or replace function public.fn_entry_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status not in ('confirmed', 'declined', 'checked_in') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;
  perform public.fn_push_webhook(new.status::text, new.tournament_id, new.player_id);
  return new;
end;
$$;
revoke all on function public.fn_entry_push_notify() from public, anon, authenticated;

-- New: a fecha is created → everyone hears about it.
create or replace function public.fn_tournament_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.fn_push_webhook('fecha_created', new.id, new.created_by);
  return new;
end;
$$;
revoke all on function public.fn_tournament_push_notify() from public, anon, authenticated;

drop trigger if exists trg_tournament_push_notify on public.tournament;
create trigger trg_tournament_push_notify
  after insert on public.tournament
  for each row execute function public.fn_tournament_push_notify();
