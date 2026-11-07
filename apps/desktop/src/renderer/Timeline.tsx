// The timeline: a DOM track area over the engine's project. Drags are previewed locally
// and sent as one command on release; the engine's next snapshot replaces the preview.
// The look follows the canvas (Main.dc.html): toolbar, 24 px ruler, 120 px track heads.

import { dubProgress } from './dub'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { Icon } from './icons'
import { keysFor } from './keymap'
import { setUi, useUi } from './ui-state'
import { clipMenu, openMenu, timelineMenu } from './ContextMenu'
import { addToTimeline, MEDIA_MIME } from './Library'
import { TEXT_MIME } from './LibraryTabs'
import { usePeaks, useStrip, type Peaks } from './media-cache'
import { DEFAULT_TEXT, scaleSpec } from './textPresets'
import { renderTextClip } from './textRender'
import {
  call,
  deleteSelection,
  deleteSide,
  exitSource,
  findClip,
  freezeFrame,
  getState,
  importPaths,
  mediaById,
  mirror,
  openCrop,
  redo,
  reverse,
  rotate,
  seek,
  setCover,
  setScrubbing,
  setState,
  setTrack,
  skim,
  splitAtPlayhead,
  toast,
  toggleLinkage,
  toggleMagnet,
  undo,
  useStore,
  useVmakeJob,
  vmakeProgress,
  type Clip,
  type Label,
  type Media,
  type Snapshot,
  type Track,
  type Us,
} from './store'

const HEAD_W = 120
const RULER_H = 24
const MAIN_H = 60
const AUDIO_H = 46
const GAP = 4
const PAD_TOP = 6
const PAD_BOTTOM = 12
const NEW_ROW_H = 34
/** How close to the panel's edge a drag starts scrolling the timeline, and its top speed (px a frame). */
const EDGE_PX = 40
const EDGE_SPEED = 18
const MIN_CLIP = 100_000
const SNAP_PX = 8
const S = 1_000_000
const MIN_PPS = 2
const MAX_PPS = 800
const SNAP_KEY = 'studio.snapping'
const SKIM_KEY = 'studio.skim'

// The canvas's 16 px timeline icons (1.5 px stroke).
const D = {
  cursor: 'M3.5 2.5l9 4.5-4 1.2-1.3 4.3z',
  split: 'M8 2.5v11 M4.5 6l-2 2 2 2 M11.5 6l2 2-2 2',
  trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 9h5.8l.6-9',
  freeze: 'M8 2v12 M2.8 5l10.4 6 M13.2 5L2.8 11',
  reverse: 'M5 3.5L2 6.5l3 3 M2 6.5h8a3.5 3.5 0 0 1 0 7H8',
  mirror: 'M8 2v12 M6 4.5L2.5 11.5H6z M10 4.5l3.5 7H10z',
  crop: 'M4 1.5V12h10.5 M1.5 4H12v10.5',
  undo: 'M5.5 9L2.5 6l3-3 M2.5 6h7a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10.5 9l3-3-3-3 M13.5 6h-7a3.5 3.5 0 0 0 0 7H9',
  magnet: 'M4 2.5v5.5a4 4 0 0 0 8 0V2.5 M4 5h2.5 M9.5 5H12',
  loop: 'M8 8C6.5 6 5.4 5 4 5a3 3 0 0 0 0 6c1.4 0 2.5-1 4-3s2.6-3 4-3a3 3 0 0 1 0 6c-1.4 0-2.5-1-4-3z',
  snap: 'M2 13.5h12 M5 13.5V7 M11 13.5V3.5',
  link: 'M6.5 9.5a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7 M9.5 6.5a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  height: 'M2 3h12 M2 13h12 M8 5.5v5 M6 7.5l2-2 2 2 M6 8.5l2 2 2-2',
  zoom: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5 M5 7h4 M7 5v4',
  video: 'M2 4h9v8H2z M11 7l3-2v6l-3-2',
  audio: 'M6 12V3.5l7-1.5v8.5 M6 12a2 2 0 1 1-2-2 2 2 0 0 1 2 2z M13 10.5a2 2 0 1 1-2-2 2 2 0 0 1 2 2z',
  speaker: 'M2.5 6h2.5l3.5-3v10L5 10H2.5z M11 6a3 3 0 0 1 0 4',
  muted: 'M2.5 6h2.5l3.5-3v10L5 10H2.5z M11 6.5l3 3 M14 6.5l-3 3',
  lock: 'M4 7.5h8v6H4z M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  eyeOff: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M2.5 2.5l11 11',
  transition: 'M2.5 4l5.5 4-5.5 4z M13.5 4L8 8l5.5 4z',
}
const Svg = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

// Track colours from the canvas: colour says what a track holds.
const TONES = {
  video: { icon: '#C4C4CA' },
  voice: { icon: '#66A3FF', head: '#66A3FF', body: '#85B5FF', peak: '#142133', avg: '#4F5966' },
  music: { icon: '#34B494', head: '#34B494', body: '#5DC3A9', peak: '#0A241E', avg: '#475B56' },
}
type Tone = 'voice' | 'music'

// Tracks over the main track, by what they hold (docs/contract-v2.md); bar colours as on the canvas.
type Role = 'text' | 'captions' | 'sticker' | 'overlay' | 'adjust'
const ROLES: Record<Role, { name: string; icon: string; color: string; light: string; bar: boolean }> = {
  text: { name: 'Text', icon: 'M3 4.5V3h10v1.5 M8 3v10 M6 13h4', color: '#E8C050', light: '#F6DE94', bar: true },
  captions: { name: 'Captions', icon: 'M2 3.5h12v9H2z M4.5 7.5h3 M9 7.5h2.5 M4.5 10h5', color: '#9996FC', light: '#C9C7FF', bar: true },
  sticker: { name: 'Sticker', icon: 'M13.5 8A5.5 5.5 0 1 1 8 2.5h5.5z M6 6.5h.01 M10 6.5h.01 M5.5 9.5c1.4 1.4 3.6 1.4 5 0', color: '#DA8CCC', light: '#ECBBE2', bar: true },
  overlay: { name: 'Overlay', icon: 'M2 4h9v8H2z M11 7l3-2v6l-3-2', color: '#C4C4CA', light: '#EDEDEF', bar: false },
  adjust: { name: 'Adjustment', icon: 'M8 2.5a5.5 5.5 0 1 0 0 11z M8 2.5a5.5 5.5 0 0 1 0 11', color: '#74BE59', light: '#A6DB92', bar: true },
}
const roleOf = (t: Track): Role => (t.role && t.role in ROLES ? (t.role as Role) : 'overlay')
const BAR_H = 26
const OVERLAY_H = 40
/** What a clip off the main track moves among: the sound rows, or the rows over the video of its role. */
type Lane = Role | 'audio'
/** A text clip's length when it's added (the engine's default for text). */
const TEXT_US = 3_000_000
/** The ghost of the plain text clip "Add text" makes, while it's dragged in from the library. */
const NEW_TEXT: Clip = { id: 'new-text', mediaId: '', startUs: 0, inUs: 0, durationUs: TEXT_US, volume: 1, fit: 'fill', text: DEFAULT_TEXT }

/** Commands the menus and shortcuts send to the timeline. */
export const timelineApi = {
  fit: () => {},
  zoom: (_factor: number) => {},
  toggleSnap: () => {},
  setHeight: (_scale: number) => {},
  fitHeight: () => {},
}

interface Row {
  id: string
  kind: 'main' | 'audio' | 'overlay' | 'new'
  track?: Track
  top: number
  height: number
  label: string
  tone?: Tone
  role?: Role
}

type Drag =
  | { type: 'scrub'; snapUs: Us | null }
  /** A fade's handle on a sound clip, dragged: the fade (`now`, was `base`, up to `max`) ends under the pointer; `edge` is the clip's edge along the content. */
  | { type: 'fade'; clipId: string; side: 'in' | 'out'; edge: number; base: Us; max: Us; now: Us }
  /** In the content (not the window), so the box keeps its start while the timeline scrolls either way. */
  | { type: 'box'; x0: number; y0: number; x1: number; y1: number; started: boolean; base: string[] }
  | ({
      type: 'move'
      clipId: string
      main: boolean
      free: boolean
      trackId: string
      x0: number
      y0: number
      grabUs: Us
      started: boolean
      atUs: Us
      /** What it moves among off the main track (a main-track picture lifts onto the overlay rows). */
      lane: Lane
      snapUs: Us | null
      /** A video or picture, which can go up off the main track and (from an overlay track) back down. */
      picture: boolean
      /** Crossing over: up onto a track over the video, or down into the main track. */
      dest: 'over' | 'main' | null
      /** Where it started, and the rest of the selection moving with it (each on its own track, by the same time). */
      fromUs: Us
      group: { id: string; startUs: Us; durationUs: Us }[]
      /** The rest of a selection on the main track, held with this one: lifted up together, each `offUs` from it (as they sit now). */
      lift: { id: string; offUs: Us; durationUs: Us }[]
    } & Landing)
  | {
      type: 'trim'
      clipId: string
      ripple: boolean
      edge: 'left' | 'right'
      /** Along the content, so the edge keeps up with the pointer while the timeline scrolls. */
      x0: number
      clip: Clip
      /** None for text clips and adjustment layers, which can be any length. */
      media?: Media
      /** On a track over the video: where its neighbours on that track begin and end, which its edges stop at. */
      room: [Us, Us] | null
      d: Us
      snapUs: Us | null
    }

/**
 * Where a dragged clip lands: a row (`rowId`), or a new track made at `newAt` in the
 * project's track list, shown as a line at `line` (the rows' y) between two rows, or for
 * sound as the empty row under them (`line` null).
 */
interface Landing {
  rowId: string
  newAt: number | null
  line: number | null
}

interface Placed {
  clip: Clip
  start: Us
  dur: Us
  inUs: Us
  hole?: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * True if a clip fits on `track` from `start` among its other clips (the engine's `fits`):
 * on a sound track two clips may overlap by as much as both their fades cover.
 */
function fitsOn(track: Track, clip: { id: string; durationUs: Us; fadeInUs?: Us; fadeOutUs?: Us }, start: Us): boolean {
  const end = start + clip.durationUs
  return track.clips.every((o) => {
    const overlap = Math.min(end, o.startUs + o.durationUs) - Math.max(start, o.startUs)
    if (o.id === clip.id || overlap <= 0) return true
    const a = { start: o.startUs, end: o.startUs + o.durationUs, in: o.fadeInUs ?? 0, out: o.fadeOutUs ?? 0 }
    const b = { start, end, in: clip.fadeInUs ?? 0, out: clip.fadeOutUs ?? 0 }
    const [first, second] = a.start < b.start ? [a, b] : [b, a]
    return track.kind === 'audio' && second.start > first.start && second.end > first.end && overlap <= first.out && overlap <= second.in
  })
}

/** Where a clip dropped at `at` lands on the magnetic main track (same rule as the engine). */
function mainIndexAt(clips: { start: Us; dur: Us }[], at: Us): number {
  const i = clips.findIndex((c) => at < c.start + c.dur / 2)
  return i < 0 ? clips.length : i
}

function packMain(items: Placed[]): Placed[] {
  let t = 0
  return items.map((p) => {
    const out = { ...p, start: t }
    t += p.dur
    return out
  })
}

/**
 * A clip's in point (source time), length and start after moving `edge` by d (timeline
 * time), within its source. A sped-up clip reads `speed` source seconds per second; a
 * reversed one plays its source window [in, in + span] from the end. A still (a picture,
 * a text clip, an adjustment layer) can be any length.
 */
function trimmed(drag: Extract<Drag, { type: 'trim' }>, d: Us): { inUs: Us; dur: Us; start: Us } {
  const { clip, room } = drag
  const source = drag.media?.kind === 'image' ? undefined : drag.media
  const sp = clip.speed ?? 1
  const image = !source
  const inUs = clip.inUs
  const dur = clip.durationUs
  // How far the edge can go out, in timeline time: to the source's start or its end.
  const toStart = image ? Infinity : inUs / sp
  const toEnd = source ? Math.max(0, source.durationUs - inUs) / sp - dur : Infinity
  if (drag.edge === 'left') {
    const lo = image ? -dur : -(clip.reverse ? toEnd : toStart)
    const dd = clamp(d, Math.max(lo, drag.ripple ? -Infinity : -clip.startUs, room ? room[0] - clip.startUs : -Infinity), dur - MIN_CLIP)
    // Forwards, the left edge moves the in point; reversed, it moves the window's end.
    return { inUs: image || clip.reverse ? inUs : Math.max(0, inUs + dd * sp), dur: dur - dd, start: clip.startUs + dd }
  }
  const out = clip.reverse ? toStart : toEnd
  const dd = clamp(d, MIN_CLIP - dur, Math.min(image ? Number.MAX_SAFE_INTEGER / 4 : out, room ? room[1] - clip.startUs - dur : Infinity))
  // Reversed, the right edge is the source window's start.
  return { inUs: clip.reverse && !image ? Math.max(0, inUs - dd * sp) : inUs, dur: dur + dd, start: clip.startUs }
}

const stored = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : v === 'on'
  } catch {
    return fallback
  }
}
const store = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? 'on' : 'off')
  } catch {}
}

/** Voice (a voiceover or a recording) or music, by the track's role or else its clips. */
function toneOf(track: Track, snap: Snapshot | null): Tone {
  if (track.role === 'voice' || track.role === 'music') return track.role
  const voice = track.clips.length > 0 && track.clips.every((c) => /[\\/]\.?(?:[^\\/]*\.studio[\\/])?(voiceovers|recordings)[\\/]/i.test(mediaById(snap, c.mediaId)?.path ?? ''))
  return voice ? 'voice' : 'music'
}

/**
 * "Add text" dropped from the library: the plain text clip at `atUs`, on a text row with room
 * or on a new track made at `newTrackAt`. As with Add text (`addText` in libraryActions.ts),
 * it's selected and its text field takes the keys.
 */
async function addTextAt(atUs: Us, place: { trackId: string } | { newTrackAt: number }) {
  const p = getState().snap?.project
  if (!p) return
  try {
    const look = await renderTextClip(scaleSpec(DEFAULT_TEXT, p.width), 'text')
    const r = await call<{ clipId: string; trackId: string }>('text.add', { atUs: Math.round(atUs), text: look, ...place })
    if (!r) return
    setState({ selection: [r.clipId], focus: 'timeline' })
    setUi('insp.textTab', 'text')
    const t0 = Date.now()
    const focus = () => {
      if (document.querySelector('.insp-text') && findClip(getState().snap, r.clipId)) window.dispatchEvent(new CustomEvent('studio:edit-text', { detail: r.clipId }))
      else if (Date.now() - t0 < 2000) setTimeout(focus, 50)
    }
    setTimeout(focus, 0)
  } catch (e) {
    toast(`Couldn’t add the text: ${(e as Error).message}`, 'error')
  }
}

/** The zoom slider runs on a log scale between the closest and farthest zoom. */
const zoomPct = (pps: number) => (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100
const ppsAt = (pct: number) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, pct / 100)

export function TimelinePanel() {
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const playing = useStore((s) => s.playing)
  const showWaveforms = useStore((s) => s.showWaveforms)
  const showThumbnails = useStore((s) => s.showThumbnails)
  const tool = useStore((s) => s.tool)
  const [pps, setPps] = useState(60)
  const [scale, setScale] = useState(1)
  const [snapping, setSnapping] = useState(() => stored(SNAP_KEY, true))
  const [skimOn, setSkimOn] = useState(() => stored(SKIM_KEY, false))
  const [skimAt, setSkimAt] = useState<Us | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [held, setHeld] = useState<{ drag: Drag; rev: number } | null>(null)
  const [dropHint, setDropHint] = useState<{ t: Us; audio: boolean } | null>(null)
  // "Add text" dragged in from the library: where the new text clip will land.
  const [textDrop, setTextDrop] = useState<(Landing & { atUs: Us; snapUs: Us | null }) | null>(null)
  const textDropRef = useRef(textDrop)
  const [view, setView] = useState({ w: 800, h: 300 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  // The drag as last drawn: a release drops what the ghost showed, even if the edge
  // auto-scroll moved it again since (it moves up to a fifth of a second a frame).
  const shownRef = useRef<Drag | null>(null)
  useLayoutEffect(() => {
    shownRef.current = drag
  }, [drag])
  const anchorRef = useRef<string | null>(null)
  const lastDownRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  const pendingScroll = useRef<number | null>(null)
  // Until you zoom yourself, the timeline widens its view to keep every clip in sight.
  const autoFit = useRef(true)

  const project = snap?.project
  const durationUs = snap?.durationUs ?? 0
  const magnet = project?.magnet ?? true
  const [loopPlay, setLoopPlay] = useUi('tl.loop', false)
  const linkage = project?.linkage ?? true

  useEffect(() => store(SNAP_KEY, snapping), [snapping])
  useEffect(() => store(SKIM_KEY, skimOn), [skimOn])

  // The engine's next snapshot replaces a released drag's preview.
  useEffect(() => {
    if (held && snap && snap.revision !== held.rev) setHeld(null)
  }, [snap, held])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitWidth = () => (scrollRef.current?.clientWidth ?? 800) - HEAD_W - 48
  const fit = () => {
    autoFit.current = true
    setPps(clamp(fitWidth() / Math.max(5, durationUs / S), MIN_PPS, MAX_PPS))
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }
  const zoomTo = (next: number, clientX?: number) => {
    const el = scrollRef.current
    if (!el) return
    autoFit.current = false
    const old = ppsRef.current
    next = clamp(next, MIN_PPS, MAX_PPS)
    const anchor = clientX != null ? clientX - el.getBoundingClientRect().left - HEAD_W : (getState().positionUs / S) * old - el.scrollLeft
    const t = (el.scrollLeft + anchor) / old
    pendingScroll.current = t * next - anchor
    setPps(next)
  }
  const zoomAt = (factor: number, clientX?: number) => zoomTo(ppsRef.current * factor, clientX)
  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current)
      pendingScroll.current = null
    }
  }, [pps])

  const tracks = project?.tracks ?? []
  const mainTrack = tracks.find((t) => t.main)
  const audioTracks = tracks.filter((t) => !t.main && t.kind === 'audio')
  // Over the main track; the last one in the project is drawn on top, so it is the top row.
  const overlayTracks = tracks.filter((t) => !t.main && t.kind !== 'audio').reverse()
  // Track heights at scale 1, with the gaps between them: what "fit tracks to the panel" divides.
  const baseH = (mainTrack ? MAIN_H + GAP : 0) + audioTracks.length * (AUDIO_H + GAP) + overlayTracks.reduce((h, t) => h + (ROLES[roleOf(t)].bar ? BAR_H : OVERLAY_H) + GAP, 0)
  const kindOf = (trackId: string) => tracks.find((t) => t.id === trackId)?.kind

  timelineApi.fit = fit
  timelineApi.zoom = (f) => zoomAt(f)
  timelineApi.toggleSnap = () => setSnapping((s) => !s)
  timelineApi.setHeight = (v) => setScale(clamp(v, 0.5, 1.8))
  timelineApi.fitHeight = () => setScale(clamp((view.h - RULER_H - PAD_TOP - PAD_BOTTOM - 28) / Math.max(1, baseH), 0.5, 1.8))

  // A new project starts fitted; afterwards the view only widens when clips outgrow it.
  useEffect(() => {
    autoFit.current = true
  }, [snap?.dir])
  useEffect(() => {
    if (autoFit.current && durationUs > 0 && (durationUs / S) * ppsRef.current > fitWidth()) fit()
  }, [snap?.dir, durationUs, view.w])

  // Wheel: Alt or Ctrl zooms around the pointer, Shift changes track height, plain scrolls sideways.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const delta = e.deltaY || e.deltaX
      if (e.altKey || e.ctrlKey) {
        e.preventDefault()
        zoomAt(Math.exp(-delta * 0.0015), e.clientX)
      } else if (e.shiftKey) {
        e.preventDefault()
        setScale((s) => clamp(s * Math.exp(-delta * 0.0012), 0.5, 1.8))
      } else if (e.clientX - el.getBoundingClientRect().left > HEAD_W && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const active = drag ?? held?.drag ?? null
  const draggingAudio = (active?.type === 'move' && !active.main && active.started && kindOf(active.trackId) === 'audio') || !!dropHint?.audio

  const rows = useMemo(() => {
    const out: Row[] = []
    let top = 0
    const push = (r: Omit<Row, 'top'>) => {
      out.push({ ...r, top })
      top += r.height + GAP
    }
    const roles = overlayTracks.map(roleOf)
    const seen: Partial<Record<Role, number>> = {}
    overlayTracks.forEach((t, i) => {
      const role = roles[i]
      const total = roles.filter((r) => r === role).length
      // Numbered from the bottom up, so "Text 1" is the one nearest the video.
      seen[role] = (seen[role] ?? 0) + 1
      const n = total - seen[role]! + 1
      const base = ROLES[role].bar ? BAR_H : OVERLAY_H
      push({ id: t.id, kind: 'overlay', track: t, role, height: Math.max(ROLES[role].bar ? 14 : 20, Math.round(base * scale)), label: total > 1 ? `${ROLES[role].name} ${n}` : ROLES[role].name })
    })
    if (mainTrack) push({ id: mainTrack.id, kind: 'main', track: mainTrack, height: Math.max(22, Math.round(MAIN_H * scale)), label: 'Video' })
    const count = { voice: 0, music: 0 }
    const tones = audioTracks.map((t) => toneOf(t, snap))
    audioTracks.forEach((t, i) => {
      const tone = tones[i]
      const n = ++count[tone]
      const many = tones.filter((x) => x === tone).length > 1
      const name = tone === 'voice' ? 'Voiceover' : t.role === 'music' ? 'Music' : 'Audio'
      push({ id: t.id, kind: 'audio', track: t, tone, height: Math.max(18, Math.round(AUDIO_H * scale)), label: many || name === 'Audio' ? `${name} ${n}` : name })
    })
    if (draggingAudio) push({ id: 'new', kind: 'new', height: NEW_ROW_H, label: '' })
    return out
  }, [tracks, scale, draggingAudio, snap])
  const tracksH = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0
  // The tracks sit in the middle of the panel, under the ruler, until they fill it.
  const tracksTop = RULER_H + Math.max(PAD_TOP, Math.floor((view.h - RULER_H - tracksH - 28) / 2))
  const contentH = Math.max(view.h, tracksTop + tracksH + 28 + PAD_BOTTOM)

  // Where every clip sits, with the active drag applied.
  const placed = useMemo(() => {
    const map = new Map<string, Placed[]>()
    for (const t of tracks) {
      let items: Placed[] = t.clips.map((c) => ({ clip: c, start: c.startUs, dur: c.durationUs, inUs: c.inUs }))
      const packed = t.main && magnet
      if (active?.type === 'trim' && items.some((p) => p.clip.id === active.clipId)) {
        const r = trimmed(active, active.d)
        items = items.map((p) => (p.clip.id === active.clipId ? { ...p, inUs: r.inUs, dur: r.dur, start: active.ripple ? p.start : r.start } : p))
        if (packed) items = packMain(items)
      }
      if (active?.type === 'move' && active.started && items.some((p) => p.clip.id === active.clipId)) {
        if (packed && active.dest !== 'over') {
          const moving = items.find((p) => p.clip.id === active.clipId)!
          const rest = packMain(items.filter((p) => p.clip.id !== active.clipId))
          const idx = mainIndexAt(rest, active.atUs)
          rest.splice(idx, 0, { ...moving, hole: true })
          items = packMain(rest)
        } else if (packed) {
          // Lifted off the main track: the clips after it close up.
          items = packMain(items.filter((p) => p.clip.id !== active.clipId))
        } else {
          items = items.filter((p) => p.clip.id !== active.clipId)
        }
      }
      // A fade being dragged: drawn at its new length straight away.
      if (active?.type === 'fade') {
        const key = active.side === 'in' ? 'fadeInUs' : 'fadeOutUs'
        items = items.map((p) => (p.clip.id === active.clipId ? { ...p, clip: { ...p.clip, [key]: active.now } } : p))
      }
      // The rest of a selection dragged together, shifted along with the one held.
      if (active?.type === 'move' && active.started && active.group.length) {
        const shift = active.atUs - active.fromUs
        const moved = new Set(active.group.map((g) => g.id))
        items = items.map((p) => (moved.has(p.clip.id) ? { ...p, start: p.start + shift } : p))
      }
      // An overlay's picture coming down into the magnetic main track: a gap opens where it will go.
      if (active?.type === 'move' && active.started && active.dest === 'main' && !active.main && packed) {
        const clip = tracks.flatMap((x) => x.clips).find((c) => c.id === active.clipId)
        if (clip) {
          const rest = packMain(items)
          rest.splice(mainIndexAt(rest, active.atUs), 0, { clip, start: 0, dur: clip.durationUs, inUs: clip.inUs, hole: true })
          items = packMain(rest)
        }
      }
      map.set(t.id, items)
    }
    return map
  }, [tracks, active, magnet])

  /** Where a pointer is along the content (its scrolled-away part included). */
  const xIn = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0)
  const timeAt = (clientX: number) => ((xIn(clientX) - HEAD_W) / ppsRef.current) * S

  // Dragging the line, a clip, an edge or a box against the panel's left or right edge
  // scrolls the timeline (faster the further in), and the drag carries on under the pointer.
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const moveRef = useRef<(e: { clientX: number; clientY: number; target: EventTarget | null }) => void>(() => {})
  const dragging = drag?.type ?? (textDrop ? 'text' : undefined)
  // A box also scrolls the rows at the top and bottom edges. However the timeline scrolled
  // (the edges, the wheel, the scrollbar), the drag carries on under the pointer.
  useEffect(() => {
    if (!dragging) return
    let raf = 0
    let last: [number, number] | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = scrollRef.current
      const p = pointerRef.current
      if (!el || !p) return
      const r = el.getBoundingClientRect()
      const speed = (into: number) => Math.sign(into) * Math.ceil(EDGE_SPEED * Math.min(2, Math.abs(into) / EDGE_PX) ** 2)
      const [left, right] = [r.left + HEAD_W, r.left + el.clientWidth]
      const into = p.x < left + EDGE_PX ? p.x - (left + EDGE_PX) : p.x > right - EDGE_PX ? p.x - (right - EDGE_PX) : 0
      if (into) el.scrollLeft = Math.max(0, el.scrollLeft + speed(into))
      const d = dragRef.current
      if (d?.type === 'box' && d.started) {
        const [top, bottom] = [r.top + RULER_H, r.top + el.clientHeight]
        const down = p.y < top + EDGE_PX ? p.y - (top + EDGE_PX) : p.y > bottom - EDGE_PX ? p.y - (bottom - EDGE_PX) : 0
        if (down) el.scrollTop = Math.max(0, el.scrollTop + speed(down))
      }
      if (last && (el.scrollLeft !== last[0] || el.scrollTop !== last[1])) moveRef.current({ clientX: p.x, clientY: p.y, target: null })
      last = [el.scrollLeft, el.scrollTop]
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [dragging])
  /** Where a pointer is down the content, from its top (the ruler's). */
  const yOn = (clientY: number) => clientY - (contentRef.current?.getBoundingClientRect().top ?? 0)
  const yIn = (clientY: number) => yOn(clientY) - tracksTop

  /** The index in the project's tracks a new track takes to show just above `r` (on the sound side, in its place). */
  const indexAbove = (r: Row) => {
    if (r.kind === 'new') return tracks.length
    if (r.kind === 'audio') return tracks.indexOf(r.track!)
    if (r.kind === 'overlay') return tracks.indexOf(r.track!) + 1
    // Above the video: under every track over it.
    const first = tracks.findIndex((t) => !t.main && t.kind !== 'audio')
    return first >= 0 ? first : tracks.indexOf(r.track!) + 1
  }

  /**
   * Where a clip of `lane` starting at `start` lands for the pointer at `y` (the rows' y), as
   * CapCut does: a row of its kind with room there; else a new track, at the line between
   * two rows the pointer is near (above them all for the top one), or just above the row
   * that has no room. Sound stays among the sound rows (the empty one under them is a new
   * track), the rest among the rows over the video (at the video or below it: just above it).
   */
  const aim = (lane: Lane, y: number, clip: { id: string; durationUs: Us; fadeInUs?: Us; fadeOutUs?: Us }, start: Us): Landing => {
    const audio = lane === 'audio'
    const lanes = rows.filter((r) => (audio ? r.kind === 'audio' || r.kind === 'new' : r.kind === 'overlay' || r.kind === 'main'))
    if (!lanes.length) return { rowId: '', newAt: tracks.length, line: null }
    const last = lanes.length - 1
    // A new track just above lanes[i]: the empty row under the sound, else a line.
    const above = (i: number): Landing => (lanes[i].kind === 'new' ? { rowId: 'new', newAt: tracks.length, line: null } : { rowId: '', newAt: indexAbove(lanes[i]), line: lanes[i].top - GAP / 2 })
    const onRow = (i: number): Landing => {
      const r = lanes[i]
      const kind = r.kind === 'audio' ? 'audio' : r.role
      return r.track && !r.track.locked && kind === lane && fitsOn(r.track, clip, start) ? { rowId: r.id, newAt: null, line: null } : above(i)
    }
    if (y >= lanes[last].top) return audio ? onRow(last) : above(last)
    // A row's top and bottom edges (and the gap between rows) mean the line there.
    const edge = (r: Row) => clamp(Math.round(r.height / 5), 3, 6)
    for (let i = 0; i < last; i++) {
      const r = lanes[i]
      if (y < r.top + edge(r)) return above(i)
      if (y < r.top + r.height - edge(r)) return onRow(i)
      if (y < r.top + r.height + GAP) return above(i + 1)
    }
    return above(last)
  }

  /** Snaps to the playhead, the start, or another clip's edge within a few pixels. */
  const snapTo = (times: Us[], exclude: string | Set<string>): { shift: Us; at: Us | null } => {
    if (!snapping || !snap) return { shift: 0, at: null }
    const out = (id: string) => (typeof exclude === 'string' ? id === exclude : exclude.has(id))
    const targets = [0, getState().positionUs]
    for (const t of snap.project.tracks) for (const c of t.clips) if (!out(c.id)) targets.push(c.startUs, c.startUs + c.durationUs)
    const tol = (SNAP_PX / ppsRef.current) * S
    let best: { shift: Us; at: Us | null } = { shift: 0, at: null }
    let bestDist = tol
    for (const t of times)
      for (const g of targets) {
        const dist = Math.abs(g - t)
        if (dist < bestDist) {
          bestDist = dist
          best = { shift: g - t, at: g }
        }
      }
    return best
  }

  /**
   * Where the playhead goes for the pointer at `clientX`: with snapping on (and Alt not held),
   * onto the start, the end, or any clip's start or end on any track (its cuts) within a few
   * pixels. Not onto itself, as a clip drag snaps to the playhead.
   */
  const scrubAt = (clientX: number, free = false): { at: Us; snapUs: Us | null } => {
    const t = Math.max(0, timeAt(clientX))
    if (!snapping || !snap || free) return { at: t, snapUs: null }
    let best: Us | null = null
    let bestDist = (SNAP_PX / ppsRef.current) * S
    const consider = (g: Us) => {
      const dist = Math.abs(g - t)
      if (dist < bestDist) {
        bestDist = dist
        best = g
      }
    }
    consider(0)
    consider(snap.durationUs)
    for (const tr of snap.project.tracks) for (const c of tr.clips) {
      consider(c.startUs)
      consider(c.startUs + c.durationUs)
    }
    return { at: best ?? t, snapUs: best }
  }

  /** Clips whose box crosses the rectangle between two pointer positions. */
  const clipsInBox = (b: Extract<Drag, { type: 'box' }>) => {
    const t0 = ((Math.min(b.x0, b.x1) - HEAD_W) / ppsRef.current) * S
    const t1 = ((Math.max(b.x0, b.x1) - HEAD_W) / ppsRef.current) * S
    const y0 = Math.min(b.y0, b.y1) - tracksTop
    const y1 = Math.max(b.y0, b.y1) - tracksTop
    const hit: string[] = []
    for (const r of rows) {
      if (r.top + r.height <= y0 || r.top >= y1) continue
      for (const p of placed.get(r.id) ?? []) if (p.start < t1 && p.start + p.dur > t0) hit.push(p.clip.id)
    }
    return hit
  }

  /** Shift+click: everything from the last clicked clip to this one, across the tracks between. */
  const rangeTo = (id: string) => {
    const anchor = anchorRef.current
    const where = (cid: string) => {
      const ri = rows.findIndex((r) => (placed.get(r.id) ?? []).some((p) => p.clip.id === cid))
      const p = ri >= 0 ? placed.get(rows[ri].id)!.find((x) => x.clip.id === cid)! : undefined
      return p && { ri, start: p.start, end: p.start + p.dur }
    }
    const a = anchor ? where(anchor) : undefined
    const b = where(id)
    if (!a || !b) return [id]
    const [r0, r1] = [Math.min(a.ri, b.ri), Math.max(a.ri, b.ri)]
    const [t0, t1] = [Math.min(a.start, b.start), Math.max(a.end, b.end)]
    return rows.slice(r0, r1 + 1).flatMap((r) => (placed.get(r.id) ?? []).filter((p) => p.start < t1 && p.start + p.dur > t0).map((p) => p.clip.id))
  }

  const update = (d: Drag | null) => {
    dragRef.current = d
    setDrag(d)
  }
  const endSkim = () => {
    if (skimAt == null) return
    setSkimAt(null)
    skim(null)
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const target = e.target as HTMLElement
    setState({ focus: 'timeline' })
    const clipEl = target.closest<HTMLElement>('[data-clip]')
    if (clipEl) {
      const id = clipEl.dataset.clip!
      // A clip whose text is being removed gets a menu of its own (Cancel text removal).
      if (!getState().selection.includes(id) || findClip(getState().snap, id)?.clip.busy) setState({ selection: [id] })
      openMenu(e.clientX, e.clientY, clipMenu())
    } else if (!target.closest('.tl-head, .tl-corner, .tl-heads-fill, .tl-ruler')) openMenu(e.clientX, e.clientY, timelineMenu())
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !snap) return
    pointerRef.current = { x: e.clientX, y: e.clientY }
    // The timeline takes Ctrl+C/X/V and Delete, and the player goes back to it from a preview.
    if (getState().focus !== 'timeline') setState({ focus: 'timeline' })
    if (getState().source) exitSource()
    const target = e.target as HTMLElement
    if (target.closest('.tl-head, .tl-corner, .tl-heads-fill')) return
    endSkim()
    try {
      contentRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic pointers (the UI check) have nothing to capture.
    }
    // A double-click on empty space grabs the playhead there, like the ruler and the line itself.
    const now = performance.now()
    const last = lastDownRef.current
    const double = !!last && now - last.t < 400 && Math.abs(e.clientX - last.x) < 6 && Math.abs(e.clientY - last.y) < 6
    lastDownRef.current = { t: now, x: e.clientX, y: e.clientY }
    const empty = !target.closest('[data-clip]')
    // The ruler and the playhead move the playhead, and keep following the pointer.
    if (target.closest('.tl-ruler, .tl-playhead, .tl-playhead-head') || (double && empty)) {
      if (getState().playing) call('playback.pause')
      setScrubbing(true)
      const s = scrubAt(e.clientX, e.altKey)
      seek(s.at)
      update({ type: 'scrub', snapUs: s.snapUs })
      return
    }
    const clipEl = target.closest<HTMLElement>('[data-clip]')
    if (clipEl) {
      const id = clipEl.dataset.clip!
      const found = snap.project.tracks.flatMap((t) => t.clips.map((c) => ({ c, t }))).find((x) => x.c.id === id)
      if (!found) return
      const sel = getState().selection
      if (e.shiftKey) {
        setState({ selection: [...new Set([...sel, ...rangeTo(id)])] })
        return
      }
      if (e.ctrlKey || e.metaKey) {
        setState({ selection: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
        anchorRef.current = id
        return
      }
      if (!sel.includes(id)) setState({ selection: [id] })
      anchorRef.current = id
      // A locked track's clips can be picked, not moved or trimmed; nor can a clip whose text
      // is being removed (Vmake), until that's done.
      if (found.t.locked || found.c.busy) return
      // The split tool (B) cuts the clip where you click.
      if (getState().tool === 'blade') {
        call('timeline.split', { atUs: Math.round(timeAt(e.clientX)), clipIds: [id] })
        return
      }
      // A fade's handle (top corners of a clip with sound): drag it to make the fade longer or shorter.
      const fadeSide = target.dataset.fade as 'in' | 'out' | undefined
      if (fadeSide) {
        const c = found.c
        const base = (fadeSide === 'in' ? c.fadeInUs : c.fadeOutUs) ?? 0
        const other = (fadeSide === 'in' ? c.fadeOutUs : c.fadeInUs) ?? 0
        const edgeUs = fadeSide === 'in' ? c.startUs : c.startUs + c.durationUs
        update({ type: 'fade', clipId: id, side: fadeSide, edge: HEAD_W + (edgeUs / S) * ppsRef.current, base, max: Math.max(0, c.durationUs - other), now: base })
        return
      }
      const edge = target.dataset.edge as 'left' | 'right' | undefined
      const media = mediaById(snap, found.c.mediaId)
      const ripple = found.t.main && magnet
      const audio = found.t.kind === 'audio'
      // A text clip or adjustment layer has no media; any clip but a missing file can be trimmed.
      if (edge && (media || !found.c.mediaId)) {
        // Over the video its edges stop at its neighbours, as it can't share the time with them.
        const others = found.t.main || audio ? [] : found.t.clips.filter((c) => c.id !== id)
        const room: [Us, Us] | null = found.t.main || audio ? null : [Math.max(0, ...others.map((c) => c.startUs + c.durationUs).filter((x) => x <= found.c.startUs)), Math.min(Infinity, ...others.map((c) => c.startUs).filter((x) => x >= found.c.startUs + found.c.durationUs))]
        update({ type: 'trim', clipId: id, ripple, edge, x0: xIn(e.clientX), clip: found.c, media, room, d: 0, snapUs: null })
      } else {
        const picture = !!media && media.kind !== 'audio' && !found.c.text && !found.c.caption && (found.t.main || (!audio && roleOf(found.t) === 'overlay'))
        const lane: Lane = audio ? 'audio' : found.t.main ? 'overlay' : roleOf(found.t)
        // One of several selected clips: the others move with it, by the same time, each on its own track.
        const sel = getState().selection
        const group = !found.t.main && sel.length > 1 && sel.includes(id)
          ? snap.project.tracks.filter((t) => !t.main && !t.locked).flatMap((t) => t.clips.filter((c) => c.id !== id && sel.includes(c.id) && !c.busy)).map((c) => ({ id: c.id, startUs: c.startUs, durationUs: c.durationUs }))
          : []
        // Several main-track clips selected: dragged up off the main track, they all go, together.
        const lift = found.t.main && picture && sel.length > 1 && sel.includes(id)
          ? found.t.clips.filter((c) => c.id !== id && sel.includes(c.id) && !c.busy && mediaById(snap, c.mediaId)?.kind !== 'audio').map((c) => ({ id: c.id, offUs: c.startUs - found.c.startUs, durationUs: c.durationUs }))
          : []
        update({ type: 'move', clipId: id, main: found.t.main, free: !ripple, trackId: found.t.id, lane, x0: e.clientX, y0: e.clientY, grabUs: timeAt(e.clientX) - found.c.startUs, started: false, atUs: found.c.startUs, rowId: found.t.id, newAt: null, line: null, snapUs: null, picture, dest: null, fromUs: found.c.startUs, group, lift })
      }
      return
    }
    // Empty space: drag a box to select clips (Shift or Ctrl adds to the selection); a plain click moves the playhead.
    const add = e.shiftKey || e.ctrlKey || e.metaKey
    update({ type: 'box', x0: xIn(e.clientX), y0: yOn(e.clientY), x1: xIn(e.clientX), y1: yOn(e.clientY), started: false, base: add ? getState().selection : [] })
  }

  const onPointerMove = (e: { clientX: number; clientY: number; target: EventTarget | null }) => {
    const d = dragRef.current
    pointerRef.current = { x: e.clientX, y: e.clientY }
    if (!snap) return
    if (!d) {
      // Preview on hover: the player shows the frame under the pointer; the playhead stays.
      if (skimOn && !getState().playing && !getState().source && durationUs > 0 && !(e.target as HTMLElement).closest('.tl-head, .tl-corner, .tl-heads-fill')) {
        const t = clamp(timeAt(e.clientX), 0, durationUs)
        setSkimAt(t)
        skim(t)
      } else endSkim()
      return
    }
    if (d.type === 'scrub') {
      const s = scrubAt(e.clientX, 'altKey' in e && !!e.altKey)
      seek(s.at)
      if (s.snapUs !== d.snapUs) update({ ...d, snapUs: s.snapUs })
      return
    }
    if (d.type === 'box') {
      const [x, y] = [xIn(e.clientX), yOn(e.clientY)]
      const started = d.started || Math.abs(x - d.x0) > 3 || Math.abs(y - d.y0) > 3
      if (!started) return
      const next = { ...d, x1: x, y1: y, started }
      update(next)
      setState({ selection: [...new Set([...d.base, ...clipsInBox(next)])] })
      return
    }
    if (d.type === 'fade') {
      const from = ((xIn(e.clientX) - d.edge) / ppsRef.current) * S
      const v = Math.min(d.max, Math.max(0, d.side === 'in' ? from : -from))
      update({ ...d, now: Math.round(v / 10_000) * 10_000 })
      return
    }
    if (d.type === 'trim') {
      let delta = ((xIn(e.clientX) - d.x0) / ppsRef.current) * S
      const r = trimmed(d, delta)
      // The edge under the pointer. A rippling main-track clip's left edge stays put.
      const edgeAt = d.edge === 'right' ? d.clip.startUs + r.dur : d.ripple ? null : r.start
      let snapUs: Us | null = null
      if (edgeAt != null) {
        const s = snapTo([edgeAt], d.clipId)
        if (s.at != null) {
          delta += s.shift
          snapUs = s.at
        }
      }
      update({ ...d, d: delta, snapUs })
      return
    }
    if (!d.started && Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return
    const t = timeAt(e.clientX)
    const y = yIn(e.clientY)
    const video = rows.find((r) => r.kind === 'main')
    // Pictures stack as you like: a video-track clip stays in the video track at it (or below
    // it) and goes up onto the tracks over it above; an overlay's picture comes back down into it.
    const inMain = !!video && (d.main ? !d.picture || y >= video.top : d.picture && y >= video.top && !video.track?.locked)
    const dest: 'over' | 'main' | null = inMain ? (d.main ? null : 'main') : d.main ? 'over' : null
    if (inMain && magnet) {
      // On the magnetic main track the ghost follows the pointer and the clips make room.
      update({ ...d, started: true, dest, atUs: Math.max(0, t), rowId: video!.id, newAt: null, line: null, snapUs: null })
      return
    }
    const clip = snap.project.tracks.flatMap((x) => x.clips).find((c) => c.id === d.clipId)!
    if (d.group.length) {
      const all = [{ id: d.clipId, startUs: d.fromUs, durationUs: clip.durationUs }, ...d.group]
      let shift = Math.max(t - d.grabUs - d.fromUs, -Math.min(...all.map((g) => g.startUs)))
      const s = snapTo(all.flatMap((g) => [g.startUs + shift, g.startUs + shift + g.durationUs]), new Set(all.map((g) => g.id)))
      shift = Math.max(shift + s.shift, -Math.min(...all.map((g) => g.startUs)))
      update({ ...d, started: true, dest: null, atUs: d.fromUs + shift, rowId: d.trackId, newAt: null, line: null, snapUs: s.at })
      return
    }
    // Main-track clips lifted together: none before 0, and they land where all of them fit.
    const first = Math.min(0, ...(inMain ? [] : d.lift.map((l) => l.offUs)))
    let start = Math.max(-first, t - d.grabUs)
    const s = snapTo([start, start + clip.durationUs], d.clipId)
    start = Math.max(-first, start + s.shift)
    const span = d.lift.length && !inMain ? { id: d.clipId, durationUs: Math.max(clip.durationUs, ...d.lift.map((l) => l.offUs + l.durationUs)) - first } : clip
    // Anywhere else: a row of its kind with room, or a new track (see `aim`).
    const to: Landing = inMain ? { rowId: video!.id, newAt: null, line: null } : aim(d.lane, y, span, start + first)
    update({ ...d, started: true, dest, atUs: start, ...to, snapUs: s.at })
  }

  /** "Add text" from the library over the timeline: lands like a moved text clip, 3 s long, its start at the pointer. */
  const aimText = (clientX: number, clientY: number) => {
    let start = Math.max(0, timeAt(clientX))
    const s = snapTo([start, start + TEXT_US], '')
    start = Math.max(0, start + s.shift)
    const next = { atUs: start, snapUs: s.at, ...aim('text', yIn(clientY), { id: '', durationUs: TEXT_US }, start) }
    const was = textDropRef.current
    if (was && was.atUs === next.atUs && was.rowId === next.rowId && was.newAt === next.newAt && was.line === next.line) return
    textDropRef.current = next
    setTextDrop(next)
  }
  const endTextDrop = () => {
    textDropRef.current = null
    setTextDrop(null)
  }

  moveRef.current = (e) => (dragRef.current ? onPointerMove(e) : textDropRef.current && aimText(e.clientX, e.clientY))

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const now = dragRef.current
    const shown = shownRef.current
    // (A flick released before the ghost was ever drawn still drops where the pointer is.)
    const drawn = shown && now && shown.type === now.type && 'clipId' in shown && 'clipId' in now && shown.clipId === now.clipId && (!('started' in now) || !now.started || ('started' in shown && shown.started))
    const d = drawn ? shown : now
    pointerRef.current = null
    update(null)
    if (!d || !snap) return
    if (d.type === 'scrub') {
      setScrubbing(false)
      return
    }
    if (d.type === 'box') {
      if (!d.started) {
        if (!d.base.length) setState({ selection: [] })
        if (getState().playing) call('playback.pause')
        seek(timeAt(e.clientX))
      }
      return
    }
    let p: Promise<unknown> | undefined
    if (d.type === 'fade') {
      if (d.now === d.base) return
      p = call('clip.set', { clipId: d.clipId, [d.side === 'in' ? 'fadeInUs' : 'fadeOutUs']: d.now, label: d.side === 'in' ? 'Fade in' : 'Fade out' })
    } else if (d.type === 'trim') {
      const r = trimmed(d, d.d)
      if (r.dur === d.clip.durationUs && r.inUs === d.clip.inUs && r.start === d.clip.startUs) return
      p = call('timeline.trim', { clipId: d.clipId, inUs: Math.round(r.inUs), durationUs: Math.round(r.dur), ...(d.ripple ? {} : { startUs: Math.round(r.start) }) })
    } else if (d.started && d.lift.length && (d.newAt != null || d.dest === 'over')) {
      // The selection lifted off the main track together, onto one track.
      const moves = [{ clipId: d.clipId, startUs: Math.round(d.atUs) }, ...d.lift.map((l) => ({ clipId: l.id, startUs: Math.round(d.atUs + l.offUs) }))]
      p = call('timeline.liftMany', { moves, ...(d.newAt != null ? { newTrackAt: d.newAt } : { trackId: d.rowId }) })
    } else if (d.started && d.group.length) {
      const shift = d.atUs - d.fromUs
      if (!shift) return
      p = call('timeline.moveMany', { moves: [{ clipId: d.clipId, startUs: Math.round(d.atUs) }, ...d.group.map((g) => ({ clipId: g.id, startUs: Math.round(g.startUs + shift) }))] })
    } else if (d.started) {
      if (d.newAt != null) {
        // A new track where the ghost showed it: between two rows, above them all, or under the sound.
        p = call('timeline.move', { clipId: d.clipId, startUs: Math.round(d.atUs), newTrackAt: d.newAt })
      } else if (d.dest === 'over') {
        p = call('timeline.move', { clipId: d.clipId, startUs: Math.round(d.atUs), trackId: d.rowId })
      } else if (d.dest === 'main') {
        p = call('timeline.move', { clipId: d.clipId, startUs: Math.round(d.atUs), trackId: snap.project.tracks.find((t) => t.main)!.id })
      } else if (!d.free) {
        const main = snap.project.tracks.find((t) => t.main)!
        const from = main.clips.findIndex((c) => c.id === d.clipId)
        const rest = packMain(main.clips.filter((c) => c.id !== d.clipId).map((c) => ({ clip: c, start: c.startUs, dur: c.durationUs, inUs: c.inUs })))
        if (mainIndexAt(rest, d.atUs) === from) return
        p = call('timeline.move', { clipId: d.clipId, startUs: Math.round(d.atUs) })
      } else {
        const trackId = d.main ? undefined : d.rowId
        p = call('timeline.move', { clipId: d.clipId, startUs: Math.round(d.atUs), ...(trackId ? { trackId } : {}) })
      }
    } else return
    setHeld({ drag: d, rev: snap.revision })
    p.then((r) => r === undefined && setHeld(null))
    setTimeout(() => setHeld((h) => (h?.drag === d ? null : h)), 1500)
  }

  // Media and "Add text" dragged in from the library, or files and folders from the desktop.
  const onDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types
    if (types.includes(TEXT_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      pointerRef.current = { x: e.clientX, y: e.clientY }
      aimText(e.clientX, e.clientY)
      return
    }
    if (!types.includes(MEDIA_MIME) && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const audio = types.includes(`${MEDIA_MIME}-audio`)
    let t = Math.max(0, timeAt(e.clientX))
    if (!audio && mainTrack && magnet) {
      // Show where it will land: the boundary the engine will insert at.
      const items = mainTrack.clips.map((c) => ({ start: c.startUs, dur: c.durationUs }))
      const i = mainIndexAt(items, t)
      t = i < items.length ? items[i].start : items.reduce((s, c) => s + c.dur, 0)
    }
    setDropHint({ t, audio })
  }
  const onDrop = (e: DragEvent) => {
    const text = textDropRef.current
    if (e.dataTransfer.types.includes(TEXT_MIME)) {
      e.preventDefault()
      pointerRef.current = null
      endTextDrop()
      // Where the ghost showed it.
      if (text) addTextAt(text.atUs, text.newAt != null ? { newTrackAt: text.newAt } : { trackId: text.rowId })
      return
    }
    const hint = dropHint
    setDropHint(null)
    const t = Math.max(0, Math.round(timeAt(e.clientX)))
    const data = e.dataTransfer.getData(MEDIA_MIME)
    e.preventDefault()
    if (data) addToTimeline(JSON.parse(data), hint?.audio || !magnet ? t : Math.round(hint?.t ?? t))
    else if (e.dataTransfer.files.length) importPaths([...e.dataTransfer.files].map((f) => window.studio.app.pathForFile(f)).filter(Boolean), t)
  }

  const contentW = HEAD_W + Math.max(durationUs / S + 15, (view.w - HEAD_W - 12) / pps) * pps + 12
  const px = (us: Us) => (us / S) * pps
  const moving = active?.type === 'move' && active.started ? active : null
  const movingClip = moving ? snap?.project.tracks.flatMap((t) => t.clips).find((c) => c.id === moving.clipId) : undefined
  const overH = Math.max(20, Math.round(OVERLAY_H * scale))
  // On the magnetic main track the ghost follows the pointer; elsewhere it shows the clip's start.
  const ghostAtPointer = !!moving && magnet && (moving.dest === 'main' || (moving.main && !moving.dest))
  // The ghost: where the dragged clip, or the text from the library, lands when let go.
  const ghost = moving && movingClip
    ? { clip: movingClip, at: ghostAtPointer ? moving.atUs - moving.grabUs : moving.atUs, lane: moving.lane, to: moving as Landing, tone: rows.find((r) => r.id === moving.trackId)?.tone }
    : textDrop
      ? { clip: NEW_TEXT, at: textDrop.atUs, lane: 'text' as Lane, to: textDrop as Landing, tone: undefined }
      : null
  const ghostRow = ghost && ghost.to.line == null ? rows.find((r) => r.id === ghost.to.rowId) : undefined
  const newLine = ghost?.to.line ?? null
  const ghostH = ghostRow?.height ?? (!ghost ? 0 : ghost.lane === 'audio' ? Math.max(18, Math.round(AUDIO_H * scale)) : ROLES[ghost.lane].bar ? Math.max(14, Math.round(BAR_H * scale)) : overH)
  // On a new track's line it sits across the line; above every row, over it when there's room.
  const ghostTop = ghostRow ? ghostRow.top : newLine == null ? 0 : newLine < 0 && tracksTop - RULER_H + newLine >= ghostH + 2 ? newLine - ghostH - 1 : newLine - ghostH / 2
  const ghostVariant = ghostRow ? (ghostRow.kind === 'main' ? 'main' : ghostRow.kind === 'overlay' ? 'overlay' : 'audio') : ghost?.lane === 'audio' ? 'audio' : 'overlay'
  const snapLine = (active?.type === 'trim' || active?.type === 'move' || active?.type === 'scrub') && active.snapUs != null ? active.snapUs : (textDrop?.snapUs ?? null)
  const box = drag?.type === 'box' && drag.started ? drag : null
  const pictures = selection.some((id) => mainTrack?.clips.some((c) => c.id === id && mediaById(snap, c.mediaId)?.kind !== 'audio'))
  const videos = selection.some((id) => mainTrack?.clips.some((c) => c.id === id && mediaById(snap, c.mediaId)?.kind === 'video'))
  const atPicture = mainTrack?.clips.some((c) => c.startUs <= getState().positionUs && getState().positionUs < c.startUs + c.durationUs && mediaById(snap, c.mediaId)?.kind !== 'audio')
  const heightPct = ((scale - 0.5) / 1.3) * 100
  const zp = zoomPct(pps)

  return (
    <div className="panel timeline">
      <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
        <Tool d={D.cursor} label="Select" keys={keysFor('selectTool')} on={tool === 'select'} onClick={() => setState({ tool: 'select' })} />
        <Tool d={D.split} label="Split" keys={keysFor('split')} onClick={splitAtPlayhead} disabled={!durationUs} on={tool === 'blade'} />
        <Tool icon="deleteLeft" label="Delete left" keys={keysFor('deleteLeft')} onClick={() => deleteSide('left')} disabled={!durationUs} />
        <Tool icon="deleteRight" label="Delete right" keys={keysFor('deleteRight')} onClick={() => deleteSide('right')} disabled={!durationUs} />
        <Tool d={D.trash} label="Delete" keys={keysFor('del')} onClick={deleteSelection} disabled={!selection.length} />
        <Tool d={D.freeze} label="Freeze frame" onClick={freezeFrame} disabled={!atPicture} />
        <Tool d={D.reverse} label="Reverse" onClick={reverse} disabled={!videos} />
        <Tool d={D.mirror} label="Mirror" onClick={mirror} disabled={!pictures} />
        <Tool icon="rotate" label="Rotate" onClick={rotate} disabled={!pictures} />
        <Tool d={D.crop} label="Crop" onClick={openCrop} disabled={!pictures} />
        <span className="tl-sep" aria-hidden="true" />
        <Tool d={D.undo} label="Undo" keys={keysFor('undo')} onClick={undo} disabled={!snap?.canUndo} />
        <Tool d={D.redo} label="Redo" keys={keysFor('redo')} onClick={redo} disabled={!snap?.canRedo} />
        <span className="tl-spacer" />
        <Toggle d={D.loop} label="Loop playback (at the end, play again from the start)" on={loopPlay} onClick={() => setLoopPlay(!loopPlay)} />
        <Toggle d={D.magnet} label="Main track magnet" keys={keysFor('magnet')} on={magnet} onClick={toggleMagnet} disabled={!snap} />
        <Toggle d={D.snap} label="Snapping" keys={keysFor('snapping')} on={snapping} onClick={() => setSnapping((s) => !s)} />
        <Toggle d={D.link} label="Link audio and video" keys={keysFor('linkage')} on={linkage} onClick={toggleLinkage} disabled={!snap} />
        <Toggle
          d={D.eye}
          label="Preview on hover"
          on={skimOn}
          onClick={() => {
            endSkim()
            setSkimOn((s) => !s)
          }}
        />
        <span className="tl-sep" aria-hidden="true" />
        <ToolSlider d={D.height} label="Track height" tip="Track height  Shift+scroll" pct={heightPct} onChange={(v) => setScale(0.5 + (v / 100) * 1.3)} />
        <ToolSlider d={D.zoom} label="Timeline zoom" tip="Zoom  Alt+scroll" pct={zp} onChange={(v) => zoomTo(ppsAt(v))} />
      </div>
      <div className="tl-scroll" ref={scrollRef} onPointerLeave={endSkim}>
        <div
          className={`tl-content${active?.type === 'trim' ? ' trimming' : ''}${moving ? ' moving' : ''}${tool === 'blade' ? ' blade' : ''}`}
          ref={contentRef}
          style={{ width: contentW, height: contentH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={onContextMenu}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (contentRef.current?.contains(e.relatedTarget as Node)) return
            setDropHint(null)
            pointerRef.current = null
            endTextDrop()
          }}
          onDrop={onDrop}
        >
          <div className="tl-ruler-row">
            <div className="tl-corner">Shift + scroll: height</div>
            <Ruler pps={pps} width={contentW - HEAD_W} />
            <Markers labels={project?.labels} pps={pps} />
            <PlayheadHead pps={pps} />
          </div>
          {/* The track-head column's background above and below the centred tracks. */}
          <div className="tl-heads-fill" style={{ height: contentH - RULER_H, marginBottom: -(contentH - RULER_H) }} />
          <div className="tl-rows" style={{ height: tracksH, marginTop: tracksTop - RULER_H }}>
            {rows.map((r) => (
              <div key={r.id} className={`tl-row kind-${r.kind}${r.track?.locked ? ' locked' : ''}${r.track?.mute ? ' muted' : ''}`} style={{ height: r.height, top: r.top }}>
                <TrackHead row={r} snap={snap} />
                <div className="tl-lane">
                  {r.kind === 'main' && !r.track?.clips.length && <span className="tl-hint">Drag media here, or double-click it in the library</span>}
                  {r.kind === 'new' && <span className="tl-hint">Drop here for a new audio track</span>}
                </div>
              </div>
            ))}
          </div>
          {rows.length > 0 && !draggingAudio && (
            <p className="tl-drop-note" style={{ top: tracksTop + tracksH + 8 }}>
              Drop text, stickers or sound anywhere here. Each gets its own track.
            </p>
          )}
          <div className="tl-clips" style={{ top: tracksTop, left: HEAD_W, height: tracksH }}>
            {rows.map((r) =>
              (placed.get(r.id) ?? []).map((p) => (
                <ClipView
                  key={p.clip.id}
                  clip={p.clip}
                  media={mediaById(snap, p.clip.mediaId)}
                  x={px(p.start)}
                  w={px(p.dur)}
                  inUs={p.inUs}
                  dur={p.dur}
                  top={r.top}
                  h={r.height}
                  pps={pps}
                  variant={r.kind === 'main' ? 'main' : r.kind === 'overlay' ? 'overlay' : 'audio'}
                  tone={r.tone}
                  role={r.role}
                  selected={selection.includes(p.clip.id)}
                  linked={linkage && !!p.clip.link}
                  hole={p.hole}
                  dimmed={!!r.track?.hidden || (r.kind !== 'main' && r.kind !== 'new' && !!r.track?.mute && r.kind === 'audio')}
                  waveforms={showWaveforms}
                  thumbnails={showThumbnails}
                  busy={p.clip.busy ?? undefined}
                />
              )),
            )}
            {/* Transitions sit on the cut before the clip that has one. */}
            {rows
              .filter((r) => r.kind === 'main')
              .flatMap((r) =>
                (placed.get(r.id) ?? [])
                  .filter((p, i) => i > 0 && p.clip.transition && !p.hole)
                  .map((p) => (
                    <button
                      key={`tr-${p.clip.id}`}
                      type="button"
                      className="tl-transition"
                      style={{ left: px(p.start), top: r.top + r.height / 2 }}
                      title={`${p.clip.transition!.name} · ${(p.clip.transition!.durationUs / 1e6).toFixed(1)} s  (click to change)`}
                      aria-label={`Transition: ${p.clip.transition!.name}`}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        setState({ selection: [p.clip.id], focus: 'timeline' })
                        setUi('lib.cat', 'transitions')
                      }}
                    >
                      <Svg d={D.transition} size={10} />
                    </button>
                  )),
              )}
            {ghost &&
              moving &&
              !ghostAtPointer &&
              (moving.newAt != null || moving.dest === 'over') &&
              moving.lift.map((l) => {
                const c = snap?.project.tracks.flatMap((t) => t.clips).find((x) => x.id === l.id)
                return c ? (
                  <ClipView
                    key={`lift-${c.id}`}
                    clip={c}
                    media={mediaById(snap, c.mediaId)}
                    x={px(ghost.at + l.offUs)}
                    w={px(c.durationUs)}
                    inUs={c.inUs}
                    dur={c.durationUs}
                    top={ghostTop}
                    h={ghostH}
                    pps={pps}
                    variant={ghostVariant}
                    tone={ghostRow?.tone ?? ghost.tone ?? 'music'}
                    role={ghostRow?.role ?? (ghost.lane === 'audio' ? undefined : ghost.lane)}
                    selected
                    linked={linkage && !!c.link}
                    ghost
                    waveforms={showWaveforms}
                    thumbnails={showThumbnails}
                  />
                ) : null
              })}
            {ghost && (
              <ClipView
                clip={ghost.clip}
                media={mediaById(snap, ghost.clip.mediaId)}
                x={px(ghost.at)}
                w={px(ghost.clip.durationUs)}
                inUs={ghost.clip.inUs}
                dur={ghost.clip.durationUs}
                top={ghostTop}
                h={ghostH}
                pps={pps}
                variant={ghostVariant}
                tone={ghostRow?.tone ?? ghost.tone ?? 'music'}
                role={ghostRow?.role ?? (ghost.lane === 'audio' ? undefined : ghost.lane)}
                selected
                linked={linkage && !!ghost.clip.link}
                ghost
                waveforms={showWaveforms}
                thumbnails={showThumbnails}
              />
            )}
          </div>
          {/* A new track will be made here: the line between two rows (or above them all). */}
          {ghost && newLine != null && (
            <div className="tl-newrow" style={{ top: tracksTop + newLine, left: HEAD_W }}>
              <span>{ghost.lane === 'audio' ? 'New audio track' : `New ${ROLES[ghost.lane].name.toLowerCase()} track`}</span>
            </div>
          )}
          {snapLine != null && <div className="tl-snapline" style={{ left: HEAD_W + px(snapLine), top: tracksTop, height: tracksH }} />}
          {dropHint && <div className="tl-drophint" style={{ left: HEAD_W + px(dropHint.t), top: tracksTop, height: tracksH }} />}
          {skimAt != null && !playing && <div className="tl-skimline" style={{ left: HEAD_W + px(skimAt), top: RULER_H, height: contentH - RULER_H }} />}
          {box && (
            <div
              className="tl-box"
              style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
            />
          )}
          <Playhead pps={pps} height={durationUs ? contentH : tracksTop + tracksH} scrollRef={scrollRef} />
        </div>
      </div>
    </div>
  )
}

/** A toolbar button: the canvas's icon, its name, and its key in the tooltip. */
function Tool({ d, icon, label, keys, onClick, disabled, on }: { d?: string; icon?: 'deleteLeft' | 'deleteRight' | 'rotate'; label: string; keys?: string; onClick?: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" className={`tool${on ? ' on' : ''}`} title={keys ? `${label}  ${keys}` : label} aria-label={label} onClick={onClick} disabled={disabled}>
      {d ? <Svg d={d} /> : <Icon name={icon!} />}
    </button>
  )
}

/** An on/off setting on the right of the toolbar. */
function Toggle({ d, label, keys, on, onClick, disabled }: { d: string; label: string; keys?: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`tool toggle${on ? ' on' : ''}`} title={`${label}${keys ? `  ${keys}` : ''}  ·  ${on ? 'On' : 'Off'}`} aria-label={label} aria-pressed={on} onClick={onClick} disabled={disabled}>
      <Svg d={d} />
    </button>
  )
}

/** The canvas's small slider: icon, a 72 px track, a knob. */
function ToolSlider({ d, label, tip, pct, onChange }: { d: string; label: string; tip: string; pct: number; onChange: (v: number) => void }) {
  const p = clamp(pct, 0, 100)
  return (
    <span className="tool-slider" title={tip}>
      <Svg d={d} size={14} />
      <span className="tool-slider-track">
        <span className="rail" />
        <span className="fill" style={{ width: `${p}%` }} />
        <span className="knob" style={{ left: `calc(${p}% - 5px)` }} />
        <input type="range" aria-label={label} min={0} max={100} step={0.5} value={p} onChange={(e) => onChange(Number(e.target.value))} />
      </span>
    </span>
  )
}

/** A track's head: its kind (by colour), name, cover frame on the video track, lock and mute. */
function TrackHead({ row, snap }: { row: Row; snap: Snapshot | null }) {
  if (row.kind === 'new') return <div className="tl-head" />
  const t = row.track!
  const overlay = row.kind === 'overlay'
  const color = row.kind === 'main' ? TONES.video.icon : overlay ? ROLES[row.role ?? 'overlay'].color : TONES[row.tone ?? 'music'].icon
  // Short bar tracks (text, captions) still get their two buttons, as on the canvas.
  const tall = row.height >= 30 || (overlay && row.height >= 20)
  const cover = row.kind === 'main' && row.height >= 40
  return (
    <div className={`tl-head${cover ? ' with-cover' : ''}`}>
      {cover && <CoverButton snap={snap} track={t} h={row.height - 8} />}
      <span className="tl-head-icon" style={{ color }}>
        <Svg d={row.kind === 'main' ? D.video : overlay ? ROLES[row.role ?? 'overlay'].icon : D.audio} size={14} />
      </span>
      <span className="tl-head-name" title={row.label}>
        {row.label}
      </span>
      {tall && (
        <span className={`tl-head-btns${cover ? ' stacked' : ''}`}>
          <button type="button" className={`tl-head-btn${t.locked ? ' on' : ''}`} aria-label={`${t.locked ? 'Unlock' : 'Lock'} ${row.label}`} aria-pressed={!!t.locked} title={t.locked ? 'Unlock' : 'Lock'} onClick={() => setTrack(t.id, { locked: !t.locked })}>
            <Svg d={D.lock} size={12} />
          </button>
          {overlay ? (
            <button type="button" className={`tl-head-btn${t.hidden ? ' on' : ''}`} aria-label={`${t.hidden ? 'Show' : 'Hide'} ${row.label}`} aria-pressed={!!t.hidden} title={t.hidden ? 'Show' : 'Hide'} onClick={() => setTrack(t.id, { hidden: !t.hidden })}>
              <Svg d={t.hidden ? D.eyeOff : D.eye} size={12} />
            </button>
          ) : (
            <button type="button" className={`tl-head-btn${t.mute ? ' on' : ''}`} aria-label={`${t.mute ? 'Unmute' : 'Mute'} ${row.label}`} aria-pressed={!!t.mute} title={t.mute ? 'Unmute' : 'Mute'} onClick={() => setTrack(t.id, { mute: !t.mute })}>
              <Svg d={t.mute ? D.muted : D.speaker} size={12} />
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/** The cover frame (the video's thumbnail); a click sets it to the frame at the playhead. */
function CoverButton({ snap, track, h }: { snap: Snapshot | null; track: Track; h: number }) {
  const at = snap?.project.coverUs ?? 0
  const clip = track.clips.find((c) => at >= c.startUs && at < c.startUs + c.durationUs) ?? track.clips[0]
  const media = clip ? mediaById(snap, clip.mediaId) : undefined
  const urls = useStrip(media?.kind === 'audio' ? undefined : media)
  let url: string | undefined
  if (urls?.length && clip && media) {
    const src = clip.inUs + clamp(at - clip.startUs, 0, clip.durationUs)
    url = urls[urls.length === 1 ? 0 : clamp(Math.floor((src / Math.max(1, media.durationUs)) * urls.length), 0, urls.length - 1)]
  }
  return (
    <button type="button" className="tl-cover" style={{ height: h }} title="Set the cover frame: the frame at the playhead" onClick={setCover} disabled={!track.clips.length}>
      {url && <img src={url} alt="" />}
      <span>Cover</span>
    </button>
  )
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** 00:02, or 00:01.5 between whole seconds. */
function rulerText(t: number): string {
  const whole = Math.floor(t + 1e-6)
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`
  const frac = Math.round((t - whole) * 10)
  return frac ? `${base}.${frac}` : base
}

const Ruler = memo(function Ruler({ pps, width }: { pps: number; width: number }) {
  // Labels at least 56 px apart; a short tick halfway between them, as on the canvas.
  const major = STEPS.find((s) => s * pps >= 56) ?? 600
  const labels = []
  for (let i = 0; i * major * pps < width; i++) {
    const t = i * major
    labels.push(
      <span key={i} style={{ left: t * pps }}>
        {rulerText(t)}
      </span>,
    )
  }
  const m = major * pps
  return (
    <div
      className="tl-ruler"
      style={{
        width,
        backgroundImage: `repeating-linear-gradient(to right, #34343A 0 1px, transparent 1px ${m}px), repeating-linear-gradient(to right, #34343A 0 1px, transparent 1px ${m / 2}px)`,
        backgroundSize: `100% 10px, 100% 5px`,
      }}
    >
      {labels}
    </div>
  )
})

/** Markers (M) as flags on the ruler, and labelled ranges as a bar under the numbers. */
function Markers({ labels, pps }: { labels?: Label[]; pps: number }) {
  if (!labels?.length) return null
  return (
    <>
      {labels.map((l) =>
        l.endUs > l.startUs ? (
          <span key={l.id} className="tl-range" title={l.text} style={{ left: HEAD_W + (l.startUs / S) * pps, width: Math.max(2, ((l.endUs - l.startUs) / S) * pps) }} />
        ) : (
          <span key={l.id} className="tl-marker" title={`${l.text}  (click to go there)`} style={{ left: HEAD_W + (l.startUs / S) * pps }} onPointerDown={(e) => {
            e.stopPropagation()
            seek(l.startUs)
          }} />
        ),
      )}
    </>
  )
}

/** The playhead's head, in the ruler. */
function PlayheadHead({ pps }: { pps: number }) {
  const pos = useStore((s) => s.positionUs)
  return <span className="tl-playhead-head" style={{ transform: `translateX(${HEAD_W + (pos / S) * pps}px)` }} />
}

function Playhead({ pps, height, scrollRef }: { pps: number; height: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const pos = useStore((s) => s.positionUs)
  const playing = useStore((s) => s.playing)
  const x = HEAD_W + (pos / S) * pps
  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const visibleRight = el.scrollLeft + el.clientWidth - 40
    if (x > visibleRight || x < el.scrollLeft + HEAD_W) el.scrollLeft = x - HEAD_W - 40
  }, [x, playing])
  return <div className="tl-playhead" style={{ transform: `translateX(${x}px)`, height }} />
}

interface ClipProps {
  clip: Clip
  media?: Media
  x: number
  w: number
  inUs: Us
  dur: Us
  top: number
  h: number
  pps: number
  variant: 'main' | 'audio' | 'overlay'
  tone?: Tone
  role?: Role
  selected: boolean
  linked?: boolean
  hole?: boolean
  ghost?: boolean
  /** On a hidden or muted track. */
  dimmed?: boolean
  waveforms: boolean
  thumbnails: boolean
  /** Text is being removed from it (Vmake): the job's id. */
  busy?: string
}

/**
 * A clip whose text is being removed, greyed out under its progress and time left (app.css).
 * It follows its job by itself, ticking each second, so the timeline doesn't redraw for it.
 */
function BusyLabel({ jobId }: { jobId: string }) {
  const job = useVmakeJob(jobId)
  const dub = useStore((s) => s.dubJobs[jobId])
  const { fraction, text, head, left } = dub ? dubProgress(dub) : vmakeProgress(job)
  return (
    <>
      <span className="clip-busy" title={`${text}
${dub?.stage ?? job?.stage ?? 'Waiting for Vmake'}`}>
        <span className="busy-spin" aria-hidden="true" />
        <span className="clip-busy-text">
          <span>{head}</span>
          {left && <span className="clip-busy-left">{left}</span>}
        </span>
      </span>
      <span className={`busy-bar${fraction == null ? ' waiting' : ''}`} aria-hidden="true">
        <span style={fraction == null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </>
  )
}

const ClipView = memo(function ClipView({ clip, media, x, w, inUs, dur, top, h, pps, variant, tone, role, selected, linked, hole, ghost, dimmed, waveforms, thumbnails, busy }: ClipProps) {
  const pictureStrip = variant === 'main' || (variant === 'overlay' && !ROLES[role ?? 'overlay'].bar)
  const strip = useStrip(pictureStrip && thumbnails && media?.kind !== 'audio' ? media : undefined)
  // A video whose sound was extracted shows no waveform: its sound lives on the audio track.
  // A video over the main one plays its own sound too, so it shows its waveform as well.
  const sound = !(variant === 'overlay' && ROLES[role ?? 'overlay'].bar) && (media?.hasAudio || media?.kind === 'audio') && !clip.detached && waveforms
  const peaks = usePeaks(sound ? media : undefined)
  const width = Math.max(2, w - 1)
  const name = media?.name ?? 'Missing media'
  const cls = `clip ${variant}${selected ? ' selected' : ''}${hole ? ' hole' : ''}${ghost ? ' ghost' : ''}${dimmed ? ' dimmed' : ''}${busy && !hole ? ' busy' : ''}`
  const style: React.CSSProperties = { transform: `translate(${x}px, ${top}px)`, width, height: h }
  const keys = <Keys clip={clip} dur={dur} />
  const fades = { inPx: ((clip.fadeInUs ?? 0) / S) * pps, outPx: ((clip.fadeOutUs ?? 0) / S) * pps, curve: clip.fadeCurve ?? 'lin' }
  if (variant === 'overlay' && ROLES[role ?? 'overlay'].bar) {
    const r = ROLES[role ?? 'overlay']
    const label = clip.text?.content?.replace(/\s+/g, ' ') || (role === 'adjust' ? 'Adjustment layer' : name)
    return (
      <div className={`${cls} bar`} data-clip={hole || ghost ? undefined : clip.id} style={{ ...style, background: hole ? undefined : selected ? r.light : r.color }}>
        {!hole && (
          <>
            {width > 16 && <span className="clip-bar-label" style={{ lineHeight: `${h}px` }}>{label}</span>}
            {keys}
            {busy && <BusyLabel jobId={busy} />}
            <span className="clip-edge left" data-edge="left" />
            <span className="clip-edge right" data-edge="right" />
          </>
        )}
      </div>
    )
  }
  if (variant === 'audio') {
    const c = TONES[tone ?? 'music']
    const headH = h >= 32 ? 14 : 0
    return (
      <div className={cls} data-clip={hole || ghost ? undefined : clip.id} style={{ ...style, background: hole ? undefined : c.body }}>
        {!hole && (
          <>
            {headH > 0 && (
              <span className="clip-head" style={{ background: c.head, height: headH, lineHeight: `${headH}px` }}>
                {linked && <Icon name="link" size={10} />}
                {name}
              </span>
            )}
            {peaks && <Waveform peaks={peaks} inUs={inUs} dur={dur} w={width} h={h - headH} volume={clip.volume} peak={c.peak} avg={c.avg} speed={clip.speed ?? 1} reverse={!!clip.reverse} fades={fades} />}
            {sound && !ghost && <Fades clip={clip} w={width} top={headH} h={h - headH} fades={fades} />}
            {headH === 0 && width > 36 && <span className="clip-label">{name}</span>}
            {busy && <BusyLabel jobId={busy} />}
            <span className="clip-edge left" data-edge="left" />
            <span className="clip-edge right" data-edge="right" />
          </>
        )}
      </div>
    )
  }
  const waveH = peaks ? Math.round(h * 0.28) : 0
  return (
    <div className={cls} data-clip={hole || ghost ? undefined : clip.id} style={style}>
      {!hole && (
        <>
          {media && <Filmstrip urls={strip} media={media} inUs={inUs} w={width} h={h - waveH} pps={pps} flip={!!clip.flip} speed={clip.speed ?? 1} reverse={!!clip.reverse} dur={dur} />}
          {peaks && waveH > 0 && <Waveform peaks={peaks} inUs={inUs} dur={dur} w={width} h={waveH} volume={clip.volume} peak="rgba(237, 237, 239, 0.5)" avg="rgba(237, 237, 239, 0.25)" speed={clip.speed ?? 1} reverse={!!clip.reverse} fades={fades} />}
          {peaks && waveH > 0 && !ghost && <Fades clip={clip} w={width} top={h - waveH} h={waveH} fades={fades} />}
          {keys}
          {h >= 34 && width > 30 && (
            <span className="clip-label">
              {linked && <Icon name="link" size={10} />}
              {clip.reverse && <span className="clip-flag">Reversed</span>}
              {(clip.speed ?? 1) !== 1 && <span className="clip-flag">{+(clip.speed ?? 1).toFixed(2)}×</span>}
              {name}
            </span>
          )}
          {busy && <BusyLabel jobId={busy} />}
          <span className="clip-edge left" data-edge="left" />
          <span className="clip-edge right" data-edge="right" />
        </>
      )}
    </div>
  )
})

/** Keyframes as white diamonds along the clip's foot (any setting, one diamond per time). */
function Keys({ clip, dur }: { clip: Clip; dur: Us }) {
  const k = clip.keyframes
  if (!k || dur <= 0) return null
  const times = [...new Set(Object.values(k).flatMap((list) => list.map((p) => p.atUs)))].filter((t) => t >= 0 && t <= dur)
  return (
    <>
      {times.map((t) => (
        <span key={t} className="clip-key" aria-hidden="true" style={{ left: `${(t / dur) * 100}%` }} />
      ))}
    </>
  )
}

/** Frames at their natural shape, repeated; runs of the same frame share one element. */
function Filmstrip({ urls, media, inUs, w, h, pps, flip, speed, reverse, dur }: { urls?: string[]; media: Media; inUs: Us; w: number; h: number; pps: number; flip: boolean; speed: number; reverse: boolean; dur: Us }) {
  if (!urls?.length || h <= 4) return <div className="filmstrip" style={{ height: h }} />
  const aspect = media.width && media.height ? media.width / media.height : 9 / 16
  const tileW = Math.max(16, h * aspect)
  const n = Math.ceil(w / tileW)
  const runs: { a: number; b: number; idx: number }[] = []
  for (let i = 0; i < n; i++) {
    // The source time shown at this tile: faster clips cover more source, reversed ones run back.
    const off = (((i + 0.5) * tileW) / pps) * S * speed
    const t = reverse ? inUs + dur * speed - off : inUs + off
    const idx = urls.length === 1 ? 0 : clamp(Math.floor((t / Math.max(1, media.durationUs)) * urls.length), 0, urls.length - 1)
    const last = runs[runs.length - 1]
    if (last && last.idx === idx) last.b = i
    else runs.push({ a: i, b: i, idx })
  }
  return (
    <div className={`filmstrip${flip ? ' flipped' : ''}`} style={{ height: h }}>
      {runs.map((r) => (
        <span key={r.a} style={{ left: r.a * tileW, width: Math.min((r.b - r.a + 1) * tileW, w - r.a * tileW), backgroundImage: `url(${urls[r.idx]})`, backgroundSize: `${tileW}px ${h}px` }} />
      ))}
    </div>
  )
}

/**
 * The sound's shape: peaks in the darker colour and, inside them, the average level over
 * about 50 ms in the lighter one (the canvas's peak and RMS layers).
 */
type FadeShape = { inPx: number; outPx: number; curve: string }

/** How loud a fade is a fraction `f` of the way in (0 silent, 1 full), shaped like FFmpeg's afade curves. */
function fadeGain(f: number, curve: string): number {
  const x = Math.min(1, Math.max(0, f))
  switch (curve) {
    case 'qsin':
      return Math.sin((x * Math.PI) / 2)
    case 'hsin':
      return (1 - Math.cos(x * Math.PI)) / 2
    case 'esin':
      return 1 - Math.cos((x * Math.PI) / 2)
    case 'log':
      return Math.sqrt(x)
    case 'exp':
    case 'squ':
      return x * x
    case 'cub':
      return x * x * x
    default:
      return x
  }
}
const fadeAt = (x: number, w: number, f: FadeShape) => (f.inPx > 0 && x < f.inPx ? fadeGain(x / f.inPx, f.curve) : 1) * (f.outPx > 0 && x > w - f.outPx ? fadeGain((w - x) / f.outPx, f.curve) : 1)

/**
 * A clip's fades, as CapCut draws them: the part a fade takes shaded over its curve, and a
 * round handle at each top corner to drag the fade longer or shorter (from nothing too).
 */
function Fades({ clip, w, top, h, fades }: { clip: Clip; w: number; top: number; h: number; fades: FadeShape }) {
  if (h < 8 || w < 16) return null
  const curve = (x0: number, len: number, rising: boolean) => {
    const pts: string[] = []
    for (let i = 0; i <= 16; i++) {
      const f = i / 16
      pts.push(`${(x0 + (rising ? f : 1 - f) * len).toFixed(1)},${(h * (1 - fadeGain(f, fades.curve))).toFixed(1)}`)
    }
    return pts
  }
  const fin = Math.min(fades.inPx, w)
  const fout = Math.min(fades.outPx, w)
  return (
    <>
      <svg className="clip-fades" style={{ top, width: w, height: h }} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {fin > 0.5 && (
          <>
            <polygon points={`0,0 ${curve(0, fin, true).join(' ')} ${fin},0`} />
            <polyline points={curve(0, fin, true).join(' ')} />
          </>
        )}
        {fout > 0.5 && (
          <>
            <polygon points={`${w},0 ${curve(w - fout, fout, false).join(' ')} ${w - fout},0`} />
            <polyline points={curve(w - fout, fout, false).join(' ')} />
          </>
        )}
      </svg>
      <span className={`fade-handle in${fin > 0.5 ? ' on' : ''}`} data-fade="in" style={{ left: Math.max(fin, 7), top }} title={`Fade in${clip.fadeInUs ? ` ${(clip.fadeInUs / S).toFixed(1)} s` : ''}: drag`} />
      <span className={`fade-handle out${fout > 0.5 ? ' on' : ''}`} data-fade="out" style={{ left: Math.min(w - fout, w - 7), top }} title={`Fade out${clip.fadeOutUs ? ` ${(clip.fadeOutUs / S).toFixed(1)} s` : ''}: drag`} />
    </>
  )
}

function Waveform({ peaks, inUs, dur, w, h, volume, peak, avg, speed, reverse, fades }: { peaks: Peaks; inUs: Us; dur: Us; w: number; h: number; volume: number; peak: string; avg: string; speed: number; reverse: boolean; fades?: FadeShape }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.min(8192, Math.max(1, Math.round(w * dpr)))
    const ch = Math.max(1, Math.round(h * dpr))
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const { rate, peaks: data } = peaks
    const gain = Math.min(2, volume)
    const half = Math.max(1, Math.round(rate * 0.025))
    const levels = new Float32Array(cw)
    const means = new Float32Array(cw)
    const span = dur * speed
    // Source time at a fraction of the clip's width (reversed clips read from the end).
    const src = (f: number) => (reverse ? inUs + span * (1 - f) : inUs + span * f)
    for (let x = 0; x < cw; x++) {
      const a = src(x / cw)
      const b = src((x + 1) / cw)
      const t0 = Math.min(a, b)
      const t1 = Math.max(a, b)
      let i0 = Math.floor((t0 / S) * rate)
      const i1 = Math.max(i0 + 1, Math.ceil((t1 / S) * rate))
      const c = Math.floor((i0 + i1) / 2)
      let m = 0
      for (; i0 < i1 && i0 < data.length; i0++) if (data[i0] > m) m = data[i0]
      let sum = 0
      let n = 0
      for (let i = Math.max(0, c - half); i <= c + half && i < data.length; i++, n++) sum += data[i]
      // The fades taper it, as they do the sound.
      const g = fades ? fadeAt(x / dpr, cw / dpr, fades) : 1
      levels[x] = Math.min(1, (m / 255) * gain) * g
      means[x] = n ? Math.min(1, (sum / n / 255) * gain * 0.7) * g : 0
    }
    const draw = (vals: Float32Array, color: string) => {
      ctx.fillStyle = color
      for (let x = 0; x < cw; x++) {
        const bar = vals[x] * (ch - 2)
        if (bar < 0.5) continue
        ctx.fillRect(x, (ch - bar) / 2, 1, Math.max(1, bar))
      }
    }
    // A baseline, so silent sound still reads as sound.
    ctx.fillStyle = peak
    ctx.fillRect(0, Math.floor(ch / 2), cw, Math.max(1, Math.round(dpr)))
    draw(levels, peak)
    draw(means, avg)
  }, [peaks, inUs, dur, w, h, volume, peak, avg, speed, reverse, fades?.inPx, fades?.outPx, fades?.curve])
  return <canvas ref={ref} className="waveform" style={{ width: w, height: h }} />
}
