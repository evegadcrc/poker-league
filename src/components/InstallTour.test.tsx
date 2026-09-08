import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import InstallTour, { TOUR_PUSH_NOTE, TOUR_TITLE } from './InstallTour'
import { TOUR_KEY } from '@/lib/install'

beforeEach(() => {
  localStorage.clear()
})

describe('InstallTour', () => {
  it('iOS Safari: four numbered steps (Compartir → Agregar a pantalla de inicio) + the push note', () => {
    render(<InstallTour open onClose={() => {}} platform="ios-safari" />)
    expect(screen.getByRole('dialog', { name: TOUR_TITLE })).toBeInTheDocument()
    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(4)
    expect(steps[0]).toHaveTextContent(/Compartir/)
    expect(steps[1]).toHaveTextContent(/Agregar a pantalla de inicio/)
    expect(steps[3]).toHaveTextContent(/ícono nuevo/)
    expect(screen.getByText(TOUR_PUSH_NOTE)).toBeInTheDocument()
  })

  it('iOS other browser: explains it must be Safari and offers to copy the link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<InstallTour open onClose={() => {}} platform="ios-other" />)
    expect(screen.getByText(/solo se instala desde/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar enlace' }))
    })
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/`)
    expect(await screen.findByText('📋 Enlace copiado')).toBeInTheDocument()
  })

  it('Android with the native prompt: "Instalar ahora" prompts, then marks the tour done', async () => {
    const onClose = vi.fn()
    const prompt = vi.fn().mockResolvedValue(undefined)
    const nativePrompt = {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
    } as unknown as import('@/lib/install').BeforeInstallPromptEvent
    render(<InstallTour open onClose={onClose} platform="android" nativePrompt={nativePrompt} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Instalar ahora' }))
    })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(TOUR_KEY)).toBe('done')
    expect(onClose).toHaveBeenCalled()
    // Manual steps are still listed for the "O a mano" path.
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(/menú ⋮/)
  })

  it('desktop: two steps, no native button', () => {
    render(<InstallTour open onClose={() => {}} platform="desktop" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Instalar/ })).toBeNull()
  })

  it('"Después" closes without marking done; "Listo" marks done', () => {
    const onClose = vi.fn()
    render(<InstallTour open onClose={onClose} platform="ios-safari" />)
    fireEvent.click(screen.getByRole('button', { name: 'Después' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(TOUR_KEY)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }))
    expect(localStorage.getItem(TOUR_KEY)).toBe('done')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders nothing when closed', () => {
    const { container } = render(<InstallTour open={false} onClose={() => {}} platform="ios-safari" />)
    expect(container).toBeEmptyDOMElement()
  })
})
