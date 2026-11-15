// Whether a voice is on its own in a sound file (a voiceover) or over music and other sound (a
// clip's own sound, a voiceover laid on a song). A translation replaces a voice on its own by
// cutting it out where the new one speaks; a voice over music is first taken out of the music
// (the stems server), so the music stays under the new voice.
// No imports: node --test runs this file (scripts/voice-mix.test.mjs).

/** The window the sound's level is measured in, in seconds. */
const WINDOW = 0.05
/** Room around each word that still counts as the voice (breaths, the tail of a word). */
const AIR = 0.15
/** How much sound between and around the words it takes to judge (seconds). */
const ENOUGH = 1
/** Sound between the words this loud (dBFS)… */
const LOUD_DB = -42
/** …and no more than this far under the voice is music or other sound, not a quiet room. */
const UNDER_DB = 25

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))]
}

/**
 * Whether the voice in `pcm` (mono, `rate` Hz) is over other sound: the sound outside its words
 * (at least a second of it) is mostly loud and not far under the voice. With too little of it
 * to judge (the voice talks all the way through), it counts as on its own.
 */
export function overOtherSound(pcm: Int16Array, rate: number, words: { start: number; end: number }[]): boolean {
  const n = Math.max(1, Math.round(rate * WINDOW))
  const windows = Math.floor(pcm.length / n)
  const gap: number[] = []
  const voice: number[] = []
  const said = words.map((w) => [w.start - AIR, w.end + AIR] as const).sort((a, b) => a[0] - b[0])
  let k = 0
  for (let i = 0; i < windows; i++) {
    const t0 = i * WINDOW
    const t1 = t0 + WINDOW
    while (k < said.length && said[k][1] < t0) k++
    let sum = 0
    for (let j = i * n; j < (i + 1) * n; j++) sum += pcm[j] * pcm[j]
    const db = 20 * Math.log10(Math.sqrt(sum / n) / 32768 + 1e-9)
    let inWord = false
    for (let j = k; j < said.length && said[j][0] < t1; j++)
      if (said[j][1] > t0) {
        inWord = true
        break
      }
    ;(inWord ? voice : gap).push(db)
  }
  if (gap.length * WINDOW < ENOUGH || !voice.length) return false
  const around = quantile(gap, 0.6)
  return around > LOUD_DB && around > quantile(voice, 0.5) - UNDER_DB
}
