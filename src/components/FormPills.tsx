import { cn } from '@/lib/utils'

/**
 * Form-guide result tiers as emitted by the `leaderboard` RPC (0003_points.sql):
 * champion | podium | final | out. Mapped to the prototype's pill classes, which
 * key off the design tokens (`--champ-*` … `--out-*`) so they work in all themes.
 */
const TIER_CLASS: Record<string, string> = {
  champion: 'champ',
  podium: 'podio',
  final: 'final',
  out: 'out',
}
const TIER_LABEL: Record<string, string> = {
  champion: 'Campeón',
  podium: 'Podio',
  final: 'Mesa final',
  out: 'Fuera',
}

type FormPillsProps = {
  /** Tiers from the RPC, MOST-RECENT-FIRST (index 0 = latest game). */
  form: string[]
  /**
   * Finishing positions from the RPC (`form_positions`, mig 0018), aligned 1:1
   * with `form` and in the SAME order (most-recent-first). When present, the
   * number is rendered inside each pill; a missing entry falls back to an empty
   * pill (color only). Optional so older callers / fixtures keep working.
   */
  positions?: number[]
  /**
   * `inline` (default) = the compact leaderboard row strip (`.form`).
   * `full` = the profile "Racha completa" strip with larger pills (`.big-form`).
   */
  variant?: 'inline' | 'full'
}

/**
 * Renders the form pills. CRITICAL: the RPC returns tiers most-recent-first,
 * but the prototype renders newest-on-the-RIGHT — so we reverse the array here
 * (see .harness/notes lessons, slice 5). Each pill now shows the finishing
 * POSITION number (mig 0018) in its tier color; `form` and `positions` are
 * zipped BEFORE reversing so the tier and its number stay paired. A player with
 * no completed games shows no pills.
 */
export default function FormPills({ form, positions, variant = 'inline' }: FormPillsProps) {
  if (form.length === 0) return null
  // Zip tier + position, then reverse the pairs → newest-on-the-RIGHT while the
  // tier/number pairing is preserved. Never mutate the RPC arrays in place.
  const newestOnRight = form
    .map((tier, i) => ({ tier, pos: positions?.[i] }))
    .reverse()
  return (
    <div className={variant === 'full' ? 'big-form' : 'form'} aria-label="Racha reciente">
      {newestOnRight.map(({ tier, pos }, i) => {
        const klass = TIER_CLASS[tier] ?? 'out'
        const tierLabel = TIER_LABEL[tier] ?? 'Fuera'
        const label = pos != null ? `${tierLabel} · ${pos}º` : tierLabel
        return (
          <span
            // Position within the fixed 5-slot window is stable enough as a key.
            key={i}
            className={cn('pill', klass)}
            title={label}
            aria-label={label}
          >
            {pos != null ? pos : null}
          </span>
        )
      })}
    </div>
  )
}
