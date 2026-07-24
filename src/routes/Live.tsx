import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { deriveLiveSignal, useLiveEventCues } from '@/lib/notify'
import Sheet from '@/components/Sheet'
import { aliveCount, colonesCompact, playedCount, type EntryStatus } from '@/lib/fechas'
import {
  chipsInPlay,
  compactChips,
  findLevel,
  formatClock,
  isAlive,
  liveStandings,
  nextLevel,
  ordinal,
  parseDistribution,
  parsePrizes,
  pctLabel,
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
  ante_enabled: boolean
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
  'id, name, ante_enabled, current_level, level_started_at, is_paused, paused_remaining_seconds, blind_structure_id, prizes, payout_distribution'

async function fetchLive(): Promise<State> {
  // A single fecha is live at a time; take the most recent just in case.
  const { data: t, error: tErr } = await supabase
    .from('tournament')
    .select(TOURNAMENT_COLUMNS)
    .eq('status', 'live')
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (tErr) return { phase: 'error' }
  if (!t) return { phase: 'no-live' }
  const tournament = t as LiveTournament

  const [levelsRes, entriesRes, potRes] = await Promise.all([
    tournament.blind_structure_id
      ? supabase
          .from('blind_level')
          .select('level_number, small_blind, big_blind, ante, duration_seconds, is_break')
          .eq('structure_id', tournament.blind_structure_id)
          .order('level_number')
      : Promise.resolve({ data: [] as BlindLevel[], error: null }),
    supabase
      .from('entry')
      .select('id, player_id, status, final_position, chips, player:player_id(name, avatar_url)')
      .eq('tournament_id', tournament.id),
    supabase.rpc('fn_pot', { p_tournament_id: tournament.id }),
  ])

  if (levelsRes.error || entriesRes.error) return { phase: 'error' }

  return {
    phase: 'ready',
    tournament,
    levels: (levelsRes.data ?? []) as BlindLevel[],
    entries: (entriesRes.data ?? []) as EntryRow[],
    prizes: parsePrizes(tournament.prizes),
    // Pot is best-effort: a transient RPC hiccup shouldn't blank the screen.
    pot: potRes.error ? 0 : Number(potRes.data ?? 0),
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

  const { tournament, levels, entries, prizes, pot } = state
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

  const level = findLevel(levels, tournament.current_level)
  const upcoming = nextLevel(levels, tournament.current_level)
  const remaining = remainingSeconds(
    {
      isPaused: tournament.is_paused,
      pausedRemainingSeconds: tournament.paused_remaining_seconds,
      levelStartedAt: tournament.level_started_at,
      levelDurationSeconds: level?.duration_seconds ?? 0,
    },
    now,
  )
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

      <div className={`live-wrap${tournament.is_paused ? ' paused' : ''}`}>
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
        <div className="next-lvl">{nextLabel(upcoming)}</div>
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

      <Premios prizes={displayPrizes} proposed={proposed} />

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
          standings.map((s) => <StandingRow key={s.id} entry={s} />)
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
    </>
  )
}

function nextLabel(level: BlindLevel | null): string {
  if (!level) return 'Último nivel'
  const when = formatClock(level.duration_seconds)
  if (level.is_break) return `Siguiente · Nivel ${level.level_number} — Descanso · ${when}`
  return `Siguiente · Nivel ${level.level_number} — ${level.small_blind} / ${level.big_blind} · ${when}`
}

function Blind({ label, value }: { label: string; value: number }) {
  return (
    <div className="b">
      <div className="v">{value}</div>
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

function Premios({ prizes, proposed = false }: { prizes: Prize[]; proposed?: boolean }) {
  return (
    <div className="premios" data-testid="premios">
      <div className="ph">
        <span className="t">Premios</span>
        <span className="s">{proposed ? 'reparto propuesto' : 'según el pozo'}</span>
      </div>
      {prizes.length === 0 ? (
        <div className="prow-prize">
          <span className="nm">Los premios se definen según el pozo final.</span>
        </div>
      ) : (
        prizes.map((p) => (
          <div className="prow-prize" key={p.position}>
            <span className="pl">{ordinal(p.position)}</span>
            <span className="nm" />
            <span className="pct">{pctLabel(p.pct)}</span>
            <span className="amt">{colonesCompact(p.amount)}</span>
          </div>
        ))
      )}
    </div>
  )
}

function StandingRow({ entry }: { entry: StandingEntry }) {
  const alive = isAlive(entry.status)
  const name = entry.player?.name ?? 'Jugador'
  return (
    <div className={`standing ${alive ? 'alive' : 'out'}`} data-testid="standing">
      <div className="pos">{alive ? '•' : ordinal(entry.final_position ?? 0)}</div>
      <div className="nm">{name}</div>
      {alive && <span className="mini-badge">En juego</span>}
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
