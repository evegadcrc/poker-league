# Review iter 1 — poker-league-prototype (FE core: auth + stateful frontend)
Diff: dcaa727..HEAD (ac2e1e8), 95 files, +24774/-25 (review scope = auth + Admin/Live/FechaDetail + libs + their tests)
Verdict: FINDINGS

Scope reviewed: `src/lib/auth.tsx`, `src/components/guards.tsx`, `src/lib/supabase.ts`,
`src/lib/useLoadable.ts`, `src/lib/{fechas,admin,checkin,summary,live}.ts`,
`src/routes/{Admin,Live,FechaDetail}.tsx`, and co-located tests.
SQL/RLS, other screens, CreateFecha/LeagueSettings = out of scope (other reviewers).

## Findings

### Critical / security question (cannot confirm in FE scope — route to SQL/security pass)
- SECURITY QUESTION: `src/lib/auth.tsx:158-161` `useRole()` derives `isAdmin` from
  `player.is_admin`, a column on the `player` row returned by `claim_player`. Plan step 2 says
  "player may insert/update/delete only their **own** player row/avatar." If the player-UPDATE
  RLS policy on `public.player` does **not** column-restrict `is_admin`, any player can
  `update player set is_admin=true where id=<own>` and self-promote. The server admin RPCs also
  gate on `is_admin OR created_by=auth.uid()` (be-contract:139-141), so a self-promoted row would
  pass the *server* guard too — i.e. this is not merely a hidden-UI bypass, it's real privilege
  escalation. The FE code is correct (it never trusts client-supplied role — see security notes
  below); the risk lives entirely in the RLS column grant, which I can't see from these files.
  **Action: the SQL/RLS reviewer must confirm `is_admin` (and `auth_user_id`) are NOT
  self-writable in the player-owns-own-row UPDATE policy.** Treat as Critical until confirmed.

### Required
- `src/routes/Live.tsx:196-215` (`doSelfBust`) — on RPC failure the optimistic
  `setReportedPosition(optimisticPos)` (line 209, set *before* the await) is never reset, and the
  error path (line 213) only `console.error`s. Result of a failed `self_bust`: the player sees the
  permanent "Reportado: Nº lugar" note (line 304-306), the "Estoy fuera" button is gone, they
  **cannot retry**, and they get **no toast** — yet the DB still has them `playing`. Directly
  violates spec/ be-contract "RPC failure → toast + safe retry (no double-apply)". Fix: only set
  `reportedPosition` after a successful RPC; on error clear it and surface a toast so the player
  can re-report.
- `src/lib/useLoadable.ts:33` + `src/routes/FechaDetail.tsx:122-126,136-222` — the hook calls
  `setState(loading)` on *every* effect run, including `reload()` (attempt bump). So after every
  optimistic `patchMine` + `reload()` (RSVP / cancel / check-in), the screen flips to
  `phase:'loading'`, hits FechaDetail's early-return skeleton (line 234-241), and shows
  "Cargando fecha…" for a full two-round-trip refetch — wiping the optimistic patch and (for
  check-in) unmounting the "+2.000 fichas" celebration until the reload lands. This is exactly the
  flicker the design set out to avoid ("optimistic updates reconciling with realtime refetch
  **without flicker**"). Note Live.tsx/Admin.tsx sidestep this by using a hand-rolled loader that
  keeps prev on reload (`setState(prev => …)`), which is why they *didn't* adopt useLoadable — the
  asymmetry is the smell. Fix: don't reset to `loading` on a `reload()`/attempt bump when data is
  already present; only reset on first mount or a real `deps` change (or expose a "soft reload").
- `src/routes/Admin.tsx:271-290,306-316` (auto-advance) — the once-per-level guard
  `autoAdvancedLevel.current` is set to `current_level` *before* the RPC (line 314). On a transient
  `clock` failure `doClock` toasts and `load()`s back to server truth, which is still level N with
  `remaining===0`, so the guard (`ref.current === current_level`) stays satisfied and auto-advance
  **never retries** — the live clock sits at 00:00 until an admin manually taps "Nivel ▶". This is
  the documented Kong-502 transient-failure class (lessons.md "Slice 4"). Fix: reset
  `autoAdvancedLevel.current = null` on `clock` failure so the next tick re-fires.
- TEST GAP `src/routes/Admin.test.tsx:73` — the suite forces `timer_mode:'manual'` explicitly "to
  avoid auto-advance firing," so the auto-advance FE contract (plan step 12: single-writer, fire
  `next_level` exactly once at 0, don't fire while paused, re-arm after the level changes) has **no
  FE test at all**. `admin.integration.test.ts:384-398` only exercises the SQL `clock` RPC bounds,
  not the React effect. A multi-branch contract with only the manual branch (implicitly) covered →
  parameterize an RTL test over auto+paused / auto+expired / manual, asserting the once-per-level
  fire and the paused no-fire.
- TEST GAP `src/routes/Live.test.tsx:273-290` — self-report bust is tested only on the success path
  (`rpcResult.error=null`). The failure branch — the one carrying the reportedPosition bug above —
  is unexercised. Add a case with `self_bust` erroring and assert the button remains / a retry is
  possible / feedback is shown.
- `src/lib/fechas.test.ts:73-78` — `statusPill` is a full-enum contract (`Record<EntryStatus,…>`,
  8 states) but the test asserts only 4 (confirmed, declined, invited, winner). `checked_in`,
  `playing`, `no_show`, `eliminated` labels/classes are unverified (TS guarantees the keys exist,
  not their values). Per the "tests pin the contract" rule, table-test all 8.

### Optional / Consider
- `src/routes/FechaDetail.tsx:170-190` — `doRsvp` and `doCancel` swallow RPC failure (doCancel:
  `console.error`; doRsvp: nothing) and just `reload()`. Unlike the check-in path they show the
  user no toast/feedback, contradicting spec "confirm/check-in/pay/eliminate give immediate
  feedback" + "RPC failure → toast". Consider a shared toast like the Admin console's.
- `src/routes/Live.tsx:209,304-306` — `reportedPosition` displays the *optimistic* placement
  permanently; it's never updated to the server-reconciled `myEntry.final_position` after reload,
  so if the server assigns a different position the note stays stale (mitigated by the "el admin
  puede ajustar" copy). Consider deriving the note from reloaded entry state.
- `src/lib/auth.tsx:86-116` — a `bindError:'other'` (claim_player RPC failure, e.g. Kong-502)
  sets `boundUserId.current = userId` first (line 89), so the bind never retries; the user is
  bounced to /login (guards: `!player`) with no in-app retry until a full reload / re-auth.
  Consider resetting the ref on the error branch so a subsequent render/session refresh re-binds.
- `src/lib/auth.tsx` (whole file) — `AuthProvider` has no component-level test. The StrictMode
  double-invoke guard (`boundUserId` ref), the sign-out reset (onAuthStateChange → clear), and the
  bind dedup are core stateful auth logic; `claim_player.test.ts` only covers the SQL RPC. Add an
  RTL test for the provider state machine.
- `src/routes/Live.tsx:125-128`, `src/routes/Admin.tsx:226-228` — the 1s `setNow` interval runs
  even while paused, forcing a whole-tree re-render every second for an unchanged clock. Cheap at
  this scale, but could pause the interval when `is_paused`.

### Nit
- `src/routes/FechaDetail.tsx:176-177` — `if (error) reload(); else reload();` both branches call
  `reload()` — dead branching; collapse to one call (and add the missing error toast, above).
- `src/routes/Admin.tsx:437` — `isInPlay(e.status) && e.status !== 'winner'` for the "En juego"
  count re-excludes what `isInPlay` includes; a dedicated predicate would read clearer.
- `src/lib/fechas.ts:195-202` — `bandLabel` uses `sorted[sorted.length - 2]?.hours_before ?? 6`,
  a magic index+fallback that's hard to follow; document or restructure.

### FYI
- `src/routes/Live.tsx` and `src/routes/Admin.tsx` duplicate the realtime + 1s-clock +
  keep-prev-on-error load mechanic. lessons.md ("Simplify pass") records this as a *deliberate*
  skip (2 sites, below the 3-site bar, intertwined with screen-specific logic). Not a finding —
  noting it because the useLoadable asymmetry above is the flip side of that decision.
- Every realtime event triggers a full 4-part refetch (tournament + levels + entries + fn_pot).
  Fine for a friends' league (spec: tens of players); not an N+1 concern.

## Security notes (FE, inline pass)
- Enforcement model is correct on the client side: every mutating RPC takes only ids
  (`p_tournament_id` / `p_entry_id`) and never a caller-supplied `player_id`/role — `rsvp`,
  `cancel_rsvp`, `check_in`, `self_bust`, `eliminate`, `confirm_payment`, `add_rebuy`,
  `mark_no_show`, `clock`, `complete_tournament`, `claim_player`. Server derives identity from
  `auth.uid()`. Guards (`guards.tsx`) only hide UI. Good — no mutation trusts client identity.
- Magic-link: `signInWithOtp` uses `emailRedirectTo: ${window.location.origin}/` (fixed origin,
  no open-redirect). Anon/publishable key only (`supabase.ts`); throws if env missing; no secrets
  in these files. No `dangerouslySetInnerHTML`; summary text rendered in a readOnly `<textarea>`.
- **Touches-sensitive: YES** — auth/session (`auth.tsx`), role gating (`useRole`/guards),
  magic-link handling, first-login `claim_player` binding. Route to the security pass, primarily
  for the `is_admin` RLS column-write question above.

## Axes checked
correctness ✗ (self-bust error, auto-advance stall, useLoadable flicker) ·
readability ✗ (nits) · architecture ✗ (useLoadable vs hand-rolled loader asymmetry) ·
security ✓ within FE / touches-sensitive: YES (auth, role, magic-link, claim_player) ·
performance ✓ (small-scale; no N+1/pagination concern)
