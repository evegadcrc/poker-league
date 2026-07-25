import { useLoadable } from '@/lib/useLoadable'
import { fetchProfile, EMPTY_PROFILE, type ProfileState } from '@/lib/profile'
import Sheet from './Sheet'
import FormPills from './FormPills'
import Sparkline from './Sparkline'

type PlayerStatsSheetProps = {
  playerId: string
  playerName: string
  /** The Tabla row's 5-game form window (most-recent-first) + finishing positions. */
  form: string[]
  formPositions: number[]
  onClose: () => void
}

/**
 * Bottom-sheet popup with a player's season stats, opened by tapping a Tabla
 * row. Reuses the `player_profile` RPC (via `fetchProfile`) for the numeric
 * block + points-history sparkline, and the Tabla row's own form window for the
 * pill strip (the RPC omits finishing positions, the row carries them). Works
 * for any player, including the signed-in user. Mounted only while open, so a
 * fresh fetch runs on each open; a loading skeleton, an error+retry, and an
 * empty ("sin jugadas") state are all handled.
 */
export default function PlayerStatsSheet({
  playerId,
  playerName,
  form,
  formPositions,
  onClose,
}: PlayerStatsSheetProps) {
  const { state, reload } = useLoadable<ProfileState>(
    { status: 'loading' },
    () => fetchProfile(playerId),
    [playerId],
  )

  const profile = state.status === 'ready' ? state.profile : EMPTY_PROFILE
  const hasHistory = profile.points_history.length > 0
  const hasForm = form.length > 0

  return (
    <Sheet open onClose={onClose} title={playerName}>
      {state.status === 'loading' && (
        <div data-testid="ps-loading">
          <div className="prof-stats" aria-hidden="true">
            {['Puntos', 'Jugadas', 'Títulos', 'Podios'].map((k) => (
              <div className="c" key={k}>
                <div className="v">—</div>
                <div className="k">{k}</div>
              </div>
            ))}
          </div>
          <div className="sk prof-sk" aria-hidden="true" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="prof-message" role="alert">
          <p>No se pudo cargar el perfil.</p>
          <div className="btn-row" style={{ justifyContent: 'center', padding: '8px 18px' }}>
            <button type="button" className="btn ghost sm" onClick={() => reload()}>
              Reintentar
            </button>
          </div>
        </div>
      )}

      {state.status === 'ready' && (
        <div data-testid="ps-stats">
          <div className="prof-stats">
            <div className="c">
              <div className="v blood">{profile.total_points}</div>
              <div className="k">Puntos</div>
            </div>
            <div className="c">
              <div className="v">{profile.games_played}</div>
              <div className="k">Jugadas</div>
            </div>
            <div className="c">
              <div className="v">{profile.wins}</div>
              <div className="k">Títulos</div>
            </div>
            <div className="c">
              <div className="v">{profile.podiums}</div>
              <div className="k">Podios</div>
            </div>
          </div>

          {profile.games_played === 0 && !hasHistory && !hasForm ? (
            <div className="prof-message">
              <p>Sin jugadas todavía. Sus resultados aparecerán aquí.</p>
            </div>
          ) : (
            <>
              <div className="section-head" style={{ paddingBottom: 2 }}>
                <div>
                  <span className="overline">Racha</span>
                </div>
              </div>
              {hasForm ? (
                <FormPills form={form} positions={formPositions} variant="full" />
              ) : (
                <div className="prof-message">
                  <p>Todavía no hay racha.</p>
                </div>
              )}

              {hasHistory && (
                <>
                  <div className="rule faint" />
                  <div className="section-head" style={{ paddingBottom: 2 }}>
                    <div>
                      <span className="overline">Historial de puntos</span>
                    </div>
                  </div>
                  <Sparkline history={profile.points_history} />
                </>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  )
}
