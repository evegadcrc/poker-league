import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Web-Audio cue engine (plan step 12). jsdom has no AudioContext, so every test
// either relies on that (safe no-op path) or installs a mock AudioContext whose
// createOscillator/createGain are spies. State lives module-level, so each test
// gets a FRESH module via vi.resetModules() + dynamic import; localStorage
// (the in-memory Storage from src/test/setup.ts) persists across those imports,
// which is exactly what the "reload keeps settings" assertion needs.
// ---------------------------------------------------------------------------

type Spies = {
  createOscillator: ReturnType<typeof vi.fn>
  createGain: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}

function makeAudioParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
}

function installMockAudio(state: 'running' | 'suspended' = 'running'): Spies {
  const createOscillator = vi.fn(() => ({
    type: 'sine' as OscillatorType,
    frequency: makeAudioParam(),
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }))
  const createGain = vi.fn(() => ({ gain: makeAudioParam(), connect: vi.fn() }))
  const resume = vi.fn(() => Promise.resolve())
  class MockAudioContext {
    currentTime = 0
    state = state
    destination = {}
    resume = resume
    createOscillator = createOscillator
    createGain = createGain
  }
  ;(window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext
  return { createOscillator, createGain, resume }
}

function clearMockAudio() {
  const w = window as unknown as {
    AudioContext?: unknown
    webkitAudioContext?: unknown
  }
  delete w.AudioContext
  delete w.webkitAudioContext
}

async function freshSound() {
  vi.resetModules()
  return import('./sound')
}

beforeEach(() => {
  localStorage.clear()
  clearMockAudio()
})

describe('sound settings store', () => {
  it('defaults to unmuted at a mid volume', async () => {
    const s = await freshSound()
    expect(s.getSoundSettings()).toEqual({ muted: false, volume: 0.7 })
  })

  it('persists muted + volume to pf-sound and reloads them', async () => {
    const s = await freshSound()
    s.setMuted(true)
    s.setVolume(0.3)

    const raw = localStorage.getItem('pf-sound')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({ muted: true, volume: 0.3 })

    // "Reload": a fresh module reads the persisted settings.
    const reloaded = await freshSound()
    expect(reloaded.getSoundSettings()).toEqual({ muted: true, volume: 0.3 })
  })

  it('clamps volume into [0,1]', async () => {
    const s = await freshSound()
    s.setVolume(5)
    expect(s.getSoundSettings().volume).toBe(1)
    s.setVolume(-3)
    expect(s.getSoundSettings().volume).toBe(0)
  })

  it('exposes all four cue names', async () => {
    const s = await freshSound()
    expect(s.SOUND_CUES).toEqual([
      'levelWarning',
      'levelChange',
      'tournamentStart',
      'elimination',
    ])
  })
})

describe('playCue', () => {
  it('synthesizes audio nodes when unmuted with volume > 0', async () => {
    const spies = installMockAudio()
    const s = await freshSound()
    s.setMuted(false)
    s.setVolume(0.8)

    s.playCue('tournamentStart')

    // tournamentStart = 4 tones → an oscillator + gain per tone.
    expect(spies.createOscillator).toHaveBeenCalledTimes(4)
    expect(spies.createGain).toHaveBeenCalledTimes(4)
  })

  it('is a no-op when muted (no audio nodes created)', async () => {
    const spies = installMockAudio()
    const s = await freshSound()
    s.setMuted(true)

    s.playCue('levelChange')

    expect(spies.createOscillator).not.toHaveBeenCalled()
    expect(spies.createGain).not.toHaveBeenCalled()
  })

  it('is a no-op when volume is 0', async () => {
    const spies = installMockAudio()
    const s = await freshSound()
    s.setVolume(0)

    s.playCue('elimination')

    expect(spies.createOscillator).not.toHaveBeenCalled()
    expect(spies.createGain).not.toHaveBeenCalled()
  })

  it('resumes a suspended context before playing', async () => {
    const spies = installMockAudio('suspended')
    const s = await freshSound()

    s.playCue('levelWarning')

    expect(spies.resume).toHaveBeenCalled()
    expect(spies.createOscillator).toHaveBeenCalled()
  })

  it('does not throw when no AudioContext is available (safe no-op)', async () => {
    // No mock installed → window.AudioContext is undefined (jsdom).
    const s = await freshSound()
    expect(s.getSoundSettings().muted).toBe(false)
    expect(() => s.playCue('levelChange')).not.toThrow()
    expect(() => s.playCue('levelWarning')).not.toThrow()
    expect(() => s.playCue('tournamentStart')).not.toThrow()
    expect(() => s.playCue('elimination')).not.toThrow()
    expect(() => s.resumeAudio()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Persistent level-end alarm. Unlike the one-shot cues it LOOPS (every ~1.2s)
// until stopped, so the loop tests drive setInterval with fake timers.
// ---------------------------------------------------------------------------
describe('level-end alarm', () => {
  it('sounds a klaxon immediately when started (unmuted)', async () => {
    const spies = installMockAudio()
    const s = await freshSound()

    s.startLevelAlarm()

    // The klaxon is a 2-tone sting → an oscillator + gain per tone.
    expect(spies.createOscillator).toHaveBeenCalledTimes(2)
    expect(spies.createGain).toHaveBeenCalledTimes(2)
    s.stopLevelAlarm()
  })

  it('is a no-op when muted (no audio nodes created)', async () => {
    const spies = installMockAudio()
    const s = await freshSound()
    s.setMuted(true)

    s.startLevelAlarm()

    expect(spies.createOscillator).not.toHaveBeenCalled()
    expect(spies.createGain).not.toHaveBeenCalled()
    s.stopLevelAlarm()
  })

  it('loops until stopped, then stays silent', async () => {
    vi.useFakeTimers()
    try {
      const spies = installMockAudio()
      const s = await freshSound()

      s.startLevelAlarm()
      expect(spies.createOscillator).toHaveBeenCalledTimes(2) // immediate klaxon
      vi.advanceTimersByTime(1300) // one interval → another klaxon
      expect(spies.createOscillator).toHaveBeenCalledTimes(4)
      vi.advanceTimersByTime(1300)
      expect(spies.createOscillator).toHaveBeenCalledTimes(6)

      s.stopLevelAlarm()
      vi.advanceTimersByTime(5000) // no further klaxons after stop
      expect(spies.createOscillator).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start is idempotent — a second call does not stack the loop', async () => {
    vi.useFakeTimers()
    try {
      const spies = installMockAudio()
      const s = await freshSound()

      s.startLevelAlarm()
      s.startLevelAlarm() // ignored while already sounding
      expect(spies.createOscillator).toHaveBeenCalledTimes(2) // one immediate klaxon, not two
      vi.advanceTimersByTime(1300)
      expect(spies.createOscillator).toHaveBeenCalledTimes(4) // one interval, not two

      s.stopLevelAlarm()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not throw when no AudioContext is available (safe no-op)', async () => {
    const s = await freshSound() // jsdom → no AudioContext
    expect(() => s.startLevelAlarm()).not.toThrow()
    expect(() => s.stopLevelAlarm()).not.toThrow()
  })
})
