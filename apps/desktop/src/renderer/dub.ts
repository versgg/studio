// Dub on the page: starting one from a clip's Dub tab, following it (the clip is busy meanwhile,
// as for Vmake), the review (what to dub, and the translations), and putting a ready one on the
// timeline: the clip plays the new picture (the original with the old text taken out), each
// translated text goes on a text track as an ordinary text clip at the original's exact frames,
// place, font, size, colour, box and shadow; for a voice dub the clip's own sound goes off, the
// background (her voice taken out) goes under it, and every sentence is its own sound clip at
// its moment; captions in the new language if asked.
//
// The font is fitted here, where text is drawn with the same fonts the export uses: every font of
// the lettering's kind (the one Claude names first) at every weight, sized so its letters are as
// wide as the original's, drawn over the original's letter mask (dub-look.ts) and scored by how
// well they cover it (an earlier dubbing tool's fontfit round 3).

import type { DubJob, DubLook, DubScan, DubText, DubVoice, DubVoiceLine } from '../shared/dub'
import { dubRunning, unchanged } from '../shared/dub'
import { cuesOf, placeCaptions, recaption } from './captions'
import { FONTS } from './textFonts'
import { loadFont } from './textFonts'
import { layoutText, renderTextClip, type TextLook } from './textRender'
import { getUi, setUi } from './ui-state'
import { call, fileUrl, findClip, getState, mediaById, setState, subscribeStore as subscribe, toast, type Clip, type Snapshot } from './store'

const EMOJI = /\p{Extended_Pictographic}|‍|️/gu
const noEmoji = (s: string) => s.replace(EMOJI, '').trim()

/** Right-click › Dub…: the clip's Dub tab in the Inspector. */
export function openDub(target: { mediaId: string; clipId: string }) {
  setState({ selection: [target.clipId], focus: 'timeline' })
  setUi('insp.tab', 'dub')
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? ''
const folderOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
/** A dub's sentence files: `line-L03.wav`, its rerolls `line-L03-r<tag>-fit.wav`. */
const LINE_FILE = /^line-([A-Za-z0-9]+)[-.]/

/** The timeline clip that plays a dubbed sentence: any take of it, else a file of the dub named for it. */
export function lineClip(snap: Snapshot | null, job: DubJob, line: DubVoiceLine): Clip | undefined {
  const takes = new Set([line.file, ...(line.takes ?? []).map((t) => t.file)])
  const clips = snap?.project.tracks.flatMap((t) => t.clips) ?? []
  const path = (c: Clip) => mediaById(snap, c.mediaId)?.path ?? ''
  return clips.find((c) => takes.has(path(c))) ?? clips.find((c) => folderOf(path(c)) === job.dir && LINE_FILE.exec(fileName(path(c)))?.[1] === line.id)
}

/** The dubbed sentences among `clipIds` (sound clips a voice dub put on the timeline), by dub. */
export function dubbedLines(snap: Snapshot | null, clipIds: string[]): { job: DubJob; lineIds: string[] }[] {
  const jobs = Object.values(getState().dubJobs)
  const out = new Map<string, { job: DubJob; lineIds: string[] }>()
  for (const id of clipIds) {
    const c = findClip(snap, id)?.clip
    const path = (c && mediaById(snap, c.mediaId)?.path) ?? ''
    const line = LINE_FILE.exec(fileName(path))?.[1]
    const job = line && jobs.find((j) => j.dir === folderOf(path) && j.voiceId)
    if (!job) continue
    const entry = out.get(job.id) ?? { job, lineIds: [] }
    if (!entry.lineIds.includes(line)) entry.lineIds.push(line)
    out.set(job.id, entry)
  }
  return [...out.values()]
}

/**
 * Takes put where their sentences' clips are (a sentence you've moved stays where you put it),
 * each clip taking its take's whole length, and the dub's captions there made again from the
 * take's words: all one undo step. A sentence whose clip is gone goes back at its moment.
 */
async function swapIn(job: DubJob, lines: DubVoiceLine[], label: string) {
  const engine = window.studio.engine
  const gesture = `${label} ${job.id} ${Date.now().toString(36)}`
  const imp = await engine.call('media.import', { paths: lines.map((l) => l.file), gesture, label })
  if (imp.failed?.length || imp.imported?.length !== lines.length) throw new Error(imp.failed?.[0]?.error ?? 'the new take couldn’t be imported')
  const snap = getState().snap
  const video = findClip(snap, job.clipId)?.clip
  const spans: { fromUs: number; toUs: number; words: { text: string; start: number; end: number }[] }[] = []
  let lastEnd = -Infinity
  for (const { l, mediaId } of lines.map((l, i) => ({ l, mediaId: imp.imported[i] as string })).sort((a, b) => a.l.at - b.l.at)) {
    const old = lineClip(snap, job, l)
    const speed = old?.speed ?? 1
    // Sentences put back one after another: each starts no sooner than a short pause after the last.
    const at = old ? old.startUs : Math.max((video?.startUs ?? 0) + Math.round((l.at * 1e6) / (video?.speed ?? 1)), lastEnd + 300_000)
    if (old) await engine.call('clip.replaceMedia', { clipId: old.id, mediaId, whole: true, gesture, label })
    else await engine.call('timeline.insert', { mediaId, atUs: at, gesture })
    const dur = Math.round((l.dur * 1e6) / speed)
    lastEnd = at + dur
    const time = (s: number) => at + Math.round((s * 1e6) / speed)
    spans.push({ fromUs: at, toUs: Math.max(lastEnd, old ? old.startUs + old.durationUs : 0), words: l.words.map((w) => ({ text: w.text, start: time(w.start), end: time(w.end) })) })
  }
  await recaption(job.lang, spans, gesture)
}

/**
 * Reroll: dubbed sentences spoken again by the same voice as a new take (main: `reroll`; with
 * `edits`' words where given, else their own), swapped in where their clips are.
 */
export async function rerollLines(job: DubJob, lineIds: string[], edits: Record<string, string> = {}): Promise<DubVoiceLine[] | undefined> {
  const r = await window.studio.services.dubReroll(job.id, lineIds, edits)
  if ('error' in r) return void toast(`Couldn’t reroll: ${r.error}`, 'error')
  if (!r.length) return void toast('Nothing to reroll: only sentences the dub spoke can be said again.')
  try {
    await swapIn(job, r, 'Reroll voice')
  } catch (e) {
    return void toast(`Couldn’t put the new take in: ${(e as Error).message}`, 'error')
  }
  const faster = r.some((l) => l.tempo > 1.001) ? ' It runs a little faster to fit before the next.' : ''
  toast(r.length === 1 ? `Take ${r[0].takes?.length ?? 2} of that sentence is in.${faster} The Dub tab keeps every take.` : `${r.length} sentences said again, as one take.${faster}`)
  return r
}

/** Right-click › Reroll voice: the dubbed sentences among `clipIds`, each dub's as one reroll. */
export async function rerollClips(clipIds: string[]) {
  const snap = getState().snap
  for (const { job, lineIds } of dubbedLines(snap, clipIds)) {
    // Each with the words of the take its clip plays (Ctrl+Z may have put an earlier one back).
    const r = await window.studio.services.dubResult(job.id)
    const lines = 'error' in r ? [] : (r.voice?.lines ?? [])
    const words: Record<string, string> = {}
    for (const id of lineIds) {
      const l = lines.find((x) => x.id === id)
      const c = l && lineClip(snap, job, l)
      const path = c && mediaById(snap, c.mediaId)?.path
      const text = l?.takes?.find((t) => t.file === path)?.text ?? l?.text
      if (text) words[id] = text
    }
    await rerollLines(job, lineIds, words)
  }
}

/** An earlier take of a sentence played again (it was kept, so it's free), where its clip is. */
export async function pickLineTake(job: DubJob, lineId: string, take: number): Promise<DubVoiceLine | undefined> {
  const r = await window.studio.services.dubPickTake(job.id, lineId, take)
  if ('error' in r) return void toast(`Couldn’t play that take: ${r.error}`, 'error')
  try {
    await swapIn(job, [r], `Take ${take + 1}`)
  } catch (e) {
    return void toast(`Couldn’t put that take in: ${(e as Error).message}`, 'error')
  }
  return r
}

/** The Dub tab's picks and changed translations: the paid steps start. */
export const goDub = (id: string, o: { texts: string[]; lines: string[]; edits?: Record<string, string> }) => window.studio.services.dubGo(id, o)

/** Starts a dub of a clip; the clip is busy until it's on the timeline (or cancelled). */
export type DubOptions = { lang: string; model: string; text: boolean; removeText?: boolean; voice: DubVoice; voiceId?: string; voiceName?: string; captions: boolean; review: boolean }

export async function dubText(target: { mediaId: string; clipId: string }, o: DubOptions | string, model?: string) {
  // (target, lang, model): the on-screen text only, everything dubbed (the UI check and Claude's old call).
  const opts: DubOptions = typeof o === 'string' ? { lang: o, model: model ?? 'pro', text: true, voice: 'keep', captions: false, review: false } : o
  const snap = getState().snap
  const media = mediaById(snap, target.mediaId)
  const clip = findClip(snap, target.clipId)?.clip
  if (!snap || !media || !clip) return
  if (clip.busy) return void toast('That clip is already being worked on.')
  // A clip that plays an earlier dub's clean copy is dubbed from the original (whose text can
  // be found), and that copy is used again.
  const from = cleanedBy(media.path)
  const job = await window.studio.services.dubStart({ project: snap.dir, clipId: clip.id, mediaId: media.id, name: from?.name ?? media.name, source: from?.source ?? media.path, inUs: (from?.inUs ?? 0) + clip.inUs, spanUs: Math.round(clip.durationUs * (clip.speed ?? 1)), ...opts })
  if ('error' in job) return void toast(`The dub couldn’t start: ${job.error}`, 'error')
  onDubJob(job)
  try {
    await window.studio.engine.call('clip.busy', { clipId: clip.id, job: job.id })
  } catch (e) {
    await window.studio.services.dubCancel(job.id)
    toast(`The dub couldn’t start: ${(e as Error).message}`, 'error')
  }
}

/** The dub whose clean copy (Vmake's) a file is, if any. */
export const cleanedBy = (path: string) => Object.values(getState().dubJobs).find((j) => j.clean === path)

/**
 * A clean copy already made for this clip's stretch of its file (an earlier dub's, into any
 * language), which a new dub uses again at no cost; also when the clip plays that copy itself.
 */
export function cleanFor(clip: { inUs: number; durationUs: number; speed?: number }, media: { path: string }) {
  const from = cleanedBy(media.path)
  const source = from?.source ?? media.path
  const inUs = (from?.inUs ?? 0) + clip.inUs
  const span = Math.round(clip.durationUs * (clip.speed ?? 1))
  return from ?? Object.values(getState().dubJobs).find((j) => j.clean && j.source === source && Math.abs(j.inUs - inUs) < 1000 && Math.abs(j.spanUs - span) < 1000)
}

export async function cancelDub(id: string) {
  const job = await window.studio.services.dubCancel(id)
  if (job) return
  const c = getState().snap?.project.tracks.flatMap((t) => t.clips).find((x) => x.busy === id)
  if (c) await call('clip.release', { clipId: c.id, job: id })
}

/**
 * Starts a stopped dub again from where it stopped (what it found, read and had removed is kept;
 * a text removal that stopped is started, and paid for, again). Its clip is busy again first.
 */
export async function retryDub(id: string) {
  const job = getState().dubJobs[id]
  const c = job && findClip(getState().snap, job.clipId)?.clip
  if (!job || !c) return void toast('That clip is gone, so the dub can’t start again. Start a new one from its clip.', 'error')
  if (c.busy && c.busy !== id) return void toast('That clip is busy with something else.')
  told.delete(`${id}:end`)
  told.delete(id)
  if (!c.busy) await window.studio.engine.call('clip.busy', { clipId: c.id, job: id })
  await window.studio.services.dubRetry(id)
}

/** Starts a dub's text removal again after Vmake stopped (paid again); the dub itself goes on. */
export async function removeAgain(id: string) {
  const r = await window.studio.services.dubRemoveAgain(id)
  if ('error' in r) toast(r.error, 'error')
}

/** What a busy clip shows for its dub. */
export function dubProgress(job: DubJob | undefined): { fraction: number | null; text: string; head: string; left: string } {
  const say = `Dubbing${job ? ` into ${LANG_NAMES[job.lang] ?? job.lang}` : ''}…`
  if (!job) return { fraction: null, text: say, head: say, left: '' }
  if (job.state === 'review') return { fraction: job.fraction, text: 'Dub: pick what to dub in the Dub tab', head: 'Dub: waiting for your picks', left: 'Dub tab' }
  const head = `${say} ${Math.round(job.fraction * 100)} %`
  return { fraction: job.fraction, text: `${head} · ${job.stage}`, head, left: job.needsClaude ? 'Waiting for Claude Code' : '' }
}

/**
 * Home's line for a project's dubs: what's running (with how far), waiting for picks, ready to
 * land when the project opens, or stopped. `tone` says how to show it. Null with nothing to say.
 */
export function dubStatus(jobs: DubJob[] | undefined): { text: string; tone: 'busy' | 'wait' | 'fail' } | null {
  if (!jobs?.length) return null
  const into = (j: DubJob) => LANG_NAMES[j.lang] ?? j.lang
  const running = jobs.filter((j) => dubRunning(j) && j.state !== 'review')
  if (running.length) {
    const f = Math.round((running.reduce((a, j) => a + j.fraction, 0) / running.length) * 100)
    const j = running[0]
    return { text: running.length > 1 ? `${running.length} dubs running · ${f} %` : `Dubbing into ${into(j)} · ${f} % · ${j.needsClaude ? 'waiting for Claude Code' : j.stage}`, tone: 'busy' }
  }
  const waiting = jobs.filter((j) => j.state === 'review')
  if (waiting.length) return { text: `Dub into ${into(waiting[0])}: pick what to dub${waiting.length > 1 ? ` (${waiting.length} clips)` : ''}`, tone: 'wait' }
  const ready = jobs.filter((j) => j.state === 'ready')
  if (ready.length) return { text: `Dub into ${into(ready[0])} ready: goes on the timeline when you open it`, tone: 'wait' }
  const failed = jobs.filter((j) => j.state === 'failed')
  if (failed.length) return { text: `Dub stopped: ${failed[0].reason ?? 'unknown error'}`, tone: 'fail' }
  return null
}

export const LANG_NAMES: Record<string, string> = { sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', de: 'German', en: 'English', nl: 'Dutch', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', pl: 'Polish' }

const applying = new Set<string>()
const told = new Set<string>()

function showTask(job: DubJob) {
  const s = getState()
  const others = s.tasks.filter((t) => t.id !== job.id)
  if (dubRunning(job)) setState({ tasks: [...others, { id: job.id, label: `Dubbing ${job.name}`, stage: job.stage, fraction: job.fraction, state: 'running', kind: 'dub', key: job.clipId, startedAt: job.startedAt }] })
  else if (others.length < s.tasks.length) setState({ tasks: others })
}

/** A dub changed (any project's): the open project's are shown, and a ready one goes on the timeline. */
export function onDubJob(job: DubJob, loading = false) {
  const s = getState()
  if (!s.snap || !sameDir(job.project, s.snap.dir)) return
  setState({ dubJobs: { ...getState().dubJobs, [job.id]: job } })
  showTask(job)
  // One that stopped before this session is only offered again (Dub text… on its clip), not announced.
  if (loading && !dubRunning(job)) told.add(job.id).add(`${job.id}:end`)
  if (job.needsClaude && !told.has(job.id)) {
    told.add(job.id)
    toast(job.stage, 'error')
  }
  if (dubRunning(job) || job.state === 'ready') void holdClip(job)
  if (job.state === 'ready') void applyDub(job)
  else if (job.state === 'failed' || job.state === 'cancelled') void freeClip(job)
}

/** A dub still going keeps its clip busy (its mark may have been taken off while the project was closed). */
const holding = new Set<string>()
async function holdClip(job: DubJob) {
  const c = findClip(getState().snap, job.clipId)?.clip
  if (!c || c.busy || holding.has(job.id)) return
  holding.add(job.id)
  await window.studio.engine.call('clip.busy', { clipId: c.id, job: job.id }).catch(() => {})
  holding.delete(job.id)
}

async function freeClip(job: DubJob) {
  const c = findClip(getState().snap, job.clipId)?.clip
  if (c?.busy === job.id) await call('clip.release', { clipId: c.id, job: job.id })
  if (!told.has(`${job.id}:end`)) {
    told.add(`${job.id}:end`)
    toast(job.state === 'failed' ? `The dub of ${job.name} failed: ${job.reason ?? 'unknown error'}` : (job.reason ?? 'Dub cancelled.'), job.state === 'failed' ? 'error' : 'info')
  }
}

function sameDir(a: string, b: string) {
  const n = (d: string) => d.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return window.studio.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/** Follows dubs: every change, and a project's dubs whenever it's opened. */
export function initDub() {
  window.studio.services.onDubJob(onDubJob)
  // For the UI check and for Claude driving the app: start a dub, fit a ready one's fonts.
  Object.assign((window as unknown as { __studio: object }).__studio ?? {}, { dubText, fitDub, cancelDub, retryDub, rerollLines, rerollClips, pickLineTake, dubbedLines })
  let jobsFor = ''
  subscribe(() => {
    const s = getState()
    const dir = s.link === 'connected' && s.snap ? s.snap.dir : ''
    if (dir === jobsFor) return
    jobsFor = dir
    // Another project: its own dubs only (clip ids repeat across projects). Ones running in the
    // project left carry on in the main process and land when it's opened again.
    setState({ dubJobs: {}, tasks: getState().tasks.filter((t) => t.kind !== 'dub') })
    if (!dir) return
    window.studio.services.dubJobs(dir).then((list) => {
      if (!getState().snap || !sameDir(getState().snap!.dir, dir)) return
      for (const j of list) onDubJob(j, true)
    })
  })
}

// Fitting the font

type Fit = { family: string; weight: number; italic: boolean; size: number; score: number }

async function loadMask(file: string) {
  const res = await fetch(fileUrl(file))
  if (!res.ok) throw new Error(`the letter mask couldn’t be read (${res.status})`)
  const img = await createImageBitmap(await res.blob())
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  const m = new Uint8Array(c.width * c.height)
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0
  return { m, w: c.width, h: c.height }
}

/** The original's lines, as Claude read them, matched to OCR's lines (and their ink). */
function linesOf(t: DubText, look: DubLook, block: DubScan['blocks'][number]) {
  const read = t.text.split('\n').map((l) => l.trim()).filter(Boolean)
  const lines = read.length === look.ink.length ? read : block.lines.map((l) => l.text)
  return lines.map((text, i) => ({ text, ink: look.ink[i] })).filter((l) => l.ink && noEmoji(l.text))
}

type Item = { t: DubText; look: DubLook; block: DubScan['blocks'][number] }

const kindOf = (t: DubText) => (t.category === 'display' || t.category === 'script' || t.category === 'mono' || t.category === 'serif' ? t.category : 'sans')
const colourGap = (a: string, b: string) => {
  const c = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [c(a), c(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/**
 * Texts set in one style ("Day 1", "Day 4"… in the same serif, the same colour, the same size):
 * fitted together, so they all get the same font, and more letters make the fit surer.
 */
export function styleGroups(items: Item[]): Item[][] {
  const groups: Item[][] = []
  const inkH = (i: Item) => median(i.look.ink.map((k) => k.h))
  for (const it of items) {
    const g = groups.find((g) => {
      const o = g[0]
      const r = inkH(it) / Math.max(1, inkH(o))
      return kindOf(o.t) === kindOf(it.t) && !!o.look.box === !!it.look.box && colourGap(o.look.color, it.look.color) < 60 && r > 0.75 && r < 1.33
    })
    if (g) g.push(it)
    else groups.push([it])
  }
  return groups
}

/**
 * The font and weight whose letters cover a style group's originals best, and each text's size
 * (source pixels): every font of the lettering's kind (the one Claude names gets a small edge)
 * at every weight, sized so its letters are as wide as the original's, drawn over the
 * original's letter mask and scored by overlap, less how far widths and heights are off.
 */
async function fitGroup(items: Item[], dir: string): Promise<{ family: string; weight: number; italic: boolean; sizes: Map<string, number>; score: number }> {
  const sep = dir.includes('\\') ? '\\' : '/'
  const masks = await Promise.all(items.map((i) => loadMask(`${dir}${sep}${i.look.mask}`)))
  const named = items.map((i) => i.t.font).filter(Boolean) as string[]
  const font0 = named.sort((a, b) => named.filter((x) => x === b).length - named.filter((x) => x === a).length)[0]
  const kind = kindOf(items[0].t)
  const italic = items.some((i) => i.t.italic)
  const upper = (i: Item, s: string) => (i.t.uppercase ? s.toLocaleUpperCase() : s)
  const lines = items.map((i) => linesOf(i.t, i.look, i.block))
  const fallbackFamily = font0 && FONTS.some((f) => f.family === font0) ? font0 : kind === 'serif' ? 'EB Garamond' : 'TikTok Sans'
  let best = { family: fallbackFamily, weight: items[0].t.weight ?? 600, italic, sizes: new Map(items.map((i, n) => [i.t.id, Math.max(8, (lines[n][0]?.ink.h ?? 20) / 0.72)])), score: -1 }
  if (!lines.some((l) => l.length)) return best
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  for (const f of FONTS.filter((x) => x.kind === kind || x.family === font0))
    for (const weight of f.weights) {
      await loadFont(f.family, weight, italic, lines.flat().map((l) => l.text).join(' '))
      const font = (size: number) => `${italic ? 'italic ' : ''}${weight} ${size}px "${f.family}"`
      const sizes = new Map<string, number>()
      let werr = 0, herr = 0, iou = 0, nw = 0, n = 0
      for (const [k, it] of items.entries()) {
        const ls = lines[k]
        if (!ls.length) continue
        ctx.font = font(100)
        const m100 = ls.map((l) => ctx.measureText(upper(it, noEmoji(l.text))))
        const plain = ls.map((l) => l.text === noEmoji(l.text))
        const widths = m100.map((m) => m.actualBoundingBoxLeft + m.actualBoundingBoxRight)
        const heights = m100.map((m) => m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)
        // Size: the letters as wide as the original's (lines with emoji only count by height).
        const size = median(ls.map((l, i) => (plain[i] && widths[i] ? (l.ink.w / widths[i]) * 100 : (l.ink.h / Math.max(1, heights[i])) * 100)))
        if (!(size > 4)) continue
        sizes.set(it.t.id, size)
        for (const [i, l] of ls.entries()) {
          const w = (widths[i] * size) / 100, h = (heights[i] * size) / 100
          if (plain[i]) (werr += Math.abs(Math.log(l.ink.w / Math.max(1, w)))), nw++
          herr += Math.abs(Math.log(l.ink.h / Math.max(1, h)))
          // Drawn over the original's letters (stretched to their width, as an earlier dubbing tool's fitter does).
          const bw = Math.max(1, plain[i] ? l.ink.w : Math.round(w)), bh = Math.max(1, l.ink.h)
          canvas.width = bw
          canvas.height = bh
          ctx.font = font(size)
          ctx.fillStyle = '#fff'
          ctx.setTransform(plain[i] ? bw / Math.max(1, w) : 1, 0, 0, 1, 0, 0)
          ctx.fillText(upper(it, noEmoji(l.text)), (m100[i].actualBoundingBoxLeft * size) / 100, (m100[i].actualBoundingBoxAscent * size) / 100)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          const d = ctx.getImageData(0, 0, bw, bh).data
          const mask = masks[k]
          let inter = 0, union = 0
          const ox = l.ink.x - it.look.maskRect.x, oy = l.ink.y - it.look.maskRect.y
          for (let y = 0; y < bh; y++)
            for (let x = 0; x < bw; x++) {
              const mx = ox + x, my = oy + y
              const a = d[(y * bw + x) * 4 + 3] > 127
              const b = mx >= 0 && my >= 0 && mx < mask.w && my < mask.h && mask.m[my * mask.w + mx] === 1
              if (a && b) inter++
              if (a || b) union++
            }
          iou += union ? inter / union : 0
          n++
        }
      }
      if (!n) continue
      const score = iou / n - 0.8 * (werr / Math.max(1, nw)) - 0.5 * (herr / n) + (f.family === font0 ? 0.03 : 0)
      if (score > best.score) best = { family: f.family, weight, italic, sizes, score }
    }
  return best
}

// Placing the text

/** How the clip's picture sits in the frame: source pixel → project pixel. */
function placement(clip: Clip, scan: DubScan) {
  const p = getState().snap!.project
  const fill = clip.fit !== 'fit'
  const k0 = fill ? Math.max(p.width / scan.width, p.height / scan.height) : Math.min(p.width / scan.width, p.height / scan.height)
  const k = k0 * ((clip.scale ?? 100) / 100)
  return {
    k,
    x: (sx: number) => p.width / 2 + (clip.posX ?? 0) + (sx - scan.width / 2) * k,
    y: (sy: number) => p.height / 2 + (clip.posY ?? 0) + (sy - scan.height / 2) * k,
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0

/** The text clip for one translated block: its look and where its middle goes. */
async function specFor(t: DubText, look: DubLook, block: DubScan['blocks'][number], fit: Fit, clip: Clip, scan: DubScan) {
  const p = getState().snap!.project
  const at = placement(clip, scan)
  const lines = linesOf(t, look, block)
  const inks = lines.length ? lines.map((l) => l.ink) : look.ink
  // Alignment: whichever of the lines' lefts, middles or rights line up best (the middle wins ties).
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
  const lefts = inks.map((i) => i.x), mids = inks.map((i) => i.x + i.w / 2), rights = inks.map((i) => i.x + i.w)
  const align: 'left' | 'center' | 'right' = inks.length < 2 || spread(mids) <= Math.min(spread(lefts), spread(rights)) + 4 ? 'center' : spread(lefts) < spread(rights) ? 'left' : 'right'
  const pitch = inks.length > 1 ? median(inks.slice(1).map((i, n) => i.y + i.h - (inks[n].y + inks[n].h))) : fit.size * 1.2
  const lineHeight = Math.min(2, Math.max(0.9, pitch / fit.size))
  let size = fit.size * at.k
  const spec: TextLook = {
    content: t.translation,
    font: fit.family,
    size,
    weight: fit.weight,
    italic: fit.italic,
    color: look.color,
    align,
    lineHeight,
    letterSpacing: 0,
    case: t.uppercase ? 'upper' : 'none',
    stroke: look.stroke ? { color: look.stroke.color, width: Math.max(1, look.stroke.width * at.k) } : null,
    shadow: look.shadow ? { color: withOpacity(look.shadow.color, look.shadow.opacity), blur: look.shadow.blur * at.k * 1.2, x: look.shadow.x * at.k, y: look.shadow.y * at.k } : null,
    background: null,
  } as TextLook
  // The original's font box (the measured ink with the fitted font's ascent above its first line).
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = `${fit.italic ? 'italic ' : ''}${fit.weight} ${fit.size}px "${fit.family}"`
  const first = measure.measureText(lines[0] ? noEmoji(lines[0].text) : 'A')
  const fm = measure.measureText('ÅÄÖgjpqy')
  const asc = fm.fontBoundingBoxAscent || fit.size * 0.9, desc = fm.fontBoundingBoxDescent || fit.size * 0.25
  const base0 = inks[0].y + first.actualBoundingBoxAscent
  const lineH = fit.size * lineHeight
  const top = base0 - asc - (lineH - asc - desc) / 2
  const centreY = top + (lineH * inks.length) / 2
  if (look.box) {
    const r = look.box.rect
    const inkLeft = Math.min(...inks.map((i) => i.x)), inkRight = Math.max(...inks.map((i) => i.x + i.w))
    const padX = Math.max(0, Math.min(inkLeft - r.x, r.x + r.w - inkRight))
    const padY = Math.max(0, base0 - asc - r.y)
    spec.background = { color: look.box.color, opacity: look.box.opacity, radius: look.box.radius * at.k, padding: padX * at.k, padY: padY * at.k, block: true }
  }
  // Too wide for the original's place: smaller, down to 85 %.
  const room = Math.min(p.width * 0.92, Math.max(...inks.map((i) => i.w)) * at.k * 1.15 + 2 * (spec.background?.padding ?? 0))
  for (let n = 0; n < 8; n++) {
    const l = layoutText(spec, p.width, p.height)
    if (Math.max(...l.widths) + 2 * (spec.background?.padding ?? 0) <= room || size <= fit.size * at.k * 0.85) break
    size *= 0.98
    spec.size = size
  }
  const l = layoutText(spec, p.width, p.height)
  const blockW = Math.max(...l.widths)
  const cx = align === 'center' ? at.x(median(mids)) : align === 'left' ? at.x(Math.min(...lefts)) + blockW / 2 : at.x(Math.max(...rights)) - blockW / 2
  return { spec, posX: Math.round(cx - p.width / 2), posY: Math.round(at.y(centreY) - p.height / 2) }
}

function withOpacity(color: string, opacity: number) {
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')
  return /^#[0-9a-f]{6}$/i.test(color) ? color + a : color
}

/** Puts a ready dub on the timeline: the new picture under the clip, the new text over it. */
async function applyDub(job: DubJob) {
  if (applying.has(job.id)) return
  applying.add(job.id)
  try {
    const r = await window.studio.services.dubResult(job.id)
    if ('error' in r) throw new Error(r.error)
    const engine = window.studio.engine
    let found = findClip(getState().snap, job.clipId)?.clip
    if (found && !found.busy) {
      // Its mark was taken off (an older Studio did, opening the project): it's the dub's again.
      await engine.call('clip.busy', { clipId: found.id, job: job.id })
      found = { ...found, busy: job.id }
    }
    if (!found || (found.busy && found.busy !== job.id)) throw new Error('its clip has changed or gone')
    const speed = found.speed ?? 1
    const lang = LANG_NAMES[job.lang] ?? job.lang
    // Everything is fitted and drawn first, so nothing changes on the timeline unless it all can.
    const looks = new Map(r.looks.map((l) => [l.id, l]))
    const picked = new Set(job.picks?.texts ?? [])
    // Over Vmake's clean copy (`redraw`) every text edited in is drawn again, those not dubbed
    // (unpicked, or the same in the new language) with their own words; else only the dubbed ones.
    const items = r.scan
      ? r.texts
          .filter((x) => x.kind === 'edit' && looks.has(x.id) && (job.redraw || (picked.has(x.id) && !unchanged(x))))
          .map((x) => ({ t: picked.has(x.id) ? x : { ...x, translation: x.text }, look: looks.get(x.id)!, block: blockOf(r.scan!, x.id) }))
          .sort((a, b) => a.block.startUs - b.block.startUs)
      : []
    const fits = new Map<string, Fit>()
    for (const g of styleGroups(items)) {
      const f = await fitGroup(g, job.dir)
      for (const it of g) fits.set(it.t.id, { family: f.family, weight: f.weight, italic: f.italic, size: f.sizes.get(it.t.id) ?? median([...f.sizes.values()]), score: f.score })
    }
    const ready: { atUs: number; endUs: number; drawn: TextLook; posX: number; posY: number; label: string }[] = []
    for (const it of items) {
      const atUs = found.startUs + Math.round(it.block.startUs / speed)
      const endUs = Math.min(found.startUs + found.durationUs, found.startUs + Math.round(it.block.endUs / speed))
      if (endUs - atUs < 20_000) continue
      const { spec, posX, posY } = await specFor(it.t, it.look, it.block, fits.get(it.t.id)!, found, r.scan!)
      ready.push({ atUs, endUs, drawn: await renderTextClip(spec, `dub-${it.t.id}`), posX, posY, label: it.t.translation.split('\n')[0].slice(0, 40) })
    }
    const voice = r.voice?.lines ?? []
    const files = [...(job.bed ? [job.bed] : []), ...voice.map((l) => l.file)]
    const imp = files.length ? await engine.call('media.import', { paths: files }) : { imported: [] }
    if (files.length && (imp.failed?.length || imp.imported?.length !== files.length)) throw new Error(imp.failed?.[0]?.error ?? 'the new voice couldn’t be imported')
    const sounds: string[] = imp.imported ?? []

    // The picture: the copy with the old text taken out (which also ends the clip's busy state).
    if (job.base && (ready.length || job.removeText)) {
      const pic = await engine.call('media.import', { paths: [job.base] })
      const mediaId = pic.imported?.[0]
      if (!mediaId) throw new Error(pic.failed?.[0]?.error ?? 'the new picture couldn’t be imported')
      await engine.call('clip.replaceMedia', { clipId: found.id, mediaId, job: job.id, label: `Dub into ${lang}` })
    } else await engine.call('clip.release', { clipId: found.id, job: job.id })
    // Text tracks, filled in time order: a text goes on the first one free at its time.
    const rows: { trackId: string; endUs: number }[] = []
    for (const x of ready) {
      const row = rows.find((w) => w.endUs <= x.atUs)
      const added = await engine.call('text.add', { atUs: x.atUs, durationUs: x.endUs - x.atUs, text: x.drawn, ...(row ? { trackId: row.trackId } : {}) })
      if (row) row.endUs = x.endUs
      else rows.push({ trackId: added.trackId, endUs: x.endUs })
      await engine.call('clip.set', { clipId: added.clipId, posX: x.posX, posY: x.posY, label: x.label })
    }

    // The voice: the clip's own sound off, the background under it, every sentence at its moment.
    const at = (s: number) => found.startUs + Math.round((s * 1e6) / speed)
    if (voice.length) {
      await engine.call('clip.set', { clipId: found.id, detached: true })
      let k = 0
      if (job.bed) await engine.call('timeline.insert', { mediaId: sounds[k++], atUs: found.startUs })
      for (const l of voice) await engine.call('timeline.insert', { mediaId: sounds[k++], atUs: at(l.at) })
    }

    // Captions in the new language: from the new voice's own word times; where her own voice
    // stays, the translation shared out over the time she says it.
    if (job.captions) {
      const words: { text: string; start: number; end: number }[] = []
      const spread = (text: string, from: number, to: number) => {
        const ws = text.split(/\s+/).filter(Boolean)
        const total = ws.reduce((a, w) => a + w.length + 1, 0)
        let t = from
        for (const w of ws) {
          const d = ((to - from) * (w.length + 1)) / total
          words.push({ text: w, start: at(t), end: at(t + d) })
          t += d
        }
      }
      const said = new Map(r.said.map((x) => [x.id, x.translation]))
      if (voice.length)
        for (const l of voice) {
          if (l.own) spread(said.get(l.id) ?? l.text, l.at, l.at + l.dur)
          else for (const w of l.words) words.push({ text: w.text, start: at(l.at + w.start), end: at(l.at + w.end) })
        }
      else for (const l of r.speech?.lines ?? []) spread(said.get(l.id) ?? l.text, l.start, l.end)
      if (words.length) await placeCaptions(cuesOf(words, getUi('lib.capWords', 0)), { lang: job.lang, style: 'Clean', centerY: 0.72 })
    }
    await window.studio.services.dubApplied(job.id)
    const dubbed = voice.filter((l) => !l.own).length
    toast(
      [ready.length ? `${ready.length} text${ready.length === 1 ? '' : 's'}` : '', job.removeText && job.base ? 'on-screen text removed' : '', dubbed ? `${dubbed} sentence${dubbed === 1 ? '' : 's'}` : '', job.captions ? 'captions' : ''].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) +
        ` in ${lang}. Each is its own clip you can change; Ctrl+Z takes them off.${job.notes?.length ? ` Note: ${job.notes.join(' ')}` : ''}`,
    )
  } catch (e) {
    // Ends failed (the main process tells us, and the clip is freed then); Try again puts it on again.
    await window.studio.services.dubFailed(job.id, `It couldn’t go on the timeline: ${(e as Error).message}`)
  } finally {
    applying.delete(job.id)
  }
}

const blockOf = (scan: DubScan, id: string) => scan.blocks.find((b) => b.id === id)!

/** For the UI check and Claude: a dub's fitted fonts, by style group, without touching the timeline. */
export async function fitDub(id: string) {
  const r = await window.studio.services.dubResult(id)
  if ('error' in r) throw new Error(r.error)
  const items = r.texts.filter((x) => x.kind === 'edit').flatMap((t) => {
    const look = r.looks.find((l) => l.id === t.id)
    return look && r.scan ? [{ t, look, block: blockOf(r.scan, t.id) }] : []
  })
  const out: { ids: string[]; family: string; weight: number; score: number }[] = []
  for (const g of styleGroups(items)) {
    const f = await fitGroup(g, r.job.dir)
    out.push({ ids: g.map((i) => i.t.id), family: f.family, weight: f.weight, score: Math.round(f.score * 1000) / 1000 })
  }
  return out
}
