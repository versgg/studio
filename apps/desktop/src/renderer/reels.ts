// Instagram Reels as Meta draws it in Ads Manager (View preview › Instagram Reels), measured
// from the user's own preview on 2026-11-01 against the video frame under it: the phone shows
// a 9:16 video at its full height, 532 × 1038 of it, so 4.4 % of the width goes off each side.
// Everything below is in that phone's pixels; the player scales it to the frame.

export const PHONE_W = 532
export const PHONE_H = 1038
/** The share of a 9:16 frame's width Reels leaves off each side. */
export const TRIM = (1 - PHONE_W / PHONE_H / (9 / 16)) / 2

/** Whether the project is the 9:16 shape Reels fills (the overlay and the export check need it). */
export const isReels = (w: number, h: number) => h > 0 && Math.abs(w / h - 9 / 16) < 0.01

/** What the app puts over the video, [x0, y0, x1, y1] in phone pixels. */
const COVERED: { name: string; box: [number, number, number, number] }[] = [
  { name: 'the Reels title', box: [0, 0, PHONE_W, 92] },
  { name: 'the Shop now card', box: [25, 700, 434, 859] },
  { name: 'the account and caption', box: [25, 888, 434, 1004] },
  { name: 'the like and share buttons', box: [470, 842, 509, 1002] },
]

/**
 * What a box on a 9:16 frame runs under, given as fractions of the frame's width and height
 * (left, top, right, bottom); null when it is clear. Pass `sides` false when the box's width
 * isn't known, so only its height is judged against the sides.
 */
export function reelsCovers(x0: number, y0: number, x1: number, y1: number, sides = true): string | null {
  const px = (f: number) => ((f - TRIM) / (1 - 2 * TRIM)) * PHONE_W
  const [a, b, c, d] = [px(x0), y0 * PHONE_H, px(x1), y1 * PHONE_H]
  if (sides && (a < 0 || c > PHONE_W)) return 'the cut-off sides'
  for (const z of COVERED) if (a < z.box[2] && c > z.box[0] && b < z.box[3] && d > z.box[1]) return z.name
  return null
}

/** The ad's own words on the preview: the account, the card's headline and the first line of the text. */
export interface ReelsText {
  account: string
  headline: string
  text: string
}

const KEY = 'studio.reels.v1'
// Placeholder words, until the user types their own.
const FIRST: ReelsText = { account: 'yourbrand', headline: 'Your headline', text: 'Your ad text…' }

interface Saved {
  last?: Partial<ReelsText>
  dirs?: Record<string, Partial<ReelsText>>
}

function saved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved
  } catch {
    return {}
  }
}

/** The project's words, else the ones typed last (a new project of the same brand), else the first ad's. */
export function reelsText(dir: string | undefined): ReelsText {
  const s = saved()
  return { ...FIRST, ...s.last, ...(dir ? s.dirs?.[dir] : undefined) }
}

export function saveReelsText(dir: string | undefined, t: ReelsText) {
  const s = saved()
  s.last = t
  if (dir) s.dirs = { ...s.dirs, [dir]: t }
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage full or off: the words still show until the app closes.
  }
}

let ruler: CanvasRenderingContext2D | null = null
/** `text` cut to `max` phone pixels in `font`, ending in `more` when anything was cut or `always` is set. */
export function fitLine(text: string, font: string, max: number, more = '…', always = false): string {
  ruler ??= document.createElement('canvas').getContext('2d')
  const first = text.split('\n')[0].trim()
  const cut = always || first !== text.trim()
  if (!ruler) return first + (cut ? more : '')
  ruler.font = font
  const fits = (s: string) => ruler!.measureText(s).width <= max
  if (fits(first + (cut ? more : ''))) return first + (cut ? more : '')
  let n = first.length
  while (n > 0 && !fits(first.slice(0, n).trimEnd() + more)) n--
  return first.slice(0, n).trimEnd() + more
}
