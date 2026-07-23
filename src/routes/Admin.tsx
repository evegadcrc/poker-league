import { Link } from 'react-router-dom'

/**
 * Admin-only stub behind RequireAdmin. Proves role gating for slice 4; the real
 * admin console (clock, payments, eliminations, CRUD) arrives in later slices.
 */
export default function Admin() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brandtext">
            <span className="kick">Solo admin</span>
            <span className="word">Consola</span>
          </div>
        </div>
        <Link className="btn ghost sm" to="/">
          Volver
        </Link>
      </header>
      <main className="app-main">
        <div className="section-head">
          <div>
            <span className="overline">Administración</span>
            <h1>Consola de admin</h1>
          </div>
        </div>
        <div className="rule" />
        <div className="pad">
          <div className="card">
            <p>
              Área reservada para administradores. Las herramientas de la liga
              (reloj, pagos, eliminaciones, CRUD de fechas) se agregan en
              entregas posteriores.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
