// Captions: speech to text with the transcript server (through the main
// process), proofread against the script the sound was read from (a voiceover keeps its
// ElevenLabs script beside it; any other script can be pasted), split into caption lines by
// "Lines" and "Max per line", each line drawn with the caption style to a PNG, then
// `captions.set` (one captions track per language). Another language comes from that
// language's own voiceover and script. Each caption holds "Words per caption" words (or a
// sentence), as the transcript server splits them. Lines can be edited and restyled, are saved as .srt,
// and are part of the picture unless their track is hidden.
//
// A captions track's style, language and height are kept in its lines' `text.preset`:
// "Clean · sv · 72" (style · language code · centre height in % of the frame).

import { roleOf, trackName } from './audioState'
import { CAPTION_STYLES, scaleSpec } from './textPresets'
import { previewTextLook } from './liveText'
import { drawText, projectFile, savePng, type TextLook } from './textRender'
import { basename } from './format'
import { alreadyRunning, call, endTask, getState, holdSelection, mediaById, patchTask, setState, startTask, toast, type Clip, type Snapshot, type Track, type Us } from './store'

/** The languages the transcript server takes (it can also detect them). */
export const LANGS: { code: string; name: string; iso3: string[] }[] = [
  { code: 'sv', name: 'Swedish', iso3: ['swe'] },
  { code: 'en', name: 'English', iso3: ['eng'] },
  { code: 'no', name: 'Norwegian', iso3: ['nor', 'nob', 'nno', 'nb', 'nn'] },
  { code: 'da', name: 'Danish', iso3: ['dan'] },
  { code: 'fi', name: 'Finnish', iso3: ['fin'] },
  { code: 'de', name: 'German', iso3: ['deu', 'ger'] },
  { code: 'nl', name: 'Dutch', iso3: ['nld', 'dut'] },
  { code: 'fr', name: 'French', iso3: ['fra', 'fre'] },
  { code: 'es', name: 'Spanish', iso3: ['spa'] },
  { code: 'it', name: 'Italian', iso3: ['ita'] },
  { code: 'pt', name: 'Portuguese', iso3: ['por'] },
  { code: 'pl', name: 'Polish', iso3: ['pol'] },
  { code: 'ja', name: 'Japanese', iso3: ['jpn'] },
  { code: 'ko', name: 'Korean', iso3: ['kor'] },
]
export const langName = (code: string) => LANGS.find((l) => l.code === code)?.name ?? (code ? code.toUpperCase() : 'Captions')
const langCode = (any: string) => {
  const a = any.toLowerCase()
  return LANGS.find((l) => l.code === a || l.iso3.includes(a))?.code ?? a.slice(0, 3)
}

export const POSITIONS: Record<string, number> = { Bottom: 0.72, Middle: 0.5 }

export interface CaptionInfo {
  track: Track
  style: string
  lang: string
  /** Centre height, 0–1. */
  centerY: number
  lines: Clip[]
}

const parsePreset = (p: string | undefined) => {
  const [style, lang, y] = (p ?? '').split(' · ')
  return { style: CAPTION_STYLES[style] ? style : 'Clean', lang: lang ?? '', centerY: y ? Math.min(0.95, Math.max(0.05, Number(y) / 100)) : POSITIONS.Bottom }
}

/** The project's captions tracks, each with its style, language and lines in time order. */
export function captionTracks(snap: Snapshot | null): CaptionInfo[] {
  return (snap?.project.tracks ?? [])
    .filter((t) => t.role === 'captions')
    .map((track) => {
      const lines = [...track.clips].sort((a, b) => a.startUs - b.startUs)
      return { track, lines, ...parsePreset(lines.find((c) => c.text?.preset)?.text?.preset) }
    })
}

/**
 * A language's captions rows: the track `trackId` is on and every other captions track in the
 * same language (rows added above for lines that didn't fit between two others).
 */
export function captionGroup(snap: Snapshot | null, trackId: string): CaptionInfo[] {
  const all = captionTracks(snap)
  const me = all.find((t) => t.track.id === trackId)
  return me ? all.filter((t) => t.lang === me.lang) : []
}

/** Every line of a language's rows in time order, each with its own track. */
export function groupLines(snap: Snapshot | null, trackId: string): { clip: Clip; trackId: string }[] {
  return captionGroup(snap, trackId)
    .flatMap((t) => t.lines.map((clip) => ({ clip, trackId: t.track.id })))
    .sort((a, b) => a.clip.startUs - b.clip.startUs)
}

/**
 * Where captions can be made from: the voice tracks first (the likely pick), then the clips'
 * own sound, then music; only sound that's heard (a clip turned all the way down, as CapCut's
 * mute comes over, isn't).
 */
export function captionSources(snap: Snapshot | null): [id: string, label: string][] {
  const voices: [string, string][] = []
  const rest: [string, string][] = []
  for (const t of snap?.project.tracks ?? []) {
    if ((t.kind !== 'audio' && !t.main) || !snap || !soundClips(snap, t).length) continue
    if (t.main) rest.unshift([t.id, 'The clips’ own sound'])
    else if (roleOf(t, snap) === 'voice') voices.push([t.id, `Voice · ${trackName(t, snap)}`])
    else rest.push([t.id, `Music · ${trackName(t, snap)}`])
  }
  return [...voices, ...rest]
}

// Words to lines

export interface Word {
  text: string
  start: Us
  end: Us
}
/** One word of a caption line, with its time from the line's start. Kept in the line (`text.words`). */
export interface CapWord {
  w: string
  s: Us
  e: Us
}
export interface Cue extends LinePlace {
  startUs: Us
  endUs: Us
  text: string
  words?: CapWord[]
}

/** Where a line sits on the picture when it's been moved, scaled or turned there. */
export interface LinePlace {
  posX?: number
  posY?: number
  scale?: number
  rotation?: number
}
/** A line's place, to keep when its track's lines are set again (and to pass on to the lines made from it). */
const placeOf = (c: Clip | undefined): LinePlace => (c ? { posX: c.posX ?? 0, posY: c.posY ?? 0, scale: c.scale ?? 100, rotation: c.rotation ?? 0 } : {})

/** A pause this long closes a caption early (the transcript server's PAUSE). */
const PAUSE_US = 600_000
/** "By sentence" still closes a caption after this many words, for a sentence that never ends. */
const SENTENCE_MAX_WORDS = 16

/** Words per caption as the setting says it: 0 is a sentence each. */
export const wordsLabel = (n: number) => (n <= 0 ? 'By sentence' : `${n} word${n === 1 ? '' : 's'}`)

/**
 * Groups words into captions as the transcript server does: `perCaption` words each (0: a
 * sentence each), and a sentence end or a 0.6 s pause always closes one. Long captions wrap
 * when they're drawn.
 */
export function cuesOf(words: Word[], perCaption: number): Cue[] {
  const limit = perCaption > 0 ? perCaption : SENTENCE_MAX_WORDS
  const groups: Word[][] = []
  let cur: Word[] = []
  for (const w of words) {
    const text = w.text.trim()
    if (!text) continue
    if (cur.length && w.start - cur[cur.length - 1].end > PAUSE_US) {
      groups.push(cur)
      cur = []
    }
    cur.push({ ...w, text })
    if (cur.length >= limit || /[.!?…]["”»]?$/.test(text)) {
      groups.push(cur)
      cur = []
    }
  }
  if (cur.length) groups.push(cur)
  // Each caption stays up at least 0.6 s where there's room, and runs on to the next across short gaps.
  return groups.map((g, i) => {
    const start = g[0].start
    const next = groups[i + 1]?.[0].start ?? Infinity
    let end = Math.max(g[g.length - 1].end, start + 600_000)
    if (next - end < 400_000) end = next
    const words = g.map((w) => ({ w: w.text, s: Math.round(w.start - start), e: Math.round(w.end - start) }))
    return { startUs: Math.round(start), endUs: Math.round(Math.min(end, next)), text: g.map((w) => w.text).join(' '), words }
  })
}

/** Words heard this session, per captions track: for lines made before they kept their own. */
const heard = new Map<string, Word[]>()

/** A line's words with its time shared out by their length (a space counts as a letter). */
function estimateWords(text: string, durationUs: Us): CapWord[] {
  const words = text.split(/\s+/).filter(Boolean)
  const total = words.reduce((n, w) => n + w.length + 1, 0)
  let at = 0
  return words.map((w) => {
    const s = Math.round((at * durationUs) / total)
    at += w.length + 1
    return { w, s, e: Math.round(((at - 1) * durationUs) / total) }
  })
}

/** Whether a line kept its words' times (lines made before Studio kept them didn't). */
const keptTimes = (c: Clip) => Array.isArray(c.text?.words) && c.text!.words!.length > 0

/** A line's words on the timeline: the times it keeps, else shared out over the line by length. */
function wordsOfLine(c: Clip): Word[] {
  const ws = keptTimes(c) ? c.text!.words! : estimateWords(c.text?.content ?? '', c.durationUs)
  return ws.map((x) => ({ text: x.w, start: c.startUs + x.s, end: c.startUs + x.e }))
}

/**
 * Every word of a captions track in time order: the times its lines keep, else this session's
 * as heard, else shared out over each line by length (good enough to split by, and kept after).
 */
export function wordsOfTrack(info: CaptionInfo): Word[] | null {
  if (!info.lines.every(keptTimes) && heard.has(info.track.id)) return heard.get(info.track.id)!
  const all = info.lines.flatMap(wordsOfLine)
  return all.length ? all : null
}
export const canResplit = (trackId: string) => {
  const info = captionTracks(getState().snap).find((t) => t.track.id === trackId)
  return !!info && !!wordsOfTrack(info)
}
/** True when some of a track's lines have no words' times of their own (they're estimated). */
export const estimatedTimes = (trackId: string) => !!captionTracks(getState().snap).find((t) => t.track.id === trackId)?.lines.some((c) => !keptTimes(c))

/** The word being said at `t` in a line, by its index (-1 between words or without times). */
export function wordAt(c: Clip, t: Us): number {
  const ws = c.text?.words
  if (!Array.isArray(ws)) return -1
  const rel = t - c.startUs
  let at = -1
  for (let i = 0; i < ws.length && ws[i].s <= rel; i++) at = i
  return at
}

/** What the proofread did to a captions track's words this session: its line, and each swap. */
export interface Proofread {
  summary: string
  changes: { heard: string; script: string; atUs: Us }[]
}
const proofreads = new Map<string, Proofread>()
const proofListeners = new Set<() => void>()
export const proofreadOf = (trackId: string) => proofreads.get(trackId)
export function subscribeProofreads(l: () => void) {
  proofListeners.add(l)
  return () => {
    proofListeners.delete(l)
  }
}

/** The clips of a track that captions are made from: those with sound that's heard, in time order. */
/** A clip's sound at −40 dB or below isn't heard (CapCut's mute comes over as −60 dB). */
const HEARD = 0.01
function soundClips(snap: Snapshot, src: Track): Clip[] {
  return [...src.clips].sort((a, b) => a.startUs - b.startUs).filter((c) => mediaById(snap, c.mediaId)?.hasAudio && !(src.main && c.detached) && c.volume > HEARD)
}

/** The script a track's sound was read from: its voiceovers' ElevenLabs scripts, joined; "" if none. */
export async function scriptOfTrack(trackId: string): Promise<string> {
  const snap = getState().snap
  const src = snap?.project.tracks.find((t) => t.id === trackId)
  if (!snap || !src) return ''
  const paths = soundClips(snap, src).map((c) => mediaById(snap, c.mediaId)!.path)
  return paths.length ? window.studio.services.scriptsFor(paths) : ''
}

// Drawing and setting lines

/**
 * The engine's project as it is now. A change made a moment ago may not have reached the
 * store's copy yet, and lines drawn from an old copy would undo it.
 */
async function latest(): Promise<Snapshot | null> {
  try {
    return (await window.studio.engine.call('project.current')) as Snapshot
  } catch {
    return getState().snap
  }
}

const presetOf = (style: string, lang: string, centerY: number) => `${style} · ${lang} · ${Math.round(centerY * 100)}`

function styleFor(style: string, lang: string, centerY: number): TextLook {
  const p = getState().snap!.project
  const s = scaleSpec(CAPTION_STYLES[style] ?? CAPTION_STYLES.Clean, p.width)
  return { ...s, preset: presetOf(style, lang, centerY) }
}

/** A captions track's look as its lines have it now: its style and every change made to it since. */
function lookOf(info: CaptionInfo, centerY = info.centerY): TextLook {
  const t = info.lines[0]?.text
  if (!t) return styleFor(info.style, info.lang, centerY)
  const { content: _c, png: _p, boxW: _w, boxH: _h, words: _ws, ...look } = t
  return { ...(look as TextLook), content: '', preset: presetOf(info.style, info.lang, centerY) }
}

type Drawable = Cue & { png?: string; boxW?: number; boxH?: number }

/** A captions track's lines as they are, ready to draw again (`keep`: keep their drawings). */
const cuesFrom = (info: CaptionInfo, keep: boolean): Drawable[] =>
  info.lines.map((c) => ({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text: c.text?.content ?? '', words: c.text?.words, ...placeOf(c), ...(keep ? { png: c.text?.png ?? undefined, boxW: c.text?.boxW, boxH: c.text?.boxH } : {}) }))

/**
 * After the lines are set again (every line gets a new id), the line you were on stays the
 * selected one: `index` in the new order, if a line of this track was selected.
 */
function keepSelected(info: CaptionInfo, r: { clipIds: string[] } | undefined, index: number) {
  if (!r?.clipIds[index]) return
  const sel = getState().selection
  if (sel.length === 1 && info.lines.some((c) => c.id === sel[0])) setState({ selection: [r.clipIds[index]] })
}

// Drawing lines. A line's drawing is a full-frame PNG (~20 ms each, most of it the PNG), so:
// drawings made this session are kept by everything that decides them (a style tried again,
// or a line typed back to what it was, costs nothing); three are drawn at a time; and a change
// to every line (a style, a look, words per caption) is set at once and its drawings follow,
// nearest the playhead first (`streamLines`), so nothing waits for all of them.

/** Drawings made this session, by project, look, words and place. */
const drawings = new Map<string, { png: string; boxW: number; boxH: number }>()
const drawKey = (look: TextLook, text: string, centerY: number) => {
  const s = getState().snap
  return JSON.stringify([s?.dir, s?.project.width, s?.project.height, centerY, text, look])
}
let drawCount = 0

/** One line's drawing, from the ones kept when it's been drawn before. */
async function drawLine(look: TextLook, text: string, centerY: number) {
  const key = drawKey(look, text, centerY)
  const kept = drawings.get(key)
  if (kept) return kept
  const p = getState().snap!.project
  const d = await drawText({ ...look, content: text }, p.width, p.height, { centerY, maxWidth: p.width * 0.94 })
  const png = await savePng(projectFile('text', `cap-${Date.now().toString(36)}${(++drawCount).toString(36)}.png`), d.png)
  const made = { png, boxW: d.boxW, boxH: d.boxH }
  drawings.set(key, made)
  return made
}

/** Runs `f` over `items`, `n` at a time. */
async function inTurn<T>(n: number, items: T[], f: (x: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await f(items[i], i)
    }
  }))
}

async function drawLines(cues: Drawable[], style: TextLook, centerY: number, task?: string, only?: number) {
  const out: Drawable[] = new Array(cues.length)
  let done = 0
  await inTurn(3, cues, async (c, i) => {
    if (only != null && i !== only && c.png) {
      out[i] = c
      return
    }
    const d = await drawLine(style, c.text, centerY)
    out[i] = { startUs: c.startUs, endUs: c.endUs, text: c.text, ...d, words: c.words, posX: c.posX, posY: c.posY, scale: c.scale, rotation: c.rotation }
    if (task && ++done % 4 === 0) patchTask(task, { stage: `Drawing line ${done} of ${cues.length}`, fraction: 0.7 + (0.25 * done) / cues.length })
  })
  return out
}

/** The latest change to every line of a row; an older one still drawing stops. */
const streams = new Map<string, number>()

/**
 * A change to every line of a row, set at once with `spec` (each line keeps the drawing it has,
 * or `keep: false` none, until its new one comes; ones drawn before come at once), then drawn
 * nearest the playhead first and sent as they're ready (`captions.draw`), all one undo step.
 */
async function streamLines(info: CaptionInfo, cues: Drawable[], spec: TextLook, centerY: number, keep: boolean) {
  const row = info.track.id
  const run = (streams.get(row) ?? 0) + 1
  streams.set(row, run)
  const gesture = `restyle ${row} ${run} ${Date.now().toString(36)}`
  const ready = cues.map((c) => drawings.get(drawKey(spec, c.text, centerY)))
  const lines = cues.map((c, i) => ({ ...c, ...(ready[i] ?? (keep ? {} : { png: undefined, boxW: undefined, boxH: undefined })) }))
  const sel = getState().selection[0]
  const at = Math.max(0, info.lines.findIndex((c) => c.id === sel))
  holdSelection(3000)
  const r = await setLines(row, lines, spec, undefined, gesture)
  if (!r) return
  keepSelected(info, r, Math.min(at, lines.length - 1))
  const pos = getState().positionUs
  const todo = cues.map((_, i) => i).filter((i) => !ready[i]).sort((a, b) => Math.abs(cues[a].startUs - pos) - Math.abs(cues[b].startUs - pos))
  if (!todo.length) return r
  const task = todo.length > 24 ? startTask('Drawing the captions', 'restyle', row) : undefined
  let batch: { clipId: string; png: string; boxW: number; boxH: number }[] = []
  let sent = performance.now()
  let done = 0
  const send = async () => {
    if (!batch.length || streams.get(row) !== run) return
    const b = batch
    batch = []
    sent = performance.now()
    await call('captions.draw', { drawings: b, gesture })
  }
  try {
    await inTurn(3, todo, async (i) => {
      if (streams.get(row) !== run) return
      const d = await drawLine(spec, cues[i].text, centerY)
      batch.push({ clipId: r.clipIds[i], ...d })
      done++
      // Sent in a few big batches: each one is a new snapshot of the whole project.
      if (batch.length >= 60 || performance.now() - sent > 700) {
        if (task) patchTask(task, { stage: `Drawing line ${done} of ${todo.length}`, fraction: done / todo.length })
        await send()
      }
    })
    await send()
    if (task) endTask(task)
  } catch (e) {
    if (task) endTask(task, (e as Error).message)
    else toast(`Couldn’t draw the captions: ${(e as Error).message}`, 'error')
  }
  return r
}

async function setLines(trackId: string | undefined, lines: ({ startUs: Us; endUs: Us; text: string; png?: string; words?: CapWord[] } & LinePlace)[], style: TextLook, above?: string, gesture?: string) {
  const { content: _c, png: _p, boxW: _w, boxH: _h, words: _ws, ...shared } = style as TextLook & { words?: unknown }
  return call<{ trackId: string; clipIds: string[] }>('captions.set', { ...(trackId ? { trackId } : {}), ...(above ? { aboveTrackId: above } : {}), lines, style: shared, ...(gesture ? { gesture } : {}) })
}

/**
 * Words per caption: the track's lines are split again from their words' times and set at once
 * (the timeline, the list and the live picture show them straight away), then drawn, nearest
 * the playhead first, and their drawings sent as they're ready (`streamLines`), all one undo
 * step. A newer change while they draw starts over.
 */
export async function resplitCaptions(trackId: string, perCaption: number) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  const words = info && wordsOfTrack(info)
  if (!info || !words?.length) return
  const cues = cuesOf(words, perCaption).map((c) => ({ ...c, ...placeOf(info.lines[0]) }))
  // The line you were on: the new one that starts where it was, or holds that moment.
  const sel = info.lines.find((c) => c.id === getState().selection[0])
  const at = sel ? Math.max(0, cues.findIndex((c) => c.endUs > sel.startUs)) : -1
  const r = await streamLines(info, cues, lookOf(info), info.centerY, false)
  if (r && at >= 0 && r.clipIds[at]) setState({ selection: [r.clipIds[at]] })
}

const isErr = (r: unknown): r is { error: string } => !!r && typeof r === 'object' && 'error' in r

/**
 * Makes captions from a sound track: its clips' sound goes to the transcript server as one
 * recording, with `script` (else the voiceovers' own scripts) to proofread against; the words
 * come back on the timeline, are split into lines, drawn and set.
 */
export async function generateCaptions(o: { sourceTrackId: string; language: string; perCaption: number; style: string; centerY: number; script?: string }) {
  const snap = getState().snap
  const src = snap?.project.tracks.find((t) => t.id === o.sourceTrackId)
  if (!snap || !src) return toast('Pick the sound to make captions from.', 'error')
  const clips = soundClips(snap, src)
  if (!clips.length) return toast('That track has no sound to transcribe.', 'error')
  if (alreadyRunning('captions', o.sourceTrackId)) return
  const task = startTask(`Making captions from ${trackName(src, snap)}`, 'captions', o.sourceTrackId)
  try {
    const script = o.script?.trim() || (await scriptOfTrack(o.sourceTrackId))
    const parts = clips.map((c) => ({ path: mediaById(snap, c.mediaId)!.path, startUs: c.inUs, durationUs: Math.round(c.durationUs * (c.speed ?? 1)) }))
    const r = await window.studio.services.transcribeParts({ taskId: task, parts, language: o.language || undefined, script: script || undefined })
    if (isErr(r)) throw new Error(r.error)
    // Seconds into a clip's own sound, to the timeline (a faster clip's sound passes sooner).
    const onTimeline = (part: number, s: number) => clips[part].startUs + Math.round((s * 1e6) / (clips[part].speed ?? 1))
    const words: Word[] = []
    for (const w of r.words) {
      const c = clips[w.part]
      if (!c) continue
      const start = onTimeline(w.part, w.start)
      if (start >= c.startUs + c.durationUs) continue
      words.push({ text: w.word, start, end: Math.min(onTimeline(w.part, w.end), c.startUs + c.durationUs) })
    }
    if (!words.length) throw new Error('No speech was heard in that sound.')
    const lang = o.language || langCode(r.language) || ''
    const cues = cuesOf(words, o.perCaption)
    patchTask(task, { stage: 'Drawing the lines', fraction: 0.7 })
    const trackId = await placeCaptions(cues, { lang, style: o.style, centerY: o.centerY }, task)
    heard.set(trackId, words)
    // The script check can fail on its own (the server's AI out of credits): the words stay as heard.
    const unchecked = script && r.unchecked ? `Not checked against the script: ${r.unchecked}. The words are as heard.` : ''
    if (script) proofreads.set(trackId, { summary: unchecked || (r.summary ?? 'Checked against the script.'), changes: r.changes.filter((c) => clips[c.part]).map((c) => ({ heard: c.heard, script: c.script, atUs: onTimeline(c.part, c.at) })) })
    else proofreads.delete(trackId)
    for (const l of proofListeners) l()
    endTask(task)
    toast(`${cues.length} caption lines in ${langName(lang)}.${unchecked ? ` ${unchecked}` : script && r.summary ? ` ${r.summary.replace(/\.$/, '')}.` : ''}`)
    return trackId
  } catch (e) {
    const msg = (e as Error).message
    // Nothing said in it: name another sound that may have speech.
    const other = /no speech/i.test(msg) ? captionSources(getState().snap).find(([id]) => id !== o.sourceTrackId) : undefined
    endTask(task, `Captions failed: ${msg}${other ? ` Try Made from › ${other[1]}.` : ''}`)
  }
}

/**
 * Captions for every voiceover, each in its own language from its own ElevenLabs script: the
 * way to have the ad's captions in Swedish, Norwegian and Danish. One at a time, since the server
 * takes two jobs at once from an address. Returns the captions tracks made.
 */
export async function captionsForEveryVoiceover(o: { perCaption: number; style: string; centerY: number }): Promise<string[]> {
  const snap = getState().snap
  const voices = (snap?.project.tracks ?? []).filter((t) => t.kind === 'audio' && roleOf(t, snap) === 'voice' && soundClips(snap!, t).length)
  const made: string[] = []
  for (const t of voices) {
    if (!(await scriptOfTrack(t.id))) continue
    const id = await generateCaptions({ ...o, sourceTrackId: t.id, language: '' })
    if (id) made.push(id)
  }
  if (!made.length) toast('No voiceover here has its script. Voiceovers made in the Audio tab keep theirs; for others, paste the script and make captions from that track.', 'error')
  return made
}

/**
 * Draws caption lines and sets them on the captions track for `lang` (made if there's none;
 * a language that already has a track gets its lines replaced). Returns the track's id.
 */
export async function placeCaptions(cues: Cue[], o: { lang: string; style: string; centerY: number }, task?: string): Promise<string> {
  // Made again for a language that has a track: its lines are replaced, its look and height kept.
  const same = captionTracks(await latest()).find((t) => t.lang === o.lang)
  const centerY = same?.lines.length ? same.centerY : o.centerY
  const style = same?.lines.length ? lookOf(same) : styleFor(o.style, o.lang, o.centerY)
  // Made again, the lines stay where the old ones were moved to.
  const lines = await drawLines(same?.lines.length ? cues.map((c) => ({ ...c, ...placeOf(same.lines[0]) })) : cues, style, centerY, task)
  const r = await setLines(same?.track.id, lines, style)
  if (!r) throw new Error('The engine didn’t take the captions.')
  return r.trackId
}

/**
 * A captions row's lines replaced by `cues` in another language (Translations): the row keeps
 * its look, height and the place its lines were moved to; its language becomes `lang`.
 */
export async function setCaptionLines(trackId: string, cues: Cue[], lang: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  if (!info) throw new Error('A captions track is gone.')
  const look = { ...lookOf(info), preset: presetOf(info.style, lang, info.centerY) }
  const lines = await drawLines(cues.map((c) => (c.posX == null ? { ...c, ...placeOf(info.lines[0]) } : c)), look, info.centerY)
  return setLines(trackId, lines, look)
}

/**
 * Stretches of a language's captions said again (a dub's sentence rerolled): on every row of
 * the language, the lines whose middle is inside a stretch give way to its new words (times on
 * the timeline), split as that row splits, in its look and where its first line sat. A stretch
 * with no line of the language in it is left alone. `gesture` makes it one undo step with the
 * sound swapped before it.
 */
export async function recaption(lang: string, spans: { fromUs: Us; toUs: Us; words: Word[] }[], gesture?: string) {
  const rows = captionTracks(await latest()).filter((t) => t.lang === lang)
  const within = (c: Clip, s: (typeof spans)[number]) => s.words.length > 0 && c.startUs + c.durationUs / 2 >= s.fromUs && c.startUs + c.durationUs / 2 < s.toUs
  const inside = (c: Clip) => spans.some((s) => within(c, s))
  const added = new Map<string, Drawable[]>()
  for (const s of spans) {
    const first = rows.flatMap((r) => r.lines.filter((c) => within(c, s)).map((c) => ({ c, r }))).sort((a, b) => a.c.startUs - b.c.startUs)[0]
    if (!first) continue
    const id = first.r.track.id
    added.set(id, [...(added.get(id) ?? []), ...cuesOf(s.words, wordsPerCaptionOf(first.r)).map((c) => ({ ...c, ...placeOf(first.c) }))])
  }
  for (const r of rows) {
    const add = added.get(r.track.id) ?? []
    if (!add.length && !r.lines.some(inside)) continue
    const cues = [...cuesFrom(r, true).filter((_, i) => !inside(r.lines[i])), ...add].sort((a, b) => a.startUs - b.startUs)
    // A new line never runs into the one after it.
    for (let i = 0; i < cues.length - 1; i++) cues[i].endUs = Math.min(cues[i].endUs, cues[i + 1].startUs)
    const look = lookOf(r)
    await setLines(r.track.id, await drawLines(cues, look, r.centerY, undefined, -1), look, undefined, gesture)
  }
}

/** Words per caption the way a row was split: the usual number of words in its lines (0 for whole sentences). */
export function wordsPerCaptionOf(info: CaptionInfo) {
  const counts = info.lines.map((c) => (c.text?.content ?? '').split(/\s+/).filter(Boolean).length).sort((a, b) => a - b)
  const n = counts[Math.floor(counts.length / 2)] ?? 0
  return n >= 8 ? 0 : n
}

/**
 * Draws a captions track's lines again: with one of the caption styles (`style`), at another
 * height, or split again into `perCaption` words (from the times the lines keep). Any other
 * change made to the look stays, unless a style is picked.
 */
export async function restyleCaptions(trackId: string, o: { style?: string; centerY?: number; perCaption?: number }) {
  // A style or a height is the language's, every row of it; words per caption is this row's.
  const done = o.perCaption == null ? previewCaptionLook(trackId, o) : () => {}
  try {
    const rows = o.perCaption != null ? captionTracks(await latest()).filter((t) => t.track.id === trackId) : captionGroup(await latest(), trackId)
    for (const info of rows) {
      if (!info.lines.length) continue
      const centerY = o.centerY ?? info.centerY
      const words = o.perCaption != null ? wordsOfTrack(info) : null
      const cues: Drawable[] = words ? cuesOf(words, o.perCaption!).map((c) => ({ ...c, ...placeOf(info.lines[0]) })) : cuesFrom(info, true)
      const spec = o.style ? styleFor(o.style, info.lang, centerY) : lookOf(info, centerY)
      // Set at once; each line keeps its drawing (the same words) until its new one comes.
      await streamLines(info, cues, spec, centerY, !words)
    }
  } finally {
    done()
  }
}

/**
 * Shows a language's captions in the player with another style or height straight away (the
 * Height slider while it's dragged); the drawings come with restyleCaptions.
 */
export function previewCaptionLook(trackId: string, o: { style?: string; centerY?: number }): () => void {
  const dones = captionGroup(getState().snap, trackId).map((info) => {
    const centerY = o.centerY ?? info.centerY
    const { content: _c, ...look } = o.style ? styleFor(o.style, info.lang, centerY) : { content: '', preset: presetOf(info.style, info.lang, centerY) }
    return previewTextLook(
      info.lines.map((c) => c.id),
      look,
    )
  })
  return () => dones.forEach((d) => d())
}

/** Look changes waiting to be set, per language: a slider dragged sets them once it rests. */
const lookQueue = new Map<string, { patch: Partial<TextLook>; timer: number; dones: (() => void)[]; waiting: (() => void)[] }>()

/**
 * A change to how every line of a language's captions looks (font, size, colour…), on every
 * row. The player shows it on the next frame; changes made within 250 ms of each other are set
 * together, each line keeping its old drawing until its new one comes (`streamLines`).
 */
export function applyCaptionLook(trackId: string, patch: Partial<TextLook>): Promise<void> {
  const key = captionGroup(getState().snap, trackId)[0]?.lang ?? trackId
  const q = lookQueue.get(key) ?? { patch: {}, timer: 0, dones: [], waiting: [] }
  q.patch = { ...q.patch, ...patch }
  lookQueue.set(key, q)
  q.dones.push(previewTextLook(groupLines(getState().snap, trackId).map((l) => l.clip.id), patch))
  window.clearTimeout(q.timer)
  return new Promise((resolve) => {
    q.waiting.push(resolve)
    q.timer = window.setTimeout(async () => {
      lookQueue.delete(key)
      try {
        for (const info of captionGroup(await latest(), trackId)) {
          if (!info.lines.length) continue
          const look = lookOf(info)
          await streamLines(info, cuesFrom(info, true), { ...look, ...q.patch, preset: look.preset }, info.centerY, true)
        }
      } catch (e) {
        toast(`Couldn’t change the captions: ${(e as Error).message}`, 'error')
      } finally {
        for (const d of q.dones) d()
        for (const w of q.waiting) w()
      }
    }, 250)
  })
}

/** Draws the lines that need it and sets the track's lines, the selected line staying selected. */
async function redraw(info: CaptionInfo, cues: Drawable[], spec: TextLook, centerY: number, only?: number, select?: number) {
  const sel = getState().selection[0]
  const at = select ?? Math.max(0, info.lines.findIndex((c) => c.id === sel))
  const task = cues.filter((c) => !c.png).length > 12 ? startTask('Redrawing the captions', 'restyle', info.track.id) : undefined
  try {
    const lines = await drawLines(cues, spec, centerY, task, only)
    holdSelection(3000)
    const r = await setLines(info.track.id, lines, spec)
    keepSelected(info, r, Math.min(at, lines.length - 1))
    if (task) endTask(task)
    return r
  } catch (e) {
    if (task) endTask(task, (e as Error).message)
    else toast(`Couldn’t change the captions: ${(e as Error).message}`, 'error')
  }
}

/**
 * One line's new words: its PNG is drawn again and the track's lines are set again (its times
 * stay). No words at all takes the line out (the one before it is then the selected one).
 */
export async function editCaptionLine(trackId: string, clipId: string, text: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  if (!info) return
  const i = info.lines.findIndex((c) => c.id === clipId)
  if (i < 0 || (text.trim() && info.lines[i].text?.content === text)) return
  const cues = cuesFrom(info, true)
  if (!text.trim()) {
    cues.splice(i, 1)
    return redraw(info, cues, lookOf(info), info.centerY, -1, Math.max(0, i - 1))
  }
  cues[i] = { ...cues[i], text, png: undefined }
  return redraw(info, cues, lookOf(info), info.centerY, -1, i)
}

/** `find` (any case) as a pattern that matches it anywhere. */
export const findPattern = (find: string) => new RegExp(find.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')

/**
 * Replace all: every line of a language (on all its rows) with `find` in it gets `replace`
 * instead; only those lines are drawn again, their times kept (and their words' times while
 * they have as many words). Returns how many lines changed.
 */
export async function replaceInCaptions(trackId: string, find: string, replace: string): Promise<number> {
  if (!find.trim()) return 0
  let changed = 0
  for (const info of captionGroup(await latest(), trackId)) {
    const cues = cuesFrom(info, true)
    let here = 0
    for (const [i, c] of cues.entries()) {
      const text = c.text.replace(findPattern(find), replace).replace(/\s+/g, ' ').trim()
      if (text === c.text) continue
      const words = c.words && text.split(' ').length === c.words.length ? c.words.map((w, k) => ({ ...w, w: text.split(' ')[k] })) : undefined
      cues[i] = { ...c, text, words, png: undefined }
      here++
    }
    // A line replaced by nothing goes.
    const kept = cues.filter((c) => c.text)
    if (here) await redraw(info, kept, lookOf(info), info.centerY, -1)
    changed += here
  }
  return changed
}

/** How long a new line is, and the least room that takes one between two lines. */
const NEW_LINE_US = 1_500_000
const MIN_ROOM_US = 300_000

/**
 * Enter at the end of a line: a new, empty line right after it. It goes in the gap before the
 * next line when there's room (filling the gap, up to 1.5 s); when there isn't, on a row above:
 * the language's next row if it's free there, else a new one just above this row. `text` is
 * the line's words as typed, saved first. Returns the new line's id.
 */
export async function addCaptionLineAfter(trackId: string, clipId: string, text?: string): Promise<string | undefined> {
  let info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  let i = info?.lines.findIndex((c) => c.id === clipId) ?? -1
  if (!info || i < 0) return
  const typed = text?.trim()
  const start = info.lines[i].startUs + info.lines[i].durationUs
  const room = (info.lines[i + 1]?.startUs ?? Infinity) - start
  if (room >= MIN_ROOM_US) {
    const cues = cuesFrom(info, true)
    if (typed && typed !== cues[i].text) cues[i] = { ...cues[i], text: typed, png: undefined }
    cues.splice(i + 1, 0, { startUs: start, endUs: start + Math.min(room, NEW_LINE_US), text: '', ...placeOf(info.lines[i]) })
    const r = await redraw(info, cues, lookOf(info), info.centerY, -1, i + 1)
    return r?.clipIds[i + 1]
  }
  if (typed && typed !== info.lines[i].text?.content) {
    await editCaptionLine(trackId, clipId, typed)
    info = captionTracks(await latest()).find((t) => t.track.id === trackId)
    if (!info) return
  }
  const end = start + NEW_LINE_US
  const free = (t: CaptionInfo) => t.lines.every((c) => c.startUs >= end || c.startUs + c.durationUs <= start)
  const row = captionGroup(await latest(), trackId).find((t) => t.track.id !== trackId && free(t))
  if (row) {
    const cues = cuesFrom(row, true)
    const at = cues.filter((c) => c.startUs < start).length
    cues.splice(at, 0, { startUs: start, endUs: end, text: '', ...placeOf(info.lines[i]) })
    const r = await redraw(row, cues, lookOf(row), row.centerY, -1, at)
    return r?.clipIds[at]
  }
  const look = lookOf(info)
  const lines = await drawLines([{ startUs: start, endUs: end, text: '', ...placeOf(info.lines[i]) }], look, info.centerY)
  holdSelection(3000)
  const r = await setLines(undefined, lines, look, trackId)
  if (r?.clipIds[0]) setState({ selection: [r.clipIds[0]] })
  return r?.clipIds[0]
}

/**
 * Enter in a line: it becomes two at the cursor, `before` and `after`, each keeping the voice's
 * own timing. With the words' times kept, the first ends with its last word and the second
 * starts with its first; without them the time is shared out by length. Nothing is heard
 * again. Returns the new lines' ids (the second part is `ids[index + 1]`).
 */
export async function splitCaptionLine(trackId: string, clipId: string, before: string, after: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  const i = info?.lines.findIndex((c) => c.id === clipId) ?? -1
  if (!info || i < 0) return
  const [a, b] = [before.trim(), after.trim()]
  if (!a || !b) {
    await editCaptionLine(trackId, clipId, `${a} ${b}`.trim())
    return
  }
  const c = info.lines[i]
  const start = c.startUs
  const end = c.startUs + c.durationUs
  const ws = c.text?.words ?? []
  const n = a.split(/\s+/).length
  let first: Cue
  let second: Cue
  if (ws.length > n) {
    const next = start + ws[n].s
    first = { startUs: start, endUs: next, text: a, words: ws.slice(0, n), ...placeOf(c) }
    second = { startUs: next, endUs: end, text: b, words: ws.slice(n).map((x) => ({ ...x, s: x.s - ws[n].s, e: x.e - ws[n].s })), ...placeOf(c) }
  } else {
    const cut = Math.round(start + ((end - start) * a.length) / (a.length + b.length))
    first = { startUs: start, endUs: cut, text: a, ...placeOf(c) }
    second = { startUs: cut, endUs: end, text: b, ...placeOf(c) }
  }
  const cues = cuesFrom(info, true)
  cues.splice(i, 1, first, second)
  const r = await redraw(info, cues, lookOf(info), info.centerY, -1, i + 1)
  return r && { ids: r.clipIds, index: i }
}

/** Backspace at the start of a line: it joins the line before it (`text` is this line's words as typed). */
export async function joinCaptionLine(trackId: string, clipId: string, text: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  const i = info?.lines.findIndex((c) => c.id === clipId) ?? -1
  if (!info || i < 1) return
  const [prev, cur] = [info.lines[i - 1], info.lines[i]]
  const shift = cur.startUs - prev.startUs
  const pw = prev.text?.words
  const cw = cur.text?.words
  const joined: Cue = {
    ...placeOf(prev),
    startUs: prev.startUs,
    endUs: cur.startUs + cur.durationUs,
    text: `${(prev.text?.content ?? '').trim()} ${text.trim()}`.trim(),
    words: pw && cw ? [...pw, ...cw.map((x) => ({ ...x, s: x.s + shift, e: x.e + shift }))] : undefined,
  }
  const cues = cuesFrom(info, true)
  cues.splice(i - 1, 2, joined)
  const r = await redraw(info, cues, lookOf(info), info.centerY, -1, i - 1)
  return r && { ids: r.clipIds, index: i - 1, caret: (prev.text?.content ?? '').trim().length + 1 }
}

/**
 * Delete at the end of a line: the line after it joins it (`text` is this line's words as
 * typed), each keeping its words' times. The cursor stays where it was, before the joined words.
 */
export async function joinNextCaptionLine(trackId: string, clipId: string, text: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  const i = info?.lines.findIndex((c) => c.id === clipId) ?? -1
  if (!info || i < 0 || i + 1 >= info.lines.length) return
  const [cur, next] = [info.lines[i], info.lines[i + 1]]
  const mine = text.trim()
  const shift = next.startUs - cur.startUs
  // This line's word times hold only while its words are as they were.
  const cw = mine === (cur.text?.content ?? '').trim() ? cur.text?.words : undefined
  const nw = next.text?.words
  const joined: Cue = {
    ...placeOf(cur),
    startUs: cur.startUs,
    endUs: next.startUs + next.durationUs,
    text: `${mine} ${(next.text?.content ?? '').trim()}`.trim(),
    words: cw && nw ? [...cw, ...nw.map((x) => ({ ...x, s: x.s + shift, e: x.e + shift }))] : undefined,
  }
  const cues = cuesFrom(info, true)
  cues.splice(i, 2, joined)
  const r = await redraw(info, cues, lookOf(info), info.centerY, -1, i)
  return r && { ids: r.clipIds, index: i, caret: mine.length }
}

// .srt

const srtTime = (us: Us) => {
  const ms = Math.max(0, Math.round(us / 1000))
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}

export function srtOf(info: CaptionInfo): string {
  return info.lines.map((c, i) => `${i + 1}\n${srtTime(c.startUs)} --> ${srtTime(c.startUs + c.durationUs)}\n${(c.text?.content ?? '').trim()}\n`).join('\n')
}

const projectStem = () => {
  const s = getState().snap
  return (s?.project.name || basename(s?.dir ?? '').replace(/\.studio$/i, '') || 'Captions').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
}

/** Export .srt: a save dialog, next to the project folder by default. */
export async function exportSrt(trackId: string) {
  const info = captionTracks(await latest()).find((t) => t.track.id === trackId)
  if (!info?.lines.length) return toast('Make captions first.', 'error')
  const dir = getState().snap?.dir ?? ''
  const parent = dir.replace(/[\\/][^\\/]*$/, '')
  const sep = dir.includes('\\') ? '\\' : '/'
  const file = await window.studio.app.saveFile({ title: 'Save the captions', defaultPath: `${parent}${sep}${projectStem()}${info.lang ? `.${info.lang}` : ''}.srt`, filters: [{ name: 'Subtitles (.srt)', extensions: ['srt'] }] })
  if (!file) return
  const r = await window.studio.files.writeSrt(file, srtOf(info))
  if ('error' in r) return toast(r.error, 'error')
  toast(`Saved ${basename(r.out)}`)
  window.studio.app.showItem(r.out)
}

/**
 * For the Export dialog's Captions setting (".srt" or "Both"): writes `<baseName>.srt` into
 * `folder` (with the language, `<baseName>.<lang>.srt`, when there are several tracks; hidden
 * tracks too). Returns the files written.
 */
export async function exportCaptionsSrt(folder: string, baseName: string): Promise<string[]> {
  const all = captionTracks(await latest()).filter((t) => t.lines.length)
  const sep = folder.includes('\\') ? '\\' : '/'
  const out: string[] = []
  const used = new Set<string>()
  for (const t of all) {
    let name = all.length > 1 && t.lang ? `${baseName}.${t.lang}` : baseName
    for (let n = 2; used.has(name); n++) name = `${baseName}-${n}`
    used.add(name)
    const r = await window.studio.files.writeSrt(`${folder.replace(/[\\/]$/, '')}${sep}${name}.srt`, srtOf(t))
    if ('error' in r) throw new Error(r.error)
    out.push(r.out)
  }
  return out
}

/** Burn into the video: the captions track is part of the picture (shown), or left out (hidden). */
export async function burnCaptions(trackId: string, on: boolean) {
  await call('track.set', { trackId, hidden: !on, label: on ? 'Show captions' : 'Hide captions' })
  toast(on ? 'The captions are part of the picture: in the player and in every export.' : 'The captions are left out of the picture. Export .srt to give them as a file.')
}
