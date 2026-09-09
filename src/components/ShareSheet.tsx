import { useEffect, useState } from 'react'
import Sheet from '@/components/Sheet'
import { whatsappShareUrl, writeClipboard } from '@/lib/summary'

// ---------------------------------------------------------------------------
// Share sheet — a ready-to-paste WhatsApp message with a preview, "Compartir en
// WhatsApp" (wa.me; the sender picks the chat) and "Copiar texto". The text is
// built by the caller (convocatoria, fecha result, season standings); this
// component only presents it.
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  onClose: () => void
  title: string
  intro?: string
  text: string
  /** Prefix for data-testids: `${testId}-sheet`, `-text`, `-whatsapp`. */
  testId?: string
}

export default function ShareSheet({ open, onClose, title, intro, text, testId = 'share' }: Props) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => {
    if (open) setCopied(null)
  }, [open])

  const share = () => {
    window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer')
  }
  const copy = async () => {
    const ok = await writeClipboard(text)
    setCopied(ok ? 'ok' : 'fail')
  }

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div data-testid={`${testId}-sheet`}>
        {intro && <p>{intro}</p>}
        <div className="field">
          <label htmlFor={`${testId}-text`}>Mensaje</label>
          <textarea
            id={`${testId}-text`}
            rows={10}
            readOnly
            value={text}
            data-testid={`${testId}-text`}
          />
        </div>
        {copied && (
          <div className="fd-note" role="status">
            <p>
              {copied === 'ok'
                ? '📋 Texto copiado'
                : 'No se pudo copiar — seleccionar el texto y copiarlo a mano.'}
            </p>
          </div>
        )}
        <div className="btn-row">
          <button
            type="button"
            className="btn blood full"
            onClick={share}
            data-testid={`${testId}-whatsapp`}
          >
            Compartir en WhatsApp
          </button>
        </div>
        <div className="btn-row">
          <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={() => void copy()}>
            Copiar texto
          </button>
          <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </Sheet>
  )
}
