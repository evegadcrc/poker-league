# Review iter 1 — poker-league-phase2 (Track B)
Diff: 84b4222...191b670, 34 files, +4220/-5
Verdict: FINDINGS (no Critical; 1 required, 6 optional, 1 nit, 3 FYI)

Gates run green locally: `npm run lint` (only pre-existing test-mock `no-thenable`
warnings, incl. one new in Galeria.test.tsx — matches established pattern) ·
`npm run build` (tsc + vite; worker code-split to its own `equity.worker-*.js`
chunk, confirming MC is off the main thread) · Track-B unit + RTL suites 79
passed (poker 43, RTL 36). Integration suite is env-gated (skips locally).

The flaky-test lesson is actively HONORED, not re-introduced: MC RNG is seeded
(`equity.ts:40,195`; fixtures inject `mulberry32(seed)`), enumeration path is
seed-independent, gallery integration test isolates on a throwaway 2097 season
with teardown, and `vite.config.ts:92` sets `fileParallelism:false` (serial).

## Findings

### Correctness
- **[required]** `src/lib/notify.ts:99-100` — the elimination cue's
  winner/co-champion EXCLUSION is never tested. `out` is built only from
  `status==='eliminated'` (winners/choppers get `status='winner'`, correctly
  excluded), but no test exercises a `playing → winner` transition asserting NO
  `elimination` cue fires. `EntryStatus` is an enum and this is an explicit
  contract point (comment at notify.ts:50-52 + the task brief). This app auto-
  promotes the last player to 1st (`winner`), so the transition is real; a future
  refactor that folded `winner` into `out` would fire a wrong "quedó fuera" for
  the champion with no test to catch it. Add a case to Live.notify.test.tsx (a
  player goes `playing→winner` → assert `elimination` count unchanged).
- **Optional:** `src/routes/Calculadora.tsx:105` calls
  `evaluate7([...holeCards, ...boardCards])` with 5 cards (flop) and 6 cards
  (turn) for the "Tu mejor mano" readout, but every evaluator test
  (`evaluator.test.ts`) passes exactly 7 cards. The 5-/6-card paths are shipped +
  user-visible yet untested. Logic looks correct (no 7-card assumption), but add
  a 5-card and 6-card case.
- **Optional / FYI:** `src/lib/poker/equity.test.ts:26-36` — the AKs-vs-22 test's
  `Math.abs(res.win - res.lose) < 0.02` ("essentially even") is tighter than the
  true equity gap (the pair is marginally favored even vs suited AK) and rides on
  the specific seed's 50k-sample landing in-window. Deterministic today (not
  flaky), but brittle to any seed/iteration change. Consider asserting direction
  (as the AKo test does) or widening the tolerance.

### Security  (touches-sensitive: YES)
- **Optional (route to security lens):** `supabase/migrations/0016_gallery.sql:76-87`
  — the `gallery` bucket is PUBLIC (`public=true`) with `select to public`, so
  photo AND cover image *bytes* are world-readable to anyone holding the URL, not
  just league members. Plan step-14's "SELECT for league members" holds only at
  the `gallery_photo` ROW layer (path enumeration); the objects themselves are
  not member-gated. Mitigated by unguessable UUID paths and it mirrors the
  sanctioned `avatars` bucket (0011, also public) — acceptable, but the deviation
  from the plan's read-gating language should be an explicit, owned decision.
- **Optional:** `supabase/migrations/0016_gallery.sql:76-78` — no
  `file_size_limit` / `allowed_mime_types` on the `gallery` bucket. Any league
  member can upload arbitrary files of any size. Avatars (0011) has the same gap,
  but avatars is self-owned single-photo; gallery lets *every* member upload
  unbounded objects into a public bucket (storage-abuse + content-type surface).
  Add size + image-MIME limits.
- **FYI:** the storage-OBJECT RLS policies (`0016_gallery.sql:85-115`,
  owner-folder insert/update/delete) are NOT covered by
  `src/lib/gallery.integration.test.ts` — that suite exercises only the
  `gallery_photo` TABLE RLS. The owner-folder object gate is unverified by tests.
- **FYI:** `0016_gallery.sql:60-62` gallery_photo INSERT `with check` verifies
  only `uploader_id = self` — not that `storage_path` sits under the uploader's
  folder, nor that `tournament_id` is one they may post to (single-league makes
  this low-impact). Also: deleting a gallery_photo row does not delete the
  storage object → orphaned public bytes remain.
- **FYI:** `cover_url` write path is admin-gated correctly — `FechaDetail.tsx:597`
  `.update({cover_url})` runs under the 0001:215 "admin update tournament" policy
  (`auth_is_admin() OR created_by = self`); only admins create fechas, so this is
  effectively admin-only. The `url(${coverUrl})` inline background
  (`Fechas.tsx`, `FechaDetail.tsx:630`) is admin-controlled and set via the React
  style object (CSSOM can't break out into new declarations) → no injection.
  Notification API (`notify.ts:139`) passes admin `tournament.name` as the text
  `title`/`body` — rendered as text by the API, not HTML; player names go only to
  the React toast (escaped). No untrusted-text injection.

### Readability / Architecture  (clean)
- **Nit:** Spanish hand-name inconsistency across the two label sources:
  `Calculadora.tsx:32-42` (HAND_NAMES_ES) uses `Par` / `Doble par` /
  `Escalera de color`, while `HandRankings.tsx:44-80` uses `Pareja` /
  `Doble Pareja` / `Escalera de Color`. On the *same* Calculadora page the
  made-hand readout ("Doble par") disagrees with the rankings reference
  ("Doble Pareja"). Extract one shared name map.
- FYI (positive): `deriveLiveSignal` extraction (191b670) is used by both
  `Live.tsx:198` and `Admin.tsx:355`; behavior preserved (Live.notify + notify
  suites green). Worker math stays pure in `src/lib/poker/*`; the UI mocks
  `@/lib/equityWorker` (Calculadora.test.tsx) and never spins a real Worker.
  Routes/nav follow the existing AppLayout/App pattern.

### Performance  (clean)
- **FYI / Optional:** `Fechas.tsx` history cover cards load their images eagerly
  via CSS `background-image` (no lazy), unlike the gallery grid which uses
  `<img loading="lazy">` (Galeria.tsx:150). History is small (tens of fechas) so
  acceptable per spec's pagination note, but covers aren't lazy like the grid.
- FYI (positive): MC (default 50k iters) runs in the code-split worker (build
  output confirms); Calculadora debounces requests 250ms + fixed seed
  (`EQUITY_SEED`) → deterministic, no per-render flicker; enumeration bounded to
  ≤2 unknown board cards with fixed opps (UI always uses the MC/random path).
  Partial Fisher-Yates draw is uniform-without-replacement and correct.

## Axes checked
correctness ✓ · readability ✓ · architecture ✓ · security ✓ (touches-sensitive: yes — public storage bucket, gallery_photo RLS, member file upload, Notification API, admin-gated cover write) · performance ✓
