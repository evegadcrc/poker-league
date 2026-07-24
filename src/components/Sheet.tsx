import { useEffect, type ReactNode } from 'react'

type SheetProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}

/**
 * Bottom sheet (ported from the prototype's `.scrim` / `.sheet`). Tapping the
 * scrim or pressing Escape closes it. Rendered inline (no portal) inside the
 * 480px app column; the scrim is fixed + centered so it covers the viewport.
 */
export default function Sheet({ open, onClose, title, children }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grip" aria-hidden="true" />
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}
