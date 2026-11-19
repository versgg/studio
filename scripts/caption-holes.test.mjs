// Stretches the transcript server skipped (apps/desktop/src/shared/caption-holes.ts): node --test scripts/caption-holes.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillHoles, holesOf, levelsOf, mergeWords } from '../apps/desktop/src/shared/caption-holes.ts'

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

/** 16 kHz samples: a tone where `on(t)` is true, silence elsewhere. */
const pcmOf = (seconds, on) => {
  const rate = 16000
  const a = new Int16Array(rate * seconds)
  for (let i = 0; i < a.length; i++) if (on(i / rate)) a[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate))
  return new Uint8Array(a.buffer)
}

test('the stretch Whisper skipped is heard on its own and its words land at their times in the whole', async () => {
  // Sound all through 33 s; the first hearing has words at 0–6 s and 30–33 s only.
  const pcm = pcmOf(33, () => true)
  const first = [word(0.2), word(2), word(5.4), word(30.2), word(32)]
  let sent = 0
  const filled = await fillHoles(pcm, first, async (again) => {
    sent = again.byteLength / 2 / 16000
    // What it says in what it was given: a word every 2 s from 0.5 s.
    return Array.from({ length: Math.floor(sent / 2) }, (_, i) => word(0.5 + i * 2))
  })
  assert.equal(filled.holes, 1)
  // Only the hole was sent (6.1–29.9 s: 0.3 s kept around each word; and 0.2 s either side), not the whole 33 s.
  assert.ok(sent > 23 && sent < 25, `sent ${sent} s`)
  const middle = filled.words.filter((w) => w.start > 6 && w.start < 30)
  assert.ok(middle.length >= 10, `${middle.length} words in the middle`)
  // A word 0.5 s into what was sent (from 5.9 s) is at 6.4 s in the whole.
  assert.ok(Math.abs(middle[0].start - 6.4) < 0.05, `first middle word at ${middle[0].start}`)
  assert.deepEqual(filled.words.map((w) => w.start), [...filled.words.map((w) => w.start)].sort((a, b) => a - b))
})

test('a second hearing that fails, or nothing to hear again, leaves the words as they were', async () => {
  const pcm = pcmOf(20, () => true)
  const first = [word(0.5), word(1.5)]
  const failed = await fillHoles(pcm, first, async () => {
    throw new Error('server busy')
  })
  assert.deepEqual(failed.words, first)
  let asked = false
  const none = await fillHoles(pcmOf(20, () => false), first, async () => ((asked = true), []))
  assert.equal(none.holes, 0)
  assert.equal(asked, false)
})
