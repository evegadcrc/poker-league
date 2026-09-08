# Lessons

Append-only, cross-task store of solved problems and durable insights. One `##` entry per
lesson: title, then `<date> · task:<slug> · tags: <module, area, …>`, then Problem / Fix /
Prevention. Written by /dh:diagnose post-mortems and /dh:remember --lesson; consulted by
/dh:plan, /dh:diagnose, and the review-loop reviewer before work begins.


## Prod Supabase (free tier) auto-pauses after 7 idle days → "Failed to fetch" at login
2026-09-07 · task:poker-league-phase3 · tags: infra, supabase, auth, ops
Problem: App showed the login screen ("Enviar enlace") and every auth call failed with
`TypeError: Failed to fetch`. Not an app bug: the prod Supabase project (ref evbbsvwglspdzzqdvrcf)
had status INACTIVE — free-tier pause after ~7 days with no API traffic. Paused projects drop DNS
(NXDOMAIN on `<ref>.supabase.co`), so the browser reports a network error.
Fix: `supabase projects list -o json` → status; restore from the dashboard (no CLI restore
command). Data, auth SMTP config, and keys all survive a pause.
Prevention: `.github/workflows/supabase-keepalive.yml` runs one anon PostgREST query daily
(secrets SUPABASE_URL / SUPABASE_ANON_KEY on evegadcrc/poker-league). A paused project makes the
job fail, which emails the repo owner. Repo is private, so GitHub's 60-day schedule auto-disable
for inactive public repos does not apply.
