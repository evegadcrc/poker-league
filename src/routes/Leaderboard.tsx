import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useLoadable } from '@/lib/useLoadable'
import Legend from '@/components/Legend'
import PlayerRow, { type LeaderboardRow } from '@/components/PlayerRow'

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-season' }
  | { status: 'ready'; rows: LeaderboardRow[]; fechas: number; seasonName: string }

type SeasonRow = { id: string; name: string; year: number }

const SKELETON_ROWS = 6

/**
 * "Liga" home — the Tabla (leaderboard). Reads a season, calls the
 * `leaderboard(season_id)` RPC and renders the ranked table. The RPC already
 * returns rows in ranked order (tiebreakers applied in SQL) and includes the
 * whole roster at 0 pts for a fresh season, so there is no separate "empty
 * standings" path beyond an empty roster. The number of fechas is the games
 * played by the most-active member (every completed fecha the roster has seen).
 *
 * When a `seasonId` route param is present (`/temporadas/:seasonId`) the Tabla
 * is scoped to THAT season (used to browse archived seasons from the seasons
 * list). Without one it keeps its default behavior: a resilient active-season
 * read that never throws on 0 / >1 active rows.
 */
async function fetchState(seasonId: string | undefined): Promise<State> {
  let season: SeasonRow | null = null

  if (seasonId) {
    // Scoped read: a specific (possibly archived) season by id.
    const { data, error } = await supabase
      .from('season')
      .select('id, name, year')
      .eq('id', seasonId)
      .maybeSingle()
    if (error) return { status: 'error' }
    season = (data as SeasonRow | null) ?? null
  } else {
    // Resilient active-season read: never throws on 0 OR >1 active rows. The DB
    // enforces single-active (mig 0014), but a defensive ordered read keeps the
    // Tabla from erroring if that invariant is ever violated — pick the newest.
    const { data: seasons, error: seasonError } = await supabase
      .from('season')
      .select('id, name, year')
      .eq('status', 'active')
      .order('year', { ascending: false })
      .limit(1)
    if (seasonError) return { status: 'error' }
    season = (seasons?.[0] as SeasonRow | undefined) ?? null
  }

  if (!season) return { status: 'no-season' }

  const { data, error } = await supabase.rpc('leaderboard', {
    p_season_id: season.id,
  })
  if (error) return { status: 'error' }

  const rows = (data ?? []) as LeaderboardRow[]
  const fechas = rows.reduce((max, r) => Math.max(max, r.games_played), 0)
  return { status: 'ready', rows, fechas, seasonName: season.name }
}

export default function Leaderboard() {
  const { player } = useAuth()
  const { seasonId } = useParams()
  const { state, reload } = useLoadable<State>(
    { status: 'loading' },
    () => fetchState(seasonId),
    [seasonId],
  )

  const scoped = Boolean(seasonId)
  const fechas = state.status === 'ready' ? state.fechas : 0
  const overline =
    state.status === 'ready' && scoped ? state.seasonName : 'Clasificación general'

  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">{overline}</span>
          <h1>Tabla</h1>
        </div>
        <div
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}
        >
          <Link
            to="/temporadas"
            className="meta"
            style={{ color: 'var(--oxblood)' }}
            data-testid="seasons-link"
          >
            Temporadas ›
          </Link>
          {state.status === 'ready' && (
            <span className="meta">
              {fechas} {fechas === 1 ? 'fecha' : 'fechas'}
            </span>
          )}
        </div>
      </div>
      <div className="rule" />

      <div className="lb-legend">
        <span>#</span>
        <span>Jugador</span>
        <span>Pts</span>
      </div>

      {state.status === 'loading' && <SkeletonRows />}

      {state.status === 'error' && (
        <div className="lb-message" role="alert">
          <p>No se pudo cargar la tabla.</p>
          <button type="button" className="btn ghost sm" onClick={() => reload()}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'no-season' && (
        <div className="lb-message">
          <p>
            {scoped
              ? 'No se encontró esa temporada.'
              : 'No hay una temporada activa todavía.'}
          </p>
        </div>
      )}

      {state.status === 'ready' && state.rows.length === 0 && (
        <div className="lb-message">
          <p>Aún no hay jugadores en el roster de esta temporada.</p>
        </div>
      )}

      {state.status === 'ready' && state.rows.length > 0 && (
        <div className="stagger">
          {state.rows.map((row, i) => (
            <PlayerRow
              key={row.player_id}
              row={row}
              rank={i + 1}
              isCurrent={player?.id === row.player_id}
            />
          ))}
        </div>
      )}

      <Legend />
    </>
  )
}

/** Loading placeholder — mirrors the .lb-row grid so the table doesn't jump. */
function SkeletonRows() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div className="lb-row skeleton-row" key={i}>
          <div className="rank">
            <span className="sk sk-rank" />
          </div>
          <div className="who">
            <span className="sk sk-avatar" />
            <div className="name">
              <span className="sk sk-name" />
              <span className="sk sk-form" />
            </div>
          </div>
          <div className="lb-stats">
            <span className="sk sk-stat" />
          </div>
        </div>
      ))}
    </div>
  )
}
