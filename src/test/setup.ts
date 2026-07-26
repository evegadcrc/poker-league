import '@testing-library/jest-dom'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Node 25 exposes an experimental global `localStorage` that shadows jsdom's and
// is not usable without `--localstorage-file`. Install a deterministic in-memory
// Storage so app code (src/lib/theme.tsx) and tests share a working implementation.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
  writable: true,
})
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

// jsdom ships no real canvas and no blob-URL support, both of which the
// ImageCropper (crop-on-upload) touches. Provide deterministic no-op stubs so
// any test that mounts a cropper (Profile / FechaDetail cover) can drive the
// "Usar foto" confirm path without a native canvas backend. The crop GEOMETRY
// is unit-tested separately via the pure `computeCropRect` helper.
URL.createObjectURL = () => 'blob:mock'
URL.revokeObjectURL = () => {}
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => {},
  })) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob(['stub'], { type: 'image/jpeg' }))
  }
}

afterEach(() => {
  cleanup()
})
