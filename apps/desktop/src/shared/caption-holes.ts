// Captions: stretches the transcript server skipped. Whisper (the server's large-v2) works in
// 30-second windows and can jump from where it is to the window's end, leaving everything in
// between without a word: a clip that opened in English and went on in Swedish got its first
// 6 s and its last 3 s, nothing from 6 to 30 s (2026-11-19). A stretch of 3 s or more with sound
// in it most of the time and no word is sent again on its own, and its words put in their place.

/** Loudness in 50 ms steps (dBFS) of 16 kHz mono 16-bit sound. */
export function levelsOf(pcm: Uint8Array, rate = 16000): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const step = Math.round(rate / 20)
  const n = Math.floor(pcm.byteLength / 2 / step)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = 0; k < step; k++) {
      const v = view.getInt16((i * step + k) * 2, true) / 32768
      s += v * v
    }
    out[i] = 10 * Math.log10(s / step + 1e-10)
  }
  return out
}

/** Sound, not silence: louder than this (dBFS) in a 50 ms step. */
const SOUND_DB = -40

/**
 * The stretches (seconds) with no word that are at least `least` s long and have sound in at
 * least half their 50 ms steps. Each word keeps 0.3 s either side of it.
 */
export function holesOf(levels: Float32Array, words: { start: number; end: number }[], least = 3): { start: number; end: number }[] {
  const total = levels.length / 20
  const taken = [...words].sort((a, b) => a.start - b.start).map((w) => [Math.max(0, w.start - 0.3), Math.min(total, w.end + 0.3)] as const)
  const free: [number, number][] = []
  let at = 0
  for (const [a, b] of taken) {
    if (a > at) free.push([at, a])
    at = Math.max(at, b)
  }
  if (at < total) free.push([at, total])
  return free
    .filter(([a, b]) => b - a >= least)
    .filter(([a, b]) => {
      const from = Math.floor(a * 20)
      const to = Math.min(levels.length, Math.ceil(b * 20))
      let loud = 0
      for (let i = from; i < to; i++) if (levels[i] > SOUND_DB) loud++
      return loud >= (to - from) / 2
    })
    .map(([start, end]) => ({ start, end }))
}

/**
 * Every hole in `pcm` (16 kHz mono 16-bit) heard again as one recording, its pieces joined by
 * 0.8 s of silence (`hear` sends it; its words are in seconds into what it was given), and the
 * words put back at their times in the whole and merged in. A second hearing that fails or hears
 * nothing leaves the words as they were.
 */
export async function fillHoles<W extends { start: number; end: number }>(pcm: Uint8Array, words: W[], hear: (pcm: Uint8Array) => Promise<W[]>, rate = 16000): Promise<{ words: W[]; holes: number }> {
  const holes = holesOf(levelsOf(pcm, rate), words)
  if (!holes.length) return { words, holes: 0 }
  const total = pcm.byteLength / 2 / rate
  const gap = new Uint8Array(Math.round(rate * 0.8) * 2)
  const bits: Uint8Array[] = []
  const at: { from: number; into: number }[] = []
  let len = 0
  for (const h of holes) {
    const a = Math.max(0, h.start - 0.2)
    const b = Math.min(total, h.end + 0.2)
    if (bits.length) {
      bits.push(gap)
      len += gap.length
    }
    at.push({ from: a, into: len / (rate * 2) })
    const piece = pcm.subarray(Math.floor(a * rate) * 2, Math.floor(b * rate) * 2)
    bits.push(piece)
    len += piece.length
  }
  const joined = new Uint8Array(len)
  let o = 0
  for (const b of bits) {
    joined.set(b, o)
    o += b.length
  }
  let again: W[]
  try {
    again = await hear(joined)
  } catch {
    return { words, holes: holes.length }
  }
  const back = again.map((w) => {
    let k = 0
    while (k + 1 < at.length && at[k + 1].into <= w.start + 0.05) k++
    const d = at[k].from - at[k].into
    return { ...w, start: w.start + d, end: w.end + d }
  })
  return { words: mergeWords(words, back), holes: holes.length }
}

/** The words heard again in the holes, at their times in the whole: those over a word already there are left out. */
export function mergeWords<W extends { start: number; end: number }>(first: W[], again: W[]): W[] {
  const over = (w: W) => first.some((f) => w.start < f.end - 0.05 && w.end > f.start + 0.05)
  return [...first, ...again.filter((w) => !over(w))].sort((a, b) => a.start - b.start)
}
