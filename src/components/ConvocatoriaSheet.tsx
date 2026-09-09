import { useMemo } from 'react'
import ShareSheet from '@/components/ShareSheet'
import { convocatoriaText, type ConvocatoriaEntry } from '@/lib/summary'

// ---------------------------------------------------------------------------
// Convocatoria sheet — the roster message for the group chat (ShareSheet with
// the convocatoria text). Shown to a player right after they confirm ("Voy") so
// the group gets the updated list from whoever just joined, not only the admin.
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

  return (
    <ShareSheet
      open={open}
      onClose={onClose}
      title={title}
      intro={intro}
      text={text}
      testId="convocatoria"
    />
  )
}
