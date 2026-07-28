import { useEffect, useMemo, useRef, useState } from 'react'
import { makeCard, formatCard, type Card, type Suit } from '@/lib/poker/cards'
import { categoryOf, evaluate7 } from '@/lib/poker/evaluator'
import { createEquityWorker, type EquityResult } from '@/lib/equityWorker'
import { supabase } from '@/lib/supabase'
import HandRankings from '@/components/HandRankings'

// ---------------------------------------------------------------------------
// Calculadora de probabilidades (Phase 2, plan step 10). A visual Texas
// Hold'em odds calculator: pick your 2 hole cards, an optional board (flop /
// turn / river) and a number of rivals; the win/tie equity is computed off the
// main thread by the Monte-Carlo Web Worker (src/lib/poker/equity.worker.ts,
// via @/lib/equityWorker) so the UI never blocks. Pure client-side — no DB.
// Styled entirely in the design-token system so it renders in all 3 themes.
// ---------------------------------------------------------------------------

/** Fixed seed → identical inputs give identical numbers (no flicker on re-render). */
const EQUITY_SEED = 0xc0ffee
const DEBOUNCE_MS = 250
const MAX_RIVALS = 10

/** Ranks high → low for the picker (14=A … 2). */
const PICKER_RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2] as const
/** Suit rows: glyph, Spanish name (for a11y labels), and red/black color class. */
const SUIT_ROWS: readonly { suit: Suit; glyph: string; name: string; red: boolean }[] = [
  { suit: 's', glyph: '♠', name: 'picas', red: false },
  { suit: 'h', glyph: '♥', name: 'corazones', red: true },
  { suit: 'd', glyph: '♦', name: 'diamantes', red: true },
  { suit: 'c', glyph: '♣', name: 'tréboles', red: false },
]

/** Category (0..8) → Spanish hand name. */
const HAND_NAMES_ES: readonly string[] = [
  'Carta alta',
  'Par',
  'Doble par',
  'Trío',
  'Escalera',
  'Color',
  'Full',
  'Póker',
  'Escalera de color',
]

function rankLabel(rank: number): string {
  if (rank === 14) return 'A'
  if (rank === 13) return 'K'
  if (rank === 12) return 'Q'
  if (rank === 11) return 'J'
  return String(rank)
}

/** Split a card into its rank label + suit glyph/color for rendering. */
function cardFace(card: Card): { rank: string; glyph: string; red: boolean } {
  const suit = SUIT_ROWS.find((r) => r.suit === (['s', 'h', 'd', 'c'][card & 3] as Suit))!
  return { rank: rankLabel((card >> 2) + 2), glyph: suit.glyph, red: suit.red }
}

// Slot layout: 0-1 = Tu mano, 2-6 = Mesa (2-4 flop, 5 turn, 6 river).
const HOLE = [0, 1] as const
const BOARD = [2, 3, 4, 5, 6] as const
const N_SLOTS = 7

type ComputeStatus = 'idle' | 'computing' | 'ready'

// Gate: the calculator is disabled while a LIVE fecha has odds_enabled=false (an
// admin can turn it off so nobody uses it mid-game). 'loading' renders the
// calculator optimistically — we never flash the disabled state before we know.
type GateState = 'loading' | 'enabled' | 'disabled'

export default function Calculadora() {
  const [gate, setGate] = useState<GateState>('loading')

  // One-shot check on mount: is there a live fecha that disables the calculator?
  // Fail open (enabled) on any error — the calculator is a harmless reference.
  useEffect(() => {
    let alive = true
    void (async () => {
      const { data, error } = await supabase
        .from('tournament')
        .select('id')
        .eq('status', 'live')
        .is('cancelled_at', null) // a cancelled live fecha must not gate the calc
        .eq('odds_enabled', false)
        .limit(1)
        .maybeSingle()
      if (!alive) return
      setGate(!error && data ? 'disabled' : 'enabled')
    })()
    return () => {
      alive = false
    }
  }, [])

  const [slots, setSlots] = useState<(Card | null)[]>(() => Array(N_SLOTS).fill(null))
  const [active, setActive] = useState<number | null>(0)
  const [rivals, setRivals] = useState(1)
  const [status, setStatus] = useState<ComputeStatus>('idle')
  const [result, setResult] = useState<EquityResult | null>(null)
  const [showRankings, setShowRankings] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  // Guards against a stale worker reply landing after the inputs became
  // non-computable (e.g. the user cleared a card mid-compute).
  const wantResultRef = useRef(false)

  // One worker for the screen's lifetime. Replies flow straight into state.
  useEffect(() => {
    const worker = createEquityWorker()
    worker.onmessage = (e: MessageEvent) => {
      if (!wantResultRef.current) return
      setResult(e.data as EquityResult)
      setStatus('ready')
    }
    workerRef.current = worker
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const used = useMemo(() => new Set(slots.filter((c): c is Card => c != null)), [slots])
  const remaining = 52 - used.size

  const holeCards = slots.slice(0, 2).filter((c): c is Card => c != null)
  const boardCards = BOARD.map((i) => slots[i]).filter((c): c is Card => c != null)
  const boardCount = boardCards.length
  const computable =
    holeCards.length === 2 && [0, 3, 4, 5].includes(boardCount) && rivals >= 1

  // The hero's current made hand (main-thread, cheap) once a flop is out.
  const madeHand =
    holeCards.length === 2 && boardCount >= 3
      ? HAND_NAMES_ES[categoryOf(evaluate7([...holeCards, ...boardCards]))]
      : null

  // A primitive request signature: the compute effect re-fires only when the
  // serialized inputs actually change (React compares the string by value), so
  // no array-identity churn and no exhaustive-deps escape hatch is needed.
  const reqKey = JSON.stringify({
    h: holeCards.map(formatCard),
    b: boardCards.map(formatCard),
    r: rivals,
    ok: computable,
  })

  useEffect(() => {
    const { h, b, r, ok } = JSON.parse(reqKey) as {
      h: string[]
      b: string[]
      r: number
      ok: boolean
    }
    wantResultRef.current = ok
    if (!ok) {
      setStatus('idle')
      setResult(null)
      return
    }
    setStatus('computing')
    const id = setTimeout(() => {
      workerRef.current?.postMessage({ hole: h, board: b, opponents: r, seed: EQUITY_SEED })
    }, DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [reqKey])

  const nextEmpty = (arr: (Card | null)[], after: number): number | null => {
    for (let i = after + 1; i < N_SLOTS; i++) if (arr[i] == null) return i
    for (let i = 0; i <= after; i++) if (arr[i] == null) return i
    return null
  }
  const firstEmpty = (arr: (Card | null)[]): number | null => {
    const i = arr.findIndex((c) => c == null)
    return i === -1 ? null : i
  }

  const pickCard = (card: Card) => {
    if (used.has(card)) return
    const target = active ?? firstEmpty(slots)
    if (target == null) return
    setSlots((prev) => {
      const next = prev.slice()
      next[target] = card
      setActive(nextEmpty(next, target))
      return next
    })
  }

  const tapSlot = (i: number) => {
    setSlots((prev) => {
      if (prev[i] != null) {
        const next = prev.slice()
        next[i] = null
        return next
      }
      return prev
    })
    setActive(i)
  }

  const reset = () => {
    setSlots(Array(N_SLOTS).fill(null))
    setActive(0)
    setResult(null)
    setStatus('idle')
  }

  // Disabled by a live fecha (odds_enabled=false): show the message, keep the
  // hand-rankings reference available. 'loading' falls through to the calculator
  // so the normal case never flashes a disabled state before the check resolves.
  if (gate === 'disabled') {
    return (
      <div data-testid="calc-root">
        <div className="section-head" style={{ paddingTop: 10 }}>
          <div>
            <span className="overline">Probabilidades</span>
            <h1>Calculadora</h1>
          </div>
        </div>
        <div className="rule" />
        <div className="calc-disabled" data-testid="calc-disabled" role="status">
          <p>La calculadora está deshabilitada durante la fecha en curso.</p>
        </div>
        <div className="calc-rankings">
          <button
            type="button"
            className="calc-rankings-toggle"
            aria-expanded={showRankings}
            aria-controls="calc-rankings-body"
            data-testid="rankings-toggle"
            onClick={() => setShowRankings((v) => !v)}
          >
            <span>Ranking de manos</span>
            <span className="chev" aria-hidden="true">
              ⌄
            </span>
          </button>
          {showRankings && (
            <div className="calc-rankings-body" id="calc-rankings-body">
              <HandRankings />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div data-testid="calc-root">
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">Probabilidades</span>
          <h1>Calculadora</h1>
        </div>
        <button type="button" className="btn ghost sm" onClick={reset} data-testid="calc-reset">
          Limpiar
        </button>
      </div>
      <div className="rule" />

      <div className="calc-slots">
        <div className="calc-group">
          <span className="calc-cap">Mano</span>
          <div className="calc-slot-row">
            {HOLE.map((i) => (
              <Slot
                key={i}
                card={slots[i]}
                active={active === i}
                testId={`slot-hole-${i}`}
                label={`Mano, carta ${i + 1}`}
                onTap={() => tapSlot(i)}
              />
            ))}
          </div>
        </div>

        <div className="calc-group calc-grow">
          <span className="calc-cap">Mesa</span>
          <div className="calc-slot-row">
            {BOARD.map((i, k) => (
              <Slot
                key={i}
                card={slots[i]}
                active={active === i}
                gap={k === 3}
                small
                testId={`slot-board-${k}`}
                label={`Mesa, carta ${k + 1}`}
                onTap={() => tapSlot(i)}
              />
            ))}
          </div>
          <span className="calc-subcap">Flop · Turn · River</span>
        </div>
      </div>

      <div className="calc-rivals">
        <div>
          <div className="calc-cap">Rivales</div>
          <div className="calc-subcap">Manos aleatorias de los rivales</div>
        </div>
        <div className="calc-stepper">
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Menos rivales"
            disabled={rivals <= 1}
            onClick={() => setRivals((r) => Math.max(1, r - 1))}
          >
            −
          </button>
          <span className="calc-riv-n" data-testid="rivals-n">
            {rivals}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Más rivales"
            disabled={rivals >= MAX_RIVALS}
            onClick={() => setRivals((r) => Math.min(MAX_RIVALS, r + 1))}
          >
            +
          </button>
        </div>
      </div>

      <div className="calc-restantes">
        Cartas restantes: <b data-testid="restantes">{remaining}</b>
      </div>

      <Results status={status} result={result} computable={computable} hole={holeCards.length} board={boardCount} madeHand={madeHand} />

      <div className="calc-picker" role="group" aria-label="Elegir una carta">
        {SUIT_ROWS.map((row) => (
          <div className="calc-prow" key={row.suit}>
            <span className={`calc-suit ${row.red ? 'red' : 'blk'}`} aria-hidden="true">
              {row.glyph}
            </span>
            {PICKER_RANKS.map((rank) => {
              const card = makeCard(rank, row.suit)
              const disabled = used.has(card)
              return (
                <button
                  key={rank}
                  type="button"
                  className={`calc-card ${row.red ? 'red' : 'blk'}`}
                  aria-label={`${rankLabel(rank)} de ${row.name}`}
                  disabled={disabled}
                  onClick={() => pickCard(card)}
                >
                  {rankLabel(rank)}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="calc-rankings">
        <button
          type="button"
          className="calc-rankings-toggle"
          aria-expanded={showRankings}
          aria-controls="calc-rankings-body"
          data-testid="rankings-toggle"
          onClick={() => setShowRankings((v) => !v)}
        >
          <span>Ranking de manos</span>
          <span className="chev" aria-hidden="true">
            ⌄
          </span>
        </button>
        {showRankings && (
          <div className="calc-rankings-body" id="calc-rankings-body">
            <HandRankings />
          </div>
        )}
      </div>
    </div>
  )
}

function Slot({
  card,
  active,
  small = false,
  gap = false,
  label,
  testId,
  onTap,
}: {
  card: Card | null
  active: boolean
  small?: boolean
  gap?: boolean
  label: string
  testId: string
  onTap: () => void
}) {
  const face = card != null ? cardFace(card) : null
  return (
    <button
      type="button"
      data-testid={testId}
      className={`calc-slot${small ? ' sm' : ''}${active ? ' on' : ''}${face ? ' filled' : ''}${gap ? ' gap' : ''}`}
      aria-label={face ? `${label}: quitar` : `${label}: vacía`}
      onClick={onTap}
    >
      {face ? (
        <>
          <span className={`rk ${face.red ? 'red' : 'blk'}`}>{face.rank}</span>
          <span className={`st ${face.red ? 'red' : 'blk'}`}>{face.glyph}</span>
        </>
      ) : (
        <span className="ph" aria-hidden="true">
          +
        </span>
      )}
    </button>
  )
}

function Results({
  status,
  result,
  computable,
  hole,
  board,
  madeHand,
}: {
  status: ComputeStatus
  result: EquityResult | null
  computable: boolean
  hole: number
  board: number
  madeHand: string | null
}) {
  const pct = (x: number) => `${Math.round(x * 100)}%`

  if (!computable) {
    let hint = 'Elegir 2 cartas para empezar.'
    if (hole === 2 && (board === 1 || board === 2))
      hint = 'Completar el flop (3 cartas) para ver las probabilidades.'
    return (
      <div className="calc-results empty" data-testid="calc-results">
        <p>{hint}</p>
      </div>
    )
  }

  if (status !== 'ready' || !result) {
    return (
      <div className="calc-results" data-testid="calc-results" aria-busy="true">
        <div className="calc-spinner" aria-hidden="true" />
        <span className="calc-computing">Calculando…</span>
      </div>
    )
  }

  return (
    <div className="calc-results" data-testid="calc-results">
      <div className="calc-eq">
        <div className="c win">
          <div className="v" data-testid="win-pct">
            {pct(result.win)}
          </div>
          <div className="k">Ganar</div>
        </div>
        <div className="c">
          <div className="v" data-testid="tie-pct">
            {pct(result.tie)}
          </div>
          <div className="k">Empate</div>
        </div>
        <div className="c">
          <div className="v" data-testid="lose-pct">
            {pct(result.lose)}
          </div>
          <div className="k">Perder</div>
        </div>
      </div>
      {madeHand && (
        <div className="calc-hand" data-testid="made-hand">
          Mejor mano: <b>{madeHand}</b>
        </div>
      )}
    </div>
  )
}
