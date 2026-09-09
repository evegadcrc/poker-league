import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { useLoadable } from '@/lib/useLoadable'
import Avatar from '@/components/Avatar'
import AvatarLightbox from '@/components/AvatarLightbox'
import ConvocatoriaSheet from '@/components/ConvocatoriaSheet'
import PhotoLightbox from '@/components/PhotoLightbox'
import ImageCropper from '@/components/ImageCropper'
import PlayerStatsSheet from '@/components/PlayerStatsSheet'
import Galeria, { galleryUrl } from '@/components/Galeria'
import PrizeList from '@/components/PrizeList'
import Sheet from '@/components/Sheet'
import { chopAdjustedPrizes, pointsBreakdown, type PointsBreakdown, type ScoringConfig } from '@/lib/admin'
import { classifyCheckInError, requestPosition, type Coords } from '@/lib/checkin'
import { formatMiles } from '@/lib/format'
import { parsePrizes, type Prize } from '@/lib/live'
import ShareSheet from '@/components/ShareSheet'
import { convocatoriaText, fechaSummaryText, whatsappShareUrl, writeClipboard } from '@/lib/summary'
import {
  CHECKIN_WINDOW_MS,
  attendanceCounts,
  attendanceSort,
  bandLabel,
  computePot,
  formatCountdown,
  formatWhen,
  hoursUntil,
  parseBands,
  parseLeagueConfig,
  pickBand,
  playedCount,
  statusPill,
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
  guests_open: boolean
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
  paid: boolean
  made_final_table: boolean
  chopped: boolean
  chop_group: number | null
  rebuys_count: number
  player: { name: string; avatar_url: string | null; is_guest?: boolean } | null
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
      'id, season_id, name, scheduled_at, status, geofence_radius_m, cover_url, counts_for_league, guests_open, prizes, buy_in, rebuy_amount, starting_stack, cancelled_at',
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
        'id, player_id, status, rsvp_at, cancelled_at, checked_in_at, early_bird, chips, points_earned, final_position, paid, made_final_table, chopped, chop_group, rebuys_count, player:player_id(name, avatar_url, is_guest)',
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

  const rows = ((entries ?? []) as EntryRow[]).slice().sort(attendanceSort)

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

/** A seconds-precision countdown is visible: scheduled, not cancelled, and
 *  check-in opens within the hour (or already did — the pre-live window). */
function needsFastTick(state: State, now: number): boolean {
  if (state.phase !== 'ready') return false
  const t = state.tournament
  if (t.status !== 'scheduled' || t.cancelled_at != null) return false
  const opensAt = new Date(t.scheduled_at).getTime() - CHECKIN_WINDOW_MS
  return Number.isFinite(opensAt) && opensAt - now < CHECKIN_WINDOW_MS
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
  // True → the "late check-in (no bonus)" warning sheet is showing. A live check-
  // in must confirm through it first; a pre-live check-in proceeds directly.
  const [lateWarnOpen, setLateWarnOpen] = useState(false)
  // Non-null → the cover hero is expanded in a full-screen lightbox.
  const [coverZoom, setCoverZoom] = useState(false)
  // Non-null → the "Abrir fecha" RPC failed (e.g. it's no longer scheduled).
  const [openError, setOpenError] = useState<string | null>(null)
  const [checkIn, setCheckIn] = useState<CheckIn>({ kind: 'idle' })
  // Non-null → show the celebratory "+2.000 fichas" sheet after a check-in.
  const [celebrate, setCelebrate] = useState<{ earlyBird: boolean; chips: number | null } | null>(
    null,
  )
  // Reactive wall-clock (ms) so the pre-live window (opens 1h before the start)
  // flips on its own without a manual reload. Mirrors Live.tsx's clock tick, but
  // coarser (30s) — the only boundary that matters here is the 1h mark.
  const [now, setNow] = useState(() => Date.now())
  // 1s while a countdown with seconds is on screen (check-in opens within the
  // hour, or the pre-live run-up to the start); 30s otherwise.
  const fastTick = needsFastTick(state, now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fastTick ? 1_000 : 30_000)
    return () => clearInterval(timer)
  }, [fastTick])

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
            paid: false,
            made_final_table: false,
            chopped: false,
            chop_group: null,
            rebuys_count: 0,
            player: { name: player.name, avatar_url: player.avatar_url },
          })
        }
        entries.sort(attendanceSort)
        return { ...prev, entries }
      })
    },
    [player],
  )

  // After a successful "Voy": offer the updated roster for the group chat.
  const [shareOpen, setShareOpen] = useState(false)

  const doRsvp = useCallback(
    async (choice: 'confirm' | 'decline') => {
      setBusy(true)
      patchMine(choice === 'confirm' ? 'confirmed' : 'declined')
      const { error } = await supabase.rpc('rsvp', { p_tournament_id: id, p_choice: choice })
      setBusy(false)
      if (error) console.error('rsvp failed', error.message)
      else if (choice === 'confirm') setShareOpen(true)
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

  // Admin registration desk (pre-live / live): confirm a player's buy-in payment
  // (confirm_payment RPC, mig 0009 — admin-gated, no status check → works while
  // scheduled). Marks the entry paid so it counts toward the pot.
  const doConfirmPayment = useCallback(
    async (entryId: string) => {
      const { error } = await supabase.rpc('confirm_payment', { p_entry_id: entryId })
      if (error) console.error('confirm_payment failed', error.message)
      else reload({ silent: true })
    },
    [reload],
  )

  // Realtime: reflect console-driven changes (busts / undos / rebuys / opens)
  // in this Fecha view. Mirrors Live.tsx — subscribe to this tournament's row
  // (clock/status) and its entries (standings/points), and silently reload on
  // any change. postgres_changes carries STATE only, never per-tick updates. A
  // silent reload keeps the current screen (no skeleton flash) while it syncs;
  // resubscribe resyncs after a (re)connect so the view never drifts.
  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`fecha:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament', filter: `id=eq.${id}` },
        () => {
          reload({ silent: true })
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'entry', filter: `tournament_id=eq.${id}` },
        () => {
          reload({ silent: true })
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') reload({ silent: true })
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [id, reload])

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

  // Admin: open a scheduled fecha → live (open_tournament RPC, mig 0005). It sizes
  // the final table and materializes prizes. Check-in becomes a bonus-only action
  // once live (no early-bird bonus, mig 0031): confirmed players who haven't
  // checked in STAY in the fecha — only an admin's mark_no_show sets no_show. On
  // success the admin lands on the live view (/vivo) to run the clock / open the
  // Consola; the RPC raises if the fecha is no longer scheduled (already live /
  // completed).
  const doOpenFecha = useCallback(async () => {
    if (
      !window.confirm(
        '¿Abrir la fecha? Empieza el juego. Los que ya hicieron check-in a tiempo tienen su bono; después de abrir, el check-in ya no da bono.',
      )
    )
      return
    setBusy(true)
    setOpenError(null)
    const { error } = await supabase.rpc('open_tournament', { p_tournament_id: id })
    setBusy(false)
    if (error) {
      console.error('open_tournament failed', error.message)
      setOpenError('No se pudo abrir la fecha. Puede que ya no esté programada.')
      return
    }
    navigate('/vivo')
  }, [id, navigate])

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
  // Pre-live window: the fecha is still `scheduled` but the game night is close
  // enough (≤1h before the scheduled start) that check-in + payments open. No new
  // DB status — it's a purely time-derived UI state (reactive via the `now` tick).
  const scheduledAtMs = new Date(tournament.scheduled_at).getTime()
  const preLive =
    scheduled && runnable && Number.isFinite(scheduledAtMs) && now >= scheduledAtMs - CHECKIN_WINDOW_MS
  // Check-in is gated to the pre-live window (or once live): a confirmed player
  // sees it only within the 1h run-up or after open — not days early.
  const canCheckIn = (preLive || live) && runnable && myEntry?.status === 'confirmed'
  const alreadyCheckedIn = live && myEntry != null && CHECKED_IN_STATUSES.has(myEntry.status)
  // A late arrival can still confirm ("Voy") after the fecha is opened: show it
  // to a live, runnable player who has NOT confirmed and has NOT taken a seat
  // (absent / invited / declined). Once confirmed, canCheckIn takes over. Decline
  // stays scheduled-only (see the RsvpActions block below).
  const canConfirmLive =
    live &&
    runnable &&
    player != null &&
    (myEntry == null || myEntry.status === 'invited' || myEntry.status === 'declined')
  // Same "Voy — confirmar asistencia" affordance during the pre-live window: a
  // player who hasn't confirmed (no entry / invited / declined) can still join.
  const canConfirmPreLive =
    preLive &&
    player != null &&
    (myEntry == null || myEntry.status === 'invited' || myEntry.status === 'declined')
  const locating = checkIn.kind === 'locating' || checkIn.kind === 'submitting'
  // Completed fecha: the ACTUAL payout per place — the materialized
  // tournament.prizes, chop-adjusted (a chopped top splits its pooled slots
  // equally). Standalone fechas are still played for money → show it too.
  const finalPrizes = completed ? chopAdjustedPrizes(prizes, entries) : []
  // Real-time per-player points breakdown (transparency). N = everyone who took a
  // seat (checked-in / playing / eliminated / winner) — the field size the engine
  // will score against at completion, so a live bust previews its final value and
  // a completed fecha matches fn_tournament_points exactly. `scoring` re-shapes the
  // season LeagueConfig into the admin helper's ScoringConfig (same numbers).
  const seatCount = playedCount(entries)
  const scoring: ScoringConfig = {
    points_multiplier: config.multiplier,
    bonus_final_table: config.bonusFinalTable,
    bonus_attendance: config.bonusAttendance,
    top_finish_bonuses: config.topFinishBonuses,
  }

  return (
    <>
      <Back />
      {/* Portada hero — visible to EVERYONE (not just the admin), tap to expand.
          The upload affordance stays admin-only in CoverControl below. */}
      {tournament.cover_url && (
        <button
          type="button"
          className="fd-cover-hero"
          data-testid="fd-cover-hero"
          style={{ backgroundImage: `url("${tournament.cover_url}")` }}
          aria-label="Ampliar portada de la fecha"
          onClick={() => setCoverZoom(true)}
        />
      )}
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">{preLive ? 'Registro abierto' : OVERLINE[tournament.status]}</span>
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
      {preLive && (
        <div className="fd-prelive-note" data-testid="fd-prelive-note">
          Check-in y pagos abiertos
        </div>
      )}
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
      {tournament.counts_for_league === false && (
        <div className="fd-standalone" data-testid="fd-standalone">
          Amistoso · no suma a la liga
        </div>
      )}

      {/* Top action bar — the player's SINGLE currently-actionable CTA for this
          moment, surfaced above the list so it's the first thing they act on. The
          gates (canCheckIn / canConfirm* / RsvpActions) are unchanged; only their
          placement moved here from the old bottom block. Admin fecha-management
          (Abrir / Cancelar / Eliminar) stays below — it's not a player action. */}
      {!completed && runnable && (scheduled || live) && player && (
        <div className="fd-top-actions" data-testid="fd-top-actions">
          {live && alreadyCheckedIn ? (
            <div className="btn-row">
              <Link className="btn blood full" to="/vivo">
                Ir a En Vivo
              </Link>
            </div>
          ) : canConfirmLive || canConfirmPreLive ? (
            <div className="btn-row">
              <button
                type="button"
                className="btn blood full"
                disabled={busy}
                onClick={() => doRsvp('confirm')}
              >
                Voy — confirmar asistencia
              </button>
            </div>
          ) : canCheckIn ? (
            <>
              {/* Check-in is open (pre-live): the timer goes red and counts down
                  to the start itself; past the start it just says so. */}
              {preLive && (
                <div className="fd-countdown hot" role="timer" data-testid="fecha-countdown">
                  {scheduledAtMs - now > 0
                    ? `🔴 Empieza en ${formatCountdown(scheduledAtMs - now)}`
                    : '🔴 ¡Ya es la hora!'}
                </div>
              )}
              <GeoBanner state={checkIn} radius={tournament.geofence_radius_m} />
              <div className="btn-row">
                <button
                  type="button"
                  className="btn blood full"
                  disabled={locating}
                  onClick={() => (live ? setLateWarnOpen(true) : doCheckIn())}
                >
                  {checkIn.kind === 'locating'
                    ? 'Ubicando…'
                    : checkIn.kind === 'submitting'
                      ? 'Confirmando…'
                      : '📍 Hacer check-in'}
                </button>
              </div>
              {preLive && (
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </>
          ) : scheduled && !preLive ? (
            <div className="btn-row">
              <RsvpActions
                status={myEntry?.status}
                busy={busy}
                checkInOpensInMs={scheduledAtMs - CHECKIN_WINDOW_MS - now}
                onRsvp={doRsvp}
                onCancel={() => setCancelOpen(true)}
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Players list (prominent) — its own strong top border separates it from
          the header block. The RSVP summary + admin fecha actions sit BELOW it. */}
      <div className="plist">
        {entries.map((e) => (
          <PlayerAttendanceRow
            key={e.id}
            entry={e}
            isMe={player?.id === e.player_id}
            completed={completed}
            seatCount={seatCount}
            scoring={scoring}
            earlyBirdChips={config.earlyBirdChips}
            canAdminCheckIn={isAdmin && (preLive || live) && runnable && e.status === 'confirmed'}
            canConfirmPayment={
              isAdmin && (preLive || live) && runnable && e.status === 'confirmed' && !e.paid
            }
            onAdminCheckIn={doAdminCheckIn}
            onConfirmPayment={doConfirmPayment}
          />
        ))}
      </div>

      {finalPrizes.length > 0 && (
        <PrizeList prizes={finalPrizes} formatAmount={(n) => `₡${formatMiles(n)}`} />
      )}

      <div className="rule faint" />

      {/* (1) RSVP summary chips */}
      <div className="att-head" data-testid="att-head">
        <ChipCount tone="confirmed" n={counts.voy} label="Voy" />
        <ChipCount tone="declined" n={counts.cancelaron} label="Cancelaron" />
        <ChipCount tone="none" n={counts.sinResp} label="Sin resp." />
      </div>

      {/* (2) Admin Cancelar-fecha / Eliminar-fecha actions (player CTAs moved up) */}
      {isAdmin && (
        <AdminFechaActions
          status={tournament.status}
          cancelled={cancelled}
          busy={busy}
          openError={openError}
          onOpen={doOpenFecha}
          onEdit={() => navigate(`/fechas/${tournament.id}/editar`)}
          onCancel={doCancelFecha}
          onDelete={doDeleteFecha}
        />
      )}

      {/* (3) Admin share row — convocatoria for the group chat + the plain join
          link. Not for a completed fecha (results go out from the Consola's
          "Resumen para WhatsApp") nor a cancelled one. */}
      {isAdmin && !completed && !cancelled && (
        <ShareFecha tournament={tournament} entries={entries} />
      )}
      {/* (3b) Completed fecha: the result (podium, pot, players) for the group. */}
      {isAdmin && completed && (
        <ShareResultado tournament={tournament} entries={entries} prizes={finalPrizes} />
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

      {/* Post-"Voy": the roster (with the optimistic confirm already applied)
          ready to paste in the group. */}
      <ConvocatoriaSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        fecha={tournament}
        entries={entries.map((e) => ({ name: e.player?.name ?? 'Jugador', status: e.status }))}
      />

      <CheckInCelebration
        celebrate={celebrate}
        earlyBirdChips={config.earlyBirdChips}
        onClose={() => setCelebrate(null)}
      />

      <LateCheckInSheet
        open={lateWarnOpen}
        onClose={() => setLateWarnOpen(false)}
        onConfirm={() => {
          setLateWarnOpen(false)
          void doCheckIn()
        }}
      />

      {coverZoom && tournament.cover_url && (
        <PhotoLightbox
          url={tournament.cover_url}
          alt="Portada de la fecha"
          onClose={() => setCoverZoom(false)}
        />
      )}
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

// Admin management for a fecha: OPEN a scheduled fecha → live (open_tournament,
// the primary action — starts the game), soft-cancel a scheduled/live fecha
// (keeps the row + history, just stops it being runnable) and hard-delete a fecha
// created by mistake (delete_tournament RPC). Each confirms before acting.
function AdminFechaActions({
  status,
  cancelled,
  busy,
  openError,
  onOpen,
  onEdit,
  onCancel,
  onDelete,
}: {
  status: TournamentStatus
  cancelled: boolean
  busy: boolean
  openError: string | null
  onOpen: () => void
  onEdit: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  // Opening is only for a scheduled, uncancelled fecha (the RPC also enforces this).
  const canOpen = status === 'scheduled' && !cancelled
  // Editing (→ /fechas/:id/editar) has the same window: once live the clock,
  // entries and check-ins depend on the fecha's settings; a completed fecha holds
  // results. Same rule as the inline date editor up top.
  const canEdit = status === 'scheduled' && !cancelled
  const canCancel = (status === 'scheduled' || status === 'live') && !cancelled
  // Delete is only for mistakes: a scheduled fecha, or any already-cancelled one.
  // A COMPLETED fecha holds real results + gallery, and a LIVE (uncancelled) fecha
  // is in progress — neither may be deleted (cancel a live fecha first).
  const canDelete = cancelled || status === 'scheduled'
  return (
    <div className="fd-admin-actions" data-testid="fd-admin-actions">
      {canOpen && (
        <button
          type="button"
          className="btn blood full"
          disabled={busy}
          onClick={onOpen}
          data-testid="fd-open-fecha"
        >
          Abrir fecha
        </button>
      )}
      {openError && (
        <div className="fd-note" role="alert">
          <p>{openError}</p>
        </div>
      )}
      {canEdit && (
        <button
          type="button"
          className="btn ghost full"
          disabled={busy}
          onClick={onEdit}
          data-testid="fd-edit-fecha"
        >
          Editar fecha
        </button>
      )}
      {(canCancel || canDelete) && (
        <div className="fd-admin-row">
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
      )}
    </div>
  )
}

// Admin share row. "Compartir en WhatsApp" opens WhatsApp with the convocatoria
// (roster + join link) pre-filled via wa.me — the admin picks the group there,
// since no API can post into a WhatsApp group. "Copiar enlace" copies the plain
// deep link; a logged-out player who taps it is brought back to this fecha after
// the magic link (lib/next.ts).
function ShareFecha({ tournament, entries }: { tournament: TournamentRow; entries: EntryRow[] }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const link = `${window.location.origin}/fechas/${tournament.id}`

  const shareWhatsApp = useCallback(() => {
    const text = convocatoriaText({
      fechaName: tournament.name,
      scheduledAt: tournament.scheduled_at,
      buyIn: tournament.buy_in,
      entries: entries.map((e) => ({ name: e.player?.name ?? 'Jugador', status: e.status })),
      link,
      guestsOpen: tournament.guests_open,
    })
    window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer')
  }, [tournament, entries, link])

  const copyLink = useCallback(async () => {
    const ok = await writeClipboard(link)
    setCopied(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopied(null), 2500)
  }, [link])

  return (
    <div className="fd-admin-actions" data-testid="fd-share">
      <div className="fd-admin-row">
        <button
          type="button"
          className="btn ghost sm"
          onClick={shareWhatsApp}
          data-testid="fd-share-whatsapp"
        >
          Compartir en WhatsApp
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => void copyLink()}
          data-testid="fd-copy-link"
        >
          Copiar enlace
        </button>
      </div>
      {copied && (
        <div className="fd-note" role="status">
          <p>{copied === 'ok' ? '✓ Enlace copiado' : 'No se pudo copiar el enlace.'}</p>
        </div>
      )}
      {tournament.guests_open && (
        <div className="fd-note" data-testid="fd-guests-open">
          <p>Invitados pueden anotarse con este enlace («Ingresar como invitado»).</p>
        </div>
      )}
    </div>
  )
}

// Admin share for a COMPLETED fecha: podium, pot and player count, with the
// link back to the fecha. Pot = the materialized prizes when present (they
// reflect any manual override), else recomputed from paid entries + rebuys.
function ShareResultado({
  tournament,
  entries,
  prizes,
}: {
  tournament: TournamentRow
  entries: EntryRow[]
  prizes: Prize[]
}) {
  const [open, setOpen] = useState(false)
  const pot =
    prizes.length > 0
      ? prizes.reduce((sum, p) => sum + p.amount, 0)
      : computePot(entries, tournament.buy_in, tournament.rebuy_amount, null)
  const text = fechaSummaryText({
    fechaName: tournament.name,
    pot,
    entries: entries.map((e) => ({
      name: e.player?.name ?? 'Jugador',
      status: e.status,
      final_position: e.final_position,
      rebuys_count: e.rebuys_count,
    })),
    link: `${window.location.origin}/fechas/${tournament.id}`,
  })
  return (
    <div className="fd-admin-actions" data-testid="fd-share-result">
      <button
        type="button"
        className="btn ghost full"
        onClick={() => setOpen(true)}
        data-testid="fd-share-result-open"
      >
        Compartir resultado en WhatsApp
      </button>
      <ShareSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Resultado de la fecha"
        intro="Compartir el resultado en el grupo:"
        text={text}
        testId="resultado"
      />
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
  checkInOpensInMs,
  onRsvp,
  onCancel,
}: {
  status: EntryStatus | undefined
  busy: boolean
  /** Time until check-in opens (1h before the start); drives the countdown label. */
  checkInOpensInMs: number
  onRsvp: (choice: 'confirm' | 'decline') => void
  onCancel: () => void
}) {
  if (status === 'confirmed') {
    return (
      <>
        <button
          type="button"
          className="btn full"
          disabled
          title="El check-in abre 1 hora antes de la fecha"
          data-testid="checkin-countdown"
        >
          📍 Check-in · abre en {formatCountdown(checkInOpensInMs)}
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
  seatCount,
  scoring,
  earlyBirdChips,
  canAdminCheckIn,
  canConfirmPayment,
  onAdminCheckIn,
  onConfirmPayment,
}: {
  entry: EntryRow
  isMe: boolean
  completed: boolean
  /** Field size N (everyone who took a seat) for the points breakdown. */
  seatCount: number
  /** Season scoring config re-shaped for the v2 breakdown helper. */
  scoring: ScoringConfig
  /** Season early-bird bonus (fichas) for the on-time check-in note. */
  earlyBirdChips: number
  canAdminCheckIn: boolean
  /** Admin registration desk: this confirmed entry hasn't paid its buy-in yet. */
  canConfirmPayment: boolean
  onAdminCheckIn: (entryId: string) => void
  onConfirmPayment: (entryId: string) => void
}) {
  const pill = statusPill(entry.status)
  const name = entry.player?.name ?? 'Jugador'
  const avatarUrl = entry.player?.avatar_url ?? null
  // On time = checked in while the fecha was still pre-live (early_bird set by
  // the check_in RPC). A late check-in (checked_in_at set, early_bird false)
  // shows no badge — the plain "Check-in listo" note carries it.
  const onTime = entry.early_bird === true && entry.checked_in_at != null
  // Real-time points breakdown for a RANKED, non-chop finisher (live bust OR
  // completed). Chop co-champions (chop_group set) are skipped — the engine
  // AVERAGES their value across the group, so a per-position split would mislead.
  // Players still in juego (no final_position) get no breakdown.
  const breakdown =
    entry.final_position != null && entry.chop_group == null
      ? pointsBreakdown(entry.final_position, seatCount, scoring, {
          paid: entry.paid,
          madeFinalTable: entry.made_final_table,
        })
      : null
  // The finishing PLACE + POINTS badge (in place of the status pill). Shown for
  // any ranked finisher — on a COMPLETED fecha (finishers + no-shows) AND, mig
  // 0030, LIVE once a player busts (final_position set), so eliminated/winner
  // rows show their live total as it lands. Still-playing players keep their
  // status pill. Points prefer the DB value; the client breakdown is a fallback
  // so the total shows even in the instant before the live fn write arrives.
  const result = completed || entry.final_position != null ? fechaResult(entry, breakdown) : null

  // Two tap targets (parity with the Tabla row): the avatar opens a full-screen
  // photo lightbox, the rest of the row opens the season-stats popup. The avatar
  // is a nested `<button>` whose click/keydown stopPropagation so it never also
  // triggers the row's popup; the admin "Registrar" button does the same.
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)

  return (
    <>
      <div
        className="prow"
        data-testid="prow"
        role="button"
        tabIndex={0}
        aria-label={`Ver perfil de ${name}`}
        onClick={() => setStatsOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setStatsOpen(true)
          }
        }}
      >
        <button
          type="button"
          className="avatar-btn"
          aria-label={`Ver foto de ${name}`}
          onClick={(e) => {
            // Keep the row's stats popup from also firing.
            e.stopPropagation()
            setLightboxOpen(true)
          }}
          onKeyDown={(e) => {
            // The button activates on Enter/Space natively; stop the keydown so
            // the row's Enter/Space handler doesn't ALSO open the stats popup.
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
          }}
        >
          <Avatar name={name} url={avatarUrl} size={36} />
        </button>
        <div className="pinfo">
          <b>
            {name}
            {isMe ? ' · tú' : ''}
            {entry.player?.is_guest ? ' · invitado' : ''}
          </b>
          {onTime && (
            <span className="mini-badge ontime" data-testid="ontime-badge">
              A tiempo
            </span>
          )}
          {!result && <div className="sub">{noteFor(entry, earlyBirdChips)}</div>}
          {breakdown && <PointsBreakdownLine breakdown={breakdown} position={entry.final_position!} />}
        </div>
        {canAdminCheckIn || canConfirmPayment ? (
          // Admin registration desk (pre-live / live): confirm the buy-in payment
          // and/or force a check-in. Each button stops propagation so it never
          // also opens the row's stats popup.
          <div className="prow-admin" data-testid="prow-admin">
            {canConfirmPayment && (
              <button
                type="button"
                className="btn sm ghost admin-pay"
                onClick={(e) => {
                  e.stopPropagation()
                  onConfirmPayment(entry.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                }}
              >
                Confirmar pago
              </button>
            )}
            {canAdminCheckIn && (
              <button
                type="button"
                className="btn sm blood admin-checkin"
                onClick={(e) => {
                  // Don't let the admin action also open the stats popup.
                  e.stopPropagation()
                  onAdminCheckIn(entry.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                }}
              >
                Registrar
              </button>
            )}
          </div>
        ) : result ? (
          <FechaResult result={result} />
        ) : (
          <span className={`status ${pill.cls}`}>{pill.label}</span>
        )}
      </div>

      {lightboxOpen && (
        <AvatarLightbox name={name} url={avatarUrl} onClose={() => setLightboxOpen(false)} />
      )}

      {statsOpen && (
        <PlayerStatsSheet
          playerId={entry.player_id}
          playerName={name}
          form={[]}
          formPositions={[]}
          onClose={() => setStatsOpen(false)}
        />
      )}
    </>
  )
}

// Compact, real-time points breakdown under a finisher's name: how the engine
// arrives at their fecha points. Base + total always show; a bonus term only
// appears when non-zero. The top-4 term is tagged with the finishing place
// ("+10 (3º)"). Tabular figures keep the numbers column-aligned across rows.
function PointsBreakdownLine({
  breakdown,
  position,
}: {
  breakdown: PointsBreakdown
  position: number
}) {
  const terms = [`Base ${breakdown.base}`]
  if (breakdown.asistencia) terms.push(`+${breakdown.asistencia} asist`)
  if (breakdown.mesaFinal) terms.push(`+${breakdown.mesaFinal} mesa`)
  if (breakdown.top4) terms.push(`+${breakdown.top4} (${position}º)`)
  // The running total is intentionally omitted here — it already shows in the
  // row's place/points badge, so repeating it in the term line was redundant.
  return (
    <div className="fd-breakdown" data-testid="fd-breakdown">
      <span className="bd-terms">{terms.join(' · ')}</span>
    </div>
  )
}

/** Completed-fecha per-player outcome shown in place of the status badge. */
type FechaResultData =
  | { kind: 'place'; place: number; isChamp: boolean; points: number }
  | { kind: 'noshow'; points: number }

/**
 * The outcome to render for one entry (place + points) — or null for rows that
 * keep their ordinary status pill (declined / invited / non-participants /
 * still-playing on a live fecha). Ranked finishers show their place; chopped
 * co-champions share `1º` (they sit at the top K positions) and keep the
 * champion accent. Points prefer the stored engine value (`points_earned`) and
 * fall back to the client-computed `breakdown.total` so a live bust shows its
 * total even before the fn_tournament_points write lands (mig 0030).
 */
function fechaResult(e: EntryRow, breakdown: PointsBreakdown | null): FechaResultData | null {
  if (e.final_position != null) {
    return {
      kind: 'place',
      place: e.chopped ? 1 : e.final_position,
      isChamp: e.chopped || e.final_position === 1,
      points: e.points_earned ?? breakdown?.total ?? 0,
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
          <b className="ok">Fuera de rango de la sede.</b> Acercarse al lugar (radio {radius}m) e
          intentar de nuevo.
        </div>
      </div>
    )
  }
  if (state.kind === 'denied') {
    return (
      <div className="geo warn" role="alert">
        <span className="ring">!</span>
        <div>
          No se pudo leer la ubicación.
          <br />
          <span style={{ color: 'var(--ink-3)' }}>Solicitar al admin que lo registre.</span>
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
        Hacer <b className="ok">check-in</b> al llegar a la sede.
        <br />
        <span style={{ color: 'var(--ink-3)' }}>
          Radio {radius} m · sin GPS, el admin registra.
        </span>
      </div>
    </div>
  )
}

// Celebratory sheet after a successful check-in — the "+2.000 fichas" moment
// when the player arrived early (early_bird), a plain confirmation otherwise.
function CheckInCelebration({
  celebrate,
  earlyBirdChips,
  onClose,
}: {
  celebrate: { earlyBird: boolean; chips: number | null } | null
  /** Season early-bird bonus (fichas) — the real configured value, not a hardcode. */
  earlyBirdChips: number
  onClose: () => void
}) {
  const chipsLabel =
    celebrate?.chips != null ? `${celebrate.chips.toLocaleString('es-CR')} fichas` : null
  return (
    <Sheet
      open={celebrate != null}
      onClose={onClose}
      title={celebrate?.earlyBird ? '¡Llegada temprana!' : '¡Check-in listo!'}
    >
      <div className="celebrate">
        {celebrate?.earlyBird ? (
          <>
            <div className="big">+{formatMiles(earlyBirdChips)} fichas</div>
            <div className="sub">
              Bonus por llegar antes del arranque.
              {chipsLabel ? ` Comienza con ${chipsLabel}.` : ''}
            </div>
          </>
        ) : (
          <div className="sub">
            Check-in confirmado.{chipsLabel ? ` Comienza con ${chipsLabel}.` : ''}
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

// Late check-in warning: once the fecha is live the early-bird bonus is gone,
// so a live check-in confirms through this sheet first (a pre-live check-in
// proceeds directly). Confirm → the caller's doCheckIn runs; cancel → nothing.
function LateCheckInSheet({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Check-in tarde">
      <p>
        La fecha ya arrancó, así que no se reciben las fichas de bono por llegar a tiempo. ¿Hacer
        check-in igual?
      </p>
      <div className="btn-row">
        <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn blood" style={{ flex: 1 }} onClick={onConfirm}>
          Sí, hacer check-in
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
  // Non-null → the picked file is being framed in the crop modal (16/9) before
  // it is uploaded, so the stored cover already centers nicely in the card.
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setPendingFile(file)
  }, [])

  // Upload the CROPPED blob (always JPEG) then point tournament.cover_url at it.
  const uploadBlob = useCallback(
    async (blob: Blob) => {
      setPendingFile(null)
      if (!uploaderId) return
      setBusy(true)
      setError(null)
      const path = `${uploaderId}/covers/${tournamentId}-${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('gallery')
        .upload(path, blob, { contentType: 'image/jpeg' })
      if (upErr) {
        setBusy(false)
        setError('No se pudo subir la portada. Intentar de nuevo.')
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
      {pendingFile && (
        <ImageCropper
          file={pendingFile}
          aspect={16 / 9}
          outputWidth={1200}
          title="Ajustar la portada"
          onCancel={() => setPendingFile(null)}
          onCropped={uploadBlob}
        />
      )}
    </section>
  )
}

function noteFor(e: EntryRow, earlyBirdChips: number): string {
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
      return e.early_bird ? `Check-in · +${formatMiles(earlyBirdChips)} fichas` : 'Check-in listo'
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
