// Voiceovers Studio didn't make (an ElevenLabs file made on the website, a CapCut import): what
// they say and which of the account's ElevenLabs voices speaks them, so a translation can speak
// them again in the same voice instead of cloning it anew.
//
// Once per file (kept in `<project>/cache/voices/`, keyed by the file's path, size and time):
//   1. The transcript server hears it, with a time for every word; the words are cut into sentences
//      (at . ! ? or a pause), each placed where it's said;
//   2. the voice: the one Studio wrote beside the file, else the account's ElevenLabs history
//      (what was generated with the same words tells the voice, its model and speed), else a
//      voice whose name the file is named after ("Ad 1 Anna v2.wav" → "Anna …"); else none,
//      and the translation clones it from these sentences for its takes (deleted after), unless
//      another voice, sound to clone from or keeping its sound is picked in the Translations tab;
//   3. whether the voice is over music or other sound (`mixed`, shared/voice-mix.ts): then a
//      translation takes it out of the music first, so the music stays under the new voice.
// A file with no speech in it (music) is kept as that, so it isn't sent again. A video clip's own
// sound is read the same way (its file's sound).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { transcribe } from './transcript'
import { FAKE } from './dub-voice'
import { kept } from './eleven-cache'
import { ElevenLabs } from './elevenlabs'
import { ffmpeg } from './ffmpeg'
import { getSecret } from './secrets'
import { overOtherSound } from '../shared/voice-mix'
import { sentencesOf } from '../shared/speech-timing'

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
  /** What it says, sentence by sentence, in seconds into the file, with each word's time (`words`, since v2). Empty: no speech. */
  sentences: { text: string; start: number; end: number; words?: { text: string; start: number; end: number }[] }[]
  language: string
  voice: ReadVoice | null
  /** Why no voice was found, when none was ('kept', from an earlier Studio: the user chose to keep its sound as it is). */
  note?: string
  /** The voice is over music or other sound (measured outside its words). */
  mixed?: boolean
  /** How it was read: 2 keeps each word's time and hears a short file's one or two words. */
  v?: number
}

/** A file this short (seconds) that says one or two words says something ("Testa nu!"); a longer one is a breath or a jingle. */
const SHORT_FILE = 4

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
    const r = JSON.parse(fs.readFileSync(cacheFile(project, file), 'utf8')) as VoiceRead
    // Heard as nothing before v2, which took a short file's one or two words for no speech: heard again once.
    return !r.v && !r.sentences.length ? null : r
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
      const words = FAKE ? fakeWords(file) : await heard(file)
      const length = await lengthOf(file)
      const short = length > 0 && length <= SHORT_FILE
      const sentences = sentencesOf(words.words, short ? 1 : 3).map((x) => ({ ...x, words: words.words.filter((w) => w.start >= x.start - 0.001 && w.end <= x.end + 0.001) }))
      const r: VoiceRead = { file, sentences, language: words.language, voice: null, v: 2 }
      if (sentences.length) Object.assign(r, await findVoice(file, sentences.map((s) => s.text).join(' ')), { mixed: await overMusic(file, words.words) })
      keep(project, r)
      return r
    })().finally(() => reading.delete(k))
    reading.set(k, job)
  }
  return job
}

/** A file's length in seconds (0: unknown). */
async function lengthOf(file: string): Promise<number> {
  try {
    return Number((await ffmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { tool: 'ffprobe', timeoutMs: 15_000 })).toString().trim()) || 0
  } catch {
    return 0
  }
}

/** Whether the voice in `file` is over music or other sound (shared/voice-mix.ts), from its sound at 8 kHz. */
async function overMusic(file: string, words: { start: number; end: number }[]): Promise<boolean> {
  try {
    const raw = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'])
    const bytes = new Uint8Array(raw)
    return overOtherSound(new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1), 8000, words)
  } catch {
    return false
  }
}

/** The file's words through the transcript server (its sound as 16 kHz mono FLAC). */
async function heard(file: string): Promise<{ language: string; words: { text: string; start: number; end: number }[] }> {
  const audio = await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-f', 'flac', 'pipe:1'])
  let r: Awaited<ReturnType<typeof transcribe>>
  try {
    r = await transcribe({ audio, fileName: 'voiceover.flac' })
  } catch (e) {
    // The server says so when there's no speech at all (music, a sound bed): that's an answer, not a failure.
    if (/no speech/i.test((e as Error).message)) return { language: '', words: [] }
    throw e
  }
  return { language: r.language, words: r.words.map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })).filter((w) => w.text) }
}

/** The account's own voices (not the Voice Library's), for picking one by hand. */
export async function accountVoices(): Promise<{ id: string; name: string }[]> {
  if (FAKE) return (await fakeEleven.voices()).map((v) => ({ id: v.id, name: v.name }))
  const key = getSecret('elevenlabs')
  if (!key) throw new Error('No ElevenLabs key is saved.')
  // ElevenLabs not sending the list: the one it sent last (eleven-cache.ts), if any.
  const list = await new ElevenLabs(key).voices().catch((e) => {
    const k = kept().voices
    if (!k?.length) throw e
    return k
  })
  return list.filter((v) => v.category !== 'library' && v.category !== 'recent').map((v) => ({ id: v.id, name: v.name }))
}

// Words into sentences (at most 9 s each): shared/speech-timing.ts.
export { sentencesOf }

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
    const voices = (await el.voices().catch((e) => (FAKE || !kept().voices?.length ? Promise.reject(e) : kept().voices!))).filter((v) => v.category !== 'library')
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

// The stand-in for tests (STUDIO_ELEVEN_FAKE=1): never calls the server or ElevenLabs. A file
// named as a voiceover, or as one that speaks ("speaks-…"), "says" two Swedish sentences (any
// other is heard as no speech). The account has Test Voice, whose history holds a voiceover's
// sentences; a file that speaks says others, in a voice the account doesn't know.

const FAKE_SAID = 'Det här är testet. Nu kommer den andra meningen som är lite längre.'

function fakeWords(file: string) {
  const name = path.basename(file)
  if (!/voiceover|speaks/i.test(name)) return { language: 'sv', words: [] }
  const said = /speaks/i.test(name) ? FAKE_SPEAKS : FAKE_SAID
  const words = said.split(' ').map((text, i) => ({ text, start: 0.4 + i * 0.4 + (i > 3 ? 0.6 : 0), end: 0.7 + i * 0.4 + (i > 3 ? 0.6 : 0) }))
  // A file named "norsk" speaks Norwegian (the voice changer's other way, in tests).
  return { language: /norsk/i.test(name) ? 'no' : 'sv', words }
}

/** What a clip that speaks says, in a voice the stand-in account doesn't have. */
const FAKE_SPEAKS = 'Hej och välkommen hit. Det här är min favorit och jag använder den varje dag.'

const fakeEleven = {
  history: async () => [{ voiceId: 'fake-voice', voiceName: 'Test Voice', model: 'eleven_v3', text: FAKE_SAID, speed: 1.05, at: 1 }],
  voices: async () => [
    { id: 'fake-voice', name: 'Test Voice', category: 'generated' },
    { id: 'fake-erik', name: 'Erik', category: 'cloned' },
  ],
}
