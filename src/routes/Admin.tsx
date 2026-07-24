import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { deriveLiveSignal, useLiveEventCues } from '@/lib/notify'
import Avatar from '@/components/Avatar'
import Sheet from '@/components/Sheet'
import PrizeDistributionEditor, {
  distToRows,
  isValidDist,
  rowsToDist,
  type PctRow,
} from '@/components/PrizeDistributionEditor'
import CreateFecha from '@/routes/admin/CreateFecha'
import LeagueSettings from '@/routes/admin/LeagueSettings'
import type { Json } from '@/lib/database.types'
import { colonesCompact, colonesFull, type EntryStatus } from '@/lib/fechas'
import {
  fechaSummaryText,
  seasonSummaryText,
  writeClipboard,
  type SeasonStandingRow,
} from '@/lib/summary'
import {
  chopPreview,
  isInPlay,
  playerActions,
  tieSplitMoneyEach,
  type ClockAction,
  type ScoringConfig,
} from '@/lib/admin'
import {
  findLevel,
  formatClock,
  nextLevel,
  ordinal,
  parseDistribution,
  parsePrizes,
  remainingSeconds,
  showAnte,
  type BlindLevel,
  type DistSlice,
  type Prize,
} from '@/lib/live'

type AdminTab = 'consola' | 'crear' | 'liga'

// ---------------------------------------------------------------------------
// Admin console (slice 12). Sub-nav: Consola (the live-game control surface,
// built here) · Nueva fecha · Liga (slice-13 stubs). The Consola panel only
// renders when a fecha is live; the admin device is the SOLE clock writer and
// (in timer_mode='auto') advances the level when the local timer reaches 0.
// ---------------------------------------------------------------------------
export default function Admin() {
  const [tab, setTab] = useState<AdminTab>('consola')
  return (
    <>
      <div className="section-head">
        <div>
          <span className="overline">Consola de admin</span>
          <h1>Admin</h1>
        </div>
      </div>

      <div className="subnav" role="tablist" aria-label="Secciones de admin">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'consola'}
          className={tab === 'consola' ? 'on' : ''}
          onClick={() => setTab('consola')}
        >
          Consola
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'crear'}
          className={tab === 'crear' ? 'on' : ''}
          onClick={() => setTab('crear')}
        >
          Nueva fecha
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'liga'}
          className={tab === 'liga' ? 'on' : ''}
          onClick={() => setTab('liga')}
        >
          Liga
        </button>
      </div>

      <div className={`apanel${tab === 'consola' ? ' on' : ''}`}>
        {tab === 'consola' && <ConsolePanel />}
      </div>
      <div className={`apanel${tab === 'crear' ? ' on' : ''}`}>
        {tab === 'crear' && <CreateFecha />}
      </div>
      <div className={`apanel${tab === 'liga' ? ' on' : ''}`}>
        {tab === 'liga' && <LeagueSettings />}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Console data
// ---------------------------------------------------------------------------
type ConsoleTournament = {
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
  final_table_size: number | null
  starting_stack: number | null
}

type ConsoleEntry = {
  id: string
  player_id: string
  status: EntryStatus
  paid: boolean
  chips: number | null
  rebuys_count: number
  early_bird: boolean
  final_position: number | null
  player: { name: string; avatar_url: string | null } | null
}

type Ready = {
  phase: 'ready'
  tournament: ConsoleTournament
  levels: BlindLevel[]
  entries: ConsoleEntry[]
  prizes: Prize[]
  scoring: ScoringConfig
  pot: number
}
type State = { phase: 'loading' } | { phase: 'error' } | { phase: 'no-live' } | Ready

/** Realtime connection health — drives the subtle reconnect banner. */
type Conn = 'connecting' | 'live' | 'reconnecting'

const TOURNAMENT_COLUMNS =
  'id, name, season_id, ante_enabled, timer_mode, current_level, level_started_at, is_paused, paused_remaining_seconds, blind_structure_id, prizes, payout_distribution, final_table_size, starting_stack'

async function fetchConsole(): Promise<State> {
  const { data: t, error: tErr } = await supabase
    .from('tournament')
    .select(TOURNAMENT_COLUMNS)
    .eq('status', 'live')
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'no-live' }
  const tournament = t as ConsoleTournament

  const [levelsRes, entriesRes, seasonRes, potRes] = await Promise.all([
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
        'id, player_id, status, paid, chips, rebuys_count, early_bird, final_position, player:player_id(name, avatar_url)',
      )
      .eq('tournament_id', tournament.id),
    supabase
      .from('season')
      .select('points_multiplier, bonus_final_table, bonus_top3, bonus_attendance')
      .eq('id', tournament.season_id)
      .maybeSingle(),
    supabase.rpc('fn_pot', { p_tournament_id: tournament.id }),
  ])

  if (levelsRes.error || entriesRes.error || seasonRes.error) return { phase: 'error' }

  const s = (seasonRes.data ?? {}) as Partial<ScoringConfig>
  return {
    phase: 'ready',
    tournament,
    levels: (levelsRes.data ?? []) as BlindLevel[],
    entries: (entriesRes.data ?? []) as ConsoleEntry[],
    prizes: parsePrizes(tournament.prizes),
    scoring: {
      points_multiplier: s.points_multiplier ?? 10,
      bonus_final_table: s.bonus_final_table ?? 5,
      bonus_top3: s.bonus_top3 ?? 8,
      bonus_attendance: s.bonus_attendance ?? 2,
    },
    pot: potRes.error ? 0 : Number(potRes.data ?? 0),
  }
}

function ConsolePanel() {
  const { isAdmin } = useRole()
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [confirmKill, setConfirmKill] = useState<ConsoleEntry | null>(null)
  const [noShowFor, setNoShowFor] = useState<ConsoleEntry | null>(null)
  const [blindsOpen, setBlindsOpen] = useState(false)
  const [prizesOpen, setPrizesOpen] = useState(false)
  const [multiBustOpen, setMultiBustOpen] = useState(false)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [whatsOpen, setWhatsOpen] = useState(false)
  // Realtime health → subtle reconnect banner (mirrors the En Vivo screen).
  const [conn, setConn] = useState<Conn>('connecting')
  // Transient error surfaced after a failed action RPC (auto-dismisses).
  const [toast, setToast] = useState<string | null>(null)
  // Level we have SUCCESSFULLY auto-advanced past (blocks re-firing that level).
  const autoAdvancedLevel = useRef<number | null>(null)
  // `now` value of the last auto-advance attempt → throttles retries to at most
  // one per clock tick, so a failed write re-fires next second instead of either
  // stalling forever or hammering the server in a tight reconcile loop.
  const autoAttemptAt = useRef<number | null>(null)

  const load = useCallback(async () => {
    const next = await fetchConsole()
    setState((prev) => (next.phase === 'error' && prev.phase === 'ready' ? prev : next))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-dismiss the action-error toast after a few seconds; the reconciled
  // state (we refetch on every failure) is the source of truth meanwhile.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  const tid = state.phase === 'ready' ? state.tournament.id : null
  useEffect(() => {
    if (!tid) return
    const channel = supabase
      .channel(`admin:${tid}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament', filter: `id=eq.${tid}` },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'entry', filter: `tournament_id=eq.${tid}` },
        () => void load(),
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

  // Every mutating RPC is idempotent / self-guarding server-side (0009_admin.sql):
  // eliminate rejects a non-in-play entry, add_rebuy rejects a non-eliminated
  // one, confirm_payment sets fixed values. So on failure we simply surface a
  // toast AND refetch to reconcile with server truth — a retry can never
  // double-apply, because the state transition blocks the second call.
  const doClock = useCallback(
    async (action: ClockAction, payload?: Json): Promise<boolean> => {
      if (!tid) return false
      setBusy(true)
      setToast(null)
      const { error } = await supabase.rpc('clock', {
        p_tournament_id: tid,
        p_action: action,
        ...(payload ? { p_payload: payload } : {}),
      })
      setBusy(false)
      if (error) {
        setToast('No se pudo actualizar el reloj. Reintentá.')
        void load() // reconcile to server truth so a retry is safe
        return false
      }
      void load()
      return true
    },
    [tid, load],
  )

  // Edit the live fecha's payout SPLIT (not just amounts): write the new
  // distribution to tournament.payout_distribution directly (existing admin
  // update-tournament RLS policy — no new RPC), then re-run set_prizes to
  // re-materialize prizes against the current pot, and reload.
  const saveDistribution = useCallback(
    async (dist: DistSlice[]) => {
      if (!tid) return
      setBusy(true)
      setToast(null)
      const { error: upErr } = await supabase
        .from('tournament')
        .update({ payout_distribution: dist as unknown as Json })
        .eq('id', tid)
      if (upErr) {
        setBusy(false)
        setToast('No se pudieron guardar los premios. Reintentá.')
        void load()
        return
      }
      const { error: rpcErr } = await supabase.rpc('set_prizes', { p_tournament_id: tid })
      setBusy(false)
      if (rpcErr) {
        setToast('No se pudieron recalcular los premios. Reintentá.')
      }
      void load()
    },
    [tid, load],
  )

  const level = state.phase === 'ready' ? findLevel(state.levels, state.tournament.current_level) : null
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

  // Sound cues + in-app toasts + optional local notifications, off state
  // transitions (level advance, elimination). The admin hears the same cues via
  // the refetch that follows each action; fires once per transition, not per tick.
  const { toast: eventToast, permission: notifyPermission, requestNotifications } =
    useLiveEventCues(deriveLiveSignal(state, now))

  // Auto-advance: admin client is the single writer. When timer_mode='auto' and
  // the running clock hits 0, write next_level. It fires once per level on
  // success; the per-tick throttle (autoAttemptAt) bounds retries so a transient
  // failure re-fires on the NEXT second's tick — never stalling at 00:00 forever
  // (Kong-502 class), never looping tightly on the failure-driven refetch.
  useEffect(() => {
    if (state.phase !== 'ready') return
    const { tournament } = state
    if (tournament.timer_mode !== 'auto' || tournament.is_paused) return
    if (remaining > 0) return
    if (autoAdvancedLevel.current === tournament.current_level) return
    if (autoAttemptAt.current === now) return // at most one attempt per tick
    autoAttemptAt.current = now
    // Latch the level BEFORE the await so a tick that fires while the RPC is still
    // in flight (round-trip > 1s, Kong-502 class) can't double-fire next_level and
    // skip a level. On failure, release the latch so the next distinct tick retries;
    // on success it stays latched (current_level advances via realtime).
    autoAdvancedLevel.current = tournament.current_level
    void (async () => {
      const ok = await doClock('next_level')
      if (!ok) autoAdvancedLevel.current = null
    })()
  }, [state, remaining, now, doClock])

  if (state.phase === 'loading') return <div className="fd-note">Cargando consola…</div>
  if (state.phase === 'error')
    return (
      <div className="fd-note" role="alert">
        <p>No se pudo cargar la consola.</p>
        <button type="button" className="btn ghost sm" onClick={() => void load()}>
          Reintentar
        </button>
      </div>
    )
  if (state.phase === 'no-live')
    return (
      <div className="fd-note">
        No hay ninguna fecha en vivo. Abrí una fecha desde su detalle para controlar la consola.
      </div>
    )

  const { tournament, levels, entries, prizes, scoring, pot } = state
  const upcoming = nextLevel(levels, tournament.current_level)
  const anteVisible = showAnte(level, tournament.ante_enabled)
  const finishersWithPosition = entries.filter((e) => e.final_position != null).length
  const canUndo = entries.some((e) => e.status === 'eliminated' || e.status === 'winner')

  // Runs a mutating action RPC. The RPCs are self-guarding (see doClock note),
  // so on failure we toast + refetch to reconcile — a retry never double-applies.
  const runAction = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true)
    setToast(null)
    const { error } = await fn()
    setBusy(false)
    if (error) {
      setToast('No se pudo aplicar el cambio. Reintentá.')
      void load() // reconcile to server truth so a retry is safe
    } else {
      void load()
    }
  }

  return (
    <>
      {conn === 'reconnecting' && (
        <div className="live-reconnect" role="status" data-testid="admin-reconnect">
          Reconectando… mostrando los últimos datos
        </div>
      )}
      {toast && (
        <div className="action-toast" role="alert" data-testid="admin-toast">
          <span>{toast}</span>
          <button type="button" className="link-btn" onClick={() => setToast(null)}>
            Cerrar
          </button>
        </div>
      )}
      {eventToast && (
        <div className="live-reconnect" role="status" data-testid="admin-event-toast">
          {eventToast.message}
        </div>
      )}
      {notifyPermission === 'default' && (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn ghost sm"
            data-testid="admin-notify-cta"
            onClick={() => void requestNotifications()}
          >
            🔔 Activar notificaciones
          </button>
        </div>
      )}
      <div className={`live-wrap${tournament.is_paused ? ' paused' : ''}`} style={{ padding: 16 }}>
        <div className="lvl">
          Nivel {tournament.current_level} · reloj{tournament.is_paused ? ' · en pausa' : ''}
        </div>
        <div className="timer" style={{ fontSize: 56 }} data-testid="admin-timer">
          {formatClock(remaining)}
        </div>
        <div className="blinds">
          <div className="b">
            <div className="v">{level?.small_blind ?? 0}</div>
            <div className="k">SB</div>
          </div>
          <div className="b">
            <div className="v">{level?.big_blind ?? 0}</div>
            <div className="k">BB</div>
          </div>
          {anteVisible && (
            <div className="b">
              <div className="v">{level?.ante ?? 0}</div>
              <div className="k">Ante</div>
            </div>
          )}
        </div>
        <div className="next-lvl">
          {upcoming ? `Siguiente · Nivel ${upcoming.level_number}` : 'Último nivel'} ·{' '}
          {tournament.timer_mode === 'auto' ? 'avance automático' : 'avance manual'}
        </div>
      </div>

      <div className="clock-grid" data-testid="clock-grid">
        <button
          type="button"
          className="btn primary wide"
          disabled={busy}
          onClick={() => void doClock(tournament.is_paused ? 'resume' : 'pause')}
        >
          {tournament.is_paused ? '▶  Reanudar' : '⏸  Pausar'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void doClock('minus_min')}>
          −1 min
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void doClock('plus_min')}>
          +1 min
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void doClock('prev_level')}>
          ◀ Nivel
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void doClock('next_level')}>
          Nivel ▶
        </button>
        <button
          type="button"
          className="btn ghost wide"
          disabled={busy}
          onClick={() => setBlindsOpen(true)}
        >
          ✎  Editar blinds
        </button>
        <button
          type="button"
          className="btn ghost wide"
          disabled={busy}
          onClick={() => setPrizesOpen(true)}
        >
          🏆  Editar premios
        </button>
      </div>

      <div className="live-stats" style={{ marginBottom: 6 }}>
        <div className="c">
          <div className="v">{colonesCompact(pot)}</div>
          <div className="k">Pozo</div>
        </div>
        <div className="c">
          <div className="v">{entries.filter((e) => isInPlay(e.status) && e.status !== 'winner').length}</div>
          <div className="k">En juego</div>
        </div>
        <div className="c">
          <div className="v">{tournament.final_table_size ?? '—'}</div>
          <div className="k">Mesa final</div>
        </div>
      </div>

      <div className="section-head" style={{ paddingBottom: 6 }}>
        <div>
          <span className="overline">Jugadores · toca para ajustar</span>
        </div>
      </div>
      <div className="rule faint" />

      <div className="plist" data-testid="admin-players">
        {entries.map((e) => (
          <AdminPlayerRow
            key={e.id}
            entry={e}
            busy={busy}
            onPay={(id) => void runAction(() => supabase.rpc('confirm_payment', { p_entry_id: id }))}
            onRebuy={(id) => void runAction(() => supabase.rpc('add_rebuy', { p_entry_id: id }))}
            onEliminate={() => setConfirmKill(e)}
            onNoShow={() => setNoShowFor(e)}
          />
        ))}
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn ghost full"
          disabled={busy || entries.filter((e) => isInPlay(e.status) && e.status !== 'winner').length < 2}
          onClick={() => setMultiBustOpen(true)}
        >
          ✖✖  Eliminar varios (misma mano)
        </button>
      </div>

      {isAdmin && (
        <div className="btn-row">
          <button
            type="button"
            className="btn ghost full"
            onClick={() => setWhatsOpen(true)}
          >
            📲  Resumen
          </button>
        </div>
      )}

      <div className="btn-row" style={{ gap: 10 }}>
        <button
          type="button"
          className="btn ghost"
          style={{ flex: 1 }}
          disabled={busy || !canUndo}
          onClick={() =>
            void runAction(() => supabase.rpc('undo_last_elimination', { p_tournament_id: tournament.id }))
          }
        >
          ↩ Deshacer
        </button>
        <button
          type="button"
          className="btn blood"
          style={{ flex: 2 }}
          disabled={busy}
          onClick={() => setCompleteOpen(true)}
        >
          🏁  Completar fecha
        </button>
      </div>

      {/* Eliminate confirm */}
      <Sheet open={confirmKill != null} onClose={() => setConfirmKill(null)} title="Eliminar jugador">
        <p>
          ¿Eliminar a <b>{confirmKill?.player?.name ?? 'este jugador'}</b>? Se le asigna su posición
          final. Podés deshacerlo con “Deshacer”.
        </p>
        <div className="btn-row">
          <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={() => setConfirmKill(null)}>
            Volver
          </button>
          <button
            type="button"
            className="btn blood"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => {
              const id = confirmKill!.id
              setConfirmKill(null)
              void runAction(() => supabase.rpc('eliminate', { p_entry_id: id }))
            }}
          >
            Eliminar
          </button>
        </div>
      </Sheet>

      {/* No-show excused / −15 choice */}
      <Sheet open={noShowFor != null} onClose={() => setNoShowFor(null)} title="Marcar no-show">
        <p>
          <b>{noShowFor?.player?.name ?? 'Este jugador'}</b> confirmó pero no llegó. Elegí el castigo:
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn ghost"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => {
              const id = noShowFor!.id
              setNoShowFor(null)
              void runAction(() => supabase.rpc('mark_no_show', { p_entry_id: id, p_excused: true }))
            }}
          >
            Justificado · 0 pts
          </button>
          <button
            type="button"
            className="btn blood"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => {
              const id = noShowFor!.id
              setNoShowFor(null)
              void runAction(() => supabase.rpc('mark_no_show', { p_entry_id: id, p_excused: false }))
            }}
          >
            No-show · −15 pts
          </button>
        </div>
      </Sheet>

      {/* Edit blinds */}
      <EditBlindsSheet
        open={blindsOpen}
        onClose={() => setBlindsOpen(false)}
        level={level}
        anteEnabled={tournament.ante_enabled}
        onSave={(payload) => {
          setBlindsOpen(false)
          void doClock('edit_blinds', payload)
        }}
      />

      {/* Edit prizes (payout distribution → re-materialize) */}
      <EditPrizesSheet
        open={prizesOpen}
        onClose={() => setPrizesOpen(false)}
        distribution={parseDistribution(tournament.payout_distribution)}
        busy={busy}
        onSave={(dist) => {
          setPrizesOpen(false)
          void saveDistribution(dist)
        }}
      />

      {/* Simultaneous multi-bust (ordered / dead-even tie) */}
      <MultiBustSheet
        open={multiBustOpen}
        onClose={() => setMultiBustOpen(false)}
        entries={entries}
        prizes={prizes}
        busy={busy}
        onBust={(ids, tied) => {
          setMultiBustOpen(false)
          void runAction(() =>
            supabase.rpc('eliminate_multi', { p_entry_ids: ids, p_tied: tied }),
          )
        }}
      />

      {/* Complete + chop flow */}
      <CompleteSheet
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        entries={entries}
        prizes={prizes}
        scoring={scoring}
        finishersWithPosition={finishersWithPosition}
        busy={busy}
        onComplete={(chopIds) => {
          setCompleteOpen(false)
          void runAction(() =>
            supabase.rpc('complete_tournament', {
              p_tournament_id: tournament.id,
              ...(chopIds.length > 0 ? { p_chop_entry_ids: chopIds } : {}),
            }),
          )
        }}
      />

      {/* WhatsApp summary (copy-paste, stage 1) */}
      <WhatsSheet
        open={whatsOpen}
        onClose={() => setWhatsOpen(false)}
        fechaName={tournament.name}
        seasonId={tournament.season_id}
        entries={entries}
        pot={pot}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// WhatsApp summary sheet (slice 15). Two copy-paste shapes — the fecha result
// (built from the console's entries/pot) and the season standings (fetched from
// the `leaderboard` RPC on open). Copy uses navigator.clipboard with a legacy
// fallback (see writeClipboard). Stage-1: copy-paste only, no native send.
// ---------------------------------------------------------------------------
type WhatsScope = 'fecha' | 'temporada'

function WhatsSheet({
  open,
  onClose,
  fechaName,
  seasonId,
  entries,
  pot,
}: {
  open: boolean
  onClose: () => void
  fechaName: string
  seasonId: string
  entries: ConsoleEntry[]
  pot: number
}) {
  const [scope, setScope] = useState<WhatsScope>('fecha')
  const [seasonName, setSeasonName] = useState('Liga')
  const [standings, setStandings] = useState<SeasonStandingRow[] | null>(null)
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)

  // Reset transient UI + load the season standings each time the sheet opens.
  useEffect(() => {
    if (!open) return
    setScope('fecha')
    setCopied(null)
    let active = true
    void (async () => {
      const [sRes, lbRes] = await Promise.all([
        supabase.from('season').select('name').eq('id', seasonId).maybeSingle(),
        supabase.rpc('leaderboard', { p_season_id: seasonId }),
      ])
      if (!active) return
      setSeasonName((sRes.data as { name?: string } | null)?.name ?? 'Liga')
      setStandings((lbRes.data as SeasonStandingRow[] | null) ?? [])
    })()
    return () => {
      active = false
    }
  }, [open, seasonId])

  const text =
    scope === 'fecha'
      ? fechaSummaryText({
          fechaName,
          pot,
          entries: entries.map((e) => ({
            name: e.player?.name ?? 'Jugador',
            status: e.status,
            final_position: e.final_position,
            rebuys_count: e.rebuys_count,
          })),
        })
      : seasonSummaryText({ seasonName, rows: standings ?? [] })

  const doCopy = async () => {
    const ok = await writeClipboard(text)
    setCopied(ok ? 'ok' : 'fail')
  }

  return (
    <Sheet open={open} onClose={onClose} title="Resumen para WhatsApp">
      <p>Copiá y pegá en el grupo (etapa 1). El envío directo llega después.</p>

      <div className="subnav" role="tablist" aria-label="Tipo de resumen" style={{ marginBottom: 10 }}>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'fecha'}
          className={scope === 'fecha' ? 'on' : ''}
          onClick={() => {
            setScope('fecha')
            setCopied(null)
          }}
        >
          Fecha
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'temporada'}
          className={scope === 'temporada' ? 'on' : ''}
          onClick={() => {
            setScope('temporada')
            setCopied(null)
          }}
        >
          Temporada
        </button>
      </div>

      <div className="field">
        <label htmlFor="wa-text">Mensaje</label>
        <textarea id="wa-text" rows={9} readOnly value={text} data-testid="wa-text" />
      </div>

      {copied && (
        <div className="fd-note" role="status" data-testid="wa-status">
          {copied === 'ok'
            ? '📋 Resumen copiado'
            : 'No se pudo copiar — seleccioná el texto y copialo manualmente.'}
        </div>
      )}

      <div className="btn-row">
        <button type="button" className="btn blood full" onClick={() => void doCopy()}>
          📋 Copiar resumen
        </button>
      </div>
    </Sheet>
  )
}

function AdminPlayerRow({
  entry,
  busy,
  onPay,
  onRebuy,
  onEliminate,
  onNoShow,
}: {
  entry: ConsoleEntry
  busy: boolean
  onPay: (id: string) => void
  onRebuy: (id: string) => void
  onEliminate: (id: string) => void
  onNoShow: (id: string) => void
}) {
  const name = entry.player?.name ?? 'Jugador'
  const actions = playerActions(entry.status, entry.paid)
  const fire = (kind: string) => {
    if (kind === 'pay') onPay(entry.id)
    else if (kind === 'rebuy') onRebuy(entry.id)
    else if (kind === 'eliminate') onEliminate(entry.id)
    else if (kind === 'noshow') onNoShow(entry.id)
  }
  return (
    <div className="prow" data-testid="admin-prow">
      <Avatar name={name} url={entry.player?.avatar_url} size={36} />
      <div className="pinfo">
        <b>
          {name}
          {entry.final_position != null ? ` · ${ordinal(entry.final_position)}` : ''}
        </b>
        <div className="sub">
          {entry.paid ? (
            <span className="paid-check">✓ Pagó</span>
          ) : (
            <span className="unpaid">● Sin pagar</span>
          )}
          {entry.rebuys_count > 0 && <span className="mini-badge">↺ {entry.rebuys_count}</span>}
          {entry.chips != null && entry.chips > 0 && (
            <span className="chips-badge">
              {entry.chips.toLocaleString('es-CR')} fichas iniciales{entry.early_bird ? ' · +2.000' : ''}
            </span>
          )}
        </div>
      </div>
      <div className="prow-actions">
        {actions.map((a) => (
          <button
            key={a.kind}
            type="button"
            className={`btn sm ${a.variant}`}
            disabled={busy}
            onClick={() => fire(a.kind)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function EditBlindsSheet({
  open,
  onClose,
  level,
  anteEnabled,
  onSave,
}: {
  open: boolean
  onClose: () => void
  level: BlindLevel | null
  anteEnabled: boolean
  onSave: (payload: Json) => void
}) {
  const [sb, setSb] = useState('')
  const [bb, setBb] = useState('')
  const [ante, setAnte] = useState('')

  useEffect(() => {
    if (open) {
      setSb(String(level?.small_blind ?? ''))
      setBb(String(level?.big_blind ?? ''))
      setAnte(level?.ante != null ? String(level.ante) : '')
    }
  }, [open, level])

  return (
    <Sheet open={open} onClose={onClose} title="Editar blinds del nivel">
      <div className="field">
        <label htmlFor="eb-sb">Small blind</label>
        <input id="eb-sb" inputMode="numeric" value={sb} onChange={(e) => setSb(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="eb-bb">Big blind</label>
        <input id="eb-bb" inputMode="numeric" value={bb} onChange={(e) => setBb(e.target.value)} />
      </div>
      {anteEnabled && (
        <div className="field">
          <label htmlFor="eb-ante">Ante</label>
          <input id="eb-ante" inputMode="numeric" value={ante} onChange={(e) => setAnte(e.target.value)} />
        </div>
      )}
      <div className="btn-row">
        <button
          type="button"
          className="btn blood full"
          onClick={() =>
            onSave({
              small_blind: sb === '' ? undefined : Number(sb),
              big_blind: bb === '' ? undefined : Number(bb),
              ...(anteEnabled ? { ante: ante === '' ? null : Number(ante) } : {}),
            })
          }
        >
          Guardar blinds
        </button>
      </div>
    </Sheet>
  )
}

function EditPrizesSheet({
  open,
  onClose,
  distribution,
  busy,
  onSave,
}: {
  open: boolean
  onClose: () => void
  distribution: DistSlice[]
  busy: boolean
  onSave: (dist: DistSlice[]) => void
}) {
  const [rows, setRows] = useState<PctRow[]>([])
  const wasOpen = useRef(false)

  // Seed the editor from the fecha's current split ONLY on the open transition
  // (the `distribution` prop is a fresh array each render — seeding on every
  // render would wipe the admin's in-progress edits once per clock tick).
  useEffect(() => {
    if (open && !wasOpen.current) setRows(distToRows(distribution))
    wasOpen.current = open
  }, [open, distribution])

  return (
    <Sheet open={open} onClose={onClose} title="Editar premios del torneo">
      <p>
        Cambiá el reparto de premios de esta fecha. Al guardar se recalculan los montos según el
        pozo actual.
      </p>
      <PrizeDistributionEditor rows={rows} onChange={setRows} disabled={busy} />
      <div className="btn-row">
        <button
          type="button"
          className="btn blood full"
          disabled={busy || !isValidDist(rows)}
          onClick={() => onSave(rowsToDist(rows))}
        >
          Guardar premios
        </button>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Simultaneous multi-bust (Phase-2 step 6). Two modes for "2+ out on one hand":
//   • Eliminaron en orden — ordered total−1: the shortest starting stack takes
//     the WORST position. No live stacks in the app, so the admin sets the order
//     (players are shown shortest-chips-first; that order is passed through).
//   • Empataron (reparten) — a dead-even all-in: the tied players SPLIT the
//     positions they occupy (equal points + equal money). NOT co-champions.
// ---------------------------------------------------------------------------
function MultiBustSheet({
  open,
  onClose,
  entries,
  prizes,
  busy,
  onBust,
}: {
  open: boolean
  onClose: () => void
  entries: ConsoleEntry[]
  prizes: Prize[]
  busy: boolean
  onBust: (ids: string[], tied: boolean) => void
}) {
  const [sel, setSel] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) setSel(new Set())
  }, [open])

  // In-play players, shortest chips FIRST (→ worst position in ordered mode).
  const inPlay = useMemo(
    () =>
      entries
        .filter((e) => isInPlay(e.status) && e.status !== 'winner')
        .slice()
        .sort((a, b) => (a.chips ?? 0) - (b.chips ?? 0)),
    [entries],
  )

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Selected ids in the displayed (shortest-first) order.
  const ids = inPlay.filter((e) => sel.has(e.id)).map((e) => e.id)
  const k = ids.length
  // A multi-bust must leave ≥1 survivor: selecting the ENTIRE in-play field is a
  // final-table/heads-up chop, which goes through "Completar fecha", not here.
  const emptiesField = k >= inPlay.length
  const canBust = k >= 2 && !emptiesField

  // Tie money preview: the tied group takes the bottom K positions of the
  // current in-play count → split the summed prize amounts for those positions.
  const tiePositions = Array.from({ length: k }, (_, i) => inPlay.length - i)
  const tieMoneyEach = k >= 2 ? tieSplitMoneyEach(prizes, tiePositions) : 0

  return (
    <Sheet open={open} onClose={onClose} title="Eliminar varios (misma mano)">
      <p>
        Marcá a los jugadores que salieron en la misma mano. <b>En orden</b>: el de menos fichas
        termina más abajo. <b>Empataron</b>: reparten posición, puntos y dinero en partes iguales.
      </p>

      <div className="plist" data-testid="multibust-list" style={{ borderTop: '1.5px solid var(--ink)' }}>
        {inPlay.length === 0 ? (
          <div className="fd-note">No quedan jugadores en juego.</div>
        ) : (
          inPlay.map((e) => {
            const name = e.player?.name ?? 'Jugador'
            return (
              <label key={e.id} className="prow" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={sel.has(e.id)}
                  onChange={() => toggle(e.id)}
                  aria-label={`Eliminar ${name}`}
                />
                <Avatar name={name} url={e.player?.avatar_url} size={36} />
                <div className="pinfo">
                  <b>{name}</b>
                  <div className="sub">
                    {e.chips != null ? `${e.chips.toLocaleString('es-CR')} fichas` : 'En juego'}
                  </div>
                </div>
              </label>
            )
          })
        )}
      </div>

      {k >= 2 && (
        <div className="premios" data-testid="tie-preview" style={{ marginLeft: 0, marginRight: 0 }}>
          <div className="ph">
            <span className="t">Empate de {k}</span>
            <span className="s">si reparten en partes iguales</span>
          </div>
          <div className="prow-prize">
            <span className="nm">Dinero c/u</span>
            <span className="amt">{colonesFull(tieMoneyEach)}</span>
          </div>
        </div>
      )}

      {emptiesField && inPlay.length >= 2 && (
        <div className="fd-note" data-testid="multibust-survivor-hint">
          Debe quedar al menos un jugador en juego. Para un chop de mesa final usá “Completar fecha”.
        </div>
      )}

      <div className="btn-row" style={{ gap: 10 }}>
        <button
          type="button"
          className="btn ghost"
          style={{ flex: 1 }}
          disabled={busy || !canBust}
          onClick={() => onBust(ids, false)}
        >
          En orden ({k})
        </button>
        <button
          type="button"
          className="btn blood"
          style={{ flex: 1 }}
          disabled={busy || !canBust}
          onClick={() => onBust(ids, true)}
        >
          Empataron ({k})
        </button>
      </div>
    </Sheet>
  )
}

function CompleteSheet({
  open,
  onClose,
  entries,
  prizes,
  scoring,
  finishersWithPosition,
  busy,
  onComplete,
}: {
  open: boolean
  onClose: () => void
  entries: ConsoleEntry[]
  prizes: Prize[]
  scoring: ScoringConfig
  finishersWithPosition: number
  busy: boolean
  onComplete: (chopIds: string[]) => void
}) {
  const [chop, setChop] = useState<Set<string>>(new Set())
  const finalists = useMemo(() => entries.filter((e) => isInPlay(e.status)), [entries])

  useEffect(() => {
    if (open) setChop(new Set())
  }, [open])

  const toggle = (id: string) =>
    setChop((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const chopIds = [...chop]
  const preview = chopIds.length >= 2 ? chopPreview(chopIds.length, prizes, finishersWithPosition, scoring) : null

  return (
    <Sheet open={open} onClose={onClose} title="Completar fecha">
      <p>
        Completar calcula los puntos y cierra la fecha. Para un <b>chop</b>, seleccioná a los
        jugadores que reparten los primeros lugares (co-campeones).
      </p>

      <div className="plist" data-testid="chop-list" style={{ borderTop: '1.5px solid var(--ink)' }}>
        {finalists.length === 0 ? (
          <div className="fd-note">No quedan jugadores en juego.</div>
        ) : (
          finalists.map((e) => {
            const name = e.player?.name ?? 'Jugador'
            const checked = chop.has(e.id)
            return (
              <label key={e.id} className="prow" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(e.id)}
                  aria-label={`Chop ${name}`}
                />
                <Avatar name={name} url={e.player?.avatar_url} size={36} />
                <div className="pinfo">
                  <b>{name}</b>
                  <div className="sub">
                    {e.chips != null ? `${e.chips.toLocaleString('es-CR')} fichas` : 'En juego'}
                  </div>
                </div>
              </label>
            )
          })
        )}
      </div>

      {preview && (
        <div className="premios" data-testid="chop-preview" style={{ marginLeft: 0, marginRight: 0 }}>
          <div className="ph">
            <span className="t">Chop de {preview.k}</span>
            <span className="s">reparto en partes iguales</span>
          </div>
          <div className="prow-prize">
            <span className="nm">Dinero c/u</span>
            <span className="amt">{colonesFull(preview.moneyEach)}</span>
          </div>
          <div className="prow-prize">
            <span className="nm">Puntos c/u</span>
            <span className="amt">{preview.pointsEach} pts</span>
          </div>
        </div>
      )}

      <div className="btn-row">
        <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
          Volver
        </button>
        <button
          type="button"
          className="btn blood"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => onComplete(chopIds.length >= 2 ? chopIds : [])}
        >
          {chopIds.length >= 2 ? `Chop y completar (${chopIds.length})` : 'Completar sin chop'}
        </button>
      </div>
    </Sheet>
  )
}
