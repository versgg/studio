// Stems: a clip's sound split into its parts by the stems server's audio read
// (ORIGIN below; STUDIO_STEMS_URL points elsewhere; AudioShake underneath; no key, the
// service limits each address instead: two jobs at a time and an hourly cap). Only the stretch
// of the source the clip plays is sent, at the source's own speed, cut here by FFmpeg (WAV up to
// a minute, MP3 at 320 kbps above). The page puts the stems back at the clip's place, speed and
// direction (`timeline.addStems` in the engine), so they play in sync with it.
//
// The contract:
//   POST /api/jobs (multipart: file, mode=audio)   → { job } (or { cached, key })
//   GET  /api/jobs/{job}                            → { status, stage, queue_position, result_key, error, elapsed, log }
//   GET  /api/results/{key}                         → audio.stems: { items: [{ name, peaks, duration, url }] } | { status: 'running' } | { error }
//   POST /api/results/{key}/stems                   → separates a saved read's stems again (its sound is kept a week)
//   GET  /api/results/{key}/stems/{name}.mp3        → one stem (kept a week)
// An audio read waits for its stems before it's done, so they're "running" afterwards only
// when a saved read is being separated again. Errors come back as { detail }, shown as they are
// (a 429 says which limit). AudioShake sends all 20 stems; most are empty for a given sound,
// and the service doesn't say which, so each is measured here (SILENT_DB, shared/stems.ts).
//
// Each job lives in its own folder in the project (`<project>.studio/stems/<name> <id>/`, with
// job.json and the stems), so it outlives the app: when the project is next opened a job is
// picked up by its result key, its job id on the server, or the part cut for it (sent again, the server's
// cache then answers at once). The page imports a stem when it's played or used.
//
// STUDIO_STEMS_FAKE=1 (tests): a stand-in that never goes online. A job takes
// STUDIO_STEMS_FAKE_MS (4 s) through the same stages, and its "stems" are FFmpeg filters of
// the part (a low-pass for bass, a band-pass for vocals; piano and strings silent).

import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'
import { MAX_SECONDS, MIN_SECONDS, expectedMs, measure, running, separatingFraction, sortStems, stemLabel, type Song, type Stem, type StemsJob } from '../shared/stems'

const ORIGIN = process.env.STUDIO_STEMS_URL ?? 'https://video.basalt.codes'
export const FAKE = process.env.STUDIO_STEMS_FAKE === '1'
const POLL_MS = FAKE ? 250 : 2000
const LIMIT_MS = 30 * 60_000
/** A part this long or shorter goes as WAV (lossless, ≤ 10 MB); longer as MP3. */
const WAV_SECONDS = 60

class StemsError extends Error {}
/** The server no longer has that job or file. */
class Gone extends StemsError {}

/** Every job known in this session, by its folder. */
const jobs = new Map<string, StemsJob>()
/** The jobs running here, with the switch that stops each. */
const live = new Map<string, AbortController>()
/** Projects whose stems folder has been read. */
const loaded = new Set<string>()

const key = (dir: string) => {
  const d = path.resolve(dir)
  return process.platform === 'win32' ? d.toLowerCase() : d
}
const inside = (file: string, dir: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(file))
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}
const isProject = (dir: string) => fs.existsSync(path.join(dir, 'project.json'))
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
  })
const rm = (file: string | undefined) => {
  try {
    if (file) fs.rmSync(file, { force: true })
  } catch {}
}
/** A name that's safe in a folder or file name on every system. */
const safe = (s: string) => s.replace(/\.[^.\\/]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Sound'
/** The part cut for a job, if it's still there. */
const partOf = (job: StemsJob) => ['part.wav', 'part.mp3'].map((f) => path.join(job.dir, f)).find((f) => fs.existsSync(f))

// Saving: job.json holds everything but where it is (the folder can move with a copy of the project).

interface Saved extends Omit<StemsJob, 'project' | 'dir' | 'stems'> {
  stems?: (Omit<Stem, 'path'> & { file: string })[]
  /** The server answered from a read it had saved (so its stems may be separated again once if they'd failed). */
  saved?: boolean
  /** Sent again with force after the saved stems were gone. */
  forced?: boolean
}
type Job = StemsJob & { saved?: boolean; forced?: boolean }

function save(job: Job) {
  if (!fs.existsSync(job.dir)) return
  const { project: _p, dir: _d, stems, ...rest } = job
  const out: Saved = { ...rest, ...(stems ? { stems: stems.map(({ path: p, ...s }) => ({ ...s, file: path.basename(p) })) } : {}) }
  const file = path.join(job.dir, 'job.json')
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 1))
    fs.renameSync(`${file}.tmp`, file)
  } catch (e) {
    console.error(`[stems] couldn't save ${file}: ${(e as Error).message}`)
  }
}

function read(dir: string, project: string): Job | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) as Saved
    if (!s?.id || !s.mediaId || typeof s.inUs !== 'number') return null
    const { stems, ...rest } = s
    return { ...rest, project, dir, ...(stems ? { stems: stems.map(({ file, ...x }) => ({ ...x, path: path.join(dir, file) })) } : {}) }
  } catch {
    return null
  }
}

function send(job: StemsJob) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('stems:job', job)
}

/** Changes a job, saves it and tells the windows. A job dropped meanwhile stays gone. */
function patch(job: Job, p: Partial<Job>) {
  if (jobs.get(key(job.dir)) !== job) return
  Object.assign(job, p)
  save(job)
  send(job)
}

// The server, or the test stand-in.

interface RemoteJob {
  status: 'queued' | 'running' | 'done' | 'error'
  stage: string
  queue_position: number
  result_key: string | null
  error: string | null
  log?: { stage: string }[]
}
interface RemoteStems {
  status?: string
  error?: string
  items?: { name: string; duration?: number }[]
  /** The read's `audio.music`: Shazam's matches, or one named from the lyrics. */
  music?: RemoteSong[]
}
interface RemoteSong {
  title?: string
  artist?: string
  album?: string
  released?: string
  genre?: string
  shazam_url?: string
  cover?: string
  heard_at?: number
  track_at?: number
  note?: string
  source?: string
}
interface Remote {
  send(file: string, force: boolean, signal: AbortSignal): Promise<{ job?: string; key?: string }>
  job(id: string, signal: AbortSignal): Promise<RemoteJob>
  stems(key: string, signal: AbortSignal): Promise<RemoteStems>
  again(key: string, signal: AbortSignal): Promise<void>
  download(job: StemsJob, name: string, out: string, signal: AbortSignal): Promise<void>
}

async function detail(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return body.detail
  } catch {}
  return `The server answered HTTP ${r.status}.`
}

async function get(url: string, signal: AbortSignal, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  let r: Response
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
  } catch (e) {
    if (signal.aborted) throw e
    throw new StemsError(`The server couldn't be reached: ${(e as Error).message}`)
  }
  if (r.status === 404) throw new Gone(await detail(r))
  if (!r.ok) throw new StemsError(await detail(r))
  return r
}

const online: Remote = {
  async send(file, force, signal) {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(fs.readFileSync(file))]), path.basename(file))
    form.append('mode', 'audio')
    if (force) form.append('force', '1')
    const r = await get(`${ORIGIN}/api/jobs`, signal, { method: 'POST', body: form }, 10 * 60_000)
    return (await r.json()) as { job?: string; key?: string }
  },
  async job(id, signal) {
    return (await (await get(`${ORIGIN}/api/jobs/${encodeURIComponent(id)}`, signal)).json()) as RemoteJob
  },
  async stems(k, signal) {
    const r = (await (await get(`${ORIGIN}/api/results/${encodeURIComponent(k)}`, signal)).json()) as { audio?: { stems?: RemoteStems; music?: RemoteSong[] } }
    return { ...(r.audio?.stems ?? { error: 'The server kept no stems with that read.' }), music: r.audio?.music ?? [] }
  },
  async again(k, signal) {
    await get(`${ORIGIN}/api/results/${encodeURIComponent(k)}/stems`, signal, { method: 'POST' })
  },
  async download(_job, name, out, signal) {
    const r = await get(`${ORIGIN}/api/results/${encodeURIComponent(_job.key!)}/stems/${encodeURIComponent(name)}.mp3`, signal, {}, 120_000)
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()))
  },
}

/**
 * The songs the server's read named, in Studio's words, each cover saved beside the stems (a cover
 * that won't come is left out; the song still shows).
 */
async function songsOf(music: RemoteSong[], dir: string, signal: AbortSignal): Promise<Song[]> {
  const out: Song[] = []
  for (const [i, t] of music.entries()) {
    if (!t.title) continue
    let cover: string | undefined
    if (t.cover && /^https:\/\//.test(t.cover)) {
      try {
        const r = await fetch(t.cover, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
        if (r.ok) {
          cover = path.join(dir, `cover-${i + 1}.jpg`)
          fs.writeFileSync(cover, Buffer.from(await r.arrayBuffer()))
        }
      } catch {}
    }
    out.push({
      title: t.title,
      artist: t.artist || undefined,
      album: t.album || undefined,
      released: t.released || undefined,
      genre: t.genre || undefined,
      url: t.shazam_url && /^https:\/\/(www\.)?shazam\.com\//.test(t.shazam_url) ? t.shazam_url : undefined,
      cover,
      heardAt: t.heard_at,
      trackAt: t.track_at,
      note: t.note || undefined,
      fromLyrics: t.source === 'lyrics' || undefined,
    })
  }
  return out
}

/** The stand-in's "stems": FFmpeg filters of the part, in the server's names. */
const FAKE_STEMS: [string, string][] = [
  ['instrumental', 'highpass=f=120,lowpass=f=8000'],
  ['vocals', 'bandpass=f=1000:width_type=h:w=1800'],
  ['drums', 'highpass=f=3000'],
  ['bass', 'lowpass=f=180'],
  ['piano', 'volume=0'],
  ['strings', 'volume=0.00001'],
]
let failNext: string | null = null

const stand: Remote = {
  async send(file, _force, signal) {
    await sleep(300, signal)
    if (failNext) {
      const why = failNext
      failNext = null
      throw new StemsError(why)
    }
    if (!fs.existsSync(file)) throw new StemsError('The part to send is gone.')
    // The job id carries when it started and how long it takes, so it goes on across a restart.
    return { job: `fake-${Date.now()}-${Number(process.env.STUDIO_STEMS_FAKE_MS) || 4000}` }
  },
  async job(id) {
    const [, t0, ms] = id.split('-').map(Number)
    const f = (Date.now() - t0) / ms
    if (!(t0 > 0)) throw new Gone('That job is gone.')
    if (f >= 1) return { status: 'done', stage: 'done', queue_position: 0, result_key: `fake${t0}`, error: null, log: [] }
    if (f < 0.15) return { status: 'queued', stage: 'queued', queue_position: 1, result_key: null, error: null }
    return { status: 'running', stage: f < 0.3 ? 'probe' : 'stems', queue_position: 0, result_key: null, error: null }
  },
  async stems() {
    return { items: FAKE_STEMS.map(([name]) => ({ name })), music: [{ title: 'Stand-in Song', artist: 'Studio Test Mode', album: 'Never Released', released: '2026', genre: 'Pop', heard_at: 0.5, track_at: 42 }] }
  },
  async again() {},
  async download(job, name, out) {
    const part = partOf(job)
    if (!part) throw new Gone('The part is gone.')
    const filter = FAKE_STEMS.find(([n]) => n === name)?.[1] ?? 'anull'
    await ffmpeg(['-i', part, '-af', filter, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', '-y', out])
  },
}

function remote(job: StemsJob): Remote {
  if (job.fake) return stand
  if (FAKE) throw new StemsError('Studio is in test mode (STUDIO_STEMS_FAKE), so it never calls the server.')
  return online
}

/** The server's stages, as the Stems tab says them. */
function stageText(stage: string): string {
  const said: Record<string, string> = { queued: 'The server has the sound', probe: 'The server is reading the sound', stems: 'Separating with AudioShake', audio: 'Separating with AudioShake', cache: 'The server had separated this before', done: 'The server is done' }
  return said[stage] ?? 'Separating with AudioShake'
}

/** Cuts the stretch of the source the clip plays: WAV (lossless) up to a minute, MP3 at 320 kbps above. */
async function cut(job: StemsJob): Promise<string> {
  if (!fs.existsSync(job.source)) throw new StemsError(`${path.basename(job.source)} is missing.`)
  const seconds = job.spanUs / 1e6
  const wav = seconds <= WAV_SECONDS
  const out = path.join(job.dir, wav ? 'part.wav' : 'part.mp3')
  const tmp = `${out}.tmp`
  try {
    await ffmpeg(['-ss', (job.inUs / 1e6).toFixed(3), '-t', seconds.toFixed(3), '-i', job.source, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100', ...(wav ? ['-c:a', 'pcm_s16le', '-f', 'wav'] : ['-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3']), '-y', tmp])
  } catch (e) {
    rm(tmp)
    throw new StemsError(/matches no streams/i.test((e as Error).message) ? `${path.basename(job.source)} has no sound.` : `Couldn't cut the sound: ${(e as Error).message}`)
  }
  // Under a fifth of a second of sound (the clip lies past the end of the file's sound).
  if (fs.statSync(tmp).size < (wav ? 44100 * 4 * 0.2 : 320_000 / 8 / 5)) {
    rm(tmp)
    throw new StemsError('That part of the file has no sound.')
  }
  fs.renameSync(tmp, out)
  return out
}

/** A stem's waveform, loudness and length, from its samples. */
async function measureFile(file: string) {
  const rate = 22_050
  const raw = await ffmpeg(['-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'])
  const pcm = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 2)))
  return { ...measure(pcm, rate), durationUs: Math.round((pcm.length / rate) * 1e6) }
}

/** Runs a job from where it is to its end. */
async function run(job: Job) {
  const k = key(job.dir)
  if (live.has(k) || !running(job)) return
  const stop = new AbortController()
  live.set(k, stop)
  const signal = stop.signal
  const gone = () => signal.aborted || jobs.get(k) !== job
  try {
    const remote_ = remote(job)
    let misses = 0
    let reran = false
    for (;;) {
      if (gone()) return
      // 1. Sent, and the server's job followed to its end.
      if (!job.key) {
        if (!job.remote) {
          let part = partOf(job)
          if (!part) {
            patch(job, { state: 'cutting', stage: 'Cutting out the clip’s sound', fraction: 0.02 })
            part = await cut(job)
          }
          if (gone()) return
          const mb = fs.statSync(part).size / 1e6
          patch(job, { state: 'uploading', stage: `Sending the sound to the server (${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB)`, fraction: 0.06 })
          const r = await remote_.send(part, !!job.forced, signal)
          if (gone()) return
          const sent = { sentAt: Date.now(), expectedMs: expectedMs(job.spanUs / 1e6) }
          if (r.key) patch(job, { key: r.key, saved: true, ...sent })
          else if (r.job) patch(job, { remote: r.job, state: 'waiting', stage: 'The server has the sound', queue: 0, fraction: 0.15, ...sent })
          else throw new StemsError('The server answered without a job.')
          continue
        }
        let st: RemoteJob
        try {
          st = await remote_.job(job.remote, signal)
          misses = 0
        } catch (e) {
          if (gone()) return
          // The server forgot the job (it restarted, or two hours passed): sent again, its cache answers if it got that far.
          if (e instanceof Gone) {
            patch(job, { remote: undefined })
            continue
          }
          // A dropped connection (a laptop waking up) is tried again a few times.
          if (++misses >= 5) throw e
          await sleep(POLL_MS * 2, signal)
          continue
        }
        if (gone()) return
        if (st.status === 'error') throw new StemsError(st.error || 'The server couldn’t read the sound.')
        if (st.status === 'done' && st.result_key) {
          patch(job, { key: st.result_key, saved: !!st.log?.some((l) => l.stage === 'cache') })
          continue
        }
        if (st.status === 'queued') patch(job, { state: 'waiting', queue: st.queue_position, stage: st.queue_position > 1 ? `Waiting at the server (${st.queue_position - 1} ahead)` : 'Waiting at the server', fraction: 0.15 })
        else patch(job, { state: 'separating', queue: 0, stage: stageText(st.stage), fraction: separatingFraction(Date.now() - (job.sentAt ?? job.startedAt), job.expectedMs ?? 60_000, job.fraction) })
        if (Date.now() - (job.sentAt ?? job.startedAt) > LIMIT_MS) throw new StemsError('The server didn’t finish within 30 minutes.')
        await sleep(POLL_MS, signal)
        continue
      }
      const stems: Stem[] = []
      let songs: Song[] = []
      try {
        // 2. The read's stems: there with it, or still being separated (a saved read separated again).
        const st = await remote_.stems(job.key, signal)
        if (gone()) return
        if (st.status === 'running') {
          patch(job, { state: 'separating', stage: 'Separating with AudioShake', fraction: separatingFraction(Date.now() - (job.sentAt ?? job.startedAt), job.expectedMs ?? 60_000, job.fraction) })
          if (Date.now() - (job.sentAt ?? job.startedAt) > LIMIT_MS) throw new StemsError('AudioShake didn’t finish within 30 minutes.')
          await sleep(POLL_MS * 1.5, signal)
          continue
        }
        if (st.error || !st.items?.length) {
          // A read the server had saved, whose stems had failed then: separated again, once.
          if (job.saved && !reran) {
            reran = true
            await remote_.again(job.key, signal)
            patch(job, { state: 'separating', stage: 'Separating with AudioShake', sentAt: Date.now(), expectedMs: expectedMs(job.spanUs / 1e6), fraction: 0.2 })
            continue
          }
          throw new StemsError(st.error ? `AudioShake couldn’t separate it: ${st.error}` : 'AudioShake sent back no stems.')
        }
        const items = sortStems(st.items)
        songs = await songsOf(st.music ?? [], job.dir, signal)
        // 3. Every stem brought back and measured.
        patch(job, { state: 'downloading', stage: 'Bringing the stems back', fraction: 0.88 })
        const base = safe(job.name)
        for (const [i, it] of items.entries()) {
          const file = path.join(job.dir, `${base} (${stemLabel(it.name)}).mp3`)
          await remote_.download(job, it.name, `${file}.part`, signal)
          if (gone()) return
          fs.renameSync(`${file}.part`, file)
          const m = await measureFile(file)
          stems.push({ name: it.name, label: stemLabel(it.name), path: file, durationUs: m.durationUs, peaks: m.peaks, levelDb: m.levelDb, silent: m.silent })
          patch(job, { stage: `Bringing the stems back (${i + 1} of ${items.length})`, fraction: 0.88 + (0.1 * (i + 1)) / items.length })
        }
      } catch (e) {
        // The server no longer keeps the read's sound or stems (a week passed): it's made again, once.
        if (e instanceof Gone && !job.forced && partOf(job)) {
          patch(job, { key: undefined, remote: undefined, forced: true })
          continue
        }
        throw e
      }
      rm(partOf(job))
      patch(job, { state: 'done', stage: 'Done', fraction: 1, stems, songs, queue: 0, finishedAt: Date.now() })
      return
    }
  } catch (e) {
    if (!gone()) {
      rm(partOf(job))
      patch(job, { state: 'failed', stage: 'Failed', reason: (e as Error).message || String(e), finishedAt: Date.now() })
    }
  } finally {
    if (live.get(k) === stop) live.delete(k)
  }
}

/** Reads a project's stems folder once, and picks up jobs left unfinished. */
function load(project: string) {
  const k = key(project)
  if (loaded.has(k)) return
  loaded.add(k)
  const root = path.join(project, 'stems')
  let names: string[] = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  for (const n of names) {
    const dir = path.join(root, n)
    if (jobs.has(key(dir))) continue
    const j = read(dir, project)
    if (!j) continue
    jobs.set(key(dir), j)
    if (running(j)) void run(j)
  }
}

/** Removes a job and its folder (one that never finished: nothing in it is used). */
function drop(job: StemsJob) {
  live.get(key(job.dir))?.abort()
  jobs.delete(key(job.dir))
  if (inside(job.dir, path.join(job.project, 'stems')))
    try {
      fs.rmSync(job.dir, { recursive: true, force: true })
    } catch {}
}

/** Starts separating the stretch of `source` a clip plays (`inUs`, `spanUs` of the source). */
export function start(o: { project: string; clipId: string; mediaId: string; name: string; source: string; inUs: number; spanUs: number }): StemsJob {
  if (!isProject(o.project)) throw new Error('That project folder is missing.')
  const seconds = o.spanUs / 1e6
  if (seconds > MAX_SECONDS) throw new Error(`The server separates up to ${MAX_SECONDS / 60} minutes of sound, and the clip plays ${Math.round(seconds)} s. Trim it first.`)
  if (seconds < MIN_SECONDS) throw new Error('The clip is too short to separate.')
  if (!fs.existsSync(o.source)) throw new Error(`${path.basename(o.source)} is missing.`)
  load(o.project)
  // An earlier try for this clip that failed is replaced by this one.
  for (const j of [...jobs.values()]) if (key(j.project) === key(o.project) && j.clipId === o.clipId && j.state === 'failed') drop(j)
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const dir = path.join(o.project, 'stems', `${safe(o.name)} ${id}`)
  fs.mkdirSync(dir, { recursive: true })
  const job: Job = {
    id,
    project: o.project,
    dir,
    clipId: o.clipId,
    mediaId: o.mediaId,
    name: o.name,
    source: o.source,
    inUs: Math.max(0, Math.round(o.inUs)),
    spanUs: Math.round(o.spanUs),
    state: 'cutting',
    stage: 'Cutting out the clip’s sound',
    fraction: 0.02,
    startedAt: Date.now(),
    expectedMs: expectedMs(seconds),
    ...(FAKE ? { fake: true } : {}),
  }
  jobs.set(key(dir), job)
  save(job)
  send(job)
  void run(job)
  return job
}

/** Stops a separation and removes what it made. The server carries on with its copy (and keeps the result). */
export function cancel(dir: string) {
  const job = jobs.get(key(dir))
  if (!job || !running(job)) return
  drop(job)
  send({ ...job, state: 'cancelled', stage: 'Cancelled' })
}

/** A project's separations (running, failed or done), read from its stems folder the first time. */
export function list(project: string): StemsJob[] {
  load(project)
  return [...jobs.values()].filter((j) => key(j.project) === key(project))
}

/** For the UI check, in fake mode only. */
export const stemsTest = {
  /** The next job is refused when it's sent, with this message (as the server's 429). */
  failNext(message: string) {
    if (FAKE) failNext = message
  },
  /** As if the app quit and started again: every job stops where it is, and is read back from disk. */
  restart() {
    if (!FAKE) return
    for (const c of live.values()) c.abort()
    live.clear()
    jobs.clear()
    loaded.clear()
  },
}
