-- ============================================================================
-- Poker Friends — Phase 2, slices 14 + 15: per-fecha photo gallery + cover cards
--
-- STEP 14 — gallery_photo table + a `gallery` Storage bucket + RLS. Any authed
--   LEAGUE member may upload (insert their OWN gallery_photo row + a storage
--   object under their own player-id folder); league members may READ every
--   photo; the UPLOADER or an admin may DELETE. Mirrors the avatars-bucket shape
--   from 0011 — the bucket is PUBLIC so getPublicUrl renders the grid + covers
--   without the (locally stopped) imgproxy transform endpoint. The real
--   authorization teeth live on the gallery_photo TABLE (RLS below); the storage
--   policies gate the object bytes with the same owner-folder idiom as avatars.
--
-- STEP 15 — tournament.cover_url (nullable). The history / past-fecha list
--   renders a full-bleed cover from this URL; null → a themed gradient fallback
--   (handled in the FE, no broken image). Admin sets the cover from the fecha
--   view via the existing "admin update tournament" RLS policy (0001) writing
--   this column directly. Backfill: left null (fallback rendering handles it).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) tournament.cover_url — nullable; existing rows stay null (gradient fallback).
-- ---------------------------------------------------------------------------
alter table public.tournament add column if not exists cover_url text;

-- ---------------------------------------------------------------------------
-- (2) gallery_photo — one row per uploaded photo, linked to a fecha + uploader.
--     on delete cascade so removing a fecha/player also clears its media rows.
-- ---------------------------------------------------------------------------
create table if not exists public.gallery_photo (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournament(id) on delete cascade,
  uploader_id   uuid not null references public.player(id)     on delete cascade,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_gallery_photo_tournament on public.gallery_photo(tournament_id);
create index if not exists idx_gallery_photo_uploader   on public.gallery_photo(uploader_id);

alter table public.gallery_photo enable row level security;

-- RLS — same model as the rest of the schema (default privileges already grant
-- table DML to `authenticated`, so RLS is the gate). Players get scoped DIRECT
-- access here (no RPC): the row is fully player-owned media, and every write is
-- constrained to the caller's own player id.
--   SELECT — league members only. auth_player_id() resolves to the caller's
--     bound player row; a signed-in auth user with NO player row (non-member)
--     gets NULL → sees nothing.
--   INSERT — a league member may insert ONLY their own row (uploader_id = self).
--   DELETE — the uploader OR any admin.
--   (no UPDATE policy — a posted photo is immutable.)
drop policy if exists "gallery_photo member read"       on public.gallery_photo;
drop policy if exists "gallery_photo uploader insert"    on public.gallery_photo;
drop policy if exists "gallery_photo owner or admin delete" on public.gallery_photo;

create policy "gallery_photo member read" on public.gallery_photo
  for select to authenticated
  using (public.auth_player_id() is not null);

create policy "gallery_photo uploader insert" on public.gallery_photo
  for insert to authenticated
  with check (uploader_id = public.auth_player_id());

create policy "gallery_photo owner or admin delete" on public.gallery_photo
  for delete to authenticated
  using (public.auth_is_admin() or uploader_id = public.auth_player_id());

-- ---------------------------------------------------------------------------
-- (3) `gallery` Storage bucket (public read, mirroring `avatars` from 0011 so
--     getPublicUrl / cover_url render without the stopped imgproxy transforms).
--     Objects are keyed by an uploader-id folder: path = "<uploader_id>/<file>"
--     (covers land under "<uploader_id>/covers/<file>"), so the owner-or-admin
--     delete/update policies match on the first path segment exactly like the
--     avatars bucket does.
-- ---------------------------------------------------------------------------
-- Capped to image types + a sane per-object size so a member can't push
-- arbitrary content-typed or unbounded bytes into this public bucket (the FE
-- `accept="image/*"` is not a server-side gate). file_size_limit is bytes
-- (storage.buckets column is bigint): 10 MiB = 10 * 1024 * 1024.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gallery', 'gallery', true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "gallery public read"          on storage.objects;
drop policy if exists "gallery member insert"         on storage.objects;
drop policy if exists "gallery owner or admin update" on storage.objects;
drop policy if exists "gallery owner or admin delete" on storage.objects;

create policy "gallery public read" on storage.objects
  for select to public
  using (bucket_id = 'gallery');

-- Any league member uploads under their OWN player-id folder.
create policy "gallery member insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'gallery'
    and public.auth_player_id() is not null
    and (storage.foldername(name))[1] = public.auth_player_id()::text
  );

-- Upsert support (owner or admin) — matches the avatars owner-update shape.
create policy "gallery owner or admin update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'gallery'
    and (public.auth_is_admin() or (storage.foldername(name))[1] = public.auth_player_id()::text)
  )
  with check (
    bucket_id = 'gallery'
    and (public.auth_is_admin() or (storage.foldername(name))[1] = public.auth_player_id()::text)
  );

create policy "gallery owner or admin delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'gallery'
    and (public.auth_is_admin() or (storage.foldername(name))[1] = public.auth_player_id()::text)
  );
