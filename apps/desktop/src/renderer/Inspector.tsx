import './inspector.css'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Pills, SelectButton } from './controls'
import { INSP_ICONS } from './design-icons'
import { basename, timecode } from './format'
import { Buttons, ColourRow, CurveBox, CurveEditor, HslRanges, IconsRow, KeyList, Note, PairRow, Presets, Row, Sec, SegRow, SelectRow, SliderRow, Wheels, type WheelValue } from './InspectorBlocks'
import { clipKeys, keyValue, lookValue, setEase, setKeys, setLook, useLookVersion } from './inspector-look'
import { applyCaptionLook, brandOf, captionTracks, editCaptionLine, restyleCaptions, saveLook, textGestureForAll, trackObject, updateText } from './libraryActions'
import { CaptionLinesTab } from './CaptionsPanel'
import { StemsTab } from './StemsTab'
import { DubTab } from './DubTab'
import { previewCaptionLook } from './captions'
import { liveVersion, lookOf as liveLook, previewTextLook, subscribeLive } from './liveText'
import { PresetStyles } from './PresetStyles'
import { DEFAULT_TEXT } from './textPresets'
import { BusyBar } from './LibraryBlocks'
import { MASK_DEFAULTS, maskValues, type Mask, type MaskShape } from './masks'
import { FONTS, WEIGHTS, fontDef, fontLabel, nearestWeight, projectFontFamilies } from './textFonts'
import type { TextLook } from './textRender'
import { autoReframe, followTarget, hasTrackTargets, matteInfo, removeBackground, reSmooth, resetReframe, setMatteEdge, stopFollowing, trackTargets, wasReframed, type MatteMethod } from './vision'
import { call, cancelTextRemoval, deleteSelection, ffmpegShort, findClip, mediaById, setState, splitAtPlayhead, taskElapsed, toast, useRunningTask, useStore, useVmakeJob, vmakeProgress, type Clip, type Media, type Task, type Track } from './store'
import { setUi, useUi } from './ui-state'

export const FORMATS: [string, number, number][] = [
  ['9:16', 1080, 1920],
  ['4:5', 1080, 1350],
  ['1:1', 1080, 1080],
  ['16:9', 1920, 1080],
]

const TAB_NAMES: Record<string, string> = { captions: 'Captions', video: 'Video', audio: 'Audio', stems: 'Stems', dub: 'Dub', speed: 'Speed', animation: 'Animation', adjust: 'Adjust', text: 'Text', tracking: 'Tracking', project: 'Project', selection: 'Selection' }

export function InspectorPanel() {
  const count = useStore((s) => s.selection.length)
  return <div className="panel inspector">{count === 0 ? <ProjectView /> : count === 1 ? <ClipView /> : <MultiView count={count} />}</div>
}

// The frame around every view: tabs, the name and where it's from, then the body.

function Shell({ tabs, tab, onTab, name, source, title, children }: { tabs: string[]; tab: string; onTab?: (t: string) => void; name: string; source: string; title?: string; children: ReactNode }) {
  return (
    <>
      <div className="insp-tabs" role="group" aria-label="Inspector sections">
        {tabs.map((t) => (
          <button key={t} type="button" aria-pressed={t === tab} className={t === tab ? 'on' : ''} onClick={() => onTab?.(t)}>
            {TAB_NAMES[t]}
          </button>
        ))}
      </div>
      <div className="insp-head" title={title}>
        <span className="insp-name">{name}</span>
        <span className="insp-source">{source}</span>
      </div>
      <div className="insp-body">{children}</div>
    </>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 00:07.00 */
const clock = (us: number) => {
  const cs = Math.round(Math.max(0, us) / 10_000)
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`
}
const plus = (x: number) => `${x > 0 ? '+' : ''}${x}`
const dbOf = (vol: number) => (vol <= 0.001 ? -60 : Math.max(-60, Math.min(12, Math.round(20 * Math.log10(vol)))))
const gainOf = (db: number) => (db <= -60 ? 0 : Math.round(10 ** (db / 20) * 1000) / 1000)
const dbText = (x: number) => (x <= -60 ? '−∞ dB' : `${plus(x)} dB`)
const tenths = (unit: string) => (x: number) => `${(x / 10).toFixed(1)}${unit}`
/** A text box with `x` px of room at its sides; the room above and below keeps its share of it. */
const padTo = (b: NonNullable<TextLook['background']>, x: number) => ({ ...b, padding: x, padY: b.padY === undefined || b.padding <= 0 ? undefined : Math.round((b.padY * x * 10) / b.padding) / 10 })

/** How keyframes read in the Animation tab's list, by the param they're stored under. */
const KEY_TEXT: Record<string, (v: number) => string> = {
  scale: (v) => `Scale ${v} %`,
  posX: (v) => `Position X ${v} px`,
  posY: (v) => `Position Y ${v} px`,
  rotation: (v) => `Rotation ${v}°`,
  opacity: (v) => `Opacity ${v} %`,
  volume: (v) => `Volume ${dbText(dbOf(v))}`,
  speed: (v) => `Speed ${v.toFixed(1)}×`,
  fadeIn: (v) => `Fade in ${tenths(' s')(v)}`,
  fadeOut: (v) => `Fade out ${tenths(' s')(v)}`,
}
const keyText = (param: string, v: number) => KEY_TEXT[param]?.(v) ?? `${param[0].toUpperCase()}${param.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()} ${plus(v)}`

// One clip

function ClipView() {
  const snap = useStore((s) => s.snap)
  const id = useStore((s) => s.selection[0])
  const dubJobs = useStore((s) => s.dubJobs)
  const [tab, setTab] = useUi('insp.tab', 'video')
  useLookVersion()
  // A line just redrawn (captions get new ids) is selected a moment before the store has it:
  // the view stays on what it showed until then, rather than blinking empty.
  const last = useRef<ReturnType<typeof findClip>>(null)
  const found = findClip(snap, id) ?? last.current
  last.current = found
  if (!found) return null
  const { clip, track } = found
  if (clip.text) return <TextView clip={clip} track={track} />
  if (!clip.mediaId) return <AdjustmentView clip={clip} />
  const media = mediaById(snap, clip.mediaId)
  const kind = media?.kind ?? 'video'
  const overlay = !track.main && track.kind === 'video'
  // A video over the main one plays its own sound too, so it has the Audio tab. Anything with
  // sound has Stems (its sound split into parts by the server).
  const sound = kind === 'audio' || (kind === 'video' && !!media?.hasAudio)
  const stems = sound ? ['stems'] : []
  const tabs = kind === 'audio' ? ['audio', 'stems', 'speed'] : overlay ? ['video', ...(sound ? ['audio', 'stems'] : []), 'animation', 'adjust', ...(kind === 'video' ? ['speed'] : []), 'tracking'] : kind === 'image' ? ['video', 'animation', 'adjust'] : ['video', 'audio', ...stems, 'dub', 'speed', 'animation', 'adjust']
  const cur = tabs.includes(tab) ? tab : tabs[0]
  const fps = snap?.project.fps ?? 30
  const file = media ? `${media.dir ? `${media.dir}/` : ''}${basename(media.path)}` : 'Missing media'
  const details = media
    ? [
        media.path,
        `On the timeline at ${timecode(clip.startUs, fps)}, ${timecode(clip.durationUs, fps)} long`,
        media.kind !== 'image' ? `From the source ${timecode(clip.inUs, fps)} – ${timecode(clip.inUs + clip.durationUs, fps)}` : '',
        media.kind !== 'audio' ? `Source ${media.width} × ${media.height}${media.fps ? ` · ${Math.round(media.fps * 100) / 100} fps` : ''}` : '',
        track.main ? 'Main track' : overlay ? `${track.role ? `${track.role[0].toUpperCase()}${track.role.slice(1)}` : 'Overlay'} track` : 'Audio track',
      ]
        .filter(Boolean)
        .join('\n')
    : undefined
  const dubbing = clip.busy ? dubJobs[clip.busy] : undefined
  // Text is being removed from it (or dubbed): how far along, and nothing to change until it's done.
  // A dub's clip shows its Dub tab (its review, or how far along it is).
  if (clip.busy)
    return (
      <Shell tabs={dubbing ? ['dub'] : tabs} tab={dubbing ? 'dub' : cur} onTab={setTab} name={(media?.name ?? 'Missing media').replace(/\.[^.]+$/, '')} source={`${file} · ${(clip.durationUs / 1e6).toFixed(1)} s at ${clock(clip.startUs)}`} title={details}>
        {dubbing ? <DubTab clip={clip} media={media} /> : <BusyClip jobId={clip.busy} />}
      </Shell>
    )
  return (
    <Shell tabs={tabs} tab={cur} onTab={setTab} name={(media?.name ?? 'Missing media').replace(/\.[^.]+$/, '')} source={`${file} · ${(clip.durationUs / 1e6).toFixed(1)} s at ${clock(clip.startUs)}`} title={details}>
      {cur === 'video' && media ? <VideoTab clip={clip} media={media} track={track} /> : cur === 'audio' ? <AudioTab clip={clip} media={media} track={track} /> : cur === 'stems' ? <StemsTab clip={clip} media={media} /> : cur === 'dub' ? <DubTab clip={clip} media={media} /> : cur === 'speed' ? <SpeedTab clip={clip} /> : cur === 'animation' ? <AnimationTab clip={clip} /> : cur === 'adjust' ? <AdjustTab clip={clip} /> : cur === 'tracking' ? <TrackingTab clip={clip} /> : null}
    </Shell>
  )
}

/** Value helpers for one clip: read a control's value (the clip's field), send a change. */
function useClipValues(clip: Clip) {
  const v = <T,>(k: string, d: T) => lookValue(clip, k, d)
  const set = (k: string, x: unknown, label?: string) => setLook([clip.id], { [k]: x }, label)
  return { v, set }
}

// Video

const RATIOS: Record<string, number> = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 }
const turned = (clip: Clip) => (clip.rotate ?? 0) % 180 === 90

/** The crop that gives `name` (9:16 …) from the middle of the picture. */
function centredCrop(media: Media, clip: Clip, name: string) {
  const src = media.width / Math.max(1, media.height)
  const want = turned(clip) ? 1 / RATIOS[name] : RATIOS[name]
  if (src > want) {
    const w = want / src
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  const h = src / want
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}

/** Which ratio the clip's crop is, if any. */
function ratioOf(media: Media, clip: Clip) {
  const c = clip.crop
  if (!c || !media.height) return 'Free'
  let r = (c.w * media.width) / (c.h * media.height)
  if (turned(clip)) r = 1 / r
  return Object.keys(RATIOS).find((n) => Math.abs(r - RATIOS[n]) / RATIOS[n] < 0.02) ?? 'Free'
}

const MASKS: [string, string, MaskShape | null][] = [
  ['None', INSP_ICONS.none, null],
  ['Line', INSP_ICONS.line, 'line'],
  ['Mirror', INSP_ICONS.mirror, 'mirror'],
  ['Circle', INSP_ICONS.circle, 'circle'],
  ['Rectangle', INSP_ICONS.rect, 'rect'],
  ['Heart', INSP_ICONS.heart, 'heart'],
  ['Star', 'M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4 4.3 13.5l.8-4.2L2 6.4l4.2-.5z', 'star'],
]
const BLENDS: [string, string][] = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['add', 'Add'],
  ['softlight', 'Soft light'],
  ['difference', 'Difference'],
]
const STAB: [string, number][] = [
  ['Light', 30],
  ['Medium', 60],
  ['Strong', 90],
]
const METHODS: [MatteMethod, string][] = [
  ['person', 'Person'],
  ['subject', 'Any subject'],
]

function VideoTab({ clip, media, track }: { clip: Clip; media: Media; track: Track }) {
  // Slow jobs on this clip show their progress right here, not only in the title bar.
  const reframing = useRunningTask('reframe', clip.id)
  const matting = useRunningTask('matte', clip.id)
  const { v, set } = useClipValues(clip)
  const ids = [clip.id]
  const aspect = useStore((s) => FORMATS.find(([, w, h]) => w === s.snap?.project.width && h === s.snap?.project.height)?.[0] ?? 'this format')
  const on = v('transformOn', true)
  const [follow, setFollow] = useUi<'face' | 'object'>(`insp.rf.follow.${clip.id}`, 'face')
  const [movement, setMovement] = useUi<'Smooth' | 'Snappy'>(`insp.rf.move.${clip.id}`, 'Smooth')
  const [method, setMethod] = useUi<MatteMethod>(`insp.bg.method.${clip.id}`, matteInfo(clip)?.method ?? 'person')
  const [edge, setEdge] = useUi(`insp.bg.edge.${clip.id}`, matteInfo(clip)?.edge ?? 2)
  const matte = matteInfo(clip)
  const stab = v<{ strength: number } | null>('stabilize', null)
  const mask = v<Mask | null>('mask', null)
  const resetTransform = () => setLook(ids, { scale: 100, posX: 0, posY: 0, rotation: 0, opacity: 100, flipV: false, flip: false, rotate: 0 }, 'Reset transform')
  const setMask = async (m: Mask | null) => {
    try {
      await setLook(ids, await maskValues(clip.id, m), m ? 'Mask' : 'Remove mask')
    } catch (e) {
      toast(`Couldn’t draw the mask: ${(e as Error).message}`, 'error')
    }
  }
  const maskPatch = (patch: Partial<Mask>) => mask && setMask({ ...mask, ...patch })
  const reframed = wasReframed(clip.id)
  return (
    <>
      <Sec first title="Transform" on={on} onToggle={(x) => set('transformOn', x, x ? 'Transform on' : 'Transform off')} onReset={resetTransform} />
      {on ? (
        <>
          <SliderRow label="Scale" value={v('scale', 100)} min={0} max={400} reset={100} format={(x) => `${x} %`} onCommit={(x) => set('scale', x)} clip={clip} keyParam="scale" />
          <SegRow
            label="Frame"
            className="seg"
            items={[
              ['fill', 'Fill'],
              ['fit', 'Fit'],
            ]}
            value={clip.fit}
            onPick={(f) => f !== clip.fit && set('fit', f)}
          />
          <PairRow
            label="Position"
            x={v('posX', 0)}
            y={v('posY', 0)}
            clip={clip}
            params={['posX', 'posY']}
            onCommit={(x, y) => {
              setLook(ids, { posX: x, posY: y })
              keyValue(clip, 'posX', x)
              keyValue(clip, 'posY', y)
            }}
          />
          <SliderRow label="Rotation" value={v('rotation', 0)} min={-180} max={180} reset={0} center={0} format={(x) => `${x}°`} onCommit={(x) => set('rotation', x)} clip={clip} keyParam="rotation" />
          <SliderRow label="Opacity" value={v('opacity', 100)} min={0} max={100} reset={100} format={(x) => `${x} %`} onCommit={(x) => set('opacity', x)} clip={clip} keyParam="opacity" />
          <IconsRow
            label="Flip"
            items={[
              ['Flip horizontal', INSP_ICONS.flipH],
              ['Flip vertical', INSP_ICONS.flipV],
            ]}
            isOn={(n) => (n === 'Flip horizontal' ? v('flip', false) : v('flipV', false))}
            onPick={(n) => (n === 'Flip horizontal' ? set('flip', !v('flip', false), 'Flip horizontal') : set('flipV', !v('flipV', false), 'Flip vertical'))}
          />
        </>
      ) : (
        <Note>Transform is off: scale, position, rotation and opacity are kept but not used.</Note>
      )}
      {track.main && (
        <>
          <Sec title="Crop" onReset={() => clip.crop && set('crop', null, 'Reset crop')} />
          <SegRow label="Ratio" items={['Free', '9:16', '4:5', '1:1']} value={ratioOf(media, clip)} onPick={(r) => (r === 'Free' ? setState({ dialog: 'crop', cropClip: clip.id }) : set('crop', centredCrop(media, clip, r), `Crop ${r}`))} />
          <Note>Pick Free to drag the corners yourself.</Note>
        </>
      )}
      <Sec title="Auto reframe" onReset={() => resetReframe(clip)} />
      <SegRow
        label="Follow"
        items={[
          ['face', 'Face'],
          ['object', 'Object'],
        ]}
        value={follow}
        onPick={(x) => {
          setFollow(x as 'face' | 'object')
          if (reframed) autoReframe(clip.id, x as 'face' | 'object', movement)
        }}
      />
      <SegRow
        label="Movement"
        items={['Smooth', 'Snappy']}
        value={movement}
        onPick={(x) => {
          setMovement(x as 'Smooth' | 'Snappy')
          if (reframed) reSmooth(clip.id, x as 'Smooth' | 'Snappy')
        }}
      />
      <Buttons items={[{ label: reframing ? `Reframing · ${taskElapsed(reframing)}` : reframed ? `Reframed for ${aspect}: again` : `Reframe for ${aspect}`, onClick: () => autoReframe(clip.id, follow, movement), disabled: !!reframing, title: 'Follows the face or object through the clip and keyframes the position' }]} />
      {reframing && <BusyLine task={reframing} />}
      <Note>Keeps the {follow === 'face' ? 'face' : 'main object'} in frame for the project’s format. Smooth glides; Snappy keeps up with fast moves.</Note>
      <Sec title="Mask" onReset={() => mask && setMask(null)} />
      <IconsRow label="Shape" items={MASKS.map(([n, d]) => [n, d] as [string, string])} isOn={(n) => (MASKS.find(([m]) => m === n)?.[2] ?? null) === (mask?.shape ?? null)} onPick={(n) => {
        const shape = MASKS.find(([m]) => m === n)?.[2] ?? null
        if (!shape) return setMask(null)
        setMask({ shape, ...(mask && mask.shape !== shape ? { ...MASK_DEFAULTS[shape], x: mask.x, y: mask.y, invert: mask.invert, feather: mask.feather } : MASK_DEFAULTS[shape]) })
      }} />
      {mask && (
        <>
          <PairRow label="Centre" x={Math.round(mask.x * 100)} y={Math.round(mask.y * 100)} onCommit={(x, y) => maskPatch({ x: Math.max(-50, Math.min(150, x)) / 100, y: Math.max(-50, Math.min(150, y)) / 100 })} />
          {mask.shape !== 'line' && mask.shape !== 'mirror' && <SliderRow label="Width" value={Math.round(mask.w * 100)} min={2} max={200} reset={60} format={(x) => `${x} %`} onCommit={(x) => maskPatch({ w: x / 100 })} />}
          {mask.shape !== 'line' && <SliderRow label="Height" value={Math.round(mask.h * 100)} min={2} max={200} reset={34} format={(x) => `${x} %`} onCommit={(x) => maskPatch({ h: x / 100 })} />}
          <SliderRow label="Rotation" value={Math.round(mask.rotation)} min={-180} max={180} reset={0} center={0} format={(x) => `${x}°`} onCommit={(x) => maskPatch({ rotation: x })} />
          <SliderRow label="Feather" value={Math.round(mask.feather)} min={0} max={100} reset={0} format={(x) => `${x}`} onCommit={(x) => maskPatch({ feather: x })} />
          <SegRow
            label="Keep"
            items={[
              ['in', 'Inside'],
              ['out', 'Outside'],
            ]}
            value={mask.invert ? 'out' : 'in'}
            onPick={(x) => maskPatch({ invert: x === 'out' })}
          />
          <Note>Centre is in % of the frame. The shape is drawn at the project’s size.</Note>
        </>
      )}
      {matting && <BusyLine task={matting} />}
      <Sec
        title="Remove background"
        on={!!clip.matte || !!matting}
        onToggle={(x) => (x ? removeBackground(clip.id, method, edge) : set('matte', null, 'Keep the background'))}
        onReset={() => {
          setEdge(2)
          if (clip.matte) set('matte', null, 'Keep the background')
        }}
      />
      <SegRow
        label="Method"
        items={METHODS}
        value={matte?.method ?? method}
        onPick={(x) => {
          setMethod(x as MatteMethod)
          if (clip.matte) removeBackground(clip.id, x as MatteMethod, edge)
        }}
      />
      <SliderRow
        label="Edge"
        value={matte?.edge ?? edge}
        min={0}
        max={20}
        reset={2}
        format={(x) => `${x} px`}
        onCommit={(x) => {
          setEdge(x)
          if (clip.matte) setMatteEdge(clip.id, x)
        }}
      />
      <Note>{clip.matte ? `Background removed (${METHODS.find(([m]) => m === (matte?.method ?? method))?.[1]}). Edge softens the cut-out.` : 'Person finds people; Any subject keeps what’s in the middle of the frame and follows it.'}</Note>
      <Sec title="Stabilise" on={!!stab} onToggle={(x) => set('stabilize', x ? { strength: 60 } : null, x ? 'Stabilise' : 'Stop stabilising')} onReset={() => stab && set('stabilize', null, 'Stop stabilising')} />
      {stab && <SegRow label="Strength" items={STAB.map(([n]) => n)} value={STAB.reduce((a, b) => (Math.abs(b[1] - stab.strength) < Math.abs(a[1] - stab.strength) ? b : a))[0]} onPick={(x) => set('stabilize', { strength: STAB.find(([n]) => n === x)![1] })} />}
      {stab && <Note>The first play analyses the shake; until then the clip plays as it was. Export waits for it.</Note>}
      {!track.main && (
        <>
          <Sec title="Blend" onReset={() => set('blend', 'normal')} />
          <SelectRow label="Mode" value={BLENDS.find(([k]) => k === v('blend', 'normal'))?.[1] ?? 'Normal'} options={BLENDS.map(([, l]) => l)} onChange={(x) => set('blend', BLENDS.find(([, l]) => l === x)?.[0] ?? 'normal')} />
        </>
      )}
    </>
  )
}

// Audio

function AudioTab({ clip, media, track }: { clip: Clip; media?: Media; track: Track }) {
  const hasSound = media?.kind === 'audio' || !!media?.hasAudio
  // Noise reduction and voice EQ run on the clip's track; loudness on the whole export.
  const fx = (track as { effects?: { noise?: { on?: boolean; reductionDb?: number }; eq?: { on?: boolean; presenceDb?: number } } }).effects ?? {}
  const master = (useStore((s) => s.snap?.project) as { master?: { normalize?: boolean; targetLufs?: number } } | undefined)?.master
  const enh = !!fx.eq?.on
  const nr = !!fx.noise?.on
  const loud = master?.normalize ?? true
  const LOUD: [string, number][] = [
    ['−14 LUFS · social', -14],
    ['−16 LUFS · podcast', -16],
    ['−23 LUFS · broadcast', -23],
  ]
  const target = LOUD.find(([, n]) => n === Math.round(master?.targetLufs ?? -14))?.[0] ?? `${master?.targetLufs ?? -14} LUFS`
  const effects = (patch: Record<string, unknown>) => call('track.set', { trackId: track.id, effects: patch })
  const canDetach = track.main && media?.kind === 'video' && hasSound && !clip.detached
  // Muted by "Use only these" (Stems tab): its stems play in its place.
  const byStems = useStore((s) => !!clip.detached && ((!track.main && track.kind === 'audio') || (!!clip.link && !!s.snap?.project.tracks.some((t) => t.clips.some((c) => c.link === clip.link && c.id !== clip.id && /[\\/]stems[\\/]/.test(mediaById(s.snap, c.mediaId)?.path ?? ''))))))
  const note = !hasSound ? 'This clip has no sound.' : byStems ? 'This clip is muted: its stems play instead (Stems tab).' : clip.detached ? 'This clip is muted. Its sound is on its own audio track.' : clip.volume === 0 ? 'This clip is muted.' : null
  return (
    <>
      {note && <Note>{note}</Note>}
      <Sec
        first
        title="Volume"
        onReset={() => {
          call('clip.set', { clipId: clip.id, volume: 1, fadeInUs: 0, fadeOutUs: 0, label: 'Reset volume' })
        }}
      />
      <SliderRow label="Volume" value={dbOf(clip.volume)} min={-60} max={12} reset={0} center={0} format={dbText} onCommit={(x) => call('clip.set', { clipId: clip.id, volume: gainOf(x) })} clip={clip} keyParam="volume" toKey={gainOf} />
      <SliderRow label="Fade in" value={Math.round((clip.fadeInUs ?? 0) / 100_000)} min={0} max={30} reset={0} format={tenths(' s')} onCommit={(x) => call('clip.set', { clipId: clip.id, fadeInUs: x * 100_000 })} clip={clip} keyParam="fadeIn" />
      <SliderRow label="Fade out" value={Math.round((clip.fadeOutUs ?? 0) / 100_000)} min={0} max={30} reset={0} format={tenths(' s')} onCommit={(x) => call('clip.set', { clipId: clip.id, fadeOutUs: x * 100_000 })} clip={clip} keyParam="fadeOut" />
      <Sec title="Enhance voice" on={enh} onToggle={(x) => effects({ eq: { on: x } })} onReset={() => effects({ eq: { on: false, highpassHz: 80, presenceDb: 3 } })} />
      {enh && <SliderRow label="Amount" value={Math.round(((fx.eq?.presenceDb ?? 3) / 6) * 100)} min={0} max={100} reset={50} format={(x) => `${x} %`} onCommit={(x) => effects({ eq: { presenceDb: (x / 100) * 6 } })} />}
      {enh && <Note>Works on the whole track: a rumble cut and a lift around 4 kHz.</Note>}
      <Sec title="Noise reduction" on={nr} onToggle={(x) => effects({ noise: { on: x } })} onReset={() => effects({ noise: { on: false, reductionDb: 12, sensitivity: 6 } })} />
      {nr && <SliderRow label="Amount" value={Math.round(((fx.noise?.reductionDb ?? 12) / 30) * 100)} min={0} max={100} reset={40} format={(x) => `${x} %`} onCommit={(x) => effects({ noise: { reductionDb: (x / 100) * 30 } })} />}
      <Sec title="Loudness" on={loud} onToggle={(x) => call('project.setMaster', { normalize: x })} onReset={() => call('project.setMaster', { normalize: true, targetLufs: -14 })} />
      {loud && <SelectRow label="Target" value={target} options={LOUD.map(([n]) => n)} onChange={(x) => call('project.setMaster', { targetLufs: LOUD.find(([n]) => n === x)?.[1] ?? -14 })} />}
      <Sec title="Pitch" onReset={() => call('clip.set', { clipId: clip.id, pitch: 0 })} />
      <SliderRow label="Semitones" value={clip.pitch ?? 0} min={-12} max={12} reset={0} center={0} format={plus} onCommit={(x) => call('clip.set', { clipId: clip.id, pitch: x })} clip={clip} keyParam="pitch" />
      <Buttons
        items={[
          clip.detached
            ? { label: 'Restore its sound', onClick: () => call('clip.set', { clipId: clip.id, detached: false }) }
            : { label: 'Detach audio', onClick: () => call('clip.extractAudio', { clipIds: [clip.id] }), disabled: !canDetach, title: 'Puts the sound on its own audio track (Ctrl+Shift+S)' },
          { label: 'Open on the Audio page', onClick: () => setState({ page: 'audio' }) },
        ]}
      />
    </>
  )
}

// Speed

const SPEED_CURVES: [string, string][] = [
  ['None', 'M4 22H60'],
  ['Montage', 'M4 30C14 30 16 12 24 12S30 32 38 32 48 12 60 12'],
  ['Hero', 'M4 12C20 12 22 34 32 34S44 12 60 12'],
  ['Bullet', 'M4 10C14 10 18 36 32 36S50 10 60 10'],
  ['Jump cut', 'M4 30H22V12H40V30H60'],
  ['Flash in', 'M4 34C30 34 40 10 60 10'],
  ['Flash out', 'M4 10C24 10 34 34 60 34'],
  ['Custom', 'M4 26C12 14 22 30 32 18S48 30 60 16'],
]
/** The drawn curves on the 280 × 120 graph: y 60 is 1×, each 22 px up doubles the speed. */
const SPEED_GRAPHS: Record<string, string> = {
  None: 'M0 60H280',
  Montage: 'M0 82C44 82 52 33 88 33S118 87 150 87 210 33 280 33',
  Hero: 'M0 33C70 33 80 93 140 93S210 33 280 33',
  Bullet: 'M0 27C44 27 70 98 140 98S220 27 280 27',
  'Jump cut': 'M0 82H96V33H175V82H280',
  'Flash in': 'M0 93C130 93 175 27 280 27',
  'Flash out': 'M0 27C105 27 150 93 280 93',
}
const speedAtY = (y: number) => Math.round(2 ** ((60 - y) / 22) * 100) / 100
const yAtSpeed = (s: number) => 60 - 22 * Math.log2(s)

/** A preset's speed points: the drawn curve sampled at 33 times along the clip. */
function curvePoints(name: string): [number, number][] {
  const d = SPEED_GRAPHS[name]
  if (!d) return []
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  svg.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden'
  document.body.appendChild(svg)
  try {
    const total = path.getTotalLength()
    const out: [number, number][] = []
    let at = 0
    for (let i = 0; i <= 32; i++) {
      const x = (i / 32) * 280
      // The curves run left to right, so walk along until x is reached.
      while (at < total && path.getPointAtLength(at).x < x) at += 0.5
      const p = path.getPointAtLength(Math.min(total, at))
      out.push([Math.round((i / 32) * 1000) / 1000, Math.min(10, Math.max(0.1, speedAtY(p.y)))])
    }
    return out
  } finally {
    svg.remove()
  }
}

/** Custom curve: the editor's 0–1 height is 0.1× (bottom) to 10× (top), 1× in the middle. */
const toCurveY = (s: number) => (Math.log10(Math.max(0.1, Math.min(10, s))) + 1) / 2
const fromCurveY = (y: number) => Math.round(10 ** (y * 2 - 1) * 100) / 100

function SpeedTab({ clip }: { clip: Clip }) {
  const { v, set } = useClipValues(clip)
  const curve = v<Clip['speedCurve']>('speedCurve', null)
  const [mode, setMode] = useUi(`insp.spMode.${clip.id}`, curve ? 'Curve' : 'Normal')
  const speed = v('speed', 1)
  const smooth = v<Clip['smooth']>('smooth', null)
  const keepPitch = v('keepPitch', true)
  const name = curve?.name ?? 'None'
  const graph = name === 'Custom' && curve ? curve.points.map(([t, s], i) => `${i ? 'L' : 'M'}${(t * 280).toFixed(1)} ${yAtSpeed(s).toFixed(1)}`).join(' ') : (SPEED_GRAPHS[name] ?? SPEED_GRAPHS.None)
  const pick = (n: string) => {
    if (n === 'None') return set('speedCurve', null, 'No speed curve')
    if (n === 'Custom') return set('speedCurve', { name: 'Custom', points: curve?.points?.length ? curve.points : curvePoints('Montage') }, 'Speed curve')
    set('speedCurve', { name: n, points: curvePoints(n) }, `Speed curve: ${n}`)
  }
  return (
    <>
      <Pills variant="nav" label="Speed mode" items={['Normal', 'Curve']} value={mode} onPick={setMode} />
      {mode === 'Normal' ? (
        <>
          <SliderRow label="Speed" value={Math.round(speed * 10)} min={1} max={100} reset={10} format={tenths('×')} onCommit={(x) => set('speed', x / 10)} clip={clip} keyParam="speed" toKey={(x) => x / 10} />
          <Row label="Duration">
            <SelectButton small label="Duration" value={`${(clip.durationUs / 1e6).toFixed(2)} s`} title="Follows the speed" />
          </Row>
          {curve && <Note>A speed curve ({curve.name}) is on this clip; Curve shows it.</Note>}
          <Sec title="Keep pitch" on={keepPitch} onToggle={(x) => set('keepPitch', x, x ? 'Keep pitch' : 'Pitch follows speed')} onReset={() => set('keepPitch', true)} />
          <Sec title="Smooth slow motion" on={!!smooth} onToggle={(x) => set('smooth', x ? { quality: 'Best' } : null, x ? 'Smooth slow motion' : 'Plain slow motion')} onReset={() => smooth && set('smooth', null)} />
          {smooth ? (
            <>
              <SegRow label="Quality" items={['Fast', 'Best']} value={smooth.quality} onPick={(x) => set('smooth', { quality: x })} />
              <Note>Made on export (Best takes a while); the player shows plain slow motion.{speed >= 1 ? ' It only changes clips slower than 1×.' : ''}</Note>
            </>
          ) : (
            <Note>Makes new frames between the real ones, so slow parts stay fluid.</Note>
          )}
        </>
      ) : (
        <>
          <Presets items={SPEED_CURVES} value={name} onPick={pick} />
          {name === 'Custom' && curve ? (
            <CurveEditor points={curve.points.map(([t, s]) => [t, toCurveY(s)] as [number, number])} color="#E8C050" onChange={(pts) => set('speedCurve', { name: 'Custom', points: pts.map(([t, y]) => [Math.round(t * 1000) / 1000, fromCurveY(y)] as [number, number]) })} />
          ) : (
            <CurveBox path={graph} color="#E8C050" />
          )}
          <Note>{name === 'Custom' ? 'Click the curve to add a point, drag one off to remove it. Middle is 1×, top 10×, bottom 0.1×.' : 'Pick a curve. The sound is silenced on a curved clip; duration follows the speed.'}</Note>
        </>
      )}
    </>
  )
}

// Animation (clips and text)

const ANIM_IN: [string, string][] = [
  ['None', 'M18 30L46 14'],
  ['Fade', 'M10 32H54 M10 32C30 32 34 12 54 12'],
  ['Zoom in', 'M24 16h16v12H24z M12 8h40v28H12z'],
  ['Zoom out', 'M12 8h40v28H12z M28 19h8v6h-8z'],
  ['Slide up', 'M32 36V10 M24 18l8-8 8 8'],
  ['Slide down', 'M32 8V34 M24 26l8 8 8-8'],
  ['Slide left', 'M54 22H10 M18 14l-8 8 8 8'],
  ['Slide right', 'M10 22H54 M46 14l8 8-8 8'],
  ['Pop', 'M32 6v6 M32 32v6 M14 22h6 M44 22h6 M24 16h16v12H24z'],
  ['Spin', 'M44 22a12 12 0 1 1-3.5-8.5 M41 7v7h7'],
  ['Blur in', 'M14 22h36 M18 16h28 M18 28h28'],
]
const TYPEWRITER: [string, string] = ['Typewriter', 'M12 16h6 M22 16h6 M32 16h6 M12 28h30 M46 24v8']
const ANIM_LOOP: [string, string][] = [
  ['None', 'M18 30L46 14'],
  ['Pulse', 'M6 22h12l4-10 6 20 4-10h26'],
  ['Float', 'M8 28c8-12 16-12 24 0s16 12 24 0'],
  ['Wiggle', 'M8 22l6-8 6 16 6-16 6 16 6-16 6 16 6-8'],
  ['Spin', 'M44 22a12 12 0 1 1-3.5-8.5 M41 7v7h7'],
]

function AnimationTab({ clip }: { clip: Clip }) {
  const { v, set } = useClipValues(clip)
  const [phase, setPhase] = useUi('insp.anPhase', 'In')
  const anim = v<NonNullable<Clip['anim']>>('anim', {})
  const key = phase === 'In' ? 'in' : phase === 'Out' ? 'out' : 'loop'
  const cur = anim[key] as { name: string; durationUs?: number; periodUs?: number } | undefined
  const items = phase === 'Loop' ? ANIM_LOOP : clip.text && phase === 'In' ? [...ANIM_IN, TYPEWRITER] : ANIM_IN
  const dur = Math.round(((key === 'loop' ? cur?.periodUs : cur?.durationUs) ?? (key === 'loop' ? 1_000_000 : 500_000)) / 100_000)
  const put = (name: string, tenthsOfS: number) => {
    const next = { ...anim } as Record<string, unknown>
    if (name === 'None') delete next[key]
    else next[key] = key === 'loop' ? { name, periodUs: tenthsOfS * 100_000 } : { name, durationUs: tenthsOfS * 100_000 }
    set('anim', next, name === 'None' ? `No ${phase.toLowerCase()} animation` : `${phase} animation: ${name}`)
  }
  const all = clipKeys(clip)
  const list = Object.entries(all)
    .flatMap(([param, l]) => l.map((k) => ({ param, k })))
    .sort((a, b) => a.k.atUs - b.k.atUs)
    .map(({ param, k }) => ({ id: `${param}@${k.atUs}`, time: clock(clip.startUs + k.atUs), text: keyText(param, k.value), ease: k.ease ?? 'Linear' }))
  return (
    <>
      <Pills variant="nav" label="Animation phase" items={['In', 'Out', 'Loop']} value={phase} onPick={setPhase} />
      <Presets items={items} value={cur?.name ?? 'None'} onPick={(x) => put(x, dur)} />
      <SliderRow label={phase === 'Loop' ? 'Every' : 'Duration'} value={dur} min={1} max={phase === 'Loop' ? 40 : 30} reset={phase === 'Loop' ? 10 : 5} format={tenths(' s')} onCommit={(x) => cur && put(cur.name, x)} />
      {!cur && <Note>Pick an animation first; its length is set here.</Note>}
      <Sec title="Keyframes on this clip" onReset={() => setKeys(clip, {})} />
      {list.length > 0 && (
        <KeyList
          items={list}
          onEase={(id, ease) => {
            const [param, at] = id.split('@')
            setEase(clip, param, Number(at), ease)
          }}
        />
      )}
      <Note>Click the diamond next to any value to add one. Right-click a diamond to change its easing.</Note>
    </>
  )
}

// Adjust

const BASIC: [string, string][] = [
  ['temperature', 'Temperature'],
  ['tint', 'Tint'],
  ['saturation', 'Saturation'],
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['highlights', 'Highlights'],
  ['shadows', 'Shadows'],
  ['sharpen', 'Sharpen'],
  ['vignette', 'Vignette'],
]
const HUES: [string, string][] = [
  ['Red', '#E05A5A'],
  ['Orange', '#E8955A'],
  ['Yellow', '#E8C050'],
  ['Green', '#74BE59'],
  ['Cyan', '#48BECF'],
  ['Blue', '#66A3FF'],
  ['Purple', '#9996FC'],
  ['Magenta', '#DA8CCC'],
]
const HUE_NOTES: Record<string, string> = {
  Red: 'lips, red fabric and warm light',
  Orange: 'skin tones',
  Yellow: 'sunlight, gold and warm wood',
  Green: 'leaves and grass',
  Cyan: 'water and a pale sky',
  Blue: 'sky and denim',
  Purple: 'flowers and deep shadows',
  Magenta: 'pinks and berry tones',
}
const CHANNELS: [string, 'master' | 'red' | 'green' | 'blue', string][] = [
  ['Luma', 'master', '#EDEDEF'],
  ['Red', 'red', '#F08080'],
  ['Green', 'green', '#74BE59'],
  ['Blue', 'blue', '#66A3FF'],
]
const WHEELS: [string, 'lift' | 'gamma' | 'gain'][] = [
  ['Lift', 'lift'],
  ['Gamma', 'gamma'],
  ['Gain', 'gain'],
]
const IDENTITY: [number, number][] = [
  [0, 0],
  [1, 1],
]
/** The wheel disc's dot reaches 0.84 of its radius; the engine's push is −1…1 with y up (red at the top). */
const DISC = 0.84
type Wheel = { x: number; y: number; lum: number }

/** A wheel's push in red, green and blue (red at the top, green bottom right, blue bottom left). */
function wheelText(name: string, w: Wheel) {
  const r = w.y
  const g = 0.866 * w.x - 0.5 * w.y
  const b = -0.866 * w.x - 0.5 * w.y
  const fmt = (n: number) => `${n < -0.0049 ? '−' : ' '}${Math.abs(n * 0.1).toFixed(2)}`
  if (name === 'Gain') return [r, g, b].map((n) => ` ${(1 + n * 0.1).toFixed(2)}`).join('')
  return [r, g, b].map(fmt).join('')
}

function AdjustTab({ clip }: { clip: Clip }) {
  const { v, set } = useClipValues(clip)
  const snap = useStore((s) => s.snap)
  const [nav, setNav] = useUi('insp.adjNav', 'Basic')
  const [hue, setHue] = useUi('insp.hslRange', 'Orange')
  const [channel, setChannel] = useUi('insp.curveCh', 'Luma')
  const [naming, setNaming] = useState<string | null>(null)
  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])
  useEffect(() => {
    window.studio.files.luts().then(setLuts)
  }, [])
  const hsl = v<NonNullable<Clip['hsl']>>('hsl', {})
  const curves = v<NonNullable<Clip['curves']>>('curves', {})
  const wheels = v<NonNullable<Clip['wheels']>>('wheels', {})
  const lut = v<Clip['lut']>('lut', null)
  const effects = v<NonNullable<Clip['effects']>>('effects', [])
  const ch = CHANNELS.find(([n]) => n === channel) ?? CHANNELS[0]
  // Everything on this tab, for "Apply to all clips".
  const applyAll = () => {
    const keys = [...BASIC.map(([k]) => k), 'hsl', 'curves', 'wheels', 'lut', 'effects']
    const values = Object.fromEntries(keys.map((k) => [k, lookValue<unknown>(clip, k, null)]).filter(([, x]) => x !== null))
    const ids = (snap?.project.tracks ?? []).flatMap((t) => t.clips).filter((c) => c.mediaId && mediaById(snap, c.mediaId)?.kind !== 'audio' && !c.text).map((c) => c.id)
    setLook(ids, values, 'Apply to all clips')
  }
  const lutName = !lut ? 'None' : (luts.find((l) => basename(l.path) === basename(lut.path))?.name ?? basename(lut.path).replace(/\.cube$/i, ''))
  const lutOptions = ['None', ...luts.map((l) => l.name), ...(lut && !luts.some((l) => l.name === lutName) ? [lutName] : []), 'Choose a .cube file…']
  const pickLut = async (name: string) => {
    if (name === 'None') return set('lut', null, 'No LUT')
    if (name === lutName) return
    let src = luts.find((l) => l.name === name)?.path
    if (name === 'Choose a .cube file…') src = (await window.studio.app.chooseFile({ title: 'Choose a LUT', filters: [{ name: 'LUT (.cube)', extensions: ['cube'] }] })) ?? undefined
    if (!src || !snap) return
    const r = await window.studio.files.useLut(src, snap.dir)
    if ('error' in r) return toast(r.error, 'error')
    set('lut', { path: r.out, strength: lut?.strength ?? 100 }, `LUT: ${name === 'Choose a .cube file…' ? basename(src) : name}`)
  }
  return (
    <>
      <Pills variant="nav" label="Adjustment type" items={['Basic', 'HSL', 'Curves', 'Wheels']} value={nav} onPick={setNav} />
      {nav === 'Basic' && BASIC.map(([k, label]) => <SliderRow key={k} label={label} value={v(k, 0)} min={-100} max={100} reset={0} center={0} format={plus} onCommit={(x) => set(k, x)} clip={clip} keyParam={k} />)}
      {nav === 'HSL' && (
        <>
          <HslRanges items={HUES} value={hue} onPick={setHue} />
          <Note>
            {hue} covers {HUE_NOTES[hue]}.
          </Note>
          {(
            [
              ['h', 'Hue'],
              ['s', 'Saturation'],
              ['l', 'Luminance'],
            ] as const
          ).map(([c, label]) => (
            <SliderRow key={c} label={label} value={hsl[hue]?.[c] ?? 0} min={-100} max={100} reset={0} center={0} format={plus} onCommit={(x) => set('hsl', { ...hsl, [hue]: { ...{ h: 0, s: 0, l: 0 }, ...hsl[hue], [c]: x } }, `HSL ${hue}`)} />
          ))}
        </>
      )}
      {nav === 'Curves' && (
        <>
          <SegRow label="Channel" items={CHANNELS.map(([n]) => n)} value={ch[0]} onPick={setChannel} />
          <CurveEditor points={curves[ch[1]] ?? IDENTITY} color={ch[2]} onChange={(pts) => set('curves', { ...curves, [ch[1]]: pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]) }, `Curve: ${ch[0]}`)} />
          <Note>Click the curve to add a point. Drag a point off the graph to remove it.</Note>
        </>
      )}
      {nav === 'Wheels' && (
        <>
          <Wheels
            items={WHEELS.map(([name, k]) => {
              const w: Wheel = { x: 0, y: 0, lum: 0, ...wheels[k] }
              return { name, value: { x: w.x * DISC, y: -w.y * DISC }, vals: wheelText(name, w) }
            })}
            onChange={(name, ui: WheelValue) => {
              const k = WHEELS.find(([n]) => n === name)![1]
              set('wheels', { ...wheels, [k]: { lum: 0, ...wheels[k], x: Math.round((ui.x / DISC) * 100) / 100, y: Math.round((-ui.y / DISC) * 100) / 100 } }, `${name} wheel`)
            }}
          />
          {WHEELS.map(([name, k]) => (
            <SliderRow key={k} label={`${name} level`} value={wheels[k]?.lum ?? 0} min={-100} max={100} reset={0} center={0} format={plus} onCommit={(x) => set('wheels', { ...wheels, [k]: { x: 0, y: 0, ...wheels[k], lum: x } }, `${name} level`)} />
          ))}
        </>
      )}
      <Sec title="Look" onReset={() => lut && set('lut', null, 'No LUT')} />
      <SelectRow label="LUT" value={lutName} options={lutOptions} onChange={pickLut} />
      {lut && <SliderRow label="Strength" value={Math.round(lut.strength)} min={0} max={100} reset={100} format={(x) => `${x} %`} onCommit={(x) => set('lut', { ...lut, strength: x })} />}
      <Sec title="Effects" onReset={() => effects.length && set('effects', [], 'Remove effects')} />
      {effects.length ? (
        effects.map((fx) => (
          <SliderRow
            key={fx.name}
            label={fx.name}
            value={Math.round(fx.amount)}
            min={0}
            max={100}
            reset={60}
            format={(x) => `${x} %`}
            onCommit={(x) => set('effects', effects.map((e) => (e.name === fx.name ? { ...e, amount: x } : e)), `${fx.name} amount`)}
            onRemove={() => set('effects', effects.filter((e) => e.name !== fx.name), `Remove ${fx.name}`)}
          />
        ))
      ) : (
        <Note>Add effects from Library › Effects › Video effects.</Note>
      )}
      {naming != null ? (
        <div className="insp-name-row">
          <input
            className="insp-input"
            autoFocus
            value={naming}
            placeholder="Name the look"
            aria-label="Name of the look"
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && naming.trim()) saveLook(clip, naming).then(() => setNaming(null))
              if (e.key === 'Escape') setNaming(null)
            }}
          />
          <Buttons
            items={[
              { label: 'Save', onClick: () => naming.trim() && saveLook(clip, naming).then(() => setNaming(null)), disabled: !naming.trim() },
              { label: 'Cancel', onClick: () => setNaming(null) },
            ]}
          />
        </div>
      ) : (
        <Buttons
          items={[
            ...(clip.mediaId ? [{ label: 'Apply to all clips', onClick: applyAll, title: 'Gives every clip these adjustments' }] : []),
            { label: 'Save as a look', onClick: () => setNaming(''), title: 'Keeps these adjustments as a look in Library › Effects › Looks' },
          ]}
        />
      )}
    </>
  )
}

// An adjustment layer

function AdjustmentView({ clip }: { clip: Clip }) {
  return (
    <Shell tabs={['adjust']} tab="adjust" name="Adjustment layer" source={`${(clip.durationUs / 1e6).toFixed(1)} s at ${clock(clip.startUs)} · applies to everything below`}>
      <AdjustTab clip={clip} />
    </Shell>
  )
}

// A text clip

const CASES: [TextLook['case'], string][] = [
  ['none', 'Aa'],
  ['upper', 'AA'],
  ['lower', 'aa'],
]
const ALIGNS: [string, string, TextLook['align']][] = [
  ['Left', INSP_ICONS.left, 'left'],
  ['Centre', INSP_ICONS.center, 'center'],
  ['Right', INSP_ICONS.right, 'right'],
]
const alphaOf = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? parseInt(c.slice(7, 9), 16) / 255 : 1)
const withA = (c: string, a: number) => `${c.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0').toUpperCase()}`

function TextView({ clip, track }: { clip: Clip; track: Track }) {
  // Captions open on their lines, text on its words; each remembers the tab you last used.
  const [tab, setTab] = useUi(clip.caption ? 'insp.capTab' : 'insp.textTab', clip.caption ? 'captions' : 'text')
  const project = useStore((s) => s.snap?.project)
  const brand = brandOf(project)
  // The look as the player shows it: the clip's, with the changes still being drawn.
  useSyncExternalStore(subscribeLive, liveVersion)
  const spec = liveLook(clip)
  const { v } = useClipValues(clip)
  const tabs = clip.caption ? ['captions', 'text', 'animation'] : ['text', 'animation', 'tracking']
  const cur = tabs.includes(tab) ? tab : tabs[0]
  // Apply to all: every caption line of this track (on unless you untick it), or every text clip (off unless you tick it).
  const [allCaptions, setAllCaptions] = useUi('insp.capAll', true)
  const [allText, setAllText] = useUi('insp.textAll', false)
  const all = clip.caption ? allCaptions : allText
  const snap = useStore((s) => s.snap)
  const capInfo = clip.caption ? captionTracks(snap).find((t) => t.track.id === track.id) : undefined
  const area = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const timer = useRef(0)
  /** With Apply to all text: every text clip on an unlocked text track, this one first. */
  const textClips = () => [...new Set([clip.id, ...(project?.tracks ?? []).filter((t) => t.role === 'text' && !t.locked).flatMap((t) => t.clips.filter((c) => c.text).map((c) => c.id))])]
  const toAll = !clip.caption && all
  /** A change to the look: this clip, or with Apply to all, every caption line of its track or every text clip (one undo step). */
  const put = (patch: Partial<TextLook>) => {
    if (clip.caption && all) return applyCaptionLook(track.id, patch)
    if (toAll) {
      const gesture = textGestureForAll()
      for (const id of textClips()) void updateText(id, patch, gesture)
      return
    }
    return updateText(clip.id, patch)
  }
  /** A transform change: this clip, or with Apply to all text every text clip, each to this value (as the look does). */
  const place = (values: Record<string, unknown>, label?: string) => setLook(toAll ? textClips() : [clip.id], values, label ?? (toAll ? 'Apply to all text' : undefined))
  // Typing: a text clip follows every key. A caption line shows each key in the player at once
  // and is saved 0.6 s after the last one (or when the field is left); its words are its own,
  // whatever Apply to all says.
  const commit = (text: string) => {
    clearTimeout(timer.current)
    if (text === clip.text?.content) return
    if (clip.caption) editCaptionLine(track.id, clip.id, text)
    else updateText(clip.id, { content: text })
  }
  useEffect(() => {
    setDraft(null)
  }, [clip.id])
  useEffect(() => {
    const onEdit = (e: Event) => {
      if ((e as CustomEvent).detail !== clip.id) return
      setUi(clip.caption ? 'insp.capTab' : 'insp.textTab', 'text')
      requestAnimationFrame(() => {
        area.current?.focus()
        area.current?.select()
      })
    }
    window.addEventListener('studio:edit-text', onEdit)
    return () => window.removeEventListener('studio:edit-text', onEdit)
  }, [clip.id])
  const text = draft ?? spec.content
  const fonts = [...new Set([...brand.fonts, ...projectFontFamilies(), ...FONTS.map((f) => f.family)])]
  const def = fontDef(spec.font)
  const weights = WEIGHTS.filter(([w]) => def.weights.includes(w))
  const colours = [...brand.colors, '#FFFFFF', '#111114']
  const bold = spec.weight >= 600
  return (
    <Shell tabs={tabs} tab={cur} onTab={setTab} name={spec.content.split('\n')[0] || 'Text'} source={`${clip.caption ? 'Caption line' : 'Text'} · ${(clip.durationUs / 1e6).toFixed(1)} s at ${clock(clip.startUs)}${track.hidden ? ' · track hidden' : ''}`}>
      {cur === 'captions' && <CaptionLinesTab track={track} />}
      {cur === 'text' && (
        <>
          {clip.caption ? (
            // Which lines a change to the look goes to: the language's every line, or this one.
            <SegRow label="Change" className="insp-scope" value={all ? 'all' : 'one'} items={[['all', 'All lines'], ['one', 'This line']]} onPick={(v) => setAllCaptions(v === 'all')} />
          ) : (
            <label className="insp-all">
              <input type="checkbox" checked={all} onChange={(e) => setAllText(e.target.checked)} />
              Apply to all text
            </label>
          )}
          <textarea
            ref={area}
            className="insp-text"
            aria-label="Text"
            value={text}
            spellCheck
            onChange={(e) => {
              const t = e.target.value
              setDraft(t)
              clearTimeout(timer.current)
              if (!clip.caption) return updateText(clip.id, { content: t })
              previewTextLook([clip.id], { content: t })
              timer.current = window.setTimeout(() => commit(t), 600)
            }}
            onBlur={() => draft != null && commit(draft)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <Sec first title="Preset style" />
          <PresetStyles look={spec} onPick={put} />
          <Sec title="Text" onReset={() => put({ font: DEFAULT_TEXT.font, weight: DEFAULT_TEXT.weight, size: Math.round(DEFAULT_TEXT.size * ((project?.width ?? 1080) / 1080)), letterSpacing: 0, lineHeight: DEFAULT_TEXT.lineHeight, case: 'none', italic: false, underline: false, align: 'center', color: '#FFFFFF' })} />
          <SelectRow label="Font" value={spec.font} options={fonts.map((f) => [f, fontLabel(f)] as [string, string])} onChange={(f) => put({ font: f, weight: nearestWeight(f, spec.weight) })} />
          <SelectRow label="Weight" value={WEIGHTS.find(([w]) => w === nearestWeight(spec.font, spec.weight))?.[1] ?? 'Regular'} options={weights.map(([, n]) => n)} onChange={(n) => put({ weight: WEIGHTS.find(([, x]) => x === n)![0] })} />
          <SliderRow label="Size" value={Math.round(spec.size)} min={8} max={400} reset={96} format={(x) => `${x} px`} onLive={(x) => put({ size: x })} onCommit={(x) => put({ size: x })} />
          <SliderRow label="Spacing" value={Math.round(spec.letterSpacing)} min={-20} max={80} reset={0} center={0} format={plus} onLive={(x) => put({ letterSpacing: x })} onCommit={(x) => put({ letterSpacing: x })} />
          <SliderRow label="Line height" value={Math.round(spec.lineHeight * 100)} min={70} max={250} reset={115} format={(x) => `${x} %`} onLive={(x) => put({ lineHeight: x / 100 })} onCommit={(x) => put({ lineHeight: x / 100 })} />
          <SegRow label="Case" items={CASES.map(([k, l]) => [k, l] as [string, string])} value={spec.case} onPick={(x) => put({ case: x as TextLook['case'] })} />
          <IconsRow
            label="Style"
            items={[
              ['Bold', INSP_ICONS.bold],
              ['Italic', INSP_ICONS.italic],
              ['Underline', INSP_ICONS.under],
            ]}
            isOn={(n) => (n === 'Bold' ? bold : n === 'Italic' ? !!spec.italic : !!spec.underline)}
            onPick={(n) => (n === 'Bold' ? put({ weight: bold ? nearestWeight(spec.font, 400) : Math.max(...def.weights) }) : n === 'Italic' ? put({ italic: !spec.italic }) : put({ underline: !spec.underline }))}
          />
          <IconsRow label="Align" items={ALIGNS.map(([n, d]) => [n, d] as [string, string])} isOn={(n) => ALIGNS.find(([x]) => x === n)?.[2] === spec.align} onPick={(n) => put({ align: ALIGNS.find(([x]) => x === n)![2] })} />
          <ColourRow label="Colour" value={spec.color} colours={colours} onPick={(c) => put({ color: c })} />
          <Sec title="Outline" on={!!spec.stroke} onToggle={(x) => put({ stroke: x ? { color: '#000000', width: Math.max(2, Math.round(spec.size / 24)) } : null })} onReset={() => put({ stroke: null })} />
          {spec.stroke && (
            <>
              <SliderRow label="Width" value={Math.round(spec.stroke.width)} min={1} max={30} reset={4} format={(x) => `${x} px`} onLive={(x) => put({ stroke: { ...spec.stroke!, width: x } })} onCommit={(x) => put({ stroke: { ...spec.stroke!, width: x } })} />
              <ColourRow label="Colour" value={spec.stroke.color} colours={colours} onPick={(c) => put({ stroke: { ...spec.stroke!, color: c } })} />
            </>
          )}
          <Sec title="Shadow" on={!!spec.shadow} onToggle={(x) => put({ shadow: x ? { color: '#00000099', blur: 12, x: 0, y: 4 } : null })} onReset={() => put({ shadow: { color: '#00000099', blur: 12, x: 0, y: 4 } })} />
          {spec.shadow && (
            <>
              <SliderRow label="Opacity" value={Math.round(alphaOf(spec.shadow.color) * 100)} min={0} max={100} reset={60} format={(x) => `${x} %`} onLive={(x) => put({ shadow: { ...spec.shadow!, color: withA(spec.shadow!.color, x / 100) } })} onCommit={(x) => put({ shadow: { ...spec.shadow!, color: withA(spec.shadow!.color, x / 100) } })} />
              <SliderRow label="Blur" value={Math.round(spec.shadow.blur)} min={0} max={60} reset={12} format={(x) => `${x} px`} onLive={(x) => put({ shadow: { ...spec.shadow!, blur: x } })} onCommit={(x) => put({ shadow: { ...spec.shadow!, blur: x } })} />
              <SliderRow label="Distance" value={Math.round(spec.shadow.y)} min={-30} max={30} reset={4} center={0} format={(x) => `${x} px`} onLive={(x) => put({ shadow: { ...spec.shadow!, y: x } })} onCommit={(x) => put({ shadow: { ...spec.shadow!, y: x } })} />
            </>
          )}
          <Sec title="Background" on={!!spec.background} onToggle={(x) => put({ background: x ? { color: '#000000', opacity: 0.7, radius: 6, padding: Math.round(spec.size * 0.3) } : null })} onReset={() => put({ background: null })} />
          {spec.background && (
            <>
              <ColourRow label="Colour" value={spec.background.color} colours={colours} onPick={(c) => put({ background: { ...spec.background!, color: c } })} />
              <SliderRow label="Opacity" value={Math.round(spec.background.opacity * 100)} min={0} max={100} reset={70} format={(x) => `${x} %`} onLive={(x) => put({ background: { ...spec.background!, opacity: x / 100 } })} onCommit={(x) => put({ background: { ...spec.background!, opacity: x / 100 } })} />
              <SliderRow label="Corners" value={Math.round(spec.background.radius)} min={0} max={120} reset={6} format={(x) => `${x} px`} onLive={(x) => put({ background: { ...spec.background!, radius: x } })} onCommit={(x) => put({ background: { ...spec.background!, radius: x } })} />
              <SliderRow label="Padding" value={Math.round(spec.background.padding)} min={0} max={120} reset={24} format={(x) => `${x} px`} onLive={(x) => put({ background: padTo(spec.background!, x) })} onCommit={(x) => put({ background: padTo(spec.background!, x) })} />
            </>
          )}
          {clip.caption && all ? (
            <>
              <Sec title="Position" onReset={() => restyleCaptions(track.id, { centerY: 0.72 })} />
              <SliderRow label="Height" value={Math.round((capInfo?.centerY ?? 0.72) * 100)} min={5} max={95} reset={72} format={(x) => `${x} % down`} onLive={(x) => previewCaptionLook(track.id, { centerY: x / 100 })} onCommit={(x) => restyleCaptions(track.id, { centerY: x / 100 })} />
            </>
          ) : (
            <>
          <Sec title="Transform" onReset={() => place({ scale: 100, posX: 0, posY: 0, rotation: 0, opacity: 100 }, 'Reset transform')} />
          <SliderRow label="Scale" value={v('scale', 100)} min={0} max={400} reset={100} format={(x) => `${x} %`} onCommit={(x) => place({ scale: x })} clip={clip} keyParam="scale" />
          <PairRow
            label="Position"
            x={v('posX', 0)}
            y={v('posY', 0)}
            clip={clip}
            params={['posX', 'posY']}
            onCommit={(x, y) => {
              place({ posX: x, posY: y })
              keyValue(clip, 'posX', x)
              keyValue(clip, 'posY', y)
            }}
          />
          <SliderRow label="Rotation" value={v('rotation', 0)} min={-180} max={180} reset={0} center={0} format={(x) => `${x}°`} onCommit={(x) => place({ rotation: x })} clip={clip} keyParam="rotation" />
          <SliderRow label="Opacity" value={v('opacity', 100)} min={0} max={100} reset={100} format={(x) => `${x} %`} onCommit={(x) => place({ opacity: x })} clip={clip} keyParam="opacity" />
            </>
          )}
        </>
      )}
      {cur === 'animation' && <AnimationTab clip={clip} />}
      {cur === 'tracking' && <TrackingTab clip={clip} />}
    </Shell>
  )
}

function TrackingTab({ clip }: { clip: Clip }) {
  const [target, setTarget] = useUi(`insp.trk.target.${clip.id}`, '')
  const [mode, setMode] = useUi(`insp.trk.mode.${clip.id}`, 'Position')
  const tasks = useStore((s) => s.tasks)
  useStore((s) => s.snap?.revision)
  const found = hasTrackTargets(clip.id)
  const targets = trackTargets(clip.id)
  const label = (l: string) => `${l[0].toUpperCase()}${l.slice(1)}`
  const options = targets.map((t) => `${label(t.label)} · seen ${t.seen} %`)
  const shown = targets.find((t) => t.label === target)
  const busy = tasks.some((t) => t.state === 'running' && t.label === 'Looking for things to follow')
  const follow = (l: string, m: string) => l && followTarget(clip.id, l, m === 'Position and scale')
  const following = !!clip.keyframes?.posX?.length && !!target
  return (
    <>
      <Note>Pin this clip to something that moves under it, like a face, a hand or the product.</Note>
      <Buttons items={[{ label: found ? 'Look again' : 'Find things to follow', onClick: () => trackObject(clip.id), disabled: busy, title: 'Looks through the main-track picture under this clip for faces and objects' }]} />
      <Sec title="Tracking" onReset={() => {
        setTarget('')
        stopFollowing(clip)
      }} />
      <SegRow
        label="Follow"
        items={['Position', 'Position and scale']}
        value={mode}
        onPick={(x) => {
          setMode(x)
          if (target) follow(target, x)
        }}
      />
      <SelectRow
        label="Target"
        value={shown ? `${label(shown.label)} · seen ${shown.seen} %` : found ? 'Pick one' : 'Not found yet'}
        options={found ? (options.length ? ['Pick one', ...options] : ['Nothing found']) : ['Not found yet']}
        onChange={(x) => {
          const t = targets[options.indexOf(x)]
          if (!t) return
          setTarget(t.label)
          follow(t.label, mode)
        }}
      />
      {following && <Note>Following the {target}: its position {mode === 'Position and scale' ? 'and size are' : 'is'} keyframed. Reset stops it.</Note>}
    </>
  )
}

// Several clips

function MultiView({ count }: { count: number }) {
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const total = selection.reduce((sum, id) => sum + (findClip(snap, id)?.clip.durationUs ?? 0), 0)
  return (
    <Shell tabs={['selection']} tab="selection" name={`${count} clips selected`} source={`${(total / 1e6).toFixed(1)} s in all`}>
      <Buttons
        items={[
          { label: 'Split at playhead', onClick: splitAtPlayhead },
          { label: 'Delete', onClick: deleteSelection },
        ]}
      />
      <Note>Looks and effects from the Library apply to all of them.</Note>
    </Shell>
  )
}

// Nothing selected: the project

function Info({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="insp-info">
      <span>{label}</span>
      <span title={title}>{value}</span>
    </div>
  )
}

function ProjectView() {
  const snap = useStore((s) => s.snap)
  const caps = useStore((s) => s.caps)
  if (!snap)
    return (
      <Shell tabs={['project']} tab="project" name="Project" source="Opening…">
        <Note>Opening the project…</Note>
      </Shell>
    )
  const p = snap.project
  const aspect = FORMATS.find(([, w, h]) => w === p.width && h === p.height)?.[0]
  return (
    <Shell tabs={['project']} tab="project" name={p.name} source={`${aspect ? `${aspect} · ` : ''}${p.width} × ${p.height} · ${p.fps} fps`}>
      <Sec first title="Project" />
      <Info label="Length" value={timecode(snap.durationUs, p.fps)} />
      <Info label="Frame rate" value={`${p.fps} fps`} />
      <Info label="Media" value={`${p.media.length} files`} />
      <Sec title="Format" />
      <SegRow label="Format" items={FORMATS.map(([a]) => a)} value={aspect ?? ''} onPick={(a) => a !== aspect && call('project.setFormat', { aspect: a })} />
      <Note>
        {p.width} × {p.height} at {p.fps} fps
      </Note>
      <Sec title="Saved in" />
      <Info label="Folder" value={basename(snap.dir)} title={snap.dir} />
      <Buttons items={[{ label: 'Show in folder', onClick: () => window.studio.app.showItem(snap.dir) }]} />
      {caps && (
        <>
          <Sec title="Engine" />
          <Info label="FFmpeg" value={ffmpegShort(caps.ffmpeg) ?? 'Not found'} title={caps.ffmpeg ?? undefined} />
          <Info label="Encoder" value={caps.nvenc ? 'NVENC' : 'None (software)'} />
          <Info label="Sound out" value={caps.audioDevice ?? 'None'} />
        </>
      )}
    </Shell>
  )
}

/** A clip whose text is being removed (Vmake): how far along, and the one thing to do with it. */
function BusyClip({ jobId }: { jobId: string }) {
  const job = useVmakeJob(jobId)
  const { fraction, text } = vmakeProgress(job)
  const bar = { fraction: fraction ?? 0, waiting: fraction == null } as Task
  return (
    <>
      <div className="insp-busy insp-busy-clip" role="status">
        <span className="busy-spin" aria-hidden="true" />
        <span>{text}</span>
        <BusyBar task={bar} />
      </div>
      <Note>
        {job ? `${job.stage} · ${taskElapsed({ startedAt: job.startedAt } as Task)}. ` : 'Waiting for Vmake. '}
        The clip can’t be changed until its text is removed; the cleaned copy then takes its place. It carries on if you close the project, and picks up again when Studio starts.
      </Note>
      <Buttons items={[{ label: 'Cancel text removal', onClick: () => cancelTextRemoval(jobId) }]} />
    </>
  )
}

/** A slow job on this clip: what it's doing, how long so far, and a bar. */
function BusyLine({ task }: { task: Task }) {
  return (
    <div className="insp-busy" role="status">
      <span className="busy-spin" aria-hidden="true" />
      <span>
        {task.stage} · {taskElapsed(task)}
        {!task.waiting && task.fraction > 0 ? ` · ${Math.round(task.fraction * 100)} %` : ''}
      </span>
      <BusyBar task={task} />
    </div>
  )
}
