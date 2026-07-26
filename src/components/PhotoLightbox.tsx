import { useEffect } from 'react'

type PhotoLightboxProps = {
  url: string
  /** Accessible label / alt for the enlarged photo (Spanish copy). */
  alt?: string
  onClose: () => void
}

/**
 * Full-screen dim overlay that shows an arbitrary image URL enlarged — the
 * sibling of `AvatarLightbox` for gallery photos and the fecha cover hero.
 * Tapping the overlay, the ✕ button, or pressing Escape closes it. Reuses the
 * `.lightbox` / `.lightbox-close` / `.lightbox-img` visual language (App.css).
 */
export default function PhotoLightbox({ url, alt = 'Foto ampliada', onClose }: PhotoLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button type="button" className="lightbox-close" aria-label="Cerrar" onClick={onClose}>
        ✕
      </button>
      <div className="lightbox-img">
        <img className="lightbox-photo" src={url} alt={alt} />
      </div>
    </div>
  )
}
