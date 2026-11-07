// Vmake text removal as jobs that outlive their project and the app. Each job is saved beside
// its project (`<project>.studio/jobs.json`), and userData's `vmake-jobs.json` lists the
// projects that have any, so the next start finds them. The main process runs every job to
// its end whichever project is open (upload, charge, poll, download); the page applies a
// finished one, or frees a failed one's clip, when its project is open (store.ts ›
// settleVmakeJob), then says so and the job is forgotten.
//
// After a restart: a job Vmake is working on is followed again by its record and task ids
// (Vmake's query needs nothing else), and a finished one is asked for again, for a fresh
// download link. One still uploading starts its upload again (nothing was charged yet). One
// that was being charged as the app closed can't be followed (Vmake's answer, with the ids,
// was lost), so it fails and says to check vmake.ai.
//
// Vmake only says "working" or "done", so the bar while it works is the clock against an
// estimate: the clip's seconds of video times the median wait per second of the account's
// last ten finished jobs (userData's `vmake-speed.json`; a first guess before any). The
// estimate is fixed when the job is charged and saved with it, so the bar and the time left
// hold across closing the project and restarting the app (src/shared/vmake-estimate.ts).
//
// STUDIO_VMAKE_FAKE=1 (tests): a stand-in that never goes online. A job takes
// STUDIO_VMAKE_FAKE_MS (10 s) by the clock (so it goes on while the app is closed, as
// Vmake's would) and, like Vmake, says only working or done; it learns and uses the same
// estimate. The "cleaned" video is the part blurred by FFmpeg: a real, different file.

import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'
import { getSecret } from './secrets'
import { expectedWait, HISTORY_SIZE, waitFraction } from '../shared/vmake-estimate'
import { Vmake, VmakeAuthError, VmakeError, VmakeUnreachable, type VmakeRef, type VmakeStatus } from './vmake'

export type JobState = 'preparing' | 'uploading' | 'charging' | 'working' | 'downloading' | 'done' | 'failed' | 'cancelled'

export interface VmakeJob {
  /** Also the clip's busy mark in the engine (`Clip::busy`). */
  id: string
  /** The project's `.studio` folder. */
  project: string
  /** The timeline clip it's for; none for a library item (the result then joins the library). */
  clipId?: string
  mediaId: string
  /** The file's name, for messages. */
  name: string
  title: string
  model: string
  /** The file sent: the clip's part, cut into the project's `cleaned/` folder, or the library file. */
  source?: string
  /** The source was cut for this job, and goes when it ends. */
  removeSource?: boolean
  /** Where the cleaned video goes (in `cleaned/`). */
  out: string
  state: JobState
  stage: string
  fraction: number
  /** Why it failed, or what cancelling it meant. */
  reason?: string
  startedAt: number
  /** Vmake's ids for it, once it's charged. */
  recordId?: VmakeRef
  taskId?: VmakeRef
  chargedAt?: number
  /** Seconds of video sent (the clip's part, or the whole file). */
  seconds?: number
  /** How long Vmake should take, fixed when it's charged; a first guess before any job finished. */
  expectedMs?: number
  firstGuess?: boolean
  /** Vmake sent a progress number of its own: the bar is that, not the clock. */
  reported?: boolean
  /** Made by the test stand-in (never sent to Vmake). */
  fake?: boolean
  /** Started by a visual dub (dub.ts), which takes the result itself: the page leaves it alone. */
  dub?: string
}

export const FAKE = process.env.STUDIO_VMAKE_FAKE === '1'
const POLL_MS = FAKE ? 300 : 4000
/** Past this a job still working is asked about less often (it carries on as long as Vmake works on it). */
const LONG_MS = 45 * 60_000
export const ended = (j: VmakeJob) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'

/** Every job known in this session, by id (any project). */
const jobs = new Map<string, VmakeJob>()
/** The jobs running here, with the switch that stops each. */
const live = new Map<string, AbortController>()
/** Projects whose jobs.json has been read. */
const loaded = new Set<string>()

const key = (dir: string) => {
  const d = path.resolve(dir)
  return process.platform === 'win32' ? d.toLowerCase() : d
}
const inside = (file: string, dir: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(file))
  return !!r && !r.startsWith('..') && !path.isAbsolute(r)
}
const indexFile = () => path.join(app.getPath('userData'), 'vmake-jobs.json')
const speedFile = () => path.join(app.getPath('userData'), 'vmake-speed.json')
const jobsFile = (dir: string) => path.join(dir, 'jobs.json')
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

function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

/** The last finished jobs' waits: seconds of waiting per second of video, oldest first. */
function rates(): number[] {
  try {
    const h = JSON.parse(fs.readFileSync(speedFile(), 'utf8'))
    return Array.isArray(h) ? h.map((x) => Number(x?.rate)).filter((x) => Number.isFinite(x) && x > 0) : []
  } catch {
    return []
  }
}

/** Learns from a finished job how long Vmake took for its length. */
function learn(job: VmakeJob) {
  if (!job.chargedAt || !job.seconds) return
  const waitedMs = Date.now() - job.chargedAt
  let h: unknown[] = []
  try {
    h = JSON.parse(fs.readFileSync(speedFile(), 'utf8'))
  } catch {}
  const entry = { rate: +(waitedMs / 1000 / job.seconds).toFixed(3), seconds: +job.seconds.toFixed(2), waitedMs, model: job.model, at: new Date().toISOString() }
  try {
    writeJson(speedFile(), [...(Array.isArray(h) ? h : []), entry].slice(-HISTORY_SIZE))
  } catch (e) {
    console.error(`[vmake] couldn't save how long it took: ${(e as Error).message}`)
  }
}

/** The wait to expect for a job, fixed when it's charged. */
const estimate = (job: VmakeJob) => {
  const e = expectedWait(job.seconds ?? 0, rates())
  return { expectedMs: e.ms, firstGuess: e.firstGuess }
}

let lastIndex = ''
function saveIndex() {
  const dirs = JSON.stringify([...new Set([...jobs.values()].map((j) => j.project))])
  if (dirs === lastIndex) return
  try {
    writeJson(indexFile(), JSON.parse(dirs))
    lastIndex = dirs
  } catch (e) {
    console.error(`[vmake] couldn't save the job list: ${(e as Error).message}`)
  }
}

/** Writes a project's jobs.json (removed when it has none left), and the list of projects. */
function save(project: string) {
  const mine = [...jobs.values()].filter((j) => key(j.project) === key(project))
  if (!isProject(project)) {
    // The project was deleted: its jobs go with it.
    for (const j of mine) {
      live.get(j.id)?.abort()
      jobs.delete(j.id)
    }
  } else
    try {
      if (mine.length) writeJson(jobsFile(project), mine)
      else rm(jobsFile(project))
    } catch (e) {
      console.error(`[vmake] couldn't save ${jobsFile(project)}: ${(e as Error).message}`)
    }
  saveIndex()
}

/** Who else hears every change: dub.ts follows the removals its dubs started. */
const watchers: ((job: VmakeJob) => void)[] = []
export const watch = (f: (job: VmakeJob) => void) => void watchers.push(f)

function send(job: VmakeJob) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('vmake:job', job)
  for (const f of watchers) f(job)
}

/** Changes a job, saves it and tells the windows. A job that's been settled (or dropped) stays gone. */
function patch(job: VmakeJob, p: Partial<VmakeJob>) {
  if (jobs.get(job.id) !== job) return
  Object.assign(job, p)
  save(job.project)
  send(job)
}

/** Ends a job that didn't finish, and removes the files it made. */
function end(job: VmakeJob, state: 'failed' | 'cancelled', reason: string) {
  live.get(job.id)?.abort()
  if (!live.has(job.id)) cleanUp(job)
  patch(job, { state, reason, stage: state === 'failed' ? 'Failed' : 'Cancelled' })
}

function cleanUp(job: VmakeJob) {
  if (job.removeSource) rm(job.source)
  rm(`${job.out}.download`)
}

// Vmake, or the test stand-in.

interface Remote {
  upload(file: string): Promise<string>
  purchase(source: string, title: string, model: string): Promise<{ recordId: VmakeRef; taskId: VmakeRef }>
  query(recordId: VmakeRef, taskId: VmakeRef): Promise<VmakeStatus>
  download(result: string, out: string, signal: AbortSignal): Promise<void>
}

let failNext = false
let slowNext = 0
// The stand-in's next queries fail as a dropped connection or an expired token would.
let dropQueries = 0
let expiredQueries = 0

const stand: Remote = {
  async upload(file) {
    await sleep(400)
    if (!fs.existsSync(file)) throw new VmakeError('The part to send is gone.')
    return file
  },
  // The record id carries when it started, how long it takes and whether it fails.
  async purchase(source) {
    const ms = slowNext || Number(process.env.STUDIO_VMAKE_FAKE_MS) || 10_000
    slowNext = 0
    const r = { recordId: `fake:${Date.now()}:${ms}:${failNext ? 'fail' : 'ok'}`, taskId: source }
    failNext = false
    return r
  },
  async query(recordId, taskId) {
    if (dropQueries > 0 && dropQueries--) throw new VmakeUnreachable('Vmake did not answer: fetch failed')
    if (expiredQueries > 0 && expiredQueries--) throw new VmakeAuthError('Vmake rejected that token: it has expired. Copy a fresh one.')
    const [, t0, ms, how] = String(recordId).split(':')
    const f = (Date.now() - Number(t0)) / Number(ms)
    // Like Vmake: working or done, no progress number.
    if (how === 'fail' && f >= 0.5) return { status: 3, progress: 0 }
    return f >= 1 ? { status: 2, progress: 0, result: String(taskId) } : { status: 1, progress: 0 }
  },
  async download(result, out) {
    await ffmpeg(['-i', result, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'boxblur=8:1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', '-y', out])
  },
}

function remote(job: VmakeJob): Remote {
  if (job.fake) return stand
  if (FAKE) throw new VmakeError('Studio is in test mode (STUDIO_VMAKE_FAKE), so it never calls Vmake.')
  // The token is read for each job, so a fresh one pasted meanwhile is used.
  return new Vmake(getSecret('vmake') ?? '')
}

/** Runs a job from where it is to its end. */
async function run(job: VmakeJob) {
  if (live.has(job.id) || ended(job)) return
  const stop = new AbortController()
  live.set(job.id, stop)
  const stopped = () => stop.signal.aborted || jobs.get(job.id) !== job
  try {
    let vm = remote(job)
    let charged = false
    if (job.state === 'uploading') {
      if (!job.source || !fs.existsSync(job.source)) throw new VmakeError('The part to send is gone.')
      patch(job, { stage: 'Uploading to Vmake', fraction: 0.05 })
      const url = await vm.upload(job.source)
      if (stopped()) return
      patch(job, { state: 'charging', stage: 'Vmake is queueing it', fraction: 0.2 })
      const { recordId, taskId } = await vm.purchase(url, job.title, job.model)
      // Kept even if it was cancelled meanwhile: those are the credits spent.
      if (jobs.get(job.id) !== job) return
      if (stopped()) return patch(job, { recordId, taskId, chargedAt: Date.now() })
      patch(job, { state: 'working', recordId, taskId, chargedAt: Date.now(), ...estimate(job), stage: 'Vmake is removing the text', fraction: 0.2 })
      charged = true
    }
    // A job charged before estimates existed gets one now.
    if (job.state === 'working' && job.expectedMs == null) patch(job, estimate(job))
    let misses = 0
    // Charged or seen working in this run: how long it took is then known when it's done (not
    // so for one found done after the app was closed, which may have finished long before).
    let watched = charged
    // A job Vmake was paid for is followed until Vmake itself says it's done or failed (the
    // user's rule: "when it's done it's done"). It used to end at 45 minutes, after 5 missed
    // answers or on an expired token, and its record went with it, while Vmake carried on
    // (2026-11-07: a compound at 85 % after 45 minutes, est. 26 more).
    while (job.state === 'working') {
      let t: VmakeStatus
      try {
        t = await vm.query(job.recordId!, job.taskId!)
        misses = 0
      } catch (e) {
        misses++
        // Vmake refusing the question itself (not the job: that's its status, below) may be a
        // passing fault on its side; only a refusal that lasts half an hour ends the job.
        if (e instanceof VmakeError && !(e instanceof VmakeUnreachable) && misses >= 30) throw e
        if (e instanceof VmakeAuthError) {
          // Waits for a fresh token (pasted under Remove text), read again each time.
          patch(job, { stage: 'Vmake carries on, but needs a fresh access token for Studio to follow it: paste one under Remove text' })
          await sleep(FAKE ? POLL_MS : 10_000, stop.signal)
          if (stopped()) return
          vm = remote(job)
          continue
        }
        // A dropped connection (a laptop asleep, no network): asked again, less and less often.
        if (misses >= 3) patch(job, { stage: 'Can’t reach Vmake right now; trying again (it carries on there)' })
        await sleep(Math.min(POLL_MS * 2 ** Math.min(misses, 6), FAKE ? 2000 : 60_000), stop.signal)
        if (stopped()) return
        continue
      }
      if (stopped()) return
      if (t.status === 2 && t.result) {
        if (watched) learn(job)
        patch(job, { state: 'downloading', stage: 'Bringing the finished video back', fraction: 0.88 })
        break
      }
      if (t.status !== 0 && t.status !== 1) throw new VmakeError(`Vmake could not process that video (status ${t.status}).`)
      watched = true
      // By the clock against the estimate (or Vmake's own number, if it ever sends one).
      patch(job, { stage: 'Vmake is removing the text', fraction: waitFraction(Date.now() - (job.chargedAt ?? job.startedAt), job.expectedMs ?? 60_000, job.fraction, t.progress), ...(t.progress > 0 ? { reported: true } : {}) })
      await sleep(Date.now() - (job.chargedAt ?? job.startedAt) > LONG_MS ? POLL_MS * 5 : POLL_MS, stop.signal)
      if (stopped()) return
    }
    if (job.state === 'downloading') {
      const tmp = `${job.out}.download`
      // Brought back, tried again on a dropped connection (each time with a fresh link: one from
      // before a restart may have run out).
      for (let tries = 1; ; tries++) {
        try {
          const t = await vm.query(job.recordId!, job.taskId!)
          if (!(t.status === 2 && t.result)) throw new VmakeError(`Vmake no longer has the finished video (status ${t.status}).`)
          await vm.download(t.result, tmp, stop.signal)
          break
        } catch (e) {
          if (stopped()) return
          if ((e instanceof VmakeError && !(e instanceof VmakeUnreachable)) || tries >= 20) throw e
          if (e instanceof VmakeAuthError) vm = remote(job)
          patch(job, { stage: e instanceof VmakeAuthError ? 'Done on Vmake: paste a fresh access token under Remove text to bring it back' : 'Can’t reach Vmake right now; trying again to bring it back' })
          await sleep(Math.min(POLL_MS * 2 ** Math.min(tries, 6), FAKE ? 2000 : 60_000), stop.signal)
          if (stopped()) return
        }
      }
      if (stopped()) return
      fs.renameSync(tmp, job.out)
      if (job.removeSource) rm(job.source)
      patch(job, { state: 'done', stage: 'Done', fraction: 1 })
    }
  } catch (e) {
    if (!stopped()) end(job, 'failed', (e as Error).message || String(e))
  } finally {
    if (live.get(job.id) === stop) live.delete(job.id)
    if (ended(job)) cleanUp(job)
  }
}

/** A job read back from disk (after a restart), picked up where it can be. */
function resume(job: VmakeJob) {
  if (job.state === 'preparing') end(job, 'failed', 'Studio closed before the clip went to Vmake. Nothing was charged; start it again.')
  else if (job.state === 'charging') end(job, 'failed', "Studio closed while Vmake was starting the job, so it can't be followed. Check vmake.ai before starting it again: it may have charged.")
  else if (!ended(job)) void run(job)
}

/** Reads a project's jobs.json once, and picks its jobs up. */
function load(project: string) {
  const k = key(project)
  if (loaded.has(k)) return
  loaded.add(k)
  let list: VmakeJob[] = []
  try {
    list = JSON.parse(fs.readFileSync(jobsFile(project), 'utf8'))
  } catch {
    return
  }
  let foreign = false
  for (const j of Array.isArray(list) ? list : []) {
    // A copy of a project (Save as) carries a jobs.json too; those jobs are the original's.
    if (!j?.id || typeof j.project !== 'string' || key(j.project) !== k) foreign = true
    else if (!jobs.has(j.id)) {
      jobs.set(j.id, j)
      resume(j)
    }
  }
  if (foreign) save(project)
}

/** At start: every project with jobs, from the list in userData. */
export function resumeAll() {
  let dirs: unknown = []
  try {
    dirs = JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
  } catch {}
  for (const d of Array.isArray(dirs) ? dirs : []) if (typeof d === 'string') load(d)
  saveIndex()
}

/** A file name in `cleaned/` that's neither on disk nor another job's. */
function freeOut(out: string) {
  const ext = path.extname(out)
  const stem = out.slice(0, -ext.length)
  const taken = (p: string) => fs.existsSync(p) || [...jobs.values()].some((j) => key(j.out) === key(p))
  for (let n = 1; ; n++) {
    const p = n === 1 ? out : `${stem} ${n}${ext}`
    if (!taken(p)) return p
  }
}

/** A new job, waiting for its source (the page cuts the clip's part first, then `start`s it). */
export function create(o: { project: string; clipId?: string; mediaId: string; name: string; title: string; model: string; out: string; seconds?: number; dub?: string }): VmakeJob {
  if (!isProject(o.project)) throw new Error('That project folder is missing.')
  if (!o.out.toLowerCase().endsWith('.mp4') || !inside(o.out, path.join(o.project, 'cleaned'))) throw new Error("The result must be an .mp4 in the project's cleaned folder.")
  load(o.project)
  const job: VmakeJob = {
    id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    project: o.project,
    ...(o.clipId ? { clipId: o.clipId } : {}),
    mediaId: o.mediaId,
    ...(o.seconds && Number.isFinite(o.seconds) ? { seconds: o.seconds } : {}),
    name: o.name,
    title: o.title,
    model: o.model,
    out: freeOut(o.out),
    state: 'preparing',
    stage: 'Cutting out the part to send',
    fraction: 0.02,
    startedAt: Date.now(),
    ...(FAKE ? { fake: true } : {}),
    ...(o.dub ? { dub: o.dub } : {}),
  }
  fs.mkdirSync(path.dirname(job.out), { recursive: true })
  jobs.set(job.id, job)
  save(job.project)
  send(job)
  return job
}

/** Sends a job's source to Vmake and runs it to the end. */
export function start(id: string, o: { source: string; removeSource?: boolean }): VmakeJob {
  const job = jobs.get(id)
  if (!job) throw new Error('That text removal is gone.')
  if (job.state !== 'preparing') return job
  if (!fs.existsSync(o.source)) throw new Error(`${path.basename(o.source)} is missing.`)
  // Only a part cut for this job inside the project is ever deleted, never the user's own file.
  const removeSource = !!o.removeSource && inside(o.source, path.join(job.project, 'cleaned'))
  patch(job, { source: o.source, removeSource, state: 'uploading', stage: 'Uploading to Vmake', fraction: 0.05 })
  void run(job)
  return job
}

/** Stops a job (with `error`, as failed). Credits Vmake already took stay spent. */
export function cancel(id: string, error?: string): VmakeJob | null {
  const job = jobs.get(id)
  if (!job) return null
  if (ended(job)) return job
  const said =
    job.recordId != null ? 'Text removal cancelled. Vmake had already charged for it.' : job.state === 'charging' ? 'Text removal cancelled. Vmake may already have charged for it.' : 'Text removal cancelled before Vmake charged anything.'
  end(job, error ? 'failed' : 'cancelled', error ?? said)
  return job
}

/** A project's jobs, read from its jobs.json the first time. */
export function list(project: string): VmakeJob[] {
  load(project)
  return [...jobs.values()].filter((j) => key(j.project) === key(project))
}

/** The page has applied a finished job (or freed a failed one's clip): it's forgotten. */
export function settled(id: string) {
  const job = jobs.get(id)
  if (!job || !ended(job)) return
  jobs.delete(id)
  save(job.project)
}

/** For the UI check, in fake mode only. */
export const vmakeTest = {
  /** The next job fails halfway, as Vmake failing one would. */
  failNext() {
    if (FAKE) failNext = true
  },
  /** The next job takes `ms` (instead of STUDIO_VMAKE_FAKE_MS), so a step can be sure it's still working. */
  slowNext(ms: number) {
    if (FAKE) slowNext = ms
  },
  /** The next `n` questions about a job fail as a dropped connection would. */
  dropQueries(n: number) {
    if (FAKE) dropQueries = n
  },
  /** The next `n` questions about a job are refused as an expired token would be. */
  expireToken(n: number) {
    if (FAKE) expiredQueries = n
  },
  /** As if the app quit and started again: every job stops where it is, and is read back from disk. */
  restart() {
    if (!FAKE) return
    for (const c of live.values()) c.abort()
    live.clear()
    jobs.clear()
    loaded.clear()
    resumeAll()
  },
}
