import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useLoadable } from '@/lib/useLoadable'
import Avatar from '@/components/Avatar'
import Galeria, { galleryUrl } from '@/components/Galeria'
import PrizeList from '@/components/PrizeList'
import Sheet from '@/components/Sheet'
import { chopAdjustedPrizes } from '@/lib/admin'
import { classifyCheckInError, requestPosition, type Coords } from '@/lib/checkin'
import { formatMiles } from '@/lib/format'
import { parsePrizes, type Prize } from '@/lib/live'
import {
  attendanceCounts,
  bandLabel,
  formatWhen,
  hoursUntil,
  parseBands,
  parseLeagueConfig,
  pickBand,
  statusPill,
  statusRank,
  toDatetimeLocal,
  type Band,
  type EntryStatus,
  type LeagueConfig,
  type TournamentStatus,
} from '@/lib/fechas'

type TournamentRow = {
  id: string
  season_id: string
  name: string
  scheduled_at: string
  status: TournamentStatus
  geofence_radius_m: number
  cover_url: string | null
  counts_for_league: boolean
  prizes: unknown
  buy_in: number
  rebuy_amount: number | null
  starting_stack: number | null
  cancelled_at: string | null
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
  chopped: boolean
  chop_group: number | null
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
  /** Season scoring config for the "cómo se juega" info card. */
  config: LeagueConfig
  /** Final materialized prizes (set_prizes → tournament.prizes); [] pre-final. */
  prizes: Prize[]
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
    .select(
      'id, season_id, name, scheduled_at, status, geofence_radius_m, cover_url, counts_for_league, prizes, buy_in, rebuy_amount, starting_stack, cancelled_at',
    )
    .eq('id', id)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'not-found' }
  const tournament = t as TournamentRow

  const [{ data: entries, error: eErr }, { data: season, error: sErr }] = await Promise.all([
    supabase
      .from('entry')
      .select(
        'id, player_id, status, rsvp_at, cancelled_at, checked_in_at, early_bird, chips, points_earned, final_position, chopped, chop_group, rebuys_count, player:player_id(name, avatar_url)',
      )
      .eq('tournament_id', id),
    supabase
      .from('season')
      .select(
        'cancel_bands, points_multiplier, bonus_final_table, bonus_attendance, no_show_penalty, early_bird_bonus_chips, top_finish_bonuses',
      )
      .eq('id', tournament.season_id)
      .maybeSingle(),
  ])

  if (eErr || sErr) return { phase: 'error' }

  const rows = ((entries ?? []) as EntryRow[])
    .slice()
    .sort((a, b) => statusRank(a.status) - statusRank(b.status))

  const seasonRow = (season ?? null) as { cancel_bands?: unknown } | null

  return {
    phase: 'ready',
    tournament,
    entries: rows,
    bands: parseBands(seasonRow?.cancel_bands),
    config: parseLeagueConfig(seasonRow),
    prizes: parsePrizes(tournament.prizes),
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
            chopped: false,
            chop_group: null,
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
      if (error) console.error('rsvp failed', error.message)
      // Silent reconcile: keep the optimistic patch on screen (no skeleton
      // flash) while the refetch confirms/corrects it against server truth.
      reload({ silent: true })
    },
    [id, patchMine, reload],
  )

  const doCancel = useCallback(async () => {
    setBusy(true)
    setCancelOpen(false)
    patchMine('declined')
    const { error } = await supabase.rpc('cancel_rsvp', { p_tournament_id: id })
    setBusy(false)
    reload({ silent: true })
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
    // Silent so the "+2.000 fichas" celebration isn't unmounted by a skeleton
    // flash while the refetch reconciles the optimistic check-in.
    reload({ silent: true })
  }, [id, patchMine, reload])

  // Admin override for a player whose GPS failed (check_in_geo_ok=false in DB).
  const doAdminCheckIn = useCallback(
    async (entryId: string) => {
      const { error } = await supabase.rpc('admin_check_in', { p_entry_id: entryId })
      if (error) console.error('admin_check_in failed', error.message)
      else reload({ silent: true })
    },
    [reload],
  )

  // Admin edited the scheduled start (0017 admin-only tournament UPDATE): patch
  // the displayed date/time immediately, then reconcile against server truth.
  const patchSchedule = useCallback(
    (iso: string) => {
      setState((prev) =>
        prev.phase === 'ready'
          ? { ...prev, tournament: { ...prev.tournament, scheduled_at: iso } }
          : prev,
      )
      reload({ silent: true })
    },
    [setState, reload],
  )

  // Admin: mark a scheduled/live fecha as cancelled (soft flag via the admin-only
  // tournament UPDATE policy, 0017). The row stays; it just stops being runnable.
  const doCancelFecha = useCallback(async () => {
    if (
      !window.confirm(
        '¿Cancelar esta fecha? Quedará marcada como cancelada y no se podrá abrir ni jugar.',
      )
    )
      return
    setBusy(true)
    const { error } = await supabase
      .from('tournament')
      .update({ cancelled_at: new Date().toISOString() })
      .eq('id', id)
    setBusy(false)
    if (error) {
      console.error('cancel fecha failed', error.message)
      return
    }
    reload({ silent: true })
  }, [id, reload])

  // Admin: hard-delete a fecha created by mistake (delete_tournament RPC removes
  // its gallery + entries + the row), then return to the fechas list.
  const doDeleteFecha = useCallback(async () => {
    if (
      !window.confirm(
        '¿Eliminar esta fecha para siempre? Se borrarán sus inscripciones y fotos. Esta acción no se puede deshacer.',
      )
    )
      return
    setBusy(true)
    const { error } = await supabase.rpc('delete_tournament', { p_id: id })
    setBusy(false)
    if (error) {
      console.error('delete fecha failed', error.message)
      return
    }
    navigate('/fechas')
  }, [id, navigate])

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
          <button type="button" className="btn ghost sm" onClick={() => reload()}>
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

  const { tournament, entries, bands, config, prizes } = state
  const counts = attendanceCounts(entries)
  const myEntry = player ? entries.find((e) => e.player_id === player.id) ?? null : null
  const scheduled = tournament.status === 'scheduled'
  const live = tournament.status === 'live'
  const completed = tournament.status === 'completed'
  // A cancelled fecha keeps its row + status but can no longer be opened/played/
  // checked-in — every "run" affordance is gated on `runnable`.
  const cancelled = tournament.cancelled_at != null
  const runnable = !cancelled
  const canCheckIn = live && runnable && myEntry?.status === 'confirmed'
  const alreadyCheckedIn = live && myEntry != null && CHECKED_IN_STATUSES.has(myEntry.status)
  const locating = checkIn.kind === 'locating' || checkIn.kind === 'submitting'
  // Completed fecha: the ACTUAL payout per place — the materialized
  // tournament.prizes, chop-adjusted (a chopped top splits its pooled slots
  // equally). Standalone fechas are still played for money → show it too.
  const finalPrizes = completed ? chopAdjustedPrizes(prizes, entries) : []

  return (
    <>
      <Back />
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">{OVERLINE[tournament.status]}</span>
          <h1>{tournament.name}</h1>
        </div>
        {cancelled && (
          <span className="badge cancelled" data-testid="fd-cancelled">
            Cancelada
          </span>
        )}
      </div>
      <div className="tc-sub" style={{ padding: '0 18px 4px' }}>
        {formatWhen(tournament.scheduled_at)}
      </div>
      {scheduled && isAdmin && !cancelled && (
        <ScheduleEditor
          tournamentId={tournament.id}
          scheduledAt={tournament.scheduled_at}
          onSaved={patchSchedule}
        />
      )}
      {scheduled && (
        <div className="fd-buyin" data-testid="fd-buyin">
          <span className="fd-buyin-k">Buy-in</span>
          <span className="fd-buyin-v">₡{formatMiles(tournament.buy_in ?? 0)}</span>
        </div>
      )}
      {isAdmin && (
        <AdminFechaActions
          status={tournament.status}
          cancelled={cancelled}
          busy={busy}
          onCancel={doCancelFecha}
          onDelete={doDeleteFecha}
        />
      )}
      {tournament.counts_for_league === false && (
        <div className="fd-standalone" data-testid="fd-standalone">
          Amistoso · no suma a la liga
        </div>
      )}
      <div className="rule faint" />

      <div className="att-head" data-testid="att-head">
        <ChipCount tone="confirmed" n={counts.voy} label="Voy" />
        <ChipCount tone="declined" n={counts.cancelaron} label="Cancelaron" />
        <ChipCount tone="none" n={counts.sinResp} label="Sin resp." />
      </div>

      {scheduled && runnable && player && (
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
      {live && runnable && (
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
            completed={completed}
            canAdminCheckIn={isAdmin && live && e.status === 'confirmed'}
            onAdminCheckIn={doAdminCheckIn}
          />
        ))}
      </div>

      {finalPrizes.length > 0 && (
        <PrizeList prizes={finalPrizes} formatAmount={(n) => `₡${formatMiles(n)}`} />
      )}

      <FechaInfo tournament={tournament} config={config} />

      {isAdmin && (
        <CoverControl
          tournamentId={tournament.id}
          uploaderId={player?.id ?? null}
          coverUrl={tournament.cover_url}
          onUpdated={() => reload({ silent: true })}
        />
      )}

      <Galeria tournamentId={tournament.id} />

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

// Admin-only inline editor for a SCHEDULED fecha's start date/time. Writes
// tournament.scheduled_at via the admin-only UPDATE policy (mig 0017) — the same
// direct-.update() path CoverControl uses. datetime-local values are local time;
// new Date(value).toISOString() converts back to the stored timestamptz.
function ScheduleEditor({
  tournamentId,
  scheduledAt,
  onSaved,
}: {
  tournamentId: string
  scheduledAt: string
  onSaved: (iso: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(() => toDatetimeLocal(scheduledAt))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(() => {
    setValue(toDatetimeLocal(scheduledAt))
    setError(null)
    setEditing(true)
  }, [scheduledAt])

  const save = useCallback(async () => {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) {
      setError('Fecha inválida.')
      return
    }
    setBusy(true)
    setError(null)
    const iso = d.toISOString()
    const { error: err } = await supabase
      .from('tournament')
      .update({ scheduled_at: iso })
      .eq('id', tournamentId)
    setBusy(false)
    if (err) {
      setError('No se pudo guardar la fecha y hora.')
      return
    }
    setEditing(false)
    onSaved(iso)
  }, [value, tournamentId, onSaved])

  if (!editing) {
    return (
      <div className="fd-sched-edit">
        <button
          type="button"
          className="icon-btn"
          data-testid="sched-edit-open"
          aria-label="Editar fecha y hora"
          title="Editar fecha y hora"
          onClick={open}
        >
          <CalendarIcon />
        </button>
      </div>
    )
  }

  return (
    <div className="fd-sched-edit" data-testid="sched-editor">
      <input
        type="datetime-local"
        className="fd-sched-input"
        aria-label="Fecha y hora de la fecha"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="btn-row">
        <button
          type="button"
          className="btn ghost"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="btn primary"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      {error && (
        <div className="fd-note" role="alert">
          <p>{error}</p>
        </div>
      )}
    </div>
  )
}

// Inline lucide-style "calendar" glyph. lucide-react is not a dependency, so the
// icon buttons in this app stay self-contained (SVG / emoji); this is the same
// Calendar path lucide ships. Decorative — the button carries the aria-label.
function CalendarIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </svg>
  )
}

// Admin management for a fecha: soft-cancel a scheduled/live fecha (keeps the row
// + history, just stops it being runnable) and hard-delete a fecha created by
// mistake (delete_tournament RPC). Both confirm before acting (in the handlers).
function AdminFechaActions({
  status,
  cancelled,
  busy,
  onCancel,
  onDelete,
}: {
  status: TournamentStatus
  cancelled: boolean
  busy: boolean
  onCancel: () => void
  onDelete: () => void
}) {
  const canCancel = (status === 'scheduled' || status === 'live') && !cancelled
  // Delete is only for mistakes: a scheduled fecha, or any already-cancelled one.
  // A COMPLETED fecha holds real results + gallery, and a LIVE (uncancelled) fecha
  // is in progress — neither may be deleted (cancel a live fecha first).
  const canDelete = cancelled || status === 'scheduled'
  return (
    <div className="fd-admin-actions" data-testid="fd-admin-actions">
      {canCancel && (
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy}
          onClick={onCancel}
          data-testid="fd-cancel-fecha"
        >
          Cancelar fecha
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className="btn blood sm"
          disabled={busy}
          onClick={onDelete}
          data-testid="fd-delete-fecha"
        >
          Eliminar fecha
        </button>
      )}
    </div>
  )
}

// Collapsible "Entrada y fichas" card — fecha-SPECIFIC entry info (buy-in, rebuy,
// starting stack, early-bird chips). The general scoring explainer ("cómo se
// ganan puntos") now lives on the Liga (leaderboard) view, not here.
function FechaInfo({ tournament, config }: { tournament: TournamentRow; config: LeagueConfig }) {
  const [open, setOpen] = useState(false)
  const rebuy =
    tournament.rebuy_amount != null ? `₡${formatMiles(tournament.rebuy_amount)}` : 'No aplica'

  return (
    <section className="fd-info" data-testid="fd-info-section">
      <button
        type="button"
        className="calc-rankings-toggle"
        aria-expanded={open}
        aria-controls="fd-info-body"
        data-testid="fd-info-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Entrada y fichas</span>
        <span className="chev" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="calc-rankings-body" id="fd-info-body">
          <div className="fd-info-block">
            <InfoRow label="Buy-in" value={`₡${formatMiles(tournament.buy_in ?? 0)}`} />
            <InfoRow label="Recompra" value={rebuy} />
            <InfoRow
              label="Stack inicial"
              value={`${formatMiles(tournament.starting_stack ?? 0)} fichas`}
            />
            <InfoRow
              label="Llegada temprana"
              value={`+${formatMiles(config.earlyBirdChips)} fichas`}
            />
          </div>
        </div>
      )}
    </section>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fd-info-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
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
  completed,
  canAdminCheckIn,
  onAdminCheckIn,
}: {
  entry: EntryRow
  isMe: boolean
  completed: boolean
  canAdminCheckIn: boolean
  onAdminCheckIn: (entryId: string) => void
}) {
  const pill = statusPill(entry.status)
  const name = entry.player?.name ?? 'Jugador'
  // On a COMPLETED fecha, finishers and no-shows swap their CAMPEÓN / FUERA /
  // no-show status badge for their finishing PLACE + the POINTS they earned that
  // fecha (entry.points_earned = the fn_tournament_points engine value).
  const result = completed ? fechaResult(entry) : null
  return (
    <div className="prow" data-testid="prow">
      <Avatar name={name} url={entry.player?.avatar_url} size={36} />
      <div className="pinfo">
        <b>
          {name}
          {isMe ? ' · tú' : ''}
        </b>
        {!result && <div className="sub">{noteFor(entry)}</div>}
      </div>
      {canAdminCheckIn ? (
        <button
          type="button"
          className="btn sm blood admin-checkin"
          onClick={() => onAdminCheckIn(entry.id)}
        >
          Registrar
        </button>
      ) : result ? (
        <FechaResult result={result} />
      ) : (
        <span className={`status ${pill.cls}`}>{pill.label}</span>
      )}
    </div>
  )
}

/** Completed-fecha per-player outcome shown in place of the status badge. */
type FechaResultData =
  | { kind: 'place'; place: number; isChamp: boolean; points: number }
  | { kind: 'noshow'; points: number }

/**
 * For a completed fecha, the outcome to render for one entry — or null for rows
 * that keep their ordinary status pill (declined / invited / non-participants).
 * Ranked finishers show their place; chopped co-champions share `1º` (they sit
 * at the top K positions) and keep the champion accent.
 */
function fechaResult(e: EntryRow): FechaResultData | null {
  if (e.final_position != null) {
    return {
      kind: 'place',
      place: e.chopped ? 1 : e.final_position,
      isChamp: e.chopped || e.final_position === 1,
      points: e.points_earned ?? 0,
    }
  }
  if (e.status === 'no_show') {
    return { kind: 'noshow', points: e.points_earned ?? 0 }
  }
  return null
}

/** Signed points label: "+34 pts", "−15 pts", "0 pts" (U+2212 minus). */
function signedPoints(pts: number): string {
  if (pts > 0) return `+${pts} pts`
  if (pts < 0) return `−${Math.abs(pts)} pts`
  return '0 pts'
}

// Podium markers for the non-champion places: silver 2nd, bronze 3rd. The
// champion (1º / chopped co-champion) keeps the crown idiom below; places 4+
// show no marker. `cls` tints the place ordinal per medal via App.css tokens.
const PODIUM_MEDAL: Record<number, { glyph: string; cls: string }> = {
  2: { glyph: '🥈', cls: 'silver' },
  3: { glyph: '🥉', cls: 'bronze' },
}

function FechaResult({ result }: { result: FechaResultData }) {
  if (result.kind === 'noshow') {
    return (
      <div className="fd-result" data-testid="fd-result">
        <span className="status s-noshow">No Show</span>
        <span className="pts neg">{signedPoints(result.points)}</span>
      </div>
    )
  }
  const medal = result.isChamp ? null : PODIUM_MEDAL[result.place]
  return (
    <div className="fd-result" data-testid="fd-result">
      <span className={cn('place', result.isChamp && 'champ', medal?.cls)}>
        {result.isChamp ? (
          <span className="crown" aria-hidden="true">
            👑
          </span>
        ) : medal ? (
          <span className="medal" data-testid="fd-medal" data-place={result.place} aria-hidden="true">
            {medal.glyph}
          </span>
        ) : null}
        {result.place}º
      </span>
      <span className={cn('pts', result.points < 0 ? 'neg' : 'pos')}>
        {signedPoints(result.points)}
      </span>
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

// Admin-only: set / change this fecha's history cover. Uploads to the public
// `gallery` bucket (under the admin's own player-id folder so the storage RLS
// matches) then writes tournament.cover_url via the existing "admin update
// tournament" policy (0001). The history list (Fechas) renders it full-bleed.
function CoverControl({
  tournamentId,
  uploaderId,
  coverUrl,
  onUpdated,
}: {
  tournamentId: string
  uploaderId: string | null
  coverUrl: string | null
  onUpdated: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file || !uploaderId) return
      setBusy(true)
      setError(null)
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
      const path = `${uploaderId}/covers/${tournamentId}-${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('gallery')
        .upload(path, file, { contentType: file.type || undefined })
      if (upErr) {
        setBusy(false)
        setError('No se pudo subir la portada. Probá de nuevo.')
        return
      }
      const publicUrl = galleryUrl(path)
      const { error: updErr } = await supabase
        .from('tournament')
        .update({ cover_url: publicUrl })
        .eq('id', tournamentId)
      setBusy(false)
      if (updErr) {
        setError('La portada se subió, pero no se pudo guardar.')
        return
      }
      onUpdated()
    },
    [tournamentId, uploaderId, onUpdated],
  )

  return (
    <section className="cover-admin" data-testid="cover-admin">
      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Portada</span>
        </div>
        <button
          type="button"
          className="upload-icon"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          aria-label={coverUrl ? 'Cambiar portada' : 'Subir portada'}
          title={busy ? 'Subiendo…' : coverUrl ? 'Cambiar portada' : 'Subir portada'}
          data-testid="cover-upload"
        >
          🖼️
        </button>
      </div>
      {coverUrl && (
        <div
          className="cover-preview"
          style={{ backgroundImage: `url("${coverUrl}")` }}
          data-testid="cover-preview"
          role="img"
          aria-label="Portada de la fecha"
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label="Subir portada"
        onChange={onFile}
        disabled={busy}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
      />
      {error && (
        <div className="fd-note" role="alert">
          <p>{error}</p>
        </div>
      )}
    </section>
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
