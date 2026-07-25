# Poker Friends — Phase 3

Live-Liga scoring change + admin/roster/auth features, on top of shipped Phase 1+2. Built + reviewed
via the dh harness (build → test → review-loop panel). Migrations 0019–0022.

## What changed
- **Scoring v2 (mig 0019):** `Points = (N−P)×5 + 15 (attendance) + 10 (final table) + graduated top-4
  (1st +20 / 2nd +15 / 3rd +10 / 4th +5) − 15 (no-show)`. New `season.top_finish_bonuses` jsonb;
  backfills the active season. (Final-table size ≤10→Top5 / >10→Top10 was already in place.)
- **Fecha admin (mig 0020):** cancel (`cancelled_at`, excluded from live/play) + hard-delete
  (`delete_tournament` RPC, gated to non-completed fechas); PROXIMA shows buy-in; date/time edit is a
  calendar icon.
- **Roster + guests (mig 0021):** "Agregar jugador" admin UI (wires the existing `create_player`);
  guest players (`is_guest`) who play + count toward prizes/field but earn 0 league points and never
  appear on the Tabla.
- **Access-request flow (mig 0022):** a first-time unknown email is recorded as a pending
  `signup_request` (no link sent); the admin approves (→ creates the player + sends the magic link) or
  rejects. Known emails log in unchanged.
- "Cómo se juega" moved to the Liga view + simplified; FE points preview updated to v2 (matches engine).

## Why
Per the 2026-07-25 product decisions in `.harness/decisions.md`.

## How to verify
`npm install` → `npm run build` (green) · `npm run lint` (clean) · `npm test` → **389 passed / 1
skipped** (local Supabase required). New migrations apply cleanly on a fresh DB (`supabase db reset`).

## Review & verification
`/dh:review-loop` panel (five-axis + security + data-migration) → **APPROVED** (2 iters). Caught + fixed
a **CRITICAL**: the shipped anon key could execute the DEFINER points writers (`fn_tournament_points`,
`recompute_final_table_size`) and overwrite match points — now revoked from anon/authenticated. Also
fixed: cancelled-live-fecha still playable, delete offered on completed fechas, missing policy guards,
NULL-role guard fail-open. Full record: `.harness/notes/poker-league-phase3/review-loop.md`.

## Risks / accepted (followups)
- v2 doesn't rescore already-completed fechas (moot — prod has 0 completed).
- `request_access` has no rate-limit (accepted for a private league; admin reviews every request).
- Systemic DEFINER-writer ACL / NULL-role audit (e.g. `create_player`) recommended as a follow-up.
- SMTP + "Poker Friends Auth" sender not included (needs a provider).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KKUxyb1xi2eH1fbrUVFUcG
