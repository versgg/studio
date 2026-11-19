// Change voice: a stretch of a recording made again in another of the account's voices, for the
// sound clips picked on the timeline (or a file in the library). First it's heard (cached per
// file, voice-read.ts) for its language and words; then, as shared/voice-change.ts explains:
//   - a language the voice changer knows: ElevenLabs' voice changer on the stretch, which keeps
//     the delivery, breaths and timing;
//   - any other (Norwegian): the words said again in the new voice in that language, as one
//     take, cut into its sentences (cutTake) and each put back at its moment within its own clip
//     (fitLines: a little earlier, faster or slower, as a translation's lines are).
// Either way the result is one file as long as the stretch (and 0.1 s of silence, so an MP3's
// rounding never shortens the last clip), so every clip cut from it keeps its place in the new file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'
import { ElevenLabs, type Voice } from './elevenlabs'
import { getSecret } from './secrets'
import { readVoice } from './voice-read'
import { CPS, cutTake, FAKE, fitLines, iso2, retime, speakTake } from './dub-voice'
import { changerKnows, piecesOf, type VcRun } from '../shared/voice-change'

/** The model the words are said again with (any language; the voice changer can't use it). */
const SAY_MODEL = 'eleven_v4'

export type VoiceChangeResult = { out: string; how: 'changer' | 'said'; language: string; voiceId: string; pieces: number; long: number }

export async function changeVoice(o: { project: string; run: VcRun; voice: Voice; removeNoise: boolean; out: string }, progress: (stage: string, fraction: number) => void): Promise<VoiceChangeResult> {
  const { run } = o
  if (!fs.existsSync(run.file)) throw new Error(`${path.basename(run.file)} is missing.`)
  const key = getSecret('elevenlabs')
  const el = key ? new ElevenLabs(key) : null
  if (!el && !FAKE) throw new Error('Paste your ElevenLabs API key first (Audio › Voice).')
  const length = run.endS - run.inS
  progress('Listening to it', 0.05)
  // Not heard (the transcript server down): the voice changer, as before there was a choice.
  const read = await readVoice(o.project, run.file).catch(() => null)
  if (read && !read.sentences.length) throw new Error(`No speech was heard in ${path.basename(run.file)}.`)
  const lang = iso2(read?.language ?? '').replace(/^nn$|^nb$/, 'no')
  // A Voice Library voice is added to the account first (it can't speak until it's there).
  const voiceId = o.voice.category === 'library' && o.voice.ownerId && el ? await el.addLibraryVoice(o.voice.ownerId, o.voice.id, o.voice.name) : o.voice.id
  const work = path.join(o.project, 'cache', 'voice-change', crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(path.dirname(o.out), { recursive: true })
  try {
    if (!read || changerKnows(lang)) {
      progress('Cutting out the sound', 0.15)
      const part = path.join(work, 'part.m4a')
      await ffmpeg(['-y', '-ss', run.inS.toFixed(3), '-t', length.toFixed(3), '-i', run.file, '-vn', '-c:a', 'aac', '-b:a', '192k', part])
      progress('ElevenLabs is changing the voice', 0.3)
      if (!el) throw new Error('The voice changer needs an ElevenLabs key.')
      const raw = path.join(work, 'changed.mp3')
      await el.changeVoice({ voiceId, input: part, out: raw, removeNoise: o.removeNoise })
      await exactly(raw, length, o.out)
      return { out: o.out, how: 'changer', language: lang, voiceId, pieces: 0, long: 0 }
    }
    // Said again: only the words the clips play, each clip's own pieces placed within it.
    const groups = piecesOf(read.sentences, run).filter((g) => g.pieces.length)
    const all = groups.flatMap((g) => g.pieces)
    if (!all.length) throw new Error('No words are spoken in that part.')
    const need = all.reduce((a, p) => a + p.text.length, 0) / (CPS[lang] ?? 14)
    const have = groups.reduce((a, g) => a + (g.clip.endS - g.clip.inS), 0)
    const speed = Math.min(1.1, Math.max(0.95, need / Math.max(1, have)))
    progress('Saying it again in the new voice', 0.3)
    const take = await speakTake(el, { voiceId, lines: all.map((p) => ({ id: p.id, translation: p.text })), lang, model: SAY_MODEL, seed: 4242, speed, out: path.join(work, 'take.mp3') })
    progress('Putting each sentence at its moment', 0.8)
    const cut = await cutTake(take, all.map((p) => p.id), work, 1)
    const lines: { file: string; at: number }[] = []
    let long = 0
    for (const g of groups) {
      const mine = cut.filter((c) => g.pieces.some((p) => p.id === c.id))
      const fit = fitLines(mine, g.pieces, g.clip.endS - g.clip.inS, 1.12)
      long += fit.long.length
      for (const p of fit.placed) {
        const c = mine.find((x) => x.id === p.id)!
        lines.push({ file: await retime(c.file, p.tempo, path.join(work, `fit-${p.id}.wav`)), at: g.clip.inS - run.inS + p.at })
      }
    }
    await mix(lines, length, o.out)
    return { out: o.out, how: 'said', language: lang, voiceId, pieces: all.length, long }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** `file` made `seconds` long and 0.1 s more (silence after it, or cut), as an MP3. */
const exactly = (file: string, seconds: number, out: string) => mix([{ file, at: 0 }], seconds, out)

/**
 * Sentences mixed into one MP3 of `seconds` and 0.1 s more, each starting `at` s in: over a
 * silence of that length, which sets the length (amix followed by apad lost its timestamps now
 * and then and FFmpeg wrote on forever: 1 run in 4 of the check hung, 2026-11-19).
 */
async function mix(lines: { file: string; at: number }[], seconds: number, out: string) {
  const len = (seconds + 0.1).toFixed(3)
  const inputs = lines.flatMap((l) => ['-i', l.file])
  const delays = lines.map((l, i) => `[${i + 1}:a]aresample=44100,adelay=delays=${Math.max(0, Math.round(l.at * 1000))}:all=1[a${i + 1}]`).join(';')
  const graph = `${delays};[0:a]${lines.map((_, i) => `[a${i + 1}]`).join('')}amix=inputs=${lines.length + 1}:duration=first:normalize=0[out]`
  await ffmpeg(['-y', '-f', 'lavfi', '-t', len, '-i', 'anullsrc=r=44100:cl=mono', ...inputs, '-filter_complex', graph, '-map', '[out]', '-t', len, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', out], { timeoutMs: 120_000 })
}
