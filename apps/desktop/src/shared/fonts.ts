// The fonts Studio draws text with: names, weights and what kind of lettering each is. The
// files are bundled by the page (renderer/textFonts.ts); the visual dub's reader (main) offers
// Claude these names to say which one a video's lettering is closest to.

export interface FontDef {
  family: string
  /** The name the font list shows, when it isn't the family's. */
  label?: string
  /** What it's good for, shown in the list. */
  use: string
  weights: number[]
  /** What kind of lettering it is (the visual dub matches like with like). */
  kind: 'sans' | 'serif' | 'script' | 'display' | 'mono'
}

export const FONTS: FontDef[] = [
  { family: 'Metropolis', label: 'System', use: 'CapCut’s own', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Bricolage Grotesque', use: 'Titles', weights: [400, 600, 700, 800], kind: 'display' },
  { family: 'IBM Plex Sans', use: 'Captions', weights: [400, 500, 600, 700], kind: 'sans' },
  { family: 'IBM Plex Mono', use: 'Numbers, countdowns', weights: [400, 600], kind: 'mono' },
  { family: 'Montserrat', use: 'Clean headlines', weights: [400, 600, 800], kind: 'sans' },
  { family: 'Poppins', use: 'Friendly', weights: [400, 600, 800], kind: 'sans' },
  { family: 'Anton', use: 'Tall and loud', weights: [400], kind: 'display' },
  { family: 'Bebas Neue', use: 'Tall caps', weights: [400], kind: 'display' },
  { family: 'Playfair Display', use: 'Quotes', weights: [400, 700], kind: 'serif' },
  { family: 'Caveat', use: 'Handwritten', weights: [400, 700], kind: 'script' },
  { family: 'Permanent Marker', use: 'Marker pen', weights: [400], kind: 'script' },
  { family: 'TikTok Sans', use: 'TikTok’s own', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Inter', use: 'Neutral UI', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Roboto', use: 'Android’s own', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Open Sans', use: 'Plain and open', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Lato', use: 'Warm sans', weights: [400, 700, 900], kind: 'sans' },
  { family: 'Nunito Sans', use: 'Soft sans', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'Figtree', use: 'Geometric, friendly', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'DM Sans', use: 'Low-contrast geometric', weights: [400, 500, 600, 700, 800], kind: 'sans' },
  { family: 'EB Garamond', use: 'Classic book serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Libre Baskerville', use: 'Wide book serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Lora', use: 'Soft serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Crimson Pro', use: 'Old-style serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Source Serif 4', use: 'Modern serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'PT Serif', use: 'Sturdy serif', weights: [400, 700], kind: 'serif' },
  { family: 'Merriweather', use: 'Screen serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Tinos', use: 'Times-style serif', weights: [400, 700], kind: 'serif' },
  { family: 'Gelasio', use: 'Georgia-style serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Cormorant Garamond', use: 'Elegant display serif', weights: [400, 500, 600, 700], kind: 'serif' },
  { family: 'Libre Caslon Text', use: 'Caslon serif', weights: [400, 700], kind: 'serif' },
]
