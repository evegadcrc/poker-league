import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import Avatar from '@/components/Avatar'
import Sheet from '@/components/Sheet'
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
}

type EntryRow = {
  id: string
  player_id: string
  status: EntryStatus
  rsvp_at: string | null
  cancelled_at: string | null
  checked_in_at: string | null
  early_bird: boolean
  points_earned: number | null
  final_position: number | null
  rebuys_count: number
  player: { name: string; avatar_url: string | null } | null
}

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
    .select('id, season_id, name, scheduled_at, status')
    .eq('id', id)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'not-found' }
  const tournament = t as TournamentRow

  const [{ data: entries, error: eErr }, { data: season, error: sErr }] = await Promise.all([
    supabase
      .from('entry')
      .select(
        'id, player_id, status, rsvp_at, cancelled_at, checked_in_at, early_bird, points_earned, final_position, rebuys_count, player:player_id(name, avatar_url)',
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
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let active = true
    setState({ phase: 'loading' })
    void fetchDetail(id).then((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
    }
  }, [id, attempt])

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
      {tournament.status === 'live' && (
        <div className="btn-row">
          <Link className="btn blood full" to="/vivo">
            Ir a En Vivo
          </Link>
        </div>
      )}

      <div className="plist">
        {entries.map((e) => (
          <PlayerAttendanceRow key={e.id} entry={e} isMe={player?.id === e.player_id} />
        ))}
      </div>

      <CancelSheet
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={doCancel}
        bands={bands}
        scheduledAt={tournament.scheduled_at}
      />
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

function PlayerAttendanceRow({ entry, isMe }: { entry: EntryRow; isMe: boolean }) {
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
      <span className={`status ${pill.cls}`}>{pill.label}</span>
    </div>
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
