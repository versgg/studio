// A voice on its own or over music (apps/desktop/src/shared/voice-mix.ts): node --test scripts/voice-mix.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overOtherSound } from '../apps/desktop/src/shared/voice-mix.ts'

const RATE = 8000
/** `seconds` of sound: `voice(t)` and `bed(t)` added, each in -1…1. */
function sound(seconds, voice, bed = () => 0) {
  const pcm = new Int16Array(Math.round(seconds * RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round((voice(t) + bed(t)) * 32767)))
  }
  return pcm
}
/** Words every 0.4 s from 0.5 s to `until`, each 0.3 s long, and a voice tone while they're said. */
const wordsTo = (until) => Array.from({ length: Math.floor((until - 0.5) / 0.4) }, (_, i) => ({ start: 0.5 + i * 0.4, end: 0.8 + i * 0.4 }))
const speaking = (words) => (t) => (words.some((w) => t >= w.start && t <= w.end) ? 0.4 * Math.sin(2 * Math.PI * 220 * t) : 0)
const music = (level) => (t) => level * Math.sin(2 * Math.PI * 523 * t)

test('a voiceover on its own, silent between and after its words', () => {
  const words = wordsTo(6)
  assert.equal(overOtherSound(sound(9, speaking(words)), RATE, words), false)
})

test('a voiceover with a quiet room under it (−50 dBFS) is still on its own', () => {
  const words = wordsTo(6)
  assert.equal(overOtherSound(sound(9, speaking(words), music(0.003)), RATE, words), false)
})

test('a voice over music that plays all the way through', () => {
  const words = wordsTo(6)
  assert.equal(overOtherSound(sound(10, speaking(words), music(0.08)), RATE, words), true)
})

test('a voice that talks the whole time can’t be judged, so it counts as on its own', () => {
  const words = [{ start: 0, end: 6 }]
  assert.equal(overOtherSound(sound(6, (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t), music(0.08)), RATE, words), false)
})

test('music far under a loud voice (more than 25 dB) is ignored', () => {
  const words = wordsTo(6)
  const loud = (t) => (words.some((w) => t >= w.start && t <= w.end) ? 0.9 * Math.sin(2 * Math.PI * 220 * t) : 0)
  assert.equal(overOtherSound(sound(10, loud, music(0.004)), RATE, words), false)
})
