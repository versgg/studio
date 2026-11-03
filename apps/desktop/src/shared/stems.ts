// Stems: a clip's sound split into its parts (vocals, instrumental, drums, bass…) by the server
// Video's audio read, with AudioShake underneath (src/main/stems.ts runs the jobs). Shared by
// the main process and the page: the jobs' shape, the stems' order and names as the server's own
// page shows them, how long a separation usually takes, how loud a stem is from its samples,
// and which separation fits a clip. Tested by `node --test scripts/stems.test.mjs`.

/** One stem, downloaded into the job's folder and measured. */
export interface Stem {
  /** The server's (AudioShake's) name: "vocals", "other-x-guitar". */
  name: string
  /** As the page says it: "Vocals lead", "Other without guitar". */
  label: string
  /** The file, in the job's folder. */
  path: string
  durationUs: number
  /** PEAKS values, 0–1 of full scale (not normalised: a quiet stem draws small). */
  peaks: number[]
  /** Its loudest moment (50 ms), in dBFS. */
  levelDb: number
  /** Nothing to hear: AudioShake sends every stem, most of them empty for a given sound. */
  silent: boolean
}

export type StemsState = 'cutting' | 'uploading' | 'waiting' | 'separating' | 'downloading' | 'done' | 'failed' | 'cancelled'

/**
 * A separation: the part of a clip's source it plays, sent to the server as one job. Kept in its
 * own folder in the project (`<project>.studio/stems/<name> <id>/job.json`, beside the stems),
 * so it outlives the app: the server keeps the result a week, so a job is picked up again by its
 * result key (or its job id, or the part cut for it) when the project is next opened.
 */
/**
 * A song in the sound sent, as the server's read names it: matched by Shazam (title, artist and the
 * rest), or, when Shazam found none, named from the lyrics the server heard (`fromLyrics`).
 */
export interface Song {
  title: string
  artist?: string
  album?: string
  released?: string
  genre?: string
  /** Its page on Shazam, and its cover saved beside the stems. */
  url?: string
  cover?: string
  /** Seconds into the part sent where it was heard, and where that is in the recording. */
  heardAt?: number
  trackAt?: number
  /** The server's warning when only an instrumental stretch plays: it may be a song built on that beat. */
  note?: string
  fromLyrics?: boolean
}

export interface StemsJob {
  id: string
  /** The project's folder, and this job's (unique: the handle the page and IPC use). */
  project: string
  dir: string
  /** The clip it was started from (any clip playing the same stretch of the file can use it). */
  clipId: string
  mediaId: string
  /** The file's name, for messages; its path, to cut from. */
  name: string
  source: string
  /** The stretch of the source sent, at the source's own speed. */
  inUs: number
  spanUs: number
  state: StemsState
  /** What it's doing, in words. */
  stage: string
  fraction: number
  /** The server's place in its queue (0: running). */
  queue?: number
  /** The songs the server's read named in it (none found: an empty list; not asked yet: missing). */
  songs?: Song[]
  /** The server's job id, then the result's key (the stems are kept under it for a week). */
  remote?: string
  key?: string
  /** Why it failed. */
  reason?: string
  startedAt: number
  /** When the server took it: the wait is timed from here, against `expectedMs`. */
  sentAt?: number
  expectedMs?: number
  finishedAt?: number
  /** In the service's order; silent ones last. */
  stems?: Stem[]
  /** Made by the test stand-in (STUDIO_STEMS_FAKE=1), never sent to the server. */
  fake?: boolean
}

/** The server's audio read takes up to five minutes of sound. */
export const MAX_SECONDS = 300
/** Too short to be worth a job. */
export const MIN_SECONDS = 0.5
/** A stem whose loudest 50 ms stays under this is silent. AudioShake's empty stems measured −68 dBFS and lower; real quiet beds −51 and up. */
export const SILENT_DB = -60
/** How many values a stem's waveform keeps. */
export const PEAKS = 240

/** The server's own page lists stems in this order (its Audio view). */
export const STEM_ORDER = [
  'vocals', 'vocals_lead', 'vocals_backing', 'dialogue', 'instrumental', 'drums', 'bass', 'piano', 'keys', 'guitar', 'guitar_electric', 'guitar_acoustic',
  'strings', 'wind', 'other', 'other-x-guitar', 'music_fx', 'effects', 'speech_denoise', 'speech_dereverb',
]

/** "vocals_lead" → "Vocals lead", "other-x-guitar" → "Other without guitar" (as the server's page says them). */
export function stemLabel(name: string): string {
  const n = String(name).replace(/-x-/g, ' without ').replace(/[_-]/g, ' ')
  return n.charAt(0).toUpperCase() + n.slice(1)
}

/** In the server's order, unknown names last. */
export function sortStems<T extends { name: string }>(items: T[]): T[] {
  const rank = (n: string) => (STEM_ORDER.includes(n) ? STEM_ORDER.indexOf(n) : 99)
  return [...items].sort((a, b) => rank(a.name) - rank(b.name))
}

/** Stems that hold others: picking both plays those parts twice. */
export const NESTED: Record<string, string[]> = {
  vocals: ['vocals_lead', 'vocals_backing'],
  instrumental: ['drums', 'bass', 'piano', 'keys', 'guitar', 'guitar_electric', 'guitar_acoustic', 'strings', 'wind', 'other', 'other-x-guitar'],
  guitar: ['guitar_electric', 'guitar_acoustic'],
}

/** "Drums is already in Instrumental", for each part picked with a stem that holds it. */
export function doubled(names: string[]): string[] {
  const out: string[] = []
  for (const [whole, parts] of Object.entries(NESTED)) {
    if (!names.includes(whole)) continue
    for (const p of parts) if (names.includes(p)) out.push(`${stemLabel(p)} is already in ${stemLabel(whole)}`)
  }
  return out
}

/** The sound track a stem gets: a voice or music track (how the timeline and Audio page colour it). */
export function stemRole(name: string): 'voice' | 'music' {
  return /^(vocals|dialogue|speech)/.test(name) ? 'voice' : 'music'
}

/** How long the server usually takes for this much sound: about 55 s, plus 1.2 s per second (its past reads: 50–120 s for clips under a minute, 4–7 min for 3–5 min). */
export function expectedMs(seconds: number): number {
  return Math.round((55 + 1.2 * Math.max(0, seconds)) * 1000)
}

/** "40 s", "2 min": a wait, rounded the way it's said. */
export function roughly(ms: number): string {
  const s = Math.max(0, ms / 1000)
  if (s < 55) return `${Math.max(5, Math.round(s / 5) * 5)} s`
  return `${Math.max(1, Math.round(s / 60))} min`
}

/** "about 1 min", before it starts. */
export const usually = (seconds: number) => `about ${roughly(expectedMs(seconds))}`

/** The bar while the server separates: 20 % → 85 % by the clock against the estimate, held there, never back. */
export function separatingFraction(elapsedMs: number, expected: number, previous = 0): number {
  const f = Math.min(1, Math.max(0, elapsedMs / Math.max(1, expected)))
  return Math.min(0.85, Math.max(previous, Math.round((0.2 + 0.65 * f) * 1e4) / 1e4))
}

/** What's left, in words, while the server separates. */
export function separatingLeft(elapsedMs: number, expected: number): string {
  const left = expected - elapsedMs
  return left > 0 ? `about ${roughly(left)} left` : 'taking longer than usual'
}

export const running = (j: { state: StemsState }) => j.state !== 'done' && j.state !== 'failed' && j.state !== 'cancelled'

/**
 * A stem's waveform and loudness from its samples (mono, 16-bit): `buckets` peaks (0–1 of full
 * scale), the loudest 50 ms in dBFS, and whether that leaves it silent.
 */
export function measure(pcm: Int16Array, rate: number, buckets = PEAKS): { peaks: number[]; levelDb: number; silent: boolean } {
  const n = pcm.length
  const peaks: number[] = new Array(buckets).fill(0)
  for (let b = 0; b < buckets && n; b++) {
    const from = Math.floor((b * n) / buckets)
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets))
    let m = 0
    for (let i = from; i < to && i < n; i++) {
      const v = Math.abs(pcm[i])
      if (v > m) m = v
    }
    peaks[b] = Math.round((m / 32768) * 1e4) / 1e4
  }
  const win = Math.max(1, Math.round(rate * 0.05))
  let loudest = 0
  for (let at = 0; at < n; at += win) {
    let sum = 0
    const end = Math.min(n, at + win)
    for (let i = at; i < end; i++) sum += (pcm[i] / 32768) ** 2
    loudest = Math.max(loudest, sum / Math.max(1, end - at))
  }
  const levelDb = loudest > 0 ? Math.round(10 * Math.log10(loudest) * 10) / 10 : -120
  return { peaks, levelDb, silent: levelDb < SILENT_DB }
}

/** A clip as the Stems tab sees it: its file, and the stretch of it it plays. */
export interface ClipSpan {
  id: string
  mediaId: string
  inUs: number
  durationUs: number
  speed?: number
}

/** The stretch of its source a clip plays: its length on the timeline times its speed. */
export const sourceSpan = (c: ClipSpan) => ({ from: c.inUs, to: c.inUs + Math.round(c.durationUs * (c.speed ?? 1)) })

/** How much of the clip's stretch a job covers, in source µs (0 when they don't meet). */
export function overlap(c: ClipSpan, j: Pick<StemsJob, 'mediaId' | 'inUs' | 'spanUs'>): number {
  if (j.mediaId !== c.mediaId) return 0
  const s = sourceSpan(c)
  return Math.max(0, Math.min(s.to, j.inUs + j.spanUs) - Math.max(s.from, j.inUs))
}

/**
 * The separation to show for a clip: one running for it, else the stems covering most of what it
 * plays (the newest of those); any clip playing the same stretch of the file can use them (a split
 * half, a copy). `failed` is the newest failed try for this clip since then, to say why.
 */
export function pickStems(c: ClipSpan, jobs: StemsJob[]): { job?: StemsJob; failed?: StemsJob } {
  const mine = jobs.filter((j) => j.state !== 'cancelled' && (j.clipId === c.id || overlap(c, j) > 0)).sort((a, b) => b.startedAt - a.startedAt)
  const live = mine.find((j) => running(j))
  const done = mine.filter((j) => j.state === 'done').sort((a, b) => overlap(c, b) - overlap(c, a) || b.startedAt - a.startedAt)[0]
  const job = live ?? done
  const failed = mine.find((j) => j.state === 'failed' && j.clipId === c.id && (!job || j.startedAt > job.startedAt))
  return { job, failed }
}

/** Whether a done job covers all the clip plays (within a frame), or only part of it. */
export function covers(c: ClipSpan, j: Pick<StemsJob, 'mediaId' | 'inUs' | 'spanUs'>): boolean {
  const s = sourceSpan(c)
  return overlap(c, j) >= s.to - s.from - 40_000
}
