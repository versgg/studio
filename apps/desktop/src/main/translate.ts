// Translations: a finished project made again in other languages, one project per language.
// The Translations tab collects what the timeline says (text clips, caption lines, spoken
// sentences with the voice that said them) and starts one job per language; each job:
//   1. copies the project ("Spring promo · Svenska" → "Spring promo · Norsk"), with every file it
//      uses from inside the project folder (the dub's clean picture, the voice lines) copied or
//      hard-linked into the copy, so deleting or moving the original never breaks it;
//   2. has Claude translate it all as one piece, with a back-translation       → translation.json
//   3. waits for the review (the languages started together are reviewed together); nothing
//      paid has run yet;
//   4. with "Same voice": a voice over music (a clip's own sound) is taken out of it first by
//      the stems server, so the music stays under the new voice                → stems.json
//      each voice is the one picked in the Translations tab (kept in the project's
//      translation-voices.json), else the one found: an ElevenLabs voice, or a clone made for the
//      takes from the dub's sample, its own sentences, or a sound or file picked to clone from,
//      deleted after unless it's kept (then made once for the languages started together, and
//      that voice speaks it from then on); then each voice speaks its sentences in the new
//      language as one take, cut into sentences and fitted to their moments as a dub does
//      (dub-voice.ts), up to three takes                                     → voice.json
//   5. is ready: the page puts it on the copy's timeline when that project is open.
// Jobs live in their copy (`<copy>.studio/translation/job.json`); userData's
// translation-jobs.json lists them, so the source project and Home find them.

import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { trProjectName, trRunning, type TrItem, type TrJob, type TrLine, type TrText, type TrVoice, type TrVoiceChoice } from '../shared/translate'
import { ClaudeSignedOut, translateSpeech } from './dub-read'
import { CPS, FAKE as ELEVEN_FAKE, cloneFrom, cutSample, cutTake, fitLines, iso2, removeClone, retime, speakTake, type Spoken } from './dub-voice'
import { ffmpeg } from './ffmpeg'
import { ElevenLabs } from './elevenlabs'
import { getSecret } from './secrets'
import { budgets, translateItems } from './translate-read'
import { knownVoice } from './voice-read'
import * as stems from './stems'
import { MAX_SECONDS, voiceAndBed } from '../shared/stems'
import type { TrSound } from '../shared/api'
import type { TrStems } from '../shared/translate'

const jobs = new Map<string, TrJob>()
const live = new Map<string, AbortController>()

const key = (p: string) => path.resolve(p).toLowerCase()
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const eleven = () => (ELEVEN_FAKE ? null : new ElevenLabs(getSecret('elevenlabs') ?? ''))

function send(job: TrJob) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('translate:job', job)
}

function save(job: TrJob) {
  fs.mkdirSync(job.dir, { recursive: true })
  fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(job, null, 1))
}

function patch(job: TrJob, p: Partial<TrJob>) {
  if (jobs.get(job.id) !== job) return
  Object.assign(job, p)
  job.rev = (job.rev ?? 0) + 1
  try {
    save(job)
  } catch {}
  send(job)
}

// The list of jobs, in userData.

const indexFile = () => path.join(app.getPath('userData'), 'translation-jobs.json')
let indexed = false

function readIndex(): string[] {
  try {
    return readJson<string[]>(indexFile()).filter((f) => typeof f === 'string')
  } catch {
    return []
  }
}

function addToIndex(file: string) {
  const all = readIndex().filter((f) => fs.existsSync(f) && key(f) !== key(file))
  fs.writeFileSync(indexFile(), JSON.stringify([...all, file], null, 1))
}

/** Every job listed, read once; one left running when Studio closed carries on (a review waits). */
function loadAll() {
  if (indexed) return
  indexed = true
  for (const f of readIndex()) {
    try {
      const j = readJson<TrJob>(f)
      if (jobs.has(j.id)) continue
      jobs.set(j.id, j)
      if (trRunning(j) && j.state !== 'review') void run(j)
    } catch {}
  }
}

// Copying the project.

const insideOf = (dir: string) => {
  const d = path.resolve(dir) + path.sep
  return (p: string) => (process.platform === 'win32' ? p.toLowerCase().startsWith(d.toLowerCase()) : p.startsWith(d))
}

/** A file into the copy: big media hard-linked (no room taken), the rest copied (they may be rewritten). */
function place(from: string, to: string) {
  if (fs.existsSync(to)) return
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.statSync(from).size > 512 * 1024)
    try {
      fs.linkSync(from, to)
      return
    } catch {}
  fs.copyFileSync(from, to)
}

/** The folder a project copy goes in: "Name.studio", else "Name 2.studio" and on. */
export function freeDir(parent: string, name: string) {
  const clean = name.replace(/[<>:"/\\|?*]/g, '-').trim() || 'Untitled'
  for (let n = 1; ; n++) {
    const dir = path.join(parent, `${clean}${n > 1 ? ` ${n}` : ''}.studio`)
    if (!fs.existsSync(dir)) return dir
  }
}

/**
 * The project copied into `to` under `name`: project.json with every path inside the source
 * folder pointing into the copy, each such file (and a voiceover's script and voice beside it)
 * copied or hard-linked there, and the caches hard-linked. Its history starts fresh.
 */
/**
 * Every path in `v` to a file inside the folder `from`, as the same file inside `to`: hard-linked
 * (or copied) over there the first time, with a voiceover's script and voice beside it.
 */
export function relocate<T>(v: T, from: string, to: string): T {
  const inside = insideOf(from)
  const moved = (s: string) => path.join(to, path.relative(from, s))
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!inside(v) || !fs.existsSync(v) || !fs.statSync(v).isFile()) return v
      place(v, moved(v))
      for (const side of ['.script.txt', '.voice.json']) {
        const f = v.replace(/\.[^.\\/]+$/, '') + side
        if (fs.existsSync(f)) place(f, moved(f))
      }
      return moved(v)
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(v) as T
}

export function copyProject(from: string, to: string, name: string) {
  const p = readJson<Record<string, unknown>>(path.join(from, 'project.json'))
  const moved = (s: string) => path.join(to, path.relative(from, s))
  fs.mkdirSync(to, { recursive: true })
  const copy = relocate(p, from, to)
  copy.name = name
  const cache = path.join(from, 'cache')
  const linkAll = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) linkAll(f)
      else
        try {
          const t = moved(f)
          fs.mkdirSync(path.dirname(t), { recursive: true })
          if (!fs.existsSync(t)) fs.linkSync(f, t)
        } catch {}
    }
  }
  if (fs.existsSync(cache)) linkAll(cache)
  // project.json last, so a half-made copy is never taken for a project.
  fs.writeFileSync(path.join(to, 'project.json.tmp'), JSON.stringify(copy, null, 2))
  fs.renameSync(path.join(to, 'project.json.tmp'), path.join(to, 'project.json'))
}

// Starting.

export type TrStart = { source: string; name: string; from: string; langs: string[]; voice: TrVoice; items: TrItem[]; durationUs: number }

/** One job per language, each with its own copy of the project; they start at once. */
export function start(o: TrStart): TrJob[] {
  loadAll()
  if (!fs.existsSync(path.join(o.source, 'project.json'))) throw new Error('That project folder is missing.')
  const langs = [...new Set(o.langs)].filter((l) => l && l !== o.from)
  if (!langs.length) throw new Error('Pick a language to translate into (other than the project’s own).')
  if (!o.items.length) throw new Error('This project has no text, captions or speech to translate.')
  const batch = `b${Date.now().toString(36)}`
  const lines = o.items.filter((i) => i.kind === 'line')
  const out: TrJob[] = []
  for (const lang of langs) {
    const name = trProjectName(o.name, lang)
    const project = freeDir(path.dirname(o.source), name)
    const id = `tr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const dir = path.join(project, 'translation')
    const job: TrJob = { id, batch, source: o.source, project, name, from: o.from, lang, voice: o.voice, captionsFromVoice: o.voice === 'same' && lines.some((l) => l.voice), state: 'copying', stage: 'Copying the project', fraction: 0.01, startedAt: Date.now(), dir }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ durationUs: o.durationUs, items: o.items }, null, 1))
    jobs.set(id, job)
    save(job)
    addToIndex(path.join(dir, 'job.json'))
    send(job)
    out.push(job)
  }
  for (const j of out) void run(j)
  return out
}

/** Claude Code calls at a time (each language is one). */
let claudeRunning = 0
async function claudeTurn(gone: () => boolean) {
  while (claudeRunning >= 3 && !gone()) await sleep(500)
  claudeRunning++
  return () => void claudeRunning--
}

/** Runs (or resumes) a language, skipping every step whose result is already in its folder. */
async function run(job: TrJob) {
  if (live.has(job.id)) return
  const stop = new AbortController()
  live.set(job.id, stop)
  const signal = stop.signal
  const gone = () => signal.aborted || jobs.get(job.id) !== job
  const file = (f: string) => path.join(job.dir, f)
  try {
    const { items, durationUs } = readJson<{ items: TrItem[]; durationUs: number }>(file('items.json'))
    // 1. The copy.
    if (!fs.existsSync(path.join(job.project, 'project.json'))) {
      patch(job, { state: 'copying', stage: 'Copying the project', fraction: 0.02 })
      copyProject(job.source, job.project, job.name)
      patch(job, { copied: fs.statSync(path.join(job.project, 'project.json')).mtimeMs })
    }
    if (gone()) return

    // 2. Claude.
    if (!fs.existsSync(file('translation.json'))) {
      for (;;) {
        patch(job, { state: 'reading', stage: 'Waiting for Claude', fraction: 0.05, needsClaude: false })
        const done = await claudeTurn(gone)
        try {
          if (gone()) return
          patch(job, { stage: 'Claude is translating', fraction: 0.1 })
          const texts = await translateItems(items, { from: job.from, lang: job.lang, endUs: durationUs, captions: !job.captionsFromVoice, speak: job.voice === 'same', signal })
          fs.writeFileSync(file('translation.json'), JSON.stringify({ from: job.from, lang: job.lang, texts }, null, 1))
          break
        } catch (e) {
          if (!(e instanceof ClaudeSignedOut) || gone()) throw e
          patch(job, { stage: (e as Error).message, needsClaude: true })
          while (!gone() && !fs.existsSync(file('translation.json'))) await sleep(2000)
          if (gone()) return
          if (fs.existsSync(file('translation.json'))) break
        } finally {
          done()
        }
      }
    }
    if (gone()) return

    // 3. The review.
    if (!job.picks) return void patch(job, { state: 'review', stage: 'Waiting for the review', fraction: 0.3, needsClaude: false })

    // 4. The voice.
    const texts = readJson<{ texts: TrText[] }>(file('translation.json')).texts
    const said = items.filter((i) => i.kind === 'line' && i.voice && job.picks!.includes(i.id) && texts.some((t) => t.id === i.id))
    const notes: string[] = []
    if (job.voice === 'same' && said.length && !fs.existsSync(file('voice.json'))) {
      const sep = await separate(job, said, gone, notes)
      if (!sep) return
      if (!(await samples(job, said, sep))) return
      // With the samples cut, so a translation of this copy clones from the same one.
      fs.writeFileSync(file('items.json'), JSON.stringify({ durationUs, items }, null, 1))
      const lines = await speak(job, items, texts, said, durationUs, gone, notes)
      if (!lines) return
      fs.writeFileSync(file('voice.json'), JSON.stringify({ lines }, null, 1))
    }
    const unknown = items.filter((i) => i.kind === 'line' && !i.voice).length
    if (job.voice === 'same' && unknown) notes.push(`${unknown} spoken part${unknown === 1 ? ' was' : 's were'} set to keep ${unknown === 1 ? 'its' : 'their'} own sound, so ${unknown === 1 ? 'it stays' : 'they stay'} in the old language.`)
    patch(job, { state: 'ready', stage: 'Ready: goes on its timeline when you open it', fraction: 0.97, notes: [...(job.notes ?? []), ...notes] })
  } catch (e) {
    if (jobs.get(job.id) === job && !signal.aborted) patch(job, { state: 'failed', stage: 'Failed', reason: (e as Error).message })
  } finally {
    if (live.get(job.id) === stop) live.delete(job.id)
  }
}

/**
 * Every sound whose voice is over music, with picked sentences in it, separated by the stems
 * server (once; kept in stems.json, by the file's path): its voice, and the rest of the sound
 * (the bed) that stays under the new voice. One that can't be separated is noted, and its
 * sound is then cut where the new voice speaks, as a voiceover's is.
 */
async function separate(job: TrJob, said: TrItem[], gone: () => boolean, notes: string[]): Promise<Record<string, TrStems | { failed: string }> | null> {
  const file = path.join(job.dir, 'stems.json')
  const done: Record<string, TrStems | { failed: string }> = fs.existsSync(file) ? readJson(file) : {}
  type Part = { clipId: string; mediaId: string; fromUs: number; spanUs: number }
  const todo = new Map<string, Part>()
  // One that failed before is tried again (Try again).
  const want = (src: string, p: Part) => {
    const d = done[src]
    if ((!d || 'failed' in d) && !todo.has(src)) todo.set(src, p)
  }
  for (const i of said) {
    if (i.heard?.mixed) want(i.heard.path, { clipId: i.id.slice(2).replace(/~\d+$/, ''), mediaId: i.heard.mediaId, fromUs: i.heard.fromUs, spanUs: i.heard.spanUs })
    // A sound picked to clone the voice from, when its voice is over music: taken out of it too.
    const c = i.voice?.clone
    if (c && !c.sample) for (const p of c.parts ?? []) if (p.mixed) want(p.path, { clipId: p.clipId ?? '', mediaId: p.mediaId ?? '', fromUs: p.fromUs ?? 0, spanUs: p.spanUs || (await secondsOf(p.path)) * 1e6 })
  }
  let n = 0
  for (const [src, h] of todo) {
    n++
    const name = path.parse(src).name
    try {
      if (h.spanUs / 1e6 > MAX_SECONDS) throw new Error(`the server separates up to ${MAX_SECONDS / 60} minutes and the clips play ${Math.round(h.spanUs / 1e6)} s of it`)
      const sj = stems.start({ project: job.project, clipId: h.clipId, mediaId: h.mediaId, name, source: src, inUs: h.fromUs, spanUs: h.spanUs })
      for (;;) {
        if (gone()) return null
        const now = stems.list(job.project).find((s) => s.dir === sj.dir)
        if (!now) throw new Error('the separation went missing')
        if (now.state === 'done' && now.stems) {
          const vb = voiceAndBed(now.stems)
          done[src] = { ...vb, fromUs: h.fromUs }
          break
        }
        if (now.state === 'failed' || now.state === 'cancelled') throw new Error(now.reason ?? 'the separation stopped')
        patch(job, { state: 'voicing', stage: `Taking the voice out of the music${todo.size > 1 ? ` (${n} of ${todo.size})` : ''}: ${now.stage}`, fraction: 0.32 + (0.03 * (n - 1 + now.fraction)) / todo.size })
        await sleep(1000)
      }
    } catch (e) {
      done[src] = { failed: (e as Error).message }
    }
    fs.writeFileSync(file, JSON.stringify(done, null, 1))
  }
  for (const [src, r] of Object.entries(done)) if ('failed' in r && todo.has(src)) notes.push(`The voice in ${path.basename(src)} couldn’t be taken out of its music (${r.failed}), so its sound is cut where the new voice speaks${said.some((i) => i.heard?.path === src) ? '' : ', and the clone is made from it as it is'}.`)
  return done
}

/** A sound file's length in seconds (0 when it can't be read). */
async function secondsOf(file: string): Promise<number> {
  try {
    return Number(String(await ffmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { tool: 'ffprobe' })).trim()) || 0
  } catch {
    return 0
  }
}

/**
 * The clone samples for voices cloned from a sound (a CapCut voiceover, a clip's own speaker, a
 * track or file picked to clone from): cut from the stretches picked (`parts`), else from the
 * sentences heard in its own sound, from the separated voice where it was over music; kept in
 * this job's folder. A voice cloned from the dub's sample has its sample already.
 */
async function samples(job: TrJob, said: TrItem[], sep: Record<string, TrStems | { failed: string }>): Promise<boolean> {
  const groups = new Map<string, TrItem[]>()
  for (const i of said) if (i.voice?.clone && !i.voice.clone.sample && (i.voice.clone.parts?.length || i.heard)) groups.set(i.voice.voiceId, [...(groups.get(i.voice.voiceId) ?? []), i])
  // Where a stretch of a file is: in its separated voice (which starts at `fromUs` in the file) when there is one.
  const from = (file: string, start: number, end: number, mixed: boolean) => {
    const s = mixed ? sep[file] : undefined
    const stem = s && !('failed' in s) && s.voice ? s : null
    const shift = stem ? stem.fromUs / 1e6 : 0
    return { file: stem?.voice ?? file, start: Math.max(0, start - shift), end: end - shift }
  }
  let n = 0
  for (const [, group] of groups) {
    n++
    const c = group[0].voice!.clone!
    const spans = c.parts?.length ? c.parts.flatMap((p) => p.spans.map((x) => from(p.path, x.start, x.end, !!p.mixed))) : group.map((i) => from(i.heard!.path, i.heard!.start, i.heard!.end, i.heard!.mixed))
    const out = path.join(job.dir, `clone-sample-${n}.mp3`)
    if (!fs.existsSync(out)) await cutSample(spans[0]?.file ?? '', spans.filter((x) => x.end > x.start), out)
    for (const i of group) i.voice!.clone!.sample = out
  }
  return true
}

// The voices picked in the Translations tab, kept in the project by each voice's key.

const choicesFile = (project: string) => path.join(project, 'translation-voices.json')

export function voiceChoices(project: string): Record<string, TrVoiceChoice> {
  try {
    return readJson<Record<string, TrVoiceChoice>>(choicesFile(project))
  } catch {
    return {}
  }
}

/** A voice's choice (null: back to the one found). */
export function chooseVoice(project: string, key: string, choice: TrVoiceChoice | null) {
  const all = voiceChoices(project)
  if (choice) all[key] = choice
  else delete all[key]
  fs.writeFileSync(choicesFile(project), JSON.stringify(all, null, 1))
}

/** Kept clones being made, by batch and voice: the languages started together share one. */
const keeping = new Map<string, Promise<string>>()

/**
 * A clone that stays in the account: made once for the languages started together, and from
 * then on that voice is the one picked for it (so a run that stopped part way, or the next
 * translation, uses it instead of cloning again).
 */
function keptClone(job: TrJob, el: ElevenLabs | null, c: NonNullable<NonNullable<TrItem['voice']>['clone']>): Promise<string> {
  const k = `${job.batch}|${c.key ?? c.sample}`
  let p = keeping.get(k)
  if (!p) {
    p = (async () => {
      const had = c.key ? voiceChoices(job.source)[c.key] : undefined
      if (had?.use === 'voice') return had.voiceId
      const name = `${c.name} (Studio)`
      const id = await cloneFrom(el, c.sample, c.name, name)
      if (c.key) chooseVoice(job.source, c.key, { use: 'voice', voiceId: id, name })
      return id
    })()
    keeping.set(k, p)
    p.catch(() => keeping.delete(k))
  }
  return p
}

/** A file name's safe form of an item id ("v:c12" → "v_c12"). */
const safe = (id: string) => id.replace(/[^\w-]/g, '_')

/**
 * Each voice speaks its sentences in the new language as one take, cut into sentences and
 * fitted to their moments; a take that doesn't fit goes back to Claude as a whole script to
 * be said more simply (at most three takes). Returns every sentence as it'll play.
 */
async function speak(job: TrJob, items: TrItem[], texts: TrText[], said: TrItem[], durationUs: number, gone: () => boolean, notes: string[]): Promise<TrLine[] | null> {
  const el = eleven()
  if (!el && !ELEVEN_FAKE) throw new Error('No ElevenLabs key is saved.')
  const file = (f: string) => path.join(job.dir, f)
  const all = items.filter((i) => i.kind === 'line').sort((a, b) => a.startUs - b.startUs)
  // The sentences as dub-voice.ts places them: seconds on the timeline, by safe id.
  const spoken = all.map((i) => ({ id: safe(i.id), speaker: i.voice?.voiceId ?? '', start: i.startUs / 1e6, end: i.endUs / 1e6, text: i.text, words: [] })) as Spoken[]
  const room = budgets(items, durationUs, job.lang)
  const end = durationUs / 1e6
  const groups = new Map<string, TrItem[]>()
  for (const i of said) groups.set(i.voice!.voiceId, [...(groups.get(i.voice!.voiceId) ?? []), i])
  const out: TrLine[] = []
  let g = 0
  for (const [voiceId, group] of groups) {
    g++
    const v = group[0].voice!
    let script = group.map((i) => ({ id: safe(i.id), item: i, translation: texts.find((t) => t.id === i.id)!.translation }))
    const need = script.reduce((a, l) => a + l.translation.length, 0) / (CPS[job.lang] ?? 14)
    const have = group.reduce((a, i) => a + room.get(i.id)!.seconds, 0)
    const speed = Math.min(1.1, Math.max(0.95, need / Math.max(1, have)))
    let seed = 4242
    let best: { placed: ReturnType<typeof fitLines>['placed']; cut: Awaited<ReturnType<typeof cutTake>>; long: string[]; script: typeof script } | null = null
    // A clone is made from its sample for these takes and deleted after (the user's rule: no clone
    // left behind unless it's kept); a kept one is made once for the languages started together.
    const c = v.clone
    const made = c ? (c.keep ? await keptClone(job, el, c) : await cloneFrom(el, c.sample, c.name)) : ''
    const speakAs = made || voiceId
    try {
      for (let round = 1; round <= 3; round++) {
        if (gone()) return null
        const who = groups.size > 1 ? `${v.name}: ` : ''
        patch(job, { state: 'voicing', stage: `${who}${round === 1 ? 'Speaking the translation in one take' : `Speaking it again, shorter (take ${round})`}`, fraction: 0.35 + (0.55 * (g - 1 + round / 3)) / groups.size })
        const ask = { voiceId: speakAs, lines: script.map((s) => ({ id: s.id, translation: s.translation })), lang: job.lang, model: v.model, seed, speed, out: file(`take-${g}-${round}.mp3`) }
        let take = await speakTake(el, ask)
        // A take in the wrong language (or accent) is spoken again with another seed.
        if (el) {
          const heard = await el.transcribe({ file: take.file, diarize: false })
          if (iso2(heard.language) !== job.lang) {
            seed += 1
            take = await speakTake(el, { ...ask, seed, out: file(`take-${g}-${round}b.mp3`) })
            const again = await el.transcribe({ file: take.file, diarize: false })
            if (iso2(again.language) !== job.lang) notes.push(`A take still sounded like ${again.language}, not ${job.lang}; listen to it.`)
          }
        }
        if (gone()) return null
        const cut = await cutTake(take, script.map((s) => s.id), job.dir, `${g}-${round}`)
        const { placed, long } = fitLines(cut, spoken, end, round < 3 ? 1.08 : 1.12)
        if (!best || long.length < best.long.length) best = { placed, cut, long, script }
        if (!long.length || round === 3) break
        // Too long for their moments: the whole script again, those sentences simpler.
        patch(job, { state: 'reading', stage: `Claude is making ${long.length} sentence${long.length === 1 ? '' : 's'} shorter` })
        const shorter = script.map((s) => {
          const r = room.get(s.item.id)!
          const c = cut.find((x) => x.id === s.id)!
          const now = s.translation.length
          return { id: s.id, heard: s.item.text, seconds: r.seconds, budget: long.includes(s.id) ? Math.max(Math.round(now * 0.7), Math.round((now * r.seconds * 1.05) / c.dur)) : Math.max(r.budget, now) }
        })
        const again = await translateSpeech(shorter, job.lang, { from: job.from, previous: script.map((s) => ({ id: s.id, text: s.item.text, translation: s.translation })) })
        script = script.map((s) => ({ ...s, translation: again.find((a) => a.id === s.id)?.translation ?? s.translation }))
        seed += 7
      }
    } finally {
      if (made && !c?.keep) await removeClone(el, made).catch((e) => notes.push(`The clone made for this translation couldn’t be deleted from ElevenLabs: ${(e as Error).message}`))
    }
    if (c) notes.push(c.keep ? `${v.name.replace(/ \(cloned\)$/, '')} was cloned and kept in your ElevenLabs voices as “${c.name} (Studio)”.` : `${v.name.replace(/ \(cloned\)$/, '')} was cloned for this translation and deleted from ElevenLabs after.`)
    if (best!.long.length) notes.push(`${best!.long.length} sentence${best!.long.length === 1 ? ' runs' : 's run'} a little past ${best!.long.length === 1 ? 'its' : 'their'} moment at 12 % faster.`)
    for (const p of best!.placed) {
      const c = best!.cut.find((x) => x.id === p.id)!
      const s = best!.script.find((x) => x.id === p.id)!
      const f = await retime(c.file, p.tempo, file(`line-${p.id}-fit.wav`))
      out.push({ id: s.item.id, file: f, atUs: Math.round(p.at * 1e6), dur: p.dur, tempo: p.tempo, text: s.translation, words: c.words.map((w) => ({ text: w.text, start: w.start / p.tempo, end: w.end / p.tempo })) })
    }
  }
  return out.sort((a, b) => a.atUs - b.atUs)
}

// The review and after.

/** The review's picks (what's translated; the rest stays as it is) and any translation changed there. */
export function go(id: string, o: { picks: string[]; edits?: Record<string, string> }): TrJob | null {
  const job = jobs.get(id)
  if (!job || job.state !== 'review') return job ?? null
  const f = path.join(job.dir, 'translation.json')
  if (o.edits && Object.keys(o.edits).length && fs.existsSync(f)) {
    const t = readJson<{ texts: TrText[] }>(f)
    for (const x of t.texts) if (o.edits[x.id] != null && o.edits[x.id].trim()) x.translation = o.edits[x.id].trim()
    fs.writeFileSync(f, JSON.stringify(t, null, 1))
  }
  patch(job, { picks: o.picks, state: 'voicing', stage: 'Starting', fraction: 0.32 })
  void run(job)
  return job
}

export function retry(id: string): TrJob | null {
  const job = jobs.get(id)
  if (!job) return null
  live.get(id)?.abort()
  live.delete(id)
  patch(job, { state: job.picks ? 'voicing' : 'reading', stage: 'Starting again', reason: undefined, needsClaude: false })
  void run(job)
  return job
}

/**
 * Stops a language. Its copy goes too while it's still exactly as copied (nothing was put on its
 * timeline and it wasn't edited); else it stays, and the reason says so.
 */
export function cancel(id: string): TrJob | null {
  const job = jobs.get(id)
  if (!job || !trRunning(job)) return job ?? null
  live.get(id)?.abort()
  const pj = path.join(job.project, 'project.json')
  const untouched = !fs.existsSync(pj) || (job.copied != null && Math.abs(fs.statSync(pj).mtimeMs - job.copied) < 1)
  if (untouched) {
    jobs.delete(id)
    try {
      fs.rmSync(job.project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      fs.writeFileSync(indexFile(), JSON.stringify(readIndex().filter((f) => fs.existsSync(f)), null, 1))
    } catch {}
    const gone: TrJob = { ...job, state: 'cancelled', stage: 'Cancelled', reason: 'Translation cancelled; its copy was removed.' }
    send(gone)
    return gone
  }
  patch(job, { state: 'cancelled', stage: 'Cancelled', reason: 'Translation cancelled. Its project copy was changed, so it stays; delete it on Home if you don’t want it.' })
  return job
}

/** The page has put a ready language on its project's timeline. */
export function applied(id: string) {
  const job = jobs.get(id)
  if (job && job.state === 'ready') patch(job, { state: 'applied', stage: 'On its timeline', fraction: 1 })
}

export function failed(id: string, reason: string) {
  const job = jobs.get(id)
  if (job && job.state === 'ready') patch(job, { state: 'failed', stage: 'Failed', reason })
}

/** What the review and the page need: the items, Claude's translations and the new voice. */
export function result(id: string) {
  loadAll()
  const job = jobs.get(id)
  if (!job) throw new Error('That translation is gone.')
  const opt = <T>(f: string): T | null => (fs.existsSync(path.join(job.dir, f)) ? readJson<T>(path.join(job.dir, f)) : null)
  return {
    job,
    items: opt<{ items: TrItem[] }>('items.json')?.items ?? [],
    texts: opt<{ texts: TrText[] }>('translation.json')?.texts ?? [],
    voice: opt<{ lines: TrLine[] }>('voice.json')?.lines ?? null,
    stems: Object.fromEntries(Object.entries(opt<Record<string, TrStems | { failed: string }>>('stems.json') ?? {}).filter((e): e is [string, TrStems] => !('failed' in e[1]))),
  }
}

/** The jobs a project has: those translating it (it's the source) and its own (it's a copy). */
export function list(project: string): TrJob[] {
  loadAll()
  return [...jobs.values()].filter((j) => (key(j.source) === key(project) || key(j.project) === key(project)) && fs.existsSync(j.dir))
}

/** Home: each project's jobs that still need something (running, waiting for the review, ready, stopped). */
export function summary(projects: string[]): Record<string, TrJob[]> {
  const out: Record<string, TrJob[]> = {}
  for (const p of projects) {
    const open = list(p).filter((j) => j.state !== 'applied' && j.state !== 'cancelled')
    if (open.length) out[p] = open
  }
  return out
}

/**
 * What the Translations tab needs to know about a project's sounds and dubs: for each sound file,
 * the voice that spoke it and what it says (a dub's sentence, a voiceover's script), with the
 * original-language words a dub translated from; and every dub's text translations.
 */
export function context(project: string, paths: string[]) {
  const sounds: Record<string, TrSound> = {}
  const textPairs: { translation: string; original: string }[] = []
  const langs: string[] = []
  const dubs = path.join(project, 'dubs')
  if (fs.existsSync(dubs))
    for (const d of fs.readdirSync(dubs)) {
      const dir = path.join(dubs, d)
      try {
        const job = readJson<{ lang: string; name?: string; voiceName?: string; state?: string; voice?: string; voiceId?: string; keepClone?: boolean }>(path.join(dir, 'job.json'))
        if (job.state !== 'applied') continue
        langs.push(job.lang)
        // The dub's bed: the clip's sound without the voice, nothing to hear.
        sounds[key(path.join(dir, 'bed.m4a'))] = {}
        const t = path.join(dir, 'texts.json')
        if (fs.existsSync(t)) for (const x of readJson<{ texts: { text: string; translation: string; kind: string }[] }>(t).texts) if (x.kind === 'edit') textPairs.push({ translation: x.translation, original: x.text })
        const v = path.join(dir, 'voice.json')
        if (!fs.existsSync(v)) continue
        const voice = readJson<{ voiceId: string; model: string; speed: number; lines: { id: string; file: string; text: string; own?: boolean }[] }>(v)
        const sf = path.join(dir, `speech-${job.lang}.json`)
        const heard = fs.existsSync(sf) ? readJson<{ lines: { id: string; text: string }[] }>(sf).lines : []
        // Her clone: the one kept in the account, else made again from the dub's sample for the take.
        const kept = job.voice === 'clone' && job.keepClone && job.voiceId
        const sample = job.voice === 'clone' && !kept ? fs.readdirSync(dir).find((f) => /^clone-.+\.mp3$/.test(f)) : undefined
        const clone = sample ? { clone: { sample: path.join(dir, sample), name: path.parse(job.name ?? 'Her voice').name } } : {}
        for (const l of voice.lines)
          sounds[key(l.file)] = l.own ? { text: l.text } : { voiceId: kept || voice.voiceId, model: voice.model, speed: voice.speed, name: job.voiceName ?? 'The dub’s voice', text: l.text, original: heard.find((h) => h.id === l.id)?.text, lang: job.lang, ...clone }
      } catch {}
    }
  // A translation already on this project's timeline (this is a copy): it's in that language now,
  // and its voice speaks on.
  try {
    const own = path.join(project, 'translation')
    const job = readJson<TrJob>(path.join(own, 'job.json'))
    if (job.state === 'applied' || job.state === 'ready') langs.push(job.lang)
    if (job.state === 'applied' && fs.existsSync(path.join(own, 'voice.json'))) {
      const items = readJson<{ items: TrItem[] }>(path.join(own, 'items.json')).items
      for (const l of readJson<{ lines: TrLine[] }>(path.join(own, 'voice.json')).lines) {
        const v = items.find((i) => i.id === l.id)?.voice
        if (v) sounds[key(l.file)] = { voiceId: v.voiceId, model: v.model, speed: v.speed, name: v.name, text: l.text, lang: job.lang, ...(v.clone?.sample ? { clone: { sample: v.clone.sample, name: v.clone.name, translation: true } } : {}) }
      }
    }
  } catch {}
  for (const p of paths) {
    if (sounds[key(p)]) continue
    const stem = p.replace(/\.[^.\\/]+$/, '')
    const script = fs.existsSync(`${stem}.script.txt`) ? fs.readFileSync(`${stem}.script.txt`, 'utf8').trim() : ''
    if (!script) {
      // A voiceover Studio didn't make, once it's been heard (voice-read.ts).
      const r = knownVoice(project, p)
      if (r) sounds[key(p)] = { text: r.sentences.map((x) => x.text).join(' '), ...(r.voice ? { voiceId: r.voice.voiceId, model: r.voice.model, speed: r.voice.speed, name: r.voice.name } : {}), lang: r.language, read: { sentences: r.sentences, how: r.voice?.how, note: r.note, language: r.language, mixed: !!r.mixed } }
      continue
    }
    const v = fs.existsSync(`${stem}.voice.json`) ? readJson<{ voiceId: string; modelId: string; speed?: number; name?: string; languageCode?: string }>(`${stem}.voice.json`) : null
    sounds[key(p)] = { text: script, ...(v ? { voiceId: v.voiceId, model: v.modelId, speed: v.speed ?? 1, name: v.name ?? 'The voiceover’s voice', lang: v.languageCode } : {}) }
  }
  // Keyed by the paths asked about, as they were asked.
  return { sounds: Object.fromEntries(paths.filter((p) => sounds[key(p)]).map((p) => [p, sounds[key(p)]])), texts: textPairs, lang: langs[langs.length - 1] ?? '', choices: voiceChoices(project), ...dubTexts(project) }
}

/**
 * For the text export: what the project's dubs (or, for a translation's copy, its source's)
 * know beyond the timeline. `filmed`: overlay text a dub left in the picture as filmed (the same
 * in the new language), in the dub's own time, with the dub folder's name to find the clips
 * playing its picture. `heard`: what was said in a dubbed clip's own sound, in its own time.
 */
function dubTexts(project: string) {
  const dirs = [project]
  try {
    dirs.push(readJson<TrJob>(path.join(project, 'translation', 'job.json')).source)
  } catch {}
  const filmed: { dir: string; text: string; startUs: number; endUs: number; box: { x: number; y: number; w: number; h: number } }[] = []
  const heard: { source: string; language: string; lines: { text: string; start: number; end: number }[] }[] = []
  for (const p of dirs) {
    const dubs = path.join(p, 'dubs')
    if (!fs.existsSync(dubs)) continue
    for (const d of fs.readdirSync(dubs)) {
      const dir = path.join(dubs, d)
      try {
        const job = readJson<{ state?: string; source: string }>(path.join(dir, 'job.json'))
        if (job.state !== 'applied') continue
        if (fs.existsSync(path.join(dir, 'texts.json')) && fs.existsSync(path.join(dir, 'scan.json'))) {
          const blocks = readJson<{ blocks: { id: string; startUs: number; endUs: number; box: { x: number; y: number; w: number; h: number } }[] }>(path.join(dir, 'scan.json')).blocks
          for (const t of readJson<{ texts: { id: string; text: string; translation: string; kind: string }[] }>(path.join(dir, 'texts.json')).texts) {
            const b = blocks.find((x) => x.id === t.id)
            if (b && t.kind === 'edit' && t.text.replace(/\s+/g, ' ').trim() === t.translation.replace(/\s+/g, ' ').trim()) filmed.push({ dir: d, text: t.text, startUs: b.startUs, endUs: b.endUs, box: b.box })
          }
        }
        const s = path.join(dir, 'speech.json')
        if (fs.existsSync(s)) {
          const sp = readJson<{ language: string; lines: { text: string; start: number; end: number }[] }>(s)
          if (sp.lines.length && !heard.some((h) => key(h.source) === key(job.source))) heard.push({ source: job.source, language: sp.language, lines: sp.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })) })
        }
      } catch {}
    }
  }
  return { filmed, heard }
}
