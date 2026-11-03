// Visual dub, step 1: every piece of on-screen text in a video, with its exact first and last
// frame and where it sits. The method:
//   - PP-OCRv4 detection and recognition (PaddleOCR's models, in assets/ocr, run here on
//     onnxruntime-node) on 5 samples a second, the long side at 1024 px;
//   - a line is followed from sample to sample by its box; where the text at a place changes
//     ("Day 1" → "Day 4") it's a new line, and a piece of a line read on its own for a sample
//     (a hand passing behind it) counts as the line;
//   - stacked lines that come and go together are one block (a two-line title);
//   - a block's first and last frame are found exactly by comparing its glyph edges against every
//     frame between the two samples around it, so the new text comes and goes on the same frames.
// OCR's words only follow the lines. Claude reads each block again from the crops saved here
// (dub.ts), as OCR misreads (a "1" for an "l", a sparkle for a character).

import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as Ort from 'onnxruntime-node'
import type { DubBlock, DubBox, DubScan } from '../shared/dub'
import { ffmpeg, findTool, lowPriority, probeVideo } from './ffmpeg'

const SAMPLES_PER_SECOND = 5
/** Detection: a pixel is text above this, a box is kept when its mean is above BOX_SCORE. */
const PIXEL_THRESHOLD = 0.3
const BOX_SCORE = 0.6
/** How far a detected box is grown (DB's unclip ratio). */
const UNCLIP = 1.5
/** Lines OCR reads with less confidence than this are noise (a pattern, a hand). */
const MIN_CONFIDENCE = 0.6
/** A block must be on screen for this many samples, else it's a flash (a sign going past). */
const MIN_SAMPLES = 2
/** Edge match against the block's own glyphs above which it's on screen in a frame. */
const PRESENT = 0.6
const EDGE = 60

type Px = { x0: number; y0: number; x1: number; y1: number }
type Read = Px & { text: string; conf: number }
type Models = { ort: typeof Ort; det: Ort.InferenceSession; rec: Ort.InferenceSession; keys: string[] }

let models: Promise<Models> | null = null

function loadModels(): Promise<Models> {
  models ??= (async () => {
    const ort = (await import('onnxruntime-node')).default as unknown as typeof Ort
    ort.env.logLevel = 'error'
    const dir = process.env.STUDIO_OCR_DIR || path.join(app.getAppPath(), 'assets', 'ocr')
    const opts = { intraOpNumThreads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2))) }
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(path.join(dir, 'ch_PP-OCRv4_det_infer.onnx'), opts),
      ort.InferenceSession.create(path.join(dir, 'ch_PP-OCRv4_rec_infer.onnx'), opts),
    ])
    const keys = ['', ...fs.readFileSync(path.join(dir, 'ppocr_keys_v1.txt'), 'utf8').split(/\r?\n/).filter(Boolean), ' ']
    return { ort, det, rec, keys }
  })()
  models.catch(() => (models = null))
  return models
}

/** Text lines in one RGB frame (W × H, both multiples of 32), with OCR's reading of each. */
async function readFrame(m: Models, rgb: Buffer, W: number, H: number): Promise<Read[]> {
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const n = W * H
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c]
  const out = await m.det.run({ [m.det.inputNames[0]]: new m.ort.Tensor('float32', input, [1, 3, H, W]) })
  const prob = out[m.det.outputNames[0]].data as Float32Array

  // Connected regions of text pixels, each grown by DB's unclip distance.
  const seen = new Uint8Array(n)
  const boxes: Px[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (seen[i] || prob[i] <= PIXEL_THRESHOLD) continue
    seen[i] = 1
    stack.push(i)
    let x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0, count = 0
    while (stack.length) {
      const p = stack.pop()!
      const x = p % W, y = (p / W) | 0
      sum += prob[p]
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1])
        if (q >= 0 && !seen[q] && prob[q] > PIXEL_THRESHOLD) {
          seen[q] = 1
          stack.push(q)
        }
    }
    if (count < 20 || sum / count < BOX_SCORE) continue
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    // Turned on its side: text printed on a product, not an edit.
    if (h > w * 2) continue
    const d = (w * h * UNCLIP) / (2 * (w + h))
    boxes.push({ x0: Math.max(0, Math.round(x0 - d)), y0: Math.max(0, Math.round(y0 - d)), x1: Math.min(W - 1, Math.round(x1 + d)), y1: Math.min(H - 1, Math.round(y1 + d)) })
  }

  const reads: Read[] = []
  for (const b of boxes) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1
    const RH = 48
    const RW = Math.max(16, Math.min(960, Math.ceil((bw * RH) / bh / 8) * 8))
    const x = new Float32Array(3 * RH * RW)
    for (let yy = 0; yy < RH; yy++)
      for (let xx = 0; xx < RW; xx++) {
        const sx = b.x0 + Math.min(bw - 1, Math.floor((xx * bw) / RW))
        const sy = b.y0 + Math.min(bh - 1, Math.floor((yy * bh) / RH))
        const p = (sy * W + sx) * 3
        // The recogniser takes BGR.
        for (let c = 0; c < 3; c++) x[c * RH * RW + yy * RW + xx] = (rgb[p + 2 - c] / 255 - 0.5) / 0.5
      }
    const o = await m.rec.run({ [m.rec.inputNames[0]]: new m.ort.Tensor('float32', x, [1, 3, RH, RW]) })
    const r = o[m.rec.outputNames[0]]
    const [, T, C] = r.dims as number[]
    const data = r.data as Float32Array
    let last = 0, text = '', conf = 0, k = 0
    for (let t = 0; t < T; t++) {
      let best = 0, bestV = -1
      for (let c = 0; c < C; c++) if (data[t * C + c] > bestV) (bestV = data[t * C + c]), (best = c)
      if (best && best !== last) {
        text += m.keys[best] ?? ''
        conf += bestV
        k++
      }
      last = best
    }
    text = text.trim()
    if (text && k && conf / k >= MIN_CONFIDENCE) reads.push({ ...b, text, conf: conf / k })
  }
  return reads
}

const area = (a: Px) => (a.x1 - a.x0) * (a.y1 - a.y0)
function overlap(a: Px, b: Px) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}
const iou = (a: Px, b: Px) => overlap(a, b) / (area(a) + area(b) - overlap(a, b) || 1)

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const digits = (s: string) => s.replace(/\D+/g, ' ').trim()
function distance(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = t
    }
  }
  return d[b.length]
}
/** The same words read twice (OCR noise aside); a number that changes is new text. */
export function sameText(a: string, b: string) {
  const x = norm(a), y = norm(b)
  if (x === y) return true
  if (digits(a) !== digits(b)) return false
  if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x))) return true
  return 1 - distance(x, y) / Math.max(x.length, y.length) >= 0.6
}

/** Most of `piece`'s letters appear, in order, in `line`. */
function partOf(piece: string, line: string) {
  const a = norm(piece), b = norm(line)
  if (!a) return true
  const d = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]
      d[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(d[j], d[j - 1])
      prev = t
    }
  }
  return d[b.length] / a.length >= 0.6
}

type Track = { first: number; last: number; box: Px; reads: Map<string, number>; text: string; hits: number }

/** Lines followed across samples. `samples[i]` is what sample i read. */
export function followLines(samples: Read[][]): Track[] {
  const done: Track[] = []
  let open: Track[] = []
  samples.forEach((reads, i) => {
    open = open.filter((t) => (t.last >= i - 2 ? true : (done.push(t), false)))
    const taken = new Set<Track>()
    for (const r of [...reads].sort((a, b) => area(b) - area(a))) {
      let best: Track | null = null
      let score = 0.3
      for (const t of open) {
        if (taken.has(t)) continue
        const s = iou(t.box, r)
        if (s > score) (best = t), (score = s)
      }
      // A piece of a line (a hand split it for a moment) keeps that line alive, whatever it reads.
      const pieceOf = (t: Track) => overlap(t.box, r) >= 0.8 * area(r) && area(r) < 0.7 * area(t.box) && partOf(r.text, t.text)
      const whole = open.find((t) => pieceOf(t))
      if (whole) {
        if (!taken.has(whole)) {
          whole.last = i
          whole.hits++
          taken.add(whole)
        }
        continue
      }
      if (best && !sameText(best.text, r.text)) {
        // A new text in the same place; the old one ended with its last sample.
        open = open.filter((t) => t !== best)
        done.push(best)
        best = null
      }
      if (best) {
        best.last = i
        best.hits++
        // Only a whole reading moves the box and has a say in the text; a piece just keeps it alive.
        if (area(r) >= 0.7 * area(best.box)) {
          best.box = r
          best.reads.set(r.text, (best.reads.get(r.text) ?? 0) + 1)
          best.text = [...best.reads].sort((a, b) => b[1] - a[1])[0][0]
        }
        taken.add(best)
      } else {
        const t: Track = { first: i, last: i, box: r, reads: new Map([[r.text, 1]]), text: r.text, hits: 1 }
        open.push(t)
        taken.add(t)
      }
    }
  })
  return [...done, ...open].sort((a, b) => a.first - b.first || a.box.y0 - b.box.y0)
}

/** Lines that come and go together, one above the other, are one block. */
export function groupLines(tracks: Track[]): Track[][] {
  const groups: Track[][] = []
  for (const t of tracks) {
    const lineH = t.box.y1 - t.box.y0
    const g = groups.find((g) =>
      g.every((u) => Math.abs(u.first - t.first) <= 1 && Math.abs(u.last - t.last) <= 1) &&
      g.some((u) => {
        const gap = Math.max(u.box.y0, t.box.y0) - Math.min(u.box.y1, t.box.y1)
        const sideBySide = Math.min(u.box.x1, t.box.x1) - Math.max(u.box.x0, t.box.x0) > -lineH
        return gap < lineH * 0.8 && sideBySide
      }),
    )
    if (g) g.push(t)
    else groups.push([t])
  }
  return groups
}

/** Edge strength of a grey picture (central differences). */
function edges(g: Uint8Array, w: number, h: number) {
  const e = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      e[p] = Math.hypot(g[p + 1] - g[p - 1], g[p + w] - g[p - w])
    }
  return e
}

/** RGB to grey, the same way for samples and frames, so their edges compare. */
function toGrey(rgb: Buffer | Uint8Array, n: number) {
  const g = new Uint8Array(n)
  for (let i = 0; i < n; i++) g[i] = (rgb[i * 3] * 77 + rgb[i * 3 + 1] * 150 + rgb[i * 3 + 2] * 29) >> 8
  return g
}

/** Grey frames of a box over a stretch of the source, at its own frame rate. */
async function greyFrames(file: string, fromS: number, toS: number, crop: Px, W: number, H: number) {
  const w = crop.x1 - crop.x0, h = crop.y1 - crop.y0
  const raw = await ffmpeg(['-ss', Math.max(0, fromS).toFixed(4), '-i', file, '-t', Math.max(0.01, toS - Math.max(0, fromS)).toFixed(4), '-an', '-vf', `scale=${W}:${H},crop=${w}:${h}:${crop.x0}:${crop.y0}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  const frames: Uint8Array[] = []
  for (let i = 0; i + w * h * 3 <= raw.length; i += w * h * 3) frames.push(toGrey(raw.subarray(i, i + w * h * 3), w * h))
  return { frames, w, h }
}

/** Saves the block's crop (full resolution) and the whole frame with the block outlined. */
async function savePictures(file: string, dir: string, id: string, atS: number, box: DubBox, width: number, height: number) {
  const pad = Math.max(8, Math.round(box.h * height * 0.25))
  const x = Math.max(0, Math.round(box.x * width) - pad), y = Math.max(0, Math.round(box.y * height) - pad)
  const w = Math.min(width - x, Math.round(box.w * width) + 2 * pad), h = Math.min(height - y, Math.round(box.h * height) + 2 * pad)
  const crop = `${id}-crop.png`
  const frame = `${id}-frame.jpg`
  const fw = 540
  const s = fw / width
  await ffmpeg(['-y', '-ss', atS.toFixed(4), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`, path.join(dir, crop)])
  await ffmpeg(['-y', '-ss', atS.toFixed(4), '-i', file, '-frames:v', '1', '-q:v', '3', '-vf', `scale=${fw}:-2,drawbox=x=${Math.round(x * s)}:y=${Math.round(y * s)}:w=${Math.round(w * s)}:h=${Math.round(h * s)}:color=0xff2d2d@0.9:t=3`, path.join(dir, frame)])
  return { crop, frame }
}

export type ScanProgress = (fraction: number, note: string) => void

/** Scans a video's text into `dir` (scan.json and the crops). */
export async function scanText(file: string, dir: string, o: { signal?: AbortSignal; progress?: ScanProgress } = {}): Promise<DubScan> {
  const t0 = Date.now()
  fs.mkdirSync(dir, { recursive: true })
  const m = await loadModels()
  const v = await probeVideo(file)
  const duration = v.durationUs / 1e6
  // Analysis size: the long side at 1024, both sides multiples of 32 (the detector's stride).
  const s = 1024 / Math.max(v.width, v.height)
  const W = Math.max(32, Math.round((v.width * s) / 32) * 32)
  const H = Math.max(32, Math.round((v.height * s) / 32) * 32)
  const total = Math.max(1, Math.ceil(duration * SAMPLES_PER_SECOND))

  // Pass 1: read every sample, and keep it in grey for the boundaries (up to about two minutes).
  const samples: Read[][] = []
  const greys: (Uint8Array | undefined)[] = []
  const keepGrey = total <= 600
  const child = spawn(findTool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-an', '-vf', `fps=${SAMPLES_PER_SECOND},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true })
  lowPriority(child)
  const stop = () => child.kill()
  o.signal?.addEventListener('abort', stop)
  let err = ''
  child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
  const size = W * H * 3
  let pending: Buffer[] = []
  let have = 0
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending.push(chunk)
      have += chunk.length
      while (have >= size) {
        const all = Buffer.concat(pending)
        const frame = all.subarray(0, size)
        const rest = all.subarray(size)
        pending = rest.length ? [rest] : []
        have = rest.length
        samples.push(await readFrame(m, frame, W, H))
        greys.push(keepGrey ? toGrey(frame, W * H) : undefined)
        o.progress?.(Math.min(0.85, (samples.length / total) * 0.85), 'Finding the text')
      }
      if (o.signal?.aborted) break
    }
  } finally {
    o.signal?.removeEventListener('abort', stop)
  }
  if (o.signal?.aborted) throw new Error('Cancelled.')
  if (!samples.length) throw new Error(err.trim().split(/\r?\n/).pop() || 'No frames could be read from this file.')

  // Lines and blocks.
  const step = 1 / SAMPLES_PER_SECOND
  const found = groupLines(followLines(samples))
    .filter((g) => Math.max(...g.map((t) => t.hits)) >= MIN_SAMPLES)
    .map((g) => {
      const lines = [...g].sort((a, b) => a.box.y0 - b.box.y0)
      const px: Px = { x0: Math.min(...lines.map((t) => t.box.x0)), y0: Math.min(...lines.map((t) => t.box.y0)), x1: Math.max(...lines.map((t) => t.box.x1)), y1: Math.max(...lines.map((t) => t.box.y1)) }
      return { first: Math.min(...g.map((t) => t.first)), last: Math.max(...g.map((t) => t.last)), lines, px, startS: 0, endS: 0, refS: 0 }
    })
    .sort((a, b) => a.first - b.first)
  type Found = (typeof found)[number]
  const grow = (p: Px): Px => ({ x0: Math.max(0, p.x0 - 4), y0: Math.max(0, p.y0 - 4), x1: Math.min(W, p.x1 + 4), y1: Math.min(H, p.y1 + 4) })
  const union = (a: Px, b: Px): Px => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })
  const cut = (g: Uint8Array, c: Px) => {
    const w = c.x1 - c.x0
    const out = new Uint8Array(w * (c.y1 - c.y0))
    for (let y = c.y0; y < c.y1; y++) out.set(g.subarray(y * W + c.x0, y * W + c.x1), (y - c.y0) * w)
    return out
  }
  // Up to five samples spread over a block.
  const spread = (b: Found) => {
    const n = Math.min(5, b.last - b.first + 1)
    return Array.from({ length: n }, (_, i) => b.first + Math.floor(((i + 0.5) * (b.last - b.first + 1)) / n))
  }
  // A block's own glyph edges in a crop: per pixel the second weakest edge over its samples. The
  // letters stay put while the picture behind them moves, and one sample with a hand over the
  // text doesn't take its letters away.
  const stable = (b: Found, c: Px) => {
    const maps = spread(b).filter((i) => greys[i]).map((i) => edges(cut(greys[i]!, c), c.x1 - c.x0, c.y1 - c.y0))
    const n = maps[0]?.length ?? 0
    const out = new Float32Array(n)
    const k = maps.length >= 3 ? 1 : 0
    const vals = new Float32Array(maps.length)
    for (let p = 0; p < n; p++) {
      for (let i = 0; i < maps.length; i++) vals[i] = maps[i][p]
      vals.sort()
      out[p] = vals[k]
    }
    return out
  }
  const match = (ref: Float32Array, f: Uint8Array, c: Px) => {
    const e = edges(f, c.x1 - c.x0, c.y1 - c.y0)
    let s = 0, t = 0
    for (let p = 0; p < e.length; p++)
      if (ref[p] > EDGE) {
        t += ref[p]
        s += Math.min(e[p], ref[p])
      }
    return t ? s / t : 0
  }
  // A text that takes over a place from another ("Day 1" → "Day 4") shares letters with it, so
  // each frame between them goes to whichever of the two it matches better.
  const samePlace = (a: Found, b: Found) => a !== b && iou(a.px, b.px) > 0.3
  const boundary = async (a: Found, side: 'start' | 'end') => {
    const other = found.find((b) => samePlace(a, b) && (side === 'start' ? b.last < a.first && b.last >= a.first - 2 : b.first > a.last && b.first <= a.last + 2))
    const c = grow(other ? union(a.px, other.px) : a.px)
    const refA = stable(a, c)
    const refB = other ? stable(other, c) : null
    const on = (f: Uint8Array) => {
      const sa = match(refA, f, c)
      return sa >= PRESENT && (!refB || sa > match(refB, f, c))
    }
    // From one frame before the sample before (or at its last) to one after the next.
    const from = Math.max(0, (side === 'start' ? a.first - 1 : a.last) * step - 1 / v.fps)
    const to = (side === 'start' ? a.first : a.last + 1) * step + 1.5 / v.fps
    const fr = await greyFrames(file, from, to, c, W, H)
    const i0 = Math.ceil(from * v.fps - 1e-6)
    if (side === 'start') {
      const hit = fr.frames.findIndex(on)
      return hit >= 0 ? (i0 + hit) / v.fps : a.first * step
    }
    let seen = false
    for (const [i, f] of fr.frames.entries()) {
      if (on(f)) seen = true
      else if (seen) return (i0 + i) / v.fps
    }
    return Math.min(duration, (a.last + 1) * step)
  }
  // A long video's samples weren't kept: fetch the few the references need.
  if (!keepGrey)
    for (const i of new Set(found.flatMap(spread)))
      greys[i] = (await greyFrames(file, i * step, i * step + 0.5 / v.fps, { x0: 0, y0: 0, x1: W, y1: H }, W, H)).frames[0]
  for (const [k, a] of found.entries()) {
    if (o.signal?.aborted) throw new Error('Cancelled.')
    o.progress?.(0.85 + (k / found.length) * 0.1, 'Finding where each text starts and ends')
    // One text taking over from another in its place starts no earlier than the other ends (a
    // blank frame between them stays blank).
    const prev = found.find((b) => samePlace(a, b) && b.last < a.first && b.last >= a.first - 2)
    a.startS = a.first === 0 ? 0 : Math.max(prev?.endS ?? 0, await boundary(a, 'start'))
    a.endS = (a.last + 1) * step >= duration ? duration : await boundary(a, 'end')
    // The picture of it: the sample that looks most like its letters.
    const c = grow(a.px)
    const ref = stable(a, c)
    const best = spread(a).filter((i) => greys[i]).sort((x, y) => match(ref, cut(greys[y]!, c), c) - match(ref, cut(greys[x]!, c), c))[0]
    a.refS = (best ?? Math.round((a.first + a.last) / 2)) * step
  }

  const blocks: DubBlock[] = []
  const frac = (p: Px): DubBox => ({ x: p.x0 / W, y: p.y0 / H, w: (p.x1 - p.x0) / W, h: (p.y1 - p.y0) / H })
  for (const [k, a] of found.sort((x, y) => x.startS - y.startS || x.px.y0 - y.px.y0).entries()) {
    o.progress?.(0.95 + (k / found.length) * 0.05, 'Saving a picture of each text')
    const id = `t${String(k + 1).padStart(2, '0')}`
    const box = frac(a.px)
    const pics = await savePictures(file, dir, id, a.refS, box, v.width, v.height)
    blocks.push({
      id,
      startUs: Math.round(a.startS * 1e6),
      endUs: Math.round(a.endS * 1e6),
      box,
      lines: a.lines.map((t) => ({ text: t.text, box: frac(t.box) })),
      refUs: Math.round(a.refS * 1e6),
      ...pics,
    })
  }
  const scan: DubScan = { version: 1, source: file, width: v.width, height: v.height, fps: v.fps, durationUs: v.durationUs, blocks, ms: Date.now() - t0 }
  fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify(scan, null, 1))
  o.progress?.(1, 'Done')
  return scan
}
