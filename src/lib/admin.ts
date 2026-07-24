import type { EntryStatus } from '@/lib/fechas'
import type { Prize } from '@/lib/live'

// ---------------------------------------------------------------------------
// Admin console (slice 12) — pure, testable helpers. The Console route owns the
// data-loading, realtime and RPC wiring; the derivations (clock actions, chop
// preview, per-player action buttons) live here so they can be unit-tested.
// ---------------------------------------------------------------------------

/** The `clock` RPC actions, matching the SQL (0009_admin.sql). */
export type ClockAction =
  | 'pause'
  | 'resume'
  | 'plus_min'
  | 'minus_min'
  | 'next_level'
  | 'prev_level'
  | 'reset_level'
  | 'edit_blinds'

/** Season scoring config needed to preview a chop's points split. */
export type ScoringConfig = {
  points_multiplier: number
  bonus_final_table: number
  bonus_top3: number
  bonus_attendance: number
}

/**
 * §5 point-value of a finishing position, assuming the finisher made the final
 * table and paid (true for the finalists a chop splits). Mirrors the SQL:
 *   (N − P)·mult + bonus_final_table + [P≤3]·bonus_top3 + bonus_attendance
 */
export function pointValueForPosition(position: number, n: number, cfg: ScoringConfig): number {
  return (
    (n - position) * cfg.points_multiplier +
    cfg.bonus_final_table +
    (position <= 3 ? cfg.bonus_top3 : 0) +
    cfg.bonus_attendance
  )
}

export type ChopPreview = {
  /** Number of choppers K. */
  k: number
  /** Cash each chopper receives (Σ top-K prize amounts / K, rounded). */
  moneyEach: number
  /** Points each chopper receives (avg §5 value of positions 1..K, rounded). */
  pointsEach: number
  /** Field size N used for the points preview. */
  n: number
}

/**
 * Preview a chop of K finalists (be-contract §Resolved 3): money = the summed
 * top-K prize amounts split equally; points = the averaged §5 point-value of
 * positions 1..K (every chopper gets the same). `finishersWithPosition` = how
 * many players already have a final_position (the eliminated field); the K
 * choppers take positions 1..K, so N = that count + K.
 */
export function chopPreview(
  k: number,
  prizes: readonly Prize[],
  finishersWithPosition: number,
  cfg: ScoringConfig,
): ChopPreview {
  const n = finishersWithPosition + k
  const topK = [...prizes].sort((a, b) => a.position - b.position).slice(0, k)
  const money = topK.reduce((sum, p) => sum + (p.amount ?? 0), 0)
  const moneyEach = k > 0 ? Math.round(money / k) : 0

  let points = 0
  for (let pos = 1; pos <= k; pos++) points += pointValueForPosition(pos, n, cfg)
  const pointsEach = k > 0 ? Math.round(points / k) : 0

  return { k, moneyEach, pointsEach, n }
}

// ---------------------------------------------------------------------------
// Per-player action buttons in the console list.
// ---------------------------------------------------------------------------
export type AdminActionKind = 'pay' | 'eliminate' | 'rebuy' | 'noshow'

export type AdminAction = {
  kind: AdminActionKind
  label: string
  /** Visual variant → maps to the `.btn` class suffix. */
  variant: 'blood' | 'ghost'
  /** Whether the UI should confirm before firing (destructive). */
  confirm?: boolean
}

/**
 * The actions available for a player row, by lifecycle status. Mirrors the
 * prototype's admin `.prow` action logic:
 *   confirmed   → Confirmar pago · Marcar no-show
 *   checked_in  → (Confirmar pago if unpaid) · Eliminar
 *   playing     → Eliminar
 *   eliminated  → Reactivar (recompra)
 *   winner / no_show / declined / invited → none
 */
export function playerActions(status: EntryStatus, paid: boolean): AdminAction[] {
  switch (status) {
    case 'confirmed':
      return [
        { kind: 'pay', label: 'Confirmar pago', variant: 'blood' },
        { kind: 'noshow', label: 'No-show', variant: 'ghost' },
      ]
    case 'checked_in': {
      const actions: AdminAction[] = []
      if (!paid) actions.push({ kind: 'pay', label: 'Confirmar pago', variant: 'blood' })
      actions.push({ kind: 'eliminate', label: 'Eliminar', variant: 'ghost', confirm: true })
      return actions
    }
    case 'playing':
      return [{ kind: 'eliminate', label: 'Eliminar', variant: 'ghost', confirm: true }]
    case 'eliminated':
      return [{ kind: 'rebuy', label: '↺ Recompra', variant: 'ghost' }]
    default:
      return []
  }
}

/** Statuses that are still in play (a chop can only include these). */
const IN_PLAY: ReadonlySet<EntryStatus> = new Set<EntryStatus>(['playing', 'checked_in', 'winner'])

export function isInPlay(status: EntryStatus): boolean {
  return IN_PLAY.has(status)
}
