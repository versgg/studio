// Picture analysis for the Inspector, with MediaPipe in a worker (vision.worker.ts):
// - Remove background: a grey matte video of the clip (white = keep), made frame by frame,
//   encoded by FFmpeg in the main process, then `clip.set { matte }`.
// - Auto reframe: a face or an object followed through the clip, turned into posX/posY
//   (and if needed scale) keyframes, so it stays in frame for the project's format.
// - Tracking: a text clip follows something in the main-track clip under it.
// Frames come from the main process (FFmpeg decodes them small); progress shows in the
// title bar's task pill.

import { call, endTask, findClip, getState, mediaById, patchTask, startTask, toast, type Clip, type Media, type Track, type Us } from './store'

// The worker

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }
let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, Pending>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if (e.data.error) p.reject(new Error(e.data.error))
    else p.resolve(e.data.result)
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The analysis worker stopped.'))
    pending.clear()
    worker = null
  }
  ask({ type: 'init', base: new URL('./mediapipe', document.baseURI).href })
  return worker
}

function ask<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const w = worker ?? getWorker()
  const id = ++nextId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...msg, id }, transfer)
  })
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
  label: string
}

const fail = (r: unknown): r is { error: string } => !!r && typeof r === 'object' && 'error' in r

/** Calls `each` with every frame of a stretch of a file (source time), decoded `width` wide. */
async function frames(media: Media, startUs: Us, durationUs: Us, fps: number, width: number, each: (rgba: Uint8Array, w: number, h: number, i: number, tUs: Us) => Promise<void> | void) {
  const src = await window.studio.files.openFrames({ path: media.path, startUs, durationUs, fps, width })
  if (fail(src)) throw new Error(src.error)
  try {
    for (let i = 0; ; i++) {
      const r = await window.studio.files.nextFrame(src.id)
      if (fail(r)) throw new Error(r.error)
      if (!r.frame) return src
      // A frame of its own (the worker takes its buffer).
      const f = r.frame.byteOffset === 0 && r.frame.byteLength === r.frame.buffer.byteLength ? r.frame : r.frame.slice()
      await each(f, src.width, src.height, i, startUs + Math.round((i * 1e6) / src.fps))
    }
  } finally {
    window.studio.files.closeFrames(src.id)
  }
}

/** The clip's stretch of its source file. */
const sourceRange = (clip: Clip, media: Media) => {
  const len = media.kind === 'image' ? 1_000_000 : Math.round(clip.durationUs * (clip.speed ?? 1))
  return { startUs: media.kind === 'image' ? 0 : clip.inUs, durationUs: Math.max(40_000, len) }
}

function projectFile(...parts: string[]) {
  const dir = getState().snap?.dir ?? ''
  const sep = dir.includes('\\') ? '\\' : '/'
  return [dir, ...parts].join(sep)
}

// Remove background

export type MatteMethod = 'person' | 'subject'
const MATTE_NAME = /[\\/]([^\\/]+)-(person|subject)-([a-z0-9]+)-e(\d+)\.mp4$/i

/** What a clip's matte was made with (read from its file name). */
export function matteInfo(clip: Clip): { method: MatteMethod; edge: number; raw: string } | null {
  const p = clip.matte?.path
  const m = p ? MATTE_NAME.exec(p) : null
  if (!p || !m) return null
  return { method: m[2].toLowerCase() as MatteMethod, edge: Number(m[4]), raw: p.replace(/-e\d+\.mp4$/i, '-raw.mp4') }
}

const busy = new Set<string>()

/** Makes a matte for the clip with `method`, and sets it on the clip. */
export async function removeBackground(clipId: string, method: MatteMethod, edge: number) {
  const snap = getState().snap
  const found = findClip(snap, clipId)
  const media = found && mediaById(snap, found.clip.mediaId)
  if (!found || !media) return
  if (media.kind === 'audio') return toast('That clip has no picture.', 'error')
  if (busy.has(clipId)) return toast('Already removing the background of this clip.')
  busy.add(clipId)
  const { clip } = found
  const label = media.name.replace(/\.[^.]+$/, '')
  const task = startTask(`Removing the background: ${label}`, 'matte', clipId)
  const stamp = Date.now().toString(36)
  const stem = `${clip.id}-${method}-${stamp}`
  const raw = projectFile('mattes', `${stem}-raw.mp4`)
  const range = sourceRange(clip, media)
  let writer: string | null = null
  try {
    patchTask(task, { stage: method === 'person' ? 'Finding the person' : 'Finding the subject', fraction: 0.01 })
    const fps = Math.min(30, media.fps || 30)
    const total = Math.max(1, Math.ceil((range.durationUs / 1e6) * fps))
    let point = { x: 0.5, y: 0.5 }
    let size: [number, number] = [0, 0]
    await frames(media, range.startUs, range.durationUs, fps, 384, async (rgba, w, h, i) => {
      if (!writer) {
        const r = await window.studio.files.openMatte({ raw, width: w, height: h, fps })
        if (fail(r)) throw new Error(r.error)
        writer = r.id
        size = [w, h]
      }
      const out = await ask<{ grey: Uint8Array; centre: { x: number; y: number } | null; area: number }>({ type: 'segment', method, width: w, height: h, rgba: rgba.buffer, point }, [rgba.buffer as ArrayBuffer])
      // The subject's centre leads the next frame's point (it follows the subject as it moves).
      if (method === 'subject' && out.centre && out.area > 0.002) point = out.centre
      const r = await window.studio.files.writeMatte(writer, out.grey)
      if (fail(r)) throw new Error(r.error)
      if (i % 5 === 0) patchTask(task, { stage: `Frame ${i + 1} of ${total}`, fraction: Math.min(0.9, 0.02 + (0.88 * (i + 1)) / total) })
    })
    if (!writer || !size[0]) throw new Error('No frames came out of that clip.')
    const closed = await window.studio.files.closeMatte(writer)
    writer = null
    if (fail(closed)) throw new Error(closed.error)
    patchTask(task, { stage: 'Making the matte', fraction: 0.93 })
    const matte = await finish(raw, stem, edge, media, range.startUs, media.kind === 'image' ? clip.durationUs : 0)
    await call('clip.set', { clipId: clip.id, matte: { path: matte }, label: 'Remove background' })
    endTask(task)
  } catch (e) {
    if (writer) await window.studio.files.closeMatte(writer, true)
    endTask(task, `Background removal failed: ${(e as Error).message}`)
  } finally {
    busy.delete(clipId)
  }
}

async function finish(raw: string, stem: string, edge: number, media: Media, startUs: Us, holdUs: Us) {
  const out = projectFile('mattes', `${stem}-e${Math.round(edge)}.mp4`)
  const r = await window.studio.files.finishMatte({ raw, out, width: media.width, height: media.height, startUs, edge: Math.round(edge), holdUs })
  if (fail(r)) throw new Error(r.error)
  return r.out
}

/** A new edge softness: the matte is made again from the raw one (no new analysis). */
export async function setMatteEdge(clipId: string, edge: number) {
  const snap = getState().snap
  const found = findClip(snap, clipId)
  const media = found && mediaById(snap, found.clip.mediaId)
  const info = found && matteInfo(found.clip)
  if (!found || !media || !info) return
  if (!(await window.studio.files.exists(info.raw))) return removeBackground(clipId, info.method, edge)
  const stem = (/[\\/]([^\\/]+)-raw\.mp4$/i.exec(info.raw) ?? [])[1] ?? `${clipId}-${info.method}-${Date.now().toString(36)}`
  try {
    const out = await finish(info.raw, stem, edge, media, sourceRange(found.clip, media).startUs, media.kind === 'image' ? found.clip.durationUs : 0)
    await call('clip.set', { clipId, matte: { path: out }, label: 'Background edge' })
  } catch (e) {
    toast(`Couldn’t change the edge: ${(e as Error).message}`, 'error')
  }
}

// Following a face or an object

type Follow = 'face' | 'object'
interface PathPoint {
  /** Source time. */
  t: Us
  /** The subject's centre and size, in fractions of the source frame (null: not seen). */
  box: Box | null
}

/** Detects in sampled frames and follows one subject: the biggest, then whichever is nearest. */
async function followPath(media: Media, startUs: Us, durationUs: Us, kind: Follow, label: string | null, onProgress: (f: number) => void): Promise<PathPoint[]> {
  const fps = 6
  const total = Math.max(1, Math.ceil((durationUs / 1e6) * fps))
  const out: PathPoint[] = []
  let last: Box | null = null
  await frames(media, startUs, durationUs, fps, 320, async (rgba, w, h, i, t) => {
    const found = await ask<Box[]>({ type: 'detect', kind, width: w, height: h, rgba: rgba.buffer }, [rgba.buffer as ArrayBuffer])
    let list = label ? found.filter((b) => b.label === label) : found
    if (kind === 'object' && !label && list.some((b) => b.label !== 'person')) list = list.filter((b) => b.label !== 'person')
    let pick: Box | null = null
    if (list.length) {
      if (last) {
        const d = (b: Box) => Math.hypot(b.x + b.w / 2 - (last!.x + last!.w / 2), b.y + b.h / 2 - (last!.y + last!.h / 2))
        pick = list.reduce((a, b) => (d(b) < d(a) ? b : a))
        if (d(pick) > 0.3) pick = list.reduce((a, b) => (b.w * b.h * b.score > a.w * a.h * a.score ? b : a))
      } else pick = list.reduce((a, b) => (b.w * b.h * b.score > a.w * a.h * a.score ? b : a))
    }
    if (pick) last = pick
    out.push({ t, box: pick })
    onProgress((i + 1) / total)
  })
  return out
}

/** Fills gaps (holds the nearest seen box) and smooths the centre with a moving average. */
function smoothPath(path: PathPoint[], windowUs: Us): { t: Us; cx: number; cy: number; size: number }[] {
  const seen = path.filter((p) => p.box)
  if (!seen.length) return []
  const filled = path.map((p) => {
    if (p.box) return { t: p.t, b: p.box }
    const near = seen.reduce((a, b) => (Math.abs(b.t - p.t) < Math.abs(a.t - p.t) ? b : a))
    return { t: p.t, b: near.box! }
  })
  return filled.map((p) => {
    const win = filled.filter((q) => Math.abs(q.t - p.t) <= windowUs)
    const avg = (f: (b: Box) => number) => win.reduce((s, q) => s + f(q.b), 0) / win.length
    return { t: p.t, cx: avg((b) => b.x + b.w / 2), cy: avg((b) => b.y + b.h / 2), size: avg((b) => b.h) }
  })
}

/** Keeps the points that matter (Ramer–Douglas–Peucker on each value). */
function simplify<T extends { t: number }>(pts: T[], value: (p: T) => number, tolerance: number): T[] {
  if (pts.length <= 2) return pts
  const keep = new Set([0, pts.length - 1])
  const walk = (a: number, b: number) => {
    let worst = -1
    let dist = tolerance
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].t - pts[a].t) / Math.max(1, pts[b].t - pts[a].t)
      const d = Math.abs(value(pts[i]) - (value(pts[a]) + f * (value(pts[b]) - value(pts[a]))))
      if (d > dist) {
        dist = d
        worst = i
      }
    }
    if (worst > 0) {
      keep.add(worst)
      walk(a, worst)
      walk(worst, b)
    }
  }
  walk(0, pts.length - 1)
  return pts.filter((_, i) => keep.has(i))
}

/** How a main-track clip's picture sits in the frame: shown size and the visible part of the source. */
function placement(clip: Clip, media: Media, scale = clip.scale ?? 100) {
  const p = getState().snap!.project
  const c = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const turned = (clip.rotate ?? 0) % 180 === 90
  let sw = media.width * c.w
  let sh = media.height * c.h
  if (turned) [sw, sh] = [sh, sw]
  const s = (clip.fit === 'fit' ? Math.min(p.width / sw, p.height / sh) : Math.max(p.width / sw, p.height / sh)) * (scale / 100)
  return { W: p.width, H: p.height, dw: sw * s, dh: sh * s, crop: c }
}

const keysOf = (clip: Clip) => ({ ...(clip.keyframes ?? {}) }) as Record<string, { atUs: Us; value: number; ease?: string }[]>

/** Reframe results this session, so Movement can change without a new analysis. */
const reframed = new Map<string, { follow: Follow; path: PathPoint[] }>()
export const wasReframed = (clipId: string) => reframed.get(clipId)?.follow ?? null

/**
 * Auto reframe: follows a face or an object and keyframes posX/posY so it stays in frame for
 * the project's format. Smooth moves slowly (a 1.6 s average); Snappy keeps up (0.4 s).
 */
export async function autoReframe(clipId: string, follow: Follow, movement: 'Smooth' | 'Snappy') {
  const snap = getState().snap
  const found = findClip(snap, clipId)
  const media = found && mediaById(snap, found.clip.mediaId)
  if (!found || !media || media.kind === 'audio') return
  let cached = reframed.get(clipId)
  if (!cached || cached.follow !== follow) {
    if (busy.has(clipId)) return toast('Already working on this clip.')
    busy.add(clipId)
    const task = startTask(`Auto reframe: ${media.name.replace(/\.[^.]+$/, '')}`, 'reframe', clipId)
    try {
      patchTask(task, { stage: follow === 'face' ? 'Finding faces' : 'Finding the subject', fraction: 0.02 })
      const range = sourceRange(found.clip, media)
      const path = await followPath(media, range.startUs, range.durationUs, follow, null, (f) => patchTask(task, { fraction: 0.02 + 0.9 * f, stage: `${Math.round(f * 100)} %` }))
      if (!path.some((p) => p.box)) throw new Error(follow === 'face' ? 'No face was found in this clip. Try Object.' : 'Nothing to follow was found in this clip. Try Face.')
      cached = { follow, path }
      reframed.set(clipId, cached)
      endTask(task)
    } catch (e) {
      endTask(task, `Auto reframe failed: ${(e as Error).message}`)
      return
    } finally {
      busy.delete(clipId)
    }
  }
  await applyReframe(clipId, cached.path, movement)
}

async function applyReframe(clipId: string, path: PathPoint[], movement: 'Smooth' | 'Snappy') {
  const snap = getState().snap
  const found = findClip(snap, clipId)
  const media = found && mediaById(snap, found.clip.mediaId)
  if (!found || !media) return
  const clip = found.clip
  const smooth = smoothPath(path, movement === 'Smooth' ? 800_000 : 200_000)
  // Room to move: if the picture barely overflows the frame, zoom in a little to make some.
  let scale = clip.scale ?? 100
  let pl = placement(clip, media, scale)
  if (pl.dw - pl.W < pl.W * 0.08 && pl.dh - pl.H < pl.H * 0.08) {
    scale = Math.round(scale * 1.3)
    pl = placement(clip, media, scale)
  }
  const rx = Math.max(0, (pl.dw - pl.W) / 2)
  const ry = Math.max(0, (pl.dh - pl.H) / 2)
  const speed = clip.speed ?? 1
  const at = (t: Us) => Math.max(0, Math.min(clip.durationUs, Math.round((t - clip.inUs) / speed)))
  const flipX = clip.flip ? -1 : 1
  const pts = smooth.map((s) => {
    const u = (s.cx - pl.crop.x) / pl.crop.w
    const v = (s.cy - pl.crop.y) / pl.crop.h
    return { t: media.kind === 'image' ? 0 : at(s.t), x: Math.round(Math.max(-rx, Math.min(rx, -(u - 0.5) * pl.dw * flipX))), y: Math.round(Math.max(-ry, Math.min(ry, -(v - 0.5) * pl.dh))) }
  })
  const keys = keysOf(clip)
  const tol = movement === 'Smooth' ? 6 : 3
  if (rx > 1) keys.posX = simplify(pts, (p) => p.x, tol).map((p) => ({ atUs: p.t, value: p.x }))
  else delete keys.posX
  if (ry > 1) keys.posY = simplify(pts, (p) => p.y, tol).map((p) => ({ atUs: p.t, value: p.y }))
  else delete keys.posY
  if (keys.scale) delete keys.scale
  await call('clip.set', { clipId, keyframes: keys, posX: keys.posX?.[0]?.value ?? 0, posY: keys.posY?.[0]?.value ?? 0, scale, label: 'Auto reframe' })
}

/** Movement changed after a reframe this session: smooth the same path again. */
export async function reSmooth(clipId: string, movement: 'Smooth' | 'Snappy') {
  const c = reframed.get(clipId)
  if (c) await applyReframe(clipId, c.path, movement)
}

/** Takes the reframe out: position keyframes gone, position and scale back to normal. */
export async function resetReframe(clip: Clip) {
  reframed.delete(clip.id)
  const keys = keysOf(clip)
  delete keys.posX
  delete keys.posY
  await call('clip.set', { clipId: clip.id, keyframes: keys, posX: 0, posY: 0, scale: 100, label: 'Reset reframe' })
}

// Tracking: a text (or sticker) clip follows something in the main-track picture under it.

interface Segment {
  clip: Clip
  media: Media
  /** Timeline stretch of this main clip under the followed clip. */
  from: Us
  to: Us
}

const tracked = new Map<string, { segments: Segment[]; paths: Map<string, { t: Us; box: Box | null; seg: number }[]>; counts: Map<string, number> }>()

function segmentsUnder(clip: Clip, tracks: Track[]): Segment[] {
  const main = tracks.find((t) => t.main)
  const snap = getState().snap
  const a = clip.startUs
  const b = clip.startUs + clip.durationUs
  return (main?.clips ?? [])
    .filter((c) => c.startUs < b && c.startUs + c.durationUs > a)
    .flatMap((c) => {
      const media = mediaById(snap, c.mediaId)
      return media && media.kind !== 'audio' ? [{ clip: c, media, from: Math.max(a, c.startUs), to: Math.min(b, c.startUs + c.durationUs) }] : []
    })
}

/** What can be followed under this clip: kinds of thing seen, most often first. */
export function trackTargets(clipId: string): { label: string; seen: number }[] {
  const t = tracked.get(clipId)
  if (!t) return []
  return [...t.counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, seen]) => ({ label, seen }))
}

/** Looks through the picture under a clip for faces and things to follow. */
export async function findTrackTargets(clipId: string) {
  const snap = getState().snap
  const found = findClip(snap, clipId)
  if (!found || !snap) return
  const segments = segmentsUnder(found.clip, snap.project.tracks)
  if (!segments.length) return toast('There is no picture under this clip on the main track.', 'error')
  if (busy.has(clipId)) return
  busy.add(clipId)
  const task = startTask('Looking for things to follow', 'track', clipId)
  try {
    const paths = new Map<string, { t: Us; box: Box | null; seg: number }[]>()
    const counts = new Map<string, number>()
    let samples = 0
    const span = segments.reduce((s, x) => s + (x.to - x.from), 0)
    let done = 0
    for (let si = 0; si < segments.length; si++) {
      const sg = segments[si]
      const speed = sg.clip.speed ?? 1
      const startUs = sg.media.kind === 'image' ? 0 : sg.clip.inUs + (sg.from - sg.clip.startUs) * speed
      const durationUs = sg.media.kind === 'image' ? 1_000_000 : (sg.to - sg.from) * speed
      for (const kind of ['face', 'object'] as Follow[]) {
        await frames(sg.media, startUs, durationUs, 6, 320, async (rgba, w, h, i, t) => {
          const boxes = await ask<Box[]>({ type: 'detect', kind, width: w, height: h, rgba: rgba.buffer }, [rgba.buffer as ArrayBuffer])
          if (kind === 'face') samples++
          const tl = sg.media.kind === 'image' ? sg.from + i * 166_667 : sg.from + Math.round((t - startUs) / speed)
          const labels = new Set(boxes.map((b) => b.label))
          for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
          for (const l of labels) {
            const list = paths.get(l) ?? []
            const prev = [...list].reverse().find((p) => p.box)?.box
            const cands = boxes.filter((b) => b.label === l)
            const pick = prev ? cands.reduce((a, b) => (Math.hypot(b.x - prev.x, b.y - prev.y) < Math.hypot(a.x - prev.x, a.y - prev.y) ? b : a)) : cands.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a))
            list.push({ t: tl, box: pick, seg: si })
            paths.set(l, list)
          }
          done++
          patchTask(task, { fraction: Math.min(0.95, (done / Math.max(1, (span / 1e6) * 12)) * 0.95), stage: kind === 'face' ? 'Faces' : 'Things' })
        })
      }
    }
    for (const [l, n] of counts) counts.set(l, Math.round((100 * n) / Math.max(1, samples)))
    tracked.set(clipId, { segments, paths, counts })
    endTask(task)
    if (!counts.size) toast('Nothing to follow was found under this clip.', 'error')
  } catch (e) {
    endTask(task, `Couldn’t look for things to follow: ${(e as Error).message}`)
  } finally {
    busy.delete(clipId)
  }
}

/** Keyframes the clip's position (and with `withScale`, its size) to follow `label`. */
export async function followTarget(clipId: string, label: string, withScale: boolean) {
  const t = tracked.get(clipId)
  const snap = getState().snap
  const found = findClip(snap, clipId)
  const list = t?.paths.get(label)
  if (!t || !found || !list?.length) return
  const clip = found.clip
  // Where the thing is in the frame (project px from the centre), through the main clip's placement.
  const pts = list
    .filter((p) => p.box)
    .map((p) => {
      const sg = t.segments[p.seg]
      const pl = placement(sg.clip, sg.media)
      const b = p.box!
      const u = (b.x + b.w / 2 - pl.crop.x) / pl.crop.w
      const v = (b.y + b.h / 2 - pl.crop.y) / pl.crop.h
      const flip = sg.clip.flip ? -1 : 1
      return { t: p.t - clip.startUs, x: (u - 0.5) * pl.dw * flip + (sg.clip.posX ?? 0), y: (v - 0.5) * pl.dh + (sg.clip.posY ?? 0), size: (b.h / pl.crop.h) * pl.dh }
    })
    .filter((p) => p.t >= 0 && p.t <= clip.durationUs)
  if (pts.length < 1) return toast(`“${label}” isn’t seen under this clip.`, 'error')
  const sm = pts.map((p) => {
    const win = pts.filter((q) => Math.abs(q.t - p.t) <= 250_000)
    const avg = (f: (q: (typeof pts)[number]) => number) => win.reduce((s, q) => s + f(q), 0) / win.length
    return { t: p.t, x: avg((q) => q.x), y: avg((q) => q.y), size: avg((q) => q.size) }
  })
  // Keep the clip where it is now relative to the thing, at the first moment it's seen.
  const dx = (clip.posX ?? 0) - sm[0].x
  const dy = (clip.posY ?? 0) - sm[0].y
  const keys = keysOf(clip)
  keys.posX = simplify(sm, (p) => p.x, 3).map((p) => ({ atUs: Math.round(p.t), value: Math.round(p.x + dx) }))
  keys.posY = simplify(sm, (p) => p.y, 3).map((p) => ({ atUs: Math.round(p.t), value: Math.round(p.y + dy) }))
  const s0 = clip.scale ?? 100
  if (withScale) keys.scale = simplify(sm, (p) => p.size, 2).map((p) => ({ atUs: Math.round(p.t), value: Math.round((s0 * p.size) / Math.max(1, sm[0].size)) }))
  else delete keys.scale
  await call('clip.set', { clipId, keyframes: keys, label: `Follow ${label}` })
}

/** Stops following: the position (and scale) keyframes go. */
export async function stopFollowing(clip: Clip) {
  const keys = keysOf(clip)
  delete keys.posX
  delete keys.posY
  delete keys.scale
  await call('clip.set', { clipId: clip.id, keyframes: keys, label: 'Stop following' })
}

export const hasTrackTargets = (clipId: string) => tracked.has(clipId)
