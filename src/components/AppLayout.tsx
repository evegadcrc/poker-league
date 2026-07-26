import { Link, NavLink, Outlet } from 'react-router-dom'
import logo from '@/assets/poker-friends.jpg'
import { useRole } from '@/lib/auth'
import { THEME_ICONS, THEME_LABELS, useTheme } from '@/lib/theme'
import { useWakeLock } from '@/lib/useWakeLock'
import { cn } from '@/lib/utils'
import InstallPrompt from './InstallPrompt'

type Tab = { to: string; label: string; icon: string; end?: boolean; adminOnly?: boolean }

/** Bottom tab nav — Liga/Fechas/En Vivo/Perfil, plus Admin only for admins. */
const TABS: readonly Tab[] = [
  { to: '/', label: 'Liga', icon: '♠', end: true },
  { to: '/fechas', label: 'Fechas', icon: '▦' },
  { to: '/vivo', label: 'En Vivo', icon: '◷' },
  { to: '/admin', label: 'Admin', icon: '✦', adminOnly: true },
  { to: '/perfil', label: 'Perfil', icon: '◑' },
]

/**
 * Authenticated app shell: themed top bar (logo + POKER FRIENDS wordmark +
 * 3-way theme-cycle button) and a bottom tab nav rendered around the routed
 * screen (`<Outlet/>`). The Admin tab appears only when `useRole().isAdmin` —
 * this replaces the prototype's demo-only role switch. All colors come from the
 * design tokens so the shell works across the three themes.
 */
export default function AppLayout() {
  const { theme, cycleTheme } = useTheme()
  const { isAdmin } = useRole()
  // Keep the device screen awake while the app is open (live clock, galleries).
  useWakeLock()

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
            <span className="kick">Liga de póker</span>
            <span className="word">POKER&nbsp;FRIENDS</span>
          </div>
        </div>
        <div className="tb-actions">
          <Link
            to="/aprende"
            className="icon-btn"
            title="Aprende a jugar"
            aria-label="Aprende a jugar"
          >
            ?
          </Link>
          <Link
            to="/calculadora"
            className="icon-btn"
            title="Calculadora de probabilidades"
            aria-label="Calculadora de probabilidades"
          >
            %
          </Link>
          <button
            type="button"
            className="icon-btn"
            onClick={cycleTheme}
            title={THEME_LABELS[theme]}
            aria-label={`Tema: ${THEME_LABELS[theme]}`}
          >
            {THEME_ICONS[theme]}
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="tabs" aria-label="Navegación principal">
        {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => cn('tab', isActive && 'on')}
          >
            <span className="ic" aria-hidden="true">
              {t.icon}
            </span>
            <span className="lb">{t.label}</span>
          </NavLink>
        ))}
      </nav>

      <InstallPrompt />
    </div>
  )
}
