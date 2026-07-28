import { useCallback, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { useLoadable } from '@/lib/useLoadable'
import PhotoLightbox from './PhotoLightbox'

// ---------------------------------------------------------------------------
// Galería — per-fecha photo grid (Phase 2, slice 14). Embedded as a section in
// FechaDetail (the gallery is inherently per-tournament, and the admin "set
// cover" affordance lives on the same screen). Reads gallery_photo rows for the
// fecha and renders them lazy-loaded from the PUBLIC `gallery` bucket; any
// league member may add a photo (upload the object under their own player-id
// folder → insert their gallery_photo row, both gated by the 0016 RLS).
// UI copy is Spanish.
// ---------------------------------------------------------------------------
type PhotoRow = { id: string; storage_path: string; uploader_id: string }
type Photo = { id: string; url: string; uploaderId: string }

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; photos: Photo[] }

type Upload = { status: 'idle' } | { status: 'uploading' } | { status: 'error'; message: string }

/** Public URL for an object in the `gallery` bucket (no transform — imgproxy). */
export function galleryUrl(path: string): string {
  return supabase.storage.from('gallery').getPublicUrl(path).data.publicUrl
}

async function fetchPhotos(tournamentId: string): Promise<State> {
  const { data, error } = await supabase
    .from('gallery_photo')
    .select('id, storage_path, uploader_id')
    .eq('tournament_id', tournamentId)
    .order('created_at', { ascending: false })

  if (error) return { status: 'error' }
  const photos = ((data ?? []) as PhotoRow[]).map((r) => ({
    id: r.id,
    url: galleryUrl(r.storage_path),
    uploaderId: r.uploader_id,
  }))
  return { status: 'ready', photos }
}

export default function Galeria({ tournamentId }: { tournamentId: string }) {
  const { player } = useAuth()
  const { state, reload } = useLoadable<State>({ status: 'loading' }, () => fetchPhotos(tournamentId), [
    tournamentId,
  ])
  const [upload, setUpload] = useState<Upload>({ status: 'idle' })
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const openPicker = useCallback(() => inputRef.current?.click(), [])

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = '' // allow re-selecting the same file
      if (!file || !player) return

      setUpload({ status: 'uploading' })
      // Key the object under the uploader's player-id folder so the owner-only
      // storage RLS (0016) matches; a random suffix keeps every photo distinct.
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
      const path = `${player.id}/${tournamentId}-${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from('gallery')
        .upload(path, file, { contentType: file.type || undefined })
      if (upErr) {
        setUpload({ status: 'error', message: 'No se pudo subir la foto. Intentar de nuevo.' })
        return
      }

      const { error: insErr } = await supabase
        .from('gallery_photo')
        .insert({ tournament_id: tournamentId, uploader_id: player.id, storage_path: path })
      if (insErr) {
        setUpload({ status: 'error', message: 'La foto se subió, pero no se pudo guardar.' })
        return
      }

      setUpload({ status: 'idle' })
      reload({ silent: true })
    },
    [player, tournamentId, reload],
  )

  const uploading = upload.status === 'uploading'
  const photos = state.status === 'ready' ? state.photos : []

  return (
    <section className="gallery" data-testid="gallery">
      <div className="section-head" style={{ paddingBottom: 2 }}>
        <div>
          <span className="overline">Galería</span>
        </div>
        {player && (
          <button
            type="button"
            className="upload-icon"
            onClick={openPicker}
            disabled={uploading}
            aria-label="Subir foto"
            title={uploading ? 'Subiendo…' : 'Subir foto'}
            data-testid="gallery-upload"
          >
            📷
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label="Subir foto"
        onChange={onFile}
        disabled={uploading}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}
      />

      {upload.status === 'error' && (
        <div className="fd-note" role="alert">
          <p>{upload.message}</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="fd-note" role="alert">
          <p>No se pudo cargar la galería.</p>
          <button type="button" className="btn ghost sm" onClick={() => reload()}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'ready' && photos.length === 0 && (
        <div className="fd-note">
          <p>Aún no hay fotos de esta fecha.</p>
        </div>
      )}

      {photos.length > 0 && (
        <div className="gal-grid" data-testid="gal-grid">
          {photos.map((p) => (
            <img
              key={p.id}
              className="gal-photo"
              src={p.url}
              alt="Foto de la fecha"
              loading="lazy"
              decoding="async"
              data-testid="gal-photo"
              role="button"
              tabIndex={0}
              aria-label="Ampliar foto"
              onClick={() => setZoomedUrl(p.url)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setZoomedUrl(p.url)
                }
              }}
            />
          ))}
        </div>
      )}

      {zoomedUrl && (
        <PhotoLightbox url={zoomedUrl} alt="Foto de la fecha" onClose={() => setZoomedUrl(null)} />
      )}
    </section>
  )
}
