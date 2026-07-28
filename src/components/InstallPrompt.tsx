import { useEffect, useState } from 'react'

/** localStorage flag — a permanent dismiss so the banner doesn't nag every load. */
const DISMISS_KEY = 'pf-install-dismissed'

/**
 * The `beforeinstallprompt` event (Chromium/Android). Not in lib.dom, so declare
 * the shape we use: capture it, `preventDefault()`, and later call `.prompt()`.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/** iOS Safari exposes the legacy standalone flag on navigator. */
type IosNavigator = Navigator & { standalone?: boolean }

/** Running as an installed PWA (Android/desktop display-mode, or iOS standalone). */
function isStandalone(): boolean {
  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches
    ) {
      return true
    }
    return (navigator as IosNavigator).standalone === true
  } catch {
    return false
  }
}

/** iOS Safari can't install programmatically — we show add-to-home instructions. */
function isIosSafari(): boolean {
  const ua = navigator.userAgent
  const isIos = /iphone|ipad|ipod/i.test(ua)
  // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS) etc. on iOS also match "Safari"
  // in their UA but aren't real Safari — exclude the known in-app/other browsers.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios|mercury/i.test(ua)
  return isIos && isSafari
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * "Instalar app" prompt. Renders NOTHING when already installed (standalone) or
 * previously dismissed. On Android/Chromium it captures `beforeinstallprompt` and
 * shows an "Instalar" button that triggers the native install flow; on iOS Safari
 * (no programmatic install) it shows add-to-home-screen instructions instead.
 * Global banner — mounted once in AppLayout; styled from the design tokens.
 */
export default function InstallPrompt() {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    if (isStandalone()) return
    const onBeforeInstall = (e: Event) => {
      // Stop Chrome's default mini-infobar and stash the event for our button.
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  if (dismissed) return null
  if (isStandalone()) return null

  const iosSafari = isIosSafari()
  // Nothing installable to surface: no captured native prompt and not iOS Safari.
  if (!deferred && !iosSafari) return null

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Ignore storage failures — just hide for this session.
    }
    setDismissed(true)
  }

  async function install() {
    if (!deferred) return
    await deferred.prompt()
    try {
      await deferred.userChoice
    } catch {
      // Ignore — the prompt was shown; hide regardless of accept/dismiss.
    }
    setDeferred(null)
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Instalar Poker Friends">
      <span className="install-ic" aria-hidden="true">
        ♠
      </span>
      <div className="install-body">
        <p className="install-title">Instalar Poker Friends</p>
        {deferred ? (
          <p className="install-text">Agregar a la pantalla de inicio para abrirla al instante.</p>
        ) : (
          <p className="install-text">
            Para instalar: tocar el ícono Compartir (
            <span className="install-share" aria-hidden="true">
              ⬆️
            </span>
            ) y luego “Añadir a pantalla de inicio”.
          </p>
        )}
      </div>
      {deferred && (
        <button type="button" className="btn blood sm" onClick={install}>
          Instalar
        </button>
      )}
      <button type="button" className="install-close" aria-label="Cerrar" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
