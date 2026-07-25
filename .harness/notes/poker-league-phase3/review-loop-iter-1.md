# Review iter 1 — poker-league-phase3
Diff: main...HEAD, 30 files, +2989/-198
Verdict: FINDINGS

Scope verified: scoring-v2 engine (mig 0019) + FE preview parity, guest exclusion
(0021), cancel/delete (0020), access-request flow (0022), seed v2 numbers, and the
test suites that pin them. Cross-checked canonical fixtures with the SQL and the
migrations against decisions.md (2026-07-25 Phase 3 entry).

## Findings

### Required
- **src/routes/Live.tsx:71 · src/routes/Admin.tsx:436 · src/routes/Calculadora.tsx:82 —
  Cancel of a LIVE fecha is not honored.** `AdminFechaActions` explicitly offers
  "Cancelar fecha" for `status==='live'` (FechaDetail.tsx:659), but the three live-
  tournament queries filter only `.eq('status','live')` and ignore `cancelled_at`.
  A soft-cancelled live fecha keeps `status='live'`, so: (a) the En Vivo screen still
  loads it as THE live game for every player (clock running), (b) the admin console
  still loads it and can run `complete_tournament` on it → injects season points,
  (c) the Calculadora odds-gate still disables the calculator. Only Fechas list +
  FechaDetail respect the flag. Fix: add `.is('cancelled_at', null)` to all three
  queries (or gate `complete_tournament` server-side on `cancelled_at is null`).
  Scheduled-fecha cancel is fully handled; this is the live path only.

- **supabase/migrations/0019_scoring_v2.sql:46-55 — v2 migration does not rescore
  already-completed tournaments in the active season.** Step 3 backfills the season
  *config* + step 4 replaces the engine, but no `fn_tournament_points` re-run is
  issued for completed fechas. Any completed fecha already scored under v1 keeps its
  v1 `points_earned`, so the live Tabla would mix v1 and v2 points within one season.
  seed.sql WAS rewritten to v2 numbers for its completed Fecha 1 (seed.sql:90-113),
  which implies v2-everywhere intent — but the migration doesn't rescore prod. This
  hinges on intent I can't infer: QUESTION — does the live active season have any
  completed fechas? If yes, add a rescore loop (call `fn_tournament_points` per
  completed active-season tournament) before deploy; if no, confirm and this is moot.

- **supabase/migrations/0022_access_requests.sql:92-95,111-112 — `request_access` is
  anon-callable with no rate limit or bound → unbounded queue growth / admin-queue
  spam.** The shipped anon key can call `request_access(<random-unique-email>)`
  arbitrarily; each new email inserts a `signup_request` row (the UNIQUE constraint
  only dedupes *identical* emails). No captcha / rate limit / cap. On a live DB this
  is an availability/nuisance vector (queue flood, table growth). The membership-
  enumeration side is documented-accepted (see FYI), but the spam/insert vector is
  not. Decide consciously before shipping an anon write to prod: edge rate-limit,
  captcha, or a pending-count cap. (Security lens owns depth.)

- **src/routes/FechaDetail.tsx (AdminFechaActions, ~640-670) — "Eliminar fecha" is
  offered on COMPLETED fechas.** The Delete button renders unconditionally whenever
  `isAdmin` (only Cancel is status-gated). `delete_tournament` hard-removes the row +
  its entries + gallery. Deleting a *completed* fecha silently removes its points from
  every player's season total and destroys its photo gallery — a one-misclick data-
  loss footgun on live standings (double-confirm + warning copy mitigate, admin-only).
  QUESTION: is deleting completed fechas intended? If not, gate delete to
  `status in ('scheduled','live')` (or non-completed). The RPC itself is correct and
  FK-safe (only entry + gallery_photo reference tournament, both `on delete cascade`).

### Optional
- Optional: **src/routes/FechaDetail.tsx:301-303,314-317** — `doCancelFecha` /
  `doDeleteFecha` only `console.error` on failure; the admin gets no UI feedback when
  a cancel/delete fails (RLS/network). Surface a toast/alert like the other actions.
- Optional: **supabase/migrations/0022_access_requests.sql:92-95** — concurrent
  `request_access` for the same new email races the `select … not found → insert`;
  the loser hits the UNIQUE violation, surfaced to the anon caller as a login error.
  Use `insert … on conflict (email) do nothing` for idempotency under concurrency.
- Optional: **src/lib/access_requests.integration.test.ts** — the suite tests the RPC
  admin-gate but never asserts a *non-admin authenticated* user gets 0 rows on a
  direct `.from('signup_request').select()` (the RLS membership-leak guard). Add a
  case: the membership queue must be unreadable by a normal member.

### Nit
- Nit: **supabase/migrations/0022_access_requests.sql:54-61** — the two `create policy`
  statements aren't `drop policy if exists`-guarded, unlike the 0017 idiom; the
  migration is not re-runnable (a retry after partial apply errors "policy exists").
- Nit: **src/lib/guest_players.integration.test.ts** — guest player rows created by
  `add_guest_entry` (synthesized `guest+…@local` emails) are never tracked in
  `playerIds` nor matched by the `gst-%@test.local` cleanup, so they leak on the
  shared local stack (compounds the known flaky-integration lesson).
- Nit: **supabase/migrations/0020** — `delete_tournament` leaves orphaned guest
  players (a guest whose only fecha is deleted has no remaining entries). Harmless
  (is_guest → excluded from Tabla) but untidy.

### FYI
- FYI: **supabase/migrations/0022_access_requests.sql:82-83** — `request_access` is a
  membership-enumeration oracle (`'member'` vs `'pending'/'rejected'`) callable by
  anon. Documented-accepted in the migration header for the private-league threat
  model; noted for the security pass.
- FYI: **supabase/migrations/0022_access_requests.sql:131-154** — `approve_request`
  has no current-status guard, so approving a *rejected* request would create the
  player + flip to approved. Unreachable via the UI (Solicitudes only lists pending),
  so this reads as an intended admin override, not a bug.

## Verification notes (what checked out)
- **Scoring v2 engine (0019) is EXACT.** Cross-checked the canonical fixtures against
  the SQL: 20p 1st=140 / 5th=100 / 11th=60; 10p 1st=90 / 4th=60; no-show=−15. Chop
  averages, graduated top-4 `top_finish_bonuses ->> (pos-1)` (1..4, 5th+→0), cancel
  bands, and the seed's hardcoded points (90/80/70/60/50/35/30/25/20/15/−15) all
  reconcile. Integration + FE-preview tests assert real numbers, not shapes.
- **FE preview == engine (no drift).** `admin.ts pointValueForPosition` /
  `fechas.ts pointsExample` mirror the SQL under the finalist assumptions
  (paid + made_final_table). `admin.test.ts`, `fechas.test.ts`, `admin.integration`
  were all updated to the v2 numbers and cover the P=4/P=5 top-4 boundary.
- **Guest exclusion (0021) is behavior-identical to 0018 except one line.** Diffed the
  two function bodies: the *only* delta is `where not p.is_guest`. Per-player aggregates
  never mix players, so roster-at-0, form/form_positions, ordering, tiebreaks are
  preserved; the integration test proves a guest who WON is dropped while a real
  finisher stays.
- **DEFINER RPC idiom honored.** `delete_tournament` / `add_guest_entry` /
  `approve_request` / `reject_request` are all `security definer`, pinned search_path,
  and admin-gated on `auth_is_admin() OR service_role` — matching the 0012 shape.
  `delete_tournament` is FK-safe (explicit gallery→entry→tournament, both cascades).
- **signup_request RLS.** Anon table grant revoked + RLS admin-only SELECT/UPDATE, no
  INSERT/DELETE policy (default-deny); anon writes only via the DEFINER `request_access`.
  Table privileges rely on Supabase's default-privileges-to-authenticated bootstrap
  (same posture as every other table in this schema) — consistent, not a regression.
- **request_access contract** returns member/pending/rejected, normalizes lower/trim,
  never re-opens a rejected email; `approve_request` is idempotent (skips create if the
  player exists, re-stamps approved). Tests cover all three outcomes + the admin gate.
- **Performance:** no N+1. Solicitudes = one `select().eq('status','pending').order()`;
  Jugadores = one RPC; RequestsPanel maps a bounded list. `request_access` does a
  seq-scan on `player` (no index on `lower(email)`) — negligible at league scale.

## Axes checked
correctness ✗ (R1 cancel-live, R2 rescore, R4 delete-completed) · readability ✓ ·
architecture ✓ · security ✗ (R3 anon spam + enumeration oracle; touches-sensitive: YES —
first-login auth gate, anon-callable request_access, 4 new DEFINER RPCs, signup_request
RLS) · performance ✓
