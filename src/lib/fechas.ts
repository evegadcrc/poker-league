import type { Database } from '@/lib/database.types'

export type EntryStatus = Database['public']['Enums']['entry_status']
export type TournamentStatus = Database['public']['Enums']['tournament_status']

/**
 * Status-pill label + CSS class, ported verbatim from the prototype's `ST` map
 * (`.status .s-*`). Every lifecycle state the attendance / standings lists can
 * render has an entry so the pill styling matches the visual source of truth.
 */
const PILL: Record<EntryStatus, readonly [string, string]> = {
  invited: ['Sin resp.', 's-none'],
  confirmed: ['Confirmado', 's-confirmed'],
  declined: ['Canceló', 's-declined'],
  checked_in: ['Check-in', 's-checked'],
  playing: ['Jugando', 's-playing'],
  no_show: ['No-show', 's-noshow'],
  eliminated: ['Fuera', 's-out'],
  winner: ['Campeón', 's-win'],
}

export function statusPill(status: EntryStatus): { label: string; cls: string } {
  const [label, cls] = PILL[status]
  return { label, cls }
}

/**
 * Sort priority for the attendance list — cluster same-status rows so the list
 * reads as grouped (those who are in first, RSVP-pending, then out).
 */
const STATUS_ORDER: readonly EntryStatus[] = [
  'winner',
  'playing',
  'checked_in',
  'confirmed',
  'eliminated',
  'no_show',
  'invited',
  'declined',
]

export function statusRank(status: EntryStatus): number {
  const i = STATUS_ORDER.indexOf(status)
  return i === -1 ? STATUS_ORDER.length : i
}

/** Statuses that count as "attending / in" for the Voy chip + card footer. */
const ATTENDING: ReadonlySet<EntryStatus> = new Set<EntryStatus>([
  'confirmed',
  'checked_in',
  'playing',
  'eliminated',
  'winner',
])

/** Statuses that mean the player is actively still alive in a live fecha. */
const ALIVE: ReadonlySet<EntryStatus> = new Set<EntryStatus>(['checked_in', 'playing'])

export type AttendanceCounts = {
  /** Confirmed / checked-in / playing / finished — everyone who is in. */
  voy: number
  /** Declined (cancelled). */
  cancelaron: number
  /** Invited but not yet responded. */
  sinResp: number
}

export function attendanceCounts(entries: readonly { status: EntryStatus }[]): AttendanceCounts {
  let voy = 0
  let cancelaron = 0
  let sinResp = 0
  for (const e of entries) {
    if (ATTENDING.has(e.status)) voy += 1
    else if (e.status === 'declined') cancelaron += 1
    else if (e.status === 'invited') sinResp += 1
  }
  return { voy, cancelaron, sinResp }
}

/** Count of players still alive (checked-in or playing) in a live fecha. */
export function aliveCount(entries: readonly { status: EntryStatus }[]): number {
  return entries.filter((e) => ALIVE.has(e.status)).length
}

/** Count of players who actually took a seat (checked in or beyond). */
export function playedCount(entries: readonly { status: EntryStatus }[]): number {
  return entries.filter(
    (e) =>
      e.status === 'checked_in' ||
      e.status === 'playing' ||
      e.status === 'eliminated' ||
      e.status === 'winner',
  ).length
}

// ---------------------------------------------------------------------------
// Cash formatting (Costa Rica colones). Compact for card footers, full for the
// cancel sheet copy.
// ---------------------------------------------------------------------------
export function colonesCompact(amount: number | null | undefined): string {
  const n = Number(amount ?? 0)
  if (n >= 1000) {
    const k = n / 1000
    const label = Number.isInteger(k) ? String(k) : k.toFixed(1)
    return `₡${label}K`
  }
  return `₡${n}`
}

export function colonesFull(amount: number | null | undefined): string {
  const n = Math.round(Number(amount ?? 0))
  return `₡${n.toLocaleString('es-CR')}`
}

/** Pot from the paid field + rebuys (mirrors fn_pot; respects a manual override). */
export function computePot(
  entries: readonly { paid: boolean; rebuys_count: number }[],
  buyIn: number,
  rebuyAmount: number | null,
  override: number | null,
): number {
  if (override != null) return Number(override)
  const paidCount = entries.filter((e) => e.paid).length
  const rebuys = entries.reduce((sum, e) => sum + (e.rebuys_count ?? 0), 0)
  return paidCount * Number(buyIn) + rebuys * Number(rebuyAmount ?? 0)
}

// ---------------------------------------------------------------------------
// Date / time — "Sáb 26 Jul · 19:00".
// ---------------------------------------------------------------------------
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = new Intl.DateTimeFormat('es-CR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d)
  const time = new Intl.DateTimeFormat('es-CR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  // Capitalize the weekday, drop any locale comma.
  const pretty = day.replace(',', '')
  return `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)} · ${time}`
}

// ---------------------------------------------------------------------------
// Graduated late-cancel bands — mirrors the SQL in 0006_rsvp.sql so the confirm
// sheet can show the penalty the RPC will apply.
// ---------------------------------------------------------------------------
export type Band = { hours_before: number; penalty: number }

const DEFAULT_BANDS: readonly Band[] = [
  { hours_before: 24, penalty: 0 },
  { hours_before: 12, penalty: -5 },
  { hours_before: 6, penalty: -10 },
  { hours_before: 0, penalty: -15 },
]

/** Coerce the season.cancel_bands jsonb into a typed, validated array. */
export function parseBands(raw: unknown): Band[] {
  if (!Array.isArray(raw)) return [...DEFAULT_BANDS]
  const bands = raw
    .map((b) => {
      const rec = b as Record<string, unknown>
      return {
        hours_before: Number(rec?.hours_before),
        penalty: Number(rec?.penalty),
      }
    })
    .filter((b) => Number.isFinite(b.hours_before) && Number.isFinite(b.penalty))
  return bands.length > 0 ? bands : [...DEFAULT_BANDS]
}

/** Hours from now until the fecha starts (clamped at 0 — matches the RPC). */
export function hoursUntil(iso: string, now: Date = new Date()): number {
  const start = new Date(iso).getTime()
  return Math.max((start - now.getTime()) / 3_600_000, 0)
}

/**
 * The band whose `hours_before` is the largest value still <= the hours
 * remaining (identical selection to the SQL). At 9h → the −10 band.
 */
export function pickBand(bands: readonly Band[], hoursRemaining: number): Band {
  const eligible = bands
    .filter((b) => b.hours_before <= hoursRemaining)
    .sort((a, b) => b.hours_before - a.hours_before)
  return eligible[0] ?? { hours_before: 0, penalty: 0 }
}

/** Human label for a band row in the cancel sheet. */
export function bandLabel(band: Band, bands: readonly Band[]): string {
  const sorted = [...bands].sort((a, b) => b.hours_before - a.hours_before)
  const idx = sorted.findIndex((b) => b.hours_before === band.hours_before)
  const upper = idx > 0 ? sorted[idx - 1]!.hours_before : null
  if (band.hours_before === 0) return `−${sorted[sorted.length - 2]?.hours_before ?? 6} h / no-show`
  if (upper == null) return `+${band.hours_before} h antes`
  return `${upper}–${band.hours_before} h`
}

// ---------------------------------------------------------------------------
// League scoring config (season row) — read-only, for the "cómo se ganan puntos"
// explainer on the Liga (leaderboard) view. Mirrors the scoring-v2 columns in
// 0019_scoring_v2.sql (multiplier 5 · attendance 15 · final-table 10 · graduated
// top-4 [20,15,10,5] · no-show −15).
// ---------------------------------------------------------------------------
export type LeagueConfig = {
  /** Scoring-v2 points multiplier applied to (N − P). */
  multiplier: number
  bonusFinalTable: number
  bonusAttendance: number
  /** Graduated top-4 finish bonuses, index 0 = 1st place (scoring v2). */
  topFinishBonuses: number[]
  /** Stored already-signed negative (e.g. −15). */
  noShowPenalty: number
  /** Llegada-temprana stack bonus, in chips. */
  earlyBirdChips: number
}

const DEFAULT_CONFIG: LeagueConfig = {
  multiplier: 5,
  bonusFinalTable: 10,
  bonusAttendance: 15,
  topFinishBonuses: [20, 15, 10, 5],
  noShowPenalty: -15,
  earlyBirdChips: 0,
}

/** Coerce a season.top_finish_bonuses jsonb into a number[], falling back to the v2 default. */
function parseTopFinish(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CONFIG.topFinishBonuses]
  const nums = raw.map((v) => Number(v))
  return nums.length > 0 && nums.every((v) => Number.isFinite(v))
    ? nums
    : [...DEFAULT_CONFIG.topFinishBonuses]
}

/** Coerce a season row (or partial) into a typed LeagueConfig with safe defaults. */
export function parseLeagueConfig(raw: unknown): LeagueConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number) =>
    Number.isFinite(Number(v)) ? Number(v) : fallback
  return {
    multiplier: num(r.points_multiplier, DEFAULT_CONFIG.multiplier),
    bonusFinalTable: num(r.bonus_final_table, DEFAULT_CONFIG.bonusFinalTable),
    bonusAttendance: num(r.bonus_attendance, DEFAULT_CONFIG.bonusAttendance),
    topFinishBonuses: parseTopFinish(r.top_finish_bonuses),
    noShowPenalty: num(r.no_show_penalty, DEFAULT_CONFIG.noShowPenalty),
    earlyBirdChips: num(r.early_bird_bonus_chips, DEFAULT_CONFIG.earlyBirdChips),
  }
}

export type PointsExample = {
  n: number
  p: number
  base: number
  graduatedTop4: number
  bonusFinalTable: number
  bonusAttendance: number
  total: number
}

/**
 * Worked scoring-v2 example: an N-player field, finishing place P, assuming the
 * player made the final table and paid so every bonus applies. base = (N − P) ×
 * multiplier; graduatedTop4 = topFinishBonuses[P−1] for P in 1..4 else 0; total
 * adds the final-table + attendance bonuses.
 */
export function pointsExample(cfg: LeagueConfig, n = 10, p = 3): PointsExample {
  const base = (n - p) * cfg.multiplier
  const graduatedTop4 = p >= 1 && p <= 4 ? cfg.topFinishBonuses[p - 1] ?? 0 : 0
  return {
    n,
    p,
    base,
    graduatedTop4,
    bonusFinalTable: cfg.bonusFinalTable,
    bonusAttendance: cfg.bonusAttendance,
    total: base + graduatedTop4 + cfg.bonusFinalTable + cfg.bonusAttendance,
  }
}

/**
 * ISO timestamp → a `<input type="datetime-local">` value in LOCAL time
 * ("YYYY-MM-DDTHH:mm"); "" for an unparseable input. The inverse is just
 * `new Date(value).toISOString()` (datetime-local strings parse as local time).
 */
export function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
