import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { attachLiveCanvas, frameMatrix, layoutOf, liveVersion, placeAt, redraw, setLivePlace, subscribeLive, type Place } from './liveText'
import { groupLines } from './captions'
import { isReels } from './reels'
import { ReelsOverlay, ReelsTextButton } from './ReelsView'
import { call, deleteSelection, exitSource, getState, mediaById, setState, step, togglePlay, useStore, type Clip, type Media, type Project, type Snapshot, type Track, type Us } from './store'
import { getUi } from './ui-state'

// Icons drawn as on the canvas (Main.dc.html), 16 px box, 1.5 px stroke.
const D = {
  safe: 'M2 6V2h4 M14 6V2h-4 M2 10v4h4 M14 10v4h-4',
  prev: 'M4 3v10 M12.5 3.5L6 8l6.5 4.5z',
  next: 'M12 3v10 M3.5 3.5L10 8l-6.5 4.5z',
  play: 'M5 3v10l8.5-5z',
  pause: 'M5 3.5v9 M11 3.5v9',
  close: 'M5 5l6 6 M11 5l-6 6',
  // Two arrows chasing each other round: turn it.
  rotate: 'M12.6 6.4A4.9 4.9 0 0 0 3.6 5.6 M3.4 9.6a4.9 4.9 0 0 0 9 .8 M12.8 3.4v3h-3 M3.2 12.6v-3h3',
}
const Svg = ({ d, size = 16, fill, width = 1.5 }: { d: string; size?: number; fill?: boolean; width?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

const ASPECTS: [string, number][] = [
  ['9:16', 9 / 16],
  ['4:5', 4 / 5],
  ['1:1', 1],
]

/** 00:07.00: minutes, seconds and hundredths, as on the canvas. */
function clock(us: Us): string {
  const cs = Math.floor(Math.max(0, us) / 10_000)
  const m = Math.floor(cs / 6000)
  const s = Math.floor(cs / 100) % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(m)}:${pad(s)}.${pad(cs % 100)}`
}

export function PlayerPanel() {
  const project = useStore((s) => s.snap?.project)
  const empty = useStore((s) => !s.snap?.durationUs && !s.source)
  const sourceName = useStore((s) => (s.source ? mediaById(s.snap, s.source.mediaId)?.name : undefined))
  const safe = useStore((s) => s.safeZones)
  const stage = useRef<HTMLDivElement>(null)
  const live = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    window.studio.player.attach('player-canvas')
  })
  useEffect(() => {
    attachLiveCanvas(live.current)
    return () => attachLiveCanvas(null)
  }, [])
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ratio = project ? project.width / project.height : 9 / 16
  const aspect = ASPECTS.find(([, r]) => Math.abs(r - ratio) < 0.01)?.[0]
  // A 9:16 project gets Meta's Reels preview on top; other shapes the plain shaded zones.
  const reels = !!project && isReels(project.width, project.height)
  // The frame fits the stage with a margin, at the project's shape.
  const availW = Math.max(0, box.w - 32)
  const availH = Math.max(0, box.h - 24)
  const fw = availW / availH > ratio ? Math.round(availH * ratio) : availW
  const fh = availW / availH > ratio ? availH : Math.round(availW / ratio)
  // The live text is drawn at the frame's size.
  useEffect(redraw, [fw, fh])
  return (
    <div className="panel player">
      <div className="player-head">
        <span className="player-title">Player</span>
        <div className="aspect-switch" role="group" aria-label="Preview format">
          {ASPECTS.map(([name]) => (
            <button key={name} type="button" className={name === aspect ? 'on' : ''} aria-pressed={name === aspect} onClick={() => name !== aspect && call('project.setFormat', { aspect: name })}>
              {name}
            </button>
          ))}
        </div>
        <button type="button" className={`safe-button${safe ? ' on' : ''}`} aria-pressed={safe} title={reels ? 'Show Instagram Reels over the video, as Meta’s ad preview draws it' : 'Show where TikTok and Reels put their buttons'} onClick={() => setState({ safeZones: !safe })}>
          <Svg d={D.safe} size={13} />
          Safe zones
        </button>
        {safe && reels && <ReelsTextButton />}
      </div>
      {sourceName && (
        <div className="player-source">
          <span className="player-source-label">
            Preview <strong title={sourceName}>{sourceName}</strong>
          </span>
          <button type="button" onClick={exitSource}>
            Back to timeline
          </button>
        </div>
      )}
      <div className="player-stage" ref={stage}>
        <div className="player-frame" style={{ width: fw, height: fh }}>
          <canvas id="player-canvas" />
          <canvas ref={live} className="player-live" aria-hidden="true" />
          {empty && <p className="player-empty">Add media to the timeline to see it here.</p>}
          {safe && reels && <ReelsOverlay />}
          {fw > 0 && project && <Stage fw={fw} fh={fh} pw={project.width} ph={project.height} />}
          {safe && !reels && (
            <>
              <span className="safe-zone top" aria-hidden="true" />
              <span className="safe-zone side" aria-hidden="true" />
              <span className="safe-zone bottom" aria-hidden="true" />
              <span className="safe-note">App UI covers the shaded parts</span>
            </>
          )}
        </div>
      </div>
      <Transport />
    </div>
  )
}

/** Time, frame steps and play, for the timeline or for the library clip being previewed. */
function Transport() {
  const source = useStore((s) => s.source)
  const sourceMedia = useStore((s) => (s.source ? mediaById(s.snap, s.source.mediaId) : undefined))
  const timelinePos = useStore((s) => s.positionUs)
  const timelineTotal = useStore((s) => s.snap?.durationUs ?? 0)
  const timelinePlaying = useStore((s) => s.playing)
  const fullPlayer = useStore((s) => s.fullPlayer)
  const pos = source ? source.positionUs : timelinePos
  const total = source ? (sourceMedia?.kind === 'image' ? 3_000_000 : (sourceMedia?.durationUs ?? 0)) : timelineTotal
  const playing = source ? source.playing : timelinePlaying
  const disabled = !total
  return (
    <div className={`transport${source ? ' source' : ''}`}>
      <span className="tc">
        {clock(pos)}
        <span className="tc-total"> / {clock(total)}</span>
      </span>
      <div className="transport-buttons">
        <button type="button" className="ib" title="Previous frame  ←" aria-label="Previous frame" onClick={() => step(-1)} disabled={disabled}>
          <Svg d={D.prev} size={15} />
        </button>
        <button type="button" className="ib play" title={playing ? 'Pause  Space' : 'Play  Space'} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay} disabled={disabled}>
          {playing ? <Svg d={D.pause} /> : <Svg d={D.play} fill />}
        </button>
        <button type="button" className="ib" title="Next frame  →" aria-label="Next frame" onClick={() => step(1)} disabled={disabled}>
          <Svg d={D.next} size={15} />
        </button>
      </div>
      <button type="button" className={`ib full-button${fullPlayer ? ' on' : ''}`} title={fullPlayer ? 'Exit full screen  F' : 'Full screen  F'} aria-label={fullPlayer ? 'Exit full screen' : 'Full screen'} aria-pressed={fullPlayer} onClick={() => setState({ fullPlayer: !fullPlayer })}>
        <Svg d={D.safe} size={14} />
      </button>
    </div>
  )
}

/** A clip's size before its own scale, in project pixels (rotated by quarter turns, cropped). */
function baseBox(clip: Clip, media: Media | undefined, pw: number, ph: number, main: boolean): { w: number; h: number } {
  if (!media || !media.width || !media.height) return { w: pw, h: ph }
  let w = media.width * (clip.crop?.w ?? 1)
  let h = media.height * (clip.crop?.h ?? 1)
  if ((clip.rotate ?? 0) % 180 === 90) [w, h] = [h, w]
  const k = clip.fit === 'fill' || (main && clip.fit !== 'fit') ? Math.max(pw / w, ph / h) : Math.min(pw / w, ph / h)
  return { w: w * k, h: h * k }
}

/** What can be picked on the player: a clip showing at the playhead, with its track and media. */
interface Item {
  clip: Clip
  track: Track
  media?: Media
}

/** The clips showing at `t` in the order a click finds them: text and captions, then stickers and overlays, then the main track; the top track first in each. */
function itemsAt(snap: Snapshot, t: Us): Item[] {
  const groups: Item[][] = [[], [], []]
  for (const track of [...snap.project.tracks].reverse()) {
    if (track.kind !== 'video' || track.hidden || track.role === 'adjust') continue
    for (const clip of track.clips) {
      if (t < clip.startUs || t >= clip.startUs + clip.durationUs) continue
      const media = mediaById(snap, clip.mediaId)
      if (!clip.text && (!media || media.kind === 'audio')) continue
      groups[clip.text ? 0 : track.main ? 2 : 1].push({ clip, track, media })
    }
  }
  return groups.flat()
}

/** A clip's box on the player, in frame pixels: its middle, size and turn. */
interface Box {
  cx: number
  cy: number
  w: number
  h: number
  rot: number
}

/**
 * Where a clip shows on the player at `place`. Text: the box of what's drawn (a caption line
 * at its height), through the place the engine gives its drawing; pictures: as fitted.
 */
function boxOf(it: Item, place: Place, p: Project, k: number): Box {
  const s = place.scale / 100
  if (it.clip.text) {
    const b = layoutOf(it.clip, p).bounds
    const c = frameMatrix(p, place, k).transformPoint(new DOMPoint(b.x + b.w / 2, b.y + b.h / 2))
    return { cx: c.x, cy: c.y, w: b.w * s * k, h: b.h * s * k, rot: place.rotation }
  }
  const base = baseBox(it.clip, it.media, p.width, p.height, it.track.main)
  return { cx: (p.width / 2 + place.posX) * k, cy: (p.height / 2 + place.posY) * k, w: base.w * s * k, h: base.h * s * k, rot: place.rotation }
}

/** Whether frame point (x, y) is inside the box, give or take `slack` pixels. */
function inside(b: Box, x: number, y: number, slack = 3) {
  const a = (-b.rot * Math.PI) / 180
  const dx = x - b.cx
  const dy = y - b.cy
  return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= b.w / 2 + slack && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= b.h / 2 + slack
}

const boxStyle = (b: Box) => ({ left: b.cx - b.w / 2, top: b.cy - b.h / 2, width: b.w, height: b.h, transform: `rotate(${b.rot}deg)` })

/** A drag's place for a clip; kept after the release until the engine's snapshot has it. */
type Live = { id: string; place: Place; dragging: boolean }

/**
 * The player's own layer, CapCut-style: a click picks the clip under the pointer (as a click
 * on the timeline does), a click on nothing drops the selection, and the pointer over a clip
 * outlines it. The selected clip gets a box: drag inside it to move it, a corner to scale,
 * the button below to turn it, × to delete it. A setting with keyframes gets a keyframe at
 * the playhead instead. Text moves with the box (liveText.ts draws it there).
 */
function Stage({ fw, pw, ph }: { fw: number; fh: number; pw: number; ph: number }) {
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const pos = useStore((s) => s.positionUs)
  const playing = useStore((s) => s.playing)
  const source = useStore((s) => s.source)
  useSyncExternalStore(subscribeLive, liveVersion)
  const [live, setLive] = useState<Live | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const release = useRef(0)

  const items = snap && !source ? itemsAt(snap, pos) : []
  const selected = selection.length === 1 ? items.find((i) => i.clip.id === selection[0]) : undefined
  // The place in the snapshot; the drag's while it lasts.
  const was = (it: Item): Place => {
    const { opacity: _o, ...pl } = placeAt(it.clip, pos)
    return pl
  }
  const placeOf = (it: Item) => (live?.id === it.clip.id ? live.place : was(it))
  const k = fw / pw
  const box = (it: Item) => boxOf(it, placeOf(it), snap!.project, k)

  // Once the snapshot has the place a drag left, the drag lets go of it.
  const end = (id: string) => {
    window.clearTimeout(release.current)
    setLive(null)
    setLivePlace(id, null)
  }
  useEffect(() => {
    if (!live || live.dragging) return
    const it = items.find((i) => i.clip.id === live.id)
    const now = it && was(it)
    if (!now || (['posX', 'posY', 'scale', 'rotation'] as const).every((n) => Math.abs(Math.round(live.place[n] * 10) / 10 - now[n]) < 0.06)) end(live.id)
  }, [snap])
  useEffect(() => () => window.clearTimeout(release.current), [])

  if (!snap || source) return null

  const at = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  // Inside the selected clip's box it's always that clip (CapCut drags what's selected).
  const pick = (x: number, y: number) => (selected && inside(box(selected), x, y) ? selected : items.find((it) => inside(box(it), x, y)))

  // Sends the change: keyframed settings get a keyframe at the playhead, the rest their value.
  // False when nothing changed.
  const commit = (clip: Clip, from: Place, v: Place) => {
    const t = pos - clip.startUs
    const own: Record<string, number> = {}
    const keys = { ...(clip.keyframes ?? {}) }
    let keyed = false
    for (const name of ['posX', 'posY', 'scale', 'rotation'] as const) {
      const value = Math.round(v[name] * 10) / 10
      if (Math.abs(value - Math.round(from[name] * 10) / 10) < 0.05) continue
      if (keys[name]?.length) {
        keys[name] = [...keys[name].filter((q) => Math.abs(q.atUs - t) > 20_000), { atUs: t, value }].sort((a, b) => a.atUs - b.atUs)
        keyed = true
      } else own[name] = value
    }
    if (!Object.keys(own).length && !keyed) return false
    // A caption line with Apply to all captions on: every line of its language goes there too.
    const track = snap.project.tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (clip.caption && !keyed && track && getUi('insp.capAll', true)) {
      const ids = groupLines(getState().snap, track.id).map((l) => l.clip.id)
      call('clip.set', { clipIds: ids, ...own, label: 'Move all captions' })
      return true
    }
    // A text clip with Apply to all text on (the Inspector's tick): every text clip takes it too.
    if (clip.text && !clip.caption && !keyed && getUi('insp.textAll', false)) {
      const ids = [...new Set([clip.id, ...snap.project.tracks.filter((t) => t.role === 'text' && !t.locked).flatMap((t) => t.clips.filter((c) => c.text).map((c) => c.id))])]
      call('clip.set', { clipIds: ids, ...own, label: 'Apply to all text' })
      return true
    }
    call('clip.set', { clipId: clip.id, ...own, ...(keyed ? { keyframes: keys } : {}), label: 'Transform' })
    return true
  }

  const drag = (mode: 'move' | 'scale' | 'rotate', it: Item, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const clip = it.clip
    if (playing || it.track.locked || clip.transformOn === false || clip.busy) return
    const from = was(it)
    const r = ref.current!.getBoundingClientRect()
    const x0 = e.clientX
    const y0 = e.clientY
    // The picture turns and grows about its own middle: the frame's, plus its position.
    const ox = r.left + (pw / 2 + from.posX) * k
    const oy = r.top + (ph / 2 + from.posY) * k
    const startDist = Math.max(1, Math.hypot(x0 - ox, y0 - oy))
    const startAngle = Math.atan2(y0 - oy, x0 - ox)
    let last = from
    let moved = false
    window.clearTimeout(release.current)
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return
      moved = true
      if (mode === 'move') {
        // Shift keeps it on one axis; it snaps to the centre lines within a few pixels.
        let dx = (ev.clientX - x0) / k
        let dy = (ev.clientY - y0) / k
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        let px = from.posX + dx
        let py = from.posY + dy
        if (Math.abs(px) < 6 / k) px = 0
        if (Math.abs(py) < 6 / k) py = 0
        last = { ...from, posX: px, posY: py }
      } else if (mode === 'scale') {
        const d = Math.hypot(ev.clientX - ox, ev.clientY - oy)
        last = { ...from, scale: Math.max(1, Math.min(400, from.scale * (d / startDist))) }
      } else {
        const turned = ((Math.atan2(ev.clientY - oy, ev.clientX - ox) - startAngle) * 180) / Math.PI
        let a = ((((from.rotation + turned + 180) % 360) + 360) % 360) - 180
        // Snaps to the quarter turns within 4°; Shift snaps to 15° steps.
        for (const q of [-180, -90, 0, 90, 180]) if (Math.abs(a - q) < 4) a = q
        last = { ...from, rotation: ev.shiftKey ? Math.round(a / 15) * 15 : a }
      }
      setLive({ id: clip.id, place: last, dragging: true })
      if (clip.text) setLivePlace(clip.id, last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moved || !commit(clip, from, last)) return end(clip.id)
      // Keep showing the new place until the engine's snapshot has it (see above).
      setLive({ id: clip.id, place: last, dragging: false })
      release.current = window.setTimeout(() => end(clip.id), 2000)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const { x, y } = at(e)
    const it = pick(x, y)
    // The timeline takes Ctrl+C/X/V and Delete after a click here, as after a click on it.
    if (!it) return setState({ selection: [], focus: 'timeline' })
    if (selection.length !== 1 || selection[0] !== it.clip.id) setState({ selection: [it.clip.id], focus: 'timeline' })
    else setState({ focus: 'timeline' })
    drag('move', it, e)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons) return
    const { x, y } = at(e)
    const id = pick(x, y)?.clip.id ?? null
    if (id !== hover) setHover(id)
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = at(e)
    const it = pick(x, y)
    if (it?.clip.text) window.dispatchEvent(new CustomEvent('studio:edit-text', { detail: it.clip.id }))
  }

  const hovered = hover && hover !== selected?.clip.id ? items.find((i) => i.clip.id === hover) : undefined
  const handles = selected && !playing ? selected : undefined
  const b = handles && box(handles)
  // A locked track's clip, one with its transform off, or one whose text is being removed, is
  // outlined but stays put.
  const fixed = handles && (handles.track.locked || handles.clip.transformOn === false || !!handles.clip.busy)
  return (
    <div ref={ref} className={`ph-stage${hover ? ' over' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} onDoubleClick={onDoubleClick}>
      {hovered && <span className="ph-hover" style={boxStyle(box(hovered))} />}
      {handles && b && (
        <>
          <div className="ph-box" style={boxStyle(b)}>
            {!fixed && (['nw', 'ne', 'sw', 'se'] as const).map((c) => <span key={c} className={`ph-corner ${c}`} onPointerDown={(e) => drag('scale', handles, e)} />)}
            {!handles.track.locked && !handles.clip.busy && (
              <button
                type="button"
                className="ph-delete"
                aria-label="Delete"
                title="Delete  Del"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSelection()
                }}
              >
                <Svg d={D.close} size={10} width={1.8} />
              </button>
            )}
            {!fixed && (
              <button type="button" className="ph-rotate" aria-label="Rotate" title="Drag to rotate (Shift: 15° steps)" onPointerDown={(e) => drag('rotate', handles, e)}>
                <Svg d={D.rotate} size={12} width={1.6} />
              </button>
            )}
          </div>
          {live?.dragging && (
            <span className="ph-readout" style={{ left: b.cx, top: b.cy - (Math.abs(b.w * Math.sin((b.rot * Math.PI) / 180)) + Math.abs(b.h * Math.cos((b.rot * Math.PI) / 180))) / 2 - 30 }}>
              {Math.round(live.place.posX)}, {Math.round(live.place.posY)} · {Math.round(live.place.scale)} % · {Math.round(live.place.rotation)}°
            </span>
          )}
        </>
      )}
    </div>
  )
}
