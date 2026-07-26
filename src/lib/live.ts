import type { EntryStatus } from '@/lib/fechas'

// ---------------------------------------------------------------------------
// En Vivo (slice 11) — pure, testable helpers for the state-based clock, the
// blind structure, the prizes block and the live standings. The Live route
// owns data-loading + realtime; everything derivable lives here so it can be
// unit-tested without a browser.
// ---------------------------------------------------------------------------

/** The clock is STATE-based: we store when the level started / whether it is
 *  paused, and the CLIENT computes the displayed remaining seconds. Ticks are
 *  never broadcast — only state changes fan out over realtime. */
export type TimerState = {
  isPaused: boolean
  pausedRemainingSeconds: number | null
  levelStartedAt: string | null
  levelDurationSeconds: number
}

/**
 * Remaining seconds for the current level (be-contract "remaining_seconds"):
 *   paused   → paused_remaining_seconds
 *   running  → level_duration − (now − level_started_at)
 * Always clamped at 0 and floored to a whole second.
 */
export function remainingSeconds(s: TimerState, now: number = Date.now()): number {
  if (s.isPaused) return Math.max(0, Math.floor(s.pausedRemainingSeconds ?? 0))
  if (!s.levelStartedAt) return Math.max(0, Math.floor(s.levelDurationSeconds))
  const startedMs = new Date(s.levelStartedAt).getTime()
  if (Number.isNaN(startedMs)) return Math.max(0, Math.floor(s.levelDurationSeconds))
  const elapsed = (now - startedMs) / 1000
  return Math.max(0, Math.floor(s.levelDurationSeconds - elapsed))
}

/** mm:ss, clamped at 0 (tabular so the neon scoreboard doesn't jitter). */
export function formatClock(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Blind structure
// ---------------------------------------------------------------------------
export type BlindLevel = {
  level_number: number
  small_blind: number
  big_blind: number
  ante: number | null
  duration_seconds: number
  is_break: boolean
}

/** The level the tournament is currently on (falls back to the first level). */
export function findLevel(levels: readonly BlindLevel[], levelNumber: number): BlindLevel | null {
  return levels.find((l) => l.level_number === levelNumber) ?? levels[0] ?? null
}

/** The next level up (smallest level_number strictly greater than the current). */
export function nextLevel(levels: readonly BlindLevel[], levelNumber: number): BlindLevel | null {
  return (
    levels
      .filter((l) => l.level_number > levelNumber)
      .sort((a, b) => a.level_number - b.level_number)[0] ?? null
  )
}

/**
 * Whether the ante should show for this level: only when the tournament has
 * antes enabled AND this level actually has a positive ante. Hidden otherwise
 * (be-contract: ante ignored when ante_enabled=false or the level's ante is 0).
 */
export function showAnte(level: BlindLevel | null, anteEnabled: boolean): boolean {
  return Boolean(anteEnabled && level && (level.ante ?? 0) > 0)
}

// ---------------------------------------------------------------------------
// Prizes (tournament.prizes jsonb → [{position, pct, amount, overridden}])
// ---------------------------------------------------------------------------
export type Prize = { position: number; pct: number | null; amount: number }

export function parsePrizes(raw: unknown): Prize[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((p) => {
      const r = (p ?? {}) as Record<string, unknown>
      return {
        position: Number(r.position),
        pct: r.pct == null ? null : Number(r.pct),
        amount: Number(r.amount ?? 0),
      }
    })
    .filter((p) => Number.isFinite(p.position))
    .sort((a, b) => a.position - b.position)
}

/** Ordinal label for a prize / standing row ("1º", "2º", …). */
export function ordinal(position: number): string {
  return `${position}º`
}

/** A payout percentage (0.60) as a compact label ("60%"), or "" when unknown. */
export function pctLabel(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return ''
  return `${Math.round(pct * 100)}%`
}

// ---------------------------------------------------------------------------
// Payout distribution (tournament.payout_distribution jsonb → [{place, pct}]).
// `pct` is a FRACTION (0.60). set_prizes materializes this × pot into the
// real `prizes`; before that runs (or when a live fecha hasn't materialized
// yet) we preview the PROPOSED split with the same maths.
// ---------------------------------------------------------------------------
export type DistSlice = { place: number; pct: number }

export function parseDistribution(raw: unknown): DistSlice[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((d) => {
      const r = (d ?? {}) as Record<string, unknown>
      return { place: Number(r.place), pct: Number(r.pct) }
    })
    .filter((d) => Number.isFinite(d.place) && Number.isFinite(d.pct))
    .sort((a, b) => a.place - b.place)
}

/**
 * Proposed prize amounts from a distribution × pot — mirrors set_prizes (mig
 * 0015): each place rounds to the nearest ₡5.000, and 1st place absorbs the
 * remainder so the amounts sum to the pot EXACTLY. Amounts are 0 when the pot
 * is not yet known (pot ≤ 0), so the split still renders before entries exist.
 */
export function proposedPrizes(dist: readonly DistSlice[], pot: number): Prize[] {
  const rows = [...dist].sort((a, b) => a.place - b.place)
  if (rows.length === 0) return []
  if (pot <= 0) return rows.map((r) => ({ position: r.place, pct: r.pct, amount: 0 }))
  const step = 5000
  const amounts = rows.map((r) => Math.round((r.pct * pot) / step) * step)
  const rest = amounts.slice(1).reduce((s, a) => s + a, 0)
  amounts[0] = pot - rest // 1st place absorbs the rounding remainder
  return rows.map((r, i) => ({ position: r.place, pct: r.pct, amount: Math.max(0, amounts[i]!) }))
}

// ---------------------------------------------------------------------------
// Live standings
// ---------------------------------------------------------------------------
export type StandingEntry = {
  id: string
  status: EntryStatus
  final_position: number | null
  chips: number | null
  /** Buy-in payment confirmed by the admin (confirm_payment). False → pending. */
  paid: boolean
  /** Engine points for this finisher (mig 0030 writes it live on every bust); null while still playing. */
  points_earned: number | null
  /** Reached the final table → the bonus_final_table term applies. */
  made_final_table: boolean
  /** Chop / dead-even tie group; non-null → the engine averages points, so no per-position breakdown. */
  chop_group: number | null
  player: { name: string; avatar_url: string | null } | null
}

const ALIVE_STATUSES: ReadonlySet<EntryStatus> = new Set<EntryStatus>(['playing', 'checked_in'])

export function isAlive(status: EntryStatus): boolean {
  return ALIVE_STATUSES.has(status)
}

/**
 * Standings order (be-contract "live_standing"): players still alive first
 * (chip-leader first), then everyone with a final_position by that position
 * ascending. Entries that never took a seat (invited/confirmed/declined/
 * no_show, no final_position) are dropped from the live board.
 */
export function liveStandings(entries: readonly StandingEntry[]): StandingEntry[] {
  return entries
    .filter((e) => isAlive(e.status) || e.final_position != null)
    .slice()
    .sort((a, b) => {
      const aAlive = isAlive(a.status)
      const bAlive = isAlive(b.status)
      if (aAlive !== bAlive) return aAlive ? -1 : 1
      if (aAlive && bAlive) return (b.chips ?? 0) - (a.chips ?? 0)
      return (a.final_position ?? 0) - (b.final_position ?? 0)
    })
}

/** Total chips still in play — the sum of every alive player's stack. */
export function chipsInPlay(entries: readonly StandingEntry[]): number {
  return entries.reduce((sum, e) => (isAlive(e.status) ? sum + (e.chips ?? 0) : sum), 0)
}

/** Compact chip label ("124K", "97K", "500"). */
export function compactChips(chips: number): string {
  const n = Math.max(0, Math.round(chips))
  if (n >= 1000) {
    const k = n / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`
  }
  return String(n)
}
