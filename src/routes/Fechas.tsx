import { Link, useNavigate } from 'react-router-dom'
import { useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useLoadable } from '@/lib/useLoadable'
import {
  aliveCount,
  attendanceCounts,
  colonesCompact,
  computePot,
  formatWhen,
  playedCount,
  type EntryStatus,
  type TournamentStatus,
} from '@/lib/fechas'

// ---------------------------------------------------------------------------
// Row shapes read from Supabase. Kept local + loose (the nested player embed is
// a to-one object) so the view models stay easy to build + mock in tests.
// ---------------------------------------------------------------------------
type TournamentRow = {
  id: string
  name: string
  scheduled_at: string
  status: TournamentStatus
  buy_in: number
  rebuy_amount: number | null
  prize_pool_override: number | null
}

type EntryRow = {
  tournament_id: string
  status: EntryStatus
  paid: boolean
  rebuys_count: number
  final_position: number | null
  player: { name: string } | null
}

type FechaCard = {
  id: string
  name: string
  when: string
  /** Raw ISO timestamp — sort key (the localized `when` string is not chronological). */
  scheduledAt: string
  status: TournamentStatus
  buyIn: string
  pot: string
  voy: number
  sinResp: number
  alive: number
  played: number
  winner: string | null
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-season' }
  | { status: 'ready'; cards: FechaCard[] }

const STATUS_SORT: Record<TournamentStatus, number> = {
  live: 0,
  scheduled: 1,
  completed: 2,
}

function buildCards(tournaments: TournamentRow[], entries: EntryRow[]): FechaCard[] {
  const byTournament = new Map<string, EntryRow[]>()
  for (const e of entries) {
    const list = byTournament.get(e.tournament_id) ?? []
    list.push(e)
    byTournament.set(e.tournament_id, list)
  }

  const cards = tournaments.map((t): FechaCard => {
    const es = byTournament.get(t.id) ?? []
    const counts = attendanceCounts(es)
    const pot = computePot(es, t.buy_in, t.rebuy_amount, t.prize_pool_override)
    const champ = es.find((e) => e.status === 'winner' || e.final_position === 1)
    return {
      id: t.id,
      name: t.name,
      when: formatWhen(t.scheduled_at),
      scheduledAt: t.scheduled_at,
      status: t.status,
      buyIn: colonesCompact(t.buy_in),
      pot: colonesCompact(pot),
      voy: counts.voy,
      sinResp: counts.sinResp,
      alive: aliveCount(es),
      played: playedCount(es),
      winner: champ?.player?.name ?? null,
    }
  })

  return cards.sort((a, b) => {
    const s = STATUS_SORT[a.status] - STATUS_SORT[b.status]
    if (s !== 0) return s
    // Sort by the raw ISO timestamp (ISO-8601 sorts lexicographically ==
    // chronologically) — scheduled → soonest first; else most-recent first.
    return a.status === 'scheduled'
      ? a.scheduledAt.localeCompare(b.scheduledAt)
      : b.scheduledAt.localeCompare(a.scheduledAt)
  })
}

async function fetchState(): Promise<State> {
  const { data: season, error: seasonError } = await supabase
    .from('season')
    .select('id')
    .eq('status', 'active')
    .maybeSingle()

  if (seasonError) return { status: 'error' }
  if (!season) return { status: 'no-season' }

  const { data: tournaments, error: tErr } = await supabase
    .from('tournament')
    .select('id, name, scheduled_at, status, buy_in, rebuy_amount, prize_pool_override')
    .eq('season_id', season.id)
    .order('scheduled_at', { ascending: false })

  if (tErr) return { status: 'error' }
  const rows = (tournaments ?? []) as TournamentRow[]
  if (rows.length === 0) return { status: 'ready', cards: [] }

  const { data: entries, error: eErr } = await supabase
    .from('entry')
    .select('tournament_id, status, paid, rebuys_count, final_position, player:player_id(name)')
    .in(
      'tournament_id',
      rows.map((t) => t.id),
    )

  if (eErr) return { status: 'error' }

  return { status: 'ready', cards: buildCards(rows, (entries ?? []) as EntryRow[]) }
}

export default function Fechas() {
  const { isAdmin } = useRole()
  const navigate = useNavigate()
  const { state, reload } = useLoadable<State>({ status: 'loading' }, fetchState)

  const open = (card: FechaCard) => {
    // Live fechas jump straight into the En Vivo screen; scheduled / completed
    // open the detail (RSVP + attendance).
    if (card.status === 'live') navigate('/vivo')
    else navigate(`/fechas/${card.id}`)
  }

  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">Calendario</span>
          <h1>Fechas</h1>
        </div>
      </div>
      <div className="rule" />

      {state.status === 'loading' && <SkeletonCards />}

      {state.status === 'error' && (
        <div className="lb-message" role="alert">
          <p>No se pudieron cargar las fechas.</p>
          <button type="button" className="btn ghost sm" onClick={() => reload()}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'no-season' && (
        <div className="lb-message">
          <p>No hay una temporada activa todavía.</p>
        </div>
      )}

      {state.status === 'ready' && state.cards.length === 0 && (
        <div className="lb-message">
          <p>Aún no hay fechas en el calendario.</p>
          {isAdmin && (
            <Link className="btn primary sm" to="/admin">
              + Nueva fecha
            </Link>
          )}
        </div>
      )}

      {state.status === 'ready' && state.cards.length > 0 && (
        <>
          <div className="pad stagger">
            {state.cards.map((card) => (
              <TournamentCard key={card.id} card={card} onOpen={() => open(card)} />
            ))}
          </div>
          {isAdmin && (
            <div className="btn-row" style={{ padding: '4px 18px 8px' }}>
              <Link className="btn primary full" to="/admin">
                + Nueva fecha
              </Link>
            </div>
          )}
        </>
      )}
    </>
  )
}

const BADGE: Record<TournamentStatus, { cls: string; label: string }> = {
  live: { cls: 'live', label: 'Live' },
  scheduled: { cls: 'up', label: 'Próxima' },
  completed: { cls: 'done', label: 'Jugada' },
}

function TournamentCard({ card, onOpen }: { card: FechaCard; onOpen: () => void }) {
  const badge = BADGE[card.status]
  return (
    <button type="button" className="tourn-card" onClick={onOpen} data-testid="tourn-card">
      <div className="tc-top">
        <div>
          <div className="tc-title">{card.name}</div>
          <div className="tc-sub">{card.when}</div>
        </div>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
      </div>
      <div className="tc-foot">{footCells(card)}</div>
    </button>
  )
}

function footCells(card: FechaCard) {
  if (card.status === 'scheduled') {
    return (
      <>
        <Cell v={card.voy} k="Confirmados" />
        <Cell v={card.sinResp} k="Sin resp." />
        <Cell v={card.buyIn} k="Buy-in" />
      </>
    )
  }
  if (card.status === 'live') {
    return (
      <>
        <Cell v={`${card.alive}/${card.played}`} k="Quedan" />
        <Cell v={card.pot} k="Pozo" />
        <Cell v={<span style={{ color: 'var(--oxblood)' }}>▶</span>} k="Entrar" />
      </>
    )
  }
  return (
    <>
      <Cell v={<span style={{ fontSize: 13 }}>{card.winner ?? '—'}</span>} k="Campeón" />
      <Cell v={card.played} k="Jugadores" />
      <Cell v={card.pot} k="Pozo" />
    </>
  )
}

function Cell({ v, k }: { v: React.ReactNode; k: string }) {
  return (
    <div className="cell">
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  )
}

function SkeletonCards() {
  return (
    <div className="pad" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="tourn-card skeleton-row" style={{ height: 108 }}>
          <div className="tc-top">
            <div style={{ flex: 1 }}>
              <span className="sk" style={{ width: '60%', height: 18 }} />
              <span className="sk" style={{ width: '40%', height: 12, marginTop: 8 }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
