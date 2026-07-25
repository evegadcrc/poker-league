import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Slice 14 — Galería component (RTL). Mocks useAuth (current player) + the
// supabase client (gallery_photo list read + storage.getPublicUrl). Asserts the
// grid renders one <img> per photo, each lazy-loaded, and that the empty state
// shows when there are no photos.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  player: { id: 'p-me', name: 'Edwin V.', avatar_url: null } as {
    id: string
    name: string
    avatar_url: string | null
  } | null,
  list: { data: [] as unknown, error: null as unknown },
}))

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ player: h.player }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        then: (resolve: (v: unknown) => void) => resolve(h.list),
      }
      return b
    },
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/gallery/${path}` } }),
      }),
    },
  },
}))

import Galeria from './Galeria'

beforeEach(() => {
  h.player = { id: 'p-me', name: 'Edwin V.', avatar_url: null }
  h.list = { data: [], error: null }
})

describe('Galeria', () => {
  it('renders a lazy-loaded photo grid, one img per gallery_photo row', async () => {
    h.list = {
      data: [
        { id: 'g1', storage_path: 'p-me/t1-a.jpg', uploader_id: 'p-me' },
        { id: 'g2', storage_path: 'p2/t1-b.jpg', uploader_id: 'p2' },
      ],
      error: null,
    }
    render(<Galeria tournamentId="t1" />)

    const photos = await screen.findAllByTestId('gal-photo')
    expect(photos).toHaveLength(2)
    // Every photo must be lazy-loaded (perf: a fecha can hold many photos).
    for (const img of photos) {
      expect(img).toHaveAttribute('loading', 'lazy')
    }
    expect(photos[0]).toHaveAttribute('src', 'https://cdn.test/gallery/p-me/t1-a.jpg')
  })

  it('shows the empty state and an upload control for a signed-in member', async () => {
    render(<Galeria tournamentId="t1" />)
    expect(await screen.findByText(/aún no hay fotos/i)).toBeInTheDocument()
    expect(screen.getByTestId('gallery-upload')).toBeInTheDocument()
    expect(screen.queryByTestId('gal-grid')).not.toBeInTheDocument()
  })

  it('the upload trigger is an icon button — aria-label only, no visible "Subir foto" text', async () => {
    render(<Galeria tournamentId="t1" />)
    await screen.findByText(/aún no hay fotos/i)
    const btn = screen.getByTestId('gallery-upload')
    // Accessible name comes from aria-label; no visible text label repeats the header.
    expect(btn).toHaveAccessibleName('Subir foto')
    expect(btn.textContent).not.toMatch(/Subir foto/)
  })
})
