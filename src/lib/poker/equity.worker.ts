// Thin Web Worker wrapper around estimateEquity (Phase 2, plan step 9).
//
// All math lives in equity.ts (pure + unit-tested). This file only marshals
// messages so the Monte-Carlo never blocks the UI thread. Instantiate from the
// UI (a later slice) with:
//   new Worker(new URL('./equity.worker.ts', import.meta.url), { type: 'module' })
// Cards cross the boundary as strings ("As","Kh"); the seed keeps results
// reproducible when the caller supplies one.

import { estimateEquity, mulberry32, type EquityResult } from './equity'
import { parseCard } from './cards'

export interface EquityRequest {
  hole: string[]
  board?: string[]
  /** Random opponent count, or explicit opponent hands as string pairs. */
  opponents: number | string[][]
  iterations?: number
  seed?: number
}

self.onmessage = (event: MessageEvent) => {
  const req = event.data as EquityRequest
  const result: EquityResult = estimateEquity({
    hole: req.hole.map(parseCard),
    board: (req.board ?? []).map(parseCard),
    opponents:
      typeof req.opponents === 'number'
        ? req.opponents
        : req.opponents.map((hand) => hand.map(parseCard)),
    iterations: req.iterations,
    rng: mulberry32(req.seed ?? (Date.now() >>> 0)),
  })
  self.postMessage(result)
}
