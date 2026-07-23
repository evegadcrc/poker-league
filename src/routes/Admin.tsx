import ScreenPlaceholder from '@/components/ScreenPlaceholder'

/**
 * Admin-only screen, rendered inside AppLayout behind RequireAdmin. Placeholder
 * for now — the live console (reloj, pagos, eliminaciones, CRUD de fechas,
 * ajustes de liga) arrives in slices 12-13.
 */
export default function Admin() {
  return (
    <ScreenPlaceholder
      overline="Consola de admin"
      title="Admin"
      note="Herramientas de administración (reloj, pagos, eliminaciones, CRUD de fechas y ajustes de liga) en próximas entregas."
    />
  )
}
