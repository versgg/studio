// Media › Download: TikTok, Instagram, YouTube and Facebook ad library links brought into a project,
// through the download server (`STUDIO_DOWNLOAD_URL` sets another), the
// same way its page works: each link is looked up first (title, length, the qualities it
// offers; nothing fetched), then a job per link makes the file on the server (YouTube goes
// through the server's proxy, so MP3 costs it a tenth of 1080p), and Studio saves it into
// `<project>.studio/downloads/` (through `.part`, then renamed) and frees it on the server.
// Jobs live in `<project>.studio/downloads/jobs.json` and carry on after a restart while the
// server still has them (it keeps a finished file 30 minutes).
//
// STUDIO_DOWNLOAD_FAKE=1 is a stand-in that never calls the server (the UI check): every link is
// "a stand-in clip", and its file a short clip FFmpeg makes.

import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ffmpeg } from './ffmpeg'
import { log } from './log'
import { pathKey } from './path-key'

const BASE = (process.env.STUDIO_DOWNLOAD_URL ?? 'https://basalt.codes/download/api').replace(/\/+$/, '')
const FAKE = process.env.STUDIO_DOWNLOAD_FAKE === '1'
const ORIGIN = new URL(BASE).origin

export interface Rung {
  id: string
  label: string
  res?: string
}
export interface Probe {
  probe: string
  url: string
  platform: string
  platformLabel: string
  title: string
  uploader?: string
  duration: number
  ladder: Rung[]
  /** The picture, as a data URL (fetched here: the page loads nothing from outside). */
  thumb: string | null
}

export type DownloadState = 'queued' | 'working' | 'saving' | 'saved' | 'failed' | 'cancelled'
export interface DownloadJob {
  id: string
  project: string
  url: string
  title: string
  platform: string
  kind: 'mp4' | 'mp3'
  quality: string
  /** Remove the on-screen text with this Vmake model once it's in ('' for no). */
  vmake: string
  /** The server's job. */
  serverId: string
  state: DownloadState
  stage: string
  fraction: number
  file?: string
  bytes?: number
  error?: string
  /** Put in the project's library (the page says so once it has). */
  imported?: boolean
  startedAt: number
}

/** The server's answer, or its own words when it says no (they're written for people). */
async function ask<T>(p: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${BASE}${p}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(90_000) })
  } catch (e) {
    throw new Error(`The download server couldn't be reached (${(e as Error).message}).`)
  }
  const text = await r.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON: an error page */
  }
  if (!r.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail
    const msg = typeof detail === 'string' ? detail : `The download server answered HTTP ${r.status}.`
    log('download.error', `${p}: ${r.status} ${msg}`)
    throw new Error(msg)
  }
  return body as T
}

/** What a link is (title, length, qualities, picture), without fetching it. */
export async function probe(url: string): Promise<Probe> {
  const clean = url.trim()
  if (!/^https?:\/\/\S+$/i.test(clean)) throw new Error('That isn’t a link (it should start with https://).')
  if (FAKE) return { probe: `fake-${Date.now().toString(36)}`, url: clean, platform: 'tiktok', platformLabel: 'TikTok', title: `Stand-in clip ${clean.slice(-6)}`, duration: 2, ladder: [{ id: '720', label: '720p · best', res: '720×1280' }], thumb: null }
  const r = await ask<{ probe: string; platform: string; platform_label: string; title: string; uploader?: string; duration: number; ladder: Rung[]; thumb?: string }>('/probe', { method: 'POST', body: JSON.stringify({ url: clean }) })
  let thumb: string | null = null
  if (r.thumb)
    try {
      const t = await fetch(`${ORIGIN}${r.thumb}`, { signal: AbortSignal.timeout(15_000) })
      if (t.ok && (t.headers.get('content-type') ?? '').startsWith('image/')) thumb = `data:${t.headers.get('content-type')};base64,${Buffer.from(await t.arrayBuffer()).toString('base64')}`
    } catch {
      /* no picture */
    }
  return { probe: r.probe, url: clean, platform: r.platform, platformLabel: r.platform_label, title: r.title, uploader: r.uploader, duration: r.duration, ladder: r.ladder ?? [], thumb }
}

// Jobs, per project.

const jobs = new Map<string, DownloadJob>()
const loaded = new Set<string>()
const key = pathKey
const jobsFile = (project: string) => path.join(project, 'downloads', 'jobs.json')

function send(job: DownloadJob) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('download:job', job)
}

function save(project: string) {
  const list = [...jobs.values()].filter((j) => key(j.project) === key(project))
  try {
    fs.mkdirSync(path.dirname(jobsFile(project)), { recursive: true })
    fs.writeFileSync(`${jobsFile(project)}.tmp`, JSON.stringify(list, null, 1))
    fs.renameSync(`${jobsFile(project)}.tmp`, jobsFile(project))
  } catch (e) {
    log('download.error', `couldn't save the jobs: ${(e as Error).message}`)
  }
}

function patch(job: DownloadJob, p: Partial<DownloadJob>) {
  Object.assign(job, p)
  save(job.project)
  send(job)
}

/** A project's downloads (read once; any still at the server are followed again). */
export function list(project: string): DownloadJob[] {
  if (!loaded.has(key(project))) {
    loaded.add(key(project))
    try {
      for (const j of JSON.parse(fs.readFileSync(jobsFile(project), 'utf8')) as DownloadJob[]) {
        if (jobs.has(j.id)) continue
        // A file half-saved when Studio closed is fetched again (the server keeps it a while).
        jobs.set(j.id, { ...j, project, ...(j.state === 'saving' ? { state: 'working' as const } : {}) })
      }
    } catch {
      /* none yet */
    }
    follow()
  }
  return [...jobs.values()].filter((j) => key(j.project) === key(project)).sort((a, b) => a.startedAt - b.startedAt)
}

/** Starts a download per pick (from `probe`), in the order given. */
export async function start(project: string, picks: { probe: string; url: string; title: string; platform: string; kind: 'mp4' | 'mp3'; quality: string; vmake: string }[]): Promise<DownloadJob[]> {
  if (!fs.existsSync(path.join(project, 'project.json'))) throw new Error('That project folder is missing.')
  list(project)
  const made: DownloadJob[] = []
  for (const p of picks) {
    const job: DownloadJob = { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, project, url: p.url, title: p.title, platform: p.platform, kind: p.kind, quality: p.quality, vmake: p.kind === 'mp4' ? p.vmake : '', serverId: '', state: 'queued', stage: 'Asking the server', fraction: 0, startedAt: Date.now() }
    jobs.set(job.id, job)
    try {
      const r = FAKE ? { id: `fake-${job.id}` } : await ask<{ id: string }>('/jobs', { method: 'POST', body: JSON.stringify({ probe: p.probe, url: p.url, kind: p.kind, quality: p.quality }) })
      patch(job, { serverId: r.id, stage: 'Queued on the server' })
    } catch (e) {
      patch(job, { state: 'failed', stage: 'Failed', error: (e as Error).message })
    }
    made.push(job)
  }
  follow()
  return made
}

export function cancel(id: string) {
  const job = jobs.get(id)
  if (!job || job.state === 'saved' || job.state === 'failed' || job.state === 'cancelled') return job ?? null
  patch(job, { state: 'cancelled', stage: 'Cancelled' })
  aborts.get(id)?.abort()
  if (job.serverId && !FAKE) void ask(`/jobs/${job.serverId}`, { method: 'DELETE' }).catch(() => {})
  return job
}

/** The page put a saved file in the project's library. */
export function imported(id: string) {
  const job = jobs.get(id)
  if (job && !job.imported) patch(job, { imported: true })
}

// Following: one status request for every job at the server, every 1.5 s while any is.

let following = false
async function follow() {
  if (following) return
  following = true
  try {
    for (;;) {
      const live = [...jobs.values()].filter((j) => j.serverId && (j.state === 'queued' || j.state === 'working'))
      if (!live.length) return
      if (FAKE) {
        for (const j of live) {
          const age = Date.now() - j.startedAt
          if (age < 1500) patch(j, { state: 'working', stage: 'Downloading on the server', fraction: age / 1500 / 2 })
          else void fetchFile(j, '')
        }
      } else {
        try {
          const r = await ask<{ jobs: { id: string; gone?: boolean; state?: string; stage?: string; progress?: number; error?: string; filename?: string; size?: number }[] }>('/jobs/status', { method: 'POST', body: JSON.stringify({ ids: live.map((j) => j.serverId) }) })
          for (const s of r.jobs) {
            const j = live.find((x) => x.serverId === s.id)
            if (!j) continue
            if (s.gone) patch(j, { state: 'failed', stage: 'Failed', error: 'The server no longer has it (it keeps a download 30 minutes). Download it again.' })
            else if (s.state === 'failed') patch(j, { state: 'failed', stage: 'Failed', error: s.error ?? 'The server couldn’t download it.' })
            else if (s.state === 'ready') void fetchFile(j, s.filename ?? '')
            else patch(j, { state: s.state === 'queued' ? 'queued' : 'working', stage: s.state === 'queued' ? 'Waiting for a free slot on the server' : `On the server: ${s.stage ?? 'downloading'}`, fraction: 0.5 * (s.progress ?? 0) })
          }
        } catch (e) {
          // The server out of reach for a moment: asked again (a failed job says so itself).
          log('download.status', (e as Error).message)
        }
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  } finally {
    following = false
  }
}

/** A file name for the project's downloads folder, not taken. */
function freeName(dir: string, name: string, ext: string) {
  const base = (name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 120) || 'Download')
  for (let n = 1; ; n++) {
    const f = path.join(dir, `${base}${n > 1 ? ` ${n}` : ''}.${ext}`)
    if (!fs.existsSync(f)) return f
  }
}

const fetching = new Set<string>()
/** A file being saved, stopped by Cancel. */
const aborts = new Map<string, AbortController>()
/** The server's finished file into the project (bytes shown as they come), then freed there. */
async function fetchFile(job: DownloadJob, filename: string) {
  if (fetching.has(job.id) || job.state === 'cancelled') return
  fetching.add(job.id)
  const dir = path.join(job.project, 'downloads')
  const out = freeName(dir, filename || job.title, job.kind)
  const part = `${out}.part`
  const stop = new AbortController()
  aborts.set(job.id, stop)
  try {
    patch(job, { state: 'saving', stage: 'Saving it into the project', fraction: 0.5 })
    fs.mkdirSync(dir, { recursive: true })
    if (FAKE) {
      await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', ...(job.kind === 'mp3' ? ['-vn', '-c:a', 'libmp3lame'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']), '-f', job.kind === 'mp3' ? 'mp3' : 'mp4', part])
    } else {
      const r = await fetch(`${BASE}/jobs/${job.serverId}/file`, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30 * 60_000)]) })
      if (!r.ok || !r.body) throw new Error(`The server didn't send the file (HTTP ${r.status}).`)
      const total = Number(r.headers.get('content-length') ?? 0)
      let got = 0
      let shown = 0
      const counted = Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).on('data', (c: Buffer) => {
        got += c.length
        if (Date.now() - shown > 250) {
          shown = Date.now()
          patch(job, { stage: `Saving it into the project: ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ''} MB`, fraction: 0.5 + (total ? 0.5 * (got / total) : 0.25) })
        }
      })
      await pipeline(counted, fs.createWriteStream(part))
    }
    if (stop.signal.aborted) throw new Error('Cancelled.')
    fs.renameSync(part, out)
    patch(job, { state: 'saved', stage: 'Saved', fraction: 1, file: out, bytes: fs.statSync(out).size })
    if (job.serverId && !FAKE) void ask(`/jobs/${job.serverId}`, { method: 'DELETE' }).catch(() => {})
    log('download', { platform: job.platform, kind: job.kind, bytes: job.bytes })
  } catch (e) {
    fs.rmSync(part, { force: true })
    if (!stop.signal.aborted) patch(job, { state: 'failed', stage: 'Failed', error: (e as Error).message })
  } finally {
    fetching.delete(job.id)
    aborts.delete(job.id)
  }
}
