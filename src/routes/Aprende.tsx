import HandRankings from '@/components/HandRankings'

// ---------------------------------------------------------------------------
// Aprende (Phase 2, plan step 11). A static, curated Spanish learning section:
// a brief Texas Hold'em how-to (objetivo, ciegas, rondas de apuestas, showdown)
// followed by the native hand-rankings reference (reused verbatim from the
// Calculadora). No backend, no data fetch — purely educational copy styled in
// the design-token system so it reads correctly across all three themes.
// ---------------------------------------------------------------------------

/** The four betting rounds of a Hold'em hand, in order. */
const ROUNDS: readonly { t: string; d: string }[] = [
  {
    t: 'Preflop',
    d: 'Cada jugador recibe 2 cartas ocultas. La apuesta empieza a la izquierda de la ciega grande.',
  },
  {
    t: 'Flop',
    d: 'Se reparten 3 cartas comunitarias boca arriba y se abre una nueva ronda de apuestas.',
  },
  {
    t: 'Turn',
    d: 'Una cuarta carta comunitaria. Otra ronda de apuestas.',
  },
  {
    t: 'River',
    d: 'La quinta y última carta comunitaria, seguida de la ronda final de apuestas.',
  },
]

/** The actions available on your turn. */
const ACTIONS: readonly { t: string; d: string }[] = [
  { t: 'Pasar (check)', d: 'Seguir en la mano sin apostar, si nadie apostó antes.' },
  { t: 'Apostar / Subir (bet / raise)', d: 'Poner fichas o aumentar la apuesta actual.' },
  { t: 'Igualar (call)', d: 'Pagar la apuesta actual para seguir en la mano.' },
  { t: 'Retirarse (fold)', d: 'Abandonar la mano y perder lo apostado hasta ese momento.' },
]

export default function Aprende() {
  return (
    <div data-testid="aprende-root">
      <div className="section-head" style={{ paddingTop: 10 }}>
        <div>
          <span className="overline">Aprende</span>
          <h1>Cómo jugar</h1>
        </div>
      </div>
      <div className="rule" />

      <p className="learn-lead">
        Texas Hold&apos;em: formá la mejor mano de 5 cartas combinando tus 2 cartas ocultas con
        las 5 cartas comunitarias de la mesa.
      </p>

      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Las ciegas</span>
        </div>
      </div>
      <p className="learn-body">
        Antes de repartir, dos jugadores ponen la ciega chica y la ciega grande (blinds) para que
        siempre haya algo en juego. En el torneo suben por niveles: el reloj marca cuándo aumentan.
      </p>

      <div className="rule faint" />

      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Rondas de apuestas</span>
        </div>
      </div>
      <ol className="learn-steps" data-testid="learn-rounds">
        {ROUNDS.map((r, i) => (
          <li className="learn-step" key={r.t}>
            <span className="n" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <span className="t">{r.t}</span>
              <span className="d">{r.d}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="rule faint" />

      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">En tu turno</span>
        </div>
      </div>
      <ul className="learn-actions">
        {ACTIONS.map((a) => (
          <li className="learn-action" key={a.t}>
            <span className="t">{a.t}</span>
            <span className="d">{a.d}</span>
          </li>
        ))}
      </ul>

      <div className="rule faint" />

      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Showdown</span>
        </div>
      </div>
      <p className="learn-body">
        Si tras el river quedan dos o más jugadores, muestran sus cartas y gana la mejor mano de 5.
        Si en cualquier ronda todos se retiran menos uno, ese jugador se lleva el bote sin mostrar.
      </p>

      <div className="rule faint" />

      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Ranking de manos</span>
        </div>
      </div>
      <p className="learn-body" style={{ paddingBottom: 4 }}>
        De la más fuerte a la más débil. Ante manos del mismo tipo, gana la de cartas más altas.
      </p>
      <div className="learn-rankings">
        <HandRankings />
      </div>
    </div>
  )
}
