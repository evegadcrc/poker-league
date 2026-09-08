import { useState } from 'react'
import Sheet from '@/components/Sheet'
import {
  installPlatform,
  markTour,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
} from '@/lib/install'
import { writeClipboard } from '@/lib/summary'

// ---------------------------------------------------------------------------
// Install walkthrough — a bottom sheet with the numbered steps to put Poker
// Friends on the home screen, per platform, plus the one thing people miss:
// notifications only arrive from the INSTALLED app, never from a browser tab.
// Auto-opened once by InstallPrompt on phones; re-openable from the banner and
// from Perfil › Notificaciones.
// ---------------------------------------------------------------------------

type Step = { text: string; glyph?: string }

const IOS_STEPS: Step[] = [
  { text: 'Tocar el botón Compartir en la barra de abajo de Safari', glyph: '⬆️' },
  { text: 'Bajar en el menú y elegir «Agregar a pantalla de inicio»', glyph: '➕' },
  { text: 'Tocar «Agregar» arriba a la derecha', glyph: '✅' },
  { text: 'Abrir Poker Friends desde el ícono nuevo en la pantalla de inicio', glyph: '♠' },
]

const ANDROID_STEPS: Step[] = [
  { text: 'Tocar el menú ⋮ de Chrome (arriba a la derecha)', glyph: '⋮' },
  { text: 'Elegir «Instalar app» o «Agregar a pantalla principal»', glyph: '➕' },
  { text: 'Confirmar con «Instalar»', glyph: '✅' },
  { text: 'Abrir Poker Friends desde el ícono nuevo', glyph: '♠' },
]

const DESKTOP_STEPS: Step[] = [
  { text: 'En Chrome o Edge: tocar el ícono de instalar en la barra de direcciones (o menú ⋮ → «Instalar Poker Friends»)', glyph: '⬇️' },
  { text: 'Confirmar con «Instalar»', glyph: '✅' },
]

export const TOUR_TITLE = 'Instalá Poker Friends'
export const TOUR_PUSH_NOTE =
  '🔔 Los avisos (notificaciones) solo llegan desde la app instalada, no desde la pestaña del navegador.'

type Props = {
  open: boolean
  onClose: () => void
  /** Android/Chromium native install prompt captured by the banner, if any. */
  nativePrompt?: BeforeInstallPromptEvent | null
  /** Override for tests; detected from the UA otherwise. */
  platform?: InstallPlatform
}

export default function InstallTour({ open, onClose, nativePrompt = null, platform }: Props) {
  const p = platform ?? installPlatform()
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)

  const done = () => {
    markTour('done')
    onClose()
  }

  const installNative = async () => {
    if (!nativePrompt) return
    try {
      await nativePrompt.prompt()
      await nativePrompt.userChoice
    } catch {
      // The prompt was shown; whatever the choice, close the tour.
    }
    done()
  }

  const copyLink = async () => {
    const ok = await writeClipboard(`${window.location.origin}/`)
    setCopied(ok ? 'ok' : 'fail')
  }

  const steps = p === 'android' ? ANDROID_STEPS : p === 'desktop' ? DESKTOP_STEPS : IOS_STEPS

  return (
    <Sheet open={open} onClose={onClose} title={TOUR_TITLE}>
      <div data-testid="install-tour" data-platform={p}>
        {p === 'ios-other' && (
          <>
            <p>
              En iPhone la app solo se instala desde <b>Safari</b>. Copiar el enlace, abrirlo en
              Safari y seguir estos pasos:
            </p>
            <div className="btn-row">
              <button type="button" className="btn ghost sm" onClick={() => void copyLink()}>
                Copiar enlace
              </button>
            </div>
            {copied && (
              <p role="status">
                {copied === 'ok' ? '📋 Enlace copiado' : 'No se pudo copiar el enlace.'}
              </p>
            )}
          </>
        )}
        {p === 'android' && nativePrompt && (
          <>
            <p>Un toque y listo:</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn blood full"
                onClick={() => void installNative()}
              >
                Instalar ahora
              </button>
            </div>
            <p>O a mano:</p>
          </>
        )}
        {p === 'ios-safari' && <p>Cuatro toques y queda como una app más:</p>}
        <ol className="tour-steps">
          {steps.map((s, i) => (
            <li key={s.text} className="tour-step">
              <span className="tour-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="tour-text">
                {s.text}
                {s.glyph && (
                  <span className="tour-glyph" aria-hidden="true">
                    {s.glyph}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <div className="tour-note">{TOUR_PUSH_NOTE}</div>
        <div className="btn-row">
          <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
            Después
          </button>
          <button type="button" className="btn blood" style={{ flex: 1 }} onClick={done}>
            Listo
          </button>
        </div>
      </div>
    </Sheet>
  )
}
