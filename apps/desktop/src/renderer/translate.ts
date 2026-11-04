// Translations on the page: collecting what the timeline says (text clips, caption lines and the
// sentences a known voice speaks), starting one job per language (src/main/translate.ts),
// following them, and putting a finished language on its own project's timeline when that
// project is open: every text clip says the translation in its own look and place (a little
// smaller if it no longer fits), the captions are made again in the new language (from the new
// voice's words, or line by line where they are), and each sentence's sound clip is swapped for
// the new one at its moment.

import { useSyncExternalStore } from 'react'
import { trLangName, trRunning, type TrItem, type TrJob, type TrVoice } from '../shared/translate'
import { captionTracks, cuesOf, setCaptionLines, wordsPerCaptionOf } from './captions'
import { loadFont } from './textFonts'
import { fontOf, layoutText, renderTextClip, textPlaceOf, type TextLook } from './textRender'
import { findClip, getState, mediaById, openProjectAt, subscribeStore as subscribe, toast, type Clip, type Snapshot } from './store'

// The jobs of the open project: those translating it, and its own when it's a copy.

let jobs: Record<string, TrJob> = {}
const listeners = new Set<() => void>()
const setJobs = (next: Record<string, TrJob>) => {
  jobs = next
  for (const l of listeners) l()
}
export function useTrJobs(): Record<string, TrJob> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    () => jobs,
  )
}

const norm = (d: string) => {
  const n = d.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return window.studio.platform === 'win32' ? n.toLowerCase() : n
}
const same = (a: string, b: string) => norm(a) === norm(b)
const letters = /\p{L}/u
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The engine's project as it is now (the store's copy may be a step behind). */
async function latest(): Promise<Snapshot | null> {
  try {
    return (await window.studio.engine.call('project.current')) as Snapshot
  } catch {
    return getState().snap
  }
}

/**
 * Everything the project says, in time order: text clips (not stickers, which have no letters),
 * caption lines, and every sound clip Studio knows the words of (a dub's sentence, a voiceover
 * with its script), with the voice that spoke it when known. `from` is the project's language:
 * its dub's, else its captions', else none.
 */
export async function collect(snap: Snapshot) {
  const p = snap.project
  const sounds = p.tracks.filter((t) => t.kind === 'audio' && !t.mute).flatMap((t) => t.clips)
  const paths = [...new Set(sounds.map((c) => mediaById(snap, c.mediaId)?.path).filter((x): x is string => !!x))]
  const ctx = await window.studio.services.translateContext(snap.dir, paths)
  if ('error' in ctx) throw new Error(ctx.error)
  const items: TrItem[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.main || t.hidden) continue
    for (const c of t.clips) {
      const content = c.text?.content ?? ''
      if (!letters.test(content)) continue
      const caption = t.role === 'captions' || c.caption
      const original = caption ? undefined : ctx.texts.find((x) => flat(x.translation) === flat(content))?.original
      items.push({ id: `${caption ? 'c' : 't'}:${c.id}`, kind: caption ? 'caption' : 'text', text: content, ...(original ? { original } : {}), startUs: c.startUs, endUs: c.startUs + c.durationUs })
    }
  }
  const voiceovers = new Map<string, Voiceover>()
  const unread = new Set<string>()
  // A sound cut into pieces (the pauses taken out) is said once: its pieces in time order, each on
  // from the one before in the file, are one line from the first to the last (a piece that goes
  // back in the file plays its words again, so it starts a line of its own).
  const runs = new Map<string, Clip[]>()
  for (const c of [...sounds].sort((a, b) => a.startUs - b.startUs)) {
    const run = [...runs.values()].find((r) => r[0].mediaId === c.mediaId && c.inUs >= r[r.length - 1].inUs + r[r.length - 1].durationUs * (r[r.length - 1].speed ?? 1) - 100_000)
    if (run) run.push(c)
    else runs.set(c.id, [c])
  }
  for (const c of sounds) {
    const m = mediaById(snap, c.mediaId)
    const s = ctx.sounds[m?.path ?? '']
    // A voiceover Studio didn't make, as it was heard: a line for each sentence, where it's said.
    if (m && s?.read) {
      if (!s.read.sentences.length) continue
      const voice = s.voiceId ? { voiceId: s.voiceId, model: s.model ?? 'eleven_v4', speed: s.speed ?? 1, name: s.name ?? 'The voice' } : undefined
      const vo = voiceovers.get(m.path) ?? { path: m.path, name: m.name, sentences: 0, voice, how: s.read.how, note: s.read.note }
      for (const [n, sn] of s.read.sentences.entries()) {
        const at = placeIn(c, sn.start, sn.end)
        if (!at) continue
        items.push({ id: `v:${c.id}~${n}`, kind: 'line', text: sn.text, startUs: at[0], endUs: at[1], ...(voice ? { voice } : {}) })
        vo.sentences++
      }
      voiceovers.set(m.path, vo)
      continue
    }
    if (m && !s && maybeVoice(m)) unread.add(m.path)
    if (!s?.text || !letters.test(s.text)) continue
    const run = runs.get(c.id)
    if (!run) continue
    const last = run[run.length - 1]
    items.push({
      id: `v:${c.id}`,
      kind: 'line',
      text: s.text,
      ...(s.original ? { original: s.original } : {}),
      startUs: c.startUs,
      endUs: last.startUs + last.durationUs,
      ...(run.length > 1 ? { pieces: run.slice(1).map((x) => x.id) } : {}),
      ...(s.voiceId ? { voice: { voiceId: s.voiceId, model: s.model ?? 'eleven_v4', speed: s.speed ?? 1, name: s.name ?? 'The voice' } } : {}),
    })
  }
  items.sort((a, b) => a.startUs - b.startUs || a.kind.localeCompare(b.kind))
  const capLang = captionTracks(snap).find((t) => t.lang)?.lang ?? ''
  return { items, from: ctx.lang || capLang, durationUs: snap.durationUs, voiceovers: [...voiceovers.values()], unread: [...unread] }
}

/** A voiceover the Translations tab heard (a file Studio didn't make), and the voice it found for it. */
export type Voiceover = { path: string; name: string; sentences: number; voice?: TrItem['voice']; how?: 'studio' | 'history' | 'name' | 'picked'; note?: string }

/** A sound file worth hearing for speech: long enough to say something, and not named as music or effects. */
const maybeVoice = (m: { name: string; durationUs?: number }) => (m.durationUs ?? 0) >= 1_500_000 && (m.durationUs ?? 0) <= 600_000_000 && !/instrument|music|musik|song|beat|bgm|soundtrack|ambien|sfx|effect/i.test(m.name)

/** A stretch of a sound file (seconds into it) on the timeline through its clip, or null when the clip doesn't play it. */
function placeIn(c: { startUs: number; inUs: number; durationUs: number; speed?: number }, start: number, end: number): [number, number] | null {
  const speed = c.speed || 1
  const from = c.inUs
  const to = c.inUs + c.durationUs * speed
  const mid = ((start + end) / 2) * 1e6
  if (mid < from || mid > to) return null
  const tl = (t: number) => Math.round(c.startUs + (Math.min(Math.max(t * 1e6, from), to) - from) / speed)
  return [tl(start), tl(end)]
}

/** Hears a voiceover once (what it says, which voice speaks it). */
export const readVoiceover = (project: string, file: string) => window.studio.services.translateReadVoice(project, file)
export const pickVoiceover = (project: string, file: string, voice: { voiceId: string; name: string } | null) => window.studio.services.translatePickVoice(project, file, voice)

/** Starts a translation of the open project into `langs`, one copy each. */
export async function startTranslation(o: { langs: string[]; voice: TrVoice; from: string }) {
  const snap = await latest()
  if (!snap) return
  try {
    const { items, durationUs } = await collect(snap)
    const r = await window.studio.services.translateStart({ source: snap.dir, name: snap.project.name, from: o.from, langs: o.langs, voice: o.voice, items, durationUs })
    if ('error' in r) return void toast(`The translation couldn’t start: ${r.error}`, 'error')
    for (const j of r) onTranslateJob(j)
  } catch (e) {
    toast(`The translation couldn’t start: ${(e as Error).message}`, 'error')
  }
}

export const goTranslation = (id: string, o: { picks: string[]; edits?: Record<string, string> }) => window.studio.services.translateGo(id, o)
export const cancelTranslation = (id: string) => window.studio.services.translateCancel(id)
export const retryTranslation = (id: string) => {
  told.delete(id)
  return window.studio.services.translateRetry(id)
}
export const openTranslation = (job: TrJob) => openProjectAt(job.project)

const told = new Set<string>()
const applying = new Set<string>()

/** A job changed (any project's): the open project's are kept, and its own ready one goes on its timeline. */
export function onTranslateJob(job: TrJob, loading = false) {
  const dir = getState().snap?.dir
  if (!dir || !(same(job.source, dir) || same(job.project, dir))) return
  setJobs({ ...jobs, [job.id]: job })
  if (same(job.project, dir) && job.state === 'ready') void applyTranslation(job)
  if (loading) told.add(job.id)
  if (job.state === 'failed' && !told.has(job.id)) {
    told.add(job.id)
    toast(`The ${trLangName(job.lang)} translation stopped: ${job.reason ?? 'unknown error'}`, 'error')
  }
}

/**
 * A finished language on its copy's timeline: text clips first (drawn and set one by one), then
 * the captions, then the voice. Ends applied; a failure ends it failed with the reason (Try
 * again puts it on again).
 */
async function applyTranslation(job: TrJob) {
  if (applying.has(job.id)) return
  applying.add(job.id)
  try {
    const r = await window.studio.services.translateResult(job.id)
    if ('error' in r) throw new Error(r.error)
    const engine = window.studio.engine
    const snap = await latest()
    if (!snap || !same(snap.dir, job.project)) return
    const p = snap.project
    const tr = new Map(r.texts.map((t) => [t.id, t.translation]))
    const picked = (id: string) => (job.picks ?? []).includes(id) && tr.has(id)
    let texts = 0
    const gone: string[] = []

    // Text clips: the translation in the clip's own look, smaller (down to 80 %) if it's much wider.
    for (const it of r.items.filter((i) => i.kind === 'text' && picked(i.id))) {
      const clip = findClip(snap, it.id.slice(2))?.clip
      if (!clip?.text) {
        gone.push(it.text)
        continue
      }
      const old = clip.text as TextLook
      const place = textPlaceOf(clip, p.width)
      const spec: TextLook = { ...old, content: tr.get(it.id)! }
      await loadFont(spec.font, fontOf(spec).weight, !!spec.italic, `${old.content} ${spec.content}`)
      const wide = (s: TextLook) => Math.max(0, ...layoutText(s, p.width, p.height, place).widths)
      const room = wide(old) * 1.1
      for (let n = 0; n < 12 && wide(spec) > room && spec.size > old.size * 0.8; n++) spec.size = Math.round(spec.size * 0.97 * 10) / 10
      const look = await renderTextClip(spec, `tr-${clip.id}`, place)
      await engine.call('text.set', { clipId: clip.id, text: look, gesture: `translate ${job.id}` })
      await engine.call('clip.set', { clipId: clip.id, label: look.content.split('\n')[0].slice(0, 40) }).catch(() => {})
      texts++
    }

    // Captions in the project's language: made again from the new voice's words, or line by line.
    const rows = captionTracks(await latest()).filter((t) => !job.from || !t.lang || t.lang === job.from)
    let captions = 0
    if (rows.length && job.captionsFromVoice && r.voice?.length) {
      const words: { text: string; start: number; end: number }[] = []
      for (const l of r.voice) for (const w of l.words) words.push({ text: w.text, start: l.atUs + Math.round(w.start * 1e6), end: l.atUs + Math.round(w.end * 1e6) })
      // Sentences not spoken again keep their words, shared out over the time they take.
      for (const it of r.items.filter((i) => i.kind === 'line' && !r.voice!.some((l) => l.id === i.id))) {
        const ws = it.text.split(/\s+/).filter(Boolean)
        const total = ws.reduce((a, w) => a + w.length + 1, 0)
        let t = it.startUs
        for (const w of ws) {
          const d = ((it.endUs - it.startUs) * (w.length + 1)) / total
          words.push({ text: w, start: Math.round(t), end: Math.round(t + d) })
          t += d
        }
      }
      words.sort((a, b) => a.start - b.start)
      const cues = cuesOf(words, wordsPerCaptionOf(rows[0]))
      await setCaptionLines(rows[0].track.id, cues, job.lang)
      const rest = rows.slice(1).flatMap((row) => row.lines.map((c) => c.id))
      if (rest.length) await engine.call('timeline.delete', { clipIds: rest })
      captions = cues.length
    } else
      for (const row of rows) {
        const cues = row.lines.map((c) => ({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text: picked(`c:${c.id}`) ? tr.get(`c:${c.id}`)! : (c.text?.content ?? ''), posX: c.posX ?? 0, posY: c.posY ?? 0, scale: c.scale ?? 100, rotation: c.rotation ?? 0 }))
        await setCaptionLines(row.track.id, cues, job.lang)
        captions += cues.filter((_, i) => picked(`c:${row.lines[i].id}`)).length
      }

    // The voice: each sentence's old sound out, the new one in at its moment. A clip that was one
    // sentence goes; a voiceover heard sentence by sentence (`v:<clip>~<n>`) goes whole when every
    // sentence is spoken again, else just the stretches that are.
    const lines = r.voice ?? []
    if (lines.length) {
      const before = await latest()
      const clipOf = (id: string) => id.slice(2).replace(/~\d+$/, '')
      const whole: string[] = []
      for (const cid of new Set(lines.map((l) => clipOf(l.id)))) {
        if (!findClip(before, cid)) continue
        const all = r.items.filter((i) => i.kind === 'line' && clipOf(i.id) === cid)
        const again = all.filter((i) => lines.some((l) => l.id === i.id))
        if (again.length >= all.length) whole.push(cid, ...all.flatMap((i) => i.pieces ?? []).filter((x) => findClip(before, x)))
        else await cutOut(cid, again.map((i) => [i.startUs, i.endUs]))
      }
      if (whole.length) await engine.call('timeline.delete', { clipIds: whole })
      const now = await latest()
      // Lines already on it (an earlier try that stopped part way) aren't put on twice.
      const placed = new Set((now?.project.tracks ?? []).flatMap((t) => t.clips).map((c) => norm(mediaById(now, c.mediaId)?.path ?? '')))
      const todo = lines.filter((l) => !placed.has(norm(l.file)))
      const imp = todo.length ? await engine.call('media.import', { paths: todo.map((l) => l.file) }) : { imported: [] }
      if (imp.failed?.length || imp.imported?.length !== todo.length) throw new Error(imp.failed?.[0]?.error ?? 'the new voice couldn’t be imported')
      for (const [k, l] of todo.entries()) await engine.call('timeline.insert', { mediaId: imp.imported[k], atUs: l.atUs })
    }

    await window.studio.services.translateApplied(job.id)
    const what = [texts ? `${texts} text${texts === 1 ? '' : 's'}` : '', captions ? `${captions} caption line${captions === 1 ? '' : 's'}` : '', lines.length ? `${lines.length} sentence${lines.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
    toast(`${what ? what.replace(/^./, (c) => c.toUpperCase()) : 'Nothing'} in ${trLangName(job.lang)}. Each is its own clip you can change.${gone.length ? ` ${gone.length} text${gone.length === 1 ? ' was' : 's were'} no longer here.` : ''}${job.notes?.length ? ` Note: ${job.notes.join(' ')}` : ''}`)
  } catch (e) {
    await window.studio.services.translateFailed(job.id, `It couldn’t go on the timeline: ${(e as Error).message}`)
  } finally {
    applying.delete(job.id)
  }
}

/** Takes stretches [a, b) of the timeline out of a sound clip: split at each edge, the piece between deleted. */
async function cutOut(clipId: string, ranges: [number, number][]) {
  const engine = window.studio.engine
  const first = findClip(await latest(), clipId)
  if (!first) return
  const { track, clip } = first
  // The piece of the clip's sound playing at `t` now (pieces keep the clip's file and track).
  const at = async (t: number) => (await latest())?.project.tracks.find((x) => x.id === track.id)?.clips.find((c) => c.mediaId === clip.mediaId && c.startUs <= t + 1_000 && t < c.startUs + c.durationUs - 1_000)
  for (const [a, b] of ranges) {
    const p = await at(a)
    if (!p) continue
    if (a > p.startUs + 1_000) await engine.call('timeline.split', { atUs: a, clipIds: [p.id] })
    const q = await at(a)
    if (q && b < q.startUs + q.durationUs - 1_000) await engine.call('timeline.split', { atUs: b, clipIds: [q.id] })
    const gone = await at(a)
    if (gone) await engine.call('timeline.delete', { clipIds: [gone.id] })
  }
}

/** Home's line for a project's translations: as the source ("Translating into…") or as a copy. Null with nothing to say. */
export function translationStatus(dir: string, list: TrJob[] | undefined): { text: string; tone: 'busy' | 'wait' | 'fail' } | null {
  if (!list?.length) return null
  const own = list.find((j) => same(j.project, dir))
  if (own) {
    const into = trLangName(own.lang)
    if (own.state === 'review') return { text: `${into} translation: waiting for the review in ${own.name.replace(/ · [^·]+$/, '')}`, tone: 'wait' }
    if (trRunning(own)) return { text: `Translating into ${into} · ${Math.round(own.fraction * 100)} % · ${own.needsClaude ? 'waiting for Claude Code' : own.stage}`, tone: 'busy' }
    if (own.state === 'ready') return { text: `${into} translation ready: goes on the timeline when you open it`, tone: 'wait' }
    if (own.state === 'failed') return { text: `${into} translation stopped: ${own.reason ?? 'unknown error'}`, tone: 'fail' }
    return null
  }
  const mine = list.filter((j) => same(j.source, dir))
  const names = (js: TrJob[]) => js.map((j) => trLangName(j.lang)).join(', ')
  const review = mine.filter((j) => j.state === 'review')
  if (review.length) return { text: `Translations into ${names(review)}: ready for your review`, tone: 'wait' }
  const running = mine.filter((j) => trRunning(j))
  if (running.length) return { text: `Translating into ${names(running)} · ${Math.round((running.reduce((a, j) => a + j.fraction, 0) / running.length) * 100)} %`, tone: 'busy' }
  const failed = mine.filter((j) => j.state === 'failed')
  if (failed.length) return { text: `Translation into ${names(failed)} stopped: ${failed[0].reason ?? 'unknown error'}`, tone: 'fail' }
  return null
}

/** Follows translations: every change, and a project's own whenever it's opened. */
export function initTranslate() {
  window.studio.services.onTranslateJob((j) => onTranslateJob(j))
  Object.assign((window as unknown as { __studio: object }).__studio ?? {}, { startTranslation, goTranslation, collectTranslation: async () => collect((await latest())!) })
  let jobsFor = ''
  subscribe(() => {
    const s = getState()
    const dir = s.link === 'connected' && s.snap ? s.snap.dir : ''
    if (dir === jobsFor) return
    jobsFor = dir
    setJobs({})
    if (!dir) return
    window.studio.services.translateJobs(dir).then((list) => {
      if (!getState().snap || !same(getState().snap!.dir, dir)) return
      for (const j of list) onTranslateJob(j, true)
    })
  })
}
