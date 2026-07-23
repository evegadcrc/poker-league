# Poker League

Glossary for a friends' Texas Hold'em league app (Costa Rica). Tracks points across a
season of game nights, runs a live tournament clock, and keeps a season leaderboard.
This file is the shared language only — no implementation details.

## Language

### League & schedule

**League** (a.k.a. **Season**):
One year-long competition (e.g., "Liga 2026") that a set of players compete in across many
game nights. Holds the points/bonus/penalty configuration. Each Season has its own
leaderboard starting from zero. Only **one Season is active at a time**.
_Avoid_: tournament, game, championship.

**Season rollover**:
Closing the active Season makes it read-only history and opens the next year's Season. The
**Player** roster carries over (Players are permanent, not per-Season); points reset to zero.

**Rebuy period**:
The early window (first N levels, admin-set) during which a **Rebuy** may reactivate an
eliminated Player or top up a live one. After it closes, eliminations are final.

**Tournament** (a.k.a. **Fecha**, game night):
A single game-night event inside a League. Has a venue, a scheduled start time, a blind
structure, and a live clock.
_Avoid_: game, match, session.

**Player**:
A member of the League. Logs in on their own phone (magic-link email auth) and sees their
own stats. A Player with admin rights is the **Admin** (tournament owner: full control).
_Avoid_: user, account, member.

### Participation lifecycle

**Entry**:
One Player's participation record for one Tournament (one row per player per game night).
Carries that player's lifecycle **status**, payment, rebuys, check-in, and finish.
_Avoid_: registration, signup, ticket.

**Confirm / RSVP** ("Voy"):
A Player stating in advance they intend to attend a Tournament. Reversible ("Unconfirm").
_Avoid_: register, join, sign up.

**Decline** ("No voy"):
A Player stating in advance they will NOT attend. A polite RSVP — exempt from the no-show
penalty.

**Check-in**:
Game-day verification that a Confirmed Player has physically arrived, validated against the
Tournament's **geofence**. Checking in **before start time** earns **bonus chips**.
_Avoid_: arrival, sign-in, register.

**Geofence**:
The venue location (point + radius) a Player's device must be within for Check-in to be
valid. Admin can manually check a player in if GPS fails.

**Buy-in**:
The physical payment a Player makes to enter. **Payment confirmation** is the Admin marking
that buy-in as received, which moves the Player to **Playing**.
_Avoid_: pay, deposit.

**Rebuy**:
A buy-in that **reactivates an eliminated Player** during the rebuy period (re-entry only).
NOT allowed while a Player is **Playing** — there is no topping up a live stack. Tracked as a
count on the Entry.

**Premios** (prize distribution):
How the pot is split into payouts by finishing position (1º/2º/3º…). Amounts may be defined or
adjusted late in a Tournament once the total pot is known. Distinct from **Puntos** (season
points). _Full distribution rules are an open discussion._

**Late-cancel penalty**:
A season point penalty for a **Confirmed** Player who later cancels, graduated by how close to
start time they cancel (none > 24h, escalating to a maximum by 6h). Ghosting (confirmed, never
cancelled, no check-in) draws the maximum. Distinct from — but reconciled with — the No-show rule.

**Avatar**:
A Player's profile photo (uploaded to storage); initials are the fallback when absent.

### Player status (per Tournament) — the lifecycle states

**Invited**: default; Tournament created, Player has not responded.
**Confirmed**: RSVP'd yes.
**Declined**: RSVP'd no (penalty-exempt).
**Checked-in**: geo-verified arrival on game day (may carry the early-bird bonus).
**No-show**: a **Confirmed** Player who did NOT check in → season point **penalty**.
**Playing** (In play): buy-in confirmed by Admin; alive in the tournament.
**Eliminated**: busted; holds a **final position** (Nº place).
**Winner**: last player standing (final position 1).

_Flagged ambiguity (resolved):_ "No-show" in this domain means **Confirmed-but-not-checked-in
only** — NOT a player who never responded. Silent non-responders and Declined players are not
penalized by the no-show rule.

### Scoring

**Puntos** (points): season currency. `Puntos = (N − P) × multiplier + bonuses`, where N =
players in the tournament, P = finishing position.
**Mesa Final** (final table): the last K remaining players; carries **BonusMesaFinal**. K is
dynamic by turnout: 5 when ≤10 players checked in, else 10 (overridable per Season).

**Chop** (split / deal): the final K Players agree to end the Tournament and split. The pot's
summed payouts for positions 1..K are divided equally (money) and the summed **Puntos** for those
positions are divided equally (points). All choppers are recorded as **co-champions**.
_Avoid_: deal, tie, draw.
**Top 3** (podium): finishing 1st–3rd; carries **BonusTop3**.
**Asistencia** (attendance bonus): **BonusAsistencia** for players who showed and paid.
**Penalty**: negative season points for a No-show (Confirmed-but-not-checked-in).
**Bonus chips**: extra starting stack for checking in early (affects chips, not points).
**Form guide**: a player's last-5 finishes shown as colored tier pills (Champion / Podium /
Final table / Out).

### Roles

**Admin**: tournament owner; full control — creates leagues/tournaments, sets the venue &
geofence, confirms payments, runs the clock, eliminates, completes, and can override any
player status.
**Player**: self-serves Confirm / Unconfirm / Check-in / self-report bust; read-only on the
live clock and standings.

## Example dialogue

> **Dev:** When someone taps "Voy", are they Playing?
> **Admin:** No — that's just the RSVP, the Confirm. They're not Playing until game day: they
> Check-in inside the venue, hand me the buy-in, and I confirm the payment. Then they're Playing.
> **Dev:** And if they said "Voy" but never show?
> **Admin:** If they Confirmed and don't Check-in, that's a No-show — they lose points. If they
> Declined, or never answered, no penalty from that rule.
> **Dev:** What's the reward for coming early?
> **Admin:** Check in before start time and you get bonus chips — more starting stack, not points.
