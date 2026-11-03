// Import from CapCut on the page: a CapCut project (read by src/main/capcut.ts) built as a new
// Studio project through the engine's own commands, so it's an ordinary project with an
// ordinary history: the main track's clips at their places with their in points, speed,
// direction, volume, fades, crop, place on the picture, keyframes, filter and transitions; other
// video tracks as overlays; text clips drawn with CapCut's own font and look; CapCut's auto
// captions as a captions track; stickers; filters over everything (adjustment clips with the
// filter's colour table); and every sound at its moment.
//
// CapCut's text sizes are its own: a size sets the font's line height (ascent + descent) to
// size × LINE pixels on a 1080-wide frame, whatever the font (measured on CapCut's renders of
// two fonts: 6.17 and 6.05). Outline, box and shadow sizes are in the same units; the
// constants below were matched against CapCut's renders of the user's projects.

import type { CcClip, CcDraft, CcKeys, CcPlace, CcStyle, CcText } from '../shared/capcut'
import { loadFont, useProjectFonts } from './textFonts'
import { drawText, projectFile, renderTextClip, savePng, withAlpha, type TextLook } from './textRender'
import { getState, mediaById, newProject, subscribeStore as subscribe, type Snapshot } from './store'

const LINE = 6.107
const STROKE = 0.5
const BG_PAD_X = 2.6
const BG_PAD_Y = 2.0
const BG_RADIUS = 1.5
const SHADOW_BLUR = 0.44
const SHADOW_DISTANCE = 0.0165
const LINE_GAP = 3.2
/** CapCut wraps text at this share of the frame's width. */
const WRAP = 0.82

export const listCapcut = () => window.studio.services.capcutList()

const engine = () => window.studio.engine
async function latest(): Promise<Snapshot> {
  return (await engine().call('project.current')) as Snapshot
}
const idOf = (r: unknown): string => (typeof r === 'string' ? r : ((r as { clipId?: string })?.clipId ?? ''))

/** The aspect Studio makes a project with, nearest the CapCut frame. */
function aspectOf(w: number, h: number) {
  const r = w / h
  return ([['9:16', 9 / 16], ['4:5', 4 / 5], ['1:1', 1], ['16:9', 16 / 9]] as const).reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a))[0]
}

/** A picture's place on the frame in Studio's terms (CapCut's x, y are half the frame from its middle, y up). */
const look = (p: CcPlace, w: number, h: number) => ({
  scale: Math.round(p.scale * 10000) / 100,
  posX: Math.round((p.x * w) / 2),
  posY: Math.round((-p.y * h) / 2),
  rotation: Math.round(p.rotation * 100) / 100,
  opacity: Math.round(p.alpha * 1000) / 10,
  flip: p.flipH,
  flipV: p.flipV,
})

const keys = (k?: CcKeys) => (k ? Object.fromEntries(Object.entries(k).map(([n, list]) => [n, list.map((x) => ({ atUs: x.atUs, value: x.value }))])) : undefined)

/** A CapCut style as Studio's text look, sized by the font's own line height. */
export async function textLook(text: string, s: CcStyle, frameW: number): Promise<{ look: TextLook; maxWidth: number }> {
  await loadFont(s.font, s.weight, s.italic, text.slice(0, 40) || 'A')
  // The font's own line height per em, from its file (as CapCut reads it).
  const ratio = s.lineRatio || 1.2
  const em = (s.size * LINE * (frameW / 1080)) / ratio
  const rad = (s.shadow?.angle ?? -45) * (Math.PI / 180)
  const lookOut: TextLook = {
    content: text,
    font: s.font,
    size: Math.round(em * 100) / 100,
    weight: s.weight,
    color: s.alpha < 1 ? withAlpha(s.color, s.alpha) : s.color,
    align: s.align,
    lineHeight: Math.round((ratio + s.lineSpacing * LINE_GAP) * 1000) / 1000,
    letterSpacing: Math.round(s.letterSpacing * em * 100) / 100,
    case: 'none',
    italic: s.italic,
    underline: s.underline,
    stroke: s.stroke ? { color: s.stroke.color, width: Math.max(1, Math.round(s.stroke.width * em * STROKE * 10) / 10) } : null,
    background: s.background
      ? { color: s.background.color, opacity: s.background.alpha, radius: Math.round(s.background.radius * em * BG_RADIUS), padding: Math.round(s.background.width * em * BG_PAD_X), padY: Math.round(s.background.height * em * BG_PAD_Y), block: s.background.style === 1 }
      : null,
    shadow: s.shadow ? { color: withAlpha(s.shadow.color, s.shadow.alpha), blur: Math.round(s.shadow.blur * em * SHADOW_BLUR * 10) / 10, x: Math.round(Math.cos(rad) * s.shadow.distance * em * SHADOW_DISTANCE * 10) / 10, y: Math.round(-Math.sin(rad) * s.shadow.distance * em * SHADOW_DISTANCE * 10) / 10 } : null,
  }
  // CapCut wraps the words at WRAP of the frame; Studio's width includes the box and outline.
  const maxWidth = WRAP * frameW + 2 * (lookOut.background?.padding ?? 0) + (lookOut.stroke?.width ?? 0)
  return { look: lookOut, maxWidth }
}

export type ImportReport = { dir: string; name: string; clips: number; texts: number; captions: number; sounds: number; stickers: number; filters: number; notes: string[]; missing: string[] }

/**
 * Builds a CapCut project as a new Studio project (it's the open one when done). `progress`
 * hears each step.
 */
export async function importCapcut(draft: CcDraft, progress: (stage: string, fraction: number) => void = () => {}): Promise<ImportReport> {
  const e = engine()
  if (!draft.readable) throw new Error('This CapCut project is saved locked (newer CapCut versions encrypt their projects), so it can’t be read.')
  progress('Making the project', 0.02)
  // The frame comes from the project itself; read it into a project made first (its folder takes the resources).
  await newProject(draft.name, '9:16')
  let snap = await latest()
  const dir = snap.dir
  progress('Reading the CapCut project', 0.05)
  const cc = await window.studio.services.capcutRead(draft.dir, dir)
  if ('error' in cc) throw new Error(cc.error)
  const W = cc.width, H = cc.height
  if (aspectOf(W, H) !== '9:16') await e.call('project.setFormat', { aspect: aspectOf(W, H) })
  await useProjectFonts(await window.studio.services.projectFonts(dir))
  await e.call('project.setOptions', { magnet: false })

  // Every file at once; each found again by its path.
  const paths = [...new Set(cc.tracks.flatMap((t) => (t.kind === 'video' || t.kind === 'audio' ? t.clips.map((c) => c.path) : t.kind === 'sticker' ? t.stickers.map((s) => s.path) : [])))]
  progress(`Bringing in ${paths.length} files`, 0.08)
  if (paths.length) await e.call('media.import', { paths })
  snap = await latest()
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  const mediaOf = (p: string) => snap.project.media.find((m) => norm(m.path) === norm(p))?.id

  const report: ImportReport = { dir, name: cc.name, clips: 0, texts: 0, captions: 0, sounds: 0, stickers: 0, filters: 0, notes: [...cc.notes], missing: cc.missing }
  const total = cc.tracks.reduce((n, t) => n + (t.kind === 'video' || t.kind === 'audio' ? t.clips.length : t.kind === 'text' ? t.texts.length : t.kind === 'sticker' ? t.stickers.length : t.filters.length), 0) || 1
  let done = 0
  const step = (what: string) => progress(what, 0.1 + (0.88 * ++done) / total)

  /** The things every clip may have, set once it's on the timeline. */
  const setClip = async (clipId: string, c: CcClip) => {
    await e.call('clip.set', {
      clipId,
      ...(c.kind !== 'audio' && c.place ? { fit: 'fit', ...look(c.place, W, H) } : {}),
      volume: c.volume,
      ...(c.fadeInUs ? { fadeInUs: c.fadeInUs } : {}),
      ...(c.fadeOutUs ? { fadeOutUs: c.fadeOutUs } : {}),
      ...(c.reverse ? { reverse: true } : {}),
      ...(c.crop ? { crop: c.crop } : {}),
      ...(c.polaroid ? polaroidLook(c, W, H) : c.keys ? { keyframes: keys(c.keys) } : {}),
      ...(c.lut ? { lut: { path: c.lut.path, strength: c.lut.strength }, ...(c.lut.grain ? { effects: [{ name: 'Film grain', amount: c.lut.grain }] } : {}) } : {}),
      ...(c.anim ? { anim: c.anim } : {}),
    })
  }
  /** In point and length (after the speed, which sets how much of the source a length plays). */
  const timeIt = async (clipId: string, c: CcClip) => {
    if (Math.abs(c.speed - 1) > 0.001) await e.call('clip.set', { clipId, speed: c.speed })
    await e.call('timeline.trim', { clipId, inUs: c.kind === 'photo' ? 0 : c.inUs, durationUs: c.durationUs, startUs: c.startUs })
  }

  for (const t of cc.tracks) {
    if (t.kind === 'video' && t.main) {
      const ids: string[] = []
      for (const c of [...t.clips].sort((a, b) => a.startUs - b.startUs)) {
        const mediaId = mediaOf(c.path)
        if (!mediaId) continue
        const clipId = idOf(await e.call('timeline.insert', { mediaId, atUs: c.startUs }))
        await timeIt(clipId, c)
        await setClip(clipId, c)
        ids.push(clipId)
        report.clips++
        step(`Clip ${report.clips}`)
      }
      // A transition sits on the clip it goes into.
      const sorted = [...t.clips].sort((a, b) => a.startUs - b.startUs)
      for (const [i, c] of sorted.entries()) if (c.transition && ids[i + 1]) await e.call('transition.set', { clipId: ids[i + 1], name: c.transition.name, durationUs: c.transition.durationUs })
    } else if (t.kind === 'video') {
      let trackId: string | undefined
      const added: { id: string; c: CcClip }[] = []
      for (const c of [...t.clips].sort((a, b) => a.startUs - b.startUs)) {
        const mediaId = mediaOf(c.path)
        if (!mediaId) continue
        const r = (await e.call('overlay.add', { mediaId, atUs: c.startUs, durationUs: c.durationUs, role: 'overlay', ...(trackId ? { trackId } : {}) })) as { clipId: string; trackId: string }
        trackId = r.trackId
        await timeIt(r.clipId, c)
        await setClip(r.clipId, c)
        added.push({ id: r.clipId, c })
        report.clips++
        step(`Clip ${report.clips}`)
      }
      await overlayTransitions(added, W, H)
    } else if (t.kind === 'audio') {
      for (const c of t.clips) {
        const mediaId = mediaOf(c.path)
        if (!mediaId) continue
        const clipId = idOf(await e.call('timeline.insert', { mediaId, atUs: c.startUs }))
        await timeIt(clipId, c)
        await setClip(clipId, c)
        report.sounds++
        step(`Sound ${report.sounds}`)
      }
    } else if (t.kind === 'text' && !t.captions) {
      let trackId: string | undefined
      for (const x of t.texts) {
        const { look: l, maxWidth } = await textLook(x.text, x.style, W)
        const drawn = await renderTextClip(l, 'capcut', { maxWidth })
        const r = (await e.call('text.add', { atUs: x.startUs, durationUs: x.durationUs, text: drawn, ...(trackId ? { trackId } : {}) })) as { clipId: string; trackId: string }
        trackId = r.trackId
        await e.call('clip.set', { clipId: r.clipId, ...look(x.place, W, H), label: x.text.split('\n')[0].slice(0, 40), ...(x.keys ? { keyframes: keys(x.keys) } : {}), ...(x.anim ? { anim: x.anim } : {}) })
        report.texts++
        step(`Text ${report.texts}`)
      }
    } else if (t.kind === 'text') {
      // A project can have several caption rows: the count runs on across them.
      const before = report.captions
      await captionsOf(t.texts, W, H, (n) => {
        report.captions = before + n
        step(`Caption line ${report.captions}`)
      })
    } else if (t.kind === 'sticker') {
      let trackId: string | undefined
      for (const s of t.stickers) {
        const mediaId = mediaOf(s.path)
        if (!mediaId) continue
        const r = (await e.call('overlay.add', { mediaId, atUs: s.startUs, durationUs: s.durationUs, role: 'sticker', ...(trackId ? { trackId } : {}) })) as { clipId: string; trackId: string }
        trackId = r.trackId
        const m = mediaById(await latest(), mediaId)
        await e.call('clip.set', { clipId: r.clipId, fit: 'fit', ...look(s.place, W, H), scale: stickerScale(s.place.scale, m?.width ?? 0, m?.height ?? 0, W, H), label: s.name, ...(s.keys ? { keyframes: keys(s.keys) } : {}), ...(s.anim ? { anim: s.anim } : {}) })
        report.stickers++
        step(`Sticker ${report.stickers}`)
      }
    } else if (t.kind === 'filter') {
      let trackId: string | undefined
      for (const f of t.filters) {
        const r = (await e.call('adjust.add', { atUs: f.startUs, durationUs: f.durationUs, ...(trackId ? { trackId } : {}) })) as { clipId: string; trackId: string }
        trackId = r.trackId
        await e.call('clip.set', { clipId: r.clipId, lut: { path: f.lut, strength: f.strength }, ...(f.grain ? { effects: [{ name: 'Film grain', amount: f.grain }] } : {}), label: f.name })
        report.filters++
        step(`Filter ${report.filters}`)
      }
    }
  }
  // CapCut's main track is magnetic: so is Studio's again when nothing on it has a gap.
  snap = await latest()
  const mainClips = [...(snap.project.tracks.find((t) => t.main)?.clips ?? [])].sort((a, b) => a.startUs - b.startUs)
  const tight = mainClips.every((c, i) => !i || Math.abs(c.startUs - (mainClips[i - 1].startUs + mainClips[i - 1].durationUs)) < 2000) && (mainClips[0]?.startUs ?? 0) < 2000
  if (tight) await e.call('project.setOptions', { magnet: true })
  progress('Done', 1)
  return report
}

/**
 * Transitions between two clips on an overlay track (Studio's transitions are the main track's):
 * a flash through white or black is a full-frame white or black picture fading in to the cut
 * and out after it, on a track just above; a dissolve fades the first out and the next in; a
 * slide or zoom is the next clip's way in. Each over the transition's length.
 */
async function overlayTransitions(added: { id: string; c: CcClip }[], W: number, H: number) {
  const e = engine()
  for (const [i, { id, c }] of added.entries()) {
    const next = added[i + 1]
    if (!c.transition || !next) continue
    const half = Math.max(100_000, Math.round(c.transition.durationUs / 2))
    const cut = next.c.startUs
    const name = c.transition.name
    if (name === 'Fade through white' || name === 'Fade through black') {
      const colour = name === 'Fade through white' ? '#FFFFFF' : '#000000'
      const file = await solidPicture(colour, W, H)
      await e.call('media.import', { paths: [file] })
      const low = (p: string) => p.replace(/\//g, '\\').toLowerCase()
      const found = (await latest()).project.media.find((m) => low(m.path) === low(file))?.id
      if (!found) continue
      const r = (await e.call('overlay.add', { mediaId: found, atUs: Math.max(0, cut - half), durationUs: 2 * half, role: 'overlay' })) as { clipId: string }
      await e.call('clip.set', { clipId: r.clipId, fit: 'fill', anim: { in: { name: 'Fade', durationUs: half }, out: { name: 'Fade', durationUs: half } }, label: c.transition.from })
    } else if (name === 'Dissolve') {
      await e.call('clip.set', { clipId: id, anim: { ...(c.anim ?? {}), out: { name: 'Fade', durationUs: half } } })
      await e.call('clip.set', { clipId: next.id, anim: { ...(next.c.anim ?? {}), in: { name: 'Fade', durationUs: half } } })
    } else {
      const inName = name === 'Zoom in' ? 'Zoom in' : /^Slide|^Wipe/.test(name) ? name.replace('Wipe', 'Slide') : 'Fade'
      await e.call('clip.set', { clipId: next.id, anim: { ...(next.c.anim ?? {}), in: { name: inName, durationUs: half * 2 } } })
    }
  }
}

/** A full-frame picture of one colour, saved once per project. */
const solids = new Map<string, string>()
async function solidPicture(colour: string, W: number, H: number) {
  const key = `${getState().snap?.dir}|${colour}|${W}x${H}`
  if (solids.has(key)) return solids.get(key)!
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, W, H)
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the colour.'))), 'image/png'))
  const file = await savePng(projectFile('stickers', `capcut-${colour.slice(1)}-${W}x${H}.png`), new Uint8Array(await blob.arrayBuffer()))
  solids.set(key, file)
  return file
}

/**
 * CapCut's Polaroid Zoom, as keyframes: the card (the photo already in it, 1024 square, fitted to
 * the frame) flies in small, low and turned 35° further, easing out into its place over
 * `motionUs` (22 % of the animation, measured on CapCut's own render:
 * settled by 0.65 s of 3 s), then the clip's own keyframes (CapCut's shrink away) carry on. The
 * card's 512 template spans the photo's fitted width × POLAROID.
 */
const POLAROID = 1.03
function polaroidLook(c: CcClip, W: number, H: number) {
  const place = look(c.place!, W, H)
  const userKeys = c.keys?.scale
  /** The clip's own scale at t (CapCut holds the first key's value before it, the last after it). */
  const user = (t: number) => {
    if (!userKeys?.length) return place.scale
    if (t <= userKeys[0].atUs) return userKeys[0].value
    for (let i = 1; i < userKeys.length; i++) if (t <= userKeys[i].atUs) return userKeys[i - 1].value + ((userKeys[i].value - userKeys[i - 1].value) * (t - userKeys[i - 1].atUs)) / (userKeys[i].atUs - userKeys[i - 1].atUs)
    return userKeys[userKeys.length - 1].value
  }
  const m = c.polaroid!.motionUs
  const scale: { atUs: number; value: number }[] = [], rotation: typeof scale = [], posX: typeof scale = [], posY: typeof scale = []
  for (let k = 0; k <= 12; k++) {
    const t = Math.round((m * k) / 12)
    const u = k / 12
    // Fitted to CapCut's card at 0.05, 0.2, 0.35, 0.6 and 1.3 s of a 3 s Polaroid Zoom: it grows
    // fast at first, keeps its 33° slant for a fifth, then swings into its own tilt, and rises
    // from a third of the frame below.
    const grow = Math.max(0.05, 1 - (1 - u) ** 2.4)
    const v = Math.min(1, Math.max(0, (u - 0.28) / 0.65))
    const turn = v * v * (3 - 2 * v)
    const rise = 1 - (1 - u) ** 2
    scale.push({ atUs: t, value: Math.round(user(t) * POLAROID * grow * 100) / 100 })
    rotation.push({ atUs: t, value: Math.round((place.rotation + 33 * (1 - turn)) * 100) / 100 })
    posX.push({ atUs: t, value: place.posX })
    posY.push({ atUs: t, value: Math.round(place.posY + 0.36 * H * (1 - rise)) })
  }
  for (const k of userKeys ?? []) if (k.atUs > m) scale.push({ atUs: k.atUs, value: Math.round(k.value * POLAROID * 100) / 100 })
  return { scale: Math.round(user(0) * POLAROID * 100) / 100, keyframes: { scale, rotation, posX, posY } }
}

/**
 * A sticker's size: CapCut draws a sticker at STICKER × its own pixels on a 1080-wide frame
 * (a 280 px GIF at 433 px in CapCut's render of 10-16 V5); Studio fits an overlay to the frame
 * at 100 %.
 */
const STICKER = 1.545
function stickerScale(scale: number, w: number, h: number, W: number, H: number) {
  if (!w || !h) return Math.round(scale * 100)
  const shown = STICKER * (W / 1080) * scale
  const fit = Math.min(W / w, H / h)
  return Math.round((shown / fit) * 10000) / 100
}

/** CapCut's auto captions as one captions track: each line drawn in its own look, where it was. */
async function captionsOf(texts: CcText[], W: number, H: number, each: (n: number) => void) {
  // The track's height: where most lines sit (y up from the middle, in half the frame).
  const ys = texts.map((t) => Math.round(t.place.y * 1000) / 1000)
  const y = ys.sort((a, b) => ys.filter((v) => v === b).length - ys.filter((v) => v === a).length)[0] ?? -0.45
  const centerY = Math.min(0.95, Math.max(0.05, 0.5 - y / 2))
  const lines = []
  let first: TextLook | null = null
  const stamp = Date.now().toString(36)
  for (const [i, t] of texts.entries()) {
    const { look: l, maxWidth } = await textLook(t.text, t.style, W)
    first ??= l
    const d = await drawText({ ...l, preset: `Clean ·  · ${Math.round(centerY * 100)}` }, W, H, { centerY, maxWidth })
    const png = await savePng(projectFile('text', `capcut-cap-${stamp}-${i}.png`), d.png)
    lines.push({ startUs: t.startUs, endUs: t.startUs + t.durationUs, text: t.text, png, boxW: d.boxW, boxH: d.boxH, posX: Math.round((t.place.x * W) / 2), posY: Math.round((centerY - (0.5 - t.place.y / 2)) * -H), scale: Math.round(t.place.scale * 100), rotation: t.place.rotation, words: estimate(t) })
    each(i + 1)
  }
  if (!lines.length || !first) return
  const { content: _c, ...style } = { ...first, preset: `Clean ·  · ${Math.round(centerY * 100)}` }
  await engine().call('captions.set', { lines, style })
}

/** A line's words with its time shared out by length, from the line's start (CapCut keeps no word times in these). */
function estimate(t: CcText) {
  const ws = t.text.split(/\s+/).filter(Boolean)
  const total = ws.reduce((n, w) => n + w.length + 1, 0)
  let at = 0
  return ws.map((w) => {
    const d = (t.durationUs * (w.length + 1)) / total
    const out = { w, s: Math.round(at), e: Math.round(at + d) }
    at += d
    return out
  })
}

/** A project's own fonts are loaded whenever it's opened. */
export function initCapcut() {
  let fontsFor = ''
  subscribe(() => {
    const s = getState()
    const dir = s.link === 'connected' && s.snap ? s.snap.dir : ''
    if (dir === fontsFor) return
    fontsFor = dir
    if (dir) void window.studio.services.projectFonts(dir).then((list) => { if (list.length) void useProjectFonts(list) })
  })
  Object.assign((window as unknown as { __studio: object }).__studio ?? {}, { importCapcut, listCapcut })
}
