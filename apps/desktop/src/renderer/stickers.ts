// Stickers: emoji (drawn with the system's colour emoji font: Segoe UI Emoji on Windows) and
// simple vector shapes, rendered here to a transparent PNG at the project's size with the
// sticker in the middle, saved in the project's stickers/ folder, imported, and put on a new
// sticker track at the playhead (overlay.add, role "sticker"). Your own PNG, GIF, WebP or WebM
// (with transparency) is copied into the same folder and added the same way.

import { call, getState, mediaById, setState, toast, type Media } from './store'
import { projectFile, savePng } from './textRender'

/** One vector drawing on a 160 × 100 board: path, fill, stroke, stroke width, transform. */
export type Art = [d: string, fill: string, stroke?: string, width?: number, transform?: string]

export interface StickerDef {
  name: string
  kinds: string[]
  emoji?: string
  art?: Art[]
}

const LEAF = 'M0 -36C8 -26 18 -28 14 -16C24 -12 22 0 12 0C22 6 20 18 8 14C12 26 4 34 0 36C-4 34 -12 26 -8 14C-20 18 -22 6 -12 0C-22 0 -24 -12 -14 -16C-18 -28 -8 -26 0 -36Z'
const STAR = 'M0 -30L7 -11L27 -15L13 1L24 21L4 13L-5 30L-9 10L-29 8L-13 -5L-21 -24L-4 -13Z'
const BIRD = 'M-26 -6C-14 -8 -6 -2 0 4C6 -2 14 -8 26 -6C16 -2 8 6 2 14L0 22L-2 14C-8 6 -16 -2 -26 -6Z'
const HEART = 'M0 22C-30 2 -22 -24 0 -10C22 -24 30 2 0 22Z'

const emoji = (name: string, e: string, ...kinds: string[]): StickerDef => ({ name, emoji: e, kinds })

export const STICKERS: StickerDef[] = [
  { name: 'Pointing arrow', art: [['M34 74C50 40 92 28 122 34', 'none', '#FFFFFF', 5], ['M108 22l16 12-14 14', 'none', '#FFFFFF', 5]], kinds: ['Arrows and circles'] },
  { name: 'Circle it', art: [['M80 22C120 20 136 44 128 64C118 86 54 88 34 66C18 46 44 24 88 26', 'none', '#F08080', 5]], kinds: ['Arrows and circles'] },
  { name: 'Underline', art: [['M24 62C60 54 100 70 136 58', 'none', '#E8C050', 7]], kinds: ['Arrows and circles'] },
  emoji('Pointing right', '👉', 'Arrows and circles', 'Reactions'),
  emoji('Pointing down', '👇', 'Arrows and circles'),
  emoji('Down arrow', '⬇️', 'Arrows and circles'),
  { name: 'Tick', art: [['M46 52l22 20 46-46', 'none', '#74BE59', 9]], kinds: ['Reactions', 'Shapes'] },
  emoji('Fire', '🔥', 'Reactions'),
  emoji('Heart eyes', '😍', 'Reactions'),
  emoji('Laughing', '😂', 'Reactions'),
  emoji('Wow', '😮', 'Reactions'),
  emoji('Thumbs up', '👍', 'Reactions'),
  emoji('Clapping', '👏', 'Reactions'),
  emoji('Hundred', '💯', 'Reactions'),
  emoji('Sparkles', '✨', 'Reactions', 'Christmas'),
  emoji('Party', '🎉', 'Reactions', 'Sale'),
  { name: 'Heart', art: [[HEART, '#F08080', 'none', 0, 'translate(80 50) scale(1.5)']], kinds: ['Reactions', 'Shapes'] },
  { name: 'Speech bubble', art: [['M36 24h88a8 8 0 0 1 8 8v28a8 8 0 0 1-8 8H70l-16 14v-14H36a8 8 0 0 1-8-8V32a8 8 0 0 1 8-8z', '#FFFFFF']], kinds: ['Reactions', 'Shapes'] },
  emoji('Christmas tree', '🎄', 'Christmas'),
  emoji('Gift', '🎁', 'Christmas', 'Sale'),
  emoji('Santa', '🎅', 'Christmas'),
  emoji('Snowman', '⛄', 'Christmas'),
  emoji('Bell', '🔔', 'Christmas'),
  emoji('Reindeer', '🦌', 'Christmas'),
  { name: 'Snowflake', art: [['M80 18V82 M52 34l56 32 M52 66l56-32 M72 22l8 8 8-8 M72 78l8-8 8 8', 'none', '#FFFFFF', 4]], kinds: ['Christmas'] },
  { name: 'Star', art: [[STAR, '#E8C050', 'none', 0, 'translate(80 50) scale(1.2)']], kinds: ['Christmas', 'Shapes'] },
  { name: 'Leaf', art: [[LEAF, '#74BE59', 'none', 0, 'translate(80 50) scale(1) rotate(-14)']], kinds: ['Christmas', 'Shapes'] },
  { name: 'Price burst', art: [[STAR, '#3B57F0', 'none', 0, 'translate(80 50) scale(1.45) rotate(8)']], kinds: ['Sale', 'Shapes'] },
  emoji('Price tag', '🏷️', 'Sale'),
  emoji('Shopping cart', '🛒', 'Sale'),
  emoji('Delivery', '🚚', 'Sale'),
  emoji('Package', '📦', 'Sale'),
  emoji('Alarm clock', '⏰', 'Sale'),
  { name: 'Swallow', art: [[BIRD, '#FFFFFF', 'none', 0, 'translate(80 50) scale(1.4)']], kinds: ['Shapes'] },
]

export const STICKER_KINDS = ['All', 'Arrows and circles', 'Reactions', 'Christmas', 'Sale', 'Shapes', 'Yours']

export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'

/** Draws a sticker in the middle of a transparent project-size canvas; returns PNG bytes. */
async function drawSticker(s: StickerDef, W: number, H: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const side = Math.min(W, H) * 0.36
  if (s.emoji) {
    const font = `${Math.round(side)}px ${EMOJI_FONT}`
    try {
      await document.fonts.load(font, s.emoji)
    } catch {}
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(s.emoji, W / 2, H / 2)
  } else if (s.art) {
    // The 160 × 100 board, scaled so it's about half the frame wide.
    const k = (Math.min(W, H) * 0.55) / 160
    ctx.translate(W / 2 - 80 * k, H / 2 - 50 * k)
    ctx.scale(k, k)
    for (const [d, fill, stroke = 'none', width = 0, transform] of s.art) {
      ctx.save()
      if (transform) applyTransform(ctx, transform)
      const p = new Path2D(d)
      if (fill !== 'none') {
        ctx.fillStyle = fill
        ctx.fill(p)
      }
      if (stroke !== 'none' && width > 0) {
        ctx.strokeStyle = stroke
        ctx.lineWidth = width
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke(p)
      }
      ctx.restore()
    }
  }
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the sticker.'))), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

/** The SVG transforms the art uses: translate, scale, rotate (in that order of appearance). */
function applyTransform(ctx: CanvasRenderingContext2D, t: string) {
  for (const m of t.matchAll(/(translate|scale|rotate)\(([^)]*)\)/g)) {
    const n = m[2].split(/[\s,]+/).filter(Boolean).map(Number)
    if (m[1] === 'translate') ctx.translate(n[0], n[1] ?? 0)
    else if (m[1] === 'scale') ctx.scale(n[0], n[1] ?? n[0])
    else ctx.rotate((n[0] * Math.PI) / 180)
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Adds media on a new sticker track at the playhead and selects it. */
async function placeSticker(mediaId: string, label: string, scale?: number) {
  const r = await call<{ clipId: string; trackId: string }>('overlay.add', { mediaId, atUs: getState().positionUs, role: 'sticker' })
  if (!r) return
  if (scale) await call('clip.set', { clipId: r.clipId, scale, label: `Size of ${label}` })
  setState({ selection: [r.clipId], focus: 'timeline' })
}

/** A built-in sticker: drawn, saved, imported, added at the playhead. */
export async function addSticker(s: StickerDef) {
  const p = getState().snap?.project
  if (!p) return
  try {
    const png = await drawSticker(s, p.width, p.height)
    const out = await savePng(projectFile('stickers', `sticker-${slug(s.name)}-${Date.now().toString(36)}.png`), png)
    const imp = await call<{ imported: string[] }>('media.import', { paths: [out] })
    const id = imp?.imported?.[0]
    if (id) await placeSticker(id, s.name)
  } catch (e) {
    toast(`Couldn’t add the sticker: ${(e as Error).message}`, 'error')
  }
}

/** Your own sticker: a PNG, GIF, WebP or WebM with transparency, copied into the project. */
export async function uploadSticker() {
  const dir = getState().snap?.dir
  if (!dir) return
  const src = await window.studio.app.chooseFile({ title: 'Add your own sticker', filters: [{ name: 'Stickers (PNG, GIF, WebP, WebM)', extensions: ['png', 'gif', 'webp', 'webm', 'apng'] }] })
  if (!src) return
  const r = await window.studio.files.importSticker(src, dir)
  if ('error' in r) return toast(r.error, 'error')
  const imp = await call<{ imported: string[] }>('media.import', { paths: [r.out] })
  const id = imp?.imported?.[0]
  // Your own file fills the frame at 100 %, so it starts at a sticker's size.
  if (id) await placeSticker(id, 'your sticker', 40)
}

/** Stickers you added yourself (files in the project's stickers folder that Studio didn't draw). */
export function yourStickers(media: Media[] | undefined): Media[] {
  return (media ?? []).filter((m) => /\.studio[\\/]stickers[\\/]/i.test(m.path) && !/[\\/]sticker-[a-z0-9-]+-[a-z0-9]+\.png$/i.test(m.path) && !m.missing)
}

/** Adds one of your stickers again. */
export async function addYourSticker(m: Media) {
  if (!mediaById(getState().snap, m.id)) return
  await placeSticker(m.id, m.name, 40)
}
