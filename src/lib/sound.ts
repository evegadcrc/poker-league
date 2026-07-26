import { useSyncExternalStore } from 'react'

/**
 * Web-Audio cue engine (plan step 12). Cues are SYNTHESIZED on the fly with
 * oscillators + gain envelopes — there are no binary audio assets, so the whole
 * thing is tiny and theme-agnostic. Nothing is wired to tournament events here;
 * that lands in step 13. This slice only ships the engine + persisted settings
 * + the ability to play a named cue.
 *
 * Two consumers read the settings: a React control (via `useSound`) and the
 * plain engine (`playCue`, called from event handlers). So state lives in a
 * small module-level store (mirrors the `theme.tsx` localStorage idiom) exposed
 * through `useSyncExternalStore`, NOT a Context — a Context can't be read from a
 * non-React module.
 */

export type SoundCue = 'levelWarning' | 'levelChange' | 'tournamentStart' | 'elimination'

/** All cue names, in a stable order — handy for iterating in tests / a picker. */
export const SOUND_CUES: readonly SoundCue[] = [
  'levelWarning',
  'levelChange',
  'tournamentStart',
  'elimination',
] as const

export type SoundSettings = { muted: boolean; volume: number }

const STORAGE_KEY = 'pf-sound'
const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.7 }

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function loadSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SoundSettings>
      return {
        muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
        volume:
          typeof parsed.volume === 'number'
            ? clampVolume(parsed.volume)
            : DEFAULT_SETTINGS.volume,
      }
    }
  } catch {
    /* localStorage / JSON may be unavailable */
  }
  return { ...DEFAULT_SETTINGS }
}

// Reassigned (never mutated) on change so the reference stays stable between
// updates — required for a correct `useSyncExternalStore` snapshot.
let settings: SoundSettings = loadSettings()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* localStorage may be unavailable */
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function getSoundSettings(): SoundSettings {
  return settings
}

export function setMuted(muted: boolean): void {
  if (settings.muted === muted) return
  settings = { ...settings, muted }
  persist()
  emit()
}

export function setVolume(volume: number): void {
  const next = clampVolume(volume)
  if (settings.volume === next) return
  settings = { ...settings, volume: next }
  persist()
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

type AudioContextConstructor = new () => AudioContext

/**
 * Resolve a usable AudioContext constructor, or null when the platform has none
 * (jsdom under Vitest, very old browsers). Returning null keeps every cue a safe
 * no-op instead of throwing.
 */
function getAudioContextCtor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as Window &
    typeof globalThis & {
      AudioContext?: AudioContextConstructor
      webkitAudioContext?: AudioContextConstructor
    }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

let audioCtx: AudioContext | null = null

/**
 * Lazily create the AudioContext. Deliberately NOT constructed at module load:
 * browsers require the first context to be created/resumed inside a user gesture
 * (autoplay policy), so we defer until the first `resumeAudio` / `playCue`.
 */
function ensureContext(): AudioContext | null {
  if (audioCtx) return audioCtx
  const Ctor = getAudioContextCtor()
  if (!Ctor) return null
  try {
    audioCtx = new Ctor()
  } catch {
    audioCtx = null
  }
  return audioCtx
}

/**
 * Unlock/resume the audio context — call from the first user gesture (a tap on
 * the settings control, later a "start tournament" tap) so subsequent cues play.
 * Safe no-op when no AudioContext exists.
 */
export function resumeAudio(): void {
  const ctx = ensureContext()
  if (ctx && ctx.state === 'suspended') void ctx.resume()
}

type Tone = {
  freq: number
  /** seconds after the cue's start */
  start: number
  duration: number
  type?: OscillatorType
  /** 0..1 peak gain before the user-volume multiplier */
  peak?: number
}

/**
 * Distinct short envelopes per cue so they're recognisable without labels:
 * - levelWarning  — two clipped square beeps (urgent "time's almost up")
 * - levelChange   — rising C–E–G sine arpeggio (a pleasant chime)
 * - tournamentStart — bright triangle fanfare climbing to a high C
 * - elimination   — a falling sawtooth two-note "out" sting
 */
const CUE_TONES: Record<SoundCue, readonly Tone[]> = {
  levelWarning: [
    { freq: 880, start: 0, duration: 0.12, type: 'square', peak: 0.5 },
    { freq: 880, start: 0.18, duration: 0.12, type: 'square', peak: 0.5 },
  ],
  levelChange: [
    { freq: 523.25, start: 0, duration: 0.16, type: 'sine' },
    { freq: 659.25, start: 0.14, duration: 0.16, type: 'sine' },
    { freq: 783.99, start: 0.28, duration: 0.3, type: 'sine' },
  ],
  tournamentStart: [
    { freq: 392.0, start: 0, duration: 0.14, type: 'triangle' },
    { freq: 523.25, start: 0.13, duration: 0.14, type: 'triangle' },
    { freq: 659.25, start: 0.26, duration: 0.14, type: 'triangle' },
    { freq: 1046.5, start: 0.39, duration: 0.34, type: 'triangle' },
  ],
  elimination: [
    { freq: 440, start: 0, duration: 0.18, type: 'sawtooth', peak: 0.45 },
    { freq: 220, start: 0.16, duration: 0.34, type: 'sawtooth', peak: 0.45 },
  ],
}

/**
 * Schedule a bundle of tones on the shared context. NO-OP when muted or volume
 * is 0 (checked BEFORE any audio node is created), and when no AudioContext is
 * available. Individual tone failures are swallowed so a cue never throws into
 * an event handler. Shared by the one-shot cues (`playCue`) and the looping
 * level-end alarm.
 */
function playTones(tones: readonly Tone[]): void {
  const { muted, volume } = settings
  if (muted || volume <= 0) return

  const ctx = ensureContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()

  const now = ctx.currentTime
  for (const tone of tones) {
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = tone.type ?? 'sine'
      osc.frequency.value = tone.freq

      const peak = Math.max(0.0002, (tone.peak ?? 0.6) * volume)
      const startAt = now + tone.start
      const endAt = startAt + tone.duration
      // Fast attack, exponential decay. Exponential ramps can't hit 0, so we
      // floor at a near-silent value and never start from a true zero.
      gain.gain.setValueAtTime(0.0001, startAt)
      gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(startAt)
      osc.stop(endAt + 0.02)
    } catch {
      /* skip a tone that fails to schedule; never throw from a cue */
    }
  }
}

/**
 * Play a named cue. NO-OP when muted or volume is 0 (checked BEFORE any audio
 * node is created), and when no AudioContext is available.
 */
export function playCue(cue: SoundCue): void {
  const tones = CUE_TONES[cue]
  if (!tones) return
  playTones(tones)
}

// ---------------------------------------------------------------------------
// Level-end alarm (persistent, looping)
// ---------------------------------------------------------------------------

/**
 * The level-END alert. Unlike the one-shot cues this LOOPS until the admin
 * acknowledges (starts the next level / pauses). A distinct urgent two-note
 * klaxon (high→low square blasts) so it's unmistakable versus `levelWarning`.
 */
const ALARM_TONES: readonly Tone[] = [
  { freq: 988, start: 0, duration: 0.24, type: 'square', peak: 0.55 },
  { freq: 740, start: 0.3, duration: 0.3, type: 'square', peak: 0.55 },
]

/** How often the alarm re-sounds while it's active. */
const ALARM_INTERVAL_MS = 1200

let alarmTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the persistent level-end alarm: sound the klaxon immediately, then
 * repeat every ~1.2s until `stopLevelAlarm`. Idempotent — a second call while
 * already sounding is a no-op. Each pulse goes through `playTones`, which is a
 * live no-op while muted / volume 0 / no AudioContext, so a muted alarm creates
 * no audio nodes (and un-muting mid-alarm starts sounding on the next pulse).
 * Safe to call outside a user gesture (it resumes a suspended context).
 */
export function startLevelAlarm(): void {
  if (alarmTimer !== null) return
  playTones(ALARM_TONES)
  alarmTimer = setInterval(() => playTones(ALARM_TONES), ALARM_INTERVAL_MS)
}

/** Stop the persistent alarm. Safe to call when it isn't running. */
export function stopLevelAlarm(): void {
  if (alarmTimer !== null) {
    clearInterval(alarmTimer)
    alarmTimer = null
  }
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export type UseSoundValue = SoundSettings & {
  setMuted: (muted: boolean) => void
  setVolume: (volume: number) => void
  playCue: (cue: SoundCue) => void
  resumeAudio: () => void
}

/** React binding for the sound store — mirrors `useTheme` (theme.tsx). */
export function useSound(): UseSoundValue {
  const snapshot = useSyncExternalStore(subscribe, getSoundSettings, getSoundSettings)
  return {
    muted: snapshot.muted,
    volume: snapshot.volume,
    setMuted,
    setVolume,
    playCue,
    resumeAudio,
  }
}
