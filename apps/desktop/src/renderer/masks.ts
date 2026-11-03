// Masks: the Inspector's shape, drawn here at the project's size as a grey PNG (white =
// keep, black = cut away; soft edges are greys), saved in the project's masks/ folder and
// sent as `mask` + `maskPng` (the engine alphamerges the PNG, so what you set is what it uses).

import { getState, type Clip } from './store'
import { projectFile, savePng } from './textRender'

export type MaskShape = 'line' | 'mirror' | 'circle' | 'rect' | 'heart' | 'star'
export type Mask = NonNullable<Clip['mask']>

export const MASK_DEFAULTS: Record<MaskShape, Omit<Mask, 'shape'>> = {
  line: { x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0, feather: 0, invert: false },
  mirror: { x: 0.5, y: 0.5, w: 1, h: 0.4, rotation: 0, feather: 0, invert: false },
  circle: { x: 0.5, y: 0.5, w: 0.6, h: 0.34, rotation: 0, feather: 10, invert: false },
  rect: { x: 0.5, y: 0.5, w: 0.7, h: 0.4, rotation: 0, feather: 0, invert: false },
  heart: { x: 0.5, y: 0.5, w: 0.6, h: 0.34, rotation: 0, feather: 0, invert: false },
  star: { x: 0.5, y: 0.5, w: 0.6, h: 0.34, rotation: 0, feather: 0, invert: false },
}

function shapePath(ctx: CanvasRenderingContext2D, m: Mask, W: number, H: number) {
  const w = m.w * W
  const h = m.h * H
  const big = 4 * Math.hypot(W, H)
  ctx.beginPath()
  switch (m.shape as MaskShape) {
    case 'line':
      // Everything above the line through the centre (turned by the rotation).
      ctx.rect(-big, -big, 2 * big, big)
      break
    case 'mirror':
      ctx.rect(-big, -h / 2, 2 * big, h)
      break
    case 'circle':
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
      break
    case 'rect':
      ctx.rect(-w / 2, -h / 2, w, h)
      break
    case 'heart': {
      // A heart in a 2 × 2 box, scaled to w × h.
      const sx = w / 2
      const sy = h / 2
      ctx.moveTo(0, 0.95 * sy)
      ctx.bezierCurveTo(-1.4 * sx, 0.05 * sy, -0.95 * sx, -1.1 * sy, 0, -0.45 * sy)
      ctx.bezierCurveTo(0.95 * sx, -1.1 * sy, 1.4 * sx, 0.05 * sy, 0, 0.95 * sy)
      break
    }
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const r = i % 2 ? 0.42 : 1
        const px = Math.cos(a) * r * (w / 2)
        const py = Math.sin(a) * r * (h / 2)
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      }
      ctx.closePath()
      break
    }
  }
}

/** Draws the mask at the project's size; returns the PNG bytes. */
export async function drawMask(m: Mask, W: number, H: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = m.invert ? '#FFFFFF' : '#000000'
  ctx.fillRect(0, 0, W, H)
  const blur = (Math.max(0, Math.min(100, m.feather)) / 100) * 0.08 * Math.min(W, H)
  if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`
  ctx.translate(m.x * W, m.y * H)
  ctx.rotate((m.rotation * Math.PI) / 180)
  shapePath(ctx, m, W, H)
  ctx.fillStyle = m.invert ? '#000000' : '#FFFFFF'
  ctx.fill()
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the mask.'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

/** The clip.set values for a mask (drawn and saved), or for no mask. */
export async function maskValues(clipId: string, m: Mask | null): Promise<Record<string, unknown>> {
  if (!m) return { mask: null, maskPng: null }
  const p = getState().snap!.project
  const png = await savePng(projectFile('masks', `${clipId}-${Date.now().toString(36)}.png`), await drawMask(m, p.width, p.height))
  return { mask: m, maskPng: png }
}
