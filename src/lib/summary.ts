import { colonesFull, playedCount, type EntryStatus } from '@/lib/fechas'

// ---------------------------------------------------------------------------
// WhatsApp summary (slice 15) — pure, testable Spanish text builders.
//
// DECISION: the copy-paste summaries are generated CLIENT-SIDE, not via a
// `season_summary_text` SQL function. Rationale: every input is already fetched
// by the screens that show the action — the admin console holds the fecha's
// entries / prizes / pot, and the leaderboard RPC (granted to authenticated,
// slice 5) yields the season standings. A SQL builder would have to re-implement
// colón formatting, ordinals and emoji in plpgsql (messier, and a SECURITY
// DEFINER surface to maintain) for zero extra capability. Keeping it here makes
// the exact string trivially unit-testable and reuses `colonesFull`. WhatsApp is
// stage-1 copy-paste text only (be-contract) — no native send.
// ---------------------------------------------------------------------------

const HEADER = '🃏 POKER FRIENDS'
const APP_LINK = 'poker-friends.app'

/** Spanish pluralization for the two counts the summaries surface. */
function jugadores(n: number): string {
  return `${n} ${n === 1 ? 'jugador' : 'jugadores'}`
}
function recompras(n: number): string {
  return `${n} ${n === 1 ? 'recompra' : 'recompras'}`
}

// ---------------------------------------------------------------------------
// Fecha result summary
// ---------------------------------------------------------------------------
export type FechaSummaryEntry = {
  name: string
  status: EntryStatus
  final_position: number | null
  rebuys_count: number | null
}

const PODIUM_LABEL: Record<number, string> = {
  1: '🏆 Campeón',
  2: '🥈 2º',
  3: '🥉 3º',
}

/** Podium lines for positions 1..3; co-finishers (a chop) share one line. */
function podiumLines(entries: readonly FechaSummaryEntry[]): string[] {
  const byPos = new Map<number, string[]>()
  for (const e of entries) {
    const p = e.final_position
    if (p != null && p >= 1 && p <= 3) {
      byPos.set(p, [...(byPos.get(p) ?? []), e.name])
    }
  }
  const lines: string[] = []
  for (const pos of [1, 2, 3]) {
    const names = byPos.get(pos)
    if (names && names.length > 0) lines.push(`${PODIUM_LABEL[pos]}: ${names.join(', ')}`)
  }
  return lines
}

/**
 * Fecha result for the group chat:
 *
 *   🃏 POKER FRIENDS · Fecha 8 — El Sótano
 *
 *   🏆 Campeón: Mauricio A.
 *   🥈 2º: Andrés R.
 *   🥉 3º: Edwin V.
 *
 *   💰 Pozo: ₡140.000
 *   👥 11 jugadores · 2 recompras
 *
 *   📊 Tabla general → poker-friends.app
 *
 * Defensive when called mid-game (no podium yet): shows a "en juego" line.
 */
export function fechaSummaryText(opts: {
  fechaName: string
  entries: readonly FechaSummaryEntry[]
  pot: number
}): string {
  const { fechaName, entries, pot } = opts
  const podium = podiumLines(entries)
  const players = playedCount(entries)
  const rebuys = entries.reduce((sum, e) => sum + (e.rebuys_count ?? 0), 0)

  const podiumBlock = podium.length > 0 ? podium.join('\n') : '🎲 Resultados en juego…'

  return [
    `${HEADER} · ${fechaName}`,
    '',
    podiumBlock,
    '',
    `💰 Pozo: ${colonesFull(pot)}`,
    `👥 ${jugadores(players)} · ${recompras(rebuys)}`,
    '',
    `📊 Tabla general → ${APP_LINK}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Season standings summary
// ---------------------------------------------------------------------------
export type SeasonStandingRow = {
  player_name: string
  total_points: number
}

const RANK_LABEL: Record<number, string> = {
  1: '🥇 1º',
  2: '🥈 2º',
  3: '🥉 3º',
}

/**
 * Top of the leaderboard for the group chat:
 *
 *   🃏 POKER FRIENDS · Liga 2026 — Tabla general
 *
 *   🥇 1º Mauricio A. — 320 pts
 *   🥈 2º Andrés R. — 295 pts
 *   🥉 3º Edwin V. — 270 pts
 *   4º Sofía M. — 240 pts
 *   5º Diego C. — 210 pts
 *
 *   📊 Mirá la tabla completa → poker-friends.app
 */
export function seasonSummaryText(opts: {
  seasonName: string
  rows: readonly SeasonStandingRow[]
  topN?: number
}): string {
  const { seasonName, rows, topN = 5 } = opts
  const top = rows.slice(0, topN)

  const body =
    top.length > 0
      ? top
          .map((r, i) => {
            const rank = i + 1
            const label = RANK_LABEL[rank] ?? `${rank}º`
            return `${label} ${r.player_name} — ${r.total_points} pts`
          })
          .join('\n')
      : 'Aún no hay puntos en la tabla.'

  return [
    `${HEADER} · ${seasonName} — Tabla general`,
    '',
    body,
    '',
    `📊 Mirá la tabla completa → ${APP_LINK}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Clipboard write with a legacy fallback (be-contract: navigator.clipboard,
// with a fallback). Returns whether the copy succeeded.
// ---------------------------------------------------------------------------
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
