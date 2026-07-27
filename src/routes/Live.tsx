import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { deriveLiveSignal, useLiveEventCues } from '@/lib/notify'
import { startLevelAlarm, stopLevelAlarm } from '@/lib/sound'
import Sheet from '@/components/Sheet'
import BlindsTable from '@/components/BlindsTable'
import PrizeList from '@/components/PrizeList'
import { aliveCount, colonesCompact, parseLeagueConfig, playedCount, type EntryStatus } from '@/lib/fechas'
import { pointsBreakdown, type PointsBreakdown, type ScoringConfig } from '@/lib/admin'
import { formatMiles } from '@/lib/format'
import {
  chipsInPlay,
  compactChips,
  findLevel,
  formatClock,
  isAlive,
  liveStandings,
  nextLabel,
  nextLevel,
  ordinal,
  parseDistribution,
  parsePrizes,
  proposedPrizes,
  remainingSeconds,
  showAnte,
  type BlindLevel,
  type Prize,
  type StandingEntry,
} from '@/lib/live'

type LiveTournament = {
  id: string
  name: string
  season_id: string
  ante_enabled: boolean
  timer_mode: 'auto' | 'manual'
  current_level: number
  level_started_at: string | null
  is_paused: boolean
  paused_remaining_seconds: number | null
  blind_structure_id: string | null
  prizes: unknown
  payout_distribution: unknown
}

type EntryRow = StandingEntry & { player_id: string }

type Ready = {
  phase: 'ready'
  tournament: LiveTournament
  levels: BlindLevel[]
  entries: EntryRow[]
  prizes: Prize[]
  pot: number
  /** Season scoring config (reshaped) for the live per-finisher points breakdown. */
  scoring: ScoringConfig
}
type State =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'no-live' }
  | Ready

/** Realtime connection health — drives the subtle reconnect banner. */
type Conn = 'connecting' | 'live' | 'reconnecting'

// The cue-engine signal is derived by the shared `deriveLiveSignal` (notify.ts).

const TOURNAMENT_COLUMNS =
  'id, name, season_id, ante_enabled, timer_mode, current_level, level_started_at, is_paused, paused_remaining_seconds, blind_structure_id, prizes, payout_distribution'

async function fetchLive(): Promise<State> {
  // A single fecha is live at a time; take the most recent just in case.
  const { data: t, error: tErr } = await supabase
    .from('tournament')
    .select(TOURNAMENT_COLUMNS)
    .eq('status', 'live')
    .is('cancelled_at', null) // a soft-cancelled live fecha is NOT the live game
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'no-live' }
  const tournament = t as LiveTournament

  const [levelsRes, entriesRes, potRes, seasonRes] = await Promise.all([
    tournament.blind_structure_id
      ? supabase
          .from('blind_level')
          .select('level_number, small_blind, big_blind, ante, duration_seconds, is_break')
          .eq('structure_id', tournament.blind_structure_id)
          .order('level_number')
      : Promise.resolve({ data: [] as BlindLevel[], error: null }),
    supabase
      .from('entry')
      .select(
        'id, player_id, status, final_position, chips, paid, points_earned, made_final_table, chop_group, player:player_id(name, avatar_url)',
      )
      .eq('tournament_id', tournament.id),
    supabase.rpc('fn_pot', { p_tournament_id: tournament.id }),
    // Season scoring config so the live standings can preview each finisher's
    // per-category points breakdown (parity with the Fecha view).
    supabase
      .from('season')
      .select('points_multiplier, bonus_final_table, bonus_attendance, top_finish_bonuses')
      .eq('id', tournament.season_id)
      .maybeSingle(),
  ])

  if (levelsRes.error || entriesRes.error) return { phase: 'error' }

  // Reshape the season LeagueConfig → the admin helper's ScoringConfig (same
  // numbers the Fecha view uses). A season fetch error is non-fatal: fall back
  // to the scoring-v2 defaults so a hiccup never blanks the live board.
  const config = parseLeagueConfig(seasonRes.error ? null : seasonRes.data)
  const scoring: ScoringConfig = {
    points_multiplier: config.multiplier,
    bonus_final_table: config.bonusFinalTable,
    bonus_attendance: config.bonusAttendance,
    top_finish_bonuses: config.topFinishBonuses,
  }

  return {
    phase: 'ready',
    tournament,
    levels: (levelsRes.data ?? []) as BlindLevel[],
    entries: (entriesRes.data ?? []) as EntryRow[],
    prizes: parsePrizes(tournament.prizes),
    // Pot is best-effort: a transient RPC hiccup shouldn't blank the screen.
    pot: potRes.error ? 0 : Number(potRes.data ?? 0),
    scoring,
  }
}

export default function Live() {
  const { isAdmin } = useRole()
  const { player } = useAuth()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [conn, setConn] = useState<Conn>('connecting')
  const [confirmBust, setConfirmBust] = useState(false)
  const [busting, setBusting] = useState(false)
  // Tap the clock → read-only full blind structure (distinct from any edit flow).
  const [blindsTableOpen, setBlindsTableOpen] = useState(false)
  // Non-null once the player has self-reported → shows the friendly "reportado" note.
  const [reportedPosition, setReportedPosition] = useState<number | null>(null)
  // True after a failed self_bust → surfaces an error and keeps the retry button.
  const [bustError, setBustError] = useState(false)

  // Refetch. Never blank a working screen: if a refetch errors while we already
  // hold ready data (e.g. mid-reconnect), keep the last-known values.
  const load = useCallback(async () => {
    const next = await fetchLive()
    setState((prev) => (next.phase === 'error' && prev.phase === 'ready' ? prev : next))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Pure-UI clock: tick once a second and recompute remaining locally. When
  // paused the computed value is constant, so the display simply holds.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Realtime: once we know the live tournament id, subscribe to state changes
  // on its row (clock/status/prizes) and its entries (standings). Any change →
  // refetch. postgres_changes only carries STATE, never per-tick updates.
  const tid = state.phase === 'ready' ? state.tournament.id : null
  useEffect(() => {
    if (!tid) return
    const channel = supabase
      .channel(`live:${tid}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament', filter: `id=eq.${tid}` },
        () => {
          void load()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'entry', filter: `tournament_id=eq.${tid}` },
        () => {
          void load()
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setConn('live')
          void load() // resync after a (re)connect so we never drift
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConn('reconnecting')
        }
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [tid, load])

  // While NO fecha is live (idle), watch the tournament table so a fecha going
  // live is caught and reloaded → the "opened" cue can fire for a player who is
  // sitting on the En Vivo screen. Gated on `no-live` (not `loading`) so a fresh
  // mount onto an already-live fecha never spins up this scan channel.
  const idle = state.phase === 'no-live'
  useEffect(() => {
    if (!idle) return
    const channel = supabase
      .channel('live:scan')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament' }, () => {
        void load()
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void load()
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [idle, load])

  // Sound cues + in-app toasts + optional local notifications, off state
  // transitions (level advance, fecha opened, elimination). Non-admin observers
  // get these through the realtime refetch above — they never act.
  const { toast: eventToast, permission: notifyPermission, requestNotifications } =
    useLiveEventCues(deriveLiveSignal(state, now))

  // Level clock, computed BEFORE the early returns so the alarm effect below
  // runs unconditionally (hooks can't sit after a conditional return). After the
  // returns `state.phase === 'ready'`, so these are the same values the render uses.
  const level = state.phase === 'ready' ? findLevel(state.levels, state.tournament.current_level) : null
  const upcoming =
    state.phase === 'ready' ? nextLevel(state.levels, state.tournament.current_level) : null
  const remaining =
    state.phase === 'ready'
      ? remainingSeconds(
          {
            isPaused: state.tournament.is_paused,
            pausedRemainingSeconds: state.tournament.paused_remaining_seconds,
            levelStartedAt: state.tournament.level_started_at,
            levelDurationSeconds: level?.duration_seconds ?? 0,
          },
          now,
        )
      : 0

  // Level-END alarm for PLAYERS. The admin device is the sole clock writer; a
  // player never advances the level. When THIS player's local clock for a live,
  // running (auto-mode, not paused) level reaches 0, sound the SAME persistent
  // alarm the admin hears and show a "waiting for the admin" indicator. The
  // alarm loops until the admin advances (a Realtime update brings a fresh
  // level_started_at → remaining > 0 → alarmActive false), pauses, or completes
  // the fecha, or this view unmounts — all covered by the effect cleanup below.
  // Mirrors the admin's condition; only sounds when there's actually a next
  // level to wait for (the last level ending is terminal, no looping alarm).
  const levelEnded =
    state.phase === 'ready' &&
    state.tournament.timer_mode === 'auto' &&
    !state.tournament.is_paused &&
    state.tournament.level_started_at != null &&
    remaining <= 0
  const alarmActive = levelEnded && upcoming != null

  // Key the effect on the `alarmActive` boolean (NOT the per-second `now` tick)
  // so the synth's own loop keeps sounding instead of restarting every second.
  useEffect(() => {
    if (!alarmActive) return
    startLevelAlarm()
    return () => stopLevelAlarm()
  }, [alarmActive])

  if (state.phase === 'loading') {
    return <Framed overline="En juego" title="En vivo" note="Cargando torneo…" />
  }
  if (state.phase === 'error') {
    return (
      <Framed overline="En juego" title="En vivo">
        <div className="fd-note" role="alert">
          <p>No se pudo cargar el torneo en vivo.</p>
          <button type="button" className="btn ghost sm" onClick={() => void load()}>
            Reintentar
          </button>
        </div>
      </Framed>
    )
  }
  if (state.phase === 'no-live') {
    return (
      <Framed overline="En juego" title="En vivo">
        <div className="fd-note">No hay ningún torneo en vivo ahora mismo.</div>
      </Framed>
    )
  }

  const { tournament, entries, prizes, pot, scoring } = state
  const myEntry = player ? (entries.find((e) => e.player_id === player.id) ?? null) : null
  // A player can self-report only while they are still in play (checked_in / playing).
  const canSelfBust = myEntry != null && isAlive(myEntry.status)

  // Self-report bust: optimistically drop the player to their finishing spot
  // (total−1: current alive count, including themselves), call self_bust, then
  // reload so realtime/DB truth reconciles. The admin can reorder/undo later.
  const doSelfBust = async () => {
    if (!tid || !myEntry) return
    setBusting(true)
    setBustError(false)
    const optimisticPos = entries.filter((e) => isAlive(e.status)).length
    setState((prev) => {
      if (prev.phase !== 'ready') return prev
      const next = prev.entries.map((e) =>
        e.id === myEntry.id
          ? { ...e, status: 'eliminated' as EntryStatus, final_position: optimisticPos }
          : e,
      )
      return { ...prev, entries: next }
    })
    const { error } = await supabase.rpc('self_bust', { p_tournament_id: tid })
    setBusting(false)
    setConfirmBust(false)
    if (error) {
      // The RPC failed → the player is still `playing` server-side. Don't commit
      // the "reportado" note; roll the optimistic drop back to server truth and
      // surface an error so they can retry (self_bust is idempotent-safe).
      setBustError(true)
      void load()
      return
    }
    // Commit the friendly note only after the server accepted the bust.
    setReportedPosition(optimisticPos)
    void load() // reconcile optimistic placement with server truth
  }

  const anteVisible = showAnte(level, tournament.ante_enabled)
  const standings = liveStandings(entries)
  const alive = aliveCount(entries)
  const played = playedCount(entries)
  const chips = chipsInPlay(entries)
  // Always show a split: materialized prizes when set_prizes has run, otherwise
  // the PROPOSED split (payout_distribution × pot) — visible even pre-final.
  const proposed = prizes.length === 0
  const displayPrizes = proposed
    ? proposedPrizes(parseDistribution(tournament.payout_distribution), pot)
    : prizes

  return (
    <>
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">{tournament.name} · En juego</span>
          <h1>En vivo</h1>
        </div>
        <span className="badge live">Live</span>
      </div>

      {conn === 'reconnecting' && (
        <div className="live-reconnect" role="status" data-testid="reconnect">
          Reconectando… mostrando los últimos datos
        </div>
      )}

      {eventToast && (
        <div className="live-reconnect" role="status" data-testid="live-toast">
          {eventToast.message}
        </div>
      )}

      {notifyPermission === 'default' && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn ghost sm"
            data-testid="notify-cta"
            onClick={() => void requestNotifications()}
          >
            🔔 Activar notificaciones
          </button>
        </div>
      )}

      <div className={`live-wrap${tournament.is_paused ? ' paused' : ''}${levelEnded ? ' ended' : ''}`}>
        <div
          className="clock-tap"
          role="button"
          tabIndex={0}
          data-testid="live-clock-tap"
          aria-label="Ver estructura de blinds"
          onClick={() => setBlindsTableOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setBlindsTableOpen(true)
            }
          }}
        >
          <div className="lvl">{level?.is_break ? 'Descanso' : `Nivel ${tournament.current_level}`}</div>
          <div className="timer" data-testid="timer">
            {formatClock(remaining)}
          </div>
          {level?.is_break ? (
            <div className="blinds">
              <div className="b">
                <div className="v">Descanso</div>
              </div>
            </div>
          ) : (
            <div className="blinds" data-testid="blinds">
              <Blind label="SB" value={level?.small_blind ?? 0} />
              <Blind label="BB" value={level?.big_blind ?? 0} />
              {anteVisible && <Blind label="Ante" value={level?.ante ?? 0} />}
            </div>
          )}
        </div>
        {levelEnded ? (
          <div className="level-ended" role="status" data-testid="live-level-ended">
            <div className="level-ended-msg">¡Tiempo! Esperando al admin…</div>
          </div>
        ) : (
          <div className="next-lvl">{nextLabel(upcoming)}</div>
        )}
      </div>

      <div className="live-stats">
        <Stat value={colonesCompact(pot)} label="Pozo" />
        <div className="c">
          <div className="v">
            {alive}
            <span style={{ color: 'var(--ink-3)', fontSize: 14 }}>/{played}</span>
          </div>
          <div className="k">Quedan</div>
        </div>
        <Stat value={compactChips(chips)} label="Fichas en juego" />
      </div>

      <div className="section-head" style={{ paddingBottom: 6 }}>
        <div>
          <span className="overline">Posiciones en vivo</span>
        </div>
      </div>
      <div className="rule faint" />
      <div data-testid="standings">
        {standings.length === 0 ? (
          <div className="fd-note">Aún no hay posiciones — el torneo acaba de arrancar.</div>
        ) : (
          standings.map((s) => (
            <StandingRow key={s.id} entry={s} seatCount={played} scoring={scoring} />
          ))
        )}
      </div>

      <div className="btn-row" data-testid="vivo-actions">
        {isAdmin ? (
          <Link className="btn primary full" to="/admin">
            Abrir consola de admin
          </Link>
        ) : reportedPosition != null ? (
          <div className="fd-note" role="status" data-testid="bust-reported">
            Reportado: {ordinal(reportedPosition)} lugar · el admin puede ajustar.
          </div>
        ) : canSelfBust ? (
          <>
            {bustError && (
              <div className="fd-note" role="alert" data-testid="bust-error">
                No se pudo reportar. Probá de nuevo.
              </div>
            )}
            <button
              type="button"
              className="btn blood full"
              disabled={busting}
              onClick={() => {
                setBustError(false)
                setConfirmBust(true)
              }}
            >
              Estoy fuera — reportar
            </button>
          </>
        ) : null}
      </div>

      <PrizeList prizes={displayPrizes} proposed={proposed} />

      {/* Self-report bust confirm */}
      <Sheet open={confirmBust} onClose={() => setConfirmBust(false)} title="Reportar que quedaste fuera">
        <p>
          ¿Confirmás que ya quedaste fuera? Se te asigna tu posición final y bajás a tu lugar en la
          tabla. El admin puede reordenar o deshacerlo si hace falta.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn ghost"
            style={{ flex: 1 }}
            onClick={() => setConfirmBust(false)}
          >
            Todavía sigo
          </button>
          <button
            type="button"
            className="btn blood"
            style={{ flex: 1 }}
            disabled={busting}
            onClick={() => void doSelfBust()}
          >
            Sí, quedé fuera
          </button>
        </div>
      </Sheet>

      {blindsTableOpen && (
        <BlindsTable
          levels={state.levels}
          currentLevel={tournament.current_level}
          onClose={() => setBlindsTableOpen(false)}
        />
      )}
    </>
  )
}

function Blind({ label, value }: { label: string; value: number }) {
  return (
    <div className="b">
      <div className="v">{formatMiles(value)}</div>
      <div className="k">{label}</div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="c">
      <div className="v">{value}</div>
      <div className="k">{label}</div>
    </div>
  )
}

function StandingRow({
  entry,
  seatCount,
  scoring,
}: {
  entry: StandingEntry
  /** Field size N (everyone who took a seat) for the points breakdown. */
  seatCount: number
  /** Season scoring config, reshaped for the breakdown helper. */
  scoring: ScoringConfig
}) {
  const alive = isAlive(entry.status)
  const name = entry.player?.name ?? 'Jugador'
  // Live per-finisher points (parity with the Fecha view): a RANKED, non-chop
  // finisher (final_position set, no chop_group) previews its scoring-v2 total +
  // breakdown. Chop co-champions are skipped (the engine AVERAGES their value).
  // Still-alive players (final_position null) get no breakdown. Points prefer the
  // DB value (mig 0030 writes it live on every bust); the client breakdown is a
  // fallback so the total shows in the instant before that write arrives.
  const breakdown =
    entry.final_position != null && entry.chop_group == null
      ? pointsBreakdown(entry.final_position, seatCount, scoring, {
          paid: entry.paid,
          madeFinalTable: entry.made_final_table,
        })
      : null
  const points = breakdown ? entry.points_earned ?? breakdown.total : null
  return (
    <div className={`standing ${alive ? 'alive' : 'out'}`} data-testid="standing">
      <div className="pos">{alive ? '•' : ordinal(entry.final_position ?? 0)}</div>
      {/* Name column: the name stays in its own `.nm` (text-only, so name-based
          test/DOM lookups aren't polluted); the breakdown sits BELOW it. */}
      <div className="nm-col" style={{ flex: 1, minWidth: 0 }}>
        <div className="nm">{name}</div>
        {breakdown && (
          <PointsBreakdownLine breakdown={breakdown} position={entry.final_position!} />
        )}
      </div>
      {!entry.paid && (
        <span className="mini-badge pending" data-testid="pendiente-pago">
          Pendiente Pago
        </span>
      )}
      {alive ? (
        <span className="mini-badge">En juego</span>
      ) : (
        points != null && (
          <span className="mini-badge" data-testid="standing-points">
            +{points} pts
          </span>
        )
      )}
    </div>
  )
}

// Compact, real-time points breakdown under a finisher's name — a local replica
// of the Fecha view's line (FechaDetail.tsx), sharing the `.fd-breakdown` visual.
// Base + total always show; a bonus term only appears when non-zero. The top-4
// term is tagged with the finishing place ("+10 (3º)").
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
  // Total omitted — the standings row already shows it in its points badge.
  return (
    <div className="fd-breakdown" data-testid="standing-breakdown">
      <span className="bd-terms">{terms.join(' · ')}</span>
    </div>
  )
}

/** Section-head + optional note/children wrapper for the loading/empty/error views. */
function Framed({
  overline,
  title,
  note,
  children,
}: {
  overline: string
  title: string
  note?: string
  children?: ReactNode
}) {
  return (
    <>
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">{overline}</span>
          <h1>{title}</h1>
        </div>
      </div>
      {note ? <div className="fd-note">{note}</div> : children}
    </>
  )
}
