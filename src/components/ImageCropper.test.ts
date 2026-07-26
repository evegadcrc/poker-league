import { describe, expect, it } from 'vitest'
import { computeCropRect } from './ImageCropper'

// Pure geometry for the crop frame → source rectangle. jsdom has no real canvas,
// so the drawable math is isolated here (the component only feeds it into
// ctx.drawImage / canvas.toBlob).

describe('computeCropRect', () => {
  it('centers a square crop over a landscape image at zoom 1', () => {
    // 2000×1000 landscape, square frame → tallest square is 1000×1000, centered
    // horizontally: sx = (2000−1000)/2 = 500.
    const r = computeCropRect({
      imgW: 2000,
      imgH: 1000,
      frameAspect: 1,
      zoom: 1,
      offsetX: 0.5,
      offsetY: 0.5,
    })
    expect(r).toEqual({ sx: 500, sy: 0, sw: 1000, sh: 1000 })
  })

  it('centers a square crop over a portrait image at zoom 1', () => {
    // 1000×2000 portrait, square frame → widest square is 1000×1000, centered
    // vertically: sy = (2000−1000)/2 = 500.
    const r = computeCropRect({
      imgW: 1000,
      imgH: 2000,
      frameAspect: 1,
      zoom: 1,
      offsetX: 0.5,
      offsetY: 0.5,
    })
    expect(r).toEqual({ sx: 0, sy: 500, sw: 1000, sh: 1000 })
  })

  it('shrinks the source rect (magnifies) as zoom grows, staying centered', () => {
    const r = computeCropRect({
      imgW: 2000,
      imgH: 1000,
      frameAspect: 1,
      zoom: 2,
      offsetX: 0.5,
      offsetY: 0.5,
    })
    // sw/sh halve; still centered within the larger allowable range.
    expect(r.sw).toBe(500)
    expect(r.sh).toBe(500)
    expect(r.sx).toBe(750) // (2000−500)/2
    expect(r.sy).toBe(250) // (1000−500)/2
  })

  it('clamps panning so the frame is always covered (no gutters)', () => {
    const base = { imgW: 2000, imgH: 1000, frameAspect: 1, zoom: 1 }
    // Flush-left / -right land on the edges of the pan range, never past them.
    expect(computeCropRect({ ...base, offsetX: -5, offsetY: 0.5 }).sx).toBe(0)
    expect(computeCropRect({ ...base, offsetX: 5, offsetY: 0.5 }).sx).toBe(1000) // maxSX
  })

  it('applies a 16/9 frame aspect (cover fit)', () => {
    // 1920×1080 is exactly 16/9 → the whole image is the crop at zoom 1.
    const r = computeCropRect({
      imgW: 1920,
      imgH: 1080,
      frameAspect: 16 / 9,
      zoom: 1,
      offsetX: 0.5,
      offsetY: 0.5,
    })
    expect(r).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 })
  })

  it('returns an empty rect for a not-yet-measured image (defensive)', () => {
    expect(
      computeCropRect({ imgW: 0, imgH: 0, frameAspect: 1, zoom: 1, offsetX: 0.5, offsetY: 0.5 }),
    ).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
  })
})
