// Voiceovers Studio didn't make (an ElevenLabs file made on the website, a CapCut import): what
// they say and which of the account's ElevenLabs voices speaks them, so a translation can speak
// them again in the same voice instead of cloning it anew.
//
// Once per file (kept in `<project>/cache/voices/`, keyed by the file's path, size and time):
//   1. The transcript server hears it, with a time for every word; the words are cut into sentences
//      (at . ! ? or a pause), each placed where it's said;
//   2. the voice: the one Studio wrote beside the file, else the account's ElevenLabs history
//      (what was generated with the same words tells the voice, its model and speed), else a
//      voice whose name the file is named after ("Ad 1 Anna v2.wav" → "Anna …"); else none, and
//      the Translations tab asks which voice it is. Nothing is ever cloned here.
// A file with no speech in it (music) is kept as that, so it isn't sent again.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { transcribe } from './transcript'
import { FAKE } from './dub-voice'
import { ElevenLabs } from './elevenlabs'
import { ffmpeg } from './ffmpeg'
import { getSecret } from './secrets'

export type VoiceHow = 'studio' | 'history' | 'name' | 'picked'

export interface ReadVoice {
  voiceId: string
  name: string
  model: string
  speed: number
  how: VoiceHow
}

export interface VoiceRead {
  file: string
  /** What it says, sentence by sentence, in seconds into the file. Empty: no speech. */
  sentences: { text: string; start: number; end: number }[]
  language: string
  voice: ReadVoice | null
  /** Why no voice was found, when none was. */
  note?: string
}

/** The model a found voice speaks the translation with: its own when that's a v3 or newer (any language), else v4. */
const DEFAULT_MODEL = 'eleven_v4'
const modelFor = (m: string) => (/^eleven_v\d/.test(m) && !/^eleven_v[12]\b/.test(m) ? m : DEFAULT_MODEL)

const cacheFile = (project: string, file: string) => {
  const st = fs.statSync(file)
  const id = crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16)
  return path.join(project, 'cache', 'voices', `${id}.json`)
}

/** What's known of `file` already (null: not read yet, or the file is gone). */
export function knownVoice(project: string, file: string): VoiceRead | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(project, file), 'utf8')) as VoiceRead
  } catch {
    return null
  }
}

function keep(project: string, r: VoiceRead) {
  const f = cacheFile(project, r.file)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(r, null, 1))
}

const reading = new Map<string, Promise<VoiceRead>>()

/** Reads a voiceover (see the notes above), or gives what was read before. */
export function readVoice(project: string, file: string): Promise<VoiceRead> {
  const known = knownVoice(project, file)
  if (known) return Promise.resolve(known)
  const k = path.resolve(file)
  let job = reading.get(k)
  if (!job) {
    job = (async () => {
      if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} is missing.`)
      const words = FAKE ? fakeWords() : await heard(file)
      const sentences = sentencesOf(words.words)
      const r: VoiceRead = { file, sentences, language: words.language, voice: null }
      if (sentences.length) Object.assign(r, await findVoice(file, sentences.map((s) => s.text).join(' ')))
      keep(project, r)
      return r
    })().finally(() => reading.delete(k))
    reading.set(k, job)
  }
  return job
}

/** The voice the user picked for a file (null: none, the old sound stays). */
export function pickVoice(project: string, file: string, voice: { voiceId: string; name: string } | null): VoiceRead | null {
  const r = knownVoice(project, file)
  if (!r) return null
  r.voice = voice ? { voiceId: voice.voiceId, name: voice.name, model: DEFAULT_MODEL, speed: 1, how: 'picked' } : null
  // 'kept': chosen to keep its own sound (not "none found").
  if (voice) delete r.note
  else r.note = 'kept'
  keep(project, r)
  return r
}

/** The file's words through the transcript server (its sound as 16 kHz mono FLAC). */
async function heard(file: string): Promise<{ language: string; words: { text: string; start: number; end: number }[] }> {
  const audio = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', 'pipe:1'])
  const r = await transcribe({ audio, fileName: 'voiceover.flac' })
  return { language: r.language, words: r.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text) }
}

/** The account's own voices (not the Voice Library's), for picking one by hand. */
export async function accountVoices(): Promise<{ id: string; name: string }[]> {
  if (FAKE) return (await fakeEleven.voices()).map((v) => ({ id: v.id, name: v.name }))
  const key = getSecret('elevenlabs')
  if (!key) throw new Error('No ElevenLabs key is saved.')
  return (await new ElevenLabs(key).voices()).filter((v) => v.category !== 'library').map((v) => ({ id: v.id, name: v.name }))
}

/** Words into sentences: one ends at . ! ? … or where the voice pauses for most of a second. */
export function sentencesOf(words: { text: string; start: number; end: number }[]) {
  const out: { text: string; start: number; end: number }[] = []
  let cur: typeof words = []
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end })
    cur = []
  }
  for (const [i, w] of words.entries()) {
    cur.push(w)
    const next = words[i + 1]
    if (/[.!?…]["”»)]*$/.test(w.text) || (next && next.start - w.end > 0.9)) flush()
  }
  flush()
  // A few stray words aren't speech (a breath, a sung line in a jingle).
  return out.reduce((n, s) => n + s.text.split(/\s+/).length, 0) >= 3 ? out : []
}

/** Words, lower-case, without punctuation or ElevenLabs' [audio tags]. */
const wordsOf = (s: string) =>
  s
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** The voice of a file: Studio's note beside it, the account's history, its name; or why not. */
async function findVoice(file: string, said: string): Promise<{ voice: ReadVoice | null; note?: string }> {
  const beside = `${file.replace(/\.[^.\\/]+$/, '')}.voice.json`
  if (fs.existsSync(beside)) {
    const v = JSON.parse(fs.readFileSync(beside, 'utf8')) as { voiceId: string; modelId: string; speed?: number; name?: string }
    return { voice: { voiceId: v.voiceId, name: v.name ?? 'The voiceover’s voice', model: modelFor(v.modelId), speed: v.speed ?? 1, how: 'studio' } }
  }
  const el = FAKE ? fakeEleven : getSecret('elevenlabs') ? new ElevenLabs(getSecret('elevenlabs')!) : null
  if (!el) return { voice: null, note: 'No ElevenLabs key is saved, so its voice can’t be looked up.' }
  let note: string | undefined
  try {
    const v = matchHistory(said, await el.history())
    if (v) return { voice: v }
  } catch (e) {
    note = `The ElevenLabs history couldn’t be read (${(e as Error).message})`
  }
  try {
    const voices = (await el.voices()).filter((v) => v.category !== 'library')
    const v = matchName(path.basename(file), voices)
    if (v) return { voice: { voiceId: v.id, name: v.name, model: DEFAULT_MODEL, speed: 1, how: 'name' } }
  } catch (e) {
    note ??= `The ElevenLabs voices couldn’t be listed (${(e as Error).message})`
  }
  return { voice: null, note: note ?? 'No voice in your ElevenLabs account said these words or is named in the file’s name.' }
}

/**
 * The voice that generated these words: history items mostly made of words that were said
 * (a take can be one sentence or the whole script), grouped by voice; the voice whose items
 * cover most of what was said, if that's at least half. Its newest such item gives the model
 * and speed.
 */
export function matchHistory(said: string, history: { voiceId: string; voiceName: string; model: string; text: string; speed: number; at: number }[]): ReadVoice | null {
  const heard = new Set(wordsOf(said))
  if (!heard.size) return null
  const best = new Map<string, { covered: Set<string>; item: (typeof history)[number] }>()
  for (const h of history) {
    const w = wordsOf(h.text)
    if (w.length < 3) continue
    const inside = w.filter((x) => heard.has(x))
    if (inside.length / w.length < 0.7) continue
    const b = best.get(h.voiceId) ?? { covered: new Set<string>(), item: h }
    for (const x of inside) b.covered.add(x)
    if (h.at > b.item.at) b.item = h
    best.set(h.voiceId, b)
  }
  const [top] = [...best.values()].sort((a, b) => b.covered.size - a.covered.size)
  if (!top || top.covered.size / heard.size < 0.5) return null
  return { voiceId: top.item.voiceId, name: top.item.voiceName || 'The voiceover’s voice', model: modelFor(top.item.model), speed: top.item.speed || 1, how: 'history' }
}

/** Words in a voice's name that say nothing about which voice it is. */
const GENERIC = new Set(['voice', 'voices', 'creation', 'clone', 'cloned', 'pro', 'the', 'and', 'new', 'take', 'final', 'version', 'copy', 'edit', 'mix', 'test'])

/** The one account voice whose name's own word (≥ 3 letters) is in the file's name; none when several are. */
export function matchName(fileName: string, voices: { id: string; name: string }[]) {
  const inFile = new Set(wordsOf(fileName.replace(/\.[^.]+$/, '')).filter((w) => w.length >= 3 && !/\d/.test(w)))
  const hits = voices.filter((v) => wordsOf(v.name).some((w) => w.length >= 3 && !GENERIC.has(w) && inFile.has(w)))
  return hits.length === 1 ? hits[0] : null
}

// The stand-in for tests (STUDIO_ELEVEN_FAKE=1): never calls the server or ElevenLabs. The file
// "says" two Swedish sentences; the account has Test Voice, whose history holds the first of them.

const FAKE_SAID = 'Det här är testet. Nu kommer den andra meningen som är lite längre.'

function fakeWords() {
  const words = FAKE_SAID.split(' ').map((text, i) => ({ text, start: 0.4 + i * 0.4 + (i > 3 ? 0.6 : 0), end: 0.7 + i * 0.4 + (i > 3 ? 0.6 : 0) }))
  return { language: 'sv', words }
}

const fakeEleven = {
  history: async () => [{ voiceId: 'fake-voice', voiceName: 'Test Voice', model: 'eleven_v3', text: FAKE_SAID, speed: 1.05, at: 1 }],
  voices: async () => [
    { id: 'fake-voice', name: 'Test Voice', category: 'generated' },
    { id: 'fake-erik', name: 'Erik', category: 'cloned' },
  ],
}
