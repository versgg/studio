// Draws text clips and caption lines: a TextSpec in, a transparent PNG at the project's
// size out, with the text centred (or at a caption's height), so the clip's posX/posY move
// its centre. Stroke, per-line background box, shadow, case, letter spacing, line height,
// italic and underline. The PNG goes into the project's text/ folder through the main
// process; boxW/boxH are the drawn box in project pixels.
//
// The drawing is in two parts: `layoutText` places the lines in the project's frame, and
// `paintText` draws them on any 2D context through its transform. The PNG and the player's
// live layer (liveText.ts) both use them, so what the player shows while you edit is what
// the export draws.

import { fontString, loadFont, nearestWeight } from './textFonts'
import { getState, type TextSpec } from './store'

/** TextSpec plus the two style switches the Inspector has (the engine keeps them as they are). */
export type TextLook = TextSpec & { italic?: boolean; underline?: boolean }

export interface Drawn {
  png: Uint8Array
  boxW: number
  boxH: number
}

/** Where the drawing puts the text: centred, or a caption's middle at `centerY` (0–1) of the height. */
export interface TextPlace {
  centerY?: number
  maxWidth?: number
}

/** A look laid out in a `width` × `height` frame: each line and where it goes, in project pixels. */
export interface TextLayout {
  spec: TextLook
  font: string
  size: number
  lines: string[]
  widths: number[]
  /** Each line's left edge and baseline. */
  x: number[]
  base: number[]
  asc: number
  desc: number
  pad: number
  strokeW: number
  /** What's drawn (glyphs, outline, background boxes; not the shadow), in frame pixels. */
  bounds: { x: number; y: number; w: number; h: number }
  /** boxW/boxH as the engine keeps them. */
  boxW: number
  boxH: number
}

const applyCase = (s: string, c: TextSpec['case']) => (c === 'upper' ? s.toLocaleUpperCase() : c === 'lower' ? s.toLocaleLowerCase() : s)

/** Splits a paragraph into lines no wider than `max` (long words are broken). */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/(\s+)/).filter((w) => w.length)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line + w
    if (!line || ctx.measureText(next.trimEnd()).width <= max) {
      line = next
      continue
    }
    lines.push(line.trimEnd())
    line = /^\s+$/.test(w) ? '' : w
    // A word longer than the line: break it by characters.
    while (ctx.measureText(line).width > max && line.length > 1) {
      let k = line.length - 1
      while (k > 1 && ctx.measureText(line.slice(0, k)).width > max) k--
      lines.push(line.slice(0, k))
      line = line.slice(k)
    }
  }
  lines.push(line.trimEnd())
  return lines
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, rr)
}

/** `#RRGGBB` (or any CSS colour) with an opacity 0–1, as a canvas colour. */
export function withAlpha(color: string, opacity: number) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim())
  if (!m) return color
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
  return `#${m[1]}${a.toString(16).padStart(2, '0')}`
}

/** The font a look draws with, and whether it has loaded (canvas draws with a fallback until then). */
export function fontOf(spec: TextLook) {
  const weight = nearestWeight(spec.font, spec.weight)
  const font = fontString(spec.font, weight, Math.max(4, spec.size), !!spec.italic)
  return { weight, font, ready: document.fonts.check(font, spec.content.slice(0, 40) || 'A') }
}

let measurer: CanvasRenderingContext2D | null = null

/** Lays `spec` out in a `width` × `height` frame (see `TextLayout`). */
export function layoutText(spec: TextLook, width: number, height: number, o: TextPlace = {}): TextLayout {
  measurer ??= document.createElement('canvas').getContext('2d')!
  const ctx = measurer
  const { font } = fontOf(spec)
  const size = Math.max(4, spec.size)
  ctx.font = font
  ctx.letterSpacing = `${spec.letterSpacing || 0}px`
  const pad = spec.background ? Math.max(0, spec.background.padding) : 0
  const strokeW = spec.stroke && spec.stroke.width > 0 ? spec.stroke.width : 0
  const max = Math.max(size, (o.maxWidth ?? width * 0.9) - 2 * pad - strokeW)
  const lines = applyCase(spec.content, spec.case)
    .split(/\r?\n/)
    .flatMap((p) => wrap(ctx, p, max))
  const widths = lines.map((l) => ctx.measureText(l).width)
  const m = ctx.measureText('ÅÄÖgjpqy')
  const asc = m.fontBoundingBoxAscent || size * 0.9
  const desc = m.fontBoundingBoxDescent || size * 0.25
  const lineH = Math.max(size * 0.5, size * (spec.lineHeight || 1.2))
  const blockW = Math.max(0, ...widths)
  const blockH = lineH * lines.length
  const cx = width / 2
  const cy = height * (o.centerY ?? 0.5)
  const top = cy - blockH / 2
  const x = lines.map((_, i) => (spec.align === 'left' ? cx - blockW / 2 : spec.align === 'right' ? cx + blockW / 2 - widths[i] : cx - widths[i] / 2))
  const base = lines.map((_, i) => top + i * lineH + (lineH - (asc + desc)) / 2 + asc)
  // The box: each line's glyphs with their outline, or its background box, whichever is bigger.
  const vpad = spec.background?.padY ?? pad * 0.55
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  lines.forEach((l, i) => {
    if (!l.trim()) return
    const [h, v] = [Math.max(strokeW, pad), Math.max(strokeW, spec.background ? vpad : 0)]
    x0 = Math.min(x0, x[i] - h)
    x1 = Math.max(x1, x[i] + widths[i] + h)
    y0 = Math.min(y0, base[i] - asc - v)
    y1 = Math.max(y1, base[i] + desc + v)
  })
  // Nothing to draw yet: a box the size of one letter where the text will be.
  if (x0 > x1) [x0, x1, y0, y1] = [cx - size / 2, cx + size / 2, cy - (asc + desc) / 2, cy + (asc + desc) / 2]
  const shadow = spec.shadow
  const extra = 2 * pad + 2 * strokeW + (shadow ? shadow.blur : 0)
  return {
    spec,
    font,
    size,
    lines,
    widths,
    x,
    base,
    asc,
    desc,
    pad,
    strokeW,
    bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    boxW: Math.round(blockW + extra),
    boxH: Math.round(blockH + (spec.background ? 2 * vpad : 0) + 2 * strokeW),
  }
}

/**
 * Draws a laid-out look on `ctx` through its current transform (frame pixels in). Canvas
 * shadows ignore the transform, so the shadow's offset and blur are put through it here.
 */
export function paintText(ctx: CanvasRenderingContext2D, l: TextLayout) {
  const { spec, lines, widths, x, base, asc, desc, pad, strokeW, size } = l
  ctx.font = l.font
  ctx.letterSpacing = `${spec.letterSpacing || 0}px`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  // Background: a box behind each line (they join up when lines are close), or one behind them all.
  if (spec.background && spec.background.opacity > 0) {
    ctx.fillStyle = withAlpha(spec.background.color, spec.background.opacity)
    const vpad = spec.background.padY ?? pad * 0.55
    const shown = lines.map((t, i) => i).filter((i) => lines[i].trim())
    if (spec.background.block && shown.length) {
      const left = Math.min(...shown.map((i) => x[i]))
      const right = Math.max(...shown.map((i) => x[i] + widths[i]))
      const top = base[shown[0]] - asc - vpad
      roundRect(ctx, left - pad, top, right - left + 2 * pad, base[shown[shown.length - 1]] + desc + vpad - top, spec.background.radius)
      ctx.fill()
    } else
      shown.forEach((i) => {
        roundRect(ctx, x[i] - pad, base[i] - asc - vpad, widths[i] + 2 * pad, asc + desc + 2 * vpad, spec.background!.radius)
        ctx.fill()
      })
  }
  const shadow = spec.shadow
  const m = ctx.getTransform()
  const setShadow = (on: boolean) => {
    ctx.shadowColor = on && shadow ? shadow.color : 'transparent'
    ctx.shadowBlur = on && shadow ? shadow.blur * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 0
    ctx.shadowOffsetX = on && shadow ? m.a * shadow.x + m.c * shadow.y : 0
    ctx.shadowOffsetY = on && shadow ? m.b * shadow.x + m.d * shadow.y : 0
  }
  // Outline first (it carries the shadow), then the fill on top.
  if (strokeW) {
    setShadow(true)
    ctx.strokeStyle = spec.stroke!.color
    ctx.lineWidth = strokeW * 2
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    lines.forEach((t, i) => ctx.strokeText(t, x[i], base[i]))
  }
  setShadow(!strokeW)
  ctx.fillStyle = spec.color
  lines.forEach((t, i) => ctx.fillText(t, x[i], base[i]))
  if (spec.underline) {
    setShadow(!strokeW)
    const th = Math.max(1, size * 0.06)
    lines.forEach((t, i) => t.trim() && ctx.fillRect(x[i], base[i] + size * 0.12, widths[i], th))
  }
  setShadow(false)
}

/**
 * Draws `spec` on a `width` × `height` canvas. `centerY` (0–1) puts the block's middle at that
 * height (captions); text clips sit in the middle. Returns the PNG bytes and the box size.
 */
export async function drawText(spec: TextLook, width: number, height: number, o: TextPlace = {}): Promise<Drawn> {
  const { weight } = fontOf(spec)
  await loadFont(spec.font, weight, !!spec.italic, spec.content.slice(0, 40) || 'A')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const layout = layoutText(spec, width, height, o)
  // Drawn on the CPU: reading a GPU canvas back for the PNG stalls the page for a few frames.
  paintText(canvas.getContext('2d', { willReadFrequently: true })!, layout)
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the text.'))), 'image/png'))
  return { png: new Uint8Array(await blob.arrayBuffer()), boxW: layout.boxW, boxH: layout.boxH }
}

/**
 * Where a clip's drawing puts its text: a text clip in the middle, a caption line at its
 * track's height ("Clean · sv · 72": 72 % down, as captions.ts draws them) and a bit wider.
 */
export function textPlaceOf(clip: { caption?: boolean; text?: TextSpec | null }, width: number): TextPlace {
  if (!clip.caption) return {}
  const y = Number((clip.text?.preset ?? '').split(' · ')[2])
  return { centerY: Number.isFinite(y) && y > 0 ? Math.min(0.95, Math.max(0.05, y / 100)) : 0.72, maxWidth: width * 0.94 }
}

/** A path in the project folder (the folder's own separator). */
export function projectFile(...parts: string[]) {
  const dir = getState().snap?.dir ?? ''
  const sep = dir.includes('\\') ? '\\' : '/'
  return [dir, ...parts].join(sep)
}

let counter = 0
/** A fresh name for a drawn PNG: `<stem>-<n>.png`, never reused (undo needs the old ones). */
export const freshPng = (folder: 'text' | 'masks' | 'stickers', stem: string) => projectFile(folder, `${stem}-${Date.now().toString(36)}${(++counter).toString(36)}.png`)

/** Writes drawn PNG bytes through the main process; throws with its message on failure. */
export async function savePng(path: string, png: Uint8Array) {
  const r = await window.studio.files.writeAsset(path, png)
  if ('error' in r) throw new Error(r.error)
  return r.out
}

/** Draws a text clip's spec and saves it; returns the spec with png, boxW and boxH set. */
export async function renderTextClip(spec: TextLook, stem: string, place?: number | TextPlace): Promise<TextLook> {
  const p = getState().snap?.project
  const w = p?.width ?? 1080
  const o = typeof place === 'number' ? { centerY: place, maxWidth: w * 0.94 } : (place ?? {})
  const d = await drawText(spec, w, p?.height ?? 1920, o)
  const png = await savePng(freshPng('text', stem), d.png)
  return { ...spec, png, boxW: d.boxW, boxH: d.boxH }
}
