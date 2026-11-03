// Outside services the page can use through IPC: saved keys, Vmake text removal, ElevenLabs
// voices and voiceovers, captions from the transcript server (checked against the voiceover's
// script), stems from the stems server, saving microphone recordings into the project, and
// (files.ts, sounds.ts) the files the page draws, frames for analysis, mattes, captions, the
// sound library and app settings.
// Keys never cross to the page; each handler reads the one it needs here.

import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { clearSecret, dropRetiredSecrets, getSecret, hasSecret, setSecret, type SecretName } from './secrets'
import { stageText, transcribe } from './transcript'
import { ElevenError, ElevenLabs, type Voice } from './elevenlabs'
import { elevenPermissionName } from '../shared/eleven-permissions'
import { ffmpeg } from './ffmpeg'
import { registerFiles } from './files'
import { registerSounds } from './sounds'
import * as dub from './dub'
import * as stems from './stems'
import * as translate from './translate'
import { accountVoices, pickVoice, readVoice } from './voice-read'
import * as capcut from './capcut'
import { Vmake, VmakeAuthError } from './vmake'
import { known as vmakeKnown, learn as vmakeLearn } from './vmake-catalog'
import * as vmakeJobs from './vmake-jobs'
import { FAKE } from './vmake-jobs'

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
const scriptFile = (sound: string) => `${sound.replace(/\.[^.\\/]+$/, '')}.script.txt`
/** What the voice actually says: ElevenLabs' audio tags ("[whispers]") and SSML breaks are not words. */
const spoken = (text: string) => text.replace(/\[[^\]]*\]|<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()

/** Files the page may write: recordings inside a project's `recordings` folder. */
const RECORDING = /\.studio[\\/]recordings[\\/][^\\/]+\.(webm|wav|ogg)$/i

export function registerServices() {
  dropRetiredSecrets()
  ipcMain.handle('secrets:status', () => Object.fromEntries(NAMES.map((n) => [n, hasSecret(n)])))
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => (NAMES.includes(name) ? { stored: setSecret(name, value) } : { error: 'unknown key' }))
  ipcMain.handle('secrets:clear', (_e, name: SecretName) => {
    if (NAMES.includes(name)) clearSecret(name)
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
  ipcMain.handle('dub:respeak', (_e, id: string, edits: Record<string, string>) => dub.respeak(id, edits).catch((e: Error) => ({ error: e.message })))
  ipcMain.handle('dub:go', (_e, id: string, o: Parameters<typeof dub.go>[1]) => dub.go(id, o))
  ipcMain.handle('dub:retry', (_e, id: string) => dub.retry(id))
  ipcMain.handle('dub:removeAgain', (_e, id: string) => tried(() => dub.removeAgain(id)))
  ipcMain.handle('dub:cancel', (_e, id: string) => dub.cancel(id))
  ipcMain.handle('dub:result', (_e, id: string) => tried(() => dub.result(id)))
  ipcMain.handle('dub:applied', (_e, id: string) => dub.applied(id))
  ipcMain.handle('dub:failed', (_e, id: string, reason: string) => dub.failed(id, reason))

  // Translations (translate.ts): a project made again in other languages, one copy per language.
  ipcMain.handle('translate:context', (_e, project: string, paths: string[]) => tried(() => translate.context(project, paths)))
  ipcMain.handle('translate:start', (_e, o: translate.TrStart) => tried(() => translate.start(o)))
  ipcMain.handle('translate:readVoice', async (_e, project: string, file: string) => {
    try {
      await readVoice(project, file)
      return { ok: true as const }
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
  ipcMain.handle('translate:pickVoice', (_e, project: string, file: string, voice: { voiceId: string; name: string } | null) => void pickVoice(project, file, voice))
  ipcMain.handle('translate:jobs', (_e, project: string) => translate.list(project))
  ipcMain.handle('translate:summary', (_e, projects: string[]) => translate.summary(projects))
  ipcMain.handle('translate:go', (_e, id: string, o: Parameters<typeof translate.go>[1]) => translate.go(id, o))
  ipcMain.handle('translate:retry', (_e, id: string) => translate.retry(id))
  ipcMain.handle('translate:cancel', (_e, id: string) => translate.cancel(id))
  ipcMain.handle('translate:result', (_e, id: string) => tried(() => translate.result(id)))
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
    for (const [id, run] of checks) {
      try {
        await run()
      } catch (e) {
        if (e instanceof ElevenError && !e.auth && (e.code === 'missing_permissions' || e.message.includes("isn't allowed"))) notAllowed.push(elevenPermissionName(id))
        else if (e instanceof ElevenError && e.auth) return { works: false, notAllowed: [], error: e.message }
        else return { works: false, notAllowed, error: (e as Error).message }
      }
    }
    return { works: true, notAllowed }
  })
  ipcMain.handle('eleven:account', () => eleven((el) => el.subscription()))
  ipcMain.handle('eleven:models', () => eleven((el) => el.models()))
  ipcMain.handle('eleven:voices', (_e, search?: string) => eleven((el) => el.voices(search ?? '')))
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
  ipcMain.handle('eleven:changeVoice', (_e, o: { voiceId: string; input: string; out: string; removeNoise: boolean }) =>
    eleven(async (el) => {
      if (!o.out.toLowerCase().endsWith('.mp3')) throw new Error('The result must be an .mp3 file.')
      await el.changeVoice(o)
      return { out: o.out }
    }),
  )
  ipcMain.handle('eleven:clone', (_e, o: { name: string; files: string[]; removeNoise: boolean }) => eleven(async (el) => ({ voiceId: await el.clone(o) })))
  // Captions: the stretches of sound a track is made of, each cut here to 16 kHz mono and
  // joined with a moment of silence between them, go to the transcript server as one recording
  // (one job however many clips, so the hourly limit lasts), with the script they were read
  // from. Each word comes back with its stretch and its time from that stretch's start.
  ipcMain.handle('captions:transcribe', async (e, o: { taskId: string; parts: { path: string; startUs: number; durationUs: number }[]; language?: string; script?: string }) => {
    const send = (stage: string, fraction: number) => !e.sender.isDestroyed() && e.sender.send('task:progress', { taskId: o.taskId, stage, fraction })
    try {
      const rate = 16_000
      const gap = Buffer.alloc(Math.round(rate * 0.8) * 2)
      const pcm: Buffer[] = []
      const starts: number[] = []
      let bytes = 0
      let sound = 0
      for (const [i, p] of o.parts.entries()) {
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
      const r = await transcribe({ audio, fileName: 'captions.flac', language: o.language, script: o.script, progress: (stage, f, queue) => send(stageText(stage, queue), 0.1 + 0.55 * f) })
      // The stretch a time falls in; a word in a gap belongs to the stretch before it.
      const partOf = (t: number) => {
        let k = 0
        while (k + 1 < starts.length && starts[k + 1] <= t + 0.05) k++
        return k
      }
      return {
        words: r.words.map((w) => {
          const k = partOf(w.start)
          return { part: k, word: w.word, start: Math.max(0, w.start - starts[k]), end: Math.max(0, w.end - starts[k]) }
        }),
        language: r.language,
        changes: r.changes.map((c) => {
          const k = partOf(c.at)
          return { part: k, heard: c.heard, script: c.script, note: c.note, at: Math.max(0, c.at - starts[k]) }
        }),
        summary: r.summary,
      }
    } catch (err) {
      return failure(err)
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

  registerFiles()
  registerSounds()

  ipcMain.handle('file:saveRecording', (_e, file: string, data: ArrayBuffer) => {
    if (!RECORDING.test(file)) return { error: 'Recordings are saved in the project folder only.' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data))
    return { out: file }
  })
}
