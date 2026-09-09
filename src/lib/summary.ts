import { colonesFull, formatWhen, playedCount, type EntryStatus } from '@/lib/fechas'

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

/** Where the summaries point: the running app's origin, or the placeholder off-browser. */
function defaultLink(): string {
  return typeof window !== 'undefined' && window.location?.origin ? window.location.origin : APP_LINK
}

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
  /** Where "Tabla general" points (defaults to the app origin). */
  link?: string
}): string {
  const { fechaName, entries, pot, link = defaultLink() } = opts
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
    `📊 Tabla general → ${link}`,
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
  /** Where "la tabla completa" points (defaults to the app origin). */
  link?: string
}): string {
  const { seasonName, rows, topN = 5, link = defaultLink() } = opts
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
    `📊 Mirá la tabla completa → ${link}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Convocatoria — the roster of an upcoming (or just-opened) fecha, for the
// admin to drop in the group chat with the join link. Built client-side from
// the entries the fecha view already holds (same rationale as above).
// ---------------------------------------------------------------------------
export type ConvocatoriaEntry = { name: string; status: EntryStatus }

/** Statuses that mean "is coming / is here" for the convocatoria. */
const COMING: ReadonlySet<EntryStatus> = new Set([
  'confirmed',
  'checked_in',
  'playing',
  'eliminated',
  'winner',
])

/** One group: header line, then one name per line (easier to scan in the chat). */
function namesBlock(emoji: string, label: string, names: readonly string[], empty?: string): string | null {
  if (names.length === 0) return empty ? `${emoji} ${label} (0): ${empty}` : null
  return [`${emoji} ${label} (${names.length}):`, ...names].join('\n')
}

/**
 * Roster for the group chat:
 *
 *   🃏 POKER FRIENDS · Fecha 10 — Casa de José
 *   📅 Sáb 20 sep · 19:00
 *   💰 Buy-in: ₡10.000
 *
 *   ✅ Confirmados (2):
 *   Carlos
 *   María
 *
 *   ❌ Cancelaron (1):
 *   Andrés
 *
 *   👉 Confirmar acá: https://…/fechas/<id>
 *
 * One name per line so the list scans quickly in the chat. "Cancelaron" is
 * omitted when empty; "Confirmados" always shows (with "nadie todavía" at zero)
 * because that is the number people ask. Players who haven't answered are not
 * listed — the link is the nudge. The buy-in line is omitted when there is none.
 */
export function convocatoriaText(opts: {
  fechaName: string
  scheduledAt: string
  buyIn: number | null | undefined
  entries: readonly ConvocatoriaEntry[]
  link: string
  /** The fecha accepts guests through the link (mig 0035) → add the hint. */
  guestsOpen?: boolean
}): string {
  const { fechaName, scheduledAt, buyIn, entries, link, guestsOpen = false } = opts
  const coming = entries.filter((e) => COMING.has(e.status)).map((e) => e.name)
  const declined = entries.filter((e) => e.status === 'declined').map((e) => e.name)

  const when = formatWhen(scheduledAt)
  const head = [`${HEADER} · ${fechaName}`]
  if (when) head.push(`📅 ${when}`)
  if (buyIn != null && buyIn > 0) head.push(`💰 Buy-in: ${colonesFull(buyIn)}`)

  // Confirmados + Cancelaron only: the people who haven't answered are exactly
  // the ones the link is for, so listing them adds length without information.
  const roster = [
    namesBlock('✅', 'Confirmados', coming, 'nadie todavía'),
    namesBlock('❌', 'Cancelaron', declined),
  ].filter((l): l is string => l != null)

  // Blank line between groups, and around the roster.
  const tail = [`👉 Confirmar acá: ${link}`]
  if (guestsOpen) tail.push('🙋 ¿Invitado? Mismo enlace → «Voy como invitado»')
  return [...head, '', roster.join('\n\n'), '', ...tail].join('\n')
}

/** WhatsApp "share this text" deep link — opens WhatsApp with the message
 *  pre-filled and lets the sender pick the chat (works on phones and desktop). */
export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`
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
