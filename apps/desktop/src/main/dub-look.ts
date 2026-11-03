// Visual dub, step 4: what each text looks like, measured from the video against its copy with
// the text removed (Vmake): the original minus the clean copy is the text layer itself, so its
// letters, colour, box and shadow are read off exactly, on any background (an earlier dubbing tool's
// cleanfit.py, used here for everything instead of only as a late correction). The font is
// fitted afterwards in the page, which draws with the same fonts the export does, against the
// letter mask saved here.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { DubBlock, DubLook, DubScan } from '../shared/dub'
import { ffmpeg } from './ffmpeg'

/** A pixel whose largest colour difference to the clean copy is above this is part of the text layer. */
const CHANGED = 28

type Rect = { x0: number; y0: number; x1: number; y1: number }

async function rgbCrop(file: string, atS: number, r: Rect, width: number, height: number, then = '') {
  const w = r.x1 - r.x0, h = r.y1 - r.y0
  const raw = await ffmpeg(['-ss', atS.toFixed(4), '-i', file, '-frames:v', '1', '-an', '-vf', `scale=${width}:${height},crop=${w}:${h}:${r.x0}:${r.y0}${then ? `,${then}` : ''}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (raw.length < w * h * 3) throw new Error(`Couldn't read a frame of ${path.basename(file)} at ${atS.toFixed(2)} s.`)
  return raw
}

const hex = (c: number[]) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const lum = (p: Buffer, i: number) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]
function median(xs: number[]) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
function medianColour(p: Buffer, idx: number[]) {
  return [0, 1, 2].map((c) => median(idx.map((i) => p[i * 3 + c])))
}

/** Grows (or with `shrink`, erodes) a mask by one pixel, 4-connected. */
function step(m: Uint8Array, w: number, h: number, shrink = false) {
  const out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const n = [m[i], x > 0 ? m[i - 1] : shrink ? 0 : m[i], x < w - 1 ? m[i + 1] : shrink ? 0 : m[i], y > 0 ? m[i - w] : shrink ? 0 : m[i], y < h - 1 ? m[i + w] : shrink ? 0 : m[i]]
      out[i] = shrink ? (n.every(Boolean) ? 1 : 0) : n.some(Boolean) ? 1 : 0
    }
  return out
}

/** A grey 8-bit PNG (the letter mask the page fits fonts against). */
export function greyPng(data: Uint8Array, w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(tb))
    return Buffer.concat([len, tb, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const rows = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) rows.set(data.subarray(y * w, y * w + w), y * (w + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** Measures one block's look at its reference moment. */
/**
 * When to measure a text: its reference frame kept two frames inside its time, then its middle.
 * The scan's reference can sit on the text's first frame, or the frame before it (seeking lands
 * a frame either way), where the text isn't drawn yet: a text measured at 51.2 s that
 * shows from 51.23 s, which failed a whole dub after Vmake had finished.
 */
function moments(b: DubBlock, fps: number) {
  const f = 1e6 / (fps || 30)
  const mid = (b.startUs + b.endUs) / 2
  const ref = b.endUs - b.startUs > 4 * f ? Math.min(Math.max(b.refUs, b.startUs + 2 * f), b.endUs - 2 * f) : mid
  return Math.abs(ref - mid) < f ? [ref] : [ref, mid]
}

export async function measureBlock(b: DubBlock, original: string, clean: string, scan: DubScan, dir: string, atUs = b.refUs): Promise<DubLook> {
  const { width: W, height: H } = scan
  const inner: Rect = { x0: Math.round(b.box.x * W), y0: Math.round(b.box.y * H), x1: Math.round((b.box.x + b.box.w) * W), y1: Math.round((b.box.y + b.box.h) * H) }
  const lineH = Math.max(8, median(b.lines.map((l) => l.box.h * H)))
  const gx = Math.round(Math.max(12, 1.2 * lineH)), gy = Math.round(Math.max(12, 0.8 * lineH))
  const r: Rect = { x0: Math.max(0, inner.x0 - gx), y0: Math.max(0, inner.y0 - gy), x1: Math.min(W, inner.x1 + gx), y1: Math.min(H, inner.y1 + gy) }
  const w = r.x1 - r.x0, h = r.y1 - r.y0
  const t = atUs / 1e6
  // With no clean copy (Vmake None, `clean` is the original itself), the picture behind the
  // letters is estimated: a median filter wider than a stroke wipes the letters out.
  const estimate = path.resolve(clean) === path.resolve(original)
  const radius = Math.min(127, Math.max(4, Math.round(lineH * 0.35)))
  const [o, c] = await Promise.all([rgbCrop(original, t, r, W, H), estimate ? rgbCrop(original, t, r, W, H, `format=rgb24,median=radius=${radius}`) : rgbCrop(clean, t, r, W, H)])
  const n = w * h
  const changed = new Uint8Array(n)
  const dl = new Float32Array(n)
  const insideInner = (i: number) => {
    const x = (i % w) + r.x0, y = Math.floor(i / w) + r.y0
    return x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1
  }
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(o[i * 3] - c[i * 3]), Math.abs(o[i * 3 + 1] - c[i * 3 + 1]), Math.abs(o[i * 3 + 2] - c[i * 3 + 2]))
    changed[i] = d > CHANGED ? 1 : 0
    dl[i] = lum(o, i * 3) - lum(c, i * 3)
  }
  const innerIdx = Array.from({ length: n }, (_, i) => i).filter(insideInner)
  const changedInner = innerIdx.filter((i) => changed[i])

  // A box: most of the text's own rectangle changed (a bar or a bubble behind the letters).
  let box: DubLook['box'] = null
  let glyph = new Uint8Array(n)
  if (changedInner.length > 0.6 * innerIdx.length) {
    const boxColour = medianColour(o, changedInner)
    const dist = (i: number) => Math.hypot(o[i * 3] - boxColour[0], o[i * 3 + 1] - boxColour[1], o[i * 3 + 2] - boxColour[2])
    const far = changedInner.map(dist)
    const cut = Math.max(60, 0.5 * quantile(far, 0.98))
    for (const i of changedInner) if (dist(i) > cut) glyph[i] = 1
    // The box's extent: changed pixels joined to the text's rectangle, row by row.
    let [bx0, by0, bx1, by1] = [w, h, 0, 0]
    for (let i = 0; i < n; i++)
      if (changed[i] && dist(i) <= cut) {
        const x = i % w, y = Math.floor(i / w)
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
    // Corner radius: how far in from each corner the box starts, along the diagonal.
    const radii: number[] = []
    for (const [cx, cy, sx, sy] of [[bx0, by0, 1, 1], [bx1, by0, -1, 1], [bx0, by1, 1, -1], [bx1, by1, -1, -1]]) {
      let k = 0
      while (k < Math.min(bx1 - bx0, by1 - by0) / 2 && !(changed[(cy + sy * k) * w + cx + sx * k] && dist((cy + sy * k) * w + cx + sx * k) <= cut)) k++
      radii.push(k / (1 - Math.SQRT1_2))
    }
    // Opaque when the box's colour doesn't follow the picture behind it.
    const plain = changedInner.filter((i) => !glyph[i])
    const sd = (p: Buffer) => {
      const v = plain.map((i) => lum(p, i * 3))
      const m = v.reduce((a, x) => a + x, 0) / Math.max(1, v.length)
      return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length))
    }
    const opacity = Math.max(0.35, Math.min(1, 1 - sd(o) / Math.max(1, sd(c))))
    box = { color: hex(boxColour), opacity: opacity > 0.9 ? 1 : opacity, radius: median(radii.sort((a, b) => a - b).slice(1, 3)), rect: { x: r.x0 + bx0, y: r.y0 + by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } }
  } else {
    // Letters lighter (or darker) than the picture they cover: the strongest change of the
    // common sign, inside the text's rectangle.
    const strong = changedInner.filter((i) => Math.abs(dl[i]) > 20)
    const light = median(strong.map((i) => dl[i])) >= 0
    const mags = changedInner.filter((i) => (light ? dl[i] > 0 : dl[i] < 0)).map((i) => Math.abs(dl[i]))
    const cut = Math.max(25, 0.45 * quantile(mags, 0.9))
    for (const i of changedInner) if ((light ? dl[i] : -dl[i]) > cut) glyph[i] = 1
  }
  if (!glyph.some(Boolean)) throw new Error(`No letters found for "${b.lines.map((l) => l.text).join(' ')}" against the clean copy.`)

  // Colour: the letters' cores (one pixel in from their edges, where nothing blends).
  const core = step(glyph, w, h, true)
  const coreIdx = [...core.keys()].filter((i) => core[i])
  const colour = medianColour(o, coreIdx.length > 20 ? coreIdx : [...glyph.keys()].filter((i) => glyph[i]))

  // Around the letters: an outline (a thin even band) or a shadow (a soft darkening, often offset).
  let stroke: DubLook['stroke'] = null
  let shadow: DubLook['shadow'] = null
  if (!box) {
    const light = lum(Buffer.from(colour), 0) > 128
    let reach = glyph
    const rings: { idx: number[]; dark: number }[] = []
    for (let k = 1; k <= Math.max(3, Math.round(lineH * 0.35)); k++) {
      const next = step(reach, w, h)
      const idx: number[] = []
      for (let i = 0; i < n; i++) if (next[i] && !reach[i]) idx.push(i)
      reach = next
      const shade = idx.map((i) => (light ? -dl[i] : dl[i]) / Math.max(16, lum(c, i * 3)))
      rings.push({ idx, dark: median(shade) })
    }
    const strongRing = rings.findIndex((g) => g.dark < 0.25)
    const band = strongRing < 0 ? rings.length : strongRing
    if (rings[0]?.dark > 0.6 && band <= 4) {
      const idx = rings.slice(0, band).flatMap((g) => g.idx)
      stroke = { color: hex(medianColour(o, idx)), width: band }
    } else if (rings[0]?.dark > 0.08) {
      // How far the darkening reaches (about the blur), its strength, and which way it leans.
      const total = rings.reduce((a, g) => a + Math.max(0, g.dark), 0)
      let acc = 0, blur = 1
      for (const [k, g] of rings.entries()) {
        acc += Math.max(0, g.dark)
        if (acc >= 0.8 * total) {
          blur = k + 1
          break
        }
      }
      let [sx, sy, sw, gxs, gys, gn] = [0, 0, 0, 0, 0, 0]
      for (const g of rings)
        for (const i of g.idx) {
          const d = Math.max(0, (light ? -dl[i] : dl[i]) / Math.max(16, lum(c, i * 3)))
          sx += (i % w) * d
          sy += Math.floor(i / w) * d
          sw += d
        }
      for (let i = 0; i < n; i++)
        if (glyph[i]) {
          gxs += i % w
          gys += Math.floor(i / w)
          gn++
        }
      shadow = {
        color: light ? '#000000' : '#ffffff',
        opacity: Math.min(1, Math.max(0.2, rings[0].dark * 1.4)),
        blur,
        x: sw ? Math.round((sx / sw - gxs / gn) * 2) / 2 : 0,
        y: sw ? Math.round((sy / sw - gys / gn) * 2) / 2 : 0,
      }
    }
  }

  // Each line's ink: the letters inside that line's OCR box.
  const ink = b.lines.map((l) => {
    const lx0 = Math.round(l.box.x * W) - r.x0, ly0 = Math.round(l.box.y * H) - r.y0
    const lx1 = Math.round((l.box.x + l.box.w) * W) - r.x0, ly1 = Math.round((l.box.y + l.box.h) * H) - r.y0
    let [x0, y0, x1, y1] = [w, h, -1, -1]
    for (let y = Math.max(0, ly0); y < Math.min(h, ly1); y++)
      for (let x = Math.max(0, lx0); x < Math.min(w, lx1); x++)
        if (glyph[y * w + x]) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    return x1 < 0 ? { x: lx0 + r.x0, y: ly0 + r.y0, w: lx1 - lx0, h: ly1 - ly0 } : { x: x0 + r.x0, y: y0 + r.y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  })

  const maskFile = `${b.id}-mask.png`
  fs.writeFileSync(path.join(dir, maskFile), greyPng(glyph.map((v) => (v ? 255 : 0)), w, h))
  return { id: b.id, color: hex(colour), box, stroke, shadow, ink, mask: maskFile, maskRect: { x: r.x0, y: r.y0, w, h } }
}

/**
 * Measures every block that's being replaced (into `dir/looks.json`). One whose letters aren't
 * found against the clean copy at any of its moments is left out (the dub keeps it as filmed)
 * rather than failing the dub.
 */
export async function measureLooks(scan: DubScan, ids: string[], original: string, clean: string, dir: string): Promise<DubLook[]> {
  const looks: DubLook[] = []
  for (const b of scan.blocks.filter((x) => ids.includes(x.id)))
    for (const at of moments(b, scan.fps)) {
      try {
        looks.push(await measureBlock(b, original, clean, scan, dir, at))
        break
      } catch (e) {
        if (!/^No letters found/.test((e as Error).message)) throw e
      }
    }
  fs.writeFileSync(path.join(dir, 'looks.json'), JSON.stringify(looks, null, 1))
  return looks
}

/**
 * One video with another shown only where the given texts were and only while they were there
 * (soft-edged patches). A dub uses it to put the original back over Vmake's clean copy where a
 * text couldn't be measured to be drawn again, so that text stays as filmed. (Dubs before
 * 2026-11-02 patched the clean copy into the original for every dubbed text, believing Vmake
 * also wipes product labels; it doesn't, and the patches flickered.)
 */
export async function buildBase(original: string, clean: string, scan: DubScan, ids: string[], out: string) {
  const { width: W, height: H } = scan
  const blocks = scan.blocks.filter((b) => ids.includes(b.id))
  if (!blocks.length) {
    fs.copyFileSync(original, out)
    return
  }
  // One moving mask for all the patches (each a soft-edged rectangle, white while its text is
  // on screen), drawn here as one picture per stretch of time and played as a slideshow, so
  // FFmpeg lays the clean copy over the original in a single pass. A layer per text took over
  // ten minutes for 31 texts over 49 s.
  const duration = scan.durationUs / 1e6
  const rects = blocks.map((b, i) => {
    const th = (b.box.h * H) / Math.max(1, b.lines.length)
    const px = Math.max(12, 1.2 * th), py = Math.max(12, 0.8 * th)
    const x = Math.max(0, Math.round(b.box.x * W - px)), y = Math.max(0, Math.round(b.box.y * H - py))
    const w = Math.min(W - x, Math.round(b.box.w * W + 2 * px)), h = Math.min(H - y, Math.round(b.box.h * H + 2 * py))
    // In whole frames, one either side to spare: the clean copy differs from the original only where
    // text was, so a patch a frame early or late can't be seen, but one a frame short let the old
    // text show under a see-through new box for that frame (Wendy's dub, 27.8 s).
    const fr = (us: number) => Math.round((us / 1e6) * scan.fps)
    return { i, x, y, w, h, f: Math.max(4, Math.round(Math.min(px, py) / 2)), s: Math.max(0, fr(b.startUs) - 1), e: fr(b.endUs) + 1 }
  })
  const frames = Math.ceil(duration * scan.fps)
  const cuts = [...new Set([0, frames, ...rects.flatMap((r) => [r.s, r.e])])].filter((t) => t >= 0 && t <= frames).sort((a, b) => a - b)
  const dir = path.join(path.dirname(out), 'masks')
  fs.mkdirSync(dir, { recursive: true })
  const made = new Map<string, string>()
  const slides: { file: string; frames: number }[] = []
  for (let k = 0; k + 1 < cuts.length; k++) {
    const count = cuts[k + 1] - cuts[k]
    if (count < 1) continue
    const on = rects.filter((r) => r.s <= cuts[k] && cuts[k] < r.e)
    const key = on.map((r) => r.i).join(',')
    let file = made.get(key)
    if (!file) {
      const m = new Uint8Array(W * H)
      for (const r of on)
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            const v = Math.round(255 * Math.max(0, Math.min(1, Math.min(x - r.x, r.x + r.w - 1 - x, y - r.y, r.y + r.h - 1 - y) / r.f)))
            if (v > m[y * W + x]) m[y * W + x] = v
          }
      file = path.join(dir, `mask-${made.size}.png`)
      fs.writeFileSync(file, greyPng(m, W, H))
      made.set(key, file)
    }
    slides.push({ file, frames: count })
  }
  const quote = (f: string) => `'${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  const list = path.join(dir, 'masks.txt')
  fs.writeFileSync(list, slides.map((s) => `file ${quote(s.file)}\nduration ${(s.frames / scan.fps).toFixed(6)}`).join('\n') + `\nfile ${quote(slides[slides.length - 1].file)}\n`)
  try {
    await ffmpeg([
      '-y', '-i', original, '-i', clean, '-f', 'concat', '-safe', '0', '-i', list,
      '-filter_complex', `[1:v]scale=${W}:${H},setsar=1[c];[2:v]fps=${scan.fps.toFixed(3)},scale=${W}:${H},format=gray[m];[c][m]alphamerge[p];[0:v][p]overlay=0:0,format=yuv420p[v]`,
      '-map', '[v]', '-map', '0:a?', '-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out,
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
