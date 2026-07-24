import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Avatar from '@/components/Avatar'
import Sheet from '@/components/Sheet'
import CreateFecha from '@/routes/admin/CreateFecha'
import LeagueSettings from '@/routes/admin/LeagueSettings'
import type { Json } from '@/lib/database.types'
import { colonesCompact, colonesFull, type EntryStatus } from '@/lib/fechas'
import {
  chopPreview,
  isInPlay,
  playerActions,
  type ClockAction,
  type ScoringConfig,
} from '@/lib/admin'
import {
  findLevel,
  formatClock,
  nextLevel,
  ordinal,
  parsePrizes,
  remainingSeconds,
  showAnte,
  type BlindLevel,
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

const TOURNAMENT_COLUMNS =
  'id, name, season_id, ante_enabled, timer_mode, current_level, level_started_at, is_paused, paused_remaining_seconds, blind_structure_id, prizes, final_table_size, starting_stack'

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
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [confirmKill, setConfirmKill] = useState<ConsoleEntry | null>(null)
  const [noShowFor, setNoShowFor] = useState<ConsoleEntry | null>(null)
  const [blindsOpen, setBlindsOpen] = useState(false)
  const [completeOpen, setCompleteOpen] = useState(false)
  // Fires next_level at most once per level when auto mode hits 0.
  const autoAdvancedLevel = useRef<number | null>(null)

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
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [tid, load])

  const doClock = useCallback(
    async (action: ClockAction, payload?: Json) => {
      if (!tid) return
      setBusy(true)
      const { error } = await supabase.rpc('clock', {
        p_tournament_id: tid,
        p_action: action,
        ...(payload ? { p_payload: payload } : {}),
      })
      setBusy(false)
      if (error) console.error('clock failed', error.message)
      else void load()
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

  // Auto-advance: admin client is the single writer. When timer_mode='auto' and
  // the running clock hits 0, write next_level exactly once for this level.
  useEffect(() => {
    if (state.phase !== 'ready') return
    const { tournament } = state
    if (tournament.timer_mode !== 'auto' || tournament.is_paused) return
    if (remaining > 0) return
    if (autoAdvancedLevel.current === tournament.current_level) return
    autoAdvancedLevel.current = tournament.current_level
    void doClock('next_level')
  }, [state, remaining, doClock])

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

  const runAction = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) console.error(error.message)
    else void load()
  }

  return (
    <>
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
    </>
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
              {entry.chips.toLocaleString('es-CR')} fichas{entry.early_bird ? ' · +2.000' : ''}
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
