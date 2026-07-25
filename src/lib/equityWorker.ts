// UI-side factory for the equity Web Worker (Phase 2, plan step 10).
//
// The worker itself (and all the math) lives in src/lib/poker/* — untouched.
// This thin helper is the ONLY place the UI instantiates the worker, so the
// Calculadora screen can `vi.mock` this module in tests and never spin a real
// Worker (jsdom has none). Vite detects the `new URL(..., import.meta.url)`
// pattern and bundles equity.worker.ts as a module worker in the build.

import type { EquityRequest } from './poker/equity.worker'
import type { EquityResult } from './poker/equity'

export type { EquityRequest, EquityResult }

/** Create the equity Monte-Carlo worker. Mocked in tests. */
export function createEquityWorker(): Worker {
  return new Worker(new URL('./poker/equity.worker.ts', import.meta.url), { type: 'module' })
}
