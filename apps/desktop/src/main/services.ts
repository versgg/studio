// Outside services the page can use through IPC: saved keys, Vmake text removal, ElevenLabs
// voices and voiceovers, captions from the transcript server (checked against the voiceover's
// script), stems from the stems server, saving microphone recordings into the project, and
// (files.ts, sounds.ts) the files the page draws, frames for analysis, mattes, captions, the
// sound library and app settings.
// Keys never cross to the page; each handler reads the one it needs here.

import { app, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { aboutVoices, beginPackage, directorUrl, discardPackage, finishPackage, inboxDir, isPartial, sendFile, type TimeLabel, type VoiceClip } from './director'
import { clearSecret, dropRetiredSecrets, getSecret, hasSecret, setSecret, type SecretName } from './secrets'
import { stageText, transcribe } from './transcript'
import { holesOf, levelsOf, mergeWords } from '../shared/caption-holes'
import { ElevenError, ElevenLabs, type Voice } from './elevenlabs'
import { elevenPermissionName } from '../shared/eleven-permissions'
import { ffmpeg } from './ffmpeg'
import { registerFiles } from './files'
import { registerSounds } from './sounds'
import * as dub from './dub'
import * as stems from './stems'
import * as translate from './translate'
import * as download from './download'
import { accountVoices, readVoice } from './voice-read'
import { changeVoice } from './voice-change'
import type { VcRun } from '../shared/voice-change'
import { forgetKept, keep, kept } from './eleven-cache'
import type { ElevenAccount, ElevenModel } from '../shared/api'
import * as capcut from './capcut'
import { Vmake, VmakeAuthError } from './vmake'
import { known as vmakeKnown, learn as vmakeLearn } from './vmake-catalog'
import * as vmakeJobs from './vmake-jobs'
import { FAKE } from './vmake-jobs'
import { FAKE as ELEVEN_FAKE } from './dub-voice'

const NAMES: SecretName[] = ['vmake', 'elevenlabs']

function failure(e: unknown) {
  return { error: (e as Error).message || String(e), auth: e instanceof VmakeAuthError || (e instanceof ElevenError && e.auth) }
}

/** Runs an ElevenLabs call with the saved key; errors come back as `{ error, auth }`. */
async function eleven<T>(f: (el: ElevenLabs) => Promise<T>) {
  try {
    return await f(new ElevenLabs(getSecret('elevenlabs') ?? ''))
  } catch (e) {
    return failure(e)
  }
}

/** The script a voiceover was read from, kept beside it, so its captions can be checked against it. */
/** Captions being heard, by the page's task: Cancel stops them. */
const transcribing = new Map<string, AbortController>()
const scriptFile = (sound: string) => `${sound.replace(/\.[^.\\/]+$/, '')}.script.txt`
/** What the voice actually says: ElevenLabs' audio tags ("[whispers]") and SSML breaks are not words. */
const spoken = (text: string) => text.replace(/\[[^\]]*\]|<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()

/**
 * The test stand-in for Voice Design (STUDIO_ELEVEN_FAKE=1): never calls ElevenLabs. Three
 * "voices" are a second of tone each, a step apart, saying the text given or one of its own.
 */
function fakeDesign(o: { description: string; text?: string; model: string }) {
  if (o.description.trim().length < 20) return { error: 'ElevenLabs: the description must be at least 20 characters' }
  const wav = (hz: number) => {
    const rate = 16_000
    const pcm = Buffer.alloc(rate * 2)
    for (let i = 0; i < rate; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2)
    const head = Buffer.alloc(44)
    head.write('RIFF', 0)
    head.writeUInt32LE(36 + pcm.length, 4)
    head.write('WAVEfmt ', 8)
    head.writeUInt32LE(16, 16)
    head.writeUInt16LE(1, 20)
    head.writeUInt16LE(1, 22)
    head.writeUInt32LE(rate, 24)
    head.writeUInt32LE(rate * 2, 28)
    head.writeUInt16LE(2, 32)
    head.writeUInt16LE(16, 34)
    head.write('data', 36)
    head.writeUInt32LE(pcm.length, 40)
    return `data:audio/wav;base64,${Buffer.concat([head, pcm]).toString('base64')}`
  }
  return { text: o.text?.trim() || 'A line written for the description, as ElevenLabs does.', previews: [220, 330, 440].map((hz, i) => ({ id: `fake-preview-${i + 1}`, audio: wav(hz), seconds: 1 })) }
}

/**
 * Opens a package in Director (director://inbox/<folder>), if something handles that link.
 * False when nothing does or it fails; tests (their own inbox) never start an app.
 */
async function openDirector(url: string): Promise<boolean> {
  if (process.env.STUDIO_DIRECTOR_INBOX) return false
  if (!app.getApplicationNameForProtocol(url)) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
}

/** Files the page may write: recordings inside a project's `recordings` folder. */
const RECORDING = /\.studio[\\/]recordings[\\/][^\\/]+\.(webm|wav|ogg)$/i

export function registerServices() {
  dropRetiredSecrets()
  ipcMain.handle('secrets:status', () => Object.fromEntries(NAMES.map((n) => [n, hasSecret(n)])))
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => (NAMES.includes(name) ? { stored: setSecret(name, value) } : { error: 'unknown key' }))
  ipcMain.handle('secrets:clear', (_e, name: SecretName) => {
    if (NAMES.includes(name)) clearSecret(name)
    if (name === 'elevenlabs') forgetKept()
  })

  // The test stand-in's account: nothing is asked of Vmake.
  const fake = () => {
    const k = vmakeKnown()
    return { ...k, balance: 1000, checked: Date.now(), prices: Object.fromEntries(Object.keys(k.models).map((m) => [m, { credits: 0, durationLimit: 0, remain: null }])) }
  }
  // What Vmake offers as last seen, at once; then the account itself (which updates that).
  ipcMain.handle('vmake:known', () => (FAKE ? fake() : vmakeKnown()))
  const askVmake = async () => {
    const a = await new Vmake(getSecret('vmake') ?? '').account()
    return vmakeLearn(a.balance, a.offers)
  }
  ipcMain.handle('vmake:account', async () => {
    if (FAKE) return fake()
    try {
      return await askVmake()
    } catch (e) {
      return failure(e)
    }
  })
  // Freshened once a little after start, so Remove text opens with today's prices and balance.
  if (!FAKE && !process.env.STUDIO_UI_CHECK && !process.env.STUDIO_PAGE_SCRIPT) app.whenReady().then(() => setTimeout(() => hasSecret('vmake') && askVmake().catch(() => {}), 4000))

  // Text removal runs as jobs kept beside the project (vmake-jobs.ts): the page makes one,
  // cuts the clip's part, starts it, and applies the result when it's done (`vmake:job`).
  const tried = <T>(f: () => T) => {
    try {
      return f()
    } catch (e) {
      return failure(e)
    }
  }
  ipcMain.handle('vmake:create', (_e, o: Parameters<typeof vmakeJobs.create>[0]) => tried(() => vmakeJobs.create(o)))
  ipcMain.handle('vmake:start', (_e, id: string, o: { source: string; removeSource?: boolean }) => tried(() => vmakeJobs.start(id, o)))
  ipcMain.handle('vmake:cancel', (_e, id: string, error?: string) => vmakeJobs.cancel(id, error))
  ipcMain.handle('vmake:jobs', (_e, project: string) => vmakeJobs.list(project))
  ipcMain.handle('vmake:settled', (_e, id: string) => vmakeJobs.settled(id))
  // Jobs left running when the app last closed go on.
  app.whenReady().then(vmakeJobs.resumeAll)

  // Stems from the stems server (stems.ts): the page names the clip's stretch of its file; the
  // part is cut, sent and the stems brought back into the project here. A project's jobs are
  // picked up again when it's listed (opened).
  ipcMain.handle('stems:start', (_e, o: Parameters<typeof stems.start>[0]) => tried(() => stems.start(o)))
  ipcMain.handle('stems:jobs', (_e, project: string) => stems.list(project))
  ipcMain.handle('stems:cancel', (_e, dir: string) => stems.cancel(dir))

  // Visual dub (dub.ts): runs on its own beside the project; the page puts a ready one on the
  // timeline and says so.
  ipcMain.handle('dub:start', (_e, o: Parameters<typeof dub.start>[0]) => tried(() => dub.start(o)))
  ipcMain.handle('dub:jobs', (_e, project: string) => dub.list(project))
  ipcMain.handle('dub:summary', (_e, projects: string[]) => dub.summary(projects))
  ipcMain.handle('dub:reroll', (_e, id: string, lineIds: string[], edits?: Record<string, string>) => dub.reroll(id, lineIds, edits).catch((e: Error) => ({ error: e.message })))
  ipcMain.handle('dub:pickTake', (_e, id: string, lineId: string, take: number) => tried(() => dub.pickTake(id, lineId, take)))
  ipcMain.handle('dub:go', (_e, id: string, o: Parameters<typeof dub.go>[1]) => dub.go(id, o))
  ipcMain.handle('dub:keepClone', (_e, id: string, keep: boolean) => dub.keepClone(id, keep).catch((e: Error) => ({ error: e.message })))
  ipcMain.handle('dub:retry', (_e, id: string, change?: Parameters<typeof dub.retry>[1]) => tried(() => dub.retry(id, change)))
  ipcMain.handle('dub:removeAgain', (_e, id: string) => tried(() => dub.removeAgain(id)))
  ipcMain.handle('dub:cancel', (_e, id: string) => dub.cancel(id))
  ipcMain.handle('dub:result', (_e, id: string) => tried(() => dub.result(id)))
  ipcMain.handle('dub:draft', (_e, id: string, which: 'review' | 'says', value: unknown) => tried(() => dub.saveDraft(id, which, value)))
  ipcMain.handle('dub:applied', (_e, id: string) => dub.applied(id))
  ipcMain.handle('dub:failed', (_e, id: string, reason: string) => dub.failed(id, reason))

  // Translations (translate.ts): a project made again in other languages, one copy per language.
  ipcMain.handle('translate:context', (_e, project: string, paths: string[]) => tried(() => translate.context(project, paths)))
  ipcMain.handle('translate:start', (_e, o: translate.TrStart) => tried(() => translate.start(o)))
  ipcMain.handle('translate:readVoice', async (_e, project: string, file: string) => {
    try {
      return { ok: true as const, sentences: (await readVoice(project, file)).sentences.length }
    } catch (e) {
      return failure(e)
    }
  })
  ipcMain.handle('translate:voices', async () => {
    try {
      return await accountVoices()
    } catch (e) {
      return failure(e)
    }
  })
  // Media › Download (download.ts): links looked up, downloaded on the server, saved into the project.
  ipcMain.handle('download:probe', (_e, url: string) => tried(() => download.probe(url)))
  ipcMain.handle('download:start', (_e, project: string, picks: Parameters<typeof download.start>[1]) => tried(() => download.start(project, picks)))
  ipcMain.handle('download:list', (_e, project: string) => download.list(project))
  ipcMain.handle('download:cancel', (_e, id: string) => download.cancel(id))
  ipcMain.handle('download:imported', (_e, id: string) => download.imported(id))
  ipcMain.handle('translate:chooseVoice', (_e, project: string, key: string, choice: Parameters<typeof translate.chooseVoice>[2]) => translate.chooseVoice(project, key, choice))
  ipcMain.handle('translate:jobs', (_e, project: string) => translate.list(project))
  ipcMain.handle('translate:summary', (_e, projects: string[]) => translate.summary(projects))
  ipcMain.handle('translate:go', (_e, id: string, o: Parameters<typeof translate.go>[1]) => translate.go(id, o))
  ipcMain.handle('translate:retry', (_e, id: string) => translate.retry(id))
  ipcMain.handle('translate:cancel', (_e, id: string) => translate.cancel(id))
  ipcMain.handle('translate:result', (_e, id: string) => tried(() => translate.result(id)))
  // Change words said: the copy's sentences said again with new words (translate.ts `respeak`).
  ipcMain.handle('translate:respeak', async (_e, project: string, edits: Record<string, string>) => {
    try {
      return await translate.respeak(project, edits)
    } catch (e) {
      return failure(e)
    }
  })
  // What the copy's sentences say now, and what each said in the language it was translated from.
  ipcMain.handle('translate:spoken', (_e, project: string) =>
    tried(() => {
      const dir = path.join(project, 'translation')
      const read = <T>(f: string): T | null => (fs.existsSync(path.join(dir, f)) ? (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T) : null)
      const job = read<{ lang: string; from: string }>('job.json')
      const items = read<{ items: { id: string; text: string }[] }>('items.json')?.items ?? []
      const lines = read<{ lines: { id: string; file: string; text: string; dur: number }[] }>('voice.json')?.lines ?? []
      return { lang: job?.lang ?? '', from: job?.from ?? '', lines: lines.map((l) => ({ id: l.id, file: l.file, text: l.text, dur: l.dur, original: items.find((i) => i.id === l.id)?.text ?? '' })) }
    }),
  )
  ipcMain.handle('translate:draft', (_e, id: string, value: translate.TrDraft | null) => tried(() => translate.saveDraft(id, value)))
  ipcMain.handle('translate:applied', (_e, id: string) => translate.applied(id))
  ipcMain.handle('translate:failed', (_e, id: string, reason: string) => translate.failed(id, reason))

  // Import from CapCut (capcut.ts): CapCut's projects, and one read into Studio's terms with its
  // fonts, stickers and filters copied into the new project (`into`).
  ipcMain.handle('capcut:list', () => tried(() => capcut.list()))
  ipcMain.handle('capcut:read', (_e, dir: string, into: string) => capcut.read(dir, into).catch((e: Error) => failure(e)))
  // Where CapCut's projects are looked for, and pointing Studio at another folder of them.
  ipcMain.handle('capcut:root', () => capcut.capcutRoot())
  ipcMain.handle('capcut:setRoot', (_e, dir: string) => tried(() => capcut.chooseRoot(dir) ?? { error: 'There are no CapCut projects in that folder.' }))
  // A project's own fonts (<project>.studio/fonts): each file and the family it's drawn with.
  ipcMain.handle('fonts:project', (_e, project: string) => {
    const dir = path.join(project, 'fonts')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).map((f) => ({ family: f.replace(/\.[^.]+$/, ''), path: path.join(dir, f) }))
  })

  // After a key is pasted: the three checks that cost nothing and change nothing (account,
  // one voice, the models). Text to speech and speech to speech can't be checked without
  // spending credits; the permissions table in the page covers those.
  ipcMain.handle('eleven:checkKey', async () => {
    let el: ElevenLabs
    try {
      el = new ElevenLabs(getSecret('elevenlabs') ?? '')
    } catch (e) {
      return { works: false, notAllowed: [], error: (e as Error).message }
    }
    const checks: [string, () => Promise<unknown>][] = [
      ['user_read', () => el.subscription()],
      ['voices_read', () => el.voicesPage()],
      ['models_read', () => el.models()],
    ]
    const notAllowed: string[] = []
    // ElevenLabs not answering one of these says nothing about the key (it has gone silent on
    // an account's voices and details while speaking); the check goes on with the others.
    const silent: string[] = []
    for (const [id, run] of checks) {
      try {
        await run()
      } catch (e) {
        if (e instanceof ElevenError && e.code === 'timeout') silent.push(({ user_read: 'your account details', voices_read: 'your voice list' } as Record<string, string>)[id] ?? 'the models')
        else if (e instanceof ElevenError && !e.auth && (e.code === 'missing_permissions' || e.message.includes("isn't allowed"))) notAllowed.push(elevenPermissionName(id))
        else if (e instanceof ElevenError && e.auth) return { works: false, notAllowed: [], error: e.message }
        else return { works: false, notAllowed, error: (e as Error).message }
      }
    }
    return { works: true, notAllowed, silent }
  })
  // Each answer kept, so the next start shows it at once (`eleven:kept`).
  const answered = (r: unknown) => !(r && typeof r === 'object' && 'error' in r)
  ipcMain.handle('eleven:kept', () => kept())
  ipcMain.handle('eleven:recent', () => eleven((el) => el.recentVoices()))
  ipcMain.handle('eleven:account', async () => {
    const r = await eleven((el) => el.subscription())
    if (answered(r)) keep({ account: r as ElevenAccount })
    return r
  })
  ipcMain.handle('eleven:models', async () => {
    const r = await eleven((el) => el.models())
    if (answered(r)) keep({ models: r as ElevenModel[] })
    return r
  })
  ipcMain.handle('eleven:voices', async (_e, search?: string) => {
    const r = await eleven((el) => el.voices(search ?? ''))
    if (!search && answered(r)) keep({ voices: r as Voice[], voicesAt: Date.now() })
    return r
  })
  ipcMain.handle('eleven:library', (_e, search: string) => eleven((el) => el.library(search)))
  ipcMain.handle('eleven:speak', (_e, o: { voice: Voice; text: string; modelId: string; stability: number; similarity: number; speed?: number; languageCode?: string; out: string }) =>
    eleven(async (el) => {
      if (!o.out.toLowerCase().endsWith('.mp3')) throw new Error('The voiceover must be an .mp3 file.')
      // A Voice Library voice has to be in the account before it can speak.
      const id = o.voice.category === 'library' && o.voice.ownerId ? await el.addLibraryVoice(o.voice.ownerId, o.voice.id, o.voice.name) : o.voice.id
      await el.speak({ voiceId: id, text: o.text, modelId: o.modelId, stability: o.stability, similarity: o.similarity, speed: o.speed, languageCode: o.languageCode, out: o.out })
      // Captions made from this voiceover are proofread against it (captions:transcribe).
      fs.writeFileSync(scriptFile(o.out), `${spoken(o.text)}\n`)
      // And the voice it was spoken with, so a translation can speak it again in another language.
      fs.writeFileSync(`${o.out.replace(/\.[^.\\/]+$/, '')}.voice.json`, JSON.stringify({ voiceId: id, name: o.voice.name, modelId: o.modelId, stability: o.stability, similarity: o.similarity, speed: o.speed ?? 1, languageCode: o.languageCode }, null, 1))
      return { out: o.out, voiceId: id }
    }),
  )
  // Change voice: a stretch of a recording in another voice (voice-change.ts), with its progress.
  ipcMain.handle('voice:change', async (e, o: { taskId: string; project: string; run: VcRun; voice: Voice; removeNoise: boolean; out: string }) => {
    if (!o.out.toLowerCase().endsWith('.mp3')) return { error: 'The result must be an .mp3 file.' }
    const send = (stage: string, fraction: number) => !e.sender.isDestroyed() && e.sender.send('task:progress', { taskId: o.taskId, stage, fraction })
    try {
      return await changeVoice(o, send)
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle('eleven:clone', (_e, o: { name: string; files: string[]; removeNoise: boolean }) => eleven(async (el) => ({ voiceId: await el.clone(o) })))
  // Design a voice from a description: a round of three previews, then the one picked kept.
  ipcMain.handle('eleven:design', (_e, o: { description: string; text?: string; model: string }) => (ELEVEN_FAKE ? fakeDesign(o) : eleven((el) => el.design(o))))
  ipcMain.handle('eleven:saveDesigned', (_e, o: { name: string; description: string; previewId: string; heard?: string[] }) =>
    ELEVEN_FAKE ? (/^fake-preview-\d$/.test(o.previewId) ? { voiceId: `fake-designed-${o.previewId.slice(-1)}` } : { error: 'Not one of the previews' }) : eleven(async (el) => ({ voiceId: await el.saveDesigned(o) })),
  )
  // Captions: the stretches of sound a track is made of, each cut here to 16 kHz mono and
  // joined with a moment of silence between them, go to the transcript server as one recording
  // (one job however many clips, so the hourly limit lasts), with the script they were read
  // from. Each word comes back with its stretch and its time from that stretch's start.
  ipcMain.handle('captions:cancel', (_e, taskId: string) => void transcribing.get(taskId)?.abort())
  ipcMain.handle('captions:transcribe', async (e, o: { taskId: string; parts: { path: string; startUs: number; durationUs: number }[]; language?: string; script?: string }) => {
    const send = (stage: string, fraction: number) => !e.sender.isDestroyed() && e.sender.send('task:progress', { taskId: o.taskId, stage, fraction })
    const stop = new AbortController()
    transcribing.set(o.taskId, stop)
    try {
      const rate = 16_000
      const gap = Buffer.alloc(Math.round(rate * 0.8) * 2)
      const pcm: Buffer[] = []
      const starts: number[] = []
      let bytes = 0
      let sound = 0
      for (const [i, p] of o.parts.entries()) {
        if (stop.signal.aborted) throw new Error('Cancelled.')
        if (!p.path || !fs.existsSync(p.path)) throw new Error(`${path.basename(p.path || 'A sound')} is missing.`)
        send(o.parts.length > 1 ? `Cutting the sound (${i + 1} of ${o.parts.length})` : 'Cutting the sound', 0.02 + (0.06 * i) / o.parts.length)
        const raw = await ffmpeg(['-ss', (Math.max(0, p.startUs) / 1e6).toFixed(3), '-t', Math.max(0.2, p.durationUs / 1e6).toFixed(3), '-i', p.path, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'])
        if (pcm.length) {
          pcm.push(gap)
          bytes += gap.length
        }
        starts.push(bytes / (rate * 2))
        pcm.push(raw)
        bytes += raw.length
        sound += raw.length
      }
      if (sound < rate * 2 * 0.2) throw new Error('That part has no sound.')
      const audio = await ffmpeg(['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', '-f', 'flac', 'pipe:1'], { stdin: Buffer.concat(pcm) })
      send('Sending the sound to the server', 0.1)
      const r = await transcribe({ audio, fileName: 'captions.flac', language: o.language, script: o.script, progress: (stage, f, queue) => send(stageText(stage, queue), 0.1 + 0.55 * f), signal: stop.signal })
      // Stretches with sound the server gave no words for (Whisper jumps ahead now and then,
      // shared/caption-holes.ts): heard again on their own, once, and their words put in place.
      let heard = r.words
      const whole = Buffer.concat(pcm)
      const holes = holesOf(levelsOf(whole), heard)
      if (holes.length) {
        send(`Listening again to ${holes.length === 1 ? 'a part' : `${holes.length} parts`} it skipped`, 0.68)
        const bits: Buffer[] = []
        const at: { from: number; into: number }[] = []
        let len = 0
        for (const h of holes) {
          const a = Math.max(0, h.start - 0.2)
          const b = Math.min(whole.length / (rate * 2), h.end + 0.2)
          if (bits.length) {
            bits.push(gap)
            len += gap.length
          }
          at.push({ from: a, into: len / (rate * 2) })
          const piece = whole.subarray(Math.floor(a * rate) * 2, Math.floor(b * rate) * 2)
          bits.push(piece)
          len += piece.length
        }
        try {
          const again = await transcribe({ audio: await ffmpeg(['-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', '-c:a', 'flac', '-f', 'flac', 'pipe:1'], { stdin: Buffer.concat(bits) }), fileName: 'captions-again.flac', language: o.language, progress: (stage, f, queue) => send(stageText(stage, queue), 0.68 + 0.2 * f), signal: stop.signal })
          const back = again.words.map((w) => {
            let k = 0
            while (k + 1 < at.length && at[k + 1].into <= w.start + 0.05) k++
            const d = at[k].from - at[k].into
            return { ...w, start: w.start + d, end: w.end + d }
          })
          heard = mergeWords(heard, back)
        } catch (e) {
          // Nothing more heard (music, or the server busy): the words from the first time stand.
          if (stop.signal.aborted) throw e
        }
      }
      // The stretch a time falls in; a word in a gap belongs to the stretch before it.
      const partOf = (t: number) => {
        let k = 0
        while (k + 1 < starts.length && starts[k + 1] <= t + 0.05) k++
        return k
      }
      return {
        words: heard.map((w) => {
          const k = partOf(w.start)
          return { part: k, word: w.word, start: Math.max(0, w.start - starts[k]), end: Math.max(0, w.end - starts[k]) }
        }),
        language: r.language,
        changes: r.changes.map((c) => {
          const k = partOf(c.at)
          return { part: k, heard: c.heard, script: c.script, note: c.note, at: Math.max(0, c.at - starts[k]) }
        }),
        summary: r.summary,
        unchecked: r.unchecked,
      }
    } catch (err) {
      return failure(err)
    } finally {
      transcribing.delete(o.taskId)
    }
  })
  // The scripts these sounds were read from (each voiceover keeps its own), joined in order.
  ipcMain.handle('captions:scripts', (_e, paths: string[]) => {
    const texts: string[] = []
    for (const p of new Set(paths)) {
      const f = scriptFile(p)
      if (fs.existsSync(f)) texts.push(fs.readFileSync(f, 'utf8').trim())
    }
    return texts.filter(Boolean).join('\n\n')
  })

  // Send to Director (director.ts): the page has the engine render the voice into a package
  // folder in Director's inbox, then it's handed over here and Director asked to open it.
  const inbox = () => inboxDir(app.getPath('appData'))
  ipcMain.handle('director:about', (_e, paths: unknown) => aboutVoices(Array.isArray(paths) ? paths.slice(0, 256) : []))
  ipcMain.handle('director:begin', (_e, name: string) => {
    try {
      return { dir: beginPackage(inbox(), String(name ?? '')).dir }
    } catch (e) {
      return failure(e)
    }
  })
  ipcMain.handle('director:discard', (_e, dir: string) => discardPackage(inbox(), dir))
  ipcMain.handle('director:finish', async (_e, o: { dir: string; name: string; clips: VoiceClip[]; labels: TimeLabel[]; script: string | null; language: string | null; open: boolean }) => {
    if (!isPartial(inbox(), o.dir)) return { error: 'That isn’t a package being sent to Director.' }
    try {
      const send = sendFile(o)
      const folder = finishPackage(o.dir, send)
      const opened = o.open ? await openDirector(directorUrl(path.basename(folder))) : false
      return { folder, opened, phrases: send.phrases.length, duration: send.duration }
    } catch (e) {
      discardPackage(inbox(), o.dir)
      return failure(e)
    }
  })

  registerFiles()
  registerSounds()

  ipcMain.handle('file:saveRecording', (_e, file: string, data: ArrayBuffer) => {
    if (!RECORDING.test(file)) return { error: 'Recordings are saved in the project folder only.' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data))
    return { out: file }
  })
}
