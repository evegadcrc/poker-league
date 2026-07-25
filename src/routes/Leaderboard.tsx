import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { parseLeagueConfig, type LeagueConfig } from '@/lib/fechas'
import { useLoadable } from '@/lib/useLoadable'
import Legend from '@/components/Legend'
import PlayerRow, { type LeaderboardRow } from '@/components/PlayerRow'

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'no-season' }
  | {
      status: 'ready'
      rows: LeaderboardRow[]
      fechas: number
      seasonName: string
      config: LeagueConfig
    }

type SeasonRow = { id: string; name: string; year: number }

/** Season columns the Tabla reads: identity + the scoring-v2 config for the explainer. */
const SEASON_COLUMNS =
  'id, name, year, points_multiplier, bonus_final_table, bonus_attendance, no_show_penalty, early_bird_bonus_chips, top_finish_bonuses'

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
  let seasonRaw: unknown = null

  if (seasonId) {
    // Scoped read: a specific (possibly archived) season by id.
    const { data, error } = await supabase
      .from('season')
      .select(SEASON_COLUMNS)
      .eq('id', seasonId)
      .maybeSingle()
    if (error) return { status: 'error' }
    seasonRaw = data ?? null
  } else {
    // Resilient active-season read: never throws on 0 OR >1 active rows. The DB
    // enforces single-active (mig 0014), but a defensive ordered read keeps the
    // Tabla from erroring if that invariant is ever violated — pick the newest.
    const { data: seasons, error: seasonError } = await supabase
      .from('season')
      .select(SEASON_COLUMNS)
      .eq('status', 'active')
      .order('year', { ascending: false })
      .limit(1)
    if (seasonError) return { status: 'error' }
    seasonRaw = seasons?.[0] ?? null
  }

  const season = seasonRaw as SeasonRow | null
  if (!season) return { status: 'no-season' }

  const { data, error } = await supabase.rpc('leaderboard', {
    p_season_id: season.id,
  })
  if (error) return { status: 'error' }

  const rows = (data ?? []) as LeaderboardRow[]
  const fechas = rows.reduce((max, r) => Math.max(max, r.games_played), 0)
  return {
    status: 'ready',
    rows,
    fechas,
    seasonName: season.name,
    config: parseLeagueConfig(seasonRaw),
  }
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

      {state.status === 'ready' && <LigaScoring config={state.config} />}
    </>
  )
}

/**
 * "Cómo se ganan puntos" — the season's scoring rules, collapsible, at the very
 * bottom of the Liga view. Pulls the live numbers from the active season config
 * (scoring v2) so it never drifts from fn_tournament_points.
 */
function LigaScoring({ config }: { config: LeagueConfig }) {
  const [open, setOpen] = useState(false)
  const top = (i: number) => config.topFinishBonuses[i] ?? 0
  return (
    <section className="fd-info" data-testid="liga-howto">
      <button
        type="button"
        className="calc-rankings-toggle"
        aria-expanded={open}
        aria-controls="liga-howto-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Cómo se ganan puntos</span>
        <span className="chev" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="calc-rankings-body" id="liga-howto-body">
          <div className="fd-info-block">
            <ul className="scoring-list">
              <li>
                <span className="sc-k">Base</span>
                <b>(N − posición) × {config.multiplier}</b>
              </li>
              <li>
                <span className="sc-k">Asistencia</span>
                <b>+{config.bonusAttendance}</b>
                <em>a todos los que juegan</em>
              </li>
              <li>
                <span className="sc-k">Mesa final</span>
                <b>+{config.bonusFinalTable}</b>
                <em>Top 5 si hay 10 o menos · Top 10 si hay más</em>
              </li>
              <li>
                <span className="sc-k">Top 4</span>
                <b>
                  1º +{top(0)} · 2º +{top(1)} · 3º +{top(2)} · 4º +{top(3)}
                </b>
              </li>
              <li>
                <span className="sc-k">No-show</span>
                <b>−{Math.abs(config.noShowPenalty)}</b>
                <em>confirmaste y no llegaste</em>
              </li>
            </ul>
            <p className="scoring-note">
              N = jugadores en la fecha · posición = tu lugar (1 = campeón).
            </p>
            <div className="scoring-example">
              <p className="sc-ex-head">Ejemplo · 20 jugadores, 3er lugar</p>
              <p>(20 − 3) × {config.multiplier} = {(20 - 3) * config.multiplier}</p>
              <p>+ {config.bonusAttendance} asistencia</p>
              <p>+ {config.bonusFinalTable} mesa final</p>
              <p>+ {top(2)} (3º)</p>
              <p className="sc-ex-total">
                <b>= {(20 - 3) * config.multiplier + config.bonusAttendance + config.bonusFinalTable + top(2)} puntos</b>
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
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
