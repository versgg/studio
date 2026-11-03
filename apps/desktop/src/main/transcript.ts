// Captions through the transcript server (API below; STUDIO_TRANSCRIPT_URL points elsewhere): Whisper large-v2
// with a timing for every word, and, given the script the sound was read from, a proofread
// against it (a misheard brand name or number is corrected to the script; anything the
// speaker really said differently is kept; timings never move). No key: the service limits
// each address instead (two jobs at a time, twenty an hour). It keeps nothing on disk, and
// the job is deleted here as soon as the words are back.

const API = process.env.STUDIO_TRANSCRIPT_URL ?? 'https://basalt.codes/transcript/api'

/** The server's language names, by the codes Studio uses ('' = let it detect). */
const LANGUAGES: Record<string, string> = {
  en: 'English', sv: 'Swedish', no: 'Norwegian', nb: 'Norwegian', da: 'Danish', de: 'German', nl: 'Dutch', fr: 'French',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', pl: 'Polish', fi: 'Finnish', ja: 'Japanese', ko: 'Korean',
}

export interface ServerWord {
  word: string
  /** Seconds into the sound that was sent. */
  start: number
  end: number
}
/** One stretch the proofread swapped for the script's words: what was heard, what the script says, from `at` s. */
export interface ServerChange {
  heard: string
  script: string
  note: string
  at: number
}
export interface ServerTranscript {
  words: ServerWord[]
  /** The language Whisper heard, as a code ("sv"). */
  language: string
  /** What the proofread changed (only with a script). */
  changes: ServerChange[]
  /** The proofread's one line ("3 corrections from your script, 1 left as spoken"); null without a script. */
  summary: string | null
}

/** The server's stage names, as the progress line says them. */
export function stageText(stage: string, queue: number): string {
  if (stage === 'waiting for the model') return queue > 0 ? `Waiting for the transcriber (${queue} ahead)` : 'Waiting for the transcriber'
  const said: Record<string, string> = { queued: 'The server has the sound', 'preparing audio': 'The server is reading the sound', transcribing: 'The server is listening', 'proofreading against your script': 'Checking the words against the script', done: 'The server is done' }
  return said[stage] ?? `The server: ${stage}`
}

export class TranscriptError extends Error {}

async function readError(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: string }
    if (typeof body.detail === 'string') return body.detail
  } catch {}
  return `The transcript server answered HTTP ${r.status}.`
}

/**
 * Transcribes `audio` (any format FFmpeg reads) and, with `script`, proofreads it. `progress`
 * hears each stage ("waiting for the model", "transcribing"…) and, while queued, the place.
 */
export async function transcribe(o: { audio: Buffer; fileName: string; language?: string; script?: string; progress?: (stage: string, fraction: number, queue: number) => void }): Promise<ServerTranscript> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(o.audio)]), o.fileName)
  form.append('language', LANGUAGES[o.language ?? ''] ?? 'Auto')
  form.append('per_line', '0')
  if (o.script?.trim()) form.append('script', o.script.trim().slice(0, 60000))
  let r: Response
  try {
    r = await fetch(`${API}/jobs`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
  } catch (e) {
    throw new TranscriptError(`The transcript server couldn't be reached: ${(e as Error).message}`)
  }
  if (!r.ok) throw new TranscriptError(await readError(r))
  const { id } = (await r.json()) as { id: string }
  try {
    // A job reports its stage and progress; long sound can take a few minutes in the queue.
    const deadline = Date.now() + 60 * 60_000
    for (;;) {
      await new Promise((res) => setTimeout(res, 1000))
      const s = await fetch(`${API}/jobs/${id}`, { signal: AbortSignal.timeout(30_000) })
      if (!s.ok) throw new TranscriptError(await readError(s))
      const job = (await s.json()) as { state: string; stage: string; progress: number; queue: number; words: ServerWord[]; language: string; changes: ServerChange[]; summary: { message?: string } | null; error: string | null }
      o.progress?.(job.stage, job.progress ?? 0, job.queue ?? 0)
      if (job.state === 'failed') throw new TranscriptError(job.error || 'The transcript server could not finish.')
      if (job.state === 'done') return { words: job.words ?? [], language: job.language ?? '', changes: job.changes ?? [], summary: job.summary?.message ?? null }
      if (Date.now() > deadline) throw new TranscriptError('The transcript server took over an hour; try a shorter stretch.')
    }
  } finally {
    // The words are ours now; nothing of this sound stays on the server.
    fetch(`${API}/jobs/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) }).catch(() => {})
  }
}
