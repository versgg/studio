// Text drawn live in the player. While a text clip or a caption line is selected and the
// timeline is paused, the player draws it itself, on a canvas over the engine's frame, with
// textRender's own drawing code at the clip's place, size, turn and opacity, so a change to
// its look, its words or its place shows on the next frame. Meanwhile the engine leaves those
// clips out of its paused frames (`preview.hide`), so nothing is drawn twice.
//
// The canvas only ever draws what the frame on screen leaves out: a clip joins once the
// engine has shown a frame without it, and leaves once it has shown one with it again. A
// clip leaves only when its changes are saved (updateText, libraryActions.ts) and in the
// snapshot, so the old look never flashes. Captions are hidden by track: setting the lines
// again gives every line a new id.

import { getState, subscribeStore, type Clip, type Project, type Us } from './store'
import { fontOf, layoutText, paintText, textPlaceOf, type TextLayout, type TextLook } from './textRender'
import { loadFont } from './textFonts'

export type Place = { posX: number; posY: number; scale: number; rotation: number }

/** The value of a setting at clip time t: its keyframes if it has any, else its own value. */
export function valueAt(clip: Clip, key: string, own: number, t: Us): number {
  const pts = clip.keyframes?.[key]
  if (!pts?.length) return own
  if (t <= pts[0].atUs) return pts[0].value
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].atUs) {
      const a = pts[i - 1]
      const b = pts[i]
      return a.value + ((b.value - a.value) * (t - a.atUs)) / Math.max(1, b.atUs - a.atUs)
    }
  }
  return pts[pts.length - 1].value
}

/** A clip's place, size and turn at timeline time `t` (as fitted when its transform is off), and its opacity 0–1. */
export function placeAt(clip: Clip, t: Us): Place & { opacity: number } {
  if (clip.transformOn === false) return { posX: 0, posY: 0, scale: 100, rotation: 0, opacity: 1 }
  const rel = t - clip.startUs
  return {
    posX: valueAt(clip, 'posX', clip.posX ?? 0, rel),
    posY: valueAt(clip, 'posY', clip.posY ?? 0, rel),
    scale: valueAt(clip, 'scale', clip.scale ?? 100, rel),
    rotation: valueAt(clip, 'rotation', clip.rotation ?? 0, rel),
    opacity: Math.min(1, Math.max(0, valueAt(clip, 'opacity', clip.opacity ?? 100, rel) / 100)),
  }
}

/**
 * Project pixels to the player's pixels (`k` per project pixel), as the engine places an
 * overlay: its drawing (the whole frame) sized and turned about its middle, then moved.
 */
export function frameMatrix(p: { width: number; height: number }, place: Place, k: number): DOMMatrix {
  return new DOMMatrix()
    .translateSelf((p.width / 2 + place.posX) * k, (p.height / 2 + place.posY) * k)
    .rotateSelf(place.rotation)
    .scaleSelf((place.scale / 100) * k)
    .translateSelf(-p.width / 2, -p.height / 2)
}

const COLOUR = ['temperature', 'tint', 'saturation', 'brightness', 'contrast', 'highlights', 'shadows', 'sharpen', 'vignette'] as const
const shows = (t: Us, c: Clip) => t >= c.startUs && t < c.startUs + c.durationUs

/**
 * Whether the player can draw a text clip at `t` the way the engine does: its look is the
 * drawing at a place, size, turn and opacity. Effects, colour, masks, blends and a moving
 * animation are the engine's alone; those clips stay in its frames.
 */
export function drawsLive(c: Clip, t: Us): boolean {
  if (!c.text || !c.text.png) return false
  if (c.effects?.length || c.mask || c.maskPng || c.matte || c.lut || (c.blend && c.blend !== 'normal')) return false
  if (c.flip || c.flipV || c.crop || (c.rotate ?? 0) % 360) return false
  if (Object.keys(c.curves ?? {}).length || Object.keys(c.wheels ?? {}).length) return false
  if (Object.values(c.hsl ?? {}).some((x) => x.h || x.s || x.l)) return false
  if (COLOUR.some((k) => (c[k] ?? 0) !== 0 || c.keyframes?.[k]?.length)) return false
  const rel = t - c.startUs
  const a = c.anim
  if (a?.loop || (a?.in && rel < a.in.durationUs) || (a?.out && rel >= c.durationUs - a.out.durationUs)) return false
  return true
}

// Looks and places shown before the engine has them

/** Changes being saved by updateText, per clip. */
const edits = new Map<string, Partial<TextLook>>()
/** Looks shown ahead for many clips at once (previewTextLook), each call with its own number. */
const ahead = new Map<string, { patch: Partial<TextLook>; n: number; end?: { revision: number; at: number } }>()
/** Places from a drag on the player. */
const places = new Map<string, Place>()
let aheadCalls = 0

// The player's boxes follow these too (a bigger size is a bigger box): React reads them through
// `useSyncExternalStore(subscribeLive, liveVersion)`.
const listeners = new Set<() => void>()
let version = 0
export const liveVersion = () => version
export function subscribeLive(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function bump() {
  version++
  for (const l of listeners) l()
}

/** A text clip's look as the player shows it: the snapshot's, with what the engine hasn't got yet. */
export function lookOf(clip: Clip): TextLook {
  const a = ahead.get(clip.id)?.patch
  const e = edits.get(clip.id)
  return (a || e ? { ...clip.text, ...a, ...e } : clip.text) as TextLook
}

/** updateText's changes to a clip while they're being saved; null once the snapshot has them. */
export function setEditLook(clipId: string, look: Partial<TextLook> | null) {
  if (look) edits.set(clipId, look)
  else edits.delete(clipId)
  bump()
  changed()
}

/** A drag's place for a clip (null when it's over). */
export function setLivePlace(clipId: string, place: Place | null) {
  if (place) places.set(clipId, place)
  else places.delete(clipId)
  bump()
  changed()
}

/**
 * Shows `patch` on these clips' text in the player at once, before the engine has their new
 * drawings: for a change made to many clips together (every caption line of a track). A
 * selected caption line's track is already drawn live, so it shows on the next frame.
 *
 * It ends by itself when the clips leave the snapshot (`captions.set` gives every line a new
 * id). Call the function it returns when the change is done or has failed: it then ends
 * with the next snapshot, or within a second if none comes.
 */
export function previewTextLook(clipIds: string[], patch: Partial<TextLook>): () => void {
  const n = ++aheadCalls
  for (const id of clipIds) ahead.set(id, { patch: { ...ahead.get(id)?.patch, ...patch }, n })
  bump()
  changed()
  return () => {
    const end = { revision: getState().snap?.revision ?? 0, at: performance.now() + 1000 }
    for (const id of clipIds) {
      const a = ahead.get(id)
      if (a?.n === n) a.end = end
    }
    window.setTimeout(changed, 1050)
  }
}

/** Looks shown ahead end with their clips, or once they're done and a newer snapshot came. */
function endAhead() {
  const snap = getState().snap
  if (!ahead.size) return
  const ids = new Set(snap?.project.tracks.flatMap((t) => t.clips.map((c) => c.id)))
  const now = performance.now()
  const n = ahead.size
  for (const [id, a] of ahead) if (!ids.has(id) || (a.end && ((snap?.revision ?? 0) > a.end.revision || now > a.end.at))) ahead.delete(id)
  if (ahead.size !== n) bump()
}

// What the engine leaves out

interface Out {
  clips: string[]
  tracks: string[]
}
const NONE: Out = { clips: [], tracks: [] }
const same = (a: Out, b: Out) => a.clips.join() === b.clips.join() && a.tracks.join() === b.tracks.join()

/** Text the player should draw now: selected, or being changed, at the playhead, while paused. */
function wanted(): Out {
  const s = getState()
  const p = s.snap?.project
  if (!p || !canvas || s.playing || s.source || s.page !== 'edit' || s.link !== 'connected') return NONE
  const t = s.positionUs
  const sel = new Set(s.selection)
  const busy = (c: Clip) => sel.has(c.id) || edits.has(c.id) || ahead.has(c.id) || places.has(c.id)
  const out: Out = { clips: [], tracks: [] }
  for (const track of p.tracks) {
    if (track.main || track.kind !== 'video' || track.hidden) continue
    const here = track.clips.filter((c) => c.text && shows(t, c))
    if (track.role === 'captions') {
      // The whole track, while one of its lines is selected or changing (the look is shared).
      if (here.length && here.every((c) => drawsLive(c, t)) && track.clips.some(busy)) out.tracks.push(track.id)
      continue
    }
    for (const c of here) if (busy(c) && drawsLive(c, t)) out.clips.push(c.id)
  }
  out.clips.sort()
  out.tracks.sort()
  return out
}

/** The last list sent and whether one is on its way; frames asked for, with what they leave out. */
let sent: Out = NONE
let sending = false
let again = false
/** Goes up when play starts (the engine's list is cleared): an answer from before is stale. */
let epoch = 0
const asked: { ticket: number; out: Out }[] = []
let lastShown = 0
/** What the frame on screen leaves out (the canvas draws exactly these), and its time. */
let onScreen: Out = NONE
let screenAt: Us | null = null
/** Where `onScreen` is going, and a number for each change on its way (an older one never lands after a newer). */
let screenNext: Out = NONE
let screenSeq = 0

function reconcile() {
  const s = getState()
  if (s.playing || s.source || s.link !== 'connected') {
    // Playing, the engine draws everything (play clears its list); a library clip has no text.
    if (sent !== NONE || onScreen !== NONE || sending) {
      epoch++
      screenSeq++
      sent = NONE
      onScreen = NONE
      screenNext = NONE
      screenAt = null
      asked.length = 0
      redraw()
    }
    return
  }
  const w = wanted()
  if (same(w, sent)) return
  if (sending) {
    again = true
    return
  }
  sending = true
  const e = epoch
  window.studio.engine
    .call('preview.hide', { clipIds: w.clips, trackIds: w.tracks })
    .then((r: { ticket: number | null }) => {
      if (e !== epoch) return
      if (r?.ticket == null) {
        sent = NONE
        return
      }
      sent = w
      asked.push({ ticket: r.ticket, out: w })
      settle()
    })
    .catch(() => {})
    .finally(() => {
      sending = false
      if (again) {
        again = false
        reconcile()
      }
    })
}

/** A frame is in the ring: the canvas takes on what it leaves out, in step with it. */
function settle() {
  let i = -1
  for (let j = 0; j < asked.length; j++) if (asked[j].ticket <= lastShown) i = j
  if (i < 0) return
  const next = asked[i].out
  asked.splice(0, i + 1)
  if (same(next, screenNext)) return
  screenNext = next
  // Joining shows with the frame that leaves it out; leaving waits a frame more, so the
  // engine's picture is up before the canvas lets go.
  const leaves = onScreen.clips.some((id) => !next.clips.includes(id)) || onScreen.tracks.some((id) => !next.tracks.includes(id))
  const seq = ++screenSeq
  requestAnimationFrame(() => {
    const go = () => {
      if (seq !== screenSeq) return
      onScreen = next
      paint()
    }
    if (leaves) requestAnimationFrame(go)
    else go()
  })
}

function onEngineEvent(method: string, params: { ticket?: number; positionUs?: Us }) {
  if (method !== 'preview.shown' || params.ticket == null) return
  lastShown = Math.max(lastShown, params.ticket)
  screenAt = params.positionUs ?? null
  settle()
}

// The canvas

let canvas: HTMLCanvasElement | null = null
let scratch: HTMLCanvasElement | null = null
let raf = 0
let started = false
/** The canvas has nothing on it. */
let blank = true
/** For the UI check: when the canvas last drew, how often, and what. */
const stats = { paints: 0, lastPaint: 0, drawn: [] as string[] }
/** The last look drawn per clip, kept while a new font loads (canvas would use a fallback). */
const lastLook = new Map<string, TextLook>()

/** The player's live canvas (null when it goes). */
export function attachLiveCanvas(el: HTMLCanvasElement | null) {
  canvas = el
  if (!started && el) {
    started = true
    let last = getState()
    subscribeStore(() => {
      const s = getState()
      const moved = s.snap !== last.snap || s.positionUs !== last.positionUs || s.selection !== last.selection || s.playing !== last.playing || s.source !== last.source || s.page !== last.page || s.link !== last.link
      last = s
      // Playing, there's nothing to draw: the playhead moving needs nothing done.
      if (moved && !(s.playing && blank && sent === NONE)) changed()
    })
    window.studio.engine.onEvent(onEngineEvent)
    ;(window as unknown as { __studioLive: object }).__studioLive = { stats, onScreen: () => onScreen, sent: () => sent }
  }
  changed()
}

/** Something the canvas or the engine's list depends on changed. */
function changed() {
  endAhead()
  reconcile()
  redraw()
}

/** Draws the canvas on the next frame (once, however many changes come before it). */
export function redraw() {
  if (!raf) raf = requestAnimationFrame(paint)
}

function paint() {
  cancelAnimationFrame(raf)
  raf = 0
  const cv = canvas
  if (!cv) return
  const s = getState()
  const p = s.snap?.project
  const dpr = window.devicePixelRatio || 1
  const cw = Math.max(1, Math.round(cv.clientWidth * dpr))
  const ch = Math.max(1, Math.round(cv.clientHeight * dpr))
  if (cv.width !== cw || cv.height !== ch) {
    cv.width = cw
    cv.height = ch
  }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cw, ch)
  stats.drawn = []
  blank = true
  if (!p || s.playing || s.source || (!onScreen.clips.length && !onScreen.tracks.length)) return
  const k = cw / p.width
  const t = screenAt ?? s.positionUs
  for (const track of p.tracks) {
    if (track.main || track.hidden) continue
    const whole = onScreen.tracks.includes(track.id)
    for (const c of track.clips) {
      if (!c.text || !(whole || onScreen.clips.includes(c.id)) || !shows(t, c)) continue
      drawClip(ctx, c, p, t, k, cw, ch)
      stats.drawn.push(c.id)
      blank = false
    }
  }
  stats.paints++
  stats.lastPaint = performance.now()
}

/** The text a clip draws, laid out in the project's frame (laid out again once its font is in). */
export function layoutOf(c: Clip, p: Project, look = lookOf(c)): TextLayout {
  const f = fontOf(look)
  if (!f.ready) loadFont(look.font, f.weight, !!look.italic, look.content.slice(0, 40) || 'A').then(() => (bump(), redraw()))
  return layoutText(look, p.width, p.height, textPlaceOf(c, p.width))
}

function drawClip(ctx: CanvasRenderingContext2D, c: Clip, p: Project, t: Us, k: number, cw: number, ch: number) {
  const want = lookOf(c)
  const f = fontOf(want)
  if (f.ready) lastLook.set(c.id, want)
  else loadFont(want.font, f.weight, !!want.italic, want.content.slice(0, 40) || 'A').then(() => (bump(), redraw()))
  const look = f.ready ? want : (lastLook.get(c.id) ?? want)
  const place = { ...placeAt(c, t), ...places.get(c.id) }
  const layout = layoutOf(c, p, look)
  const m = frameMatrix(p, place, k)
  if (place.opacity >= 1) {
    ctx.setTransform(m)
    paintText(ctx, layout)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return
  }
  // Opacity applies to the drawing as a whole (as the engine fades the PNG), not to each part.
  scratch ??= document.createElement('canvas')
  if (scratch.width !== cw || scratch.height !== ch) {
    scratch.width = cw
    scratch.height = ch
  }
  const sc = scratch.getContext('2d')!
  sc.setTransform(1, 0, 0, 1, 0, 0)
  sc.clearRect(0, 0, cw, ch)
  sc.setTransform(m)
  paintText(sc, layout)
  ctx.globalAlpha = place.opacity
  ctx.drawImage(scratch, 0, 0)
  ctx.globalAlpha = 1
}
