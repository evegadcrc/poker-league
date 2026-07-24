---
task: poker-league-prototype
status: approved        # draft → approved → consumed-by-plan → superseded
ui_first: true
created: 2026-07-23T17:50:44Z
---

# Spec — poker-league-prototype

The behavior contract for this task. Written at the end of `/dh:grill`. Read by
`/dh:plan` (to ground the plan), `/dh:review-plan` (to detect plan-spec drift),
and `/dh:design` (for the UI brief in --ui-first mode).

## Problem

A friends' Texas Hold'em league in Costa Rica needs a mobile-first app to run its year-long
season: schedule game nights in advance, let players RSVP, verify who actually shows up
(geofenced check-in) with an early-bird reward, run a live tournament clock, track
eliminations, and keep a season leaderboard with a sports-style form guide. Today this is
tracked ad-hoc; the league wants a single beautiful, self-serve app where every player logs
in on their own phone and the admin can adjust anything with minimal friction. This task
produces the **approved UI prototype** for Phase 1; the backend contract is derived from it.

## Behavior (in-scope)

**Identity & language**
- Spanish-only UI (MVP). Domain terms Spanish (Voy / No voy / Mesa Final / Puntos / Asistencia).
- Costa Rica locale/timezone (America/Costa_Rica, UTC−6, no DST). Times shown local.
- Brand identity created from scratch: wordmark + palette + simple mark.
- **Sports Almanac** aesthetic (paper/ink + oxblood accent, big grotesk display, tabular
  figures, league-table/almanac feel). **Light + dark both first-class**, toggle in header.
  Must NOT read as generic default UI.

**Auth & roles**
- Passwordless **magic-link** login (email). First login captures display name + optional avatar.
- Two roles: **Admin** (tournament owner, full control + override anything) and **Player**
  (self-serve their own actions, read-only on clock/standings).

**Season model**
- One **active Season** at a time (e.g. "Liga 2026"), its own leaderboard from zero.
- Players are permanent across Seasons. Admin **closes** a Season (→ read-only history) and
  **opens** the next year's; roster carries over, points reset. Past Seasons viewable.

**Tournament scheduling & RSVP (pre-game)**
- Admin creates a Tournament in advance (name, date/time, venue+geofence, buy-in, rebuy amount,
  starting stack, blind structure).
- Players see upcoming Tournaments and self-serve **Confirm ("Voy") / Unconfirm** and
  **Decline ("No voy")**. Reversible until the admin opens the Tournament.
- The Tournament card/detail shows the **attendance list** grouped by status (Confirmed /
  Declined / No response) with counts.

**Check-in (game day, geofenced)**
- Admin opens the Tournament (Upcoming → Live). Confirmed players may **Check-in**.
- Check-in requires the device to be within the venue **geofence** (pin + ~100m radius).
  If GPS fails, the **admin can manually check a player in**.
- Checking in **before scheduled start** → **early-bird bonus chips** (flat, configurable,
  default +2,000) added to that player's starting stack. On/after start → checked in, no bonus.
- A Confirmed player who never checks in → **No-show** → **season point penalty** (configurable,
  default −10). Declined and silent-non-responders are NOT penalized.

**Buy-in & play**
- Checked-in player hands over the buy-in physically; **admin confirms payment** → status
  becomes **Playing**. (Admin can also toggle paid / add rebuys.)
- **Rebuys**: during the rebuy period (first N levels, admin-set) a rebuy **reactivates an
  eliminated player (re-entry only)**. NOT allowed while a player is Playing (no topping up a
  live stack). After the period, eliminations are final.

**Live tournament view (player-facing, read-only, realtime)**
- Big countdown timer for the current blind level; current blinds (SB/BB/ante) + "Next:"
  preview; level number + break indicator; pot (auto-computed, admin override allowed);
  players-remaining; live standings as people bust.

**Live clock (admin)**
- Timer defaults to **auto-advance** at 0; per-tournament option to require **admin tap**.
  Admin always has play/pause, ±1 min, next/prev level, reset level, on-the-fly blind edits.

**Elimination & completion**
- **Self-report bust**: a player taps "Estoy fuera" → confirm → elimination takes effect
  live with their finishing place (total−1 flow, §7). Admin can reorder/undo/adjust anytime.
  Confirm dialog + "Undo last elimination".
- When one player remains → auto 1st place + "Complete tournament" prompt. Completion locks
  results, computes points, sets status Completed.

**Leaderboard & profiles**
- Season leaderboard: rank, avatar+name, total points, games played, wins, podiums, and the
  **last-5 form guide** (Champion=gold / Podium=green / Final table=blue / Out=gray pills).
- Tap a player → profile: point history, best finishes, full form.

**Points**
- `Puntos = (N − P) × multiplier + BonusMesaFinal + BonusTop3 + BonusAsistencia`, minus any
  No-show penalty. BonusMesaFinal and BonusTop3 are **two separate bonuses** (both can apply).
  Exact default values are admin-config (see Open questions).

## States the system must handle

Per-player lifecycle status (shown as distinct, well-designed pills/badges everywhere the
player list appears): **Invited · Confirmed · Declined · Checked-in (± early-bird) · No-show ·
Playing · Eliminated (Nº) · Winner**.

- **Loading** — data fetch / realtime reconnect → skeleton rows for lists, timer shows last
  known value while reconnecting (never blank).
- **Empty** — no upcoming tournaments → friendly empty state + (admin) "Create tournament";
  new season with no games → leaderboard shows roster at 0 pts; no players → prompt to invite.
- **Error** — magic-link failure → resend affordance; geofence check-in denied/out-of-range →
  clear message + "Ask admin to check me in"; realtime drop → subtle "reconnecting" indicator;
  payment/eliminate action fails → toast + safe retry (no double-apply).
- **Success** — confirm/check-in/pay/eliminate each give friendly immediate feedback (early-bird
  bonus surfaces a celebratory "+2,000 fichas" moment).
- **Edge** —
  - Walk-in who never confirmed: admin can add them and check them in; no penalty applies to
    them (penalty only hits Confirmed-no-check-in).
  - Unconfirm attempt after the tournament is opened → blocked (RSVP locked at open).
  - Two near-simultaneous self-report busts → optimistic placement; admin resolves order.
  - Rebuy of an eliminated player during the period → reactivates them into standings.
  - GPS unavailable → admin manual check-in path.
  - Player joins live view mid-level → timer computes correct remaining locally.

## Inputs / shapes

UI-first: concrete API/table shapes are **derived in /dh:design** into the backend contract.
Grounding entities (from CONTEXT.md): Player, League/Season (config: multiplier, bonuses,
penalty, final_table_size, early-bird bonus chips), Tournament (venue lat/lng + radius,
scheduled_at, buy_in, rebuy_amount, starting_stack, blind structure, clock state, rebuy period,
timer mode), Entry (per-player status, paid, rebuys, check-in time+geo, final_position, points),
BlindStructure/BlindLevel, GalleryPhoto (Phase 2), LearningContent (Phase 2).

## Phase 2 features (deferred — NOT in the current Phase 1 build)

- Memorable-hands gallery; tournament-history full-bleed cover cards; learning section.
- **Odds / hand calculator** (added 2026-07-23). A menu where a player inputs the cards in play and
  gets the odds of their hand (win / tie equity). Requirements:
  - **Friendly card entry is the point:** a visual card picker (52-card grid or rank×suit selector
    with the four suit glyphs ♠♥♦♣ colored), clear slots for **Tu mano** (2 hole cards), **Mesa**
    (flop 3 / turn / river), and **# de rivales** (or specific opponent hands). Tap to fill a slot,
    tap again to clear; used/duplicate cards disabled; live "cartas restantes" count.
  - **Output:** win % / tie % (equity), and outs / hand-improvement odds where meaningful.
  - **Client-side compute** — Monte-Carlo simulation (or enumeration) in the browser; NO backend,
    no Supabase. Fits alongside the learning section.
  - Styled in the same Sports-Almanac + Neón system; Spanish copy.
  - **Poker hand-rankings reference** on the calculator page (Royal Flush → High Card, best→worst),
    rendered as **native themed UI** (card + suit glyphs, Spanish labels) — NOT a raster image, so it
    stays crisp and theme-aware in all 3 themes. (User provided a PokerStars-style reference for layout.)
  - *Detailed UX + the calc engine get their own `/dh:grill --ui-first` → `/dh:design` pass when
    Phase 2 starts; this entry just captures scope + intent.*

- **Sound & notifications** (added 2026-07-23). Audio cues + alerts on key moments:
  - **Timer sounds:** a warning in the final seconds of a blind level and a chime on level change.
  - **Action sounds/alerts:** tournament **start**, tournament **opened** (check-in available), and a
    player **going out** (elimination — "X quedó fuera").
  - **Notifications:** in-app toasts always; optional local/push notifications via the PWA so alerts
    reach players whose screen is off (esp. "opened" and level changes).
  - **User-controllable:** mute + volume toggle; sounds pre-loaded; respect device silent mode.
  - **Triggers off state changes**, consistent with the state-based timer (§8) — fire on level
    advance / open / elimination events, never per tick.
  - *Gets its own design/build pass when Phase 2 starts; this entry captures scope + intent.*

## Out of scope (Phase 1 prototype)

- Everything in "Phase 2 features" above (gallery, history covers, learning, odds calculator, sound
  & notifications).
- PWA offline, push notifications, i18n toggle/English (Phase 3).
- Real Supabase wiring beyond what the prototype needs — the prototype uses mock/seed data;
  live backend is built in /dh:plan → /dh:build.
- Season tiebreaker exact algorithm beyond a sensible default (see Open questions).
- Payment processing (buy-ins are cash; app only records admin confirmation).

## Open questions
- Exact points config defaults — multiplier (10?), BonusMesaFinal, BonusTop3, BonusAsistencia
  values, No-show penalty (−10?), final_table_size (8?). — *defer to:* plan (admin-configurable)
- Rebuy period length (through which level?) and early-bird bonus amount default (+2,000?).
  — *defer to:* plan (admin-configurable)
- Season tiebreaker order (points → wins → podiums → most-recent?). — *defer to:* plan
- Geofence radius default (100m?) and whether check-in also records a timestamp for disputes.
  — *defer to:* plan
- Dark-mode palette derivation for the Sports Almanac direction (inverted paper/ink). —
  *defer to:* design

## Revisions — iter 2 (post-prototype review, look approved)

1. **Avatars = photos.** Players can upload a profile photo (Supabase Storage); initials are the
   fallback when no photo. Upload/change from the profile screen.
2. **Prize pool distribution ("Premios").** The pot is split into payouts by finishing position
   (1º/2º/3º…). Amounts can be **defined/adjusted late in the tournament** once the total pot is
   known. Shown in the live view (and admin-editable). *Full points+prize distribution rules are
   an open discussion — placeholder only (see Open questions).*
3. **Themes = 3 choices, user-selectable.** Almanaque claro (light), Almanaque oscuro (dark), and
   **Neón** (Vegas nightlife: bg #14101F, magenta #FF2E88 + cyan #22D3EE, glass+blur panels, glow,
   bold uppercase grotesk). Persist the choice.
4. **Form-guide recolor.** Tier palette moves to editorial monochrome+oxblood to match the almanac:
   Campeón = oxblood ●, Podio = ink/near-black ●, Mesa Final = warm gray ◆, Fuera = light gray ▬.
   A legend (with those symbols/colors) appears on the leaderboard.
5. **Ante optional.** Most nights have no ante. Ante is an optional field per blind level; the live
   view hides it when absent.
6. **Show chips added.** The early-bird bonus (+chips) and each player's chips in play are visible
   (live view total + admin per-player), so it's clear how many chips were added.
7. **Admin can mark a no-show / "won't attend"** for a player (pre-game or game-day), setting the
   status directly without waiting for the check-in window to lapse.
8. **Late-cancel penalty (graduated by time-to-start).** A Confirmed player may cancel; penalty:
   > 24h = 0 · 24–12h = −5 · 12–6h = −10 · < 6h = −15. **Ghosting (confirmed, never cancelled, no
   check-in) = −15 (max)** so honest early cancellation is never punished worse than ghosting.
   Cancelling shows the current penalty before confirming. *(Band boundaries admin-configurable;
   confirm exact bands in plan.)*
9. **Rebuy = re-entry only** (see updated Rebuys above): NOT allowed while Playing.
10. **Admin CRUD screens added.** Create Fecha (name, date/time, venue+geofence, buy-in, rebuy
    amount + period, starting stack, blind structure, ante on/off). League/Season settings (name,
    year, points multiplier, bonuses, no-show + late-cancel penalties, final-table size, early-bird
    chip bonus) and **close season → open next year** (roster carries, points reset).
11. **WhatsApp summary (nice-to-have).** Stage 1 = admin-only copy-paste message template
    (leaderboard / fecha result) with a Copy button. Native share/send is a later stage.

## Open questions (added iter 2)
- **Points & prize distribution rules** — how the pot splits by position, and any interaction with
  points. Explicit discussion pending; placeholder UI only for now. — *defer to:* discussion, then plan
- Late-cancel penalty exact band boundaries + whether they're league-configurable. — *defer to:* plan
- Whether "won't attend" (admin-marked) incurs the no-show penalty or is treated as an excused
  absence. — *defer to:* plan

## Revisions — iter 3 (planning decisions, 2026-07-23)

- **Prizes = % template, rounded, editable.** Season holds a payout template (e.g. 60/28/12);
  app computes payouts from the live pot and rounds to clean amounts (nearest ₡1.000), admin can
  override late. Points and prizes are separate systems.
- **Chop / split.** Admin can end with the final K players splitting: money = summed payouts for
  those positions ÷ K (rounded, adjustable); points = summed §5 point-values ÷ K (equal); all
  choppers are **co-champions** (each gets título/win + gold form pill).
- **"Won't attend" is per-case:** admin picks Excusado (0) or Penalizar (−15) when marking.
- **Mesa final is dynamic (two-tier):** 5 when ≤10 checked in, else 10 (overridable).
- **Config defaults locked** (all editable): ×10 · MF +5 · Top3 +8 · Asist +2 · no-show/ghost −15 ·
  cancel 0/−5/−10/−15 · early-bird +2.000 · recompra ≤ nivel 6 · geocerca 100 m.
- **Tiebreakers:** points → wins → podiums → most-recent finish.

*Note: the chop/split flow was NOT in the approved prototype — its admin UI is a small addition
built during implementation (see plan Risks).*

## Common-gaps checklist (filled by /dh:grill)
- [x] Loading / empty / error / success states defined — see States section.
- [x] Rate limiting / quotas / pagination considered — N/A: friends' league (tens of players,
      handful of tournaments/season); lists are small. Gallery (Phase 2) will lazy-load images.
- [x] Auth / authz: magic-link login; Admin vs Player roles; RLS sketch (§9) derived in plan.
- [x] Caching strategy explicit — no app-level cache; Supabase Realtime is the source of truth;
      timer state stored, clients compute display locally (never broadcast every tick).
- [x] Props/API shape — deferred to /dh:design (UI-first derives the backend contract); grounding
      entities listed in Inputs / shapes.
- [x] Accessibility — keyboard + screen-reader labels for actions; oxblood-on-paper and dark
      palette must meet WCAG AA contrast (validate during design); tap targets ≥44px.
- [x] i18n / timezone / locale — Spanish only (MVP), Costa Rica timezone, local time display.
- [x] Mobile / responsive — mobile-first PWA (phone primary). Admin console must be fully usable
      on a phone; scale up gracefully to tablet/desktop.
