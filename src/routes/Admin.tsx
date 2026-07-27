import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth, useRole } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import {
  approveRequest,
  fetchAutoApprove,
  fetchPendingRequests,
  rejectRequest,
  sendApprovalLink,
  setAutoApprove,
  type SignupRequest,
} from '@/lib/access'
import { deriveLiveSignal, useLiveEventCues } from '@/lib/notify'
import { startLevelAlarm, stopLevelAlarm } from '@/lib/sound'
import Avatar from '@/components/Avatar'
import Sheet from '@/components/Sheet'
import BlindsTable from '@/components/BlindsTable'
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
  parseTopFinishBonuses,
  playerActions,
  tieSplitMoneyEach,
  type ClockAction,
  type ScoringConfig,
} from '@/lib/admin'
import {
  findLevel,
  formatClock,
  nextLabel,
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

type AdminTab = 'consola' | 'crear' | 'jugadores' | 'solicitudes' | 'liga'

// ---------------------------------------------------------------------------
// Admin console (slice 12). Sub-nav: Consola (the live-game control surface,
// built here) · Nueva fecha · Liga (slice-13 stubs). The Consola panel only
// renders when a fecha is live; the admin device is the SOLE clock writer and
// (in timer_mode='auto') advances the level when the local timer reaches 0.
// ---------------------------------------------------------------------------
export default function Admin() {
  const [tab, setTab] = useState<AdminTab>('consola')
  // Pending access requests power both the "Solicitudes" panel and its tab badge,
  // so the queue is loaded here and shared down. loadPending refreshes after any
  // approve/reject so the badge stays in sync.
  const [pending, setPending] = useState<SignupRequest[]>([])
  const [pendingLoading, setPendingLoading] = useState(true)

  const loadPending = useCallback(async () => {
    const { data } = await fetchPendingRequests()
    setPending(data)
    setPendingLoading(false)
  }, [])

  useEffect(() => {
    void loadPending()
  }, [loadPending])

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
          aria-selected={tab === 'jugadores'}
          className={tab === 'jugadores' ? 'on' : ''}
          onClick={() => setTab('jugadores')}
        >
          Jugadores
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'solicitudes'}
          className={tab === 'solicitudes' ? 'on' : ''}
          onClick={() => setTab('solicitudes')}
        >
          Solicitudes
          {pending.length > 0 && (
            <span className="tab-count" data-testid="requests-badge">
              {pending.length}
            </span>
          )}
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
      <div className={`apanel${tab === 'jugadores' ? ' on' : ''}`}>
        {tab === 'jugadores' && <PlayersPanel />}
      </div>
      <div className={`apanel${tab === 'solicitudes' ? ' on' : ''}`}>
        {tab === 'solicitudes' && (
          <RequestsPanel requests={pending} loading={pendingLoading} onReload={loadPending} />
        )}
      </div>
      <div className={`apanel${tab === 'liga' ? ' on' : ''}`}>
        {tab === 'liga' && <LeagueSettings />}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Jugadores tab (Phase 3). ALWAYS shows the full league roster (name + email +
// Admin/Invitado/Bloqueado tags) plus the Agregar-jugador form. Each non-admin,
// non-self, non-guest row carries a Bloquear/Desbloquear toggle
// (set_player_blocked RPC, mig 0023). Roster is read directly from `player`
// (the 0001 "read player" RLS lets an authenticated admin SELECT it) and
// refreshed after an add or a block/unblock.
// ---------------------------------------------------------------------------
type RosterPlayer = {
  id: string
  name: string
  email: string
  is_admin: boolean
  is_guest: boolean
  blocked: boolean
}

function PlayersPanel() {
  const { player } = useAuth()
  const [players, setPlayers] = useState<RosterPlayer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const loadRoster = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('player')
      .select('id, name, email, is_admin, is_guest, blocked')
      .order('name', { ascending: true })
    setLoading(false)
    if (err) {
      setError('No se pudo cargar la lista de jugadores.')
      return
    }
    setError(null)
    setPlayers((data ?? []) as RosterPlayer[])
  }, [])

  useEffect(() => {
    void loadRoster()
  }, [loadRoster])

  const toggleBlock = async (p: RosterPlayer) => {
    // Confirm only when BLOCKING (locking someone out); unblocking is safe.
    if (!p.blocked) {
      const ok = window.confirm(
        `¿Bloquear a ${p.name}? No podrá iniciar sesión hasta que lo desbloqueés.`,
      )
      if (!ok) return
    }
    setBusyId(p.id)
    const { error: err } = await supabase.rpc('set_player_blocked', {
      p_player_id: p.id,
      p_blocked: !p.blocked,
    })
    setBusyId(null)
    if (err) {
      setError('No se pudo actualizar el estado del jugador. Reintentá.')
      return
    }
    setError(null)
    await loadRoster()
  }

  return (
    <div data-testid="players-panel">
      <AddPlayerPanel onAdded={loadRoster} />

      <div className="rule faint" />

      <div className="section-head" style={{ paddingBottom: 6 }}>
        <div>
          <span className="overline">Jugadores de la liga</span>
        </div>
      </div>

      {error && (
        <div className="fd-note" role="alert" data-testid="roster-error" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="fd-note">Cargando jugadores…</div>
      ) : players.length === 0 ? (
        <div className="fd-note" data-testid="players-empty">
          No hay jugadores todavía.
        </div>
      ) : (
        <div className="plist" data-testid="players-roster">
          {players.map((p) => (
            <RosterRow
              key={p.id}
              player={p}
              isSelf={p.id === player?.id}
              busy={busyId === p.id}
              onToggle={() => void toggleBlock(p)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RosterRow({
  player: p,
  isSelf,
  busy,
  onToggle,
}: {
  player: RosterPlayer
  isSelf: boolean
  busy: boolean
  onToggle: () => void
}) {
  // Admins are peers and you can't block yourself → no toggle. Guests are
  // throwaway per-fecha players that never log in → blocking is meaningless.
  const canBlock = !p.is_admin && !isSelf && !p.is_guest
  return (
    <div className="prow" data-testid="roster-row">
      <Avatar name={p.name} size={36} />
      <div className="pinfo">
        <b>{p.name}</b>
        <div className="sub">
          {!p.is_guest && <span className="roster-email">{p.email}</span>}
          {p.is_admin && <span className="mini-badge" data-testid="admin-tag">Admin</span>}
          {p.is_guest && (
            <span className="guest-badge" data-testid="invitado-tag">
              Invitado
            </span>
          )}
          {p.blocked && (
            <span className="block-badge" data-testid="blocked-tag">
              Bloqueado
            </span>
          )}
        </div>
      </div>
      {canBlock && (
        <div className="prow-actions">
          <button
            type="button"
            className={`btn sm ${p.blocked ? 'ghost' : 'blood'}`}
            data-testid="block-toggle"
            disabled={busy}
            onClick={onToggle}
          >
            {p.blocked ? 'Desbloquear' : 'Bloquear'}
          </button>
        </div>
      )}
    </div>
  )
}

function AddPlayerPanel({ onAdded }: { onAdded?: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = name.trim() !== '' && email.trim() !== '' && !busy

  const submit = async () => {
    setBusy(true)
    setOk(null)
    setError(null)
    const { data, error: err } = await supabase.rpc('create_player', {
      p_name: name.trim(),
      p_email: email.trim(),
    })
    setBusy(false)
    if (err) {
      // 23505 = unique_violation on player.email (already a member).
      setError(
        err.code === '23505'
          ? 'Ese correo ya está registrado.'
          : err.message || 'No se pudo agregar el jugador. Reintentá.',
      )
      return
    }
    const rows = (data ?? []) as { name: string }[]
    setOk(`✓ ${rows[0]?.name ?? name.trim()} agregado`)
    setName('')
    setEmail('')
    onAdded?.()
  }

  return (
    <div data-testid="add-player">
      <div className="field" style={{ paddingBottom: 2 }}>
        <label>Agregar jugador</label>
        <div className="hintline">
          Registrá el correo de un amigo para que pueda entrar con su enlace mágico.
        </div>
      </div>
      <div className="field">
        <label htmlFor="ap-name">Nombre</label>
        <input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ap-email">Correo</label>
        <input
          id="ap-email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {error && (
        <div className="fd-note" role="alert" data-testid="add-player-error" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}
      {ok && (
        <div className="fd-note" role="status" data-testid="add-player-ok">
          {ok}
        </div>
      )}

      <div className="btn-row" style={{ padding: '4px 18px 0' }}>
        <button
          type="button"
          className="btn primary full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? 'Agregando…' : 'Agregar jugador'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Solicitudes (Phase 3, migration 0022). The pending access-request queue: a
// first-time login with an unknown email lands here. Aprobar → approve_request
// (creates the player) → sendApprovalLink (magic link); Rechazar → reject_request.
// The list + count are owned by Admin() so the tab badge stays in sync; onReload
// refetches after each decision.
// ---------------------------------------------------------------------------
function formatRequestedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('es-CR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function RequestsPanel({
  requests,
  loading,
  onReload,
}: {
  requests: SignupRequest[]
  loading: boolean
  onReload: () => Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Auto-approve switch: reflects the active season's auto_approve_signups. When
  // ON, an unknown email is approved server-side by request_access (player
  // created + returns 'member' → Login sends the link) with no admin action.
  const [autoOn, setAutoOn] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const { on } = await fetchAutoApprove()
      setAutoOn(on)
    })()
  }, [])

  const toggleAuto = async () => {
    const next = !autoOn
    setAutoBusy(true)
    setError(null)
    setAutoOn(next) // optimistic
    const { error: err } = await setAutoApprove(next)
    setAutoBusy(false)
    if (err) {
      setAutoOn(!next) // revert on failure
      setError('No se pudo cambiar la aprobación automática. Reintentá.')
    }
  }

  const approve = async (r: SignupRequest) => {
    setBusyId(r.id)
    setToast(null)
    setError(null)
    const { email, error: err } = await approveRequest(r.id)
    if (err) {
      setError('No se pudo aprobar la solicitud. Reintentá.')
      setBusyId(null)
      return
    }
    // Approval created the member; now dispatch the magic link to that email.
    if (email) {
      const { error: linkErr } = await sendApprovalLink(email)
      setToast(
        linkErr
          ? `✓ ${email} aprobado. No se pudo enviar el enlace — puede reintentar desde el login.`
          : `✓ ${email} aprobado · enlace enviado`,
      )
    } else {
      setToast('✓ Solicitud aprobada')
    }
    setBusyId(null)
    await onReload()
  }

  const reject = async (r: SignupRequest) => {
    setBusyId(r.id)
    setToast(null)
    setError(null)
    const { error: err } = await rejectRequest(r.id)
    if (err) {
      setError('No se pudo rechazar la solicitud. Reintentá.')
      setBusyId(null)
      return
    }
    setToast('Solicitud rechazada')
    setBusyId(null)
    await onReload()
  }

  return (
    <div data-testid="requests-panel">
      <div className="toggle-row">
        <div>
          <div className="tl">Aprobar solicitudes automáticamente</div>
          <div className="ts">
            Si está activo, cualquier correo nuevo se aprueba solo y recibe el enlace al instante.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="auto-approve-toggle"
          aria-checked={autoOn}
          aria-label="Aprobar solicitudes automáticamente"
          className={`switch${autoOn ? ' on' : ''}`}
          disabled={autoBusy}
          onClick={() => void toggleAuto()}
        />
      </div>

      <div className="field" style={{ paddingBottom: 2 }}>
        <label>Solicitudes de acceso</label>
        <div className="hintline">
          Amigos que intentaron entrar con un correo que aún no está en la liga. Aprobá para
          crearles el jugador y enviarles el enlace mágico, o rechazá.
        </div>
      </div>

      {error && (
        <div className="fd-note" role="alert" data-testid="requests-error" style={{ color: 'var(--oxblood)' }}>
          {error}
        </div>
      )}
      {toast && (
        <div className="fd-note" role="status" data-testid="requests-toast">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="fd-note">Cargando solicitudes…</div>
      ) : requests.length === 0 ? (
        <div className="fd-note" data-testid="requests-empty">
          No hay solicitudes pendientes.
        </div>
      ) : (
        <div className="plist" data-testid="requests-list">
          {requests.map((r) => (
            <div className="prow" key={r.id} data-testid="request-row">
              <div className="pinfo">
                <b>{r.email}</b>
                <div className="sub">{formatRequestedAt(r.created_at)}</div>
              </div>
              <div className="prow-actions">
                <button
                  type="button"
                  className="btn sm blood"
                  disabled={busyId === r.id}
                  onClick={() => void approve(r)}
                >
                  Aprobar
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busyId === r.id}
                  onClick={() => void reject(r)}
                >
                  Rechazar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
  odds_enabled: boolean
}

type ConsoleEntry = {
  id: string
  player_id: string
  status: EntryStatus
  paid: boolean
  chips: number | null
  rebuys_count: number
  early_bird: boolean
  checked_in_at: string | null
  final_position: number | null
  player: { name: string; avatar_url: string | null; is_guest: boolean } | null
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
  'id, name, season_id, ante_enabled, timer_mode, current_level, level_started_at, is_paused, paused_remaining_seconds, blind_structure_id, prizes, payout_distribution, final_table_size, starting_stack, odds_enabled'

async function fetchConsole(): Promise<State> {
  const { data: t, error: tErr } = await supabase
    .from('tournament')
    .select(TOURNAMENT_COLUMNS)
    .eq('status', 'live')
    .is('cancelled_at', null) // a soft-cancelled live fecha can't be run/completed
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
        'id, player_id, status, paid, chips, rebuys_count, early_bird, checked_in_at, final_position, player:player_id(name, avatar_url, is_guest)',
      )
      .eq('tournament_id', tournament.id),
    supabase
      .from('season')
      .select('points_multiplier, bonus_final_table, bonus_attendance, top_finish_bonuses')
      .eq('id', tournament.season_id)
      .maybeSingle(),
    supabase.rpc('fn_pot', { p_tournament_id: tournament.id }),
  ])

  if (levelsRes.error || entriesRes.error || seasonRes.error) return { phase: 'error' }

  // Scoring v2 (mig 0019): mult 5 · final-table 10 · attendance 15 · graduated
  // top-4 [20,15,10,5]. Defaults mirror the season column defaults so the chop
  // preview equals fn_tournament_points even if a column read comes back null.
  const s = (seasonRes.data ?? {}) as {
    points_multiplier?: number
    bonus_final_table?: number
    bonus_attendance?: number
    top_finish_bonuses?: unknown
  }
  return {
    phase: 'ready',
    tournament,
    levels: (levelsRes.data ?? []) as BlindLevel[],
    entries: (entriesRes.data ?? []) as ConsoleEntry[],
    prizes: parsePrizes(tournament.prizes),
    scoring: {
      points_multiplier: s.points_multiplier ?? 5,
      bonus_final_table: s.bonus_final_table ?? 10,
      bonus_attendance: s.bonus_attendance ?? 15,
      top_finish_bonuses: parseTopFinishBonuses(s.top_finish_bonuses),
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
  // Read-only full structure shown on a clock tap — distinct from blindsOpen
  // (the per-level EDIT sheet). Do not conflate the two.
  const [blindsTableOpen, setBlindsTableOpen] = useState(false)
  const [prizesOpen, setPrizesOpen] = useState(false)
  const [multiBustOpen, setMultiBustOpen] = useState(false)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [guestOpen, setGuestOpen] = useState(false)
  const [whatsOpen, setWhatsOpen] = useState(false)
  // Realtime health → subtle reconnect banner (mirrors the En Vivo screen).
  const [conn, setConn] = useState<Conn>('connecting')
  // Transient error surfaced after a failed action RPC (auto-dismisses).
  const [toast, setToast] = useState<string | null>(null)

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

  // Level-END (no more silent auto-advance): when a running auto-mode level's
  // local clock reaches 0 we do NOT fire next_level. Instead we enter a "level
  // ended" state, sound a PERSISTENT alarm, and wait for the admin to start the
  // next level (or pause). Manual mode is unchanged — the admin drives the clock
  // with the "Nivel ▶" control and there is no time-up event to acknowledge.
  const upcoming = state.phase === 'ready' ? nextLevel(state.levels, state.tournament.current_level) : null
  const levelEnded =
    state.phase === 'ready' &&
    state.tournament.timer_mode === 'auto' &&
    !state.tournament.is_paused &&
    state.tournament.level_started_at != null &&
    remaining <= 0
  // Only sound the alarm when there's actually a next level to start; the last
  // level ending is a terminal state (no next-level button, no looping alarm).
  const alarmActive = levelEnded && upcoming != null

  // Drive the persistent alarm off `alarmActive`. Depending only on the boolean
  // means the per-second `now` tick doesn't restart it — the synth's own loop
  // keeps it sounding. The cleanup stops it whenever the level advances, the
  // admin pauses (alarmActive → false), or the console unmounts, so it never
  // lingers after acknowledgement.
  useEffect(() => {
    if (!alarmActive) return
    startLevelAlarm()
    return () => stopLevelAlarm()
  }, [alarmActive])

  // Acknowledge the level-end alarm and start the next level. Silences the alarm
  // immediately (before the RPC round-trips) then advances. `busy` disables the
  // button for the duration of the in-flight RPC, so a double-tap can't
  // double-advance (the next_level RPC is increment-based).
  const startNextLevel = useCallback(() => {
    stopLevelAlarm()
    void doClock('next_level')
  }, [doClock])

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

  const { tournament, entries, prizes, scoring, pot } = state
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
      <div className={`live-wrap${tournament.is_paused ? ' paused' : ''}${levelEnded ? ' ended' : ''}`} style={{ padding: 16 }}>
        <div
          className="clock-tap"
          role="button"
          tabIndex={0}
          data-testid="admin-clock-tap"
          aria-label="Ver estructura de blinds"
          onClick={() => setBlindsTableOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setBlindsTableOpen(true)
            }
          }}
        >
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
        </div>
        {levelEnded ? (
          <div className="level-ended" role="status" data-testid="level-ended">
            <div className="level-ended-msg">
              ¡Tiempo! Nivel {tournament.current_level} terminado
            </div>
            {upcoming ? (
              <button
                type="button"
                className="btn primary wide"
                data-testid="start-next-level"
                disabled={busy}
                onClick={startNextLevel}
              >
                ▶ Iniciar siguiente nivel
              </button>
            ) : (
              <div className="level-ended-final" data-testid="level-ended-final">
                Fin de la estructura · último nivel
              </div>
            )}
          </div>
        ) : (
          <div className="next-lvl" data-testid="admin-next-lvl">
            {nextLabel(upcoming)} ·{' '}
            {tournament.timer_mode === 'auto' ? 'alarma al terminar' : 'avance manual'}
          </div>
        )}
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

      <div className="toggle-row">
        <div>
          <div className="tl">
            Calculadora de probabilidades: {tournament.odds_enabled ? 'Activada' : 'Desactivada'}
          </div>
          <div className="ts">Apagala para que nadie la use mientras juegan esta fecha</div>
        </div>
        <button
          type="button"
          role="switch"
          data-testid="admin-odds-toggle"
          aria-checked={tournament.odds_enabled}
          aria-label="Calculadora de probabilidades"
          className={`switch${tournament.odds_enabled ? ' on' : ''}`}
          disabled={busy}
          onClick={() =>
            void runAction(() =>
              supabase
                .from('tournament')
                .update({ odds_enabled: !tournament.odds_enabled })
                .eq('id', tournament.id),
            )
          }
        />
      </div>

      <div className="section-head" style={{ paddingBottom: 6 }}>
        <div>
          <span className="overline">Jugadores · toca para ajustar</span>
        </div>
        <button
          type="button"
          className="btn ghost sm"
          data-testid="add-guest-btn"
          disabled={busy}
          onClick={() => setGuestOpen(true)}
        >
          + Agregar invitado
        </button>
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

      {/* Agregar invitado — a guest plays this fecha but earns 0 season points */}
      <GuestSheet
        open={guestOpen}
        onClose={() => setGuestOpen(false)}
        busy={busy}
        onAdd={(guestName) => {
          setGuestOpen(false)
          void runAction(() =>
            supabase.rpc('add_guest_entry', {
              p_name: guestName,
              p_tournament_id: tournament.id,
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

      {/* Read-only full blind structure (clock tap) — NOT the edit sheet. */}
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

// ---------------------------------------------------------------------------
// Agregar invitado (Phase 3). A guest plays THIS fecha only, counts toward the
// field size + pot like any entry, but earns 0 season points and never appears
// on the Tabla. Name only → add_guest_entry(name, tournamentId).
// ---------------------------------------------------------------------------
function GuestSheet({
  open,
  onClose,
  busy,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  busy: boolean
  onAdd: (name: string) => void
}) {
  const [name, setName] = useState('')

  useEffect(() => {
    if (open) setName('')
  }, [open])

  return (
    <Sheet open={open} onClose={onClose} title="Agregar invitado">
      <p>
        Un invitado juega esta fecha y cuenta para el pozo, pero no suma puntos de temporada ni
        aparece en la Tabla.
      </p>
      <div className="field">
        <label htmlFor="guest-name">Nombre</label>
        <input
          id="guest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre del invitado"
        />
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn blood full"
          disabled={busy || name.trim() === ''}
          onClick={() => onAdd(name.trim())}
        >
          Agregar invitado
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
  const isGuest = entry.player?.is_guest ?? false
  // On time = checked in while the fecha was still pre-live (early_bird set by
  // check_in / admin_check_in). Shown so the admin can see who arrived on time.
  const onTime = entry.early_bird === true && entry.checked_in_at != null
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
          {isGuest && (
            <span className="guest-badge" data-testid="guest-tag">
              Invitado
            </span>
          )}
          {entry.paid ? (
            <span className="paid-check">✓ Pagó</span>
          ) : (
            <span className="unpaid">● Sin pagar</span>
          )}
          {entry.rebuys_count > 0 && <span className="mini-badge">↺ {entry.rebuys_count}</span>}
          {onTime && (
            <span className="mini-badge ontime" data-testid="admin-ontime-badge">
              A tiempo
            </span>
          )}
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
