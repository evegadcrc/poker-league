import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import ConvocatoriaSheet from './ConvocatoriaSheet'
import type { ConvocatoriaEntry } from '@/lib/summary'

const FECHA = {
  id: 't-1',
  name: 'Fecha 9',
  scheduled_at: new Date(2026, 8, 20, 19, 0).toISOString(),
  buy_in: 20000,
}
const ENTRIES: ConvocatoriaEntry[] = [
  { name: 'Edwin V.', status: 'confirmed' },
  { name: 'María R.', status: 'confirmed' },
  { name: 'José V.', status: 'invited' },
]

describe('ConvocatoriaSheet', () => {
  it('shows the roster message with the join link, ready to share or copy', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    render(<ConvocatoriaSheet open onClose={onClose} fecha={FECHA} entries={ENTRIES} />)

    expect(screen.getByRole('dialog', { name: '¡Confirmado! 🎉' })).toBeInTheDocument()
    const text = (screen.getByTestId('convocatoria-text') as HTMLTextAreaElement).value
    expect(text).toContain('🃏 POKER FRIENDS · Fecha 9')
    expect(text).toContain('✅ Confirmados (2):\nEdwin V.\nMaría R.')
    expect(text).not.toContain('Sin responder')
    expect(text).not.toContain('José V.')
    expect(text).toContain(`👉 Confirmar acá: ${window.location.origin}/fechas/t-1`)

    fireEvent.click(screen.getByTestId('convocatoria-whatsapp'))
    expect(open).toHaveBeenCalledTimes(1)
    expect((open.mock.calls[0]![0] as string).startsWith('https://wa.me/?text=')).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copiar texto' }))
    })
    expect(writeText).toHaveBeenCalledWith(text)
    expect(await screen.findByText('📋 Texto copiado')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(onClose).toHaveBeenCalled()
    open.mockRestore()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <ConvocatoriaSheet open={false} onClose={() => {}} fecha={FECHA} entries={ENTRIES} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
