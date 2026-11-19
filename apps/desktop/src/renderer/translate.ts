// Translations on the page: collecting what the timeline says (text clips, caption lines and the
// sentences a known voice speaks), starting one job per language (src/main/translate.ts),
// following them, and putting a finished language on its own project's timeline when that
// project is open: every text clip says the translation in its own look and place (a little
// smaller if it no longer fits), the captions are made again in the new language (from the new
// voice's words, or line by line where they are), and each sentence's sound clip is swapped for
// the new one at its moment.

import { useSyncExternalStore } from 'react'
import { TR_LANGS, trLangName, trRunning, type TrClonePart, type TrItem, type TrJob, type TrStems, type TrVoice, type TrVoiceChoice } from '../shared/translate'
import type { TrSound } from '../shared/api'
import { playedPart } from '../shared/speech-timing'
import { captionTracks, cuesOf, setCaptionLines, wordsPerCaptionOf } from './captions'
import { loadFont } from './textFonts'
import { fontOf, layoutText, renderTextClip, textPlaceOf, type TextLook } from './textRender'
import { findClip, getState, mediaById, openProjectAt, projectChanged, projectScope, subscribeStore as subscribe, toast, type Clip, type ProjectScope, type Snapshot } from './store'

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

/** A sound's language as Studio's two letters ("sv", or "Swedish" → "sv"). */
const langCode = (x: string) => {
  const l = x.trim().toLowerCase()
  return TR_LANGS.find((t) => t.code === l || t.name.toLowerCase() === l || t.own.toLowerCase() === l)?.code ?? l.slice(0, 2)
}
/** A clip's sound at this volume or under isn't heard (CapCut's mute comes over as −60 dB). */
const HEARD = 0.01

/**
 * Everything the project says, in time order: text clips (not stickers, which have no letters),
 * caption lines, and everything spoken: sound clips Studio knows the words of (a dub's sentence,
 * a voiceover with its script), and sounds heard sentence by sentence (a voiceover Studio didn't
 * make, a video clip's own sound). `from` is the project's language: its dub's, else its
 * captions', else none. Speech heard in another language than that (else `lang`, the one picked
 * to translate from) is left out (a song on a clip, an English voiceover in a Swedish ad) and
 * listed in `other`.
 * The sentences are grouped by the voice that speaks them (`voices`, one row each in the tab),
 * and each gets that voice as it's picked in the tab, else as it's found: an ElevenLabs voice
 * Studio knows; the dub's clone, made again from the dub's sample; else a clone of it made from
 * its own sentences (deleted after). `sources`: the sounds with speech on each track, to clone a
 * voice from instead.
 */
export async function collect(snap: Snapshot, lang?: string) {
  const p = snap.project
  const sounds = p.tracks.filter((t) => t.kind === 'audio' && !t.mute).flatMap((t) => t.clips)
  // Video clips whose own sound plays (not turned off, not silent): someone may speak in it.
  const own = p.tracks
    .filter((t) => t.kind === 'video' && !t.mute)
    .flatMap((t) => t.clips)
    .filter((c) => {
      const m = mediaById(snap, c.mediaId)
      return m?.kind === 'video' && m.hasAudio && !c.detached && c.volume > HEARD
    })
  const ownIds = new Set(own.map((c) => c.id))
  const trackOf = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, t.id] as const)))
  const paths = [...new Set([...sounds, ...own].map((c) => mediaById(snap, c.mediaId)?.path).filter((x): x is string => !!x))]
  // The stretch of each file the clips play (in its own time), for taking its voice out of the music.
  const played = new Map<string, [number, number]>()
  for (const c of [...sounds, ...own]) {
    const path = mediaById(snap, c.mediaId)?.path
    if (!path) continue
    const a = c.inUs
    const b = c.inUs + c.durationUs * (c.speed || 1)
    const r = played.get(path)
    played.set(path, r ? [Math.min(r[0], a), Math.max(r[1], b)] : [a, b])
  }
  const other: { name: string; language: string }[] = []
  const ctx = await window.studio.services.translateContext(snap.dir, paths)
  if ('error' in ctx) throw new Error(ctx.error)
  // Files picked to clone a voice from, as they were heard.
  const picked = [...new Set(Object.values(ctx.choices ?? {}).flatMap((c) => (c.use === 'clone' && c.from.startsWith('file:') ? [c.from.slice(5)] : [])))].filter((f) => !paths.includes(f))
  if (picked.length) {
    const more = await window.studio.services.translateContext(snap.dir, picked)
    if (!('error' in more)) Object.assign(ctx.sounds, more.sounds)
  }
  const choices = ctx.choices ?? {}
  const from = ctx.lang || (captionTracks(snap).find((t) => t.lang)?.lang ?? '')
  const said = from || lang
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
  const groups = new Map<string, Group>()
  const keyOf = new Map<TrItem, string>()
  const onTrack = new Map<string, Map<string, TrClonePart>>()
  /** A stretch of a file (seconds into it) that speaks, kept for cloning from: by file. */
  const addPart = (to: Map<string, TrClonePart>, base: Omit<TrClonePart, 'spans'>, span: { start: number; end: number }) => {
    const x = to.get(base.path) ?? { ...base, spans: [] }
    if (!x.spans.some((q) => Math.abs(q.start - span.start) < 0.01 && Math.abs(q.end - span.end) < 0.01)) x.spans.push(span)
    to.set(base.path, x)
  }
  /** A sentence of a voice: grouped by the voice it was found to be, else by its own sound. */
  const addLine = (it: TrItem, s: TrSound, m: { path: string; name: string }, clipId: string, base: Omit<TrClonePart, 'spans'>, span: { start: number; end: number }, more: Partial<Group>) => {
    const k = s.voiceId || `clone:${m.path}`
    const g = groups.get(k) ?? { key: k, files: [], sentences: 0, parts: new Map(), title: s.name ?? stem(m.name), ...(s.voiceId && !s.clone ? { known: { voiceId: s.voiceId, model: s.model ?? 'eleven_v4', speed: s.speed ?? 1, name: s.name ?? 'The voice' } } : {}), ...(s.clone?.sample ? { dub: { sample: s.clone.sample, name: s.clone.name, model: s.model ?? 'eleven_v4', speed: s.speed ?? 1, translation: !!s.clone.translation } } : {}), cloneName: s.clone?.name ?? stem(m.name), ...more }
    if (!g.files.includes(m.name)) g.files.push(m.name)
    g.sentences++
    g.mixed ||= !!base.mixed
    g.clip ||= ownIds.has(clipId)
    addPart(g.parts, base, span)
    const tr = trackOf.get(clipId)
    if (tr) {
      if (!onTrack.has(tr)) onTrack.set(tr, new Map())
      addPart(onTrack.get(tr)!, base, span)
    }
    groups.set(k, g)
    keyOf.set(it, k)
    items.push(it)
  }
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
  for (const c of [...sounds, ...own]) {
    const m = mediaById(snap, c.mediaId)
    const s = ctx.sounds[m?.path ?? '']
    // A sound Studio didn't make, as it was heard: a line for each sentence, where it's said.
    if (m && s?.read) {
      if (!s.read.sentences.length) continue
      // Another language's speech is left as it is (a song, an English line in a Swedish ad), but
      // not the language a translation's copy was made from (what's still in it is left over),
      // nor a guess from under 3 s of speech (a Swedish "Testa nu!" can come back as Danish).
      const language = s.read.language ? langCode(s.read.language) : ''
      const brief = s.read.sentences.reduce((n, x) => n + x.end - x.start, 0) < 3
      if (said && language && language !== said && language !== (ctx.was ? langCode(ctx.was) : '') && !brief) {
        if (!other.some((o) => o.name === m.name)) other.push({ name: m.name, language })
        continue
      }
      const mixed = !!s.read.mixed
      const [fromUs, toUs] = played.get(m.path) ?? [0, m.durationUs]
      const base = { path: m.path, mediaId: m.id, clipId: c.id, mixed, fromUs, spanUs: toUs - fromUs }
      for (const [n, sn] of s.read.sentences.entries()) {
        const part = playedPart(c, sn)
        if (!part) continue
        const it: TrItem = { id: `v:${c.id}~${n}`, kind: 'line', text: part.text, startUs: part.at[0], endUs: part.at[1], heard: { path: m.path, mediaId: m.id, start: part.start, end: part.end, mixed, fromUs, spanUs: toUs - fromUs } }
        // Two or more voices in the file (a dialogue): each sentence goes with the voice that said it.
        const said = sn.voice ? { ...s, voiceId: sn.voice.voiceId, name: sn.voice.name, model: sn.voice.model, speed: sn.voice.speed } : s
        addLine(it, said, m, c.id, base, { start: part.start, end: part.end }, { how: said.voiceId ? (sn.voice ? 'history' : s.read.how) : undefined, note: s.read.note, keptOld: s.read.note === 'kept' })
      }
      continue
    }
    if (m && !s && maybeVoice(m, ownIds.has(c.id))) unread.add(m.path)
    if (ownIds.has(c.id) || !s?.text || !letters.test(s.text)) continue
    const run = runs.get(c.id)
    if (!run || !m) continue
    const last = run[run.length - 1]
    // A dub's sentence or a voiceover with its script: one line, from its first piece to its last.
    const span = { start: run[0].inUs / 1e6, end: (last.inUs + last.durationUs * (last.speed || 1)) / 1e6 }
    const it: TrItem = {
      id: `v:${c.id}`,
      kind: 'line',
      text: s.text,
      ...(s.original ? { original: s.original } : {}),
      startUs: c.startUs,
      endUs: last.startUs + last.durationUs,
      ...(run.length > 1 ? { pieces: run.slice(1).map((x) => x.id) } : {}),
      ...(!s.voiceId ? { heard: { path: m.path, mediaId: m.id, ...span, mixed: false, fromUs: run[0].inUs, spanUs: (span.end - span.start) * 1e6 } } : {}),
    }
    addLine(it, s, m, c.id, { path: m.path, mediaId: m.id, clipId: c.id }, span, { how: s.voiceId && !s.clone ? 'studio' : undefined })
  }
  // Each voice as it's picked, else as it's found.
  const voices: TrVoiceRow[] = []
  for (const g of groups.values()) {
    const ch = choices[g.key]
    const file = ch?.use === 'clone' && ch.from.startsWith('file:') ? ch.from.slice(5) : ''
    const read = file ? ctx.sounds[file]?.read : undefined
    // A picked track or file that no longer speaks (gone, moved, emptied) falls back to its own sound.
    const usable = (f: string) => f === 'auto' || (f.startsWith('track:') && onTrack.has(f.slice(6))) || (f === `file:${file}` && !!read?.sentences.length)
    const choice: TrVoiceChoice = ch ? (ch.use === 'clone' && !usable(ch.from) ? { ...ch, from: 'auto' } : ch) : g.keptOld ? { use: 'keep' } : g.known ? { use: 'voice', voiceId: g.known.voiceId, name: g.known.name } : { use: 'clone', from: 'auto', keep: false }
    let voice: TrItem['voice'] | undefined
    if (choice.use === 'voice') voice = g.known?.voiceId === choice.voiceId ? g.known : { voiceId: choice.voiceId, model: 'eleven_v4', speed: 1, name: choice.name }
    else if (choice.use === 'clone') {
      const sample = choice.from === 'auto' && g.dub ? g.dub.sample : ''
      const parts = sample ? undefined : choice.from === 'auto' ? [...g.parts.values()] : choice.from.startsWith('track:') ? [...onTrack.get(choice.from.slice(6))!.values()] : [{ path: file, spans: read!.sentences.map((x) => ({ start: x.start, end: x.end })), mixed: !!read!.mixed }]
      const like = g.dub ?? g.known
      voice = { voiceId: g.key.startsWith('clone:') ? g.key : `clone:${g.key}`, model: like?.model ?? 'eleven_v4', speed: like?.speed ?? 1, name: g.dub ? g.title : `${g.title} (cloned)`, clone: { sample, name: g.cloneName, ...(parts ? { parts } : {}), keep: choice.keep, key: g.key } }
    }
    for (const [it, k] of keyOf) if (k === g.key && voice) it.voice = voice
    voices.push({ key: g.key, title: g.title, where: filesLabel(g.files), paths: [...g.parts.keys()], sentences: g.sentences, choice, chosen: !!ch, voice, known: g.known ? { voiceId: g.known.voiceId, name: g.known.name } : undefined, dub: !!g.dub && !g.dub.translation, before: !!g.dub?.translation, how: g.how, note: g.note, clip: g.clip, mixed: g.mixed, file: file && choice.use === 'clone' && choice.from === `file:${file}` ? file : undefined })
  }
  const sources = [...onTrack.entries()].map(([id, parts]) => {
    const t = p.tracks.find((x) => x.id === id)
    const names = [...new Set([...parts.values()].map((x) => mediaById(snap, x.mediaId ?? '')?.name ?? x.path.split(/[\\/]/).pop()!))]
    return { id: `track:${id}`, label: `${filesLabel(names)}${t?.kind === 'video' ? ' (the clip’s own sound)' : ''}`, paths: [...parts.keys()] }
  })
  items.sort((a, b) => a.startUs - b.startUs || a.kind.localeCompare(b.kind))
  return { items, from, durationUs: snap.durationUs, voices, sources, unread: [...unread], other }
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '')
/** Files by name: "voiceover.wav", or "line-L01.wav + 8 more". */
const filesLabel = (names: string[]) => (names.length > 1 ? `${names[0]} + ${names.length - 1} more` : (names[0] ?? ''))

/** The sentences one voice speaks, as `collect` gathers them. */
type Group = {
  key: string
  title: string
  files: string[]
  sentences: number
  /** Their stretches of sound, by file: what the voice is cloned from by default. */
  parts: Map<string, TrClonePart>
  cloneName: string
  /** An ElevenLabs voice Studio knows speaks it. */
  known?: NonNullable<TrItem['voice']>
  /** The dub's clone, not kept in the account: made again from the dub's sample (or the sample an earlier translation cloned it from, `translation`). */
  dub?: { sample: string; name: string; model: string; speed: number; translation: boolean }
  how?: VoiceHow
  note?: string
  /** Set to keep its own sound in an earlier Studio. */
  keptOld?: boolean
  clip?: boolean
  mixed?: boolean
}

/**
 * A voice in the project, as the Translations tab shows it: where it speaks (`where`), what
 * speaks it in the translation (`choice`, picked in the tab when `chosen`, else as found) and
 * the voice that comes to (`voice`; none: its old sound stays). `paths`: the files it speaks in. `known`: the ElevenLabs voice
 * found for it (`how`), else `note` says why none was; `dub`: the dub's clone, made again from
 * the dub's sample (`before`: the sample a translation cloned it from); `clip`: a video clip's own sound; `mixed`: its voice is over music; `file`:
 * the file picked to clone it from.
 */
export type TrVoiceRow = { key: string; title: string; where: string; paths: string[]; sentences: number; choice: TrVoiceChoice; chosen: boolean; voice?: TrItem['voice']; known?: { voiceId: string; name: string }; dub: boolean; before: boolean; how?: VoiceHow; note?: string; clip?: boolean; mixed?: boolean; file?: string }
/** How a voice was found: made in Studio, the ElevenLabs history, the file's name, picked in an earlier Studio. */
type VoiceHow = 'studio' | 'history' | 'name' | 'picked'

/**
 * A sound worth hearing for speech: long enough to say something, and (a sound file) not named as
 * music or effects. A video clip's name says nothing about its sound ("#music" in a TikTok's).
 */
const maybeVoice = (m: { name: string; durationUs?: number }, clip = false) => (m.durationUs ?? 0) >= 500_000 && (m.durationUs ?? 0) <= 600_000_000 && (clip || !/instrument|music|musik|song|beat|bgm|soundtrack|ambien|sfx|effect/i.test(m.name))

/** Hears a voiceover once (what it says, which voice speaks it). */
export const readVoiceover = (project: string, file: string) => window.studio.services.translateReadVoice(project, file)
/** What speaks a voice in the translations (null: the one found). */
export const chooseVoice = (project: string, key: string, choice: TrVoiceChoice | null) => window.studio.services.translateChooseVoice(project, key, choice)

/** Starts a translation of the open project into `langs`, one copy each. */
export async function startTranslation(o: { langs: string[]; voice: TrVoice; from: string }) {
  const snap = await latest()
  if (!snap) return
  try {
    const { items, durationUs } = await collect(snap, o.from)
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
  // Start's answer can come after the job has moved on (its updates come another way): the newer one stays.
  if ((jobs[job.id]?.rev ?? 0) > (job.rev ?? 0)) return
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
  // For the copy only: if another project is opened while it's put on, it stops there (the
  // engine refuses the rest) and goes on again the next time the copy is opened.
  const scope = projectScope(job.project)
  try {
    if (!scope.live()) return
    const r = await window.studio.services.translateResult(job.id)
    if ('error' in r) throw new Error(r.error)
    const engine = { call: scope.engine }
    const snap = await scope.latest()
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
      const look = await renderTextClip(spec, `tr-${clip.id}`, place, { dir: job.project, width: p.width, height: p.height })
      await engine.call('text.set', { clipId: clip.id, text: look, gesture: `translate ${job.id}` })
      await engine.call('clip.set', { clipId: clip.id, label: look.content.split('\n')[0].slice(0, 40) }).catch(() => {})
      texts++
    }

    // Captions in the project's language: made again from the new voice's words, or line by line.
    const rows = captionTracks(await scope.latest()).filter((t) => !job.from || !t.lang || t.lang === job.from)
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
      await setCaptionLines(rows[0].track.id, cues, job.lang, scope)
      const rest = rows.slice(1).flatMap((row) => row.lines.map((c) => c.id))
      if (rest.length) await engine.call('timeline.delete', { clipIds: rest })
      captions = cues.length
    } else
      for (const row of rows) {
        const cues = row.lines.map((c) => ({ startUs: c.startUs, endUs: c.startUs + c.durationUs, text: picked(`c:${c.id}`) ? tr.get(`c:${c.id}`)! : (c.text?.content ?? ''), posX: c.posX ?? 0, posY: c.posY ?? 0, scale: c.scale ?? 100, rotation: c.rotation ?? 0 }))
        await setCaptionLines(row.track.id, cues, job.lang, scope)
        captions += cues.filter((_, i) => picked(`c:${row.lines[i].id}`)).length
      }

    // The voice: each sentence's old sound out, the new one in at its moment. A clip that was one
    // sentence goes; a voiceover heard sentence by sentence (`v:<clip>~<n>`) goes whole when every
    // sentence is spoken again, else just the stretches that are. A voice that was over music
    // (taken out of it by the stems server) leaves the music: the clip plays the rest of its sound
    // and its voice from the separation, its own sound off, and the voice goes where the new one
    // speaks. A video clip's own voice on its own is taken off the clip first (Extract audio).
    const lines = r.voice ?? []
    if (lines.length) {
      const before = await scope.latest()
      const clipOf = (id: string) => id.slice(2).replace(/~\d+$/, '')
      const whole: string[] = []
      const imported = new Map<string, string>()
      const media = async (paths: string[]) => {
        const todo = paths.filter((x) => !imported.has(x))
        if (todo.length) {
          const imp = await engine.call('media.import', { paths: todo })
          if (imp.failed?.length || imp.imported?.length !== todo.length) throw new Error(imp.failed?.[0]?.error ?? 'the separated sound couldn’t be imported')
          todo.forEach((x, k) => imported.set(x, imp.imported[k]))
        }
        return paths.map((x) => imported.get(x)!)
      }
      for (const cid of new Set(lines.map((l) => clipOf(l.id)))) {
        const found = findClip(before, cid)
        if (!found) continue
        const all = r.items.filter((i) => i.kind === 'line' && clipOf(i.id) === cid)
        const again = all.filter((i) => lines.some((l) => l.id === i.id))
        const ranges = again.map((i) => [i.startUs, i.endUs] as [number, number])
        const every = again.length >= all.length
        const sep: TrStems | undefined = r.stems?.[all.find((i) => i.heard)?.heard?.path ?? '']
        if (sep) {
          const [voice, ...bed] = await media([sep.voice ?? '', ...sep.bed].filter(Boolean)).then((ids) => (sep.voice ? ids : ['', ...ids]))
          for (const id of [cid, ...all.flatMap((i) => i.pieces ?? []).filter((x) => findClip(before, x))]) {
            const made = (await engine.call('timeline.addStems', { clipId: id, stems: [...bed.map((mediaId) => ({ mediaId, role: 'music' })), ...(voice ? [{ mediaId: voice, role: 'voice' }] : [])], fromUs: sep.fromUs, replace: true })) as { clipIds: string[] }
            const v = voice ? made.clipIds[made.clipIds.length - 1] : ''
            if (v && every) whole.push(v)
            else if (v) await cutOut(scope, v, ranges)
          }
        } else if (found.track.kind === 'video') {
          const ex = (await engine.call('clip.extractAudio', { clipIds: [cid] })) as { clipIds: string[] }
          for (const a of ex.clipIds ?? []) {
            if (every) whole.push(a)
            else await cutOut(scope, a, ranges)
          }
        } else if (every) whole.push(cid, ...all.flatMap((i) => i.pieces ?? []).filter((x) => findClip(before, x)))
        else await cutOut(scope, cid, ranges)
      }
      if (whole.length) await engine.call('timeline.delete', { clipIds: whole })
      const now = await scope.latest()
      // Lines already on it (an earlier try that stopped part way) aren't put on twice.
      const placed = new Set((now?.project.tracks ?? []).flatMap((t) => t.clips).map((c) => norm(mediaById(now, c.mediaId)?.path ?? '')))
      const todo = lines.filter((l) => !placed.has(norm(l.file)))
      const imp = todo.length ? await engine.call('media.import', { paths: todo.map((l) => l.file) }) : { imported: [] }
      if (imp.failed?.length || imp.imported?.length !== todo.length) throw new Error(imp.failed?.[0]?.error ?? 'the new voice couldn’t be imported')
      // The new voice on one sound track of its own (it used to go wherever there was room, so a
      // track looked full of gaps that weren't there and sentences got dragged across).
      let track = ''
      for (const [k, l] of todo.entries()) {
        const put = (await engine.call('timeline.insert', { mediaId: imp.imported[k], atUs: l.atUs, ...(track ? { trackId: track } : { newTrack: true }) })) as { trackId: string }
        track ||= put.trackId
      }
    }

    await window.studio.services.translateApplied(job.id)
    const what = [texts ? `${texts} text${texts === 1 ? '' : 's'}` : '', captions ? `${captions} caption line${captions === 1 ? '' : 's'}` : '', lines.length ? `${lines.length} sentence${lines.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
    toast(`${what ? what.replace(/^./, (c) => c.toUpperCase()) : 'Nothing'} in ${trLangName(job.lang)}. Each is its own clip you can change.${gone.length ? ` ${gone.length} text${gone.length === 1 ? ' was' : 's were'} no longer here.` : ''}${job.notes?.length ? ` Note: ${job.notes.join(' ')}` : ''}`)
  } catch (e) {
    if (projectChanged(e)) return
    await window.studio.services.translateFailed(job.id, `It couldn’t go on the timeline: ${(e as Error).message}`)
  } finally {
    applying.delete(job.id)
  }
}

/** Takes stretches [a, b) of the timeline out of a sound clip: split at each edge, the piece between deleted. */
async function cutOut(scope: ProjectScope, clipId: string, ranges: [number, number][]) {
  const engine = { call: scope.engine }
  const latest = scope.latest
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
