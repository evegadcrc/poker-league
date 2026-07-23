import './App.css'
import logo from './assets/poker-friends.jpg'
import { THEME_ICONS, THEME_LABELS, useTheme } from './lib/theme'

export default function App() {
  const { theme, cycleTheme } = useTheme()

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
        <button
          type="button"
          className="icon-btn"
          onClick={cycleTheme}
          title={THEME_LABELS[theme]}
          aria-label={`Tema: ${THEME_LABELS[theme]}`}
        >
          {THEME_ICONS[theme]}
        </button>
      </header>

      <main className="app-main">
        <div className="section-head">
          <div>
            <span className="overline">Liga de póker</span>
            <h1>Poker Friends</h1>
          </div>
        </div>
        <div className="rule" />
        <div className="pad">
          <div className="card">
            <p>
              Sistema de diseño activo — tema <b>{THEME_LABELS[theme]}</b>. Toca el
              botón de la cabecera para alternar entre Almanaque claro, Almanaque
              oscuro y Neón.
            </p>
            <div className="form" aria-hidden="true">
              <span className="pill champ">1</span>
              <span className="pill podio">3</span>
              <span className="pill final">5</span>
              <span className="pill out">9</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
