// What the library tabs (and a few Inspector buttons) do: text, the brand kit, stickers,
// looks, effects, adjustment layers, transitions, captions, the sound library, tracking and
// the MCP settings. Each goes to the engine through the contract's RPCs (docs/contract-v2.md)
// or, where the work is the page's (drawing text, stickers, captions), is done here first.

import { addSticker, addYourSticker, uploadSticker } from './stickers'
import { BUILT_IN_LOOKS, deleteLook, lookOf, saveLookAs, type Look } from './looks'
import { DEFAULT_TEXT, scaleSpec } from './textPresets'
import { previewTextLook, setEditLook } from './liveText'
import { renderTextClip, textPlaceOf, type TextLook } from './textRender'
import { setUi } from './ui-state'
import { call, findClip, getState, mediaById, setBeforePlay, setState, subscribeStore, toast, type Clip, type Project } from './store'
import { findTrackTargets } from './vision'

export { addSticker, addYourSticker, uploadSticker }
export { applyCaptionLook, burnCaptions, captionTracks, captionsForEveryVoiceover, editCaptionLine, exportCaptionsSrt, exportSrt, generateCaptions, restyleCaptions } from './captions'
export { addSound, previewSound } from './soundLibrary'
export { BUILT_IN_LOOKS, deleteLook }

// Engine lists (effects and transitions), asked once per engine connection.

const lists = new Map<string, Promise<string[]>>()
export function engineList(method: 'engine.effects' | 'engine.transitions'): Promise<string[]> {
  let p = lists.get(method)
  if (!p) {
    p = window.studio.engine.call(method).then((r: unknown) => (Array.isArray(r) ? r.map(String) : []))
    p.catch(() => lists.delete(method))
    lists.set(method, p)
  }
  return p
}

// Text

const isText = (c: Clip) => !!c.text

/** Adds a text clip at the playhead (its own track), selects it and opens its text in the Inspector. */
export async function addText(spec?: TextLook) {
  const s = getState()
  const p = s.snap?.project
  if (!p) return
  // Called from keys and menus too, so anything that isn't a text look means the plain text.
  const base = spec && typeof spec === 'object' && 'content' in spec ? spec : DEFAULT_TEXT
  try {
    const look = await renderTextClip(scaleSpec(base, p.width), 'text')
    const r = await call<{ clipId: string; trackId: string }>('text.add', { atUs: s.positionUs, text: look })
    if (!r) return
    setState({ selection: [r.clipId], focus: 'timeline' })
    setUi('insp.textTab', 'text')
    // Once the Inspector shows the new clip (it needs the engine's snapshot first), its text field takes the keys.
    const t0 = Date.now()
    const focus = () => {
      if (document.querySelector('.insp-text') && findClip(getState().snap, r.clipId)) window.dispatchEvent(new CustomEvent('studio:edit-text', { detail: r.clipId }))
      else if (Date.now() - t0 < 2000) setTimeout(focus, 50)
    }
    setTimeout(focus, 0)
  } catch (e) {
    toast(`Couldn’t add the text: ${(e as Error).message}`, 'error')
  }
}

export const addTextPreset = (spec: TextLook) => (spec.preset === 'Countdown' ? addCountdown(spec) : addText(spec))

/**
 * Countdown: the clock in the text (hh:mm:ss, mm:ss or a plain number of seconds) ticks down
 * once a second, as one-second text clips on a track of their own, 10 seconds long. Each
 * second is its own drawing, so the font and box stay exactly as the style shows.
 */
export async function addCountdown(spec: TextLook, seconds = 10) {
  const s = getState()
  const p = s.snap?.project
  if (!p) return
  const m = /(\d+):(\d{2})(?::(\d{2}))?|(\d+)/.exec(spec.content)
  if (!m) return addText(spec)
  const start = m[4] != null ? Number(m[4]) : m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2])
  const pad = (n: number) => String(n).padStart(2, '0')
  const show = (v: number) =>
    m[4] != null ? String(v) : m[3] != null ? `${pad(Math.floor(v / 3600))}:${pad(Math.floor(v / 60) % 60)}:${pad(v % 60)}` : `${pad(Math.floor(v / 60))}:${pad(v % 60)}`
  const at = s.positionUs
  let trackId: string | undefined
  let first: string | undefined
  try {
    for (let i = 0; i < seconds && start - i >= 0; i++) {
      const content = spec.content.slice(0, m.index) + show(start - i) + spec.content.slice(m.index + m[0].length)
      const look = await renderTextClip(scaleSpec({ ...spec, content }, p.width), 'countdown')
      const r = await call<{ clipId: string; trackId: string }>('text.add', { atUs: at + i * 1_000_000, durationUs: 1_000_000, text: look, ...(trackId ? { trackId } : {}) })
      if (!r) return
      trackId = r.trackId
      first ??= r.clipId
    }
    if (first) setState({ selection: [first], focus: 'timeline' })
    toast(`Countdown added: ${seconds} seconds from ${show(start)}, one clip per second`)
  } catch (e) {
    toast(`Couldn’t add the countdown: ${(e as Error).message}`, 'error')
  }
}

// A change to a text clip shows in the player on the next frame (liveText.ts draws it), and
// goes to the engine in the background: drawn to a PNG and sent with `text.set`, at most every
// 150 ms while changes keep coming (a slider dragged, words typed), and once more at the end.
// Changes less than 600 ms apart are one gesture, which the engine keeps as one undo step.

const COMMIT_EVERY = 150
const GESTURE_GAP = 600

/** A text clip's changes on their way to the engine. */
interface TextJob {
  /** Not sent yet. */
  pending: Partial<TextLook>
  /** Every change since the engine last had them all (what the player shows on top of the snapshot). */
  look: Partial<TextLook>
  running: boolean
  lastSent: number
  lastChange: number
  gesture: string
  /** The gesture is shared by every text clip (Apply to all text): one undo step for them all. */
  together?: boolean
  /** The last PNG sent: the player lets go of the clip once the snapshot has it. */
  png?: string
  failed?: boolean
  /** Ends the wait between two sends, when play wants everything saved now (flushText). */
  wake?: () => void
  hurry?: boolean
  done: (() => void)[]
}
const textJobs = new Map<string, TextJob>()

let allGesture = { id: '', last: 0 }
/** The gesture of a change going to every text clip (Apply to all text): one for a whole drag of a slider. */
export function textGestureForAll() {
  const now = performance.now()
  if (now - allGesture.last > GESTURE_GAP) allGesture = { id: `all-${now.toString(36)}`, last: now }
  allGesture.last = now
  return allGesture.id
}

/**
 * Merges `patch` into a text clip's look: shown at once, saved in the background (see above).
 * `together` (from textGestureForAll) makes it part of one undo step across text clips.
 */
export function updateText(clipId: string, patch: Partial<TextLook>, together?: string): Promise<void> {
  const now = performance.now()
  let j = textJobs.get(clipId)
  if (!j) {
    j = { pending: {}, look: {}, running: false, lastSent: 0, lastChange: 0, gesture: '', done: [] }
    textJobs.set(clipId, j)
  }
  if (together) {
    j.gesture = together
    j.together = true
  } else if (now - j.lastChange > GESTURE_GAP || j.together) {
    j.gesture = now.toString(36)
    j.together = false
  }
  j.lastChange = now
  j.pending = { ...j.pending, ...patch }
  j.look = { ...j.look, ...patch }
  j.failed = false
  setEditLook(clipId, j.look)
  const saved = new Promise<void>((res) => j.done.push(res))
  if (!j.running) sendText(clipId, j)
  return saved
}

/** Draws and sends a clip's pending changes until none are left, at most every COMMIT_EVERY ms. */
async function sendText(clipId: string, j: TextJob) {
  j.running = true
  try {
    while (Object.keys(j.pending).length) {
      const wait = j.lastSent + COMMIT_EVERY - performance.now()
      if (wait > 0 && !j.hurry)
        await new Promise<void>((res) => {
          j.wake = res
          window.setTimeout(res, wait)
        })
      j.wake = undefined
      // The player draws the change first; the PNG is drawn after that frame.
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)))
      const next = j.pending
      j.pending = {}
      j.lastSent = performance.now()
      // The engine's copy as it is now (the store's may be a step behind).
      const now = await window.studio.engine.call('project.current').catch(() => getState().snap)
      const clip = findClip(now, clipId)?.clip
      if (!clip?.text) break
      const look = await renderTextClip({ ...(clip.text as TextLook), ...next }, clipId, textPlaceOf(clip, now.project.width))
      const changed = Object.fromEntries(Object.keys(next).map((k) => [k, (look as unknown as Record<string, unknown>)[k]]))
      await window.studio.engine.call('text.set', { clipId, text: { ...changed, png: look.png, boxW: look.boxW, boxH: look.boxH }, gesture: j.gesture, ...(j.together ? { together: true } : {}) })
      j.png = look.png
    }
  } catch (e) {
    j.failed = true
    j.pending = {}
    toast(`Couldn’t draw the text: ${(e as Error).message}`, 'error')
  } finally {
    j.running = false
    j.hurry = false
    for (const d of j.done.splice(0)) d()
    settleText()
  }
}

/** Changes saved and in the snapshot (or failed): the player shows the engine's own drawing again. */
function settleText() {
  const snap = getState().snap
  for (const [id, j] of textJobs) {
    if (j.running || Object.keys(j.pending).length) continue
    const clip = findClip(snap, id)?.clip
    if (j.failed || !clip?.text || !j.png || clip.text.png === j.png) {
      textJobs.delete(id)
      setEditLook(id, null)
    }
  }
}
subscribeStore(() => textJobs.size && settleText())

/** Sends every text change waiting, now; resolves once the engine has them (undefined if none wait). */
export function flushText(): Promise<unknown> | undefined {
  const busy = [...textJobs.values()].filter((j) => j.running || Object.keys(j.pending).length)
  if (!busy.length) return undefined
  return Promise.all(
    busy.map((j) => {
      j.hurry = true
      j.wake?.()
      return new Promise<void>((res) => j.done.push(res))
    }),
  )
}
// Play waits for them, so the picture plays with the new look.
setBeforePlay(flushText)

/** Shows a look on many text clips at once (captions.ts: every line of a track); see liveText.ts. */
export { previewTextLook }

// Brand kit (project.setOptions brand, saved in the project)

export const DEFAULT_BRAND = { colors: ['#FFFFFF', '#111114', '#E8C050', '#3B57F0', '#2E5E4E'], fonts: ['Bricolage Grotesque', 'IBM Plex Sans'] }

export function brandOf(p: Project | undefined | null) {
  const b = p?.brand
  return { colors: b?.colors?.length ? b.colors : DEFAULT_BRAND.colors, fonts: b?.fonts?.length ? b.fonts : DEFAULT_BRAND.fonts }
}

function setBrand(patch: Partial<{ colors: string[]; fonts: string[] }>) {
  const now = brandOf(getState().snap?.project)
  return call('project.setOptions', { brand: { ...now, ...patch } })
}

export function addBrandColour(hex: string) {
  const c = hex.toUpperCase()
  const { colors } = brandOf(getState().snap?.project)
  if (!/^#[0-9A-F]{6}$/.test(c) || colors.includes(c)) return
  return setBrand({ colors: [...colors, c].slice(0, 12) })
}
export function removeBrandColour(hex: string) {
  const { colors } = brandOf(getState().snap?.project)
  return setBrand({ colors: colors.filter((x) => x !== hex) })
}
/** Brand fonts: [0] titles, [1] captions. */
export function setBrandFont(i: number, family: string) {
  const fonts = [...brandOf(getState().snap?.project).fonts]
  fonts[i] = family
  return setBrand({ fonts })
}

// Looks, effects and adjustment layers

/** The selected clips that have a picture (video, images, stickers, text, adjustment layers). */
export function selectedPictureIds(): string[] {
  const s = getState()
  return s.selection.filter((id) => {
    const c = findClip(s.snap, id)?.clip
    if (!c) return false
    if (isText(c) || !c.mediaId) return true
    return mediaById(s.snap, c.mediaId)?.kind !== 'audio'
  })
}

export async function applyLook(look: Look) {
  const ids = selectedPictureIds()
  if (!ids.length) return toast(`Select the clips (or an adjustment layer) to give the ${look.name} look.`, 'error')
  await call('clip.set', { clipIds: ids, ...look.values, label: `Look: ${look.name}` })
}

/** Saves a clip's colour settings as a look (kept in the app's settings). */
export async function saveLook(clip: Clip, name: string) {
  const saved = await saveLookAs(name, lookOf(clip))
  toast(`Saved “${saved}”. It’s in Library › Effects › Looks.`)
}

/** An adjustment layer at the playhead on its own track; its look applies to everything below. */
export async function addAdjustmentLayer() {
  if (!getState().snap) return
  const r = await call<{ clipId: string; trackId: string }>('adjust.add', { atUs: getState().positionUs })
  if (!r) return
  setState({ selection: [r.clipId], focus: 'timeline' })
  setUi('insp.tab', 'adjust')
}

/** Adds an effect to the selected clips, or takes it off if they all have it. */
export async function toggleEffect(name: string) {
  const s = getState()
  const ids = selectedPictureIds()
  if (!ids.length) return toast(`Select the clips to add ${name} to, or add an adjustment layer first.`, 'error')
  const clips = ids.map((id) => findClip(s.snap, id)!.clip)
  const all = clips.every((c) => c.effects?.some((e) => e.name === name))
  for (const c of clips) {
    const list = (c.effects ?? []).filter((e) => e.name !== name)
    await call('clip.set', { clipId: c.id, effects: all ? list : [...list, { name, amount: 60 }], label: all ? `Remove ${name}` : `Add ${name}` })
  }
}

// Transitions

/** "This cut": the cut into a selected main-track clip, else the first cut at or after the playhead (else the last). */
export function cutTarget(): Clip | null {
  const s = getState()
  const main = [...(s.snap?.project.tracks.find((t) => t.main)?.clips ?? [])].sort((a, b) => a.startUs - b.startUs)
  if (main.length < 2) return null
  if (s.selection.length === 1) {
    const i = main.findIndex((c) => c.id === s.selection[0])
    if (i > 0) return main[i]
  }
  const half = 500_000 / (s.snap?.project.fps || 30)
  return main.slice(1).find((c) => c.startUs >= s.positionUs - half) ?? main[main.length - 1]
}

/** A transition on this cut or every cut (`name` null takes it off), `seconds` long. */
export async function addTransition(name: string | null, seconds: number, where: 'This cut' | 'All cuts') {
  const durationUs = Math.round(seconds * 1e6)
  if (where === 'All cuts') {
    if (!getState().snap?.project.tracks.find((t) => t.main)?.clips.length) return toast('Put clips on the main track first.', 'error')
    return call('transition.setAll', { name, durationUs })
  }
  const clip = cutTarget()
  if (!clip) return toast('There is no cut yet: the main track needs two clips.', 'error')
  await call('transition.set', { clipId: clip.id, name, durationUs })
}

// Tracking (Inspector › Text › Tracking)

export const trackObject = (clipId: string) => findTrackTargets(clipId)

// MCP (History › Connection)

export function setMcp(patch: Partial<{ allowed: 'all' | 'edit' | 'look'; askBeforeExport: boolean }>) {
  const now = getState().snap?.project.mcp ?? { allowed: 'all' as const, askBeforeExport: true }
  return call('project.setOptions', { mcp: { ...now, ...patch } })
}
