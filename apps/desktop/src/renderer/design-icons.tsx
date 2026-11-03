// The icon paths drawn on the Library and Inspector boards (16 × 16 grid). Some differ
// from icons.tsx (folder, video, import), so the panels use these to match the boards.

export const LIB_ICONS = {
  media: 'M2 3.5h12v9H2z M2 10.5l3.5-3 3 2.5 2-1.5 3.5 3',
  audio: 'M6 12V3.5l7-1.5v8.5 M6 12a2 2 0 1 1-2-2 2 2 0 0 1 2 2z M13 10.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2z',
  text: 'M3 4.5V3h10v1.5 M8 3v10 M6 13h4',
  stickers: 'M13.5 8A5.5 5.5 0 1 1 8 2.5h5.5z M6 6.5h.01 M10 6.5h.01 M5.5 9.5c1.4 1.4 3.6 1.4 5 0',
  effects: 'M3 13l7-7 M9.5 2.5v2 M13.5 6.5h-2 M12 4l1-1 M5.5 3v1.5 M3 5.5h1.5',
  transitions: 'M2.5 4l5.5 4-5.5 4z M13.5 4L8 8l5.5 4z',
  captions: 'M2 3.5h12v9H2z M4.5 7.5h3 M9 7.5h2.5 M4.5 10h5',
  translations: 'M2 4h6.5 M5.25 2.5V4 M7.25 4c-.5 2.5-2.2 4.4-5 5.5 M3.5 6c.8 1.5 2 2.6 3.5 3.3 M8.5 14l2.75-6.5L14 14 M9.4 12h3.7',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9 M2.5 2.5v2.5H5 M8 5v3l2 1.5',
  import: 'M8 2v8 M5 7l3 3 3-3 M2.5 11v2.5h11V11',
  mic: 'M8 2a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0V4a2 2 0 0 1 2-2z M4 7.5a4 4 0 0 0 8 0 M8 11.5V14',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  video: 'M2 4h9v8H2z M11 7l3-2v6l-3-2',
  layers: 'M8 2l6 3.5-6 3.5-6-3.5z M2 9l6 3.5 6-3.5',
  font: 'M2 13l4-10 4 10 M3.5 9.5h5 M11 8.5a2 2 0 1 1 0 4.5 2 2 0 0 1 0-4.5z M13 8.5V13',
  cut: 'M8 2.5v11 M4.5 6l-2 2 2 2 M11.5 6l2 2-2 2',
  plus: 'M8 3v10 M3 8h10',
  scale: 'M2 14l5-5 M2 10v4h4 M14 2l-5 5 M14 6V2h-4',
  speaker: 'M2.5 6h2.5l3.5-3v10L5 10H2.5z M11 6a3 3 0 0 1 0 4',
  download: 'M8 2v8 M5 7l3 3 3-3 M2.5 13.5h11',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5',
  check: 'M3 8.5l3 3 7-7',
  chevron: 'M4 6l4 4 4-4',
  prev: 'M10 3L5 8l5 5',
  next: 'M6 3l5 5-5 5',
  play: 'M4 2v12l10-6z',
  stop: 'M4 4h8v8H4z',
} as const

export const INSP_ICONS = {
  flipH: 'M8 2v12 M6 4.5L2.5 11.5H6z M10 4.5l3.5 7H10z',
  flipV: 'M2 8h12 M4.5 6L11.5 2.5V6z M4.5 10l7 3.5V10z',
  none: 'M3 3l10 10 M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  line: 'M2 11L14 5',
  mirror: 'M2 6h12 M2 10h12',
  circle: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  rect: 'M3 4h10v8H3z',
  heart: 'M8 13C2 9 3 3.5 8 6c5-2.5 6 3 0 7z',
  bold: 'M4 3h4.5a2.5 2.5 0 0 1 0 5H4z M4 8h5a2.5 2.5 0 0 1 0 5H4z',
  italic: 'M7 3h5 M4 13h5 M10 3L6 13',
  under: 'M4 3v4a4 4 0 0 0 8 0V3 M3 14h10',
  left: 'M2 4h12 M2 8h8 M2 12h10',
  center: 'M2 4h12 M4 8h8 M3 12h10',
  right: 'M2 4h12 M6 8h8 M4 12h10',
  reset: 'M3 8a5 5 0 1 0 1.5-3.5 M3 2.5v2.5h2.5',
  diamond: 'M8 2l6 6-6 6-6-6z',
} as const

/** A board icon: a 1.5 px line drawing on the 16 px grid (or filled, for play and stop). */
export function DIcon({ d, size = 16, width = 1.5, filled, stroke }: { d: string; size?: number; width?: number; filled?: boolean; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : (stroke ?? 'currentColor')} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
