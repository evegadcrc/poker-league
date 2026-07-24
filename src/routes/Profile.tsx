import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import Avatar from '@/components/Avatar'
import FormPills from '@/components/FormPills'

/** One point of the cumulative points series (from `player_profile`). */
type HistoryPoint = { scheduled_at: string; points: number; cumulative: number }

type Profile = {
  total_points: number
  games_played: number
  wins: number
  podiums: number
  points_history: HistoryPoint[]
  form: string[]
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; profile: Profile }

type Upload =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'error'; message: string }

const EMPTY: Profile = {
  total_points: 0,
  games_played: 0,
  wins: 0,
  podiums: 0,
  points_history: [],
  form: [],
}

async function fetchProfile(playerId: string): Promise<State> {
  const { data, error } = await supabase.rpc('player_profile', { p_player_id: playerId })
  if (error) return { status: 'error' }
  const row = data?.[0]
  if (!row) return { status: 'ready', profile: EMPTY }
  return {
    status: 'ready',
    profile: {
      total_points: row.total_points ?? 0,
      games_played: row.games_played ?? 0,
      wins: row.wins ?? 0,
      podiums: row.podiums ?? 0,
      points_history: (row.points_history as unknown as HistoryPoint[]) ?? [],
      form: row.form ?? [],
    },
  }
}

/**
 * "Perfil" — the current player's season profile: hero avatar (with a camera
 * badge to change the photo), the 4-stat grid, a cumulative points-history
 * sparkline, and the full form ("Racha completa"). Avatar uploads go to the
 * public `avatars` Storage bucket (path keyed by player id so the owner-only
 * RLS policy matches), then `player.avatar_url` is updated and reflected
 * immediately (locally + app-wide via `updatePlayer`).
 */
export default function Profile() {
  const { player, updatePlayer, signOut } = useAuth()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [upload, setUpload] = useState<Upload>({ status: 'idle' })
  const [avatarOverride, setAvatarOverride] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!player) return
    let active = true
    setState({ status: 'loading' })
    void fetchProfile(player.id).then((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
    }
  }, [player, attempt])

  const openPicker = useCallback(() => inputRef.current?.click(), [])

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Clear so re-selecting the same file fires change again.
      e.target.value = ''
      if (!file || !player) return

      setUpload({ status: 'uploading' })
      // Stable path under the player-id folder → owner-only RLS matches; a
      // cache-busting query on the stored URL forces the new image to show.
      const path = `${player.id}/avatar`
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type || undefined })
      if (upErr) {
        setUpload({ status: 'error', message: 'No se pudo subir la foto. Probá de nuevo.' })
        return
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from('avatars').getPublicUrl(path)
      const bustedUrl = `${publicUrl}?t=${Date.now()}`

      const { error: updErr } = await supabase
        .from('player')
        .update({ avatar_url: bustedUrl })
        .eq('id', player.id)
      if (updErr) {
        setUpload({ status: 'error', message: 'La foto se subió, pero no se pudo guardar. Probá de nuevo.' })
        return
      }

      setAvatarOverride(bustedUrl)
      updatePlayer({ avatar_url: bustedUrl })
      setUpload({ status: 'idle' })
    },
    [player, updatePlayer],
  )

  if (!player) return null

  const displayUrl = avatarOverride ?? player.avatar_url
  const uploading = upload.status === 'uploading'
  const profile = state.status === 'ready' ? state.profile : EMPTY
  const hasHistory = profile.points_history.length > 0

  return (
    <>
      <div className="prof-hero">
        <label className="avatar-edit" aria-label="Cambiar foto de perfil">
          <Avatar name={player.name} url={displayUrl} size={54} />
          <span className="cam" aria-hidden="true">
            📷
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            aria-label="Subir foto de perfil"
            onChange={onFile}
            disabled={uploading}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
          />
        </label>
        <div>
          <span className="overline">Tu perfil</span>
          <h2>{player.name}</h2>
          <div className="sub">
            {state.status === 'loading'
              ? 'Cargando…'
              : profile.games_played === 0
                ? 'Sin jugadas todavía'
                : `${profile.total_points} pts · ${profile.games_played} ${
                    profile.games_played === 1 ? 'jugada' : 'jugadas'
                  }`}
          </div>
        </div>
      </div>

      {state.status === 'error' && (
        <div className="prof-message" role="alert">
          <p>No se pudo cargar tu perfil.</p>
          <div className="btn-row" style={{ justifyContent: 'center', padding: '8px 18px' }}>
            <button type="button" className="btn ghost sm" onClick={reload}>
              Reintentar
            </button>
          </div>
        </div>
      )}

      {state.status === 'loading' && (
        <>
          <div className="prof-stats" aria-hidden="true">
            {['Puntos', 'Jugadas', 'Títulos', 'Podios'].map((k) => (
              <div className="c" key={k}>
                <div className="v">—</div>
                <div className="k">{k}</div>
              </div>
            ))}
          </div>
          <div className="sk prof-sk" aria-hidden="true" data-testid="prof-loading" />
        </>
      )}

      {state.status === 'ready' && (
        <>
          <div className="prof-stats" data-testid="prof-stats">
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

          <div className="btn-row">
            <button
              type="button"
              className="btn ghost full sm"
              style={{ height: 40 }}
              onClick={openPicker}
              disabled={uploading}
            >
              📷 {uploading ? 'Subiendo…' : 'Cambiar foto de perfil'}
            </button>
          </div>

          {upload.status === 'error' && (
            <div className="prof-message" role="alert">
              <p>{upload.message}</p>
            </div>
          )}

          <div className="section-head" style={{ paddingBottom: 2 }}>
            <div>
              <span className="overline">Historial de puntos</span>
            </div>
          </div>
          {hasHistory ? (
            <Sparkline history={profile.points_history} />
          ) : (
            <div className="spark empty prof-message">
              <p>Aún no tienes historial de puntos. Jugá tu primera fecha para empezar.</p>
            </div>
          )}

          <div className="rule faint" />

          <div className="section-head" style={{ paddingBottom: 2 }}>
            <div>
              <span className="overline">Racha completa</span>
            </div>
          </div>
          {profile.form.length > 0 ? (
            <FormPills form={profile.form} variant="full" />
          ) : (
            <div className="prof-message">
              <p>Todavía no hay racha. Tus resultados aparecerán aquí.</p>
            </div>
          )}
        </>
      )}

      <div className="btn-row">
        <button type="button" className="btn ghost full" onClick={() => void signOut()}>
          Cerrar sesión
        </button>
      </div>
    </>
  )
}

/**
 * Inline SVG sparkline of the cumulative points series (oxblood line + gradient
 * area), ported from the prototype's #spark. Y is scaled across [min(0,series),
 * max]; a single point renders as a flat baseline with one node.
 */
function Sparkline({ history }: { history: HistoryPoint[] }) {
  const w = 340
  const h = 88
  const values = history.map((p) => p.cumulative)
  const max = Math.max(...values)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const n = values.length
  const x = (i: number) => (n <= 1 ? w / 2 : (i * w) / (n - 1))
  const y = (v: number) => h - ((v - min) / range) * h

  const nodes = values.map((v, i) => ({ cx: x(i), cy: y(v) }))
  // A single game has no line span → draw a flat baseline across the full width.
  const linePts =
    n === 1 ? [`0,${y(values[0]!)}`, `${w},${y(values[0]!)}`] : nodes.map((p) => `${p.cx},${p.cy}`)

  return (
    <div className="spark" data-testid="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Historial de puntos">
        <defs>
          <linearGradient id="pf-spark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--oxblood)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--oxblood)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M 0,${h} L ${linePts.join(' L ')} L ${w},${h} Z`} fill="url(#pf-spark)" />
        <path
          d={`M ${linePts.join(' L ')}`}
          fill="none"
          stroke="var(--oxblood)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {nodes.map((p, i) => (
          <circle
            key={i}
            cx={p.cx}
            cy={p.cy}
            r="3.2"
            fill="var(--paper)"
            stroke="var(--oxblood)"
            strokeWidth="2"
          />
        ))}
      </svg>
    </div>
  )
}
