// Stretches the transcript server skipped (apps/desktop/src/shared/caption-holes.ts): node --test scripts/caption-holes.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { holesOf, levelsOf, mergeWords } from '../apps/desktop/src/shared/caption-holes.ts'

/** Sound in 50 ms steps: `loud` (dBFS) where `on(t)` is true, else near silence. */
const levels = (seconds, on, loud = -20) => Float32Array.from({ length: seconds * 20 }, (_, i) => (on(i / 20) ? loud : -80))
const word = (start, end = start + 0.4) => ({ word: 'w', start, end })

test('a long stretch with sound and no words is a hole; one with words is not', () => {
  // Sound all through 33 s, words at 0–6 s and 30–33 s (the clip Whisper skipped).
  const words = [word(0.2), word(1), word(2.5), word(5.5), word(30.1), word(31), word(32.5)]
  const holes = holesOf(levels(33, () => true), words)
  assert.equal(holes.length, 1)
  assert.ok(Math.abs(holes[0].start - 6.2) < 0.01 && Math.abs(holes[0].end - 29.8) < 0.01, JSON.stringify(holes))
})

test('silence, pauses under 3 s and quiet stretches are not holes', () => {
  assert.deepEqual(holesOf(levels(20, () => false), [word(1)]), [])
  assert.deepEqual(holesOf(levels(10, () => true), [word(0.5), word(2.5), word(4.5), word(6.5), word(8.5)]), [])
  // Sound only a fifth of the time: breaths and clicks, not a voice that went unheard.
  assert.deepEqual(holesOf(levels(20, (t) => t % 1 < 0.2), [word(1)]), [])
})

test('levels are read from 16 kHz 16-bit sound', () => {
  const rate = 16000
  const pcm = new Int16Array(rate * 2)
  for (let i = rate; i < 2 * rate; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate))
  const l = levelsOf(new Uint8Array(pcm.buffer))
  assert.equal(l.length, 40)
  assert.ok(l[5] < -90 && l[30] > -20, `${l[5]} ${l[30]}`)
})

test('words heard again go in between the others, none twice', () => {
  const first = [word(0.2), word(1), word(30)]
  const again = [word(0.9), word(7), word(12)]
  assert.deepEqual(mergeWords(first, again).map((w) => w.start), [0.2, 1, 7, 12, 30])
})
