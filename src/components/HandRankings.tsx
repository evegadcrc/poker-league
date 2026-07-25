// ---------------------------------------------------------------------------
// HandRankings (Phase 2, plan step 11). The 10 Texas Hold'em hands, best → worst
// (Escalera Real → Carta Alta), rendered as NATIVE themed UI — real rank labels
// + ♠♥♦♣ suit glyphs reusing the `.red`/`.blk` suit-color idiom from the
// Calculadora — never a raster image, so it stays crisp and theme-aware in all
// three themes (Almanaque claro/oscuro + Neón). Pure static content, no props,
// no backend: reused verbatim by the Calculadora page and the Aprende section.
// ---------------------------------------------------------------------------

/** A single rendered card face: rank label, suit glyph, and its red/black tint. */
type Face = { r: string; s: string; red: boolean }

const SUITS = {
  s: { glyph: '♠', red: false },
  h: { glyph: '♥', red: true },
  d: { glyph: '♦', red: true },
  c: { glyph: '♣', red: false },
} as const
type SuitKey = keyof typeof SUITS

/** Build a card face from a rank label + suit key. */
const c = (r: string, s: SuitKey): Face => ({ r, s: SUITS[s].glyph, red: SUITS[s].red })

type Hand = { key: string; name: string; desc: string; cards: Face[] }

/** Best → worst. Spanish names per plan step 11 + a representative example hand. */
const HANDS: readonly Hand[] = [
  {
    key: 'royal-flush',
    name: 'Escalera Real',
    desc: 'A-K-Q-J-10 del mismo palo. La mejor mano posible.',
    cards: [c('A', 's'), c('K', 's'), c('Q', 's'), c('J', 's'), c('10', 's')],
  },
  {
    key: 'straight-flush',
    name: 'Escalera de Color',
    desc: 'Cinco cartas en secuencia, todas del mismo palo.',
    cards: [c('9', 'h'), c('8', 'h'), c('7', 'h'), c('6', 'h'), c('5', 'h')],
  },
  {
    key: 'four-of-a-kind',
    name: 'Póker',
    desc: 'Cuatro cartas del mismo valor.',
    cards: [c('Q', 's'), c('Q', 'h'), c('Q', 'd'), c('Q', 'c'), c('4', 's')],
  },
  {
    key: 'full-house',
    name: 'Full',
    desc: 'Un trío más una pareja.',
    cards: [c('K', 's'), c('K', 'h'), c('K', 'd'), c('5', 'c'), c('5', 's')],
  },
  {
    key: 'flush',
    name: 'Color',
    desc: 'Cinco cartas del mismo palo, sin importar el orden.',
    cards: [c('A', 'd'), c('J', 'd'), c('8', 'd'), c('6', 'd'), c('3', 'd')],
  },
  {
    key: 'straight',
    name: 'Escalera',
    desc: 'Cinco cartas en secuencia de palos mezclados.',
    cards: [c('8', 'c'), c('7', 'd'), c('6', 's'), c('5', 'h'), c('4', 'c')],
  },
  {
    key: 'three-of-a-kind',
    name: 'Trío',
    desc: 'Tres cartas del mismo valor.',
    cards: [c('7', 's'), c('7', 'h'), c('7', 'd'), c('K', 'c'), c('2', 's')],
  },
  {
    key: 'two-pair',
    name: 'Doble Pareja',
    desc: 'Dos parejas distintas.',
    cards: [c('J', 's'), c('J', 'h'), c('4', 'd'), c('4', 'c'), c('A', 's')],
  },
  {
    key: 'pair',
    name: 'Pareja',
    desc: 'Dos cartas del mismo valor.',
    cards: [c('10', 's'), c('10', 'h'), c('K', 'd'), c('7', 'c'), c('2', 's')],
  },
  {
    key: 'high-card',
    name: 'Carta Alta',
    desc: 'Ninguna combinación: manda la carta más alta.',
    cards: [c('A', 's'), c('K', 'd'), c('9', 'c'), c('6', 'h'), c('3', 's')],
  },
]

/** Native, theme-aware poker hand-rankings reference (best → worst). */
export default function HandRankings() {
  return (
    <ol className="hand-rankings" data-testid="hand-rankings">
      {HANDS.map((h, i) => (
        <li className="hr-row" data-testid="hr-row" data-hand={h.key} key={h.key}>
          <span className="hr-rank" aria-hidden="true">
            {i + 1}
          </span>
          <div className="hr-main">
            <span className="hr-name">{h.name}</span>
            <span className="hr-desc">{h.desc}</span>
          </div>
          <div className="hr-cards" role="img" aria-label={`Ejemplo de ${h.name}`}>
            {h.cards.map((card, k) => (
              <span className={`hr-card ${card.red ? 'red' : 'blk'}`} key={k} aria-hidden="true">
                <b className="hr-rk">{card.r}</b>
                <span className="hr-st">{card.s}</span>
              </span>
            ))}
          </div>
        </li>
      ))}
    </ol>
  )
}
