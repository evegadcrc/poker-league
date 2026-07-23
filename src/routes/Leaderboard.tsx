import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import Legend from '@/components/Legend'
import PlayerRow, { type LeaderboardRow } from '@/components/PlayerRow'

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-season' }
  | { status: 'ready'; rows: LeaderboardRow[]; fechas: number }

const SKELETON_ROWS = 6

/**
 * "Liga" home — the Tabla (leaderboard). Reads the active season, calls the
 * `leaderboard(season_id)` RPC and renders the ranked table. The RPC already
 * returns rows in ranked order (tiebreakers applied in SQL) and includes the
 * whole roster at 0 pts for a fresh season, so there is no separate "empty
 * standings" path beyond an empty roster. The number of fechas is the games
 * played by the most-active member (every completed fecha the roster has seen).
 */
async function fetchState(): Promise<State> {
  const { data: season, error: seasonError } = await supabase
    .from('season')
    .select('id, name, year')
    .eq('status', 'active')
    .maybeSingle()

  if (seasonError) return { status: 'error' }
  if (!season) return { status: 'no-season' }

  const { data, error } = await supabase.rpc('leaderboard', {
    p_season_id: season.id,
  })
  if (error) return { status: 'error' }

  const rows = (data ?? []) as LeaderboardRow[]
  const fechas = rows.reduce((max, r) => Math.max(max, r.games_played), 0)
  return { status: 'ready', rows, fechas }
}

export default function Leaderboard() {
  const { player } = useAuth()
  const [state, setState] = useState<State>({ status: 'loading' })
  // Bumped to re-trigger the load effect on "Reintentar".
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void fetchState().then((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
    }
  }, [attempt])

  const fechas = state.status === 'ready' ? state.fechas : 0

  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">Clasificación general</span>
          <h1>Tabla</h1>
        </div>
        {state.status === 'ready' && (
          <span className="meta">
            {fechas} {fechas === 1 ? 'fecha' : 'fechas'}
          </span>
        )}
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
          <button type="button" className="btn ghost sm" onClick={reload}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'no-season' && (
        <div className="lb-message">
          <p>No hay una temporada activa todavía.</p>
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
