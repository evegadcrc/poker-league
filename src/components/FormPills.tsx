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
   * `inline` (default) = the compact leaderboard row strip (`.form`).
   * `full` = the profile "Racha completa" strip with larger pills (`.big-form`).
   */
  variant?: 'inline' | 'full'
}

/**
 * Renders the form pills. CRITICAL: the RPC returns tiers most-recent-first,
 * but the prototype renders newest-on-the-RIGHT — so we reverse the array here
 * (see .harness/notes lessons, slice 5). A player with no completed games shows
 * no pills.
 */
export default function FormPills({ form, variant = 'inline' }: FormPillsProps) {
  if (form.length === 0) return null
  // Copy before reversing — never mutate the RPC array in place.
  const newestOnRight = [...form].reverse()
  return (
    <div className={variant === 'full' ? 'big-form' : 'form'} aria-label="Racha reciente">
      {newestOnRight.map((tier, i) => {
        const klass = TIER_CLASS[tier] ?? 'out'
        const label = TIER_LABEL[tier] ?? 'Fuera'
        return (
          <span
            // Position within the fixed 5-slot window is stable enough as a key.
            key={i}
            className={cn('pill', klass)}
            title={label}
            aria-label={label}
          />
        )
      })}
    </div>
  )
}
