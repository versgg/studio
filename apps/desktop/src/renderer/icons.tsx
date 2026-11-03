// 16 px line icons, 1.5 px stroke, drawn to match the canvas.

const PATHS = {
  media: 'M2 3.5h12v9H2z M2 10.5l3.5-3 3 2.5 2-1.5 3.5 3',
  audio: 'M6 12V3.5l7-1.5v8.5 M6 12a2 2 0 1 1-2-2 2 2 0 0 1 2 2z M13 10.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2z',
  text: 'M3 4.5V3h10v1.5 M8 3v10 M6 13h4',
  stickers: 'M13.5 8A5.5 5.5 0 1 1 8 2.5h5.5z M6 6.5h.01 M10 6.5h.01 M5.5 9.5c1.4 1.4 3.6 1.4 5 0',
  effects: 'M3 13l7-7 M9.5 2.5v2 M13.5 6.5h-2 M12 4l1-1 M5.5 3v1.5 M3 5.5h1.5',
  transitions: 'M2.5 4l5.5 4-5.5 4z M13.5 4L8 8l5.5 4z',
  captions: 'M2 3.5h12v9H2z M4.5 7.5h3 M9 7.5h2.5 M4.5 10h5',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9 M2.5 2.5v2.5H5 M8 5v3l2 1.5',
  plus: 'M8 3v10 M3 8h10',
  minus: 'M3 8h10',
  play: 'M5 3.2v9.6L12.5 8z',
  pause: 'M5 3.5v9 M11 3.5v9',
  stepBack: 'M11.5 4L6.5 8l5 4z M4.5 4v8',
  stepForward: 'M4.5 4l5 4-5 4z M11.5 4v8',
  toStart: 'M12.5 4L7.5 8l5 4z M7.5 4L2.5 8l5 4z',
  toEnd: 'M3.5 4l5 4-5 4z M8.5 4l5 4-5 4z',
  split: 'M8 2v12 M5.5 3.5H3.5v9h2 M10.5 3.5h2v9h-2',
  deleteLeft: 'M8 2v12 M10.5 3.5h2v9h-2 M3 8h2.5',
  deleteRight: 'M8 2v12 M5.5 3.5H3.5v9h2 M10.5 8H13',
  crop: 'M4.5 1.5v10h10 M1.5 4.5h10v10',
  mirror: 'M8 2v12 M6 4.5L2.5 11.5H6z M10 4.5l3.5 7H10z',
  rotate: 'M3.5 9a4.5 4.5 0 1 0 1.3-4.7 M3.5 2.5v3h3',
  mainMagnet: 'M2 5h4v6H2z M10 5h4v6h-4z M6 8h4',
  snapping: 'M8 1.5v13 M2 5h4v6H2 M14 5h-4v6h4',
  link: 'M6.75 9.25l2.5-2.5 M7.5 4.5l.9-.9a2.5 2.5 0 0 1 3.5 3.5l-.9.9 M8.5 11.5l-.9.9a2.5 2.5 0 0 1-3.5-3.5l.9-.9',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5',
  undo: 'M5.5 6.5H10a3 3 0 0 1 0 6H7 M5.5 6.5L8 4 M5.5 6.5L8 9',
  redo: 'M10.5 6.5H6a3 3 0 0 0 0 6h3 M10.5 6.5L8 4 M10.5 6.5L8 9',
  fit: 'M2.5 6V3.5H5 M11 3.5h2.5V6 M13.5 10v2.5H11 M5 12.5H2.5V10 M5.5 8h5',
  magnet: 'M4 2.5v5.5a4 4 0 0 0 8 0V2.5 M4 5.5h2.5 M9.5 5.5H12 M6.5 2.5v5.5a1.5 1.5 0 0 0 3 0V2.5',
  video: 'M2 4h8.5v8H2z M10.5 7l3.5-2v6l-3.5-2',
  image: 'M2.5 3h11v10h-11z M2.5 11l3.5-3.5 3 3 1.5-1.5 3 3 M10 6.5h.01',
  folder: 'M2 4.5V12.5h12V5.5H8L6.5 4H2z',
  folderPlus: 'M2 4.5V12.5h12V5.5H8L6.5 4H2z M8 7.5v3.5 M6.25 9.25h3.5',
  refresh: 'M13 8a5 5 0 1 1-1.46-3.54 M13.5 2.5v2.5H11',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M13.5 13.5l-3.3-3.3',
  external: 'M9.5 2.5h4v4 M13.5 2.5L8 8 M11.5 9.5v4h-9v-9h4',
  sidebar: 'M2 3h12v10H2z M6 3v10',
  chevronRight: 'M6 4l4 4-4 4',
  close: 'M4 4l8 8 M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  chevron: 'M4.5 6l3.5 3.5L11.5 6',
  export: 'M8 10V2.5 M5 5.5l3-3 3 3 M3 9v4.5h10V9',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, filled }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
