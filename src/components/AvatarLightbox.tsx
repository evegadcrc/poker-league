import { useEffect } from 'react'
import Avatar from './Avatar'

type AvatarLightboxProps = {
  name: string
  url?: string | null
  onClose: () => void
}

/**
 * Full-screen dim overlay that shows a player's avatar enlarged — the uploaded
 * photo when present, else the big initials chip (both via `Avatar`). Tapping
 * anywhere on the overlay, the ✕ button, or pressing Escape closes it. Opened
 * from a Tabla row's avatar (whose tap `stopPropagation`s so the row's stats
 * popup does not also fire).
 */
export default function AvatarLightbox({ name, url, onClose }: AvatarLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Foto de ${name}`}
      onClick={onClose}
    >
      <button type="button" className="lightbox-close" aria-label="Cerrar" onClick={onClose}>
        ✕
      </button>
      <div className="lightbox-img">
        <Avatar name={name} url={url} size={260} />
      </div>
    </div>
  )
}
