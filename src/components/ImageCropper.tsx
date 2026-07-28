import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// ImageCropper — a mobile-first "pick the visible area" modal used before an
// image is uploaded, so the stored file is already framed for its card (fecha
// cover ≈ 16/9, profile avatar = 1/1). The user pans (drag) and zooms (slider +
// mouse wheel) inside a fixed aspect-ratio frame; confirming draws the chosen
// source region onto an offscreen canvas and hands back a JPEG blob. UI copy is
// Spanish. The overlay reuses the `.lightbox` visual language (see App.css).
// ---------------------------------------------------------------------------

type CropRect = { sx: number; sy: number; sw: number; sh: number }

/**
 * Pure geometry: the SOURCE rectangle (in image pixels) that the crop frame is
 * currently showing. Kept side-effect-free so it is unit-testable under jsdom
 * (which has no real canvas).
 *
 * - `frameAspect` = width / height of the crop frame.
 * - At `zoom` 1 the source rect is the LARGEST rect of `frameAspect` that fits
 *   inside the image (a "cover" fit); higher zoom shrinks it (magnifies).
 * - `offsetX` / `offsetY` are normalized pan in [0, 1] (0.5 = centered, 0 =
 *   flush to the left/top edge, 1 = flush to the right/bottom). Values are
 *   clamped so the frame is always fully covered — never any empty gutter.
 */
export function computeCropRect({
  imgW,
  imgH,
  frameAspect,
  zoom,
  offsetX,
  offsetY,
}: {
  imgW: number
  imgH: number
  frameAspect: number
  zoom: number
  offsetX: number
  offsetY: number
}): CropRect {
  if (imgW <= 0 || imgH <= 0 || frameAspect <= 0) return { sx: 0, sy: 0, sw: 0, sh: 0 }
  const z = Math.max(1, zoom)
  const imgAspect = imgW / imgH
  // Largest frame-aspect rect that fits the image (cover fit at zoom 1).
  let baseSW: number
  let baseSH: number
  if (imgAspect > frameAspect) {
    baseSH = imgH
    baseSW = imgH * frameAspect
  } else {
    baseSW = imgW
    baseSH = imgW / frameAspect
  }
  const sw = baseSW / z
  const sh = baseSH / z
  const maxSX = Math.max(0, imgW - sw)
  const maxSY = Math.max(0, imgH - sh)
  const ox = Math.min(1, Math.max(0, offsetX))
  const oy = Math.min(1, Math.max(0, offsetY))
  return { sx: maxSX * ox, sy: maxSY * oy, sw, sh }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 4

type ImageCropperProps = {
  file: File
  /** width / height of the crop frame (e.g. 16/9 for a cover, 1 for an avatar). */
  aspect: number
  outputWidth: number
  title?: string
  onCancel: () => void
  onCropped: (blob: Blob) => void
}

export default function ImageCropper({
  file,
  aspect,
  outputWidth,
  title = 'Ajustar la foto',
  onCancel,
  onCropped,
}: ImageCropperProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  // Normalized pan in [0, 1]; 0.5 centers the frame on the image.
  const [offset, setOffset] = useState({ x: 0.5, y: 0.5 })
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [frameW, setFrameW] = useState(0)
  const [busy, setBusy] = useState(false)

  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  // Object URL for the picked file; revoked on unmount so we never leak it.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  // Escape cancels (parity with the lightbox close idiom).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Track the on-screen frame width so pan math maps screen pixels → source
  // pixels correctly across the 3-theme single 480px column.
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const measure = () => setFrameW(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onImgLoad = useCallback(() => {
    const img = imgRef.current
    if (img && img.naturalWidth > 0) setNat({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  const rect = nat
    ? computeCropRect({
        imgW: nat.w,
        imgH: nat.h,
        frameAspect: aspect,
        zoom,
        offsetX: offset.x,
        offsetY: offset.y,
      })
    : null

  // Drag → pan. Convert the screen delta into a normalized offset delta using
  // the source-rect width the frame is currently showing.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current || !nat || frameW <= 0) return
      const dxPx = e.clientX - drag.current.x
      const dyPx = e.clientY - drag.current.y
      drag.current = { x: e.clientX, y: e.clientY }
      const r = computeCropRect({
        imgW: nat.w,
        imgH: nat.h,
        frameAspect: aspect,
        zoom,
        offsetX: offset.x,
        offsetY: offset.y,
      })
      const frameH = frameW / aspect
      const maxSX = Math.max(0, nat.w - r.sw)
      const maxSY = Math.max(0, nat.h - r.sh)
      // screen px → source px, then source px → normalized offset [0,1].
      const dOffX = maxSX > 0 ? -(dxPx * (r.sw / frameW)) / maxSX : 0
      const dOffY = maxSY > 0 ? -(dyPx * (r.sh / frameH)) / maxSY : 0
      setOffset((o) => ({
        x: Math.min(1, Math.max(0, o.x + dOffX)),
        y: Math.min(1, Math.max(0, o.y + dOffY)),
      }))
    },
    [nat, frameW, aspect, zoom, offset.x, offset.y],
  )

  const onPointerUp = useCallback(() => {
    drag.current = null
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z - e.deltaY * 0.002)))
  }, [])

  const confirm = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    setBusy(true)
    const imgW = img.naturalWidth || nat?.w || 0
    const imgH = img.naturalHeight || nat?.h || 0
    const r = computeCropRect({
      imgW,
      imgH,
      frameAspect: aspect,
      zoom,
      offsetX: offset.x,
      offsetY: offset.y,
    })
    const outW = Math.round(outputWidth)
    const outH = Math.round(outputWidth / aspect)
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (ctx && r.sw > 0 && r.sh > 0) {
      ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH)
    }
    canvas.toBlob(
      (blob) => {
        setBusy(false)
        if (blob) onCropped(blob)
      },
      'image/jpeg',
      0.85,
    )
  }, [nat, aspect, zoom, offset.x, offset.y, outputWidth, onCropped])

  // Transform that shows exactly the source rect (sx,sy,sw,sh) scaled to fill
  // the frame: uniform scale = frameW / sw, translated so (sx,sy) → (0,0).
  const imgStyle: React.CSSProperties =
    rect && frameW > 0 && rect.sw > 0
      ? (() => {
          const scale = frameW / rect.sw
          return {
            position: 'absolute',
            top: 0,
            left: 0,
            width: nat!.w * scale,
            height: nat!.h * scale,
            transform: `translate(${-rect.sx * scale}px, ${-rect.sy * scale}px)`,
            maxWidth: 'none',
          }
        })()
      : { position: 'absolute', top: 0, left: 0, visibility: 'hidden' }

  return (
    <div className="lightbox cropper" role="dialog" aria-modal="true" aria-label={title}>
      <div className="cropper-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cropper-title">{title}</div>
        <div
          ref={frameRef}
          className="cropper-frame"
          style={{ aspectRatio: String(aspect) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt=""
              className="cropper-img"
              style={imgStyle}
              onLoad={onImgLoad}
              draggable={false}
            />
          )}
        </div>
        <div className="cropper-zoom">
          <span className="cropper-zoom-ico" aria-hidden="true">
            −
          </span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            aria-label="Acercar"
            onChange={(e) => setZoom(Number(e.target.value))}
          />
          <span className="cropper-zoom-ico" aria-hidden="true">
            +
          </span>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn ghost"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn blood"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={confirm}
          >
            {busy ? 'Procesando…' : 'Usar foto'}
          </button>
        </div>
      </div>
    </div>
  )
}
