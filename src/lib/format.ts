// ---------------------------------------------------------------------------
// Shared number formatting. Costa Rica groups thousands with "." (10000 →
// "10.000"); money is whole colones. This mirrors the grouping used on the
// fecha money inputs so the live scoreboard reads the same way.
// ---------------------------------------------------------------------------

/**
 * Group thousands with "." (period). Deterministic — rounds to a whole number
 * then inserts a "." before every group of three trailing digits.
 * `formatMiles(10000)` → `"10.000"`, `formatMiles(50)` → `"50"`.
 */
export function formatMiles(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Strip every non-digit and return the raw integer (empty → 0). The inverse of
 *  `formatMiles` for controlled ₡ inputs: "₡20.000" / "20 000" / "20000" → 20000. */
export function parseMoney(s: string): number {
  const digits = s.replace(/\D/g, '')
  return digits === '' ? 0 : Number(digits)
}
