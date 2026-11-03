// The renderer's view of the engine. The engine owns the project; this keeps the latest
// snapshot it pushed, plus UI-only state (selection, dialogs, toasts). Components read it
// through `useStore(selector)` and only re-render when their slice changes.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AppPaths, ElevenAccount, ElevenModel, LinkState, StemsJob, VmakeJob, Voice } from '../shared/api'
import type { DubJob } from '../shared/dub'
import { running as stemsRunning, stemRole } from '../shared/stems'
import { basename } from './format'
import { timeLeft, waitFraction } from '../shared/vmake-estimate'
import { getUi } from './ui-state'

export type Us = number

export interface Media {
  id: string
  path: string
  name: string
  kind: 'video' | 'audio' | 'image'
  durationUs: Us
  width: number
  height: number
  fps: number
  hasAudio: boolean
  proxy?: string | null
  poster?: string | null
  strip?: string | null
  peaks?: string | null
  /** The linked folder it came from, and its subfolder there ("" is the top, "/" separated). */
  folder?: string | null
  dir?: string | null
  /** The last rescan didn't find the file. */
  missing?: boolean
  /** A compound clip's parts (so it can be broken apart). */
  parts?: { clip: Clip; main: boolean }[] | null
}

export interface Folder {
  id: string
  path: string
  name: string
}

export interface Clip {
  id: string
  mediaId: string
  startUs: Us
  inUs: Us
  durationUs: Us
  volume: number
  fit: 'fill' | 'fit'
  /** Linked to its extracted audio (or the video it came from). */
  link?: string | null
  /** Its sound was extracted to an audio track. */
  detached?: boolean
  crop?: Crop | null
  flip?: boolean
  rotate?: number
  /** Plays backwards. */
  reverse?: boolean
  /** Source seconds per timeline second (the clip reads durationUs · speed of its source). */
  speed?: number
  // Look fields (docs/contract-v2.md); all optional, the engine sends its defaults.
  scale?: number
  posX?: number
  posY?: number
  rotation?: number
  opacity?: number
  temperature?: number
  tint?: number
  saturation?: number
  brightness?: number
  contrast?: number
  highlights?: number
  shadows?: number
  sharpen?: number
  vignette?: number
  keyframes?: Record<string, { atUs: Us; value: number }[]>
  flipV?: boolean
  transformOn?: boolean
  blend?: string
  effects?: { name: string; amount: number }[]
  /** On a main-track clip: the transition into it from the clip before. */
  transition?: { name: string; durationUs: Us } | null
  hsl?: Record<string, { h: number; s: number; l: number }>
  curves?: Partial<Record<'master' | 'red' | 'green' | 'blue', [number, number][]>>
  wheels?: Partial<Record<'lift' | 'gamma' | 'gain', { x: number; y: number; lum: number }>>
  lut?: { path: string; strength: number } | null
  stabilize?: { strength: number } | null
  smooth?: { quality: 'Fast' | 'Best' } | null
  keepPitch?: boolean
  speedCurve?: { name: string; points: [number, number][] } | null
  mask?: { shape: string; x: number; y: number; w: number; h: number; rotation: number; feather: number; invert: boolean } | null
  maskPng?: string | null
  matte?: { path: string } | null
  anim?: { in?: { name: string; durationUs: Us }; out?: { name: string; durationUs: Us }; loop?: { name: string; periodUs: Us } }
  text?: TextSpec | null
  caption?: boolean
  spectral?: { startUs: Us; endUs: Us; lowHz: number; highHz: number }[]
  envelope?: { atUs: Us; gain: number }[]
  fadeInUs?: Us
  fadeOutUs?: Us
  /** The fades' shape (FFmpeg afade curve: lin, qsin, hsin, esin, log, exp…). */
  fadeCurve?: string
  /** Semitones, keeping the speed. */
  pitch?: number
  /** Text is being removed from it (the Vmake job's id): nothing can change it until that's done. */
  busy?: string | null
}

/** A crop rectangle in fractions of the source frame. */
export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

export interface Track {
  id: string
  kind: 'video' | 'audio'
  main: boolean
  clips: Clip[]
  mute?: boolean
  solo?: boolean
  /** Locked tracks can't be edited on the timeline. */
  locked?: boolean
  /** A hidden picture track is left out of preview and export. */
  hidden?: boolean
  /** Audio: "voice" or "music" ("" or missing: guessed). Overlay video tracks: "text",
   *  "captions", "sticker", "overlay" or "adjust" (docs/contract-v2.md). */
  role?: string
}

export interface Project {
  name: string
  width: number
  height: number
  fps: number
  media: Media[]
  folders?: Folder[]
  tracks: Track[]
  /** Main track magnet: the main track closes gaps by itself. */
  magnet?: boolean
  /** Linked clips move, split and delete together. */
  linkage?: boolean
  /** The frame used as the video's cover (thumbnail), in timeline time. */
  coverUs?: Us
  /** Markers (M) and the Audio page's labels: a point when start and end are equal. */
  labels?: Label[]
  brand?: { colors: string[]; fonts: string[] }
  mcp?: { allowed: 'all' | 'edit' | 'look'; askBeforeExport: boolean }
}

/** A text clip's look; the renderer draws it to `png` (docs/contract-v2.md). */
export interface TextSpec {
  content: string
  font: string
  size: number
  weight: number
  color: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
  case: 'none' | 'upper' | 'lower'
  italic?: boolean
  underline?: boolean
  stroke: { color: string; width: number } | null
  /** A box behind each line, or with `block` one box behind them all; `padY` is the box's room above and below (else 0.55 × padding). */
  background: { color: string; opacity: number; radius: number; padding: number; padY?: number; block?: boolean } | null
  shadow: { color: string; blur: number; x: number; y: number } | null
  preset?: string
  png?: string
  boxW?: number
  boxH?: number
  /** A caption line's words, each with its time from the line's start (see captions.ts). */
  words?: { w: string; s: Us; e: Us }[]
}

export interface Label {
  id: string
  startUs: Us
  endUs: Us
  text: string
}

export interface Snapshot {
  revision: number
  dir: string
  canUndo: boolean
  canRedo: boolean
  durationUs: Us
  processing: string[]
  project: Project
}

export interface Capabilities {
  ffmpeg: string | null
  nvenc?: boolean
  encoders?: string[]
  audioDevice?: string | null
  projectsDir: string
  error?: string
}

export interface ExportJob {
  jobId: string
  width: number
  height: number
  path: string
  encoder: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  fraction: number
  seconds?: number
  bytes?: number
  error?: string
  /** When it started, and its first progress (what the time left is worked out from). */
  startedAt?: number
  rateFrom?: { at: number; fraction: number }
}

/**
 * Seconds left on an export, from how fast it has gone since its first progress (null until
 * there's enough to tell: the sound is measured before the picture starts).
 */
export function exportTimeLeft(j: ExportJob, now = Date.now()): number | null {
  if (j.state !== 'running' || !j.rateFrom) return null
  const done = j.fraction - j.rateFrom.fraction
  const took = (now - j.rateFrom.at) / 1000
  if (done < 0.02 || took < 0.5) return null
  return Math.max(0, ((1 - j.fraction) * took) / done)
}

export interface Toast {
  id: number
  tone: 'info' | 'error'
  text: string
}

export type Dialog = null | 'export' | 'new' | 'shortcuts' | 'about' | 'crop' | 'vmake' | 'voices' | 'clone' | 'saveAs' | 'versions' | 'saveLayout' | 'workspaces' | 'start' | 'whatsNew' | 'report' | 'prefs' | 'mcp'

/** Where the library is looking: everything, loose imports, or a linked folder's id. */
export type LibraryScope = 'all' | 'loose' | string

/** A copied clip and where it sat relative to the first one copied. */
export interface PasteItem {
  clip: Clip
  main: boolean
  offsetUs: Us
  /** The track's role for clips over the video (text, sticker, overlay…), so they land on that kind of track. */
  role?: string
}

/** What Ctrl+C / Ctrl+X last took: timeline clips, or library media (cut ones are out of the library until pasted). */
export type Clipboard = { kind: 'clips'; items: PasteItem[] } | { kind: 'media'; media: Media[]; cut: boolean } | null

/** A clip's look and sound, for copy and paste attributes. */
/** A clip's look and sound settings, as Copy attributes keeps them (clip.set params). */
export type Attributes = Record<string, unknown>

/** Every attribute and its neutral value, so pasting also clears what the source doesn't have. */
const ATTRIBUTE_DEFAULTS: Attributes = {
  volume: 1, fit: 'fill', crop: null, flip: false, rotate: 0,
  scale: 100, posX: 0, posY: 0, rotation: 0, opacity: 100,
  temperature: 0, tint: 0, saturation: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, sharpen: 0, vignette: 0,
  speed: 1, reverse: false, fadeInUs: 0, fadeOutUs: 0, fadeCurve: 'lin', pitch: 0, declick: false, keyframes: {},
}

export type MenuEntry = { label: string; keys?: string; run: () => unknown; disabled?: boolean } | 'sep'

export interface State {
  link: LinkState
  snap: Snapshot | null
  playing: boolean
  positionUs: Us
  selection: string[]
  exports: ExportJob[]
  /** The exports the Export window is showing (started from it), until it's closed after they finish. */
  exportBatch: string[] | null
  toasts: Toast[]
  caps: Capabilities | null
  paths: AppPaths | null
  dialog: Dialog
  /** The library's place in the folder map: a scope, and a subfolder inside a linked folder. */
  libraryScope: LibraryScope
  libraryDir: string
  /** The clip the crop dialog is working on. */
  cropClip: string | null
  /** Where Ctrl+C, Ctrl+X, Ctrl+V and Delete act: the panel clicked last. */
  focus: 'timeline' | 'library'
  /** Library items picked (separate from the timeline's selection). */
  libraryPicked: string[]
  clipboard: Clipboard
  attributes: Attributes | null
  /** An open right-click menu. */
  menu: { x: number; y: number; items: MenuEntry[] } | null
  /** Set when the export dialog is exporting only these clips. */
  exportClips: string[] | null
  /** A library clip shown on its own in the player, and its own playhead. */
  source: { mediaId: string; positionUs: Us; playing: boolean } | null
  /** Imports and folder links still running (their names). */
  importing: string[]
  /** Files in the current batch of thumbnails and waveforms (for the progress bar). */
  loadTotal: number
  /** Work running on outside services (text removal, voices), shown in the title bar. */
  tasks: Task[]
  /** What the text-removal dialog is for: a clip on the timeline, or a library item. */
  vmakeTarget: { mediaId: string; clipId?: string } | null
  /** The open project's text removals, by job id (a busy clip's `busy`). */
  vmakeJobs: Record<string, VmakeJob>
  /** The open project's stem separations (the stems server), by their folder. */
  stemsJobs: Record<string, StemsJob>
  /** The open project's dubs by id (a busy clip's `busy`). */
  dubJobs: Record<string, DubJob>
  /** ElevenLabs: whether a key is saved, the account, its voices and models, the chosen voice. */
  eleven: { hasKey: boolean | null; account?: ElevenAccount; models?: ElevenModel[]; voices?: Voice[]; error?: string }
  voice: Voice | null
  /** Which page the window shows: the editor, or the Audio page (Audacity-style). */
  page: 'edit' | 'audio' | 'home'
  /** The editor's arrangement (View › Workspace; Alt+1–3). */
  layout: Layout
  /** TikTok/Reels UI overlay on the player. */
  safeZones: boolean
  /** The player fills the window (F). */
  fullPlayer: boolean
  /** The timeline's pointer: select and drag, or the split (blade) tool. */
  tool: 'select' | 'blade'
  /** The shortcuts list is waiting for new keys. */
  recordingKeys: boolean
  /** View › Lock panel layout: the gaps between panels can't be dragged. */
  layoutLocked: boolean
  /** Panels hidden from the editor (View › Panels): 'lib', 'insp', 'player', 'tl'. */
  hiddenPanels: string[]
  /** Bumped when a saved workspace is applied or the list changes. */
  workspaceTick: number
  /** An agent's request waiting for your answer, and the ones after it. */
  approval: { id: string; what: string; detail: string } | null
  approvalQueue: { id: string; what: string; detail: string }[]
  /** View › Show waveforms / Show thumbnails. */
  showWaveforms: boolean
  showThumbnails: boolean
}

export type Layout = 'ads' | 'standard' | 'review'

export interface Task {
  id: string
  label: string
  stage: string
  fraction: number
  state: 'running' | 'done' | 'failed'
  error?: string
  /** Which job it is (voiceover, captions…) and what for (a clip, a language), so the same job
   *  can't start twice and its button can show it working. */
  kind?: string
  key?: string
  startedAt?: number
  /** No real progress is known (waiting on a service): show time, not a percentage. */
  waiting?: boolean
}

let state: State = {
  link: 'connecting',
  snap: null,
  playing: false,
  positionUs: 0,
  selection: [],
  exports: [],
  exportBatch: null,
  toasts: [],
  caps: null,
  paths: null,
  dialog: null,
  libraryScope: 'all',
  libraryDir: '',
  cropClip: null,
  focus: 'timeline',
  libraryPicked: [],
  clipboard: null,
  attributes: null,
  menu: null,
  exportClips: null,
  source: null,
  importing: [],
  loadTotal: 0,
  tasks: [],
  vmakeTarget: null,
  vmakeJobs: {},
  dubJobs: {},
  stemsJobs: {},
  eleven: { hasKey: null },
  voice: null,
  page: 'edit',
  layout: savedLayout(),
  safeZones: savedLayout() === 'ads',
  fullPlayer: false,
  tool: 'select',
  recordingKeys: false,
  hiddenPanels: (() => {
    try {
      return JSON.parse(localStorage.getItem('studio.hiddenPanels') ?? '[]')
    } catch {
      return []
    }
  })(),
  workspaceTick: 0,
  approval: null,
  approvalQueue: [],
  layoutLocked: (() => {
    try {
      return localStorage.getItem('studio.layoutLocked') === 'on'
    } catch {
      return false
    }
  })(),
  showWaveforms: true,
  showThumbnails: true,
}

/** Ctrl+D: a copy of the selection right after it (on the main track, the clip after it). */
export async function duplicate() {
  if (!copy()) return
  const cb = state.clipboard
  if (cb?.kind !== 'clips') return
  const ends = cb.items.map((i) => i.clip.startUs + i.clip.durationUs)
  const r = await call<{ clipIds: string[] }>('clips.paste', { items: cb.items, atUs: Math.max(...ends) })
  if (r) setState({ selection: r.clipIds })
}

/** Y: every clip that starts at or after the playhead. */
export function selectAfterPlayhead() {
  const t = state.positionUs
  setState({ selection: state.snap?.project.tracks.flatMap((tr) => tr.clips.filter((c) => c.startUs >= t).map((c) => c.id)) ?? [] })
}

/** Projects opened recently (File › Open recent), newest first. */
export function recentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem('studio.recent.v1') ?? '[]')
  } catch {
    return []
  }
}
export function rememberProject(dir: string) {
  try {
    localStorage.setItem('studio.recent.v1', JSON.stringify([dir, ...recentProjects().filter((d) => d !== dir)].slice(0, 8)))
  } catch {}
}
/** Takes a project off the recent list (after it's deleted). */
export function forgetProject(dir: string) {
  try {
    localStorage.setItem('studio.recent.v1', JSON.stringify(recentProjects().filter((d) => d !== dir)))
  } catch {}
}
export function clearRecent() {
  try {
    localStorage.removeItem('studio.recent.v1')
  } catch {}
}
/** Stops whatever is playing (the timeline or a library preview) before the project changes. */
async function hush() {
  if (state.playing || state.source?.playing) await call('playback.pause')
}

/** File › Close project: back to Home, with nothing left playing behind it. */
export async function closeProject() {
  await hush()
  setState({ page: 'home', selection: [], playing: false, source: null })
}

export async function openProjectAt(dir: string) {
  await hush()
  const snap = await call<Snapshot>('project.open', { path: dir })
  if (!snap) return
  setState({ snap, selection: [], positionUs: 0, playing: false, libraryScope: 'all', libraryDir: '', page: state.page === 'home' ? 'edit' : state.page })
  syncFolders(true)
}

function savedLayout(): Layout {
  try {
    const l = localStorage.getItem('studio.layout.v3')
    return l === 'standard' || l === 'review' ? l : 'ads'
  } catch {
    return 'ads'
  }
}

/** Switches the editor's arrangement; the Ads layout shows the safe zones by default, as designed. */
/** View › Panels: hides a panel (the others take its room) or shows it again. */
export function togglePanel(panel: string) {
  const hidden = state.hiddenPanels.includes(panel) ? state.hiddenPanels.filter((p) => p !== panel) : [...state.hiddenPanels, panel]
  try {
    localStorage.setItem('studio.hiddenPanels', JSON.stringify(hidden))
  } catch {}
  setState({ hiddenPanels: hidden })
}

// Saved workspaces: a layout, its panel sizes and the hidden panels, under a name.
export interface Workspace {
  name: string
  layout: Layout
  sizes: unknown
  hidden: string[]
}
const WS_KEY = 'studio.workspaces.v1'
export function workspaces(): Workspace[] {
  try {
    return JSON.parse(localStorage.getItem(WS_KEY) ?? '[]')
  } catch {
    return []
  }
}
function storeWorkspaces(list: Workspace[]) {
  try {
    localStorage.setItem(WS_KEY, JSON.stringify(list))
  } catch {}
  setState({ workspaceTick: state.workspaceTick + 1 })
}
export function saveWorkspace(name: string) {
  let sizes: unknown = null
  try {
    sizes = JSON.parse(localStorage.getItem(`studio.sizes.v1.${state.layout}`) ?? 'null')
  } catch {}
  storeWorkspaces([...workspaces().filter((w) => w.name !== name), { name, layout: state.layout, sizes, hidden: state.hiddenPanels }])
}
export function applyWorkspace(name: string) {
  const w = workspaces().find((x) => x.name === name)
  if (!w) return
  try {
    if (w.sizes) localStorage.setItem(`studio.sizes.v1.${w.layout}`, JSON.stringify(w.sizes))
    localStorage.setItem('studio.hiddenPanels', JSON.stringify(w.hidden ?? []))
  } catch {}
  setLayout(w.layout)
  setState({ hiddenPanels: w.hidden ?? [], workspaceTick: state.workspaceTick + 1 })
}
export function deleteWorkspace(name: string) {
  storeWorkspaces(workspaces().filter((w) => w.name !== name))
}

export function toggleLayoutLock() {
  const on = !state.layoutLocked
  try {
    localStorage.setItem('studio.layoutLocked', on ? 'on' : 'off')
  } catch {}
  setState({ layoutLocked: on })
}

export function setLayout(layout: Layout) {
  setState({ layout, safeZones: layout === 'ads', page: 'edit' })
  try {
    localStorage.setItem('studio.layout.v3', layout)
  } catch {}
}
const listeners = new Set<() => void>()

export const getState = () => state
export function setState(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}
/** Calls `l` after every change to the state (outside React); returns the unsubscribe. */
export const subscribeStore = (l: () => void) => subscribe(l)

// Toasts

let toastId = 0
export function toast(text: string, tone: Toast['tone'] = 'info') {
  // The same message again (a key pressed twice) moves to the front and stays a while longer,
  // rather than stacking copies of itself.
  const t = { id: ++toastId, tone, text }
  setState({ toasts: [...state.toasts.filter((x) => x.text !== text), t].slice(-4) })
  setTimeout(() => setState({ toasts: state.toasts.filter((x) => x.id !== t.id) }), tone === 'error' ? 7000 : 3500)
}

/** Calls the engine; failures become an error toast and resolve to undefined. */
export async function call<T = any>(method: string, params?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await window.studio.engine.call(method, params)
  } catch (e) {
    toast((e as Error).message, 'error')
    return undefined
  }
}

// Lookups

export function mediaById(snap: Snapshot | null, id: string): Media | undefined {
  return snap?.project.media.find((m) => m.id === id)
}
export function findClip(snap: Snapshot | null, id: string): { clip: Clip; track: Track } | undefined {
  for (const track of snap?.project.tracks ?? []) {
    const clip = track.clips.find((c) => c.id === id)
    if (clip) return { clip, track }
  }
  return undefined
}
export const fileUrl = (p: string) => `studio-file://cache/${encodeURIComponent(p)}`
/** "ffmpeg version 2024-03-04-git-e30369bc1c-essentials_build-www.gyan.dev" → "2024-03-04" */
export const ffmpegShort = (v: string | null | undefined) => v?.replace(/^ffmpeg version /, '').replace(/-git-.*$/, '').split(' ')[0] ?? null

// Engine events

/** Each object's JSON, worked out once. */
const shapes = new WeakMap<object, string>()
const shape = (o: object) => {
  let s = shapes.get(o)
  if (s == null) shapes.set(o, (s = JSON.stringify(o)))
  return s
}

/**
 * The engine sends the whole project after every change. Clips, tracks and media that didn't
 * change keep the objects the last snapshot had, so the views memoised on them (timeline clips,
 * caption rows) skip them: with hundreds of caption lines, a change to a few no longer redraws
 * them all (a 100 ms+ hitch per snapshot before).
 */
function share(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev || prev.dir !== next.dir) return next
  const oldClips = new Map(prev.project.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)))
  const oldTracks = new Map(prev.project.tracks.map((t) => [t.id, t]))
  const tracks = next.project.tracks.map((t) => {
    const clips = t.clips.map((c) => {
      const o = oldClips.get(c.id)
      return o && shape(o) === shape(c) ? o : c
    })
    const o = oldTracks.get(t.id)
    if (o && o.clips.length === clips.length && clips.every((c, i) => c === o.clips[i])) {
      const { clips: _n, ...restNew } = t
      const { clips: _o, ...restOld } = o
      if (JSON.stringify(restNew) === JSON.stringify(restOld)) return o
    }
    return { ...t, clips }
  })
  const oldMedia = new Map(prev.project.media.map((m) => [m.id, m]))
  const media = next.project.media.map((m) => {
    const o = oldMedia.get(m.id)
    return o && shape(o) === shape(m) ? o : m
  })
  return { ...next, project: { ...next.project, tracks, media } }
}

function onEvent(method: string, params: any) {
  switch (method) {
    case 'project.changed': {
      const snap = share(state.snap, params as Snapshot)
      const ids = new Set(snap.project.tracks.flatMap((t) => t.clips.map((c) => c.id)))
      // A folder the library was showing can go (unlinked, undone, another project opened).
      const scopeGone = state.libraryScope !== 'all' && state.libraryScope !== 'loose' && !snap.project.folders?.some((f) => f.id === state.libraryScope)
      // How many files are being prepared in this batch, for the library's progress bar.
      const busy = snap.processing.length
      const loadTotal = busy === 0 ? 0 : Math.max(state.loadTotal, busy)
      if (snap.dir !== state.snap?.dir) rememberProject(snap.dir)
      // While lines are being set again (captions), the selection waits for their new ids.
      const kept = state.selection.filter((id) => ids.has(id))
      const selection = !kept.length && state.selection.length && performance.now() < selectionHeld ? state.selection : kept
      setState({ snap, loadTotal, selection, ...(scopeGone ? { libraryScope: 'all', libraryDir: '' } : {}) })
      break
    }
    // Playback events say which clock moved: the timeline's, or a library clip's preview.
    case 'playback.state':
      if (params.context === 'source') {
        if (state.source) setState({ source: { ...state.source, playing: params.playing, positionUs: params.positionUs } })
      } else {
        // A frame shown by Preview on hover isn't the playhead moving: the line stays where it is.
        const ended = state.playing && !params.playing && !!state.snap?.durationUs && params.positionUs >= state.snap.durationUs - 1000
        setState({ playing: params.playing, positionUs: skimming && !params.playing ? state.positionUs : params.positionUs })
        // Loop playback (the timeline's ∞): at the end it plays again from the start.
        if (ended && getUi('tl.loop', false)) call('playback.play', { fromUs: 0 })
      }
      break
    case 'playback.position':
      if (params.context === 'source') {
        if (state.source?.playing) setState({ source: { ...state.source, positionUs: params.positionUs } })
      } else if (state.playing && !scrubbing) setState({ positionUs: params.positionUs })
      break
    case 'export.started':
      patchExport(params.jobId, { state: 'running', encoder: params.encoder, startedAt: Date.now() })
      break
    case 'export.progress': {
      const j = state.exports.find((x) => x.jobId === params.jobId)
      patchExport(params.jobId, { state: 'running', fraction: params.fraction, ...(j && !j.rateFrom && params.fraction > 0 ? { rateFrom: { at: Date.now(), fraction: params.fraction } } : {}) })
      break
    }
    case 'export.done': {
      patchExport(params.jobId, { state: 'done', fraction: 1, seconds: params.seconds, bytes: params.bytes, encoder: params.encoder })
      // "When done: Open folder", once every file of that export has finished.
      const batch = openWhenDone.find((b) => b.jobs.includes(params.jobId))
      if (batch && batch.jobs.every((id) => state.exports.find((j) => j.jobId === id)?.state === 'done')) {
        openWhenDone.splice(openWhenDone.indexOf(batch), 1)
        window.studio.app.openFolder(batch.folder)
      }
      break
    }
    case 'export.failed':
      patchExport(params.jobId, { state: 'failed', error: params.error })
      toast(`Export failed: ${params.error}`, 'error')
      break
    case 'export.cancelled':
      patchExport(params.jobId, { state: 'cancelled' })
      break
    case 'approval.requested': {
      const a = { id: String(params.id), what: String(params.what ?? 'do this'), detail: String(params.detail ?? '') }
      if (state.approval) setState({ approvalQueue: [...state.approvalQueue, a] })
      else setState({ approval: a })
      break
    }
    case 'media.warning': {
      const m = mediaById(state.snap, params.mediaId)
      toast(`${m?.name ?? 'Media'}: ${params.message}`, 'error')
      break
    }
  }
}

// A job's first events can come before export.start's answer lists it (the engine starts it
// at once, and a busy page reads the answer later): kept until the job is listed, so it never
// sits on "Waiting" while it runs.
const earlyExport = new Map<string, Partial<ExportJob>>()
function patchExport(jobId: string, patch: Partial<ExportJob>) {
  if (!state.exports.some((j) => j.jobId === jobId)) {
    earlyExport.set(jobId, { ...earlyExport.get(jobId), ...patch })
    return
  }
  setState({ exports: state.exports.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)) })
}

let started = false
export function startStore() {
  if (started) return
  started = true
  // For the UI check: import the way a drop does (with the loading state).
  ;(window as unknown as { __studio: object }).__studio = { importPaths, getState, removeText, newProject, openProjectAt }
  window.studio.engine.onEvent(onEvent)
  window.studio.app.paths().then((paths) => setState({ paths }))
  window.studio.services.onTaskProgress((p) => patchTask(p.taskId, { stage: p.stage, fraction: p.fraction }))
  // Text removals: each change as it happens, and a project's jobs whenever it's opened (or
  // the engine is back), to apply what finished while it was closed.
  window.studio.services.onVmakeJob(onVmakeJob)
  window.studio.services.onStemsJob(onStemsJob)
  let jobsFor = ''
  let revision = 0
  subscribe(() => {
    const dir = state.link === 'connected' && state.snap ? state.snap.dir : ''
    // The same project opened again (a version restored) starts its revisions again.
    const reopened = !!dir && (state.snap?.revision ?? 0) < revision
    revision = state.snap?.revision ?? 0
    if (dir === jobsFor && !reopened) return
    jobsFor = dir
    if (dir) {
      loadVmakeJobs(dir)
      loadStemsJobs(dir)
    } else setState({ vmakeJobs: {}, stemsJobs: {}, tasks: state.tasks.filter((t) => t.kind !== 'vmake' && t.kind !== 'stems') })
  })
  // Coming back to the app (say, after adding clips in Explorer) rescans linked folders.
  let lastSync = 0
  window.addEventListener('focus', () => {
    if (Date.now() - lastSync < 5000) return
    lastSync = Date.now()
    syncFolders(true)
  })
  window.studio.engine.onStatus(async (s) => {
    if (s.link === state.link) return
    setState({ link: s.link })
    if (s.link !== 'connected') return
    // (Re)connected: the engine may be fresh after a restart, so ask for everything again.
    const [snap, caps, status] = await Promise.all([call<Snapshot>('project.openLatest'), call<Capabilities>('engine.capabilities'), call('playback.status')])
    setState({ snap: snap ?? null, caps: caps ?? null, playing: !!status?.playing, positionUs: status?.positionUs ?? 0 })
    syncFolders(true)
  })
}

// Playback

let seekInFlight = false
let seekPending: Us | null = null
let scrubbing = false

/** Moves the playhead. Rapid calls (scrubbing) collapse to one request in flight. */
export function seek(t: Us) {
  const total = state.snap?.durationUs ?? 0
  t = Math.max(0, Math.min(total, Math.round(t)))
  setState({ positionUs: t })
  if (seekInFlight) {
    seekPending = t
    return
  }
  seekInFlight = true
  window.studio.engine
    .call('playback.seek', { positionUs: t })
    .catch(() => {})
    .finally(() => {
      seekInFlight = false
      if (seekPending != null) {
        const next = seekPending
        seekPending = null
        seek(next)
      }
    })
}
export function setScrubbing(on: boolean) {
  scrubbing = on
}

/**
 * Keeps a selection whose clips are about to be replaced (a captions track set again) for up to
 * `ms`, so the Inspector doesn't drop to the project view before the new ids are selected.
 */
let selectionHeld = 0
export function holdSelection(ms: number) {
  selectionHeld = performance.now() + ms
}

let skimInFlight = false
let skimPending: Us | null | undefined
/** Preview on hover is showing a frame other than the playhead's (until the engine is back on the line). */
let skimming = false
/** Preview on hover: shows the frame at `t` without moving the playhead; null goes back to it. */
export function skim(t: Us | null) {
  if (t != null) skimming = true
  if (skimInFlight) {
    skimPending = t
    return
  }
  skimInFlight = true
  const total = state.snap?.durationUs ?? 0
  const at = t == null ? state.positionUs : Math.max(0, Math.min(total, Math.round(t)))
  window.studio.engine
    .call('playback.seek', { positionUs: at })
    .catch(() => {})
    .finally(() => {
      skimInFlight = false
      if (skimPending !== undefined) {
        const next = skimPending
        skimPending = undefined
        skim(next)
      } else if (t == null) skimming = false
    })
}

/**
 * Space and the play buttons: pause, or play from the line (a previewed library clip from its
 * own). The engine is told where, so a frame Preview on hover left it on never decides it.
 */
export function togglePlay() {
  const src = state.source
  if (src ? src.playing : state.playing) return call('playback.pause')
  skimming = false
  skimPending = undefined
  const params = src ? { source: true, fromUs: src.positionUs } : { fromUs: state.positionUs }
  // Text being saved goes to the engine first, so the picture plays with it.
  const wait = !src && beforePlay?.()
  return wait ? wait.then(() => call('playback.play', params)) : call('playback.play', params)
}

let beforePlay: (() => Promise<unknown> | undefined) | null = null
/** What play waits for, if anything is pending (libraryActions: text changes not saved yet). */
export function setBeforePlay(fn: () => Promise<unknown> | undefined) {
  beforePlay = fn
}
export const frameUs = () => 1_000_000 / (state.snap?.project.fps || 30)
export function step(frames: number) {
  if (state.source) {
    if (state.source.playing) call('playback.pause')
    seekSource(state.source.positionUs + frames * frameUs())
    return
  }
  if (state.playing) call('playback.pause')
  seek(state.positionUs + frames * frameUs())
}

// Previewing a library clip on its own in the player

/** Shows a library clip at `atUs` in the player (paused). Clicking the timeline goes back. */
export function previewMedia(mediaId: string, atUs: Us) {
  setState({ source: { mediaId, positionUs: Math.max(0, Math.round(atUs)), playing: false }, playing: false })
  call('preview.source', { mediaId, atUs: Math.max(0, Math.round(atUs)) })
}

export function seekSource(t: Us) {
  const src = state.source
  const m = src && mediaById(state.snap, src.mediaId)
  if (!src || !m) return
  const dur = m.kind === 'image' ? 3_000_000 : m.durationUs
  const at = Math.max(0, Math.min(dur, Math.round(t)))
  setState({ source: { ...src, positionUs: at } })
  call('playback.seek', { positionUs: at, source: true })
}

/** Back to the timeline in the player, where its playhead was. */
export function exitSource() {
  if (!state.source) return
  setState({ source: null })
  seek(state.positionUs)
}

// Edits

interface FolderResult {
  folderId?: string
  name?: string
  added?: number
  missing?: number
  failed?: { path: string; error: string }[]
  path?: string
  error?: string
}

function reportFolders(folders: FolderResult[]) {
  for (const f of folders) {
    if (f.error) toast(`${basename(f.path ?? '')}: ${f.error}`, 'error')
    else if (f.added || f.missing || f.failed?.length) {
      const parts = [f.added ? `${f.added} new file${f.added === 1 ? '' : 's'}` : '', f.missing ? `${f.missing} missing` : '', f.failed?.length ? `${f.failed.length} unreadable` : ''].filter(Boolean)
      toast(`${f.name}: ${parts.join(', ')}`, f.failed?.length || f.missing ? 'error' : 'info')
    }
  }
}

/** Imports files and links folders. Files dropped on the timeline land at `insertAt`; folders never do. */
export async function importPaths(paths: string[], insertAt?: Us) {
  if (!paths.length) return
  // Shown in the library while it runs, so nobody drops the same folders in again.
  const label = paths.length === 1 ? basename(paths[0]) : `${paths.length} items`
  setState({ importing: [...state.importing, label] })
  const r = await call<{ imported: string[]; failed: { path: string; error: string }[]; folders?: FolderResult[] }>('media.import', { paths }).finally(() => {
    const i = state.importing.indexOf(label)
    setState({ importing: state.importing.filter((_, k) => k !== i) })
  })
  if (!r) return
  reportFolders(r.folders ?? [])
  const linked = r.folders?.filter((f) => f.folderId).pop()
  if (linked) setState({ libraryScope: linked.folderId!, libraryDir: '' })
  if (r.failed.length) toast(`${r.failed.length} file${r.failed.length === 1 ? '' : 's'} could not be imported: ${r.failed.map((f) => f.path.split(/[\\/]/).pop()).join(', ')}`, 'error')
  if (insertAt != null) {
    let at = insertAt
    for (const id of r.imported) {
      await call('timeline.insert', { mediaId: id, atUs: at })
      const m = mediaById(state.snap, id)
      at += m?.kind === 'image' ? 3_000_000 : (m?.durationUs ?? 0)
    }
  }
}

export async function importDialog() {
  const paths = await window.studio.app.openMedia()
  await importPaths(paths)
}

export async function importFolderDialog() {
  const dir = await window.studio.app.chooseFolder(undefined, 'Link a folder to the library')
  if (dir) await importPaths([dir])
}

/** Rescans linked folders for new and missing files. Quiet: no toast if it fails. */
export async function syncFolders(quiet = false) {
  if (!state.snap?.project.folders?.length) return
  const r = quiet ? await window.studio.engine.call('media.syncFolders').catch(() => undefined) : await call('media.syncFolders')
  if (r) reportFolders(r.folders ?? [])
}

export async function syncFolder(folderId: string) {
  const r = await call<FolderResult>('media.syncFolder', { folderId })
  if (!r) return
  if (r.added || r.missing || r.failed?.length) reportFolders([r])
  else toast(`${r.name}: up to date`)
}

export async function unlinkFolder(folderId: string) {
  await call('media.unlinkFolder', { folderId })
  setState({ libraryScope: 'all', libraryDir: '' })
}

const BUSY = 'Text is still being removed from that clip. Wait for it, or cancel it from its right-click menu.'

/**
 * The selection without clips whose text is being removed: they can't be edited until that's
 * done (the engine refuses them too). Null when that leaves nothing of a selection, so an
 * action doesn't fall back to the clip under the playhead instead.
 */
export function editableSelection(): string[] | null {
  const ids = state.selection.filter((id) => !findClip(state.snap, id)?.clip.busy)
  if (ids.length === state.selection.length) return ids
  toast(ids.length ? 'Text is still being removed from one of those clips, so it was left out.' : BUSY)
  return ids.length ? ids : null
}

/** Ctrl+B: splits only the selected clips (or, with none selected, the main-track clip under the playhead). */
export function splitAtPlayhead() {
  const ids = editableSelection()
  if (ids) call('timeline.split', { atUs: state.positionUs, clipIds: ids })
}

/**
 * Delete left (Q) / delete right (W): drops the part of the selected clip (or the main
 * clip under the playhead) before or after the playhead. With the magnet on, the main
 * track closes up after a delete left, so the playhead moves to where the cut now sits.
 */
export async function deleteSide(side: 'left' | 'right') {
  const t = state.positionUs
  // Only what's selected; the engine says so if the playhead isn't inside it.
  const ids = editableSelection()
  if (!ids) return
  const main = state.snap?.project.tracks.find((tr) => tr.main)
  const target = ids.length ? main?.clips.find((c) => ids.includes(c.id)) : main?.clips.find((c) => t > c.startUs && t < c.startUs + c.durationUs)
  const r = await call('timeline.trimAt', { atUs: t, clipIds: ids, keep: side === 'left' ? 'right' : 'left' })
  if (r !== undefined && side === 'left' && target && state.snap?.project.magnet !== false) seek(target.startUs)
}

/** Ctrl+Shift+S: the selected video clips' sound (or the main clip under the playhead) goes to an audio track. */
export function extractAudio() {
  const t = state.positionUs
  const main = state.snap?.project.tracks.find((tr) => tr.main)
  const sel = editableSelection()
  if (!sel) return
  const picked = sel.filter((id) => main?.clips.some((c) => c.id === id))
  const ids = picked.length ? picked : (main?.clips.filter((c) => t >= c.startUs && t < c.startUs + c.durationUs).map((c) => c.id) ?? [])
  call('clip.extractAudio', { clipIds: ids })
}

export const toggleMagnet = () => call('project.setOptions', { magnet: !(state.snap?.project.magnet ?? true) })
export const toggleLinkage = () => call('project.setOptions', { linkage: !(state.snap?.project.linkage ?? true) })

/** The selected main-track picture clips (what mirror, rotate and crop work on). */
export function selectedPictures(): Clip[] {
  const main = state.snap?.project.tracks.find((tr) => tr.main)
  return main?.clips.filter((c) => state.selection.includes(c.id) && mediaById(state.snap, c.mediaId)?.kind !== 'audio') ?? []
}
export function mirror() {
  for (const c of selectedPictures()) call('clip.set', { clipId: c.id, flip: !c.flip })
}
export function rotate() {
  for (const c of selectedPictures()) call('clip.set', { clipId: c.id, rotate: ((c.rotate ?? 0) + 90) % 360 })
}
export function openCrop() {
  const c = selectedPictures()[0]
  if (c) setState({ dialog: 'crop', cropClip: c.id })
}
/** Plays the selected video clips backwards (or forwards again). */
export function reverse() {
  const clips = selectedPictures().filter((c) => mediaById(state.snap, c.mediaId)?.kind === 'video' && !c.busy)
  const on = !clips.every((c) => c.reverse)
  if (clips.length) call('clip.set', { clipIds: clips.map((c) => c.id), reverse: on })
}
/** Freeze frame: holds the frame at the playhead for 3 s, inserted at the playhead. */
export async function freezeFrame() {
  const r = await call('timeline.freezeFrame', { atUs: state.positionUs, clipIds: state.selection })
  if (r !== undefined) toast('Freeze frame added: 3 s of the frame at the playhead')
}
/** M: a marker at the playhead (the Audio page shows it on its labels track). */
export function addMarker() {
  const at = state.positionUs
  const n = (state.snap?.project.labels?.length ?? 0) + 1
  call('labels.add', { items: [{ startUs: at, endUs: at, text: `Marker ${n}` }] })
}

// J, K, L: play backwards (again for faster), stop, play forwards.
let shuttleTimer = 0
let shuttleSpeed = 0
export function shuttle(dir: -1 | 0 | 1) {
  window.clearInterval(shuttleTimer)
  shuttleTimer = 0
  if (dir >= 0) shuttleSpeed = 0
  if (dir === 0) {
    if (state.playing) call('playback.pause')
    return
  }
  if (dir === 1) {
    const wait = !state.playing && beforePlay?.()
    if (wait) wait.then(() => call('playback.play'))
    else if (!state.playing) call('playback.play')
    return
  }
  // The engine plays forwards only, so backwards steps the playhead back in real time.
  if (state.playing) call('playback.pause')
  shuttleSpeed = Math.min(8, shuttleSpeed ? shuttleSpeed * 2 : 1)
  const tick = 1000 / 15
  shuttleTimer = window.setInterval(() => {
    const next = state.positionUs - tick * 1000 * shuttleSpeed
    seek(Math.max(0, next))
    if (next <= 0) shuttle(0)
  }, tick)
}

export const setTrack = (trackId: string, change: { mute?: boolean; locked?: boolean; solo?: boolean; hidden?: boolean }) => call('track.set', { trackId, ...change })
/** The cover (the video's thumbnail) is the frame at the playhead. */
export const setCover = () => call('project.setOptions', { coverUs: state.positionUs })

export function deleteSelection() {
  if (!state.selection.length) return
  const ids = editableSelection()
  if (!ids) return
  call('timeline.delete', { clipIds: ids })
  setState({ selection: state.selection.filter((id) => !ids.includes(id)) })
}

export const undo = () => call('edit.undo')
export const redo = () => call('edit.redo')

export function selectAll() {
  setState({ selection: state.snap?.project.tracks.flatMap((t) => t.clips.map((c) => c.id)) ?? [] })
}

export async function openProjectDialog() {
  const file = await window.studio.app.openProject(state.paths?.projects)
  if (!file) return
  const snap = await call<Snapshot>('project.open', { path: file })
  if (!snap) return
  setState({ snap, selection: [], positionUs: 0, playing: false, libraryScope: 'all', libraryDir: '' })
  syncFolders(true)
}

export async function newProject(name: string, aspect: string) {
  await hush()
  const snap = await call<Snapshot>('project.new', { name, aspect })
  if (snap) setState({ snap, selection: [], positionUs: 0, playing: false, dialog: null, libraryScope: 'all', libraryDir: '', page: 'edit' })
}

const openWhenDone: { jobs: string[]; folder: string }[] = []

export interface ExportOptions {
  /** File names without .mp4, per format ("9:16" → "Promo-9x16-v3"). */
  names?: Record<string, string>
  bitrateMbps?: number
  fps?: number
  captions?: string
  openFolder?: boolean
}

/** Starts the exports; returns their job ids (null if the engine refused). */
export async function startExport(formats: string[], quality: string, folder: string, baseName: string, clipIds?: string[] | null, o: ExportOptions = {}): Promise<string[] | null> {
  const { openFolder, ...rest } = o
  const r = await call<{ jobs: { jobId: string; width: number; height: number; path: string; encoder: string }[] }>('export.start', { formats, quality, folder, baseName, ...rest, ...(clipIds?.length ? { clipIds } : {}) })
  if (!r) return null
  const jobs: ExportJob[] = r.jobs.map((j) => ({ ...j, state: 'queued', fraction: 0, ...earlyExport.get(j.jobId) }))
  for (const j of r.jobs) earlyExport.delete(j.jobId)
  if (openFolder) openWhenDone.push({ jobs: jobs.map((j) => j.jobId), folder })
  // Ones the Export window still shows stay listed until it's closed.
  const shown = new Set(state.exportBatch ?? [])
  setState({ exports: [...state.exports.filter((j) => j.state === 'running' || j.state === 'queued' || shown.has(j.jobId)), ...jobs] })
  return jobs.map((j) => j.jobId)
}

// Clipboard, attributes, compound clips, the library's own delete

/** The selected clips (but busy ones), plus (with linkage on) the audio extracted from them. */
function selectionWithLinked(): string[] {
  const p = state.snap?.project
  if (!p) return []
  const ids = new Set(state.selection.filter((id) => !findClip(state.snap, id)?.clip.busy))
  if (p.linkage !== false) {
    const main = p.tracks.find((t) => t.main)
    const links = new Set(main?.clips.filter((c) => ids.has(c.id) && c.link).map((c) => c.link))
    for (const t of p.tracks) for (const c of t.clips) if (c.link && links.has(c.link)) ids.add(c.id)
  }
  return [...ids]
}

/** Ctrl+C: the selected clips, or the picked library items, depending on the panel clicked last. */
export function copy(): boolean {
  if (state.focus === 'library') {
    const media = state.snap?.project.media.filter((m) => state.libraryPicked.includes(m.id)) ?? []
    if (!media.length) return false
    setState({ clipboard: { kind: 'media', media, cut: false } })
    return true
  }
  if (!editableSelection()) return false
  const ids = selectionWithLinked()
  const found = ids.map((id) => findClip(state.snap, id)).filter((x): x is { clip: Clip; track: Track } => !!x)
  if (!found.length) return false
  const start = Math.min(...found.map((f) => f.clip.startUs))
  setState({ clipboard: { kind: 'clips', items: found.map((f) => ({ clip: f.clip, main: f.track.main, offsetUs: f.clip.startUs - start, ...(f.track.role && !f.track.main ? { role: f.track.role } : {}) })) } })
  return true
}

/** Ctrl+X: copy, then take the clips off the timeline (or the items out of the library). */
export async function cut() {
  if (!copy()) return
  if (state.focus === 'library') {
    const cb = state.clipboard
    if (cb?.kind !== 'media') return
    setState({ clipboard: { ...cb, cut: true } })
    await call('media.remove', { mediaIds: cb.media.map((m) => m.id) })
    setState({ libraryPicked: [] })
  } else {
    const ids = selectionWithLinked()
    await call('timeline.delete', { clipIds: ids })
    setState({ selection: state.selection.filter((id) => !ids.includes(id)) })
  }
}

/** Ctrl+V: clips go back on the timeline at the playhead; library items go back in the library, and onto the timeline if it was clicked last. */
export async function paste() {
  const cb = state.clipboard
  if (!cb) return
  if (cb.kind === 'clips') {
    const r = await call<{ clipIds: string[] }>('clips.paste', { items: cb.items, atUs: state.positionUs })
    if (r) setState({ selection: r.clipIds })
    return
  }
  let ids = cb.media.map((m) => m.id)
  if (cb.cut) {
    const r = await call<{ mediaIds: string[] }>('media.restore', { media: cb.media })
    if (!r) return
    ids = r.mediaIds
    setState({ clipboard: { ...cb, cut: false } })
  }
  if (state.focus === 'timeline') {
    let at = state.positionUs
    for (const id of ids) {
      const m = mediaById(state.snap, id)
      if (!m || m.missing) continue
      await call('timeline.insert', { mediaId: id, atUs: at })
      at += m.kind === 'image' ? 3_000_000 : m.durationUs
    }
  } else setState({ libraryPicked: ids })
}

/** Delete: clips from the timeline, or picked items from the library, by the panel clicked last. */
export function deleteFocused() {
  if (state.focus === 'library') removeFromLibrary(state.libraryPicked)
  else deleteSelection()
}

/** Takes media out of the library (files on disk stay), with any clips that used them. */
export async function removeFromLibrary(ids: string[]) {
  if (!ids.length) return
  const r = await call<{ media: number; clips: number }>('media.remove', { mediaIds: ids })
  if (!r) return
  setState({ libraryPicked: [] })
  toast(`Removed ${r.media} file${r.media === 1 ? '' : 's'} from the library${r.clips ? ` and ${r.clips} clip${r.clips === 1 ? '' : 's'} that used ${r.media === 1 ? 'it' : 'them'}` : ''}. Ctrl+Z brings ${r.media === 1 ? 'it' : 'them'} back.`)
}

export function copyAttributes() {
  const c = findClip(state.snap, state.selection[0])?.clip
  if (!c) return
  const own = c as unknown as Attributes
  setState({ attributes: Object.fromEntries(Object.entries(ATTRIBUTE_DEFAULTS).map(([k, d]) => [k, own[k] ?? d])) })
  toast('Attributes copied')
}

export function pasteAttributes() {
  const a = state.attributes
  if (!a || !state.selection.length) return
  const ids = editableSelection()
  if (!ids) return
  const [first, ...rest] = ids
  call('clip.set', { clipId: first, clipIds: rest, ...a, label: 'Paste attributes' })
}

/** Renders the selected clips into one compound clip in their place. */
export async function makeCompound() {
  const ids = editableSelection()
  if (!ids?.length) return
  toast('Making a compound clip…')
  const r = await call<{ clipId: string }>('timeline.compound', { clipIds: ids })
  if (r) setState({ selection: [r.clipId] })
}

export const isCompound = (clipId: string) => !!mediaById(state.snap, findClip(state.snap, clipId)?.clip.mediaId ?? '')?.parts

export async function breakCompound() {
  const id = state.selection.find(isCompound)
  if (!id) return
  const r = await call<string[]>('timeline.breakCompound', { clipId: id })
  if (r) setState({ selection: r })
}

/** Opens the export dialog for just the selected clips. */
export function exportSelection() {
  if (state.selection.length) setState({ dialog: 'export', exportClips: [...state.selection] })
}

// Background tasks on outside services

export function patchTask(id: string, patch: Partial<Task>) {
  setState({ tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
}

export function startTask(label: string, kind?: string, key?: string): string {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  setState({ tasks: [...state.tasks.filter((t) => t.state === 'running'), { id, label, stage: 'Starting', fraction: 0, state: 'running', kind, key, startedAt: Date.now() }] })
  return id
}

/** The running task of this kind (and key, if given), if there is one. */
export const runningTask = (kind: string, key?: string) => state.tasks.find((t) => t.state === 'running' && t.kind === kind && (key === undefined || t.key === key))

/**
 * True when that job is already running: it says so instead of starting a second one, so a
 * second click on a slow button never makes a duplicate.
 */
export function alreadyRunning(kind: string, key?: string): boolean {
  const t = runningTask(kind, key)
  if (t) toast(`${t.label} is still working (${Math.round((Date.now() - (t.startedAt ?? Date.now())) / 1000)} s so far). It finishes on its own.`)
  return !!t
}

/** The running task of a kind, for its button; re-renders every second so the time counts up. */
export function useRunningTask(kind: string, key?: string): Task | undefined {
  const task = useStore((s) => s.tasks.find((t) => t.state === 'running' && t.kind === kind && (key === undefined || t.key === key)))
  const [, tick] = useState(0)
  useEffect(() => {
    if (!task) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [task?.id])
  return task
}

/** "12 s", "1:05": how long a task has run. */
export const taskElapsed = (t: Task) => {
  const sec = Math.max(0, Math.round((Date.now() - (t.startedAt ?? Date.now())) / 1000))
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

export function endTask(id: string, error?: string) {
  patchTask(id, error ? { state: 'failed', error } : { state: 'done', fraction: 1, stage: 'Done' })
  if (error) toast(error, 'error')
  setTimeout(() => setState({ tasks: state.tasks.filter((t) => t.id !== id || t.state === 'running') }), error ? 8000 : 2500)
}

/** A path inside the project folder, with the folder's own separator. */
export function projectPath(...parts: string[]) {
  const dir = state.snap?.dir ?? ''
  const sep = dir.includes('\\') ? '\\' : '/'
  return [dir, ...parts].join(sep)
}

/** A file name not already used by the project's media (and safe on every system). */
export function freshName(stem: string, ext: string) {
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled'
  const used = new Set(state.snap?.project.media.map((m) => basename(m.path).toLowerCase()))
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`
    if (!used.has(name.toLowerCase())) return name
  }
}

export function openVmake(target: { mediaId: string; clipId?: string }) {
  setState({ dialog: 'vmake', vmakeTarget: target })
}

// Text removal with Vmake, on the user's own Vmake account. The main process runs each job
// to its end whether or not its project is open, and keeps it beside the project
// (src/main/vmake-jobs.ts). Meanwhile the clip is marked busy in the engine (`clip.busy`), so
// nothing changes it: the timeline greys it out with its progress, and the engine refuses
// edits, MCP and undo on it. A finished job is applied, or a failed one's clip freed, when
// its project is open: right away, or the next time it's opened.

const vmakeRunning = (j: VmakeJob) => j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled'
/** Jobs whose clip part this page is still cutting (a job left "preparing" by a reloaded page never goes). */
const vmakePreparing = new Set<string>()
const vmakeSettling = new Set<string>()
const sameDir = (a: string, b: string) => {
  const n = (d: string) => d.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return window.studio.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/**
 * Removes on-screen text with Vmake. For a timeline clip only the part it plays is sent, and
 * the clip then plays the cleaned copy; for a library item the whole file is sent and the
 * cleaned copy joins the library next to it.
 */
export async function removeText(target: { mediaId: string; clipId?: string }, model: string) {
  const snap = state.snap
  const media = mediaById(snap, target.mediaId)
  if (!snap || !media) return
  const clip = target.clipId ? findClip(snap, target.clipId)?.clip : undefined
  if (clip?.busy) return void toast('Text is already being removed from that clip.')
  if (!clip && Object.values(state.vmakeJobs).some((j) => vmakeRunning(j) && j.mediaId === media.id && !j.clipId)) return void toast(`Text is already being removed from ${media.name}.`)
  const stem = media.name.replace(/\.[^.]+$/, '')
  // The part of the source the clip plays: its length on the timeline times its speed.
  const durationUs = clip ? Math.round(clip.durationUs * (clip.speed ?? 1)) : media.durationUs
  const out = projectPath('cleaned', freshName(`${stem} (no text)`, '.mp4'))
  const job = await window.studio.services.vmakeCreate({ project: snap.dir, clipId: clip?.id, mediaId: media.id, name: media.name, title: stem, model, out, seconds: durationUs / 1e6 })
  if ('error' in job) return void toast(`Text removal failed: ${job.error}`, 'error')
  vmakePreparing.add(job.id)
  onVmakeJob(job)
  try {
    // Busy first: from here on nothing changes the clip, however long Vmake takes.
    if (clip) await window.studio.engine.call('clip.busy', { clipId: clip.id, job: job.id })
    let source = media.path
    let removeSource = false
    if (clip || !media.path.toLowerCase().endsWith('.mp4')) {
      const part = projectPath('cleaned', `${stem}-${job.id}-part.mp4`)
      const r = await window.studio.engine.call('media.extractRange', { mediaId: media.id, inUs: clip?.inUs ?? 0, durationUs, out: part })
      source = r.out
      removeSource = true
    }
    const r = await window.studio.services.vmakeStart(job.id, { source, removeSource })
    if ('error' in r) throw new Error(r.error)
  } catch (e) {
    await window.studio.services.vmakeCancel(job.id, (e as Error).message)
  } finally {
    vmakePreparing.delete(job.id)
  }
}

/** Right-click › Cancel text removal on a busy clip. Credits Vmake already took stay spent. */
export async function cancelTextRemoval(jobId: string) {
  const job = await window.studio.services.vmakeCancel(jobId)
  if (job) return
  // No job behind the mark (it was lost): free the clip here.
  const c = state.snap?.project.tracks.flatMap((t) => t.clips).find((x) => x.busy === jobId)
  if (c) await call('clip.release', { clipId: c.id, job: jobId })
}

/** A job changed (any project's): the open project's are shown, and applied when they end. */
function onVmakeJob(job: VmakeJob) {
  // A dub's own text removal: the dub shows it and takes its result.
  if (job.dub || !state.snap || !sameDir(job.project, state.snap.dir)) return
  setState({ vmakeJobs: { ...state.vmakeJobs, [job.id]: job } })
  showVmakeTask(job)
  if (!vmakeRunning(job)) settleVmakeJob(job)
}

/** The title bar's task for a job of the open project. */
function showVmakeTask(job: VmakeJob) {
  const others = state.tasks.filter((t) => t.id !== job.id)
  if (vmakeRunning(job)) setState({ tasks: [...others, { id: job.id, label: `Removing text from ${job.name}`, stage: job.stage, fraction: job.fraction, state: 'running', kind: 'vmake', key: job.clipId ?? job.mediaId, startedAt: job.startedAt }] })
  else if (job.state === 'done' && others.length < state.tasks.length) {
    patchTask(job.id, { state: 'done', fraction: 1, stage: 'Done' })
    setTimeout(() => setState({ tasks: state.tasks.filter((t) => t.id !== job.id || t.state === 'running') }), 2500)
  } else if (others.length < state.tasks.length) setState({ tasks: others })
}

/** A project was opened (or the engine is back): its jobs, and whatever ended while it was closed. */
async function loadVmakeJobs(dir: string) {
  const list = (await window.studio.services.vmakeJobs(dir)).filter((j) => !j.dub)
  if (!state.snap || !sameDir(state.snap.dir, dir)) return
  setState({ vmakeJobs: Object.fromEntries(list.map((j) => [j.id, j])), tasks: state.tasks.filter((t) => t.kind !== 'vmake') })
  for (const j of list) {
    showVmakeTask(j)
    if (!vmakeRunning(j)) settleVmakeJob(j)
    // Left while its part was being cut (the page reloaded): it never went to Vmake.
    else if (j.state === 'preparing' && !vmakePreparing.has(j.id)) window.studio.services.vmakeCancel(j.id, 'Studio was interrupted before the clip went to Vmake. Nothing was charged; start it again.')
  }
  // A busy mark with no job behind it (lost, or a copy of a project whose job runs in the original).
  // Only text removals' marks ("v…"): a dub's ("d…") is the dub's own (dub.ts).
  for (const t of state.snap.project.tracks)
    for (const c of t.clips)
      if (c.busy?.startsWith('v') && !list.some((j) => j.id === c.busy)) {
        await call('clip.release', { clipId: c.id, job: c.busy })
        toast(`The text removal for ${mediaById(state.snap, c.mediaId)?.name ?? 'a clip'} was lost, so the clip is back as it was. Start it again from its right-click menu.`, 'error')
      }
}

/**
 * An ended job of the open project: a finished one's cleaned copy replaces its clip (one undo
 * step, which also ends the busy state) or joins the library; a failed or cancelled one's clip
 * is freed and the reason shown. Then the main process forgets it.
 */
async function settleVmakeJob(job: VmakeJob) {
  if (vmakeSettling.has(job.id) || state.link !== 'connected') return
  vmakeSettling.add(job.id)
  const engine = window.studio.engine
  const found = job.clipId ? findClip(state.snap, job.clipId)?.clip : undefined
  // Its clip, still waiting for it.
  const ours = found?.busy === job.id ? found : undefined
  try {
    if (job.state === 'done') {
      const imp = await engine.call('media.import', { paths: [job.out] })
      const mediaId = imp.imported?.[0]
      if (ours && mediaId) {
        await engine.call('clip.replaceMedia', { clipId: ours.id, mediaId, job: job.id, label: 'Remove text' })
        toast(`Text removed from ${job.name}: the clip now plays the cleaned copy (Ctrl+Z goes back).`)
      } else {
        if (ours) await engine.call('clip.release', { clipId: ours.id, job: job.id })
        toast(job.clipId ? `Text removed from ${job.name}. The clip had changed, so the cleaned copy is in the library.` : `Text removed: "${basename(job.out)}" is in the library.`)
      }
    } else {
      if (ours) await engine.call('clip.release', { clipId: ours.id, job: job.id })
      if (job.state === 'failed') toast(`Text removal failed for ${job.name}: ${job.reason ?? 'unknown error'}`, 'error')
      else toast(job.reason ?? 'Text removal cancelled.')
    }
  } catch (e) {
    // The result couldn't come in (its file gone, say): the clip is freed all the same.
    if (ours) await engine.call('clip.release', { clipId: ours.id, job: job.id }).catch(() => {})
    toast(`The text removal for ${job.name} couldn't be applied: ${(e as Error).message}`, 'error')
  }
  await window.studio.services.vmakeSettled(job.id)
  const rest = { ...state.vmakeJobs }
  delete rest[job.id]
  setState({ vmakeJobs: rest })
  vmakeSettling.delete(job.id)
}

/**
 * What a busy clip shows: how far along (0–1; null while that isn't known yet) and in words,
 * "Removing text with Vmake… 42 % · about 40 s left". While Vmake works the bar is the clock
 * against the job's estimate (src/shared/vmake-estimate.ts), as Vmake only says working or done.
 */
export function vmakeProgress(job: VmakeJob | undefined, now = Date.now()): { fraction: number | null; text: string; head: string; left: string } {
  const say = 'Removing text with Vmake…'
  if (!job) return { fraction: null, text: say, head: say, left: '' }
  if (job.state === 'working' && job.chargedAt && job.expectedMs) {
    const elapsed = now - job.chargedAt
    const f = job.reported ? job.fraction : waitFraction(elapsed, job.expectedMs, job.fraction)
    const head = `${say} ${Math.round(f * 100)} %`
    const left = timeLeft(elapsed, job.expectedMs, !!job.firstGuess)
    return { fraction: f, text: `${head} · ${left}`, head, left }
  }
  const known = job.fraction > 0.02
  const head = known ? `${say} ${Math.round(job.fraction * 100)} %` : say
  return { fraction: known ? job.fraction : null, text: head, head, left: '' }
}

/** A job for its clip's look and the Inspector; re-renders every second so the time counts up. */
export function useVmakeJob(id: string | null | undefined): VmakeJob | undefined {
  const job = useStore((s) => (id ? s.vmakeJobs[id] : undefined))
  const [, tick] = useState(0)
  useEffect(() => {
    if (!id) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [id])
  return job
}

// Stems: a clip's sound split into its parts by the stems server (AudioShake underneath). The main
// process cuts the stretch of the file the clip plays, sends it, and brings the stems back into
// the project's stems folder (src/main/stems.ts), whichever project is open; the Stems tab shows
// the open project's. A stem is imported when it's played or used, and goes back on the
// timeline at the clip's place, speed and direction (`timeline.addStems`).

/** Starts separating a clip's sound: the stretch of its file it plays goes to the server. */
export async function separateStems(clipId: string) {
  const snap = state.snap
  const found = findClip(snap, clipId)
  const media = found && mediaById(snap, found.clip.mediaId)
  if (!snap || !found || !media) return
  const c = found.clip
  const job = await window.studio.services.stemsStart({ project: snap.dir, clipId: c.id, mediaId: media.id, name: media.name, source: media.path, inUs: c.inUs, spanUs: Math.round(c.durationUs * (c.speed ?? 1)) })
  if ('error' in job) return void toast(`Stems: ${job.error}`, 'error')
  onStemsJob(job)
}

/** Stops a separation; what it made goes. */
export const cancelStems = (dir: string) => window.studio.services.stemsCancel(dir)

/** A separation changed (any project's): the open project's are shown, with a word when one ends. */
function onStemsJob(job: StemsJob) {
  if (!state.snap || !sameDir(job.project, state.snap.dir)) return
  const was = state.stemsJobs[job.dir]
  const all = { ...state.stemsJobs }
  if (job.state === 'cancelled') delete all[job.dir]
  else all[job.dir] = job
  setState({ stemsJobs: all })
  showStemsTask(job)
  if (!was || !stemsRunning(was)) return
  if (job.state === 'done') {
    const heard = job.stems?.filter((s) => !s.silent).length ?? 0
    const song = job.songs?.[0]
    toast(`Stems of ${job.name} are ready: ${heard} with sound.${song ? ` The song: ${song.title}${song.artist ? ` by ${song.artist}` : ''}.` : ''} They're in the clip's Stems tab.`)
  } else if (job.state === 'failed') toast(`Stems of ${job.name}: ${job.reason ?? 'it failed'}`, 'error')
}

/** The title bar's task for a separation of the open project. */
function showStemsTask(job: StemsJob) {
  const id = `stems:${job.dir}`
  const others = state.tasks.filter((t) => t.id !== id)
  if (stemsRunning(job)) setState({ tasks: [...others, { id, label: `Stems of ${job.name}`, stage: job.stage, fraction: job.fraction, state: 'running', kind: 'stems', key: job.clipId, startedAt: job.startedAt }] })
  else if (job.state === 'done' && others.length < state.tasks.length) {
    patchTask(id, { state: 'done', fraction: 1, stage: 'Done' })
    setTimeout(() => setState({ tasks: state.tasks.filter((t) => t.id !== id || t.state === 'running') }), 2500)
  } else if (others.length < state.tasks.length) setState({ tasks: others })
}

/** A project was opened (or the engine is back): its separations; unfinished ones carry on. */
async function loadStemsJobs(dir: string) {
  const list = await window.studio.services.stemsJobs(dir)
  if (!state.snap || !sameDir(state.snap.dir, dir)) return
  setState({ stemsJobs: Object.fromEntries(list.map((j) => [j.dir, j])), tasks: state.tasks.filter((t) => t.kind !== 'stems') })
  for (const j of list) showStemsTask(j)
}

/** The library ids of these stem files, imported first if they aren't in the project (one undo step). */
async function stemMedia(paths: string[]): Promise<string[] | null> {
  const r = await call<{ imported: string[]; failed: { path: string; error: string }[] }>('media.import', { paths })
  if (!r) return null
  if (r.failed?.length) {
    toast(`${r.failed.map((f) => basename(f.path)).join(', ')} couldn't be imported: ${r.failed[0].error}`, 'error')
    return null
  }
  const snap = await call<Snapshot>('project.current')
  const ids = paths.map((p) => snap?.project.media.find((m) => sameDir(m.path, p))?.id)
  return ids.every(Boolean) ? (ids as string[]) : null
}

/** ▶ on a stem: plays it in the player on its own (the library's preview), or pauses it. */
export async function previewStem(path: string) {
  const src = state.source
  const playing = src && sameDir(mediaById(state.snap, src.mediaId)?.path ?? '', path)
  if (playing && src.playing) return void call('playback.pause')
  const [id] = (await stemMedia([path])) ?? []
  if (!id) return
  if (state.playing) await call('playback.pause')
  // From where it was paused, or from the start.
  const media = mediaById(state.snap, id)
  const from = playing && src.positionUs < (media?.durationUs ?? 0) - 100_000 ? src.positionUs : 0
  previewMedia(id, from)
  await call('playback.play', { source: true, fromUs: from })
}

/**
 * Puts stems of a clip's sound on new sound tracks just under it, in sync; with `replace` the
 * clip's own sound goes off ("Use only these"). One undo step (after their import, if new).
 */
export async function addStems(clipId: string, job: StemsJob, names: string[], replace: boolean) {
  const stems = job.stems?.filter((s) => names.includes(s.name)) ?? []
  if (!stems.length) return
  const ids = await stemMedia(stems.map((s) => s.path))
  if (!ids) return
  const r = await call<{ clipIds: string[] }>('timeline.addStems', { clipId, fromUs: job.inUs, stems: stems.map((s, i) => ({ mediaId: ids[i], role: stemRole(s.name) })), replace })
  if (!r) return
  const said = stems.length === 1 ? stems[0].label : `${stems.slice(0, -1).map((s) => s.label).join(', ')} and ${stems[stems.length - 1].label}`
  toast(replace ? `The clip now plays only ${said} (Ctrl+Z goes back).` : `${said} ${stems.length === 1 ? 'is' : 'are'} under the clip, in sync.`)
}

