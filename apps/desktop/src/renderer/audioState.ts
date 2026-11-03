// The Audio page's own state (tools, selection, loop, zoom, views) and its link to the
// engine's audio work: loudness, waveform levels and spectrograms arrive as events and
// are kept here. The project itself always comes from the engine's snapshot.

import { useSyncExternalStore } from 'react'
import { fileUrl, getState, mediaById, type Clip, type Media, type Project, type Snapshot, type Track, type Us } from './store'

// The engine's project, with the Audio page's fields (store.ts lists only what the editor uses).

export interface Effects {
  noise: { on: boolean; reductionDb: number; sensitivity: number }
  eq: { on: boolean; highpassHz: number; presenceDb: number }
  comp: { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number }
  deess: { on: boolean; amountDb: number }
  limiter: { on: boolean; ceilingDb: number }
}
export type EffectKey = keyof Effects

export const DEFAULT_EFFECTS: Effects = {
  noise: { on: false, reductionDb: 12, sensitivity: 6 },
  eq: { on: false, highpassHz: 80, presenceDb: 3 },
  comp: { on: false, thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120 },
  deess: { on: false, amountDb: 4 },
  limiter: { on: false, ceilingDb: -1 },
}

export interface Master {
  normalize: boolean
  targetLufs: number
  limiter: boolean
  ceilingDb: number
  gainDb: number
}

export interface EnvPoint {
  atUs: Us
  gain: number
}

export type MixTrack = Track & { gainDb?: number; pan?: number; effects?: Effects }
export type SoundClip = Clip & { fadeInUs?: Us; fadeOutUs?: Us; fadeCurve?: string; pitch?: number; declick?: boolean; envelope?: EnvPoint[] }
export type MixProject = Project & { master?: Master }

export const masterOf = (p?: Project | null): Master => ({ normalize: true, targetLufs: -14, limiter: true, ceilingDb: -1, gainDb: 0, ...((p as MixProject | undefined)?.master ?? {}) })
export const effectsOf = (t?: Track | null): Effects => {
  const e = (t as MixTrack | undefined)?.effects
  return {
    noise: { ...DEFAULT_EFFECTS.noise, ...e?.noise },
    eq: { ...DEFAULT_EFFECTS.eq, ...e?.eq },
    comp: { ...DEFAULT_EFFECTS.comp, ...e?.comp },
    deess: { ...DEFAULT_EFFECTS.deess, ...e?.deess },
    limiter: { ...DEFAULT_EFFECTS.limiter, ...e?.limiter },
  }
}
export const effectsOn = (t?: Track | null) => Object.values(effectsOf(t)).filter((x) => x.on).length

// Page state

export type View = 'wave' | 'spec' | 'both'

export interface Loudness {
  integrated: number | null
  lra: number | null
  truePeak: number | null
  short: number[]
  stepUs: Us
  durationUs: Us
}

export interface AudioUi {
  /** Select makes time selections; Draw samples redraws the wave with a pencil (zoomed in to
   *  0.25 s or less across); Spectral delete takes a box out of a spectrogram. */
  tool: 'select' | 'draw' | 'spectral'
  /** Volume envelope lines shown and editable (the E tool); off, a drag always selects. */
  envelope: boolean
  /** Track height, as on the Edit timeline (Shift + wheel): 0.5 to 1.8. */
  scale: number
  /** Audacity's edit cursor: where you last clicked. Play starts there; Stop comes back to it. */
  cursor: Us | null
  /** The time under the mouse, for the line that follows it (null off the tracks). */
  hover: Us | null
  loopOn: boolean
  loop: { a: Us; b: Us } | null
  /** The time selection, on the selected track. */
  sel: { a: Us; b: Us } | null
  trackId: string | null
  views: Record<string, View>
  rms: boolean
  /** The visible stretch of time; `null` fits the whole project. */
  zoom: { start: Us; span: Us } | null
  loudness: Loudness | null
  loudnessBusy: boolean
  loudnessError: string | null
  normalising: boolean
  recording: boolean
  /** Bumps when a levels file or spectrogram arrives, so clips redraw. */
  files: number
  /** The label being renamed. */
  editingLabel: string | null
  /** Values being dragged, by key, until the engine has them. */
  drafts: Record<string, number>
  /** Remove silences: the panel's settings and, while it's open, the pauses it would take out. */
  silence: Silence
}

export interface SilenceRange {
  startUs: Us
  endUs: Us
  /** The track it's on, when known (else found from the clip under it). */
  trackId?: string
  clipId?: string
}

export interface Silence {
  open: boolean
  /** Quieter than this counts as silence (dB). */
  thresholdDb: number
  /** The shortest pause taken out. */
  minUs: Us
  /** Air left on each side of a pause. */
  keepUs: Us
  /** The pauses a run with these settings would take out (dry run), on the timeline. */
  ranges: SilenceRange[] | null
  removedUs: number
  /** Length of what's looked at, for "31.2 s → 26.9 s". */
  scopeUs: number
  busy: boolean
  error: string | null
}

export const DEFAULT_SILENCE: Silence = { open: false, thresholdDb: -40, minUs: 500_000, keepUs: 200_000, ranges: null, removedUs: 0, scopeUs: 0, busy: false, error: null }

const VIEWS_KEY = 'studio.audio.views.v1'
const loadViews = (): Record<string, View> => {
  try {
    return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

let ui: AudioUi = {
  tool: 'select',
  envelope: false,
  scale: 1,
  cursor: null,
  hover: null,
  // Off until you make a loop region (a drag along the ruler's top strip) or turn it on.
  loopOn: false,
  loop: null,
  sel: null,
  trackId: null,
  views: loadViews(),
  rms: true,
  zoom: null,
  loudness: null,
  loudnessBusy: false,
  loudnessError: null,
  normalising: false,
  recording: false,
  files: 0,
  editingLabel: null,
  drafts: {},
  silence: DEFAULT_SILENCE,
}
const listeners = new Set<() => void>()
export const getUi = () => ui
export function setUi(patch: Partial<AudioUi>) {
  ui = { ...ui, ...patch }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function useAudio<T>(select: (s: AudioUi) => T): T {
  return useSyncExternalStore(subscribe, () => select(ui))
}

export function setView(trackId: string, view: View) {
  const views = { ...ui.views, [trackId]: view }
  setUi({ views })
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views))
  } catch {}
}

export function setDraft(key: string, v: number | null) {
  const drafts = { ...ui.drafts }
  if (v == null) delete drafts[key]
  else drafts[key] = v
  setUi({ drafts })
}

// Tracks as the page shows them

export type Role = 'voice' | 'music' | 'clip' | 'labels'

export const ROLE_COLOR: Record<Role, string> = { voice: '#66A3FF', music: '#34B494', clip: '#6E6E77', labels: '#E8C050' }

const stem = (name: string) => name.replace(/\.[^.]+$/, '')

/** A voice or music track: as set on the track, else guessed from where its sound came from. */
export function roleOf(t: Track, snap: Snapshot | null): Role {
  if (t.main) return 'clip'
  if (t.role === 'voice' || t.role === 'music') return t.role
  const voice = t.clips.some((c) => {
    const m = mediaById(snap, c.mediaId)
    return !!m && (/[\\/](recordings|voiceovers)[\\/]/i.test(m.path) || /voice|\bvo\b|speak|narrat|röst|\btal\b/i.test(m.name) || m.kind === 'video')
  })
  return voice ? 'voice' : 'music'
}

export function trackName(t: Track, snap: Snapshot | null): string {
  if (t.main) return t.mute ? 'Clip audio (muted)' : 'Clip audio'
  const m = t.clips[0] && mediaById(snap, t.clips[0].mediaId)
  return m ? stem(m.name) : 'Audio'
}

export interface Row {
  key: string
  kind: 'audio' | 'main' | 'labels'
  track?: MixTrack
  role: Role
  name: string
  h: number
  /** Pan, fader and the Effects button (a muted clip track shows just its name). */
  full: boolean
}

export function rowsOf(snap: Snapshot | null): Row[] {
  const p = snap?.project
  if (!p) return []
  const audio = p.tracks.filter((t) => !t.main)
  const voice = audio.filter((t) => roleOf(t, snap) === 'voice')
  const music = audio.filter((t) => roleOf(t, snap) === 'music')
  const rows: Row[] = [...voice, ...music].map((t) => {
    const role = roleOf(t, snap)
    return { key: t.id, kind: 'audio', track: t, role, name: trackName(t, snap), h: Math.round((role === 'voice' ? 214 : 130) * ui.scale), full: true }
  })
  const main = p.tracks.find((t) => t.main)
  if (main) {
    const sound = main.clips.some((c) => mediaById(snap, c.mediaId)?.hasAudio && !c.detached)
    const full = !main.mute && sound
    rows.push({ key: main.id, kind: 'main', track: main, role: 'clip', name: trackName(main, snap), h: full ? 130 : 64, full })
  }
  rows.push({ key: 'labels', kind: 'labels', role: 'labels', name: 'Script labels', h: 40, full: false })
  return rows
}

/** The track the Effects panel, the time selection and the view switch work on. */
export function selectedRow(rows: Row[], id: string | null): Row | undefined {
  return rows.find((r) => r.key === id && r.track) ?? rows.find((r) => r.track && r.role === 'voice') ?? rows.find((r) => r.track)
}

export function viewOf(row: Row | undefined): View {
  if (!row) return 'wave'
  return ui.views[row.key] ?? (row.role === 'voice' ? 'both' : 'wave')
}

// Time

export const S = 1_000_000

/** The stretch of time the page shows when it fits the project. */
export const fitSpan = (durationUs: Us) => Math.max(5 * S, Math.round(durationUs * 1.025))

export function viewWindow(durationUs: Us): { start: Us; span: Us } {
  return ui.zoom ?? { start: 0, span: fitSpan(durationUs) }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 00:07.00 */
export function clock(us: Us): string {
  const cs = Math.round(Math.max(0, us) / 10_000)
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`
}
/** −14.2, with a real minus sign. */
export const signed = (v: number, digits = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits)

// Engine results

export interface Levels {
  rate: number
  peak: Uint8Array
  rms: Uint8Array
}

const levels = new Map<string, Levels | 'pending' | 'failed'>()
const spectrograms = new Map<string, string | 'pending' | 'failed'>()

async function loadLevels(mediaId: string, path: string) {
  try {
    const j: { rate: number; peak: number[]; rms: number[] } = await fetch(fileUrl(path)).then((r) => r.json())
    levels.set(mediaId, { rate: j.rate, peak: Uint8Array.from(j.peak), rms: Uint8Array.from(j.rms) })
  } catch {
    levels.set(mediaId, 'failed')
  }
  setUi({ files: ui.files + 1 })
}

/** A file's peak and RMS levels, asked for once; `undefined` until they arrive. */
export function levelsFor(media: Media | undefined): Levels | undefined {
  if (!media?.hasAudio) return undefined
  const have = levels.get(media.id)
  if (have === undefined) {
    levels.set(media.id, 'pending')
    window.studio.engine
      .call('audio.levels', { mediaId: media.id })
      .then((r) => r.path && loadLevels(media.id, r.path))
      .catch(() => levels.set(media.id, 'failed'))
  }
  return typeof have === 'object' ? have : undefined
}

/** A file's spectrogram image, asked for once. */
export function spectrogramFor(media: Media | undefined): string | undefined {
  if (!media?.hasAudio) return undefined
  const have = spectrograms.get(media.id)
  if (have === undefined) {
    spectrograms.set(media.id, 'pending')
    window.studio.engine
      .call('audio.spectrogram', { mediaId: media.id })
      .then((r) => {
        if (r.path) {
          spectrograms.set(media.id, r.path)
          setUi({ files: ui.files + 1 })
        }
      })
      .catch(() => spectrograms.set(media.id, 'failed'))
  }
  return have && have !== 'pending' && have !== 'failed' ? fileUrl(have) : undefined
}

let measureTimer = 0
/** Asks for the mix's loudness (soon after edits settle); the engine answers from cache when nothing changed. */
export function measureSoon(delay = 700) {
  clearTimeout(measureTimer)
  measureTimer = window.setTimeout(async () => {
    if (!getState().snap?.durationUs) return setUi({ loudness: null, loudnessBusy: false, loudnessError: null })
    try {
      const r = await window.studio.engine.call('audio.loudness')
      if (r?.pending) setUi({ loudnessBusy: true })
      else setUi({ loudness: r, loudnessBusy: false, loudnessError: null })
    } catch (e) {
      setUi({ loudnessBusy: false, loudnessError: (e as Error).message })
    }
  }, delay)
}

let wired = false
/** Listens for the engine's audio results (once, for the life of the window). */
export function wireAudioEvents() {
  if (wired) return
  wired = true
  window.studio.engine.onEvent((method, params) => {
    if (method === 'audio.loudness') setUi({ loudness: params, loudnessBusy: false, loudnessError: null })
    else if (method === 'audio.levels') loadLevels(params.mediaId, params.path)
    else if (method === 'audio.spectrogram') {
      spectrograms.set(params.mediaId, params.path)
      setUi({ files: ui.files + 1 })
    } else if (method === 'audio.failed') {
      if (params.what === 'loudness') setUi({ loudnessBusy: false, loudnessError: params.error })
      else if (params.what === 'levels') levels.set(params.mediaId, 'failed')
      else if (params.what === 'spectrogram') spectrograms.set(params.mediaId, 'failed')
    }
  })
}

/** The project's loop region in the engine: set while Loop is on and there is a region. */
export function syncLoop() {
  const r = ui.loopOn && ui.loop && ui.loop.b - ui.loop.a >= 200_000 ? { startUs: Math.round(ui.loop.a), endUs: Math.round(ui.loop.b) } : {}
  window.studio.engine.call('playback.setLoop', r).catch(() => {})
}

/** The gain of a clip's envelope at a source time (1 without points). */
export function envelopeAt(env: EnvPoint[] | undefined, at: Us): number {
  if (!env?.length) return 1
  if (at <= env[0].atUs) return env[0].gain
  for (let i = 1; i < env.length; i++) {
    const a = env[i - 1]
    const b = env[i]
    if (at < b.atUs) return a.gain + ((b.gain - a.gain) * (at - a.atUs)) / Math.max(1, b.atUs - a.atUs)
  }
  return env[env.length - 1].gain
}

/** The levels a track sends at a timeline time, left and right (0–1), before its effects. */
export function trackLevel(t: MixTrack, p: Project, at: Us, audible: boolean): [number, number] {
  if (!audible) return [0, 0]
  let amp = 0
  for (const c of t.clips as SoundClip[]) {
    if (at < c.startUs || at >= c.startUs + c.durationUs || c.detached) continue
    const m = p.media.find((x) => x.id === c.mediaId)
    const lv = levels.get(c.mediaId)
    if (!m || typeof lv !== 'object') continue
    const src = c.inUs + (at - c.startUs)
    // The loudest 10 ms block of the last 60 ms, like a meter's fall-back.
    const i = Math.floor((src / S) * lv.rate)
    let peak = 0
    for (let k = Math.max(0, i - 5); k <= i && k < lv.peak.length; k++) peak = Math.max(peak, lv.peak[k])
    amp = Math.max(amp, (peak / 255) * c.volume * envelopeAt(c.envelope, src))
  }
  amp *= 10 ** ((t.gainDb ?? 0) / 20)
  const pan = t.pan ?? 0
  return [amp * (pan > 0 ? 1 - pan : 1), amp * (pan < 0 ? 1 + pan : 1)]
}

/** A level (0–1) as a meter height: −60 dBFS at the bottom, 0 at the top. */
export const meterPct = (amp: number) => (amp <= 0.001 ? 0 : Math.max(0, Math.min(100, ((20 * Math.log10(amp) + 60) / 60) * 100)))
