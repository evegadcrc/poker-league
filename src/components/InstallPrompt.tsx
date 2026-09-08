import { useEffect, useState } from 'react'
import InstallTour from '@/components/InstallTour'
import {
  installPlatform,
  isMobilePlatform,
  isStandalone,
  markTour,
  tourStatus,
  type BeforeInstallPromptEvent,
} from '@/lib/install'

/** localStorage flag — a permanent dismiss so the banner doesn't nag every load. */
const DISMISS_KEY = 'pf-install-dismissed'

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
 * Both offer "Cómo instalar", the step-by-step InstallTour, which also opens by
 * itself ONCE on a phone that isn't running the installed app. Global — mounted
 * once in AppLayout; styled from the design tokens.
 */
export default function InstallPrompt() {
  const [dismissed, setDismissed] = useState(readDismissed)
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [tourOpen, setTourOpen] = useState(false)

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

  // First visit on a phone, not installed, not dismissed → walk them through once.
  useEffect(() => {
    if (isStandalone() || readDismissed()) return
    if (isMobilePlatform(installPlatform()) && tourStatus() === 'none') {
      markTour('seen')
      setTourOpen(true)
    }
  }, [])

  if (dismissed) return null
  if (isStandalone()) return null

  const iosSafari = installPlatform() === 'ios-safari'

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Ignore storage failures — just hide for this session.
    }
    setTourOpen(false)
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

  const tour = (
    <InstallTour open={tourOpen} onClose={() => setTourOpen(false)} nativePrompt={deferred} />
  )

  // Nothing installable to surface in the banner: no captured native prompt and
  // not iOS Safari. The tour can still be open (first visit on iOS Chrome etc.).
  if (!deferred && !iosSafari) return tour

  return (
    <>
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
        {deferred ? (
          <button type="button" className="btn blood sm" onClick={install}>
            Instalar
          </button>
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => setTourOpen(true)}>
            Cómo instalar
          </button>
        )}
        <button type="button" className="install-close" aria-label="Cerrar" onClick={dismiss}>
          ✕
        </button>
      </div>
      {tour}
    </>
  )
}
