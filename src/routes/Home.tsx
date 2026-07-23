import { Link } from 'react-router-dom'
import logo from '@/assets/poker-friends.jpg'
import { useAuth, useRole } from '@/lib/auth'
import { THEME_ICONS, THEME_LABELS, useTheme } from '@/lib/theme'

/**
 * Authenticated home. For slice 4 this is the themed shell stub proving the
 * session + role wiring; the real Liga/Fechas/Vivo/Perfil screens land later.
 */
export default function Home() {
  const { theme, cycleTheme } = useTheme()
  const { player, signOut } = useAuth()
  const { isAdmin } = useRole()

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div
            className="logo-emblem"
            style={{ backgroundImage: `url(${logo})` }}
            role="img"
            aria-label="Poker Friends"
          />
          <div className="brandtext">
            <span className="kick">Temporada 2026</span>
            <span className="word">POKER&nbsp;FRIENDS</span>
          </div>
        </div>
        <div className="tb-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={cycleTheme}
            title={THEME_LABELS[theme]}
            aria-label={`Tema: ${THEME_LABELS[theme]}`}
          >
            {THEME_ICONS[theme]}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => signOut()}>
            Cerrar sesión
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="section-head">
          <div>
            <span className="overline">Liga de póker</span>
            <h1>Hola, {player?.name?.split(' ')[0] ?? 'jugador'}</h1>
          </div>
        </div>
        <div className="rule" />
        <div className="pad">
          <div className="card">
            <p>
              Sesión iniciada como <b>{player?.name}</b>
              {isAdmin ? ' · rol Admin' : ''}. Las pantallas de la liga
              (Tabla, Fechas, En Vivo, Perfil) llegan en las próximas entregas.
            </p>
            {isAdmin && (
              <div style={{ marginTop: 12 }}>
                <Link className="btn blood sm" to="/admin">
                  Consola de admin
                </Link>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
