// Home › Templates (Home.dc.html): each starts a 9:16 project with an opening card (the
// template's artwork as a 3 s picture on the video track) and its headline as a text clip on
// top, both yours to change. Your clips go after the card.

import type { TextLook } from './textRender'
import { addText } from './libraryActions'
import { call, getState, newProject, seek } from './store'

// Shapes in the canvas's 180 × 300 artwork space.
const S = {
  leaf: 'M0 -36C8 -26 18 -28 14 -16C24 -12 22 0 12 0C22 6 20 18 8 14C12 26 4 34 0 36C-4 34 -12 26 -8 14C-20 18 -22 6 -12 0C-22 0 -24 -12 -14 -16C-18 -28 -8 -26 0 -36Z',
  star: 'M0 -30L7 -11L27 -15L13 1L24 21L4 13L-5 30L-9 10L-29 8L-13 -5L-21 -24L-4 -13Z',
  sun: 'M-22 0A22 22 0 1 0 22 0A22 22 0 1 0 -22 0Z',
  bird: 'M-26 -6C-14 -8 -6 -2 0 4C6 -2 14 -8 26 -6C16 -2 8 6 2 14L0 22L-2 14C-8 6 -16 -2 -26 -6Z',
  blob: 'M-24 -8C-22 -24 2 -28 14 -20C28 -12 26 8 16 18C6 28 -14 26 -22 14C-28 6 -26 0 -24 -8Z',
  wave: 'M0 64C20 52 40 76 60 64C80 52 100 76 120 64C140 52 160 76 180 64L180 100L0 100Z',
  halfTall: 'M90 0H180V300H90Z',
}
const C = { cobalt: '#3B57F0', coral: '#FF6B4A', lemon: '#FFD23F', paper: '#F3F2EE', green: '#2E9E6A', pink: '#F7A8B8', ink: '#111114', sky: '#9CC3F5' }

export interface Shape {
  d: string
  fill: string
  /** translate x, y; scale; rotate (degrees), as the canvas's transforms. */
  at: [number, number, number, number]
}
export interface Template {
  name: string
  category: string
  bg: string
  shapes: Shape[]
  text: Partial<TextLook> & { content: string }
}

const sh = (d: keyof typeof S, fill: string, at: [number, number, number, number] = [0, 0, 1, 0]): Shape => ({ d: S[d], fill, at })
const display: Partial<TextLook> = { font: 'Bricolage Grotesque', weight: 800, lineHeight: 0.95, shadow: null }
const italic: Partial<TextLook> = { font: 'Bricolage Grotesque', weight: 700, italic: true, lineHeight: 1.05, shadow: null }

// Text sizes are the canvas's tile sizes (180 px wide) scaled to a 1080-wide frame (×6).
export const TEMPLATES: Template[] = [
  { name: 'Product drop', category: 'Ads', bg: C.paper, shapes: [sh('blob', C.coral, [90, 158, 3, 0]), sh('star', C.ink, [142, 52, 0.7, 10])], text: { ...display, content: 'NEW\nDROP', size: 240, color: C.ink, letterSpacing: -5 } },
  { name: 'Before / after', category: 'Ads', bg: C.green, shapes: [sh('halfTall', C.paper)], text: { ...display, content: 'BEFORE      AFTER', size: 90, color: C.ink, letterSpacing: 5 } },
  { name: 'Gift guide', category: 'Celebrations', bg: C.pink, shapes: [sh('star', C.lemon, [44, 58, 1.3, 0]), sh('star', C.coral, [138, 248, 1.5, 18]), sh('sun', C.cobalt, [146, 100, 0.5, 0])], text: { ...display, content: 'GIFT\nIDEA', size: 240, color: C.ink, letterSpacing: -5 } },
  { name: 'Trip recap', category: 'Travel', bg: C.cobalt, shapes: [sh('leaf', C.coral, [56, 222, 2.2, -14]), sh('sun', C.lemon, [136, 62, 1.1, 0]), sh('bird', C.ink, [60, 66, 0.8, -6])], text: { ...display, content: 'TRIP\nRECAP', size: 204, color: C.paper, letterSpacing: -4 } },
  { name: 'Day in my life', category: 'Photos', bg: C.sky, shapes: [sh('leaf', C.green, [44, 236, 1.8, -12]), sh('sun', C.lemon, [138, 66, 1, 0]), sh('bird', C.ink, [66, 62, 0.6, 0])], text: { ...italic, content: 'a day in\nmy life', size: 168, color: C.ink } },
  { name: 'Podcast clip', category: 'Music', bg: C.coral, shapes: [sh('sun', C.ink, [90, 74, 1.3, 0]), sh('wave', '#3A1C15', [0, 206, 1, 0])], text: { ...italic, content: '“best advice\nI ever got”', size: 138, color: C.ink } },
]
export const TEMPLATE_CATEGORIES = ['All', 'Ads', 'Travel', 'Celebrations', 'Music', 'Photos']

/** The artwork at w × h, covering the frame from the 180 × 300 art (centred, like the tiles). */
export async function drawCard(t: Template, w: number, h: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d')!
  g.fillStyle = t.bg
  g.fillRect(0, 0, w, h)
  const k = Math.max(w / 180, h / 300)
  g.translate((w - 180 * k) / 2, (h - 300 * k) / 2)
  g.scale(k, k)
  for (const s of t.shapes) {
    g.save()
    const [x, y, sc, rot] = s.at
    g.translate(x, y)
    g.rotate((rot * Math.PI) / 180)
    g.scale(sc, sc)
    g.fillStyle = s.fill
    g.fill(new Path2D(s.d))
    g.restore()
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** A new project from the template: the card on the video track, its headline as text over it. */
export async function startFromTemplate(t: Template) {
  await newProject(t.name, '9:16')
  const snap = getState().snap
  if (!snap) return
  const { width, height } = snap.project
  const png = await drawCard(t, width, height)
  const sep = snap.dir.includes('\\') ? '\\' : '/'
  const file = `${snap.dir}${sep}stickers${sep}card-${t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`
  const w = await window.studio.files.writeAsset(file, png)
  if ('error' in w) throw new Error(w.error)
  const imp = await call<{ imported: string[] }>('media.import', { paths: [w.out] })
  const mediaId = imp?.imported?.[0]
  if (mediaId) await call('timeline.insert', { mediaId, atUs: 0 })
  seek(0)
  await addText({
    font: 'Bricolage Grotesque',
    size: 96,
    weight: 800,
    color: '#FFFFFF',
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: 0,
    case: 'none',
    stroke: null,
    background: null,
    shadow: null,
    italic: false,
    underline: false,
    preset: t.name,
    ...t.text,
  } as TextLook)
}
