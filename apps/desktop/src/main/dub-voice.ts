// Voice dub: what's said in a clip, spoken again in another language by the same voice (an
// instant clone) or another, each sentence at its own moment. The method follows an earlier
// dubbing tool's, with the causes of its audible hiccups taken out (measured on four of its
// voice dubs, 2026-10-28):
//   - That tool rebuilt every sentence around Scribe's word times, putting digital silence in
//     every gap between two words: 10 ms dropouts inside words, up to 1.5 s taken out of a
//     sentence. Here a sentence's sound is never touched inside: each is cut out of the take
//     at the quietest moment between it and its neighbour, using ElevenLabs' own timing for
//     every character, with room before its first word and its whole decay after the last.
//   - Its shortening re-translated one sentence at a time to tight character budgets, until
//     lines read like telegrams ("Test i 60d."). Here a too-long take goes back to Claude as
//     the whole script, with every sentence's room, and the whole script is spoken again.
//   - Lines spoken again one by one were other performances (and a new clone each time). Here
//     the whole script is one take, one seed, one clone kept for the project.
// Steps (the dub's folder): listen (Scribe on the voice stem) → speech.json; clone → voice.json;
// speak the whole script in one take → take-<n>.mp3 + its character times; cut it into
// sentences → line-<id>.wav; fit each to its moment (a little faster, up to 8 %, or a little
// earlier into the pause before it) → voice.json's lines.

import fs from 'node:fs'
import path from 'node:path'
import { ElevenError, ElevenLabs } from './elevenlabs'
import { ffmpeg } from './ffmpeg'

export const FAKE = process.env.STUDIO_ELEVEN_FAKE === '1'

export type { DubSpoken as Spoken } from '../shared/dub'
import type { DubSpoken as Spoken } from '../shared/dub'

/** Speaking rates (characters a second at speed 1) a sentence's room is sized with (an earlier dubbing tool's CPS). */
export const CPS: Record<string, number> = { sv: 14, da: 14, no: 14, fi: 13.5, de: 14.5, nl: 14.5, en: 14.5, fr: 14.5, es: 15, it: 15, pt: 15, pl: 14 }

/** A pause this long, or a sentence end with this much after it, ends a sentence; a sentence never runs past MAX_LINE. */
const PAUSE = 0.7
const END_GAP = 0.15
const MAX_LINE = 9
/** Shorter than this (and under three words) joins its neighbour. */
const MIN_LINE = 1.2

/** Scribe's words into whole sentences, one speaker each. */
export function sentences(words: { text: string; start: number; end: number; type: string; speaker: string }[]): Spoken[] {
  const ws = words.filter((w) => w.type === 'word' && w.text.trim())
  const out: Spoken[] = []
  let cur: typeof ws = []
  const close = () => {
    if (!cur.length) return
    out.push({ id: '', speaker: cur[0].speaker, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text.trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1'), words: cur.map((w) => ({ text: w.text.trim(), start: w.start, end: w.end })) })
    cur = []
  }
  ws.forEach((w, i) => {
    const prev = cur[cur.length - 1]
    // A new speaker, a long pause or a sentence's end closes it (speech recognisers often leave
    // no gap at all after a full stop, so the stop alone is enough).
    if (prev && (w.speaker !== prev.speaker || w.start - prev.end >= PAUSE || /[.!?]["”']?$/.test(prev.text))) close()
    else if (prev && w.end - cur[0].start > MAX_LINE) {
      // Too long for one breath: split where it pauses most, a comma counting as a pause.
      let best = cur.length, score = -1
      for (let k = Math.ceil(cur.length / 3); k < cur.length; k++) {
        const s = cur[k].start - cur[k - 1].end + (/[,;:]$/.test(cur[k - 1].text) ? END_GAP * 2 : 0)
        if (s > score) (score = s), (best = k)
      }
      const tail = cur.slice(best)
      cur = cur.slice(0, best)
      close()
      cur = tail
    }
    cur.push(w)
    if (i === ws.length - 1) close()
  })
  // A scrap ("Yeah.") joins the sentence it's closest to, when that's the same speaker and near.
  for (let i = 0; i < out.length; i++) {
    const s = out[i]
    if (s.end - s.start >= MIN_LINE || s.words.length >= 3) continue
    const before = out[i - 1], after = out[i + 1]
    const gapB = before && before.speaker === s.speaker ? s.start - before.end : Infinity
    const gapA = after && after.speaker === s.speaker ? after.start - s.end : Infinity
    if (Math.min(gapB, gapA) >= PAUSE) continue
    const into = gapB <= gapA ? before : after
    const merged = gapB <= gapA ? [into, s] : [s, into]
    const m: Spoken = { id: '', speaker: s.speaker, start: merged[0].start, end: merged[1].end, text: `${merged[0].text} ${merged[1].text}`, words: [...merged[0].words, ...merged[1].words] }
    out.splice(gapB <= gapA ? i - 1 : i, 2, m)
    i--
  }
  return out.map((s, i) => ({ ...s, id: `L${String(i + 1).padStart(2, '0')}` }))
}

/** Listens to the voice (Scribe), into `speech.json`. */
export async function listen(el: ElevenLabs | null, voiceFile: string, dir: string): Promise<{ language: string; lines: Spoken[] }> {
  const file = path.join(dir, 'speech.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const heard = FAKE ? fakeHeard() : await el!.transcribe({ file: voiceFile })
  // No speech (music only) is an answer too: the dub goes on with whatever else it has.
  const r = { language: iso2(heard.language), lines: sentences(heard.words) }
  fs.writeFileSync(file, JSON.stringify(r, null, 1))
  return r
}

/** Scribe answers "eng", "swe"…; Studio's languages are two letters. */
const ISO3: Record<string, string> = { eng: 'en', swe: 'sv', nor: 'no', nob: 'no', nno: 'no', dan: 'da', fin: 'fi', deu: 'de', ger: 'de', nld: 'nl', dut: 'nl', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', pol: 'pl' }
export const iso2 = (code: string) => (code.length === 3 ? (ISO3[code.toLowerCase()] ?? code) : code.toLowerCase())

/** One instant clone of a speaker from up to two minutes of their own sentences (longest first). */
export async function cloneVoice(el: ElevenLabs | null, voiceFile: string, lines: Spoken[], speaker: string, name: string, dir: string): Promise<string> {
  const mine = lines.filter((l) => l.speaker === speaker).sort((a, b) => b.end - b.start - (a.end - a.start))
  const picked: Spoken[] = []
  let total = 0
  for (const l of mine) {
    if (total >= 120) break
    picked.push(l)
    total += l.end - l.start
  }
  picked.sort((a, b) => a.start - b.start)
  // Each sentence with a little air, joined by short silences (never hard-joined).
  const inputs = picked.flatMap((l) => ['-ss', Math.max(0, l.start - 0.08).toFixed(3), '-t', (l.end - l.start + 0.25).toFixed(3), '-i', voiceFile])
  const chain = picked.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=0.3[a${i}]`).join(';')
  const sample = path.join(dir, `clone-${speaker}.mp3`)
  await ffmpeg(['-y', ...inputs, '-filter_complex', `${chain};${picked.map((_, i) => `[a${i}]`).join('')}concat=n=${picked.length}:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', sample])
  // The stand-in keeps the sample too, as her clone is made again from it.
  return cloneFrom(el, sample, name)
}

/** An instant clone named "<name> (Studio dub)" from a sample `cloneVoice` made (kept in the dub's folder). */
export async function cloneFrom(el: ElevenLabs | null, sample: string, name: string): Promise<string> {
  if (FAKE) return fakeClone()
  return el!.clone({ name: `${name} (Studio dub)`, files: [sample], removeNoise: true, description: 'Made by Studio for a dub of this clip.' })
}

/** Deletes a clone Studio made from the account. */
export async function removeClone(el: ElevenLabs | null, voiceId: string) {
  if (FAKE) {
    unverified.delete(voiceId)
    fakeLive = Math.max(0, fakeLive - 1)
    return
  }
  await el!.deleteVoice(voiceId)
}

// The UI check's stand-in for clones ElevenLabs won't speak with until they're verified.
let refuseLeft = 0
let fakeClones = 0
let fakeLive = 0
const unverified = new Set<string>()
/** For the UI check, in fake mode only. */
export const elevenTest = {
  /** The next `n` clones are ones ElevenLabs won't speak with until they're verified. */
  refuseClones(n: number) {
    if (FAKE) refuseLeft = n
  },
  /** How many of those are still to be made. */
  left: () => refuseLeft,
  /** How many clones Studio made are in the stand-in account now. */
  live: () => fakeLive,
}
function fakeClone() {
  fakeLive++
  if (refuseLeft <= 0) return 'fake-voice'
  refuseLeft--
  const id = `fake-unverified-${++fakeClones}`
  unverified.add(id)
  return id
}

export type Take = { file: string; chars: string[]; starts: number[]; ends: number[]; script: string; spans: [number, number][] }

/** The whole script spoken in one take, with the span of each sentence in it. */
export async function speakTake(el: ElevenLabs | null, o: { voiceId: string; lines: { id: string; translation: string }[]; lang: string; model: string; seed: number; speed: number; out: string }): Promise<Take> {
  const spans: [number, number][] = []
  let script = ''
  for (const l of o.lines) {
    const t = l.translation.trim().replace(/\s+/g, ' ')
    const s = script ? script.length + 1 : 0
    script = script ? `${script} ${t}` : t
    spans.push([s, script.length])
  }
  if (FAKE && unverified.has(o.voiceId)) throw new ElevenError('ElevenLabs: This voice requires verification. Please verify your voice to continue. (voice_access_denied)', false, 'voice_access_denied')
  const timed = FAKE
    ? await fakeSpeak(script, o.out)
    : await el!.speakTimed({ voiceId: o.voiceId, text: script, modelId: o.model, stability: 0.5, similarity: 0.8, speed: o.speed, languageCode: o.lang, seed: o.seed, out: o.out })
  if (!timed.chars.length) throw new Error('ElevenLabs sent the take without its timings.')
  // Kept beside the take, so its sentences can be cut again without speaking it again.
  fs.writeFileSync(o.out.replace(/\.mp3$/i, '.json'), JSON.stringify({ script, spans, ...timed }))
  return { file: o.out, ...timed, script, spans }
}

/** Seconds of 10 ms loudness (dB) of a sound file, mono. */
async function levels(file: string): Promise<{ db: Float32Array; rate: number }> {
  const raw = await ffmpeg(['-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'])
  const n = Math.floor(raw.length / 2 / 160)
  const db = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < 160; k++) {
      const v = raw.readInt16LE((i * 160 + k) * 2) / 32768
      s += v * v
    }
    db[i] = 10 * Math.log10(s / 160 + 1e-10)
  }
  return { db, rate: 100 }
}

export type VoiceLine = { id: string; file: string; /** where it plays, s in the part */ at: number; dur: number; tempo: number; text: string; words: { text: string; start: number; end: number }[] }

/**
 * Cuts a take into its sentences: each boundary at the quietest 10 ms between the last letter
 * of one sentence and the first of the next (by ElevenLabs' own character times), each sentence
 * kept whole, from 120 ms before its first word to the end of its decay (until 40 dB under its
 * median, at most 400 ms), with 12 ms fades.
 */
export async function cutTake(take: Take, ids: string[], dir: string, round: number | string): Promise<{ id: string; file: string; dur: number; words: VoiceLine['words'] }[]> {
  const { db, rate } = await levels(take.file)
  const at = (t: number) => Math.max(0, Math.min(db.length - 1, Math.round(t * rate)))
  const first = (i: number) => take.starts[Math.min(take.starts.length - 1, take.spans[i][0])]
  const last = (i: number) => take.ends[Math.min(take.ends.length - 1, take.spans[i][1] - 1)]
  const total = db.length / rate
  // Silence, by sound: well under the take's speech (ElevenLabs' character times can be ~0.1–0.3 s
  // off where one sentence meets the next, so a cut placed by them alone left a breath or the next
  // sentence's first sound in a clip: Wendy's dub, 2026-10-29, 4 of 14 sentences).
  const sorted = Array.from(db).sort((x, y) => x - y)
  const quiet = Math.min(-45, (sorted[Math.floor(sorted.length * 0.1)] ?? -70) + 12)
  // Between sentence i and i + 1: the longest silent stretch near where the times put the gap.
  // Sentence i ends 40 ms into it, i + 1 starts 60 ms before it ends. With no silence there,
  // the quietest moment (the old way).
  const gaps = ids.map((_, i) => {
    if (i === ids.length - 1) return null
    const a = last(i), b = first(i + 1)
    let best: [number, number] | null = null
    for (let f = at(a - 0.15), run = -1; f <= at(b + 0.3) + 1; f++) {
      const silent = f <= at(b + 0.3) && db[f] < quiet
      if (silent && run < 0) run = f
      if (!silent && run >= 0) {
        if (!best || f - run > best[1] - best[0]) best = [run, f]
        run = -1
      }
    }
    if (best && best[1] - best[0] >= 6) return { end: (best[0] + 4) / rate, start: Math.max(best[0] + 4, best[1] - 6) / rate }
    let q = at((a + b) / 2)
    for (let f = at(a); f <= at(b); f++) if (db[f] < db[q]) q = f
    return { end: q / rate, start: q / rate }
  })
  const out = []
  for (const [i, id] of ids.entries()) {
    // The first sentence starts 120 ms before its first sound; the last ends 150 ms after its last.
    let heard = 0
    while (heard < db.length - 1 && db[heard] < quiet) heard++
    let lastHeard = db.length - 1
    while (lastHeard > 0 && db[lastHeard] < quiet) lastHeard--
    const start = i ? gaps[i - 1]!.start : Math.max(0, heard / rate - 0.12)
    const end = i < ids.length - 1 ? gaps[i]!.end : Math.min(total, lastHeard / rate + 0.15)
    const file = path.join(dir, `line-${id}-${round}.wav`)
    const len = end - start
    await ffmpeg(['-y', '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', take.file, '-af', `afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, len - 0.012).toFixed(3)}:d=0.012`, '-ar', '44100', '-ac', '1', file])
    // Its words, from the characters' times, from the sentence's own start.
    const words: VoiceLine['words'] = []
    const [s0, s1] = take.spans[i]
    let w = ''
    let ws = 0
    for (let c = s0; c <= s1; c++) {
      const ch = c < s1 ? take.chars[c] ?? '' : ' '
      if (/\s/.test(ch) || c === s1) {
        if (w) words.push({ text: w, start: Math.max(0, ws - start), end: Math.max(0, (take.ends[c - 1] ?? ws) - start) })
        w = ''
      } else {
        if (!w) ws = take.starts[c] ?? 0
        w += ch
      }
    }
    out.push({ id, file, dur: len, words })
  }
  return out
}

/**
 * Places each sentence at its moment: at its original start if it fits before the next one
 * starts; else a little earlier into the pause before it (up to 0.4 s, never over the previous
 * sentence), then a little faster (up to `maxTempo`, pitch kept). Returns the lines and the ids
 * that still don't fit.
 */
export function fitLines(cut: { id: string; dur: number }[], spoken: Spoken[], partEnd: number, maxTempo: number) {
  const placed: { id: string; at: number; tempo: number; dur: number }[] = []
  const long: string[] = []
  let prevEnd = 0
  for (const [i, c] of cut.entries()) {
    const k = spoken.findIndex((x) => x.id === c.id)
    const s = spoken[k]
    const next = spoken[k + 1]
    const room = (next ? next.start : partEnd) - s.start
    const early = Math.max(0, Math.min(0.4, s.start - (prevEnd + 0.06)))
    // When the sentence before came out shorter than hers, this one moves up (up to 0.6 s), so the
    // pause between them is about the one she left, not dead air (Wendy's dub: 0.97 s for her 0.32 s).
    const before = spoken[k - 1]
    const pause = before ? Math.max(0.1, s.start - before.end) : 0
    let at = i ? Math.min(s.start, Math.max(prevEnd + pause, s.start - 0.6)) : s.start
    let tempo = 1
    if (c.dur > room) {
      at = s.start - Math.min(early, c.dur - room)
      const left = room + (s.start - at)
      if (c.dur > left) tempo = c.dur / left
    }
    if (tempo > maxTempo) {
      long.push(c.id)
      tempo = maxTempo
    }
    at = Math.max(at, prevEnd + (i ? 0.04 : 0))
    const dur = c.dur / tempo
    placed.push({ id: c.id, at, tempo, dur })
    prevEnd = at + dur
  }
  return { placed, long }
}

/** A sentence played `tempo` × faster, pitch kept (FFmpeg's atempo), as WAV. */
export async function retime(file: string, tempo: number, out: string) {
  if (Math.abs(tempo - 1) < 0.005) return file
  await ffmpeg(['-y', '-i', file, '-af', `atempo=${tempo.toFixed(4)}`, out])
  return out
}

/** The background: every stem but the voice, summed (stems that are silent were left out already). */
export async function mixBed(stems: string[], out: string) {
  if (stems.length === 1) {
    await ffmpeg(['-y', '-i', stems[0], '-c:a', 'aac', '-b:a', '256k', out])
    return
  }
  await ffmpeg(['-y', ...stems.flatMap((s) => ['-i', s]), '-filter_complex', `${stems.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${stems.length}:normalize=0[out]`, '-map', '[out]', '-c:a', 'aac', '-b:a', '256k', out])
}

// The stand-in for tests (STUDIO_ELEVEN_FAKE=1): never calls ElevenLabs. What was "heard" comes
// from STUDIO_ELEVEN_FAKE_WORDS (Scribe-shaped JSON) or two sentences; "speech" is a soft
// tone per word, 65 ms a letter, with the pauses a voice would leave.

function fakeHeard() {
  const f = process.env.STUDIO_ELEVEN_FAKE_WORDS
  if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const words = 'This is a test. It has two sentences.'.split(' ').map((t, i) => ({ text: t, start: 0.3 + i * 0.35, end: 0.6 + i * 0.35, type: 'word', speaker: 'speaker_0' }))
  return { language: 'eng', words }
}

async function fakeSpeak(script: string, out: string) {
  const rate = 22050
  const chars: string[] = [], starts: number[] = [], ends: number[] = []
  const pcm: number[] = []
  let t = 0.15
  const tone = (secs: number, on: boolean) => {
    const n = Math.round(secs * rate)
    for (let i = 0; i < n; i++) pcm.push(on ? Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / rate) * Math.min(1, i / 200, (n - i) / 200)) : 0)
  }
  tone(0.15, false)
  for (const ch of script) {
    chars.push(ch)
    starts.push(t)
    const d = /\s/.test(ch) ? 0.05 : /[.!?]/.test(ch) ? 0.3 : /[,;:]/.test(ch) ? 0.15 : 0.065
    tone(d, !/[\s.!?,;:]/.test(ch))
    t += d
    ends.push(t)
  }
  tone(0.3, false)
  const data = Buffer.alloc(pcm.length * 2)
  pcm.forEach((v, i) => data.writeInt16LE(v, i * 2))
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  const wav = out.replace(/\.mp3$/i, '.fake.wav')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(wav, Buffer.concat([head, data]))
  await ffmpeg(['-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k', out])
  fs.rmSync(wav, { force: true })
  return { chars, starts, ends }
}
