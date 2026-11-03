// The Audio page (the canvas's Audio.dc.html, Audacity 4 style): big tracks with their
// mix, waveforms and spectrograms, a ruler with the time selection and loop region, the
// selected track's effects chain, loudness, "Fix and tidy" and the master stage. Every
// setting is the engine's: a slider previews locally and sends one command on release.

import './audio-page.css'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { startRecording, type Recorder } from './audio'
import { forget, rateOf, samplesFor, useSamplesVersion, type Window as SampleWindow } from './audioSamples'
import { clipMenu, openMenu } from './ContextMenu'
import {
  call,
  getState,
  mediaById,
  seek,
  togglePlay,
  setScrubbing,
  setState,
  toast,
  useStore,
  type Label,
  type Media,
  type MenuEntry,
  type PasteItem,
  type Snapshot,
  type Us,
} from './store'
import {
  DEFAULT_EFFECTS,
  ROLE_COLOR,
  S,
  clock,
  effectsOf,
  effectsOn,
  envelopeAt,
  fitSpan,
  getUi,
  levelsFor,
  masterOf,
  measureSoon,
  meterPct,
  rowsOf,
  selectedRow,
  setDraft,
  setUi,
  setView,
  signed,
  spectrogramFor,
  syncLoop,
  trackLevel,
  useAudio,
  viewOf,
  viewWindow,
  wireAudioEvents,
  type EffectKey,
  type Effects,
  DEFAULT_SILENCE,
  type EnvPoint,
  type Levels,
  type SilenceRange,
  type MixTrack,
  type Row,
  type SoundClip,
  type View,
} from './audioState'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const DOTS = 'M3.5 8h.01 M8 8h.01 M12.5 8h.01'
const PLUS = 'M8 3v10 M3 8h10'

// Toolbar icons, exactly as drawn on the canvas.
const I = {
  cursor: 'M3.5 2.5l9 4.5-4 1.2-1.3 4.3z',
  split: 'M8 2.5v11 M4.5 6l-2 2 2 2 M11.5 6l2 2-2 2',
  envelope: 'M1.5 12l3.5-6 4 3.5 5.5-6.5',
  draw: 'M3 13l1-3.5 7-7 2.5 2.5-7 7z',
  zoomIn: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5 M5 7h4 M7 5v4',
  zoomOut: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M14 14l-3.5-3.5 M5 7h4',
  start: 'M3.5 3v10 M13 3.5L6.5 8l6.5 4.5z',
  play: 'M5 3v10l8.5-5z',
  pause: 'M5 3.5v9 M11 3.5v9',
  stop: 'M4 4h8v8H4z',
  loop: 'M11.5 2l2.5 2.5-2.5 2.5 M2 7.5v-1a2 2 0 0 1 2-2h10 M4.5 14L2 11.5 4.5 9 M14 8.5v1a2 2 0 0 1-2 2H2',
  record: 'M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z',
}

/** The clips a "Fix and tidy" tool works on: the selected clips, else those on the selected track inside the time selection, else the one under the playhead. */
function fixTargets(row: Row | undefined): SoundClip[] {
  const s = getState()
  const p = s.snap?.project
  if (!p) return []
  const all = p.tracks.flatMap((t) => t.clips as SoundClip[])
  const sound = (c: SoundClip) => !c.detached && !!mediaById(s.snap, c.mediaId)?.hasAudio
  const picked = all.filter((c) => s.selection.includes(c.id) && sound(c))
  if (picked.length) return picked
  const clips = ((row?.track?.clips ?? []) as SoundClip[]).filter(sound)
  const sel = getUi().sel
  if (sel) {
    const inside = clips.filter((c) => c.startUs < sel.b && c.startUs + c.durationUs > sel.a)
    if (inside.length) return inside
  }
  const t = s.positionUs
  return clips.filter((c) => t >= c.startUs && t < c.startUs + c.durationUs)
}

function needClips(row: Row | undefined): SoundClip[] | null {
  const clips = fixTargets(row)
  if (!clips.length) {
    toast('Select a clip, or put the playhead in one on the selected track', 'error')
    return null
  }
  return clips
}

/** The lanes' width in px (kept by TracksArea), for how far the zoom can go. */
let laneWidth = 1000
/** The deepest zoom, as in Audacity 4: 6,000,000 px a second (a sample about 125 px wide at 48 kHz). */
const minSpan = () => Math.max(50, Math.round((laneWidth / 6_000_000) * 1e6))

/** Zooms so the view is `span` long around `at`. */
function zoomTo(span: Us, at: Us) {
  const total = getState().snap?.durationUs ?? 0
  const fit = fitSpan(total)
  const s = clamp(span, minSpan(), fit)
  if (s >= fit) return setUi({ zoom: null })
  setUi({ zoom: { start: clamp(at - s / 2, 0, Math.max(0, fit - s)), span: s } })
}

const zoomBy = (factor: number, at?: Us) => {
  const total = getState().snap?.durationUs ?? 0
  const fit = fitSpan(total)
  const w = viewWindow(total)
  // The buttons and keys zoom around the selection's middle if there is one, else the playhead.
  const sel = getUi().sel
  const anchor = at ?? (sel ? (sel.a + sel.b) / 2 : getState().positionUs)
  const span = clamp(w.span / factor, minSpan(), fit)
  if (span >= fit) return setUi({ zoom: null })
  const frac = (anchor - w.start) / w.span
  const start = clamp(anchor - frac * span, 0, Math.max(0, fit - span))
  setUi({ zoom: { start, span } })
}

/** Source samples per screen pixel above which the page draws levels (peak and RMS) instead of the wave. */
const LINE_SPP = 2
/** Pixels per sample from which each sample is a dot on its stem. */
const STEM_PX = 4
/** The view where the pencil starts: two pixels a sample. */
const drawSpan = () => Math.round(((laneWidth / 2) * 1e6) / 48_000)

/** Draw samples on/off; turning it on zooms in to single samples around the playhead if the view is wider. */
function toggleDraw() {
  if (getUi().tool === 'draw') return setUi({ tool: 'select' })
  const w = viewWindow(getState().snap?.durationUs ?? 0)
  if (w.span > drawSpan() * LINE_SPP) zoomTo(drawSpan(), getState().positionUs)
  setUi({ tool: 'draw' })
}

// Cutting a time selection: the stretch leaves the track and what comes after closes up.

/** What Ctrl+X on a selection took (for Ctrl+V here): the same as the store's clipboard while it's this. */
let audioCut: PasteItem[] | null = null

/** The parts of a track's clips inside [a, b), as clips of their own (for the clipboard). */
function stretchOf(clips: SoundClip[], a: Us, b: Us): PasteItem[] {
  return clips
    .filter((c) => c.startUs < b && c.startUs + c.durationUs > a)
    .map((c) => {
      const s = Math.max(a, c.startUs)
      const e = Math.min(b, c.startUs + c.durationUs)
      const sp = c.speed ?? 1
      // Backwards clips play their source from the end, so the part's in point is mirrored.
      const inUs = c.reverse ? c.inUs + (c.startUs + c.durationUs - e) * sp : c.inUs + (s - c.startUs) * sp
      const clip = { ...c, startUs: Math.round(s), inUs: Math.round(inUs), durationUs: Math.round(e - s), fadeInUs: 0, fadeOutUs: 0 }
      return { clip, main: false, offsetUs: Math.round(s - a) }
    })
}

/** Ctrl+X (keep = true) or Delete on a time selection: `audio.removeRange`, then the playhead goes to where it was. */
async function cutSelection(row: Row | undefined, keep: boolean) {
  const sel = getUi().sel
  const t = row?.track
  if (!sel || !t) return
  const a = Math.round(sel.a)
  const b = Math.round(sel.b)
  const items = stretchOf(t.clips as SoundClip[], a, b)
  if (!items.length) return toast('Nothing on this track in the selection.', 'error')
  const r = await call<{ removedUs: number }>('audio.removeRange', { trackId: t.id, startUs: a, endUs: b })
  if (r === undefined) return
  if (keep) {
    audioCut = items
    setState({ clipboard: { kind: 'clips', items }, focus: 'timeline' })
  }
  setUi({ sel: null })
  place(a)
}

/** Ctrl+V after a cut here: the stretch goes back in at the playhead on the selected track. */
async function pasteCut(row: Row | undefined) {
  const cb = getState().clipboard
  if (!audioCut || cb?.kind !== 'clips' || cb.items !== audioCut) return false
  const r = await call<{ clipIds: string[] }>('clips.paste', { items: audioCut, atUs: getState().positionUs, ...(row?.track && !row.track.main ? { trackId: row.track.id } : {}) })
  if (r?.clipIds) setState({ selection: r.clipIds })
  return true
}

function splitHere(row: Row | undefined) {
  const s = getState()
  const t = s.positionUs
  const ids = s.selection.length ? s.selection : (row?.track?.clips.filter((c) => t > c.startUs && t < c.startUs + c.durationUs).map((c) => c.id) ?? [])
  call('timeline.split', { atUs: t, clipIds: ids })
}

let recorder: Recorder | null = null
async function toggleRecord() {
  if (recorder) {
    recorder.stop()
    return
  }
  try {
    setUi({ recording: true })
    recorder = await startRecording(undefined, true, () => {
      recorder = null
      setUi({ recording: false })
    })
  } catch (e) {
    recorder = null
    setUi({ recording: false })
    toast(`Recording didn't start: ${(e as Error).message}`, 'error')
  }
}

/**
 * Puts the playhead and the start line together at `t` (Home, End, grabbing the line, a cut),
 * so Space plays from there and Stop comes back there. While playing, play carries on from it.
 */
function place(t: Us) {
  const at = clamp(Math.round(t), 0, getState().snap?.durationUs ?? 0)
  setUi({ cursor: at })
  seek(at)
}

/**
 * Loop (L) on and off. Turned on with a time selection and no loop region yet, the selection
 * becomes the region, as in Audacity 4; a region is otherwise made by dragging along the top
 * strip of the ruler.
 */
function toggleLoop() {
  const u = getUi()
  if (u.loopOn) return setUi({ loopOn: false })
  if (!u.loop && u.sel && u.sel.b - u.sel.a >= 200_000) return setUi({ loop: { a: u.sel.a, b: u.sel.b }, loopOn: true })
  if (!u.loop) toast('Select a stretch first, or drag along the top strip of the ruler, to make the stretch that loops.')
  setUi({ loopOn: true })
}

/** Where playback started, for Stop. */
let playFrom: Us = 0
/** Where Space plays from and Stop returns: where you last clicked (a selection doesn't change it). */
const startPoint = () => getUi().cursor ?? playFrom
const stop = async () => {
  if (getState().playing) await call('playback.pause')
  seek(startPoint())
}
/**
 * Space and the Play button, as in Audacity: play from the start point; while playing, stop and
 * go back to it, so play, stop, play hears the same stretch again until you click elsewhere.
 */
async function playStop() {
  if (getState().playing) return stop()
  const from = startPoint()
  if (getUi().cursor == null) setUi({ cursor: from })
  seek(from)
  await call('playback.play')
}
/** P and the Play button: pause where it is; play again carries on from there. */
const playPause = () => togglePlay()
/** X: stop here, and here becomes where Space plays from. */
async function stopHere() {
  if (getState().playing) await call('playback.pause')
  setUi({ cursor: getState().positionUs })
}
/** Shift+Space: play exactly the selection, then come back to its start. */
let selectionEnd: Us | null = null
async function playSelection() {
  const sel = getUi().sel
  if (!sel || sel.b - sel.a < 10_000) return playStop()
  if (getState().playing) await call('playback.pause')
  selectionEnd = sel.b
  seek(sel.a)
  await call('playback.play')
}
/** Called as playback moves: ends a Shift+Space play at the selection's end. */
function watchSelectionEnd(pos: Us) {
  if (selectionEnd == null) return
  if (!getState().playing) selectionEnd = null
  else if (pos >= selectionEnd) {
    selectionEnd = null
    call('playback.pause').then(() => seek(getUi().sel?.a ?? pos))
  }
}
/** Manual scrolling while playing stops the view following the playhead for 3 s, as in Audacity 4. */
let scrolledAt = 0

export function AudioPage() {
  const snap = useStore((s) => s.snap)
  const trackId = useAudio((u) => u.trackId)
  const loop = useAudio((u) => u.loop)
  const loopOn = useAudio((u) => u.loopOn)
  const scale = useAudio((u) => u.scale)
  const rows = useMemo(() => rowsOf(snap), [snap, scale])
  const row = selectedRow(rows, trackId)

  useEffect(() => wireAudioEvents(), [])
  // Loudness follows the mix; the engine measures only when the sound actually changed.
  useEffect(() => measureSoon(), [snap?.revision])
  useEffect(() => syncLoop(), [loop, loopOn])
  // Leaving the page takes the loop with it, so the editor plays straight through.
  useEffect(() => () => void window.studio.engine.call('playback.setLoop', {}).catch(() => {}), [])

  // The page's own keys (from the canvas's tooltips), ahead of the editor's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && (el as HTMLInputElement).type !== 'range'
      const s = getState() as ReturnType<typeof getState> & { recordingKeys?: boolean }
      if (typing || s.dialog || s.recordingKeys || e.altKey) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      const r = selectedRow(rowsOf(s.snap), getUi().trackId)
      let run: (() => unknown) | null = null
      if (ctrl && (key === '=' || key === '+')) run = () => zoomBy(2)
      else if (ctrl && key === '-') run = () => zoomBy(0.5)
      else if (key === 'escape' && getUi().tool !== 'select') run = () => setUi({ tool: 'select' })
      // With a time selection, Ctrl+X and Delete cut it out of the selected track (the rest closes up).
      else if (ctrl && key === 'x' && getUi().sel && r?.track) run = () => cutSelection(r, true)
      else if (!ctrl && (key === 'delete' || key === 'backspace') && getUi().sel && r?.track) run = () => cutSelection(r, false)
      else if (ctrl && key === 'v' && audioCut && getState().clipboard?.kind === 'clips' && (getState().clipboard as { items: PasteItem[] }).items === audioCut) run = () => pasteCut(r)
      else if (!ctrl && key === ' ') run = e.shiftKey ? playSelection : playStop
      else if (ctrl && key === 'f') run = () => setUi({ zoom: null })
      else if (!ctrl && !e.shiftKey && key === 'home') run = () => place(0)
      else if (!ctrl && !e.shiftKey && key === 'end') run = () => place(getState().snap?.durationUs ?? 0)
      else if (!ctrl && (key === 'arrowleft' || key === 'arrowright') && getState().playing)
        // While playing, the arrows jump 5 s (15 s with Shift), as in Audacity 4.
        run = () => seek(Math.max(0, getState().positionUs + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 15 : 5) * 1_000_000))
      else if (!ctrl && !e.shiftKey) {
        if (key === 'p') run = playPause
        else if (key === 'x') run = stopHere
        else if (key === 'v') run = () => setUi({ tool: 'select' })
        else if (key === 's') run = () => splitHere(r)
        else if (key === 'e') run = () => setUi({ envelope: !getUi().envelope })
        else if (key === 'l') run = toggleLoop
        else if (key === 'r') run = toggleRecord
      }
      if (!run) return
      e.preventDefault()
      e.stopImmediatePropagation()
      run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="ap">
      <div className="ap-main">
        <Toolbar row={row} />
        <RulerRow rows={rows} />
        <TracksArea rows={rows} row={row} snap={snap} />
        <div className="ap-bottom">
          <LoudnessPanel />
          <FixPanel row={row} />
        </div>
      </div>
      <EffectsAside rows={rows} row={row} />
    </div>
  )
}

// Toolbar

function ToolButton({ label, tip, d, on, fill = 'none', color, onClick, sep }: { label: string; tip?: string; d: string; on?: boolean; fill?: string; color?: string; onClick: () => void; sep?: boolean }) {
  return (
    <>
      {sep && <span className="ap-tsep" aria-hidden="true" />}
      <button type="button" className="ap-ib ap-tool" aria-label={label} aria-pressed={!!on} title={tip ? `${label}  ${tip}` : label} style={{ background: on ? '#24242A' : 'transparent', color: color ?? (on ? '#EDEDEF' : '#C4C4CA') }} onClick={onClick}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill={fill} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={d} />
        </svg>
      </button>
    </>
  )
}

function Toolbar({ row }: { row: Row | undefined }) {
  const tool = useAudio((u) => u.tool)
  const envelope = useAudio((u) => u.envelope)
  const loopOn = useAudio((u) => u.loopOn)
  const rms = useAudio((u) => u.rms)
  const recording = useAudio((u) => u.recording)
  const sel = useAudio((u) => u.sel)
  useAudio((u) => u.views)
  const playing = useStore((s) => s.playing)
  const pos = useStore((s) => s.positionUs)
  const view = viewOf(row)
  const roleName = row?.role === 'music' ? 'Music' : row?.role === 'clip' ? 'Clip' : 'Voice'
  useEffect(() => {
    if (playing) playFrom = getState().positionUs
  }, [playing])
  const a = sel?.a ?? pos
  const b = sel?.b ?? pos
  return (
    <div role="toolbar" aria-label="Audio tools" className="ap-toolbar">
      <ToolButton label="Select" tip="V" d={I.cursor} on={tool === 'select'} onClick={() => setUi({ tool: 'select' })} />
      <ToolButton label="Split" tip="S" d={I.split} onClick={() => splitHere(row)} />
      <ToolButton label="Volume envelope" tip="E" d={I.envelope} on={envelope} onClick={() => setUi({ envelope: !envelope })} />
      <ToolButton label="Draw samples" tip="zooms in to 0.2 s" d={I.draw} on={tool === 'draw'} onClick={() => toggleDraw()} />
      <ToolButton sep label="Zoom in" tip="⌘+" d={I.zoomIn} onClick={() => zoomBy(2)} />
      <ToolButton label="Zoom out" tip="⌘−" d={I.zoomOut} onClick={() => zoomBy(0.5)} />
      <ToolButton sep label="Skip to start" tip="Home" d={I.start} onClick={() => place(0)} />
      <ToolButton label={playing ? 'Pause' : 'Play'} tip="P · Space plays from your last click, and Space again stops and goes back there" d={playing ? I.pause : I.play} fill={playing ? 'none' : 'currentColor'} color="#EDEDEF" onClick={playPause} />
      <ToolButton label="Stop" tip="" d={I.stop} onClick={stop} />
      <ToolButton label="Loop" tip="L" d={I.loop} on={loopOn} onClick={toggleLoop} />
      <ToolButton label={recording ? 'Stop recording' : 'Record here'} tip="R" d={I.record} on={recording} fill="#FF6B4A" color="#FF6B4A" onClick={toggleRecord} />
      <span className="ap-tsep wide" aria-hidden="true" />
      <span className="ap-mono">{clock(pos)}</span>
      <span className="ap-sel-label">Selection</span>
      <span className="ap-mono ap-sel-value">
        {clock(a)} – {clock(b)} · {((b - a) / S).toFixed(b - a < S ? 3 : 2)} s
      </span>
      <span className="ap-flex" />
      <span className="ap-view-label">{roleName} view</span>
      <div role="group" aria-label={`${roleName} track view`} className="ap-seg">
        {(
          [
            ['wave', 'Waveform'],
            ['spec', 'Spectrogram'],
            ['both', 'Both'],
          ] as [View, string][]
        ).map(([id, name]) => (
          <button key={id} type="button" aria-pressed={view === id} className={view === id ? 'on' : ''} onClick={() => row && setView(row.key, id)}>
            {name}
          </button>
        ))}
      </div>
      <button type="button" role="switch" aria-checked={rms} className="ap-rms" onClick={() => setUi({ rms: !rms })}>
        <Switch on={rms} />
        RMS
      </button>
    </div>
  )
}

function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className="ap-switch" style={{ background: on ? '#3B57F0' : '#34343A' }}>
      <span style={{ left: on ? 12 : 2 }} />
    </span>
  )
}

// Ruler

const LABEL_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((x) => x * S)

function useLaneWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [w, setW] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return w
}

function RulerRow({ rows }: { rows: Row[] }) {
  const total = useStore((s) => s.snap?.durationUs ?? 0)
  useAudio((u) => u.zoom)
  const loop = useAudio((u) => u.loop)
  const loopOn = useAudio((u) => u.loopOn)
  const ref = useRef<HTMLDivElement>(null)
  const width = useLaneWidth(ref)
  const win = viewWindow(total)
  const pct = (t: Us) => ((t - win.start) / win.span) * 100
  const step = LABEL_STEPS.find((s) => (s / win.span) * width >= 70) ?? 600 * S
  const ticks: { t: Us; h: number }[] = []
  for (let t = Math.floor(win.start / (step / 4)) * (step / 4); t <= win.start + win.span; t += step / 4) ticks.push({ t, h: Math.round(t / (step / 4)) % 2 === 0 ? 10 : 5 })
  const labels: Us[] = []
  for (let t = Math.floor(win.start / step) * step; t <= win.start + win.span; t += step) labels.push(t)
  // Whole seconds as 00:07; then hundredths; then, zoomed into samples, milliseconds.
  const fmt = (t: Us) => (step >= S ? clock(t).slice(0, 5) : step >= 10_000 ? clock(t).replace(/0$/, '') : `${clock(t).slice(0, 5)}.${String(Math.round(t / 1000) % 1000).padStart(3, '0')}`)

  // The view as it is now (a drag at the edge pans it while the drag goes on).
  const timeAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    const w = viewWindow(getState().snap?.durationUs ?? 0)
    return clamp(w.start + ((x - r.left) / r.width) * w.span, 0, Math.max(total, w.start + w.span))
  }
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const y = e.clientY - ref.current!.getBoundingClientRect().top
    const t0 = timeAt(e.clientX)
    if (y < 14) {
      // Dragging along the strip at the top sets the loop region (a click there does nothing,
      // so no stray sliver of a loop is left behind).
      const x0 = e.clientX
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - x0) < 6) return
        const t1 = timeAt(ev.clientX)
        setUi({ loop: { a: Math.min(t0, t1), b: Math.max(t0, t1) }, loopOn: true })
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }
    setScrubbing(true)
    seek(Math.min(t0, total))
    setUi({ cursor: Math.min(t0, total), sel: null })
    const move = (ev: PointerEvent) => {
      const t = Math.min(timeAt(ev.clientX), total)
      seek(t)
      setUi({ cursor: t })
    }
    holdUntilRelease(move)
  }

  const addTrack = async () => {
    const paths = await window.studio.app.openMedia()
    if (!paths.length) return
    const r = await call<{ imported: string[] }>('media.import', { paths })
    const at = getState().positionUs
    const sound = (r?.imported ?? []).filter((id) => mediaById(getState().snap, id)?.hasAudio)
    if (r && !sound.length) toast('None of those files has sound', 'error')
    for (const id of sound) await call('timeline.insertNewTrack', { mediaId: id, atUs: at })
  }

  return (
    <div className="ap-ruler-row">
      <div className="ap-corner">
        <span>
          {rows.length} track{rows.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="ap-ib ap-addtrack" title="Add a sound file on a track of its own, at the playhead" onClick={addTrack}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d={PLUS} />
          </svg>
          Track
        </button>
      </div>
      <div className="ap-ruler" ref={ref} onPointerDown={onDown} onPointerMove={(e) => setUi({ hover: timeAt(e.clientX) })} onPointerLeave={() => setUi({ hover: null })}>
        {loop && (
          <span
            title="Loop region"
            className="ap-loop"
            style={{ left: `${pct(loop.a)}%`, width: `${((loop.b - loop.a) / win.span) * 100}%`, background: loopOn ? '#3E4A80' : '#2A2F48' }}
            onDoubleClick={() => setUi({ loop: null })}
          />
        )}
        {ticks.map((k) => (
          <span key={`t${k.t}`} aria-hidden="true" className="ap-tick" style={{ left: `${pct(k.t)}%`, height: k.h }} />
        ))}
        {labels.map((t) => (
          <span key={`l${t}`} className="ap-rlabel" style={{ left: `calc(${pct(t)}% + 4px)` }}>
            {fmt(t)}
          </span>
        ))}
        <RulerHead pct={pct} />
        <HoverMark pct={pct} />
      </div>
    </div>
  )
}

/** The time under the mouse, marked on the ruler. */
function HoverMark({ pct }: { pct: (t: Us) => number }) {
  const hover = useAudio((u) => u.hover)
  if (hover == null) return null
  const left = pct(hover)
  return left < 0 || left > 100 ? null : <span aria-hidden="true" className="ap-hover ruler" style={{ left: `${left}%` }} />
}

function RulerHead({ pct }: { pct: (t: Us) => number }) {
  const pos = useStore((s) => s.positionUs)
  return <span aria-hidden="true" className="ap-rhead" style={{ left: `${pct(pos)}%` }} />
}

// Tracks

function TracksArea({ rows, row, snap }: { rows: Row[]; row: Row | undefined; snap: Snapshot | null }) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useLaneWidth(lanesRef)
  laneWidth = width
  const total = snap?.durationUs ?? 0
  useAudio((u) => u.zoom)
  const sel = useAudio((u) => u.sel)
  const silenceRanges = useAudio((u) => (u.silence.open ? u.silence.ranges : null))
  const win = viewWindow(total)
  const pct = (t: Us) => ((t - win.start) / win.span) * 100
  // The pauses Remove silences would take out, each on its track.
  const silenceMarks = silenceRanges?.map((m) => ({ ...m, trackId: m.trackId ?? snap?.project.tracks.find((t) => t.clips.some((c) => c.id === m.clipId || (!m.clipId && c.startUs <= m.startUs && c.startUs + c.durationUs >= m.endUs)))?.id }))

  // The wheel works as on the Edit timeline: over the lanes it scrolls sideways, Ctrl or Alt
  // zooms at the pointer, Shift changes the track height; over the heads it scrolls the tracks.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const lanes = lanesRef.current
      if (!lanes) return
      const r = lanes.getBoundingClientRect()
      const w = viewWindow(getState().snap?.durationUs ?? 0)
      const delta = e.deltaY || e.deltaX
      // A mouse wheel notch is 100 (Chromium); a trackpad sends small amounts, so it's smooth.
      const notches = delta / 100
      if (e.ctrlKey || e.altKey) {
        e.preventDefault()
        // Audacity 4: 2^(1/6) a notch (six notches double it), the time under the mouse kept still.
        zoomBy(Math.pow(2, -(e.deltaY / 100) / 6), w.start + ((e.clientX - r.left) / r.width) * w.span)
      } else if (e.shiftKey) {
        e.preventDefault()
        setUi({ scale: clamp(getUi().scale * Math.exp(-delta * 0.0012), 0.5, 1.8) })
      } else if (e.clientX >= r.left) {
        e.preventDefault()
        if (!getUi().zoom) return
        scrolledAt = performance.now()
        const fit = fitSpan(getState().snap?.durationUs ?? 0)
        // A tenth of the view a notch, as Audacity 4.
        const d = notches * w.span * 0.1
        setUi({ zoom: { span: w.span, start: clamp(w.start + d, 0, Math.max(0, fit - w.span)) } })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // The view as it is now (a drag at the edge pans it while the drag goes on).
  const timeAt = (x: number) => {
    const r = lanesRef.current!.getBoundingClientRect()
    const w = viewWindow(getState().snap?.durationUs ?? 0)
    return Math.max(0, w.start + ((x - r.left) / r.width) * w.span)
  }

  /**
   * As on the Edit timeline: a click puts the playhead there, a drag selects that stretch of
   * sound, and a double-click grabs the playhead so it follows the mouse until you let go.
   */
  const onLaneDown = (e: RPointerEvent<HTMLDivElement>, r: Row) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.ap-clip-head, .ap-label, .ap-envpt, input')) return
    if (getState().source) setState({ source: null })
    const t0 = timeAt(e.clientX)
    const x0 = e.clientX
    if (r.track) setUi({ trackId: r.key })
    const now = performance.now()
    const double = !!lastDown && now - lastDown.t < 400 && Math.abs(e.clientX - lastDown.x) < 6
    lastDown = { t: now, x: e.clientX }
    if (double) return grabPlayhead(e.clientX)
    let moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 5) return
      moved = true
      const t1 = timeAt(ev.clientX)
      const a = snapToEdges(Math.min(t0, t1))
      const b = snapToEdges(Math.max(t0, t1))
      const owner = soundRowFor(r, a, b)
      setUi({ sel: { a, b }, ...(owner.track ? { trackId: owner.key } : {}) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moved) {
        const at = snapToEdges(Math.min(t0, getState().snap?.durationUs ?? 0))
        setUi({ sel: null, cursor: at })
        // While playing, the click only marks where Space stops and comes back to.
        if (getState().playing) return
        if (getState().selection.length) setState({ selection: [] })
        seek(getUi().cursor ?? Math.min(t0, getState().snap?.durationUs ?? 0))
      }
    }
    const stopPan = panAtEdges(move)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointerup', stopPan, { once: true })
  }

  /**
   * The track a time selection is on: the one pressed, or, where that one has no sound in the
   * stretch (an empty track under the voiceover, the labels, the space below), the nearest one
   * that has, the one above first. So a drag just under a sound selects that sound.
   */
  const soundRowFor = (r: Row, a: Us, b: Us): Row => {
    const has = (x: Row) => !!x.track && !x.track.mute && x.track.clips.some((c) => c.startUs < b && c.startUs + c.durationUs > a && !!mediaById(snap, c.mediaId)?.hasAudio && !(x.track!.main && c.detached))
    if (has(r)) return r
    const i = rows.indexOf(r)
    for (let d = 1; d < rows.length; d++) for (const j of [i - d, i + d]) if (rows[j] && has(rows[j])) return rows[j]
    return r
  }

  /** Clip and label edges within 4 px pull a click or a selection edge onto them (Audacity 4). */
  const snapToEdges = (t: Us) => {
    const r = lanesRef.current?.getBoundingClientRect()
    if (!r) return t
    const tol = (4 / r.width) * win.span
    const edges = (snap?.project.tracks ?? []).flatMap((tr) => tr.clips.flatMap((c) => [c.startUs, c.startUs + c.durationUs])).concat((snap?.project.labels ?? []).flatMap((l) => [l.startUs, l.endUs]))
    let best = t
    let bestD = tol
    for (const x of edges) if (Math.abs(x - t) < bestD) [best, bestD] = [x, Math.abs(x - t)]
    return best
  }

  /**
   * The playhead follows the mouse until the button comes up (double-click, or the line itself),
   * and the start line goes with it: where you let go is where Space plays from.
   */
  const grabPlayhead = (x: number) => {
    if (getState().playing) call('playback.pause')
    setUi({ sel: null })
    setScrubbing(true)
    place(timeAt(x))
    holdUntilRelease((ev) => place(timeAt(ev.clientX)))
  }

  // The tracks sit in the middle of the panel until they fill it, as on the Edit timeline.
  const [viewH, setViewH] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tracksH = rows.reduce((h, x) => h + x.h + 6, 0)
  const padTop = Math.max(8, Math.floor((viewH - tracksH) / 2))

  return (
    <div className="ap-tracks ap-scroll" ref={scrollRef}>
      <div className="ap-heads" style={{ paddingTop: padTop }}>
        {rows.map((r) => (
          <TrackHead key={r.key} r={r} selected={r.key === row?.key} snap={snap} />
        ))}
      </div>
      <div
        className="ap-lanes"
        ref={lanesRef}
        style={{ paddingTop: padTop }}
        onPointerMove={(e) => setUi({ hover: timeAt(e.clientX) })}
        onPointerLeave={() => setUi({ hover: null })}
        onPointerDown={(e) => {
          // A press outside every track (the space above or below them) acts on the nearest one.
          if ((e.target as HTMLElement).closest('.ap-lane')) return
          const lanes = [...e.currentTarget.querySelectorAll<HTMLElement>('.ap-lane')]
          if (!lanes.length) return
          const y = e.clientY
          const near = lanes.reduce((best, el, i) => {
            const r = el.getBoundingClientRect()
            const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
            return d < best.d ? { d, i } : best
          }, { d: Infinity, i: 0 })
          onLaneDown(e, rows[near.i])
        }}
      >
        {rows.map((r) => (
          <div key={r.key} className="ap-lane" style={{ height: r.h }} onPointerDown={(e) => onLaneDown(e, r)}>
            {r.track?.clips.map((c) => {
              const left = pct(c.startUs)
              const w = (c.durationUs / win.span) * 100
              if (left > 100 || left + w < 0) return null
              return <ClipBox key={c.id} clip={c as SoundClip} row={r} left={left} width={w} px={(w / 100) * width} snap={snap} timeAt={timeAt} />
            })}
            {r.key === row?.key && sel && <span title="Time selection" className="ap-timesel" style={{ left: `${pct(sel.a)}%`, width: `${((sel.b - sel.a) / win.span) * 100}%` }} />}
            {r.track &&
              silenceMarks
                ?.filter((m) => m.trackId === r.track!.id)
                .map((m, i) => <span key={i} className="ap-silence" title={`Pause ${((m.endUs - m.startUs) / S).toFixed(2)} s`} style={{ left: `${pct(m.startUs)}%`, width: `${((m.endUs - m.startUs) / win.span) * 100}%` }} />)}
            {r.kind === 'labels' && <LabelsLane labels={snap?.project.labels ?? []} pct={pct} span={win.span} />}
          </div>
        ))}
        <CursorLines pct={pct} />
        <Playhead pct={pct} win={win} onGrab={grabPlayhead} />
      </div>
    </div>
  )
}

/**
 * Audacity's other two lines: a thin one under the mouse, and, while playing, where play
 * started (Stop comes back to it). Without playback the playhead is the cursor, one line.
 */
function CursorLines({ pct }: { pct: (t: Us) => number }) {
  const hover = useAudio((u) => u.hover)
  const cursor = useAudio((u) => u.cursor)
  const playing = useStore((s) => s.playing)
  const pos = useStore((s) => s.positionUs)
  const at = (t: Us | null) => (t == null ? null : pct(t))
  const h = at(hover)
  const c = cursor != null && (playing || Math.abs(cursor - pos) > 1000) ? at(cursor) : null
  return (
    <>
      {c != null && c >= 0 && c <= 100 && <span aria-hidden="true" className="ap-cursor" style={{ left: `${c}%` }} title="Where play started; Stop comes back here" />}
      {h != null && h >= 0 && h <= 100 && <span aria-hidden="true" className="ap-hover" style={{ left: `${h}%` }} />}
    </>
  )
}

/** The last press on a lane, so a second one close by and soon after is a double-click. */
let lastDown: { t: number; x: number } | null = null

/** How close to the tracks' edge a drag starts panning the view, as in Audacity 4. */
const EDGE_PX = 40

/**
 * While a press is held at the tracks' left or right edge, a zoomed-in view pans that way
 * (faster the further in) and the drag carries on under the pointer: the playhead, a
 * selection's edge. Returns the stop.
 */
function panAtEdges(move: (ev: PointerEvent) => void) {
  let last: PointerEvent | null = null
  const track = (ev: PointerEvent) => {
    last = ev
  }
  window.addEventListener('pointermove', track)
  let raf = 0
  const tick = () => {
    raf = requestAnimationFrame(tick)
    const el = document.querySelector('.ap-lanes')
    const z = getUi().zoom
    if (!el || !last || !z) return
    const r = el.getBoundingClientRect()
    const into = last.clientX < r.left + EDGE_PX ? last.clientX - (r.left + EDGE_PX) : last.clientX > r.right - EDGE_PX ? last.clientX - (r.right - EDGE_PX) : 0
    if (!into) return
    const fit = fitSpan(getState().snap?.durationUs ?? 0)
    const start = clamp(z.start + Math.sign(into) * z.span * 0.02 * Math.min(2, Math.abs(into) / EDGE_PX) ** 2, 0, Math.max(0, fit - z.span))
    if (start === z.start) return
    scrolledAt = performance.now()
    setUi({ zoom: { span: z.span, start } })
    move(last)
  }
  raf = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', track)
  }
}

/**
 * Follows the mouse until the press ends, however it ends: let go, the press cancelled, or the
 * window losing focus mid-drag. Scrubbing ends with it, so playback's position is shown again.
 */
function holdUntilRelease(move: (ev: PointerEvent) => void) {
  const stopPan = panAtEdges(move)
  const end = () => {
    stopPan()
    setScrubbing(false)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
}

function Playhead({ pct, win, onGrab }: { pct: (t: Us) => number; win: { start: Us; span: Us }; onGrab: (x: number) => void }) {
  const pos = useStore((s) => s.positionUs)
  const playing = useStore((s) => s.playing)
  // Zoomed in, the view follows the playhead as in Audacity 4: once it's half a second from the
  // right edge the view moves on so it sits at 75 % (very close in, under a second across, it
  // jumps to 10 %). Scrolling by hand pauses this for 3 s.
  useEffect(() => {
    watchSelectionEnd(pos)
    const z = getUi().zoom
    if (!playing || !z || performance.now() - scrolledAt < 3000) return
    const fit = fitSpan(getState().snap?.durationUs ?? 0)
    const ahead = pos + 500_000 > z.start + z.span
    if (ahead || pos < z.start) {
      const at = z.span < 1_000_000 ? pos - z.span * 0.1 : pos - z.span * 0.75
      setUi({ zoom: { span: z.span, start: clamp(at, 0, Math.max(0, fit - z.span)) } })
    }
  }, [pos, playing])
  const left = pct(pos)
  if (left < 0 || left > 100 || win.span <= 0) return null
  return (
    <span
      aria-hidden="true"
      className="ap-playhead"
      style={{ left: `${left}%` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onGrab(e.clientX)
      }}
    />
  )
}

const LABEL_COLORS = ['#E8C050', '#66A3FF', '#34B494', '#F08080']

function LabelsLane({ labels, pct, span }: { labels: Label[]; pct: (t: Us) => number; span: Us }) {
  const editing = useAudio((u) => u.editingLabel)
  const menu = (e: React.MouseEvent, l: Label) => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, [
      { label: 'Select its time', run: () => setUi({ sel: { a: l.startUs, b: l.endUs } }) },
      { label: 'Rename', run: () => setUi({ editingLabel: l.id }) },
      { label: 'Delete', run: () => call('labels.delete', { labelIds: [l.id] }) },
    ])
  }
  return (
    <>
      {labels.map((l, i) => (
        <span
          key={l.id}
          className={`ap-label${l.endUs <= l.startUs ? ' point' : ''}`}
          style={{ left: `${pct(l.startUs)}%`, width: l.endUs > l.startUs ? `${((l.endUs - l.startUs) / span) * 100}%` : undefined }}
          title={l.text}
          onClick={() => setUi({ sel: l.endUs > l.startUs ? { a: l.startUs, b: l.endUs } : null })}
          onDoubleClick={() => setUi({ editingLabel: l.id })}
          onContextMenu={(e) => menu(e, l)}
        >
          <span aria-hidden="true" className="ap-label-dot" style={{ background: LABEL_COLORS[i % LABEL_COLORS.length] }} />
          {editing === l.id ? (
            <input
              className="ap-label-input"
              autoFocus
              defaultValue={l.text}
              onBlur={(e) => {
                const text = e.currentTarget.value.trim()
                setUi({ editingLabel: null })
                if (text && text !== l.text) call('labels.set', { labelId: l.id, text })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.currentTarget.value = l.text
                  e.currentTarget.blur()
                }
              }}
            />
          ) : (
            l.text
          )}
        </span>
      ))}
    </>
  )
}

// Track headers

function TrackHead({ r, selected, snap }: { r: Row; selected: boolean; snap: Snapshot | null }) {
  const t = r.track
  const drafts = useAudio((u) => u.drafts)
  const muted = !!t?.mute
  const soloed = !!t?.solo
  const gain = t ? (drafts[`${t.id}:gain`] ?? t.gainDb ?? 0) : 0
  const pan = t ? (drafts[`${t.id}:pan`] ?? t.pan ?? 0) : 0
  const volPct = ((gain + 60) / 72) * 100
  const panText = Math.abs(pan) < 0.005 ? 'centre' : `${Math.round(Math.abs(pan) * 100)} % ${pan < 0 ? 'left' : 'right'}`

  const commitGain = () => {
    const v = getUi().drafts[`${t!.id}:gain`]
    if (v == null) return
    call('track.set', { trackId: t!.id, gainDb: v }).finally(() => setDraft(`${t!.id}:gain`, null))
  }
  const panDrag = (e: RPointerEvent<HTMLSpanElement>) => {
    if (!t || e.button !== 0) return
    e.stopPropagation()
    const y0 = e.clientY
    const x0 = e.clientX
    const p0 = pan
    const move = (ev: PointerEvent) => setDraft(`${t.id}:pan`, Math.round(clamp(p0 + (ev.clientX - x0 - (ev.clientY - y0)) / 100, -1, 1) * 100) / 100)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const v = getUi().drafts[`${t.id}:pan`]
      if (v != null) call('track.set', { trackId: t.id, pan: v }).finally(() => setDraft(`${t.id}:pan`, null))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const panKey = (e: React.KeyboardEvent) => {
    if (!t) return
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : 0
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    call('track.set', { trackId: t.id, pan: clamp(Math.round((pan + d) * 100) / 100, -1, 1) })
  }

  const more = (e: React.MouseEvent) => {
    e.stopPropagation()
    const items: MenuEntry[] = []
    if (t && !t.main) {
      items.push({ label: 'Show as a voice track', run: () => call('track.set', { trackId: t.id, role: 'voice' }), disabled: r.role === 'voice' })
      items.push({ label: 'Show as a music track', run: () => call('track.set', { trackId: t.id, role: 'music' }), disabled: r.role === 'music' })
      items.push('sep')
    }
    if (t) {
      items.push({ label: 'Reset volume and pan', run: () => call('track.set', { trackId: t.id, gainDb: 0, pan: 0, label: 'Reset volume and pan' }), disabled: !(t as MixTrack).gainDb && !(t as MixTrack).pan })
      items.push({ label: 'Turn every effect off', run: () => call('track.set', { trackId: t.id, effects: Object.fromEntries(Object.keys(DEFAULT_EFFECTS).map((k) => [k, { on: false }])) }), disabled: !effectsOn(t) })
      items.push({ label: 'Show its effects', run: () => setUi({ trackId: t.id }) })
    } else {
      const labels = getState().snap?.project.labels ?? []
      const sel = getUi().sel
      const at = getState().positionUs
      items.push({ label: sel ? 'Add a label for the selection' : 'Add a label at the playhead', run: () => call('labels.add', { items: [{ startUs: sel?.a ?? at, endUs: sel?.b ?? at + S, text: `Label ${labels.length + 1}` }] }) })
      items.push({ label: 'Label sounds in the selected clip', run: () => labelSounds(selectedRow(rowsOf(getState().snap), getUi().trackId)) })
      items.push({ label: 'Delete every label', run: () => call('labels.delete', { labelIds: labels.map((l) => l.id) }), disabled: !labels.length })
    }
    openMenu(e.clientX, e.clientY, items)
  }

  return (
    <div className="ap-head" style={{ height: r.h, background: selected ? '#1E1E22' : '#18181B' }} onPointerDown={() => t && setUi({ trackId: t.id })}>
      <div className="ap-head-main">
        <div className="ap-head-row">
          <span aria-hidden="true" className="ap-head-color" style={{ background: ROLE_COLOR[r.role] }} />
          <span className="ap-head-name" title={r.name}>
            {r.name}
          </span>
          <button
            type="button"
            className="ap-ib ap-ms"
            aria-label={`Mute ${r.name}`}
            aria-pressed={muted}
            aria-disabled={!t}
            title={t ? (muted ? 'Unmute' : 'Mute') : 'Labels have no sound'}
            style={{ background: muted ? '#3A3A40' : '#24242A', color: muted ? '#EDEDEF' : '#A3A3AB' }}
            onClick={() => t && call('track.set', { trackId: t.id, mute: !muted })}
          >
            M
          </button>
          <button
            type="button"
            className="ap-ib ap-ms"
            aria-label={`Solo ${r.name}`}
            aria-pressed={soloed}
            aria-disabled={!t}
            title={t ? (soloed ? 'Stop soloing' : 'Solo: hear only this track') : 'Labels have no sound'}
            style={{ background: soloed ? '#3A3A40' : '#24242A', color: soloed ? '#EDEDEF' : '#A3A3AB' }}
            onClick={() => t && call('track.set', { trackId: t.id, solo: !soloed })}
          >
            S
          </button>
          <button type="button" className="ap-ib ap-more" aria-label={`More options for ${r.name}`} onClick={more}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d={DOTS} />
            </svg>
          </button>
        </div>
        {r.full && t && (
          <>
            <div className="ap-head-row ap-mix">
              <span role="slider" tabIndex={0} aria-label={`Pan ${panText}`} aria-valuemin={-1} aria-valuemax={1} aria-valuenow={pan} aria-valuetext={panText} title={`Pan ${panText}. Drag to turn, double-click to centre.`} className="ap-pan" onPointerDown={panDrag} onDoubleClick={() => call('track.set', { trackId: t.id, pan: 0 })} onKeyDown={panKey}>
                <span style={{ transform: `rotate(${pan * 140}deg)` }} />
              </span>
              <span className="ap-fader">
                <span className="ap-fader-track" />
                <span className="ap-fader-fill" style={{ width: `${volPct}%` }} />
                <span className="ap-fader-knob" style={{ left: `calc(${volPct}% - 5px)` }} />
                <label htmlFor={`vol-${t.id}`} className="ap-sr">
                  Volume of {r.name}
                </label>
                <input
                  id={`vol-${t.id}`}
                  type="range"
                  min={-60}
                  max={12}
                  step={0.5}
                  value={gain}
                  onChange={(e) => setDraft(`${t.id}:gain`, Number(e.target.value))}
                  onPointerUp={commitGain}
                  onKeyUp={commitGain}
                  onBlur={commitGain}
                  onDoubleClick={() => call('track.set', { trackId: t.id, gainDb: 0 })}
                />
              </span>
              <span className="ap-db">
                {gain > 0 ? '+' : ''}
                {signed(gain, gain % 1 ? 1 : 0)} dB
              </span>
            </div>
            <button type="button" className="ap-ib ap-fxbtn" onClick={() => setUi({ trackId: t.id })}>
              Effects<span>{effectsOn(t)}</span>
            </button>
          </>
        )}
      </div>
      <Meters track={t} snap={snap} />
    </div>
  )
}

function Meters({ track, snap }: { track?: MixTrack; snap: Snapshot | null }) {
  const pos = useStore((s) => s.positionUs)
  const playing = useStore((s) => s.playing)
  useAudio((u) => u.files)
  let l = 0
  let r = 0
  const p = snap?.project
  if (track && p && playing) {
    const audible = !track.mute && (!!track.solo || !p.tracks.some((x) => x.solo))
    const [a, b] = trackLevel(track, p, pos, audible)
    l = meterPct(a)
    r = meterPct(b)
  }
  return (
    <span aria-hidden="true" className="ap-meters" title="Level from the track's sound, fader and pan (before its effects)">
      <span>
        <span style={{ height: `${l}%` }} />
      </span>
      <span>
        <span style={{ height: `${r}%` }} />
      </span>
    </span>
  )
}

// Clips

interface ClipLook {
  head: string
  body: string
  peak: string
  rms: string
  headH: number
}
const LOOK: Record<'voice' | 'music' | 'clip', ClipLook> = {
  voice: { head: '#D1E3FF', body: '#85B5FF', peak: '#142133', rms: '#4F5966', headH: 20 },
  music: { head: '#34B494', body: '#5DC3A9', peak: '#0A241E', rms: '#475B56', headH: 20 },
  clip: { head: '#4A4A52', body: '#2A2A2E', peak: '#0E0E10', rms: '#5A5A62', headH: 16 },
}

/** Envelope gain at the top of the wave area's scale (gain 1 sits at 28.6 %). */
const ENV_MAX = 1.4

const ClipBox = memo(function ClipBox({ clip, row, left, width, px, snap, timeAt }: { clip: SoundClip; row: Row; left: number; width: number; px: number; snap: Snapshot | null; timeAt: (x: number) => Us }) {
  const media = mediaById(snap, clip.mediaId)
  useAudio((u) => u.files)
  const rms = useAudio((u) => u.rms)
  useAudio((u) => u.views)
  const envOn = useAudio((u) => u.envelope)
  const tool = useAudio((u) => u.tool)
  const selected = useStore((s) => s.selection.includes(clip.id))
  const [hover, setHover] = useState(false)
  const [env, setEnv] = useState<EnvPoint[] | null>(null)
  const look = LOOK[row.role === 'labels' ? 'clip' : row.role]
  const view = viewOf(row)
  const sound = !!media?.hasAudio && !clip.detached
  const mutedClipTrack = row.kind === 'main' && !!row.track?.mute
  // A muted clip track shows just its clips, as on the canvas.
  const showWave = sound && !mutedClipTrack && view !== 'spec'
  const showSpec = sound && !mutedClipTrack && view !== 'wave'
  const levels = showWave ? levelsFor(media) : undefined
  const spec = showSpec ? spectrogramFor(media) : undefined
  const cols = Math.round(clamp(px, 50, 4000))
  const points = env ?? clip.envelope ?? []
  const label = media ? media.name.replace(/\.[^.]+$/, '') : 'Missing media'

  const yOf = (g: number) => 100 - (clamp(g, 0, ENV_MAX) / ENV_MAX) * 100
  const xOf = (at: Us) => ((at - clip.inUs) / clip.durationUs) * 100
  const showEnv = showWave && (points.length > 0 || (envOn && hover))
  const line = points.length ? [`0,${yOf(points[0].gain)}`, ...points.map((p) => `${(xOf(p.atUs) * cols) / 100},${yOf(p.gain)}`), `${cols},${yOf(points[points.length - 1].gain)}`].join(' ') : `0,${yOf(1)} ${cols},${yOf(1)}`

  /** Envelope editing: press on the line to add a point and drag it; drag a point to move it; double-click one to remove it. */
  const waveRef = useRef<HTMLDivElement>(null)
  const envDown = (e: RPointerEvent<HTMLElement>, index?: number) => {
    if (!envOn || e.button !== 0 || getUi().tool !== 'select') return
    const box = waveRef.current!.getBoundingClientRect()
    const at = clip.inUs + (timeAt(e.clientX) - clip.startUs)
    const y = ((e.clientY - box.top) / box.height) * 100
    let pts = [...points]
    let i = index
    if (i == null) {
      // Only presses near the line edit the envelope; anywhere else makes a selection.
      const g = envelopeAt(points, at)
      if (Math.abs(y - yOf(g)) > (6 / box.height) * 100) return
      pts.push({ atUs: Math.round(at), gain: g })
      pts.sort((a, b) => a.atUs - b.atUs)
      i = pts.findIndex((p) => p.atUs === Math.round(at))
    }
    e.stopPropagation()
    const moving = i
    setEnv(pts)
    const move = (ev: PointerEvent) => {
      const src = clamp(clip.inUs + (timeAt(ev.clientX) - clip.startUs), clip.inUs, clip.inUs + clip.durationUs)
      const gy = clamp(((ev.clientY - box.top) / box.height) * 100, 0, 100)
      pts = pts.map((p, k) => (k === moving ? { atUs: Math.round(src), gain: Math.round(((100 - gy) / 100) * ENV_MAX * 1000) / 1000 } : p))
      setEnv(pts)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      call('clip.set', { clipId: clip.id, envelope: [...pts].sort((a, b) => a.atUs - b.atUs) }).finally(() => setEnv(null))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const removePoint = (i: number) => call('clip.set', { clipId: clip.id, envelope: points.filter((_, k) => k !== i) })

  const headDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const sel = getState().selection
    if (e.ctrlKey || e.metaKey) setState({ selection: sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id], focus: 'timeline' })
    else setState({ selection: [clip.id], focus: 'timeline' })
    if (row.track) setUi({ trackId: row.key })
  }
  const clipMore = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!getState().selection.includes(clip.id)) setState({ selection: [clip.id], focus: 'timeline' })
    openMenu(e.clientX, e.clientY, clipMenu())
  }

  return (
    <div
      className={`ap-clip${selected ? ' selected' : ''}`}
      style={{ left: `${left}%`, width: `${width}%`, background: look.body, opacity: mutedClipTrack ? 0.45 : 1 }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault()
        clipMore(e)
      }}
    >
      <div className="ap-clip-head" style={{ height: look.headH, background: look.head }} onPointerDown={headDown}>
        <span>{label}</span>
        {row.kind !== 'main' && (
          <button type="button" className="ap-clip-more" aria-label={`More for ${label}`} onPointerDown={(e) => e.stopPropagation()} onClick={clipMore}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#111114" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d={DOTS} />
            </svg>
          </button>
        )}
      </div>
      {showWave && (
        <div className="ap-wave" ref={waveRef} onPointerDown={(e) => envDown(e)}>
          {media && <WaveCanvas clip={clip} media={media} levels={levels} look={look} rms={rms} draw={tool === 'draw'} />}
          <svg width="100%" height="100%" viewBox={`0 0 ${cols} 100`} preserveAspectRatio="none" aria-hidden="true">
            {showEnv && tool !== 'draw' && <polyline points={line} fill="none" stroke="#B7FF01" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          </svg>
          {showEnv &&
            points.map((p, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="ap-envpt"
                style={{ left: `${xOf(p.atUs)}%`, top: `${yOf(p.gain)}%` }}
                title={`${signed(20 * Math.log10(Math.max(p.gain, 0.001)), 1)} dB`}
                onPointerDown={(e) => envDown(e, i)}
                onDoubleClick={() => removePoint(i)}
              />
            ))}
        </div>
      )}
      {showSpec && (
        <div className={`ap-spec${tool === 'spectral' ? ' painting' : ''}`} onPointerDown={(e) => tool === 'spectral' && spectralDown(e, clip, timeAt)}>
          {spec && media && (
            <img
              src={spec}
              alt={`Spectrogram of ${label}, 0 to 8 kHz`}
              style={{ left: `${(-clip.inUs / clip.durationUs) * 100}%`, width: `${(media.durationUs / clip.durationUs) * 100}%` }}
            />
          )}
          {(clip.spectral ?? []).map((b, i) => {
            const sp = clip.speed ?? 1
            const l = ((b.startUs - clip.inUs) / sp / clip.durationUs) * 100
            const w = ((b.endUs - b.startUs) / sp / clip.durationUs) * 100
            return (
              <span
                key={i}
                className="ap-specbox"
                title={`Taken out: ${Math.round(b.lowHz)}–${Math.round(b.highHz)} Hz. Double-click to put it back.`}
                style={{ left: `${l}%`, width: `${w}%`, top: `${(1 - Math.min(SPEC_TOP, b.highHz) / SPEC_TOP) * 100}%`, height: `${((Math.min(SPEC_TOP, b.highHz) - Math.max(0, b.lowHz)) / SPEC_TOP) * 100}%` }}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={() => call('clip.set', { clipId: clip.id, spectral: (clip.spectral ?? []).filter((_, k) => k !== i), label: 'Put back a spectral cut' })}
              />
            )
          })}
        </div>
      )}
      {!showWave && !showSpec && <div className="ap-clip-fill" />}
    </div>
  )
})

// Spectral delete: drag a box on a spectrogram (time across, 0–8 kHz up); it's taken out.

/** The spectrogram's top frequency (the engine draws 0–8 kHz, linear). */
const SPEC_TOP = 8000

function spectralDown(e: RPointerEvent<HTMLDivElement>, clip: SoundClip, timeAt: (x: number) => Us) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const box = e.currentTarget
  const r = box.getBoundingClientRect()
  const ghost = document.createElement('span')
  ghost.className = 'ap-specbox drawing'
  box.appendChild(ghost)
  const x0 = e.clientX
  const y0 = e.clientY
  const place = (x1: number, y1: number) => {
    const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)]
    const [c, d] = [Math.max(r.top, Math.min(y0, y1)), Math.min(r.bottom, Math.max(y0, y1))]
    Object.assign(ghost.style, { left: `${a - r.left}px`, width: `${b - a}px`, top: `${c - r.top}px`, height: `${d - c}px` })
    return { a, b, c, d }
  }
  place(x0, y0)
  const move = (ev: PointerEvent) => place(ev.clientX, ev.clientY)
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    ghost.remove()
    const { a, b, c, d } = place(ev.clientX, ev.clientY)
    if (b - a < 3 || d - c < 3) return
    const sp = clip.speed ?? 1
    const src = (x: number) => Math.round(Math.max(clip.inUs, Math.min(clip.inUs + clip.durationUs * sp, clip.inUs + (timeAt(x) - clip.startUs) * sp)))
    const hz = (y: number) => Math.round(Math.max(0, Math.min(SPEC_TOP, SPEC_TOP * (1 - (y - r.top) / r.height))))
    call('audio.spectralDelete', { clipId: clip.id, startUs: src(a), endUs: src(b), lowHz: hz(d), highHz: hz(c) })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// The wave, drawn for the part of a clip that shows: levels (peak and RMS) at normal zoom; the
// real samples as a line once there are at most LINE_SPP samples a pixel; each sample as a dot
// on a stem from the centre line from STEM_PX pixels a sample. The pencil draws on the samples.

type WaveMode = 'levels' | 'line' | 'stems'

/** A clip's timeline time to its source time (speed and reverse taken into account), and back. */
function clipTimeMap(clip: SoundClip) {
  const sp = clip.speed ?? 1
  const span = clip.durationUs * sp
  const toSrc = (t: Us) => (clip.reverse ? clip.inUs + span - (t - clip.startUs) * sp : clip.inUs + (t - clip.startUs) * sp)
  const toTimeline = (src: Us) => (clip.reverse ? clip.startUs + (clip.inUs + span - src) / sp : clip.startUs + (src - clip.inUs) / sp)
  return { sp, toSrc, toTimeline }
}

function WaveCanvas({ clip, media, levels, look, rms, draw }: { clip: SoundClip; media: Media; levels: Levels | undefined; look: ClipLook; rms: boolean; draw: boolean }) {
  useAudio((u) => u.zoom)
  useSamplesVersion()
  const total = useStore((s) => s.snap?.durationUs ?? 0)
  const ref = useRef<HTMLCanvasElement>(null)
  const [edit, setEdit] = useState<{ key: string; win: SampleWindow } | null>(null)
  const win = viewWindow(total)
  const end = clip.startUs + clip.durationUs
  const vis0 = Math.max(clip.startUs, win.start)
  const vis1 = Math.min(end, win.start + win.span)
  const { sp, toSrc, toTimeline } = clipTimeMap(clip)
  const pxPerUs = laneWidth / win.span
  const rate = rateOf(media)
  const spp = (rate * sp) / 1e6 / pxPerUs
  const mode: WaveMode = spp > LINE_SPP ? 'levels' : 1 / spp >= STEM_PX ? 'stems' : 'line'
  const [lo, hi] = [toSrc(vis0), toSrc(vis1)].sort((a, b) => a - b)
  // A sample either side, so the line runs to the edges.
  const pad = (2 * 1e6) / rate
  const fetched = mode !== 'levels' && vis1 > vis0 ? samplesFor(media, Math.max(0, lo - pad), hi + pad) : null
  const key = `${media.id}|${media.path}|${Math.round(lo)}|${Math.round(hi)}`
  const samples = edit?.key === key ? edit.win : fetched
  const gain = Math.min(clip.volume, 4)

  useEffect(() => {
    const c = ref.current
    if (!c || vis1 <= vis0) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, c.clientWidth)
    const H = Math.max(1, c.clientHeight)
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(H * dpr)
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const mid = H / 2
    g.fillStyle = look.peak
    g.fillRect(0, Math.round(mid), W, 1)
    const xAt = (t: Us) => (t - vis0) * pxPerUs
    if (mode !== 'levels' && samples) {
      const at = (i: number) => samples.startUs + (i * 1e6) / samples.rate
      const i0 = Math.max(0, Math.floor(((lo - samples.startUs) * samples.rate) / 1e6) - 2)
      const i1 = Math.min(samples.data.length - 1, Math.ceil(((hi - samples.startUs) * samples.rate) / 1e6) + 2)
      const yOf = (v: number) => mid - clamp(v * gain, -1, 1) * mid * 0.95
      g.strokeStyle = look.peak
      g.fillStyle = look.peak
      if (mode === 'line') {
        g.lineWidth = 1.5
        g.beginPath()
        for (let i = i0; i <= i1; i++) {
          const x = xAt(toTimeline(at(i)))
          if (i === i0) g.moveTo(x, yOf(samples.data[i]))
          else g.lineTo(x, yOf(samples.data[i]))
        }
        g.stroke()
      } else {
        g.lineWidth = 1
        for (let i = i0; i <= i1; i++) {
          const x = xAt(toTimeline(at(i)))
          const y = yOf(samples.data[i])
          g.beginPath()
          g.moveTo(x, mid)
          g.lineTo(x, y)
          g.stroke()
          g.beginPath()
          g.arc(x, y, 2.5, 0, Math.PI * 2)
          g.fill()
        }
      }
      return
    }
    // Levels: the loudest and the RMS of each pixel's stretch of the source.
    if (!levels) return
    for (let x = 0; x < W; x++) {
      const [a, b] = [toSrc(vis0 + x / pxPerUs), toSrc(vis0 + (x + 1) / pxPerUs)].sort((p, q) => p - q)
      let i = Math.floor((a / S) * levels.rate)
      const i1 = Math.max(i + 1, Math.ceil((b / S) * levels.rate))
      let p = 0
      let r = 0
      let n = 0
      for (; i < i1 && i < levels.peak.length; i++) {
        if (i < 0) continue
        p = Math.max(p, levels.peak[i])
        r += levels.rms[i] * levels.rms[i]
        n++
      }
      const ph = Math.min(1, (p / 255) * gain) * mid
      g.fillStyle = look.peak
      g.fillRect(x, mid - ph, 1, Math.max(1, 2 * ph))
      if (rms && n) {
        const rh = Math.min(1, (Math.sqrt(r / n) / 255) * gain) * mid
        g.fillStyle = look.rms
        g.fillRect(x, mid - rh, 1, Math.max(1, 2 * rh))
      }
    }
  })

  if (vis1 <= vis0) return null
  const style = { left: `${((vis0 - clip.startUs) / clip.durationUs) * 100}%`, width: `${((vis1 - vis0) / clip.durationUs) * 100}%` }

  /** The pencil: press and drag across the samples; the new run goes to the engine on release. */
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!draw || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (mode === 'levels' || !samples) {
      // Too far out to draw: zoom in on that spot.
      const r = e.currentTarget.getBoundingClientRect()
      return zoomTo(drawSpan(), vis0 + (e.clientX - r.left) / pxPerUs)
    }
    const r = e.currentTarget.getBoundingClientRect()
    const work = { ...samples, data: samples.data.slice() }
    const idx = (x: number) => clamp(Math.round(((toSrc(vis0 + (x - r.left) / pxPerUs) - work.startUs) * work.rate) / 1e6), 0, work.data.length - 1)
    const val = (y: number) => clamp(((r.top + r.height / 2 - y) / (r.height / 2) / 0.95) / Math.max(0.05, gain), -1, 1)
    let last = { i: idx(e.clientX), v: val(e.clientY) }
    let a = last.i
    let b = last.i
    work.data[last.i] = last.v
    setEdit({ key, win: work })
    const move = (ev: PointerEvent) => {
      const p = { i: idx(ev.clientX), v: val(ev.clientY) }
      const [s0, s1] = p.i < last.i ? [p, last] : [last, p]
      for (let k = s0.i; k <= s1.i; k++) work.data[k] = s1.i === s0.i ? p.v : s0.v + ((s1.v - s0.v) * (k - s0.i)) / (s1.i - s0.i)
      a = Math.min(a, s0.i)
      b = Math.max(b, s1.i)
      last = p
      setEdit({ key, win: { ...work, data: work.data.slice() } })
    }
    const up = async () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const atUs = Math.round(work.startUs + (a * 1e6) / work.rate)
      const res = await call('audio.drawSamples', { clipId: clip.id, atUs, samples: Array.from(work.data.subarray(a, b + 1)), rate: work.rate })
      if (res !== undefined) forget(media)
      setEdit(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <>
      <canvas ref={ref} className={`ap-wavecanvas${draw ? (mode === 'levels' ? ' zoomhint' : ' pencil') : ''}`} style={style} onPointerDown={down} data-mode={mode} title={draw ? (mode === 'levels' ? 'Click to zoom in to the samples here' : 'Draw the wave with the pencil') : undefined} />
      {draw && mode === 'levels' && (
        <span className="ap-wavehint" style={style}>
          Zoom in to draw samples (click)
        </span>
      )}
    </>
  )
}

// Loudness

function LoudnessPanel() {
  const loud = useAudio((u) => u.loudness)
  const busy = useAudio((u) => u.loudnessBusy)
  const error = useAudio((u) => u.loudnessError)
  const normalising = useAudio((u) => u.normalising)
  const project = useStore((s) => s.snap?.project)
  const total = useStore((s) => s.snap?.durationUs ?? 0)
  const master = masterOf(project)
  const target = master.targetLufs
  const num = (v: number | null | undefined) => (v == null ? '–' : signed(v))
  const line = useMemo(() => {
    if (!loud?.short.length || !loud.durationUs) return ''
    // The first values sit on the floor until the 3 s window has filled: start after them.
    const first = loud.short.findIndex((v) => v > -69.9)
    return loud.short
      .map((v, i) => {
        if (first < 0 || i < first) return ''
        const x = ((i * loud.stepUs) / loud.durationUs) * 600
        const y = clamp(30 + (target - v) * 4, 4, 96)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .filter(Boolean)
      .join(' ')
  }, [loud, target])
  const normalise = async () => {
    setUi({ normalising: true })
    const r = await call<{ measured: number; gainDb: number }>('audio.normalizeMix', { targetLufs: target })
    setUi({ normalising: false })
    if (r) toast(`The mix was ${signed(r.measured)} LUFS; its gain is now ${r.gainDb > 0 ? '+' : ''}${signed(r.gainDb)} dB.`)
  }
  return (
    <section aria-labelledby="ap-loud-h" className="ap-loud">
      <div className="ap-sec-head">
        <h2 id="ap-loud-h">Loudness</h2>
        <span title={error ?? (busy ? 'Measuring…' : undefined)}>Target {signed(target, 0)} LUFS · TikTok, Reels</span>
      </div>
      <div className="ap-stats" style={{ opacity: busy ? 0.6 : 1 }}>
        <div>
          <span>{total ? num(loud?.integrated) : '–'}</span>
          <span>Integrated, LUFS</span>
        </div>
        <div>
          <span>{total ? num(loud?.truePeak) : '–'}</span>
          <span>True peak, dBTP</span>
        </div>
        <div>
          <span>{total && loud?.lra != null ? loud.lra.toFixed(1) : '–'}</span>
          <span>Range, LU</span>
        </div>
      </div>
      <div className="ap-graph">
        <svg width="100%" height="100%" viewBox="0 0 600 100" preserveAspectRatio="none" aria-label="Short-term loudness over the project" role="img">
          <path d="M0 30H600" stroke="#3B57F0" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          {line && <polyline points={line} fill="none" stroke="#EDEDEF" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span>{signed(target, 0)}</span>
      </div>
      <button type="button" className="ap-ib ap-normalise" disabled={!total || normalising} onClick={normalise}>
        Normalise the mix to {signed(target, 0)} LUFS
      </button>
    </section>
  )
}

// Fix and tidy

const FIXES: { id: string; name: string; sub: string; d: string }[] = [
  { id: 'noise', name: 'Noise reduction', sub: 'Learns the hiss, then removes it', d: 'M2 8h1.5l1.5-4 2 8 2-6 1.5 4 1.5-2H14' },
  { id: 'silences', name: 'Remove silences', sub: 'Shortens pauses over 0.5 s', d: 'M2 8h3 M11 8h3 M5 5v6 M11 5v6' },
  { id: 'normalise', name: 'Normalise', sub: 'Peak or loudness', d: 'M2 12.5h12 M2 3.5h12 M5 10V6 M8 11V5 M11 10V6' },
  { id: 'fadeIn', name: 'Fade in', sub: 'Linear, S-curve, log', d: 'M2 13L14 3 M2 13h12' },
  { id: 'fadeOut', name: 'Fade out', sub: 'Linear, S-curve, log', d: 'M2 3l12 10 M2 13h12' },
  { id: 'crossfade', name: 'Crossfade', sub: 'Between touching clips', d: 'M2 12L14 4 M2 4l12 8' },
  { id: 'pitch', name: 'Pitch', sub: 'Semitones, keeps speed', d: 'M6 12V4l7-1.5v8 M6 12a2 2 0 1 1-2-2 2 2 0 0 1 2 2z' },
  { id: 'tempo', name: 'Tempo', sub: 'Speed, keeps pitch', d: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 5v3l2 2' },
  { id: 'clicks', name: 'Click removal', sub: 'Pops and mouth clicks', d: 'M2 8h3l1-5 2 10 1-5h5' },
  { id: 'split', name: 'Split at silences', sub: 'One clip per phrase', d: 'M8 2.5v11 M2 8h3 M11 8h3' },
  { id: 'label', name: 'Label sounds', sub: 'Marks each phrase', d: 'M3 3h7l3 3v7H3z M6 8h4' },
  { id: 'spectral', name: 'Spectral delete', sub: 'Paint out a frequency', d: 'M2 13V9 M5 13V5 M8 13V7 M11 13V3 M14 13V8' },
]

const ids = (clips: SoundClip[]) => clips.map((c) => c.id)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

async function labelSounds(row: Row | undefined) {
  const clips = needClips(row)
  if (!clips) return
  const r = await call<string[]>('audio.labelSounds', { clipIds: ids(clips) })
  if (r) toast(`Labelled ${plural(r.length, 'sound')}.`)
}

function fade(row: Row | undefined, side: 'in' | 'out', x: number, y: number) {
  const apply = (curve: string) => {
    const clips = needClips(row)
    if (!clips) return
    const sel = getUi().sel
    for (const c of clips) {
      const len = clamp(sel ? sel.b - sel.a : 500_000, 10_000, c.durationUs)
      call('clip.set', { clipId: c.id, [side === 'in' ? 'fadeInUs' : 'fadeOutUs']: Math.round(len), fadeCurve: curve })
    }
  }
  const clear = () => {
    const clips = needClips(row)
    if (clips) for (const c of clips) call('clip.set', { clipId: c.id, [side === 'in' ? 'fadeInUs' : 'fadeOutUs']: 0 })
  }
  const what = getUi().sel ? 'over the selection' : '0.5 s'
  openMenu(x, y, [
    { label: `Linear, ${what}`, run: () => apply('lin') },
    { label: `S-curve, ${what}`, run: () => apply('scurve') },
    { label: `Log, ${what}`, run: () => apply('log') },
    'sep',
    { label: `Remove the fade ${side}`, run: clear },
  ])
}

async function runFix(id: string, row: Row | undefined, e: React.MouseEvent) {
  const { clientX: x, clientY: y } = e
  const t = row?.track
  switch (id) {
    case 'noise': {
      if (!t) return toast('Pick a track first', 'error')
      if (effectsOf(t).noise.on) return toast(`Noise reduction is already on for ${row!.name}; set it under Effects.`)
      await call('track.set', { trackId: t.id, effects: { noise: { on: true } }, label: 'Noise reduction' })
      setUi({ trackId: t.id })
      return toast(`Noise reduction is on for ${row!.name}. Set how much under Effects.`)
    }
    case 'silences':
      // Opens the settings, with the pauses marked live on the waveform.
      return setUi({ silence: { ...getUi().silence, open: true, ranges: null, error: null } })
    case 'normalise': {
      const go = async (mode: 'peak' | 'loudness') => {
        const clips = needClips(row)
        if (!clips) return
        const r = await call<{ clips: { measured: number; volume: number }[] }>('audio.normalize', { clipIds: ids(clips), mode })
        if (r) toast(`Normalised ${plural(r.clips.length, 'clip')} to ${mode === 'peak' ? '−1 dBFS peak' : '−14 LUFS'}.`)
      }
      return openMenu(x, y, [
        { label: 'Peak to −1 dBFS', run: () => go('peak') },
        { label: 'Loudness to −14 LUFS', run: () => go('loudness') },
      ])
    }
    case 'fadeIn':
      return fade(row, 'in', x, y)
    case 'fadeOut':
      return fade(row, 'out', x, y)
    case 'pitch': {
      const shift = (d: number | null) => {
        const clips = needClips(row)
        if (clips) for (const c of clips) call('clip.set', { clipId: c.id, pitch: d == null ? 0 : clamp((c.pitch ?? 0) + d, -12, 12) })
      }
      const now = fixTargets(row)[0]?.pitch ?? 0
      return openMenu(x, y, [
        { label: 'Up 2 semitones', run: () => shift(2) },
        { label: 'Up 1 semitone', run: () => shift(1) },
        { label: 'Down 1 semitone', run: () => shift(-1) },
        { label: 'Down 2 semitones', run: () => shift(-2) },
        'sep',
        { label: now ? `Back to the original pitch (now ${now > 0 ? '+' : ''}${signed(now, 0)})` : 'Back to the original pitch', run: () => shift(null), disabled: !now },
      ])
    }
    case 'clicks': {
      const clips = needClips(row)
      if (!clips) return
      const on = !clips.every((c) => c.declick)
      for (const c of clips) await call('clip.set', { clipId: c.id, declick: on })
      return toast(`Click removal ${on ? 'on' : 'off'} for ${plural(clips.length, 'clip')}.`)
    }
    case 'split': {
      const clips = needClips(row)
      if (!clips) return
      const r = await call<{ clipIds: string[] }>('audio.splitAtSilences', { clipIds: ids(clips) })
      if (r) toast(`Split into ${plural(r.clipIds.length, 'phrase')}.`)
      return
    }
    case 'label':
      return labelSounds(row)
    case 'crossfade': {
      const pair = crossfadePair(row)
      if (!pair) return toast('Select two clips next to each other on one track (or put the playhead in the first one).', 'error')
      const sel = getUi().sel
      const go = (us: number) => call('audio.crossfade', { clipIds: [pair[0].id, pair[1].id], durationUs: Math.round(Math.max(20_000, Math.min(us, pair[0].durationUs, pair[1].durationUs))) })
      return openMenu(x, y, [
        { label: 'Crossfade 0.25 s', run: () => go(250_000) },
        { label: 'Crossfade 0.5 s', run: () => go(500_000) },
        { label: 'Crossfade 1 s', run: () => go(1_000_000) },
        { label: sel ? `Over the selection (${((sel.b - sel.a) / S).toFixed(2)} s)` : 'Over the selection', run: () => sel && go(sel.b - sel.a), disabled: !sel },
      ])
    }
    case 'tempo': {
      const set = (speed: number) => {
        const clips = needClips(row)
        if (clips) call('clip.set', { clipIds: ids(clips), speed, keepPitch: true, label: speed === 1 ? 'Normal tempo' : `Tempo ${speed}×` })
      }
      const now = fixTargets(row)[0]?.speed ?? 1
      return openMenu(x, y, [
        ...[0.75, 0.9, 1.1, 1.25, 1.5].map((sp) => ({ label: `${sp < 1 ? 'Slower' : 'Faster'}: ${sp}×${Math.abs(now - sp) < 0.001 ? '  ✓' : ''}`, run: () => set(sp) })),
        'sep' as const,
        { label: now !== 1 ? `Normal tempo (now ${now}×)` : 'Normal tempo', run: () => set(1), disabled: now === 1 },
      ])
    }
    case 'spectral': {
      if (getUi().tool === 'spectral') return setUi({ tool: 'select' })
      if (row && viewOf(row) === 'wave') setView(row.key, 'both')
      setUi({ tool: 'spectral' })
      return toast('Drag a box on a spectrogram to take that sound out (Esc to stop). Double-click a box to put it back.')
    }
  }
}

/** Two clips for a crossfade: the two selected on one track, else the one at the playhead and the next. */
function crossfadePair(row: Row | undefined): [SoundClip, SoundClip] | null {
  const s = getState()
  const tracks = s.snap?.project.tracks ?? []
  const picked = tracks.map((t) => t.clips.filter((c) => s.selection.includes(c.id)) as SoundClip[]).find((l) => l.length === 2)
  if (picked) return [...picked].sort((a, b) => a.startUs - b.startUs) as [SoundClip, SoundClip]
  const clips = [...((row?.track?.clips ?? []) as SoundClip[])].sort((a, b) => a.startUs - b.startUs)
  const t = s.positionUs
  const i = clips.findIndex((c) => t >= c.startUs && t < c.startUs + c.durationUs)
  return i >= 0 && clips[i + 1] ? [clips[i], clips[i + 1]] : null
}

function FixPanel({ row }: { row: Row | undefined }) {
  const tool = useAudio((u) => u.tool)
  const silenceOpen = useAudio((u) => u.silence.open)
  if (silenceOpen) return <SilencePanel row={row} />
  return (
    <section aria-labelledby="ap-fix-h" className="ap-fix">
      <div className="ap-sec-head">
        <h2 id="ap-fix-h">Fix and tidy</h2>
        <span>Works on the selection, or the whole clip</span>
      </div>
      <div className="ap-fix-grid">
        {FIXES.map((f) => (
          <button key={f.id} type="button" className={`ap-fix-tile${f.id === 'spectral' && tool === 'spectral' ? ' on' : ''}`} aria-pressed={f.id === 'spectral' ? tool === 'spectral' : undefined} onClick={(e) => runFix(f.id, row, e)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#A3A3AB" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={f.d} />
            </svg>
            <span className="ap-fix-text">
              <span>{f.name}</span>
              <span>{f.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

// Remove silences: settings with the pauses marked live, then Remove.

interface SilenceScope {
  clipIds: string[]
  trackId?: string
  startUs?: Us
  endUs?: Us
  lengthUs: Us
  label: string
}

/** What Remove silences works on: the time selection on the selected track, else the selected clips, else the selected track. */
function silenceScope(row: Row | undefined): SilenceScope | null {
  const s = getState()
  const p = s.snap?.project
  if (!p) return null
  const sound = (c: SoundClip) => !c.detached && !!mediaById(s.snap, c.mediaId)?.hasAudio
  const sel = getUi().sel
  const t = row?.track
  if (sel && t) {
    const clips = (t.clips as SoundClip[]).filter((c) => sound(c) && c.startUs < sel.b && c.startUs + c.durationUs > sel.a)
    return clips.length ? { clipIds: ids(clips), trackId: t.id, startUs: Math.round(sel.a), endUs: Math.round(sel.b), lengthUs: Math.round(sel.b - sel.a), label: 'the time selection' } : null
  }
  const picked = p.tracks.flatMap((x) => x.clips as SoundClip[]).filter((c) => s.selection.includes(c.id) && sound(c))
  if (picked.length) return { clipIds: ids(picked), lengthUs: picked.reduce((n, c) => n + c.durationUs, 0), label: plural(picked.length, 'selected clip') }
  if (t) {
    const clips = (t.clips as SoundClip[]).filter(sound)
    return clips.length ? { clipIds: ids(clips), trackId: t.id, lengthUs: clips.reduce((n, c) => n + c.durationUs, 0), label: row!.name } : null
  }
  return null
}

/** Ranges as the engine sends them ({ startUs, endUs } or [a, b]), kept inside the scope's time selection. */
function silenceRanges(raw: unknown, scope: SilenceScope): SilenceRange[] {
  const list = Array.isArray(raw) ? raw : []
  return list
    .map((r): SilenceRange => (Array.isArray(r) ? { startUs: Number(r[0]), endUs: Number(r[1]) } : { startUs: Number(r?.startUs ?? r?.start), endUs: Number(r?.endUs ?? r?.end), clipId: r?.clipId, trackId: r?.trackId ?? scope.trackId }))
    .map((r) => (scope.startUs != null && scope.endUs != null ? { ...r, startUs: Math.max(r.startUs, scope.startUs), endUs: Math.min(r.endUs, scope.endUs) } : r))
    .filter((r) => Number.isFinite(r.startUs) && Number.isFinite(r.endUs) && r.endUs > r.startUs)
}

let silenceAsk = 0
let silenceTimer = 0

/**
 * Whether the engine takes `dryRun` on audio.removeSilences. An engine without it would cut
 * for real on every slider move, so dry runs wait for the engine that also has
 * `audio.removeRange` (the same update); until then the marks are worked out here.
 */
let dryRunOk: Promise<boolean> | null = null
function engineDryRun() {
  dryRunOk ??= window.studio.engine
    .call('audio.removeRange', {})
    .then(() => true)
    .catch((e: Error) => !/unknown method/i.test(e.message))
  return dryRunOk
}

/** The pauses from the levels files (peak under the threshold for at least `min`), the engine's way: `keep` left each side. */
function estimateSilences(scope: SilenceScope, thresholdDb: number, minUs: Us, keepUs: Us): SilenceRange[] | null {
  const snap = getState().snap
  const out: SilenceRange[] = []
  const limit = 255 * 10 ** (thresholdDb / 20)
  for (const id of scope.clipIds) {
    const c = snap?.project.tracks.flatMap((t) => t.clips as SoundClip[]).find((x) => x.id === id)
    const m = c && mediaById(snap, c.mediaId)
    if (!c || !m) continue
    const lv = levelsFor(m)
    if (!lv) return null
    const { sp, toTimeline } = clipTimeMap(c)
    const i0 = Math.floor((c.inUs / S) * lv.rate)
    const i1 = Math.min(lv.peak.length, Math.ceil(((c.inUs + c.durationUs * sp) / S) * lv.rate))
    let run = -1
    const close = (i: number) => {
      const a = (run / lv.rate) * S
      const b = (i / lv.rate) * S
      if ((b - a) / sp >= minUs && b - a > 2 * keepUs * sp) {
        const [x, y] = [toTimeline(a + keepUs * sp), toTimeline(b - keepUs * sp)].sort((p, q) => p - q)
        out.push({ startUs: Math.round(x), endUs: Math.round(y), clipId: c.id })
      }
      run = -1
    }
    for (let i = i0; i < i1; i++) {
      if (lv.peak[i] < limit) {
        if (run < 0) run = i
      } else if (run >= 0) close(i)
    }
    if (run >= 0) close(i1)
  }
  return out
}

function SilencePanel({ row }: { row: Row | undefined }) {
  const si = useAudio((u) => u.silence)
  useAudio((u) => u.sel)
  const revision = useStore((s) => s.snap?.revision)
  const selection = useStore((s) => s.selection)
  // Levels files arriving (for the estimate) count as a change too.
  const files = useAudio((u) => u.files)
  const scope = silenceScope(row)
  const scopeKey = JSON.stringify(scope && [scope.clipIds, scope.trackId, scope.startUs, scope.endUs])
  const params = (o: SilenceScope) => ({ clipIds: o.clipIds, ...(o.trackId ? { trackId: o.trackId } : {}), ...(o.startUs != null ? { startUs: o.startUs, endUs: o.endUs } : {}), thresholdDb: si.thresholdDb, minUs: si.minUs, keepUs: Math.min(si.keepUs, si.minUs) })
  const patch = (p: Partial<typeof si>) => setUi({ silence: { ...getUi().silence, ...p } })

  // Live: every change asks the engine (a dry run) which pauses would go.
  useEffect(() => {
    clearTimeout(silenceTimer)
    if (!scope) return patch({ ranges: [], removedUs: 0, scopeUs: 0, busy: false, error: null })
    silenceTimer = window.setTimeout(async () => {
      const n = ++silenceAsk
      patch({ busy: true })
      try {
        if (!(await engineDryRun())) {
          const est = estimateSilences(scope, si.thresholdDb, si.minUs, Math.min(si.keepUs, si.minUs))
          if (n !== silenceAsk) return
          const ranges = est ? silenceRanges(est, scope) : null
          return patch({ ranges, removedUs: (ranges ?? []).reduce((s, x) => s + x.endUs - x.startUs, 0), scopeUs: scope.lengthUs, busy: !est, error: null })
        }
        const r = await window.studio.engine.call('audio.removeSilences', { ...params(scope), dryRun: true })
        if (n !== silenceAsk) return
        const ranges = silenceRanges(r?.ranges, scope)
        patch({ ranges, removedUs: ranges.reduce((s, x) => s + x.endUs - x.startUs, 0), scopeUs: scope.lengthUs, busy: false, error: null })
      } catch (e) {
        if (n !== silenceAsk) return
        const msg = (e as Error).message
        // "No pauses longer than…" is an answer, not a failure.
        if (/no pauses/i.test(msg)) patch({ ranges: [], removedUs: 0, scopeUs: scope.lengthUs, busy: false, error: null })
        else patch({ ranges: null, busy: false, error: msg })
      }
    }, 60)
    return () => clearTimeout(silenceTimer)
  }, [si.thresholdDb, si.minUs, si.keepUs, scopeKey, revision, selection, files])

  const close = () => {
    silenceAsk++
    setUi({ silence: { ...getUi().silence, open: false, ranges: null, busy: false, error: null } })
  }
  const remove = async () => {
    if (!scope) return
    // An engine without dry runs also can't keep to a time selection: it would cut the whole clips.
    if (scope.startUs != null && !(await engineDryRun())) return toast('This engine can only remove silences from whole clips. Select the clips instead of a time selection.', 'error')
    const r = await call<{ removedUs: number }>('audio.removeSilences', params(scope))
    if (r === undefined) return
    toast(`Took out ${plural(si.ranges?.length ?? 0, 'pause')}, ${(r.removedUs / S).toFixed(1)} s.`)
    close()
  }
  const n = si.ranges?.length ?? 0
  const before = si.scopeUs / S
  const after = Math.max(0, si.scopeUs - si.removedUs) / S
  const rowsDef: [SliderDef, number, (v: number) => void, number][] = [
    [{ param: 'thresholdDb', label: 'Quieter than', min: -70, max: -20, step: 1, fmt: (v) => `${signed(v, 0)} dB` }, si.thresholdDb, (v) => patch({ thresholdDb: v }), DEFAULT_SILENCE.thresholdDb],
    [{ param: 'minUs', label: 'Shortest pause', min: 0.1, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)} s` }, si.minUs / S, (v) => patch({ minUs: Math.round(v * S) }), DEFAULT_SILENCE.minUs / S],
    [{ param: 'keepUs', label: 'Leave', min: 0, max: 0.5, step: 0.05, fmt: (v) => `${v.toFixed(2)} s` }, si.keepUs / S, (v) => patch({ keepUs: Math.round(v * S) }), DEFAULT_SILENCE.keepUs / S],
  ]
  return (
    <section aria-labelledby="ap-sil-h" className="ap-fix ap-silence-panel">
      <div className="ap-sec-head">
        <h2 id="ap-sil-h">Remove silences</h2>
        <span>{scope ? `In ${scope.label}` : 'Select a clip, a track or a time selection'}</span>
      </div>
      <div className="ap-sil-rows">
        {rowsDef.map(([def, value, set, reset]) => (
          <FxRow key={def.param} id={`sil-${def.param}`} def={def} value={value} onDraft={set} onCommit={() => {}} onReset={() => set(reset)} />
        ))}
      </div>
      <p className="ap-sil-sum" aria-live="polite">
        {si.error ? <span className="ap-sil-err">{si.error}</span> : si.ranges == null ? 'Looking for pauses…' : n ? `${plural(n, 'pause')} · ${(si.removedUs / S).toFixed(1)} s · ${before.toFixed(1)} s → ${after.toFixed(1)} s` : 'No pauses like that here.'}
        {si.busy && si.ranges != null && <span className="ap-sil-busy"> · updating</span>}
      </p>
      <p className="ap-sil-note">The marked stretches go; everything after them closes up. Quieter than sets how quiet counts as silence.</p>
      <div className="ap-sil-actions">
        <button type="button" className="ap-sil-btn primary" disabled={!scope || !n} onClick={remove}>
          Remove {n ? plural(n, 'pause') : ''}
        </button>
        <button type="button" className="ap-sil-btn" onClick={close}>
          Cancel
        </button>
      </div>
    </section>
  )
}

// Effects

interface SliderDef {
  param: string
  label: string
  min: number
  max: number
  step: number
  fmt: (v: number) => string
}

const FX: { key: EffectKey; name: string; rows: SliderDef[]; summary: (e: Effects) => string; curve?: (e: Effects) => string }[] = [
  {
    key: 'noise',
    name: 'Noise reduction',
    rows: [
      { param: 'reductionDb', label: 'Reduction', min: 0, max: 30, step: 1, fmt: (x) => `${signed(-x, 0)} dB` },
      { param: 'sensitivity', label: 'Sensitivity', min: 0, max: 24, step: 1, fmt: (x) => `${x}` },
    ],
    summary: (e) => `${signed(-e.noise.reductionDb, 0)} dB`,
  },
  {
    key: 'eq',
    name: 'EQ · voice',
    rows: [
      { param: 'highpassHz', label: 'High-pass', min: 20, max: 300, step: 1, fmt: (x) => `${x} Hz` },
      { param: 'presenceDb', label: 'Presence', min: 0, max: 12, step: 1, fmt: (x) => `+${x} dB` },
    ],
    summary: (e) => `HP ${Math.round(e.eq.highpassHz)} Hz`,
    curve: (e) => eqCurve(e.eq.highpassHz, e.eq.presenceDb),
  },
  {
    key: 'comp',
    name: 'Compressor',
    rows: [
      { param: 'thresholdDb', label: 'Threshold', min: -60, max: 0, step: 1, fmt: (x) => `${signed(x, 0)} dB` },
      { param: 'ratio', label: 'Ratio', min: 1, max: 10, step: 0.1, fmt: (x) => `${x.toFixed(1)}:1` },
      { param: 'attackMs', label: 'Attack', min: 1, max: 100, step: 1, fmt: (x) => `${x} ms` },
      { param: 'releaseMs', label: 'Release', min: 10, max: 1000, step: 10, fmt: (x) => `${x} ms` },
    ],
    summary: (e) => `${signed(e.comp.thresholdDb, 0)} dB · ${e.comp.ratio.toFixed(1)}:1`,
    curve: (e) => compCurve(e.comp.thresholdDb, e.comp.ratio),
  },
  {
    key: 'deess',
    name: 'De-esser',
    rows: [{ param: 'amountDb', label: 'Amount', min: 0, max: 12, step: 1, fmt: (x) => `${x} dB` }],
    summary: (e) => `${e.deess.amountDb} dB`,
  },
  {
    key: 'limiter',
    name: 'Limiter',
    rows: [{ param: 'ceilingDb', label: 'Ceiling', min: -6, max: 0, step: 0.1, fmt: (x) => `${signed(x, 1)} dB` }],
    summary: (e) => `${signed(e.limiter.ceilingDb, 1)} dB`,
  },
]

/** The compressor's transfer curve on the canvas's 280 × 64 box (−60 to 0 dB both ways). */
function compCurve(thr: number, ratio: number) {
  const tx = (db: number) => ((db + 60) / 60) * 280
  const ty = (db: number) => 64 - ((db + 60) / 60) * 64
  const out = (i: number) => (i < thr ? i : thr + (i - thr) / ratio)
  return `M${tx(-60)} ${ty(-60)} L${tx(thr).toFixed(1)} ${ty(thr).toFixed(1)} L280 ${ty(out(0)).toFixed(1)}`
}

/** The voice EQ's response, 20 Hz–20 kHz across, 4 px a dB around the middle: a 12 dB/octave high-pass and a Q 1 bell at 4 kHz, as the engine runs them. */
function eqCurve(hp: number, presence: number) {
  const pts: string[] = []
  const A = 10 ** (presence / 40)
  const w0 = 4000
  for (let i = 0; i <= 70; i++) {
    const f = 20 * 10 ** ((i / 70) * 3)
    const r = (f / hp) ** 4
    const hpDb = 10 * Math.log10(r / (1 + r))
    const d = w0 * w0 - f * f
    const num = Math.sqrt(d * d + ((f * w0 * A) / 1) ** 2)
    const den = Math.sqrt(d * d + ((f * w0) / A) ** 2)
    const db = hpDb + 20 * Math.log10(num / den)
    pts.push(`${((i / 70) * 280).toFixed(1)} ${clamp(34 - db * 4, 0, 64).toFixed(1)}`)
  }
  return `M${pts.join(' L')}`
}

function EffectsAside({ rows, row }: { rows: Row[]; row: Row | undefined }) {
  const drafts = useAudio((u) => u.drafts)
  const master = masterOf(useStore((s) => s.snap?.project))
  const t = row?.track
  const fx = effectsOf(t)
  const draftFx: Effects = JSON.parse(JSON.stringify(fx))
  if (t) for (const [k, v] of Object.entries(drafts)) if (k.startsWith(`${t.id}:fx.`)) {
    const [, eff, param] = k.split('.')
    ;(draftFx[eff as EffectKey] as Record<string, number | boolean>)[param] = v
  }

  const setFx = (key: EffectKey, patch: Record<string, unknown>, label?: string) => t && call('track.set', { trackId: t.id, effects: { [key]: patch }, ...(label ? { label } : {}) })
  const pick = (e: React.MouseEvent) =>
    openMenu(
      e.clientX,
      e.clientY,
      rows.filter((r) => r.track).map((r) => ({ label: r.name, run: () => setUi({ trackId: r.key }), disabled: r.key === row?.key })),
    )
  const addEffect = (e: React.MouseEvent) =>
    openMenu(
      e.clientX,
      e.clientY,
      FX.map((f) => ({ label: fx[f.key].on ? `${f.name} (on)` : f.name, run: () => setFx(f.key, { on: true }, `${f.name} on`), disabled: !t || fx[f.key].on })),
    )

  return (
    <aside aria-label="Effects" className="ap-aside">
      <div className="ap-aside-head">
        <h2>Effects</h2>
        <button type="button" className="ap-picker" onClick={pick} disabled={!rows.some((r) => r.track)}>
          <span aria-hidden="true" style={{ background: row ? ROLE_COLOR[row.role] : '#6E6E77' }} />
          {row?.name ?? 'No track'}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#8A8A93" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>
      <div className="ap-aside-body ap-scroll">
        <p className="ap-note">Live while you play. Nothing is written into the audio until export.</p>
        {FX.map((f) => {
          const on = draftFx[f.key].on
          return (
            <div key={f.key} className="ap-fx">
              <div className="ap-fx-head">
                <button type="button" role="switch" aria-checked={on} aria-label={`${f.name} on or off`} className="ap-fx-switch" disabled={!t} onClick={() => setFx(f.key, { on: !on }, `${f.name} ${on ? 'off' : 'on'}`)}>
                  <Switch on={on} />
                </button>
                <h3 style={{ color: on ? '#EDEDEF' : '#8A8A93' }}>{f.name}</h3>
                <span className="ap-fx-sum">{on ? f.summary(draftFx) : 'Off'}</span>
                <button
                  type="button"
                  className="ap-ib ap-fx-more"
                  aria-label={`More for ${f.name}`}
                  onClick={(e) =>
                    openMenu(e.clientX, e.clientY, [
                      { label: on ? 'Turn off' : 'Turn on', run: () => setFx(f.key, { on: !on }), disabled: !t },
                      { label: 'Reset to the usual settings', run: () => setFx(f.key, { ...DEFAULT_EFFECTS[f.key], on }, `Reset ${f.name}`), disabled: !t },
                    ])
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d={DOTS} />
                  </svg>
                </button>
              </div>
              {on && f.curve && (
                <svg className="ap-curve" width="100%" height="64" viewBox="0 0 280 64" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M70 0V64 M140 0V64 M210 0V64 M0 32H280" stroke="#222226" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  <path d={f.curve(draftFx)} fill="none" stroke="#50CAFF" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </svg>
              )}
              {on && t &&
                f.rows.map((s) => {
                  const key = `${t.id}:fx.${f.key}.${s.param}`
                  const v = (draftFx[f.key] as unknown as Record<string, number>)[s.param]
                  const commit = () => {
                    const d = getUi().drafts[key]
                    if (d == null) return
                    void setFx(f.key, { [s.param]: d }, f.name)?.finally(() => setDraft(key, null))
                  }
                  return <FxRow key={s.param} id={`fx-${f.key}-${s.param}`} def={s} value={v} onDraft={(x) => setDraft(key, x)} onCommit={commit} onReset={() => setFx(f.key, { [s.param]: (DEFAULT_EFFECTS[f.key] as unknown as Record<string, number>)[s.param] })} />
                })}
            </div>
          )
        })}
        <button type="button" className="ap-ib ap-addfx" onClick={addEffect} disabled={!t}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d={PLUS} />
          </svg>
          Add effect
        </button>
        <h3 className="ap-master-h">Master</h3>
        <p className="ap-master-p">On everything you export.</p>
        {[
          { name: 'Loudness normalisation', on: master.normalize, value: `${signed(master.targetLufs, 0)} LUFS`, toggle: () => call('project.setMaster', { normalize: !master.normalize }) },
          { name: 'True-peak limiter', on: master.limiter, value: `${signed(master.ceilingDb, 1)} dBTP`, toggle: () => call('project.setMaster', { limiter: !master.limiter }) },
        ].map((m) => (
          <div key={m.name} className="ap-master-row">
            <button type="button" role="switch" aria-checked={m.on} aria-label={`${m.name} on or off`} className="ap-fx-switch" onClick={m.toggle}>
              <Switch on={m.on} />
            </button>
            <span className="ap-master-name">{m.name}</span>
            <span className="ap-master-val">{m.value}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

function FxRow({ id, def, value, onDraft, onCommit, onReset }: { id: string; def: SliderDef; value: number; onDraft: (v: number) => void; onCommit: () => void; onReset: () => void }) {
  const pct = ((value - def.min) / (def.max - def.min)) * 100
  return (
    <div className="ap-fx-row">
      <label htmlFor={id}>{def.label}</label>
      <span className="ap-slider">
        <span className="ap-slider-track" />
        <span className="ap-slider-fill" style={{ width: `${pct}%` }} />
        <span className="ap-slider-knob" style={{ left: `calc(${pct}% - 5px)` }} />
        <input id={id} type="range" min={def.min} max={def.max} step={def.step} value={value} onChange={(e) => onDraft(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit} onDoubleClick={onReset} />
      </span>
      <output htmlFor={id}>{def.fmt(value)}</output>
    </div>
  )
}
