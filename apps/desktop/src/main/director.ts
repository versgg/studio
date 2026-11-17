// Send to Director: a voice handed to Director, a separate app that turns a voiceover into a
// video ad (it hears the voice word by word and lines each phrase up with its line of the
// script). The hand-over is a folder in Director's inbox, `<appData>/Director/inbox`:
//
//   <YYYYMMDD-HHMMSS>-<slug>.partial/   written first (Director ignores .partial folders),
//     voice.wav                         the voice as it plays on its track (the engine's sound export),
//     send.json                         what's in it (below),
//   then renamed without `.partial` once complete, so Director never reads half a package.
//
// send.json (version 1; Director reads exactly this):
//   { version: 1, app: "Studio", createdAt, name, audio: "voice.wav", duration,
//     phrases: [{ start, end, text }], script, language }
// Each clip is one phrase, its start and end in seconds within voice.wav; `text` is the script
// label over it on the Audio page (null when there's none); `script` is the voiceover's script
// (`<name>.script.txt` beside it) or one pasted, else null; `language` from `<name>.voice.json`.
//
// Then Studio opens director://inbox/<folder> when asked to (services.ts). STUDIO_DIRECTOR_INBOX
// points the inbox elsewhere, for tests only (and then nothing is opened).
// No Electron here: node --test runs this file (scripts/director.test.mjs).

import fs from 'node:fs'
import path from 'node:path'

export const VOICE_FILE = 'voice.wav'
export const SEND_FILE = 'send.json'
const PARTIAL = '.partial'

export interface Phrase {
  start: number
  end: number
  text: string | null
}

export interface SendFile {
  version: 1
  app: 'Studio'
  createdAt: string
  name: string
  audio: typeof VOICE_FILE
  duration: number
  phrases: Phrase[]
  script: string | null
  language: string | null
}

/** A clip of the voice, in timeline microseconds. */
export interface VoiceClip {
  startUs: number
  durationUs: number
}

/** A label on the Audio page's Script labels row (a point when start and end are equal). */
export interface TimeLabel {
  startUs: number
  endUs: number
  text: string
}

/** Director's inbox: `<appData>/Director/inbox`, or STUDIO_DIRECTOR_INBOX (tests only). */
export function inboxDir(appData: string, env: Record<string, string | undefined> = process.env): string {
  return env.STUDIO_DIRECTOR_INBOX || path.join(appData, 'Director', 'inbox')
}

// Letters NFKD doesn't take apart.
const FOLD: Record<string, string> = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i' }

/** The voice's name for a folder: lowercase ASCII, a–z, 0–9 and hyphens, at most 40 characters ("voice" when nothing's left). */
export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[æøœßðþłđı]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || 'voice'
}

/** YYYYMMDD-HHMMSS, in this computer's time. */
export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Seconds, to the millisecond. */
const sec = (us: number) => Math.round(us / 1000) / 1000

/** Labels Studio names itself (a marker, Label sounds, a new label) aren't script text. */
const AUTO_LABEL = /^(Marker|Sound|Label) \d+$/

/**
 * The phrases of a voice: each clip in timeline order, its start and end in seconds from the
 * first clip's start (where voice.wav starts; gaps between clips stay as silence), and the
 * script labels over it. A label belongs to the clip it overlaps most, when that's at least half
 * the label or half the clip; points (markers) and Studio's own names ("Sound 3") don't count.
 */
export function phrasesOf(clips: VoiceClip[], labels: TimeLabel[] = []): { duration: number; phrases: Phrase[] } {
  const sorted = [...clips].sort((a, b) => a.startUs - b.startUs)
  if (!sorted.length) return { duration: 0, phrases: [] }
  const t0 = sorted[0].startUs
  const end = Math.max(...sorted.map((c) => c.startUs + c.durationUs))
  const texts: string[][] = sorted.map(() => [])
  for (const l of [...labels].sort((a, b) => a.startUs - b.startUs)) {
    const text = l.text.trim().replace(/\s+/g, ' ')
    if (l.endUs <= l.startUs || !text || AUTO_LABEL.test(text)) continue
    let best = -1
    let most = 0
    sorted.forEach((c, i) => {
      const o = Math.min(l.endUs, c.startUs + c.durationUs) - Math.max(l.startUs, c.startUs)
      if (o > most) {
        most = o
        best = i
      }
    })
    if (best >= 0 && (most * 2 >= l.endUs - l.startUs || most * 2 >= sorted[best].durationUs)) texts[best].push(text)
  }
  return {
    duration: sec(end - t0),
    phrases: sorted.map((c, i) => ({ start: sec(c.startUs - t0), end: sec(c.startUs + c.durationUs - t0), text: texts[i].join(' ') || null })),
  }
}

/** The send.json of a package. */
export function sendFile(o: { name: string; clips: VoiceClip[]; labels?: TimeLabel[]; script?: string | null; language?: string | null; now?: Date }): SendFile {
  const { duration, phrases } = phrasesOf(o.clips, o.labels)
  const script = o.script?.trim()
  return {
    version: 1,
    app: 'Studio',
    createdAt: (o.now ?? new Date()).toISOString(),
    name: o.name.trim() || 'Voice',
    audio: VOICE_FILE,
    duration,
    phrases,
    script: script || null,
    language: o.language?.trim() || null,
  }
}

const taken = (inbox: string, name: string) => fs.existsSync(path.join(inbox, name)) || fs.existsSync(path.join(inbox, name + PARTIAL))

/** A free `<stamp>-<slug>` in the inbox (neither it nor its .partial there yet), else with -2, -3… */
export function packageName(inbox: string, name: string, now: Date): string {
  const base = `${stampOf(now)}-${slugOf(name)}`
  let n = base
  for (let i = 2; taken(inbox, n); i++) n = `${base}-${i}`
  return n
}

/** Makes the inbox if it's missing, and the package's `.partial` folder in it for voice.wav. */
export function beginPackage(inbox: string, name: string, now = new Date()): { dir: string; name: string } {
  fs.mkdirSync(inbox, { recursive: true })
  const n = packageName(inbox, name, now)
  const dir = path.join(inbox, n + PARTIAL)
  fs.mkdirSync(dir)
  return { dir, name: n }
}

/** Whether `dir` is a package being written: a `.partial` folder right inside the inbox. */
export function isPartial(inbox: string, dir: string): boolean {
  return typeof dir === 'string' && dir.endsWith(PARTIAL) && path.dirname(path.resolve(dir)) === path.resolve(inbox) && path.basename(dir).length > PARTIAL.length
}

/**
 * Writes send.json beside voice.wav and hands the package over: its `.partial` folder renamed
 * to the final name in one step. Returns the final folder.
 */
export function finishPackage(partialDir: string, send: SendFile): string {
  if (!partialDir.endsWith(PARTIAL)) throw new Error('Not a package being written.')
  const wav = wavInfo(path.join(partialDir, VOICE_FILE))
  if (!wav || wav.seconds <= 0) throw new Error('The voice wasn’t rendered.')
  fs.writeFileSync(path.join(partialDir, SEND_FILE), `${JSON.stringify(send, null, 2)}\n`)
  const inbox = path.dirname(partialDir)
  const base = path.basename(partialDir).slice(0, -PARTIAL.length)
  let name = base
  for (let i = 2; fs.existsSync(path.join(inbox, name)); i++) name = `${base}-${i}`
  const final = path.join(inbox, name)
  fs.renameSync(partialDir, final)
  return final
}

/** Removes a package that didn't make it (only a `.partial` folder in the inbox). */
export function discardPackage(inbox: string, dir: string): void {
  if (isPartial(inbox, dir)) fs.rmSync(dir, { recursive: true, force: true })
}

/** The link that opens a package in Director. */
export const directorUrl = (folder: string) => `director://inbox/${encodeURIComponent(folder)}`

/**
 * What Studio knows about these voiceovers: the scripts kept beside them (`<name>.script.txt`,
 * as ElevenLabs voiceovers keep theirs), joined in order, and the language of the first one that
 * says (`<name>.voice.json`'s languageCode).
 */
export function aboutVoices(paths: string[]): { script: string | null; language: string | null } {
  const texts: string[] = []
  let language: string | null = null
  for (const p of new Set(paths.filter((x) => typeof x === 'string' && x))) {
    const stem = p.replace(/\.[^.\\/]+$/, '')
    try {
      const t = fs.readFileSync(`${stem}.script.txt`, 'utf8').trim()
      if (t) texts.push(t)
    } catch {}
    if (!language)
      try {
        const v = JSON.parse(fs.readFileSync(`${stem}.voice.json`, 'utf8')) as { languageCode?: unknown }
        if (typeof v.languageCode === 'string' && v.languageCode.trim()) language = v.languageCode.trim()
      } catch {}
  }
  return { script: texts.join('\n\n') || null, language }
}

/** A WAV file's format and length, from its header (null when it isn't one). */
export function wavInfo(file: string): { rate: number; channels: number; bits: number; seconds: number } | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(Math.min(size, 4096))
    fs.readSync(fd, head, 0, head.length, 0)
    const riff = head.toString('ascii', 0, 4)
    if ((riff !== 'RIFF' && riff !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') return null
    let rate = 0
    let channels = 0
    let bits = 0
    let align = 0
    let ds64: number | null = null
    for (let at = 12; at + 8 <= head.length; ) {
      const id = head.toString('ascii', at, at + 4)
      const len = head.readUInt32LE(at + 4)
      if (id === 'ds64' && at + 24 <= head.length) ds64 = Number(head.readBigUInt64LE(at + 16))
      if (id === 'fmt ' && at + 24 <= head.length) {
        channels = head.readUInt16LE(at + 10)
        rate = head.readUInt32LE(at + 12)
        align = head.readUInt16LE(at + 20)
        bits = head.readUInt16LE(at + 22)
      }
      if (id === 'data') {
        if (!rate || !align) return null
        // A length FFmpeg couldn't go back and write (or RF64's) is the rest of the file.
        const bytes = len === 0xffffffff ? (ds64 ?? size - at - 8) : Math.min(len, size - at - 8)
        return { rate, channels, bits, seconds: bytes / (rate * align) }
      }
      at += 8 + len + (len % 2)
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}
