// Text styles: the plain text the T key adds, the ad and title looks, the caption styles, and
// the Text tab's preset styles (CapCut's set). Sizes are for a 1080-wide frame and scale with
// the project. The swatches show each style with specCss(), from the same spec that gets drawn.

import type { CSSProperties } from 'react'
import type { TextLook } from './textRender'
import { withAlpha } from './textRender'
import { nearestWeight } from './textFonts'

const SHADOW = { color: '#00000099', blur: 12, x: 0, y: 4 }

const base = (o: Partial<TextLook>): TextLook => ({
  content: 'Your text',
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
  shadow: SHADOW,
  italic: false,
  underline: false,
  ...o,
})

/** What T adds: CapCut's default text, white in its System font with nothing around it. */
export const DEFAULT_TEXT = base({ preset: 'Text', content: 'Default text', font: 'Metropolis', weight: 500, size: 80, shadow: null })

export const TEXT_FOR_ADS: TextLook[] = [
  base({ preset: 'Price', content: '699 kr', size: 150 }),
  base({ preset: 'Offer bar', content: 'Fri frakt · 100 dagars garanti', font: 'IBM Plex Sans', weight: 600, size: 46, color: '#111114', background: { color: '#E8C050', opacity: 1, radius: 4, padding: 26 }, shadow: null }),
  base({ preset: 'Button', content: 'Köp nu  →', font: 'IBM Plex Sans', weight: 600, size: 56, background: { color: '#3B57F0', opacity: 1, radius: 10, padding: 42 }, shadow: null }),
  base({ preset: 'Countdown', content: 'Slutar om 02:14:09', font: 'IBM Plex Mono', weight: 600, size: 52, background: { color: '#000000', opacity: 0.55, radius: 2, padding: 24 }, shadow: null }),
  base({ preset: 'Checklist', content: '✓ Värme   ✓ Trådlös   ✓ 3 lägen', font: 'IBM Plex Sans', weight: 600, size: 44 }),
  base({ preset: 'Quote', content: '“The best gift this year”', font: 'Playfair Display', weight: 400, italic: true, size: 70 }),
]

export const TEXT_TITLES: TextLook[] = [
  base({ preset: 'Bold', content: 'Big news', size: 130 }),
  base({ preset: 'Boxed', content: 'NYHET', size: 88, color: '#111114', background: { color: '#FFFFFF', opacity: 1, radius: 0, padding: 24 }, shadow: null }),
  base({ preset: 'Caption', content: 'som riktiga händer', font: 'IBM Plex Sans', weight: 600, size: 56, shadow: { color: '#000000E6', blur: 8, x: 0, y: 2 } }),
  base({ preset: 'Accent', content: 'Fri frakt', size: 110, color: '#E8C050' }),
  base({ preset: 'Outline', content: 'NY', size: 180, color: '#FFFFFF00', stroke: { color: '#FFFFFF', width: 3 }, shadow: null }),
  base({ preset: 'Name tag', content: 'Anna, 34 · Malmö', font: 'IBM Plex Sans', weight: 500, size: 40, background: { color: '#000000', opacity: 0.6, radius: 4, padding: 18 }, shadow: null }),
]

export const TEXT_PRESETS = [...TEXT_FOR_ADS, ...TEXT_TITLES]

/** Caption styles (the Captions tab's tiles). */
export const CAPTION_STYLES: Record<string, TextLook> = {
  Clean: base({ preset: 'Clean', content: '', font: 'Metropolis', weight: 600, size: 58, lineHeight: 1.2, shadow: { color: '#000000E6', blur: 10, x: 0, y: 2 } }),
  Outline: base({ preset: 'Outline', content: '', font: 'IBM Plex Sans', weight: 700, size: 60, lineHeight: 1.2, stroke: { color: '#000000', width: 5 }, shadow: null }),
  'Word pop': base({ preset: 'Word pop', content: '', font: 'Bricolage Grotesque', weight: 800, size: 60, lineHeight: 1.3, color: '#111114', background: { color: '#E8C050', opacity: 1, radius: 6, padding: 16 }, shadow: null }),
  Box: base({ preset: 'Box', content: '', font: 'IBM Plex Sans', weight: 600, size: 56, lineHeight: 1.3, background: { color: '#000000', opacity: 0.7, radius: 8, padding: 18 }, shadow: null }),
}

/**
 * The Text tab's preset styles, CapCut's set in its order: colour, outline, shadow or glow, and
 * box only (the font, size and words stay). Outline widths, shadows and boxes are for 100 px
 * text and scale with the text's size (presetLook).
 */
type Style = Pick<TextLook, 'color' | 'stroke' | 'shadow' | 'background'>
const st = (color: string, o: Partial<Style> = {}): Style => ({ color, stroke: null, shadow: null, background: null, ...o })
const line = (color: string) => ({ color, width: 7 })
// CapCut's box presets: one box round all the lines, corners 0.4, height and width 0.28 (in
// Studio's terms as capcutImport maps them, for 100 px text).
const box = (color: string) => ({ color, opacity: 1, radius: 60, padding: 73, padY: 56, block: true })
const glow = (color: string) => ({ color, blur: 18, x: 0, y: 0 })
const drop = (color: string) => ({ color, blur: 0, x: 5, y: 5 })

export const STYLE_PRESETS: { name: string; style: Style }[] = [
  { name: 'None', style: st('#FFFFFF') },
  { name: 'White, black outline', style: st('#FFFFFF', { stroke: line('#000000') }) },
  { name: 'Black, white outline', style: st('#000000', { stroke: line('#FFFFFF') }) },
  { name: 'White, shadow', style: st('#FFFFFF', { shadow: { color: '#000000E6', blur: 2, x: 4, y: 5 } }) },
  { name: 'White, soft outline', style: st('#FFFFFF', { stroke: { color: '#000000', width: 3 }, shadow: { color: '#000000', blur: 14, x: 0, y: 0 } }) },
  { name: 'Yellow, black outline', style: st('#F4FA00', { stroke: line('#000000') }) },
  { name: 'Red, white outline', style: st('#EC1C1C', { stroke: line('#FFFFFF') }) },
  { name: 'Orange, white outline', style: st('#FB8300', { stroke: line('#FFFFFF') }) },
  { name: 'Blue, white outline', style: st('#008CFB', { stroke: line('#FFFFFF') }) },
  { name: 'Green, black outline', style: st('#00FB1C', { stroke: line('#000000') }) },
  { name: 'Black on grey', style: st('#000000', { background: box('#9C9C9C') }) },
  { name: 'White on grey', style: st('#FFFFFF', { background: box('#9C9C9C') }) },
  { name: 'Black on yellow', style: st('#000000', { background: box('#FCDB00') }) },
  { name: 'White on purple', style: st('#FFFFFF', { background: box('#8303FB') }) },
  { name: 'Purple on white', style: st('#8303FB', { background: box('#FFFFFF') }) },
  { name: 'Black on white', style: st('#000000', { background: box('#FFFFFF') }) },
  { name: 'White on black', style: st('#FFFFFF', { background: box('#000000') }) },
  { name: 'Green on black', style: st('#00FB1C', { background: box('#000000') }) },
  { name: 'Black, green shadow', style: st('#000000', { shadow: drop('#00FB1C') }) },
  { name: 'Gold, red shadow', style: st('#F3C30B', { shadow: drop('#B21A1A') }) },
  { name: 'Pink glow', style: st('#FFFFFF', { shadow: glow('#FF2D6F') }) },
  { name: 'Yellow glow', style: st('#FFFFFF', { shadow: glow('#FFD400') }) },
  { name: 'Green glow', style: st('#FFFFFF', { shadow: glow('#1BE61B') }) },
]

/** A preset style for text `size` px tall: its outline, shadow and box scaled to it. */
export function presetLook(style: Style, size: number): Style {
  const k = size / 100
  const r = (v: number) => Math.round(v * k * 10) / 10
  return {
    color: style.color,
    stroke: style.stroke && { ...style.stroke, width: Math.max(1, r(style.stroke.width)) },
    shadow: style.shadow && { ...style.shadow, blur: r(style.shadow.blur), x: r(style.shadow.x), y: r(style.shadow.y) },
    background: style.background && { ...style.background, radius: r(style.background.radius), padding: r(style.background.padding), padY: style.background.padY === undefined ? undefined : r(style.background.padY) },
  }
}

/** Which preset style a look has (by its colours and what it has around it), if any. */
export function presetOf(look: TextLook): string | undefined {
  const same = (a?: string | null, b?: string | null) => (a ?? '').toUpperCase() === (b ?? '').toUpperCase()
  return STYLE_PRESETS.find(({ style: p }) => {
    if (!same(p.color, look.color) || !p.stroke !== !look.stroke || !p.shadow !== !look.shadow || !p.background !== !look.background) return false
    return same(p.stroke?.color, look.stroke?.color) && same(p.shadow?.color, look.shadow?.color) && same(p.background?.color, look.background?.color)
  })?.name
}

/** A spec scaled from the 1080-wide design size to a frame `width` wide. */
export function scaleSpec(s: TextLook, width: number): TextLook {
  const k = width / 1080
  if (Math.abs(k - 1) < 0.001) return { ...s }
  const r = (v: number) => Math.round(v * k * 10) / 10
  return {
    ...s,
    size: r(s.size),
    letterSpacing: r(s.letterSpacing),
    stroke: s.stroke && { ...s.stroke, width: r(s.stroke.width) },
    background: s.background && { ...s.background, radius: r(s.background.radius), padding: r(s.background.padding), padY: s.background.padY === undefined ? undefined : r(s.background.padY) },
    shadow: s.shadow && { ...s.shadow, blur: r(s.shadow.blur), x: r(s.shadow.x), y: r(s.shadow.y) },
  }
}

/** CSS that shows a spec in a tile, `k` times its design size. */
export function specCss(s: TextLook, k: number): CSSProperties {
  const px = (v: number) => `${Math.max(0, v * k).toFixed(2)}px`
  return {
    fontFamily: `"${s.font}", "IBM Plex Sans", sans-serif`,
    fontWeight: nearestWeight(s.font, s.weight),
    fontStyle: s.italic ? 'italic' : 'normal',
    fontSize: px(s.size),
    lineHeight: s.lineHeight,
    letterSpacing: px(s.letterSpacing),
    textTransform: s.case === 'upper' ? 'uppercase' : s.case === 'lower' ? 'lowercase' : 'none',
    textDecoration: s.underline ? 'underline' : 'none',
    color: s.color,
    whiteSpace: 'pre',
    background: s.background ? withAlpha(s.background.color, s.background.opacity) : undefined,
    padding: s.background ? `${px(s.background.padY ?? s.background.padding * 0.55)} ${px(s.background.padding)}` : undefined,
    borderRadius: s.background ? px(s.background.radius) : undefined,
    WebkitTextStroke: s.stroke ? `${px(s.stroke.width * 2)} ${s.stroke.color}` : undefined,
    paintOrder: s.stroke ? 'stroke fill' : undefined,
    textShadow: s.shadow ? `${px(s.shadow.x)} ${px(s.shadow.y)} ${px(s.shadow.blur)} ${s.shadow.color}` : undefined,
  }
}
