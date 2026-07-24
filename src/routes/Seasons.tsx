import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useLoadable } from '@/lib/useLoadable'

// ---------------------------------------------------------------------------
// Temporadas — the seasons list. The ACTIVE season card sits on top; ARCHIVED
// seasons follow (newest year first). Tapping a card opens that season's Tabla
// (`/temporadas/:seasonId`, rendered by Leaderboard scoped to the season). Reuses
// the Fechas `.tourn-card` anatomy so it matches the rest of the app in all
// three themes. UI copy is Spanish (league is in Costa Rica).
// ---------------------------------------------------------------------------
type SeasonRow = { id: string; name: string; year: number; status: 'active' | 'archived' }

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; active: SeasonRow[]; archived: SeasonRow[] }

async function fetchState(): Promise<State> {
  const { data, error } = await supabase
    .from('season')
    .select('id, name, year, status')
    .order('year', { ascending: false })

  if (error) return { status: 'error' }
  // Sort + partition client-side (never assume the DB/enum sort order): newest
  // year first within each group, active on top, archived after.
  const rows = ((data ?? []) as SeasonRow[]).slice().sort((a, b) => b.year - a.year)
  const active = rows.filter((s) => s.status === 'active')
  const archived = rows.filter((s) => s.status === 'archived')
  return { status: 'ready', active, archived }
}

export default function Seasons() {
  const navigate = useNavigate()
  const { state, reload } = useLoadable<State>({ status: 'loading' }, fetchState)

  const open = (season: SeasonRow) => navigate(`/temporadas/${season.id}`)

  const isEmpty =
    state.status === 'ready' && state.active.length === 0 && state.archived.length === 0

  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">Liga</span>
          <h1>Temporadas</h1>
        </div>
      </div>
      <div className="rule" />

      {state.status === 'loading' && <SkeletonCards />}

      {state.status === 'error' && (
        <div className="lb-message" role="alert">
          <p>No se pudieron cargar las temporadas.</p>
          <button type="button" className="btn ghost sm" onClick={() => reload()}>
            Reintentar
          </button>
        </div>
      )}

      {isEmpty && (
        <div className="lb-message">
          <p>Aún no hay temporadas.</p>
        </div>
      )}

      {state.status === 'ready' && !isEmpty && (
        <div className="pad stagger">
          {state.active.map((s) => (
            <SeasonCard key={s.id} season={s} onOpen={() => open(s)} />
          ))}
          {state.archived.map((s) => (
            <SeasonCard key={s.id} season={s} onOpen={() => open(s)} />
          ))}
        </div>
      )}
    </>
  )
}

function SeasonCard({ season, onOpen }: { season: SeasonRow; onOpen: () => void }) {
  const isActive = season.status === 'active'
  return (
    <button
      type="button"
      className="tourn-card"
      onClick={onOpen}
      data-testid="season-card"
      data-season-id={season.id}
    >
      <div className="tc-top">
        <div>
          <div className="tc-title">{season.name}</div>
          <div className="tc-sub">Temporada {season.year}</div>
        </div>
        <span className={`badge ${isActive ? 'up' : 'done'}`}>
          {isActive ? 'Activa' : 'Archivada'}
        </span>
      </div>
      <div className="tc-foot">
        <div className="cell">
          <div className="v" style={{ fontSize: 14 }}>
            Ver tabla ›
          </div>
          <div className="k">Clasificación</div>
        </div>
      </div>
    </button>
  )
}

function SkeletonCards() {
  return (
    <div className="pad" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="tourn-card skeleton-row" style={{ height: 96 }}>
          <div className="tc-top">
            <div style={{ flex: 1 }}>
              <span className="sk" style={{ width: '55%', height: 18 }} />
              <span className="sk" style={{ width: '35%', height: 12, marginTop: 8 }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
