import { useCallback, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useLoadable } from '@/lib/useLoadable'
import Avatar from '@/components/Avatar'
import Sheet from '@/components/Sheet'
import { classifyCheckInError, requestPosition, type Coords } from '@/lib/checkin'
import {
  attendanceCounts,
  bandLabel,
  formatWhen,
  hoursUntil,
  parseBands,
  pickBand,
  statusPill,
  statusRank,
  type Band,
  type EntryStatus,
  type TournamentStatus,
} from '@/lib/fechas'

type TournamentRow = {
  id: string
  season_id: string
  name: string
  scheduled_at: string
  status: TournamentStatus
  geofence_radius_m: number
}

type EntryRow = {
  id: string
  player_id: string
  status: EntryStatus
  rsvp_at: string | null
  cancelled_at: string | null
  checked_in_at: string | null
  early_bird: boolean
  chips: number | null
  points_earned: number | null
  final_position: number | null
  rebuys_count: number
  player: { name: string; avatar_url: string | null } | null
}

/** Where the caller's own check-in attempt currently sits (drives banner + button). */
type CheckIn =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'submitting' }
  | { kind: 'out-of-range' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

/** Statuses that mean the player has already taken their seat. */
const CHECKED_IN_STATUSES: ReadonlySet<EntryStatus> = new Set<EntryStatus>([
  'checked_in',
  'playing',
  'eliminated',
  'winner',
])

type Ready = {
  phase: 'ready'
  tournament: TournamentRow
  entries: EntryRow[]
  bands: Band[]
}
type State =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'not-found' }
  | Ready

const OVERLINE: Record<TournamentStatus, string> = {
  scheduled: 'Próxima',
  live: 'En vivo',
  completed: 'Jugada',
}

async function fetchDetail(id: string): Promise<State> {
  const { data: t, error: tErr } = await supabase
    .from('tournament')
    .select('id, season_id, name, scheduled_at, status, geofence_radius_m')
    .eq('id', id)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'not-found' }
  const tournament = t as TournamentRow

  const [{ data: entries, error: eErr }, { data: season, error: sErr }] = await Promise.all([
    supabase
      .from('entry')
      .select(
        'id, player_id, status, rsvp_at, cancelled_at, checked_in_at, early_bird, chips, points_earned, final_position, rebuys_count, player:player_id(name, avatar_url)',
      )
      .eq('tournament_id', id),
    supabase.from('season').select('cancel_bands').eq('id', tournament.season_id).maybeSingle(),
  ])

  if (eErr || sErr) return { phase: 'error' }

  const rows = ((entries ?? []) as EntryRow[])
    .slice()
    .sort((a, b) => statusRank(a.status) - statusRank(b.status))

  return {
    phase: 'ready',
    tournament,
    entries: rows,
    bands: parseBands((season as { cancel_bands: unknown } | null)?.cancel_bands),
  }
}

export default function FechaDetail() {
  const { id = '' } = useParams()
  const { player } = useAuth()
  const { isAdmin } = useRole()
  const navigate = useNavigate()
  const { state, setState, reload } = useLoadable<State>(
    { phase: 'loading' },
    () => fetchDetail(id),
    [id],
  )
  const [busy, setBusy] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [checkIn, setCheckIn] = useState<CheckIn>({ kind: 'idle' })
  // Non-null → show the celebratory "+2.000 fichas" sheet after a check-in.
  const [celebrate, setCelebrate] = useState<{ earlyBird: boolean; chips: number | null } | null>(
    null,
  )

  // Optimistically patch the signed-in player's entry, then refetch to reconcile.
  const patchMine = useCallback(
    (status: EntryStatus) => {
      if (!player) return
      setState((prev) => {
        if (prev.phase !== 'ready') return prev
        let found = false
        const entries = prev.entries.map((e) => {
          if (e.player_id !== player.id) return e
          found = true
          return { ...e, status }
        })
        if (!found) {
          entries.push({
            id: `optimistic-${player.id}`,
            player_id: player.id,
            status,
            rsvp_at: new Date().toISOString(),
            cancelled_at: null,
            checked_in_at: null,
            early_bird: false,
            chips: null,
            points_earned: null,
            final_position: null,
            rebuys_count: 0,
            player: { name: player.name, avatar_url: player.avatar_url },
          })
        }
        entries.sort((a, b) => statusRank(a.status) - statusRank(b.status))
        return { ...prev, entries }
      })
    },
    [player],
  )

  const doRsvp = useCallback(
    async (choice: 'confirm' | 'decline') => {
      setBusy(true)
      patchMine(choice === 'confirm' ? 'confirmed' : 'declined')
      const { error } = await supabase.rpc('rsvp', { p_tournament_id: id, p_choice: choice })
      setBusy(false)
      if (error) reload() // reconcile back to server truth on failure
      else reload()
    },
    [id, patchMine, reload],
  )

  const doCancel = useCallback(async () => {
    setBusy(true)
    setCancelOpen(false)
    patchMine('declined')
    const { error } = await supabase.rpc('cancel_rsvp', { p_tournament_id: id })
    setBusy(false)
    reload()
    if (error) console.error('cancel_rsvp failed', error.message)
  }, [id, patchMine, reload])

  // Geolocate → check_in RPC. Every failure resolves to a friendly state:
  // no GPS / denied → "pedile al admin"; outside geofence → "estás fuera".
  const doCheckIn = useCallback(async () => {
    setCheckIn({ kind: 'locating' })
    let coords: Coords
    try {
      coords = await requestPosition()
    } catch {
      setCheckIn({ kind: 'denied' })
      return
    }
    setCheckIn({ kind: 'submitting' })
    const { data, error } = await supabase.rpc('check_in', {
      p_tournament_id: id,
      p_lat: coords.lat,
      p_lng: coords.lng,
    })
    if (error) {
      const kind = classifyCheckInError(error.message)
      if (kind === 'out-of-range') setCheckIn({ kind: 'out-of-range' })
      else if (kind === 'not-live')
        setCheckIn({ kind: 'error', message: 'El torneo aún no está abierto.' })
      else setCheckIn({ kind: 'error', message: 'No se pudo hacer el check-in.' })
      return
    }
    const row = Array.isArray(data) ? data[0] : undefined
    setCheckIn({ kind: 'idle' })
    patchMine('checked_in')
    setCelebrate({ earlyBird: row?.early_bird ?? false, chips: row?.chips ?? null })
    reload()
  }, [id, patchMine, reload])

  // Admin override for a player whose GPS failed (check_in_geo_ok=false in DB).
  const doAdminCheckIn = useCallback(
    async (entryId: string) => {
      const { error } = await supabase.rpc('admin_check_in', { p_entry_id: entryId })
      if (error) console.error('admin_check_in failed', error.message)
      else reload()
    },
    [reload],
  )

  if (state.phase === 'loading') {
    return (
      <>
        <Back />
        <div className="fd-note">Cargando fecha…</div>
      </>
    )
  }
  if (state.phase === 'error') {
    return (
      <>
        <Back />
        <div className="fd-note" role="alert">
          <p>No se pudo cargar la fecha.</p>
          <button type="button" className="btn ghost sm" onClick={reload}>
            Reintentar
          </button>
        </div>
      </>
    )
  }
  if (state.phase === 'not-found') {
    return (
      <>
        <Back />
        <div className="fd-note">Esta fecha no existe.</div>
      </>
    )
  }

  const { tournament, entries, bands } = state
  const counts = attendanceCounts(entries)
  const myEntry = player ? entries.find((e) => e.player_id === player.id) ?? null : null
  const scheduled = tournament.status === 'scheduled'
  const live = tournament.status === 'live'
  const canCheckIn = live && myEntry?.status === 'confirmed'
  const alreadyCheckedIn = live && myEntry != null && CHECKED_IN_STATUSES.has(myEntry.status)
  const locating = checkIn.kind === 'locating' || checkIn.kind === 'submitting'

  return (
    <>
      <Back />
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">{OVERLINE[tournament.status]}</span>
          <h1>{tournament.name}</h1>
        </div>
      </div>
      <div className="tc-sub" style={{ padding: '0 18px 4px' }}>
        {formatWhen(tournament.scheduled_at)}
      </div>
      <div className="rule faint" />

      <div className="att-head" data-testid="att-head">
        <ChipCount tone="confirmed" n={counts.voy} label="Voy" />
        <ChipCount tone="declined" n={counts.cancelaron} label="Cancelaron" />
        <ChipCount tone="none" n={counts.sinResp} label="Sin resp." />
      </div>

      {scheduled && player && (
        <div className="btn-row">
          <RsvpActions status={myEntry?.status} busy={busy} onRsvp={doRsvp} onCancel={() => setCancelOpen(true)} />
        </div>
      )}
      {canCheckIn && (
        <>
          <GeoBanner state={checkIn} radius={tournament.geofence_radius_m} />
          <div className="btn-row">
            <button
              type="button"
              className="btn blood full"
              disabled={locating}
              onClick={doCheckIn}
            >
              {checkIn.kind === 'locating'
                ? 'Ubicando…'
                : checkIn.kind === 'submitting'
                  ? 'Confirmando…'
                  : '📍 Hacer check-in'}
            </button>
          </div>
        </>
      )}
      {live && (
        <div className="btn-row">
          {alreadyCheckedIn && (
            <button type="button" className="btn full" disabled>
              ✓ Ya hiciste check-in
            </button>
          )}
          <Link className="btn blood full" to="/vivo">
            Ir a En Vivo
          </Link>
        </div>
      )}

      <div className="plist">
        {entries.map((e) => (
          <PlayerAttendanceRow
            key={e.id}
            entry={e}
            isMe={player?.id === e.player_id}
            canAdminCheckIn={isAdmin && live && e.status === 'confirmed'}
            onAdminCheckIn={doAdminCheckIn}
          />
        ))}
      </div>

      <CancelSheet
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={doCancel}
        bands={bands}
        scheduledAt={tournament.scheduled_at}
      />

      <CheckInCelebration celebrate={celebrate} onClose={() => setCelebrate(null)} />
    </>
  )

  function Back() {
    return (
      <button type="button" className="back" onClick={() => navigate('/fechas')}>
        ← Fechas
      </button>
    )
  }
}

function RsvpActions({
  status,
  busy,
  onRsvp,
  onCancel,
}: {
  status: EntryStatus | undefined
  busy: boolean
  onRsvp: (choice: 'confirm' | 'decline') => void
  onCancel: () => void
}) {
  if (status === 'confirmed') {
    return (
      <>
        <button type="button" className="btn full" disabled title="Check-in disponible cuando el torneo abra">
          📍 Check-in (próximamente)
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </>
    )
  }
  if (status === 'declined') {
    return (
      <button type="button" className="btn primary full" disabled={busy} onClick={() => onRsvp('confirm')}>
        Voy — confirmar asistencia
      </button>
    )
  }
  // invited / no entry yet
  return (
    <>
      <button type="button" className="btn blood" style={{ flex: 2 }} disabled={busy} onClick={() => onRsvp('confirm')}>
        Voy
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => onRsvp('decline')}>
        No voy
      </button>
    </>
  )
}

function ChipCount({ tone, n, label }: { tone: string; n: number; label: string }) {
  return (
    <div className="chip-count">
      <span className={`dot ${tone}`} />
      <span className="n">{n}</span>
      <span className="l">{label}</span>
    </div>
  )
}

function PlayerAttendanceRow({
  entry,
  isMe,
  canAdminCheckIn,
  onAdminCheckIn,
}: {
  entry: EntryRow
  isMe: boolean
  canAdminCheckIn: boolean
  onAdminCheckIn: (entryId: string) => void
}) {
  const pill = statusPill(entry.status)
  const name = entry.player?.name ?? 'Jugador'
  return (
    <div className="prow" data-testid="prow">
      <Avatar name={name} url={entry.player?.avatar_url} size={36} />
      <div className="pinfo">
        <b>
          {name}
          {isMe ? ' · tú' : ''}
        </b>
        <div className="sub">{noteFor(entry)}</div>
      </div>
      {canAdminCheckIn ? (
        <button
          type="button"
          className="btn sm blood admin-checkin"
          onClick={() => onAdminCheckIn(entry.id)}
        >
          Registrar
        </button>
      ) : (
        <span className={`status ${pill.cls}`}>{pill.label}</span>
      )}
    </div>
  )
}

// Geofence banner (ported from the prototype `.geo`): neutral while idle,
// oxblood "warn" variant when the caller is out of range or GPS failed.
function GeoBanner({ state, radius }: { state: CheckIn; radius: number }) {
  if (state.kind === 'out-of-range') {
    return (
      <div className="geo warn" role="alert">
        <span className="ring">✕</span>
        <div>
          Estás <b className="ok">fuera de la sede</b>. Acercate al lugar (radio {radius} m) e
          intentá de nuevo.
        </div>
      </div>
    )
  }
  if (state.kind === 'denied') {
    return (
      <div className="geo warn" role="alert">
        <span className="ring">!</span>
        <div>
          No pudimos leer tu ubicación.
          <br />
          <span style={{ color: 'var(--ink-3)' }}>Pedile al admin que te registre.</span>
        </div>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="geo warn" role="alert">
        <span className="ring">!</span>
        <div>{state.message}</div>
      </div>
    )
  }
  return (
    <div className="geo">
      <span className="ring">📍</span>
      <div>
        Hacé <b className="ok">check-in</b> cuando estés en la sede.
        <br />
        <span style={{ color: 'var(--ink-3)' }}>
          Radio {radius} m · sin GPS, el admin te registra.
        </span>
      </div>
    </div>
  )
}

// Celebratory sheet after a successful check-in — the "+2.000 fichas" moment
// when the player arrived early (early_bird), a plain confirmation otherwise.
function CheckInCelebration({
  celebrate,
  onClose,
}: {
  celebrate: { earlyBird: boolean; chips: number | null } | null
  onClose: () => void
}) {
  const chipsLabel =
    celebrate?.chips != null ? `${celebrate.chips.toLocaleString('es-CR')} fichas` : null
  return (
    <Sheet
      open={celebrate != null}
      onClose={onClose}
      title={celebrate?.earlyBird ? '¡Llegaste temprano!' : '¡Check-in listo!'}
    >
      <div className="celebrate">
        {celebrate?.earlyBird ? (
          <>
            <div className="big">+2.000 fichas</div>
            <div className="sub">
              Bonus por llegar antes del arranque.
              {chipsLabel ? ` Arrancás con ${chipsLabel}.` : ''}
            </div>
          </>
        ) : (
          <div className="sub">
            Check-in confirmado.{chipsLabel ? ` Arrancás con ${chipsLabel}.` : ''}
          </div>
        )}
      </div>
      <div className="btn-row">
        <button type="button" className="btn blood full" onClick={onClose}>
          Listo
        </button>
      </div>
    </Sheet>
  )
}

function noteFor(e: EntryRow): string {
  switch (e.status) {
    case 'confirmed':
      return 'Confirmado · falta check-in'
    case 'declined':
      return e.points_earned != null && e.points_earned < 0
        ? `Canceló · −${Math.abs(e.points_earned)} pts`
        : 'Canceló · sin castigo'
    case 'invited':
      return 'Sin responder'
    case 'checked_in':
      return e.early_bird ? 'Check-in · +2.000 fichas' : 'Check-in listo'
    case 'playing':
      return e.rebuys_count > 0 ? `En juego · ↺ ${e.rebuys_count}` : 'En juego'
    case 'no_show':
      return 'Confirmó y no llegó · −15 pts'
    case 'eliminated':
      return e.final_position != null ? `${e.final_position}º lugar` : 'Eliminado'
    case 'winner':
      return '¡Campeón!'
    default:
      return ''
  }
}

function CancelSheet({
  open,
  onClose,
  onConfirm,
  bands,
  scheduledAt,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  bands: Band[]
  scheduledAt: string
}) {
  const hours = hoursUntil(scheduledAt)
  const active = pickBand(bands, hours)
  const sorted = [...bands].sort((a, b) => b.hours_before - a.hours_before)
  const penaltyLabel = active.penalty === 0 ? '0' : `−${Math.abs(active.penalty)}`

  return (
    <Sheet open={open} onClose={onClose} title="Cancelar asistencia">
      <p>
        Faltan <b>~{Math.round(hours)} h</b> para el inicio. Cancelar ahora tiene una penalización de{' '}
        <b style={{ color: 'var(--oxblood)' }}>{penaltyLabel} pts</b>.
      </p>
      <div className="bands" data-testid="bands">
        {sorted.map((b) => (
          <div
            key={b.hours_before}
            className={`br ${b.hours_before === active.hours_before ? 'here' : ''}`}
          >
            <span>
              {bandLabel(b, bands)}
              {b.hours_before === active.hours_before ? ' · estás aquí' : ''}
            </span>
            <b>{b.penalty === 0 ? '0' : `−${Math.abs(b.penalty)}`}</b>
          </div>
        ))}
      </div>
      <div className="btn-row">
        <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
          Volver
        </button>
        <button type="button" className="btn blood" style={{ flex: 1 }} onClick={onConfirm}>
          Cancelar ({penaltyLabel})
        </button>
      </div>
    </Sheet>
  )
}
