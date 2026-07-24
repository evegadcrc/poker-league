# Decisions

Append-only ADR-lite ledger. One entry per non-trivial decision with context, choice, and reasoning. Never edit prior entries — supersede them with a new entry.

2026-07-23 — Plan approved for poker-league-prototype (Phase 1 build). Two-pass /dh:review-plan: REJECT (6 findings) → amended → APPROVE (caveats fixed: tournament.created_by added to schema, step-ref + auto-advance verify). 16 dispatchable slices; Supabase backend; approved prototype = visual source of truth. User approved for build.


2026-07-24 — Verify-UI Tier 4 (product decisions). (1) PRIZES auto-materialize from the season payout_template (prizes = template × pot, rounded) automatically — no admin "Editar" required; admin override still preserved. Fix = migration 0013 (set_prizes called on open + payment/rebuy). (2) CHOP POINTS confirmed INTENDED: each chopper gets round(Σ §5 point-values for the chopped positions ÷ K), bonuses (Top-3 / mesa-final) included — per-head can RISE with more choppers; this is the desired rule, do not "fix". Money split (unlike points) does divide down.
