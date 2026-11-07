// Dub: a clip re-made in another language — its on-screen text, its voice, or both, with
// captions if wanted. The Dub tab sets it up; each step is kept in the dub's own folder
// (`<project>.studio/dubs/<name> <lang> <id>/`), so a dub picks up where it stopped:
//   1. the part:     the stretch of the source the clip plays (the source itself when it's all of it),
//                    and Vmake set to take the text out of it (Smart Remove Pro by default) at once,
//                    as its own job, as it takes longest (20 minutes and more): nothing the dub does
//                    after that stops it, not failing, waiting or being cancelled, and every dub of
//                    the same part (into any language) uses that one removal (ensureRemoval)
//   2. text:         every text, its exact frames and a crop of it (dub-scan.ts)            → scan.json
//   3. voice:        separated from the music by the stems server (AudioShake, stems.ts), started
//                    now as it takes a minute or two; and what's said, heard by Scribe   → speech.json
//   4. Claude:       reads each text from its crop and translates it                       → texts.json
//                    and translates the speech as one script, sized to its moments        → speech-<lang>.json
//   5. review:       the Dub tab shows it all; the user picks what to dub and may change any
//                    translation (`go`). Only Vmake has been paid for yet.
//   6. text:         once Vmake's clean copy is in, it is the picture as it is (Vmake keeps
//                    the product's own print), and every text edited in has its look
//                    measured against it (dub-look.ts), to be drawn again: the dubbed ones
//                    translated, the rest as they were                                   → looks.json
//   7. voice:        her voice cloned (or another voice), the whole script spoken in one take,
//                    cut into sentences and fitted to their moments (dub-voice.ts)         → voice.json
//                    and the background without her voice                                  → bed.m4a
//   8. the page puts it on the timeline: the new picture, the text clips, the clip's own sound
//      off with the background and every sentence on sound tracks, captions; then says so.
// The page hears every change as `dub:job`.

import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { retryPlan, type DubChange } from '../shared/dub-retry'
import { cloneLease } from '../shared/clone-lease'
import { VOICE_GONE, cloneSpeaker } from '../shared/reclone'
import { dubRunning, unchanged, type DubJob, type DubLook, type DubScan, type DubTake, type DubText, type DubVoiceLine } from '../shared/dub'
import { buildBase, measureLooks } from './dub-look'
import { ClaudeSignedOut, langName, readTexts, translateSpeech, type SpeechText } from './dub-read'
import { scanText } from './dub-scan'
import { CPS, FAKE as ELEVEN_FAKE, cloneFrom, cloneVoice, cutTake, fitLines, iso2, listen, mixBed, removeClone, retime, speakTake, type Spoken } from './dub-voice'
import { ElevenLabs } from './elevenlabs'
import { ffmpeg, probeVideo } from './ffmpeg'
import { getSecret } from './secrets'
import * as stems from './stems'
import * as vmakeJobs from './vmake-jobs'
import { trProjectName } from '../shared/translate'
import { copyProject, freeDir, relocate } from './translate'

const jobs = new Map<string, DubJob>()
const live = new Map<string, AbortController>()
/** The model sentences are spoken with (Studio's voiceovers use it too). */
const VOICE_MODEL = 'eleven_v4'

function send(job: DubJob) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('dub:job', job)
}

function save(job: DubJob) {
  fs.mkdirSync(job.dir, { recursive: true })
  fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(job, null, 1))
}

function patch(job: DubJob, p: Partial<DubJob>) {
  if (jobs.get(job.id) !== job) return
  Object.assign(job, p)
  save(job)
  send(job)
}

const key = (p: string) => path.resolve(p).toLowerCase()
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'clip'
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type DubStart = Pick<DubJob, 'project' | 'clipId' | 'mediaId' | 'name' | 'source' | 'inUs' | 'spanUs' | 'lang' | 'model' | 'text' | 'removeText' | 'voice' | 'voiceId' | 'voiceName' | 'keepClone' | 'inPlace' | 'captions' | 'review'>

/** A new dub of a clip, started at once. */
export function start(o: DubStart): DubJob {
  if (!fs.existsSync(o.project)) throw new Error('That project folder is missing.')
  if (!fs.existsSync(o.source)) throw new Error(`${path.basename(o.source)} is missing.`)
  if (!o.text && o.voice === 'keep' && !o.captions) throw new Error('Pick something to dub: the on-screen text, the voice or captions.')
  if (o.removeText && (!o.text || o.model === 'skip')) throw new Error('Removing the on-screen text needs Vmake: pick Smart Remove Pro or Smart Remove.')
  if (o.voice === 'voice' && !o.voiceId) throw new Error('Choose the voice in the Audio tab first.')
  const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const stem = safeName(path.parse(o.name).name)
  const job: DubJob = { id, ...o, dir: path.join(o.project, 'dubs', `${stem} ${o.lang} ${id}`), state: 'preparing', stage: 'Getting the clip ready', fraction: 0.01, startedAt: Date.now() }
  jobs.set(id, job)
  save(job)
  send(job)
  void run(job)
  return job
}

const eleven = () => (ELEVEN_FAKE ? null : new ElevenLabs(getSecret('elevenlabs') ?? ''))

/** The Claude steps: when Claude Code is signed out, wait for a sign-in (Try again) or the answer's file (written over MCP). */
async function withClaude<T>(job: DubJob, file: string, stage: string, gone: () => boolean, f: () => Promise<T>): Promise<T | null> {
  for (;;) {
    patch(job, { state: 'reading', stage, needsClaude: false })
    try {
      return await f()
    } catch (e) {
      if (!(e instanceof ClaudeSignedOut) || gone()) throw e
      patch(job, { stage: (e as Error).message, needsClaude: true })
      while (!gone() && !fs.existsSync(file)) await sleep(2000)
      if (gone()) return null
    }
  }
}

/**
 * The sentences, each with its room (until the next one starts) and what fits in it: the
 * language's speaking rate, 10 % faster (the take may be spoken up to 10 % faster, and a
 * sentence played up to 8 % faster), so translations aren't squeezed until meaning goes.
 */
const rooms = (lines: Spoken[], partEnd: number, lang: string) =>
  lines.map((l, i) => {
    const seconds = (lines[i + 1]?.start ?? partEnd) - l.start
    return { id: l.id, heard: l.text, seconds, budget: Math.max(8, Math.round(seconds * (CPS[lang] ?? 14) * 1.1)) }
  })

/** How a removal stands, as its dubs keep it. */
const removalOf = (vj: vmakeJobs.VmakeJob): NonNullable<DubJob['removal']> => ({ state: vj.state, stage: vj.stage, fraction: vj.fraction, startedAt: vj.startedAt, ...(vj.reason ? { reason: vj.reason } : {}) })

/** Dubs of the same stretch of the same file in one project: one removal (either Vmake model) serves them all. */
const samePart = (a: DubJob, b: DubJob) =>
  a.id !== b.id && key(a.project) === key(b.project) && key(a.source) === key(b.source) && Math.abs(a.inUs - b.inUs) < 1000 && Math.abs(a.spanUs - b.spanUs) < 1000

/** The part a dub works on: cut into its folder, or the source itself when the clip plays all of it. */
const partOf = (job: DubJob) => (fs.existsSync(path.join(job.dir, 'part.mp4')) ? path.join(job.dir, 'part.mp4') : job.source)

/**
 * A removal changed: every dub following it hears how it stands (the Dub tab shows it, a
 * cancelled dub's too), and a finished one's clean copy becomes theirs. Once it has ended, its
 * dubs hold all they need from it (the copy, or why it stopped), so its record goes.
 */
function follow(vj: vmakeJobs.VmakeJob) {
  if (!vj.dub) return
  const mine = [...jobs.values()].filter((d) => d.vmakeJob === vj.id)
  if (!mine.length) return
  const clean = vj.state === 'done' && fs.existsSync(vj.out) ? { clean: vj.out } : {}
  for (const d of mine) patch(d, { removal: removalOf(vj), ...clean })
  if (vmakeJobs.ended(vj)) setImmediate(() => vmakeJobs.settled(vj.id))
}
vmakeJobs.watch(follow)

/**
 * The text removal, started before anything else as it takes longest, as its own job: nothing
 * the dub does after this (failing, waiting for Claude or for picks, being cancelled) stops it.
 * A removal of the same part that's running or done (an earlier dub of the clip, into any
 * language, with either model) is used rather than paid for again; a clean copy that's already
 * there is used even with Vmake None (it costs nothing). One that stopped is started again only
 * by Try again or the Dub tab's Start it again (`again`), as that's paid again.
 */
function ensureRemoval(job: DubJob, part: string, again: boolean) {
  if (!job.text || (job.clean && fs.existsSync(job.clean))) return
  const records = vmakeJobs.list(job.project)
  const going = (id?: string) => records.find((j) => j.id === id && j.state !== 'failed' && j.state !== 'cancelled')
  const own = job.model === 'skip' ? undefined : going(job.vmakeJob)
  if (own) return follow(own)
  const siblings = list(job.project).filter((d) => samePart(job, d))
  const done = siblings.find((d) => d.clean && fs.existsSync(d.clean))
  if (done) return void patch(job, { clean: done.clean, removal: { state: 'done', stage: `Already removed for the ${langName(done.lang)} dub`, fraction: 1, startedAt: Date.now() } })
  if (job.model === 'skip') return
  for (const d of siblings) {
    const theirs = going(d.vmakeJob)
    if (theirs) {
      patch(job, { vmakeJob: theirs.id, removal: removalOf(theirs) })
      return follow(theirs)
    }
  }
  if (job.vmakeJob && !again) return
  const out = path.join(job.project, 'cleaned', `${safeName(path.parse(job.name).name)} (no text).mp4`)
  const vj = vmakeJobs.create({ project: job.project, mediaId: job.mediaId, name: job.name, title: path.parse(job.name).name, model: job.model, out, seconds: job.spanUs / 1e6, dub: job.id })
  patch(job, { vmakeJob: vj.id, removal: removalOf(vj) })
  vmakeJobs.start(vj.id, { source: part })
}

/** Runs (or resumes) a dub, skipping every step whose result is already in its folder; `again` (Try again) may pay for a stopped removal again. */
async function run(job: DubJob, again = false) {
  if (live.has(job.id)) return
  const stop = new AbortController()
  live.set(job.id, stop)
  const signal = stop.signal
  const gone = () => signal.aborted || jobs.get(job.id) !== job
  const file = (f: string) => path.join(job.dir, f)
  const notes: string[] = []
  try {
    fs.mkdirSync(job.dir, { recursive: true })
    // 1. The part.
    const v = await probeVideo(job.source)
    const whole = job.inUs <= 20_000 && job.spanUs >= v.durationUs - 50_000
    const part = whole ? job.source : file('part.mp4')
    if (!whole && !fs.existsSync(part)) {
      patch(job, { state: 'preparing', stage: 'Cutting out the clip’s part', fraction: 0.02 })
      await ffmpeg(['-y', '-ss', (job.inUs / 1e6).toFixed(4), '-i', job.source, '-t', (job.spanUs / 1e6).toFixed(4), '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', part + '.tmp.mp4'])
      fs.renameSync(part + '.tmp.mp4', part)
    }
    const partEnd = job.spanUs / 1e6
    if (gone()) return
    // The text removal, before anything else: it takes longest, and runs on its own from here.
    ensureRemoval(job, part, again)
    const speaks = job.voice !== 'keep'
    const hears = speaks || job.captions

    // 3a. The voice apart from the music (the stems server), started now: it takes a minute or two.
    if (speaks && (!job.stemsDir || !stems.list(job.project).some((s) => s.dir === job.stemsDir && s.state !== 'failed' && s.state !== 'cancelled'))) {
      const sj = stems.start({ project: job.project, clipId: job.clipId, mediaId: job.mediaId, name: job.name, source: job.source, inUs: job.inUs, spanUs: job.spanUs })
      patch(job, { stemsDir: sj.dir })
    }

    // 2. The text (not for Remove, which only takes it out).
    let scan: DubScan | null = null
    if (job.text && !job.removeText) {
      if (fs.existsSync(file('scan.json'))) scan = readJson(file('scan.json'))
      else {
        patch(job, { state: 'scanning', stage: 'Finding the text', fraction: 0.03 })
        scan = await scanText(part, job.dir, { signal, progress: (f, note) => !gone() && patch(job, { stage: note, fraction: 0.03 + f * 0.17 }) })
      }
      if (gone()) return
    }

    // 3b. What's said.
    let speech: { language: string; lines: Spoken[] } | null = null
    if (hears) {
      patch(job, { state: 'listening', stage: 'Listening to what’s said', fraction: 0.22 })
      speech = await listen(eleven(), part, job.dir)
      if (gone()) return
    }
    if (!job.removeText && !scan?.blocks.length && !speech?.lines.length) throw new Error('This clip has no on-screen text or speech to dub.')
    if (hears && !speech?.lines.length) notes.push('No speech was heard, so there’s no voice or captions to dub; only the on-screen text.')

    // 4. Claude reads and translates.
    let texts: DubText[] = []
    if (scan?.blocks.length) {
      const got = await withClaude(job, file('texts.json'), 'Claude is reading and translating the text', gone, () => readTexts(scan!, job.dir, job.lang, { signal }))
      if (!got) return
      texts = got
    }
    const speechFile = file(`speech-${job.lang}.json`)
    let said: SpeechText[] = []
    if (speech?.lines.length) {
      if (fs.existsSync(speechFile)) said = readJson<{ lines: SpeechText[] }>(speechFile).lines
      else {
        const known = texts.filter((t) => t.kind !== 'part').map((t) => t.text)
        const got = await withClaude(job, speechFile, 'Claude is translating what’s said', gone, () => translateSpeech(rooms(speech!.lines, partEnd, job.lang), job.lang, { from: speech!.language, known, signal }))
        if (!got) return
        said = got
        fs.writeFileSync(speechFile, JSON.stringify({ lines: said }, null, 1))
      }
    }
    if (gone()) return

    // 5. Review: the Dub tab picks what's dubbed (`go`); without it, everything is.
    if (!job.picks) {
      const all = { texts: texts.filter((t) => t.kind === 'edit' && !unchanged(t)).map((t) => t.id), lines: said.map((l) => l.id) }
      // Nothing to pick (Remove with no voice or captions): straight on.
      if (job.review && (all.texts.length || all.lines.length)) return void patch(job, { state: 'review', stage: 'Pick what to dub in the Dub tab', fraction: 0.3 })
      patch(job, { picks: all })
    }
    const picks = job.picks!
    let textIds = texts.filter((t) => t.kind === 'edit' && picks.texts.includes(t.id) && !unchanged(t)).map((t) => t.id)
    const lineIds = speaks ? said.filter((l) => picks.lines.includes(l.id)).map((l) => l.id) : []

    // 7. The voice.
    if (lineIds.length && !fs.existsSync(file('voice.json'))) {
      try {
        await dubVoice(job, { part, partEnd, speech: speech!, said, lineIds, gone, notes })
      } finally {
        // Her clone is deleted once she's spoken (or the voice step stopped), unless it's kept.
        await leaseOf(job).tidy().catch((e) => notes.push(`Her clone couldn’t be deleted from ElevenLabs: ${(e as Error).message}`))
      }
      if (gone()) return
    }

    // 6. The clean copy (Vmake, working on its own since the start), the looks and the new picture.
    if (job.removeText) {
      // Remove: the clean copy is the picture, with nothing drawn back.
      const own = job.vmakeJob ? vmakeJobs.list(job.project).find((j) => j.id === job.vmakeJob) : undefined
      if (own) follow(own)
      if (!(await waitForClean(job, gone))) return
      patch(job, { base: job.clean, redraw: false })
    } else if (textIds.length) {
      if (job.model !== 'skip') {
        const own = job.vmakeJob ? vmakeJobs.list(job.project).find((j) => j.id === job.vmakeJob) : undefined
        if (own) follow(own)
        if (!(await waitForClean(job, gone))) return
      }
      // With None and no clean copy of this part, the looks are measured against an estimate of
      // the picture behind the letters (dub-look.ts) and the new text goes over the old.
      const clean = job.clean && fs.existsSync(job.clean) ? job.clean : part
      // Vmake's clean copy is the picture as it is: it takes out only the text edited in and
      // keeps the product's own print (checked frame by frame: a box, tube labels, side print). Patching it
      // in only where and while each text was found left texts kept as they were ("Tuben.") in
      // the picture and flickered wherever a text's frames were off by one. So every text edited
      // in is drawn again over it: the dubbed ones translated, the rest as they were.
      const redraw = clean !== part
      const drawn = redraw ? texts.filter((t) => t.kind === 'edit').map((t) => t.id) : textIds
      if (!fs.existsSync(file('looks.json'))) {
        patch(job, { state: 'matching', stage: 'Measuring how each text looks', fraction: 0.88 })
        await measureLooks(scan!, drawn, part, clean, job.dir)
      }
      if (gone()) return
      // A text whose letters couldn't be measured stays as filmed: the original is put back
      // where (and while) it was, and the page leaves out texts with no look.
      const looks = readJson<DubLook[]>(file('looks.json'))
      const lost = drawn.filter((id) => !looks.some((l) => l.id === id))
      if (lost.length) {
        notes.push(`${lost.map((id) => `“${texts.find((t) => t.id === id)?.text.replace(/\n/g, ' ')}”`).join(', ')} couldn’t be measured against the clean copy, so ${lost.length === 1 ? 'it stays' : 'they stay'} as filmed.`)
        textIds = textIds.filter((id) => !lost.includes(id))
      }
      // Without a clean copy the picture stays as it is (`base` none: the new text goes over the old).
      let base: string | undefined = redraw ? clean : undefined
      if (redraw && lost.length) {
        base = file('base.mp4')
        if (!fs.existsSync(base)) {
          patch(job, { state: 'matching', stage: 'Putting back the text that stays as filmed', fraction: 0.93 })
          await buildBase(clean, part, scan!, lost, file('base.tmp.mp4'))
          fs.renameSync(file('base.tmp.mp4'), base)
        }
      }
      if (gone()) return
      patch(job, { base, redraw })
    }
    patch(job, { notes: [...(job.notes ?? []), ...notes] })
    // The user's rule: a finished dub opens as a new project of its own; the original stays as it was.
    if (!job.inPlace && !job.from) land(job)
    else patch(job, { state: 'ready', stage: 'Ready to go on the timeline', fraction: 0.97 })
  } catch (e) {
    if (jobs.get(job.id) === job && !signal.aborted) patch(job, { state: 'failed', stage: 'Failed', reason: (e as Error).message })
  } finally {
    if (live.get(job.id) === stop) live.delete(job.id)
  }
}

/**
 * The user's rule (2026-11-07): "after you have dubbed a normal video … it opens from that same
 * Studio session into a new Studio project as dubbed". A finished dub becomes a new project,
 * "<project> · <language>": a copy of the project as it is now, with the dub's folder copied in
 * (hard links) and every path in it pointed there, Vmake's clean copy too, so the new project
 * stands on its own (deleting the original takes nothing from it). The dub's copy there (`from`)
 * is ready, and the page puts it on that project's timeline when it opens it; Reroll, What she
 * says, Her clone and translations work there. This dub becomes a record (`landed`): its clean
 * copy stays this project's, so a dub of the same clip into another language never pays Vmake again.
 */
function land(job: DubJob) {
  patch(job, { state: 'matching', stage: 'Making its own project', fraction: 0.98 })
  const own = readJson<{ name?: string }>(path.join(job.project, 'project.json')).name
  const name = trProjectName(own || path.basename(job.project).replace(/\.studio$/i, ''), job.lang)
  const to = freeDir(path.dirname(job.project), name)
  copyProject(job.project, to, name)
  const id = `${job.id}${job.lang}`
  const dir = path.join(to, 'dubs', path.basename(job.dir))
  // Every file of the dub, then its records pointed at the new folder (and the clean copy).
  const linkAll = (from: string, into: string) => {
    fs.mkdirSync(into, { recursive: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, e.name)
      const t = path.join(into, e.name)
      if (e.isDirectory()) linkAll(f, t)
      else if (!fs.existsSync(t))
        try {
          fs.linkSync(f, t)
        } catch {
          fs.copyFileSync(f, t)
        }
    }
  }
  linkAll(job.dir, dir)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'job.json')) {
    const p = path.join(dir, f)
    fs.writeFileSync(p, JSON.stringify(relocate(readJson<unknown>(p), job.project, to), null, 1))
  }
  const { vmakeJob: _removal, landed: _landed, ...rest } = relocate(job, job.project, to)
  const copy: DubJob = { ...rest, id, project: to, dir, state: 'ready', stage: 'Ready to go on the timeline', fraction: 0.97, from: { project: job.project, id: job.id } }
  // Its clip in the new project is the copy's while it's put on the timeline.
  const pj = path.join(to, 'project.json')
  const mark = (v: unknown): unknown => (Array.isArray(v) ? v.map(mark) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'busy' && x === job.id ? id : mark(x)])) : v)
  fs.writeFileSync(pj + '.tmp', JSON.stringify(mark(readJson<unknown>(pj)), null, 2))
  fs.renameSync(pj + '.tmp', pj)
  jobs.set(id, copy)
  save(copy)
  send(copy)
  // Her clone (if kept) goes with the dub: this record holds none.
  patch(job, { state: 'landed', stage: `In its own project, ${name}`, fraction: 1, landed: { project: to, name, id }, ...(job.voice === 'clone' ? { voiceId: undefined } : {}) })
}

/** Waits for the dub's removal to bring its clean copy (false if the dub stopped meanwhile). */
async function waitForClean(job: DubJob, gone: () => boolean) {
  while (!job.clean) {
    if (gone()) return false
    const r = job.removal
    if (!job.vmakeJob || !r) throw new Error('The text removal never started. Try the dub again.')
    if (r.state === 'failed' || r.state === 'cancelled') throw new Error(r.reason ?? 'Vmake couldn’t remove the text.')
    if (r.state === 'done') throw new Error('Vmake’s clean copy is gone from the project’s cleaned folder. Try the dub again.')
    patch(job, { state: 'removing', stage: `Vmake: ${r.stage}`, fraction: Math.max(job.fraction, 0.6 + r.fraction * 0.25) })
    await sleep(1000)
  }
  return true
}

/** The stems a dub's voice and background come from, once the server has them. */
async function waitForStems(job: DubJob, gone: () => boolean) {
  for (;;) {
    if (gone()) return null
    const sj = stems.list(job.project).find((s) => s.dir === job.stemsDir)
    if (!sj) throw new Error('The voice separation went missing. Try the dub again.')
    if (sj.state === 'done' && sj.stems) {
      const heard = sj.stems.filter((s) => !s.silent)
      const voice = ['dialogue', 'speech_denoise', 'vocals', 'vocals_lead'].map((n) => heard.find((s) => s.name === n)).find(Boolean)
      // The background: music and sound effects without the voice, never a stem twice.
      const bedNames = heard.some((s) => s.name === 'music_fx') ? ['music_fx'] : heard.some((s) => s.name === 'instrumental') ? ['instrumental', 'effects'] : heard.filter((s) => !/^(vocals|dialogue|speech)/.test(s.name)).map((s) => s.name)
      return { voice: voice?.path, bed: heard.filter((s) => bedNames.includes(s.name)).map((s) => s.path) }
    }
    if (sj.state === 'failed' || sj.state === 'cancelled') throw new Error(`Her voice couldn’t be separated from the music: ${sj.reason ?? 'the separation stopped'}`)
    patch(job, { state: 'voicing', stage: `Separating the voice from the music: ${sj.stage}`, fraction: 0.32 + sj.fraction * 0.1 })
    await sleep(1000)
  }
}

/** The sample her clone is made from (kept in the dub's folder), if it's there. */
function sampleOf(job: DubJob) {
  const f = fs.existsSync(job.dir) ? fs.readdirSync(job.dir).find((x) => /^clone-.+\.mp3$/.test(x)) : undefined
  return f && path.join(job.dir, f)
}

const leases = new Map<string, ReturnType<typeof cloneLease>>()

/**
 * Her clone, used one use at a time: made again from the sample when it was deleted, and deleted
 * from the account after each use unless Her clone is set to Keep (the user's rule). A voice the
 * user chose is never deleted.
 */
function leaseOf(job: DubJob) {
  let lease = leases.get(job.id)
  if (!lease) {
    lease = cloneLease({
      id: () => job.voiceId,
      make: async () => {
        if (job.voice !== 'clone') throw new Error('This dub has no voice of its own to speak with.')
        const sample = sampleOf(job)
        if (!sample && !ELEVEN_FAKE) throw new Error('Her voice sample is gone from the dub’s folder, so she can’t be cloned again. Dub the clip again.')
        const id = await cloneFrom(eleven(), sample ?? '', path.parse(job.name).name)
        patch(job, { voiceId: id })
        return id
      },
      drop: async (id) => {
        // One already gone from the account counts as deleted.
        await removeClone(eleven(), id).catch((e) => {
          if ((e as { code?: string }).code !== VOICE_GONE) throw e
        })
        if (job.voiceId === id) patch(job, { voiceId: undefined })
      },
      keep: () => job.voice !== 'clone' || !!job.keepClone,
    })
    leases.set(job.id, lease)
  }
  return lease
}

/** The Dub tab's Her clone: Keep leaves it in the account; Delete deletes one that's there now. */
export async function keepClone(id: string, keep: boolean): Promise<DubJob> {
  const job = jobs.get(id)
  if (!job) throw new Error('That dub is gone.')
  patch(job, { keepClone: keep })
  // A dub that's voicing deletes it itself when its voice step ends.
  if (!keep && !dubRunning(job)) await leaseOf(job).tidy()
  return job
}

/**
 * Speaks with the dub's voice. A clone Studio made that ElevenLabs won't speak with until it's
 * verified is deleted and her voice cloned again from the kept sample, once per run (the user's
 * rule); one gone from the account is cloned again the same way. Refused again, the dub stops and
 * says what to do. A voice the user chose is never deleted.
 */
function voiceOf(job: DubJob, el: ElevenLabs | null, notes?: string[]) {
  const name = path.parse(job.name).name
  const free = job.text ? ': Vmake’s copy is used again at no cost' : ''
  let recloned = false
  return cloneSpeaker({
    voiceId: () => job.voiceId!,
    reclone: async (old, why) => {
      if (job.voice !== 'clone') return null
      const sample = sampleOf(job)
      if (!sample && !ELEVEN_FAKE) return null
      if (job.state === 'voicing') patch(job, { stage: why === 'verify' ? 'ElevenLabs wants that clone verified: cloning her voice again' : 'Her clone is gone from ElevenLabs: cloning her voice again' })
      let kept = ''
      if (why === 'verify') await removeClone(el, old).catch((e) => (kept = ` (the old one couldn’t be deleted: ${(e as Error).message})`))
      const id = await cloneFrom(el, sample ?? '', name)
      recloned = true
      patch(job, { voiceId: id })
      notes?.push(why === 'verify' ? `ElevenLabs wanted her clone verified before it would speak, so Studio deleted it and cloned her voice again${kept}.` : 'Her clone was no longer in ElevenLabs, so Studio cloned her voice again.')
      return id
    },
    refused: (why) =>
      new Error(
        job.voice !== 'clone'
          ? why === 'verify'
            ? `ElevenLabs won’t speak with ${job.voiceName ?? 'that voice'} until it’s verified. Verify it in ElevenLabs (My Voices), or choose another voice in Audio.`
            : `${job.voiceName ?? 'That voice'} isn’t in your ElevenLabs voices any more. Choose another voice in Audio and Try again.`
          : why === 'verify'
          ? `ElevenLabs won’t speak with her cloned voice until it’s verified${recloned ? ', and a new clone was refused too' : ''}. ${job.keepClone ? `Verify “${name} (Studio dub)” in ElevenLabs (My Voices) and Try again, or dub with Another voice${free}.` : `Dub with Another voice${free}. To verify her voice in ElevenLabs instead, set Her clone to Keep and Try again: the clone stays in My Voices.`}`
          : recloned
          ? `ElevenLabs didn’t keep her new clone: it was gone as soon as it was made, so it won’t keep a clone of this voice. Dub with Another voice and Try again${free}.`
          : `Her cloned voice isn’t in ElevenLabs any more, and its sample is missing. Dub with Another voice and Try again${free}.`,
      ),
  })
}

/**
 * The new voice: her clone (or the chosen voice) speaks the picked sentences as one take,
 * which is cut into sentences and fitted to their moments; a take whose sentences don't fit
 * goes back to Claude as a whole script to be said more simply, at most twice. Sentences not
 * picked keep her own voice (from the voice stem). Writes voice.json and the background.
 */
async function dubVoice(job: DubJob, o: { part: string; partEnd: number; speech: { language: string; lines: Spoken[] }; said: SpeechText[]; lineIds: string[]; gone: () => boolean; notes: string[] }) {
  const file = (f: string) => path.join(job.dir, f)
  const el = eleven()
  const sep = await waitForStems(job, o.gone)
  if (!sep) return
  const voiceStem = sep.voice ?? o.part
  if (!sep.voice) o.notes.push('The server found no separate voice, so the clone is made from the clip’s whole sound.')
  if (!sep.bed.length) o.notes.push('The server found no music or sound apart from the voice, so there’s no background under the new voice.')
  else if (!fs.existsSync(file('bed.m4a'))) await mixBed(sep.bed, file('bed.m4a'))

  // The voice that speaks: her clone (made once, kept for the project) or the one chosen.
  if (job.voice === 'clone' && !job.voiceId) {
    patch(job, { state: 'voicing', stage: 'Cloning her voice', fraction: 0.44 })
    const counts = new Map<string, number>()
    for (const l of o.speech.lines) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + (l.end - l.start))
    const main = [...counts].sort((a, b) => b[1] - a[1])[0][0]
    patch(job, { voiceId: await cloneVoice(el, voiceStem, o.speech.lines, main, path.parse(job.name).name, job.dir), voiceName: 'Her own voice (clone)' })
  }
  if (o.gone()) return

  const spoken = o.speech.lines.filter((l) => o.lineIds.includes(l.id))
  let said = o.said.filter((l) => o.lineIds.includes(l.id))
  const room = rooms(o.speech.lines, o.partEnd, job.lang)
  const roomOf = (id: string) => room.find((r) => r.id === id)!
  // The take's speed: as much faster as the whole script needs, within what sounds natural.
  const need = said.reduce((a, l) => a + l.translation.length, 0) / (CPS[job.lang] ?? 14)
  const have = said.reduce((a, l) => a + roomOf(l.id).seconds, 0)
  const speed = Math.min(1.1, Math.max(0.95, need / Math.max(1, have)))
  let seed = 4242
  let best: { placed: ReturnType<typeof fitLines>['placed']; cut: Awaited<ReturnType<typeof cutTake>>; long: string[] } | null = null
  const say = voiceOf(job, el, o.notes)
  for (let round = 1; round <= 3; round++) {
    patch(job, { state: 'voicing', stage: round === 1 ? 'Speaking the translation in one take' : `Speaking it again, shorter (take ${round})`, fraction: 0.45 + round * 0.08 })
    let take = await say((voiceId) => speakTake(el, { voiceId, lines: said.map((l) => ({ id: l.id, translation: l.translation })), lang: job.lang, model: VOICE_MODEL, seed, speed, out: file(`take-${round}.mp3`) }))
    // A take in the wrong language (or accent) is spoken again with another seed.
    if (el) {
      const heard = await el.transcribe({ file: take.file, diarize: false })
      if (iso2(heard.language) !== job.lang) {
        seed += 1
        take = await say((voiceId) => speakTake(el, { voiceId, lines: said.map((l) => ({ id: l.id, translation: l.translation })), lang: job.lang, model: VOICE_MODEL, seed, speed, out: file(`take-${round}b.mp3`) }))
        const again = await el.transcribe({ file: take.file, diarize: false })
        if (iso2(again.language) !== job.lang) o.notes.push(`Take ${round} still sounded like ${again.language}, not ${job.lang}; listen to it.`)
      }
    }
    if (o.gone()) return
    const cut = await cutTake(take, said.map((l) => l.id), job.dir, round)
    const { placed, long } = fitLines(cut, spoken, o.partEnd, round < 3 ? 1.08 : 1.12)
    if (!best || long.length < best.long.length) best = { placed, cut, long }
    if (!long.length || round === 3) break
    // Too long to say in their moments: the whole script again, those sentences simpler.
    const shorter = room.filter((r) => o.lineIds.includes(r.id)).map((r) => {
      const c = cut.find((x) => x.id === r.id)!
      const now = said.find((s) => s.id === r.id)!.translation.length
      return long.includes(r.id) ? { ...r, budget: Math.max(Math.round(now * 0.7), Math.round((now * r.seconds * 1.05) / c.dur)) } : { ...r, budget: Math.max(r.budget, now) }
    })
    patch(job, { state: 'reading', stage: `Claude is making ${long.length} sentence${long.length === 1 ? '' : 's'} shorter`, fraction: 0.5 + round * 0.08 })
    said = await translateSpeech(shorter, job.lang, { from: o.speech.language, previous: said, signal: undefined })
    seed += 7
  }
  if (best!.long.length) o.notes.push(`${best!.long.length} sentence${best!.long.length === 1 ? ' runs' : 's run'} a little past ${best!.long.length === 1 ? 'its' : 'their'} moment at 12 % faster: ${best!.long.join(', ')}.`)

  // The sentences as they'll play, and her own voice for those not picked.
  const lines: DubVoiceLine[] = []
  for (const p of best!.placed) {
    const c = best!.cut.find((x) => x.id === p.id)!
    const f = await retime(c.file, p.tempo, file(`line-${p.id}.wav`))
    lines.push({ id: p.id, file: f, at: p.at, dur: p.dur, tempo: p.tempo, text: said.find((s) => s.id === p.id)!.translation, words: c.words.map((w) => ({ text: w.text, start: w.start / p.tempo, end: w.end / p.tempo })) })
  }
  for (const l of o.speech.lines.filter((x) => !o.lineIds.includes(x.id))) {
    const f = file(`own-${l.id}.wav`)
    const from = Math.max(0, l.start - 0.05)
    await ffmpeg(['-y', '-ss', from.toFixed(3), '-t', (l.end - from + 0.15).toFixed(3), '-i', voiceStem, '-af', 'afade=t=in:d=0.01', '-ar', '44100', f])
    lines.push({ id: l.id, file: f, at: from, dur: l.end - from + 0.15, tempo: 1, text: l.text, words: l.words.map((w) => ({ text: w.text, start: w.start - from, end: w.end - from })), own: true })
  }
  lines.sort((a, b) => a.at - b.at)
  fs.writeFileSync(file('voice.json'), JSON.stringify({ voiceId: job.voiceId, model: VOICE_MODEL, speed, lines }, null, 1))
  patch(job, { ...(fs.existsSync(file('bed.m4a')) ? { bed: file('bed.m4a') } : {}) })
}

type VoiceFile = { voiceId: string; model: string; speed: number; lines: DubVoiceLine[] }

const takeOf = (l: DubTake): DubTake => ({ file: l.file, dur: l.dur, tempo: l.tempo, text: l.text, words: l.words })

/** The translation the dub keeps for each sentence (the review's, and the next take's words). */
function keepWords(job: DubJob, words: Record<string, string>) {
  const sf = path.join(job.dir, `speech-${job.lang}.json`)
  if (!fs.existsSync(sf)) return
  const s = readJson<{ lines: SpeechText[] }>(sf)
  for (const x of s.lines) if (words[x.id] != null) x.translation = words[x.id]
  fs.writeFileSync(sf, JSON.stringify(s, null, 1))
}

/**
 * Reroll: dubbed sentences (`ids`) spoken again by the same voice as a new take (a new seed),
 * with new words where `edits` has them, else their own, together with the sentence before
 * them so the voice runs on as one performance (neighbouring ones are one take). Only those
 * sentences are cut out, each at its place (a little faster, up to 12 %, if it no longer fits
 * before the next). Every take is kept (`takes`), so an earlier one can be played again
 * (`pickTake`) at no cost. Returns them as they'll play, for the page to swap in.
 */
export async function reroll(id: string, ids: string[], edits: Record<string, string> = {}): Promise<DubVoiceLine[]> {
  const job = jobs.get(id)
  if (!job) throw new Error('That dub is gone.')
  if (job.voice === 'keep' || (job.voice === 'voice' && !job.voiceId)) throw new Error('This dub has no voice of its own to speak with.')
  // Her clone: made again from the sample if it was deleted, and deleted after unless it's kept.
  return leaseOf(job).use(() => rerollWith(job, ids, edits))
}

async function rerollWith(job: DubJob, ids: string[], edits: Record<string, string>): Promise<DubVoiceLine[]> {
  const file = (f: string) => path.join(job.dir, f)
  const voice = readJson<VoiceFile>(file('voice.json'))
  const lines = voice.lines
  const words = (l: DubVoiceLine) => edits[l.id]?.trim() || l.text
  const changed = lines.filter((l) => !l.own && ids.includes(l.id)).map((l) => l.id)
  if (!changed.length) return []
  const el = eleven()
  const say = voiceOf(job, el)
  const tag = `r${Date.now().toString(36)}`
  const out: DubVoiceLine[] = []
  // Runs of neighbouring sentences, each spoken with the sentence before it.
  const runs: string[][] = []
  for (const cid of changed) {
    const i = lines.findIndex((l) => l.id === cid)
    const last = runs[runs.length - 1]
    if (last && lines.findIndex((l) => l.id === last[last.length - 1]) === i - 1) last.push(cid)
    else runs.push([cid])
  }
  for (const run of runs) {
    const first = lines.findIndex((l) => l.id === run[0])
    const before = lines.slice(0, first).reverse().find((l) => !l.own)
    const script = [...(before ? [{ id: before.id, translation: before.text }] : []), ...run.map((rid) => ({ id: rid, translation: words(lines.find((l) => l.id === rid)!) }))]
    // A new seed each time: the same words with the same seed come back as the same take.
    const seed = Math.floor(Math.random() * 2 ** 32)
    const take = await say((voiceId) => speakTake(el, { voiceId, lines: script, lang: job.lang, model: voice.model ?? VOICE_MODEL, seed, speed: voice.speed ?? 1, out: file(`take-${tag}-${run[0]}.mp3`) }))
    const cut = await cutTake(take, script.map((s) => s.id), job.dir, tag)
    for (const rid of run) {
      const c = cut.find((x) => x.id === rid)!
      const old = lines.find((l) => l.id === rid)!
      const next = lines[lines.findIndex((l) => l.id === rid) + 1]
      const room = next ? next.at - old.at - 0.04 : job.spanUs / 1e6 - old.at
      const tempo = Math.min(1.12, Math.max(1, c.dur / Math.max(0.1, room)))
      const f = await retime(c.file, tempo, file(`line-${rid}-${tag}-fit.wav`))
      const made: DubTake = { file: f, dur: c.dur / tempo, tempo, text: words(old), words: c.words.map((w) => ({ text: w.text, start: w.start / tempo, end: w.end / tempo })) }
      const takes = [...(old.takes ?? [takeOf(old)]), made]
      Object.assign(old, made, { takes, take: takes.length - 1 })
      out.push({ ...old })
    }
  }
  // A clone cloned again (see voiceOf) is the one the dub speaks with from now on.
  voice.voiceId = job.voiceId!
  fs.writeFileSync(file('voice.json'), JSON.stringify(voice, null, 1))
  keepWords(job, Object.fromEntries(out.map((l) => [l.id, l.text])))
  return out
}

/** An earlier take of a dubbed sentence played again: nothing is spoken, it was kept. */
export function pickTake(id: string, lineId: string, index: number): DubVoiceLine {
  const job = jobs.get(id)
  if (!job) throw new Error('That dub is gone.')
  const file = path.join(job.dir, 'voice.json')
  const voice = readJson<VoiceFile>(file)
  const line = voice.lines.find((l) => l.id === lineId)
  const take = line?.takes?.[index]
  if (!line || !take || !fs.existsSync(take.file)) throw new Error('That take is gone.')
  Object.assign(line, takeOf(take), { take: index })
  fs.writeFileSync(file, JSON.stringify(voice, null, 1))
  keepWords(job, { [line.id]: line.text })
  return line
}

/** The Dub tab's picks (and any translation changed there): the paid steps start. */
export function go(id: string, o: { texts: string[]; lines: string[]; edits?: Record<string, string> }): DubJob | null {
  const job = jobs.get(id)
  if (!job || job.state !== 'review') return job ?? null
  const file = (f: string) => path.join(job.dir, f)
  if (o.edits && Object.keys(o.edits).length) {
    if (fs.existsSync(file('texts.json'))) {
      const t = readJson<{ lang: string; texts: DubText[] }>(file('texts.json'))
      for (const x of t.texts) if (o.edits[x.id] != null) x.translation = o.edits[x.id]
      fs.writeFileSync(file('texts.json'), JSON.stringify(t, null, 1))
    }
    const sf = file(`speech-${job.lang}.json`)
    if (fs.existsSync(sf)) {
      const s = readJson<{ lines: SpeechText[] }>(sf)
      for (const x of s.lines) if (o.edits[x.id] != null) x.translation = o.edits[x.id]
      fs.writeFileSync(sf, JSON.stringify(s, null, 1))
    }
  }
  if (!o.texts.length && !o.lines.length && !job.captions && !job.removeText) {
    patch(job, { state: 'cancelled', stage: 'Cancelled', reason: 'Nothing was picked to dub.' })
    return job
  }
  patch(job, { picks: { texts: o.texts, lines: o.lines }, state: 'preparing', stage: 'Starting', fraction: 0.3 })
  void run(job)
  return job
}

/**
 * Starts a failed or waiting dub again from where it stopped. With `change` (what the Dub tab
 * shows that differs from the dub's own settings), those are used instead: the old voice is
 * forgotten, and only the files the change makes wrong are made again (retryPlan).
 */
export function retry(id: string, change?: DubChange): DubJob | null {
  const job = jobs.get(id)
  if (!job) return null
  const plan = change && Object.keys(change).length ? retryPlan(job, change) : null
  live.get(id)?.abort()
  live.delete(id)
  for (const f of plan?.drop ?? []) fs.rmSync(path.join(job.dir, f), { force: true })
  patch(job, { ...plan?.patch, state: 'preparing', stage: 'Starting again', reason: undefined, needsClaude: false })
  void run(job, true)
  return job
}

/** The Dub tab's Start it again, for a text removal that stopped while the dub went on (paid again). */
export function removeAgain(id: string): DubJob {
  const job = jobs.get(id)
  if (!job) throw new Error('That dub is gone.')
  ensureRemoval(job, partOf(job), true)
  return job
}

export function cancel(id: string): DubJob | null {
  const job = jobs.get(id)
  if (!job || !dubRunning(job)) return job ?? null
  live.get(id)?.abort()
  // The text removal isn't stopped: it carries on whatever happens to the dub, and the next dub
  // of the clip uses it.
  const removing = !!job.removal && !['done', 'failed', 'cancelled'].includes(job.removal.state)
  patch(job, { state: 'cancelled', stage: 'Cancelled', reason: removing ? 'Dub cancelled. Vmake carries on removing the text, and the next dub of this clip uses it.' : 'Dub cancelled.' })
  return job
}

/** The page has put a ready dub on the timeline. */
export function applied(id: string) {
  const job = jobs.get(id)
  if (job && job.state === 'ready') patch(job, { state: 'applied', stage: 'On the timeline', fraction: 1 })
}

/** The page couldn't put a ready dub on the timeline: it ends failed (Try again puts it on again). */
export function failed(id: string, reason: string) {
  const job = jobs.get(id)
  if (job && job.state === 'ready') patch(job, { state: 'failed', stage: 'Failed', reason })
}

/** What the Dub tab shows for review, and what the page needs to build a ready dub's clips. */
export function result(id: string) {
  const job = jobs.get(id)
  if (!job) throw new Error('That dub is gone.')
  const opt = <T>(f: string): T | null => (fs.existsSync(path.join(job.dir, f)) ? readJson<T>(path.join(job.dir, f)) : null)
  return {
    job,
    scan: opt<DubScan>('scan.json'),
    texts: opt<{ texts: DubText[] }>('texts.json')?.texts ?? [],
    looks: opt('looks.json') ?? [],
    speech: opt<{ language: string; lines: Spoken[] }>('speech.json'),
    said: opt<{ lines: SpeechText[] }>(`speech-${job.lang}.json`)?.lines ?? [],
    voice: opt<{ lines: DubVoiceLine[] }>('voice.json'),
  }
}

/**
 * Home's projects list: each project's dubs that still need something (running, waiting for
 * picks, ready to land, or stopped), the latest per clip. Reading them also starts again any
 * left running when Studio last closed.
 */
export function summary(projects: string[]): Record<string, DubJob[]> {
  const out: Record<string, DubJob[]> = {}
  for (const p of projects) {
    const latest = new Map<string, DubJob>()
    for (const j of list(p)) if (!latest.has(j.clipId) || latest.get(j.clipId)!.startedAt < j.startedAt) latest.set(j.clipId, j)
    const open = [...latest.values()].filter((j) => j.state !== 'applied' && j.state !== 'landed' && j.state !== 'cancelled')
    if (open.length) out[p] = open
  }
  return out
}

/** A project's dubs, read from their folders the first time; one left running by a closed app goes on. */
export function list(project: string): DubJob[] {
  const dir = path.join(project, 'dubs')
  if (fs.existsSync(dir))
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, 'job.json')
      if (!fs.existsSync(f)) continue
      try {
        const j = { text: true, voice: 'keep', captions: false, review: false, ...JSON.parse(fs.readFileSync(f, 'utf8')) } as DubJob
        if (jobs.has(j.id)) continue
        jobs.set(j.id, j)
        // Its removal may have moved on (or finished) while the project was closed.
        const vj = j.vmakeJob ? vmakeJobs.list(j.project).find((x) => x.id === j.vmakeJob) : undefined
        if (vj) follow(vj)
        if (dubRunning(j) && j.state !== 'review') void run(j)
      } catch {}
    }
  return [...jobs.values()].filter((j) => key(j.project) === key(project))
}
