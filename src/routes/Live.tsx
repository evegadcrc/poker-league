import ScreenPlaceholder from '@/components/ScreenPlaceholder'

/** Placeholder — the real live view (reloj, blinds, pozo, posiciones) lands in slice 11. */
export default function Live() {
  return (
    <ScreenPlaceholder
      overline="En juego"
      title="En vivo"
      note="El reloj del torneo, las ciegas, el pozo y las posiciones en vivo llegan en una próxima entrega."
    />
  )
}
