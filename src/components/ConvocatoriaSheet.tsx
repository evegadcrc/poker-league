import { useEffect, useMemo, useState } from 'react'
import Sheet from '@/components/Sheet'
import {
  convocatoriaText,
  whatsappShareUrl,
  writeClipboard,
  type ConvocatoriaEntry,
} from '@/lib/summary'

// ---------------------------------------------------------------------------
// Convocatoria sheet — the roster message for the group chat, with a preview,
// "Compartir en WhatsApp" (wa.me; the sender picks the chat) and "Copiar texto".
// Shown to a player right after they confirm ("Voy") so the group gets the
// updated list from whoever just joined, not only from the admin.
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  onClose: () => void
  title?: string
  intro?: string
  fecha: { id: string; name: string; scheduled_at: string; buy_in: number | null; guests_open?: boolean }
  entries: readonly ConvocatoriaEntry[]
}

export default function ConvocatoriaSheet({
  open,
  onClose,
  title = '¡Confirmado! 🎉',
  intro = 'Compartir la lista actualizada en el grupo:',
  fecha,
  entries,
}: Props) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => {
    if (open) setCopied(null)
  }, [open])

  const text = useMemo(
    () =>
      convocatoriaText({
        fechaName: fecha.name,
        scheduledAt: fecha.scheduled_at,
        buyIn: fecha.buy_in,
        entries,
        link: `${window.location.origin}/fechas/${fecha.id}`,
        guestsOpen: fecha.guests_open ?? false,
      }),
    [fecha.name, fecha.scheduled_at, fecha.buy_in, fecha.id, fecha.guests_open, entries],
  )

  const share = () => {
    window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer')
  }
  const copy = async () => {
    const ok = await writeClipboard(text)
    setCopied(ok ? 'ok' : 'fail')
  }

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div data-testid="convocatoria-sheet">
        <p>{intro}</p>
        <div className="field">
          <label htmlFor="convocatoria-text">Mensaje</label>
          <textarea
            id="convocatoria-text"
            rows={10}
            readOnly
            value={text}
            data-testid="convocatoria-text"
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
            data-testid="convocatoria-whatsapp"
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
