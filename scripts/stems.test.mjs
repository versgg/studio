// Stems helpers (apps/desktop/src/shared/stems.ts): node --test scripts/stems.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { covers, doubled, expectedMs, measure, overlap, pickStems, separatingFraction, separatingLeft, sortStems, sourceSpan, stemLabel, stemRole, usually } from '../apps/desktop/src/shared/stems.ts'

const S = 1_000_000

test('names and order as the server’s own page shows them', () => {
  assert.equal(stemLabel('vocals_lead'), 'Vocals lead')
  assert.equal(stemLabel('other-x-guitar'), 'Other without guitar')
  assert.equal(stemLabel('music_fx'), 'Music fx')
  const names = ['speech_dereverb', 'instrumental', 'bass', 'mystery', 'vocals', 'dialogue', 'vocals_backing', 'vocals_lead']
  assert.deepEqual(sortStems(names.map((name) => ({ name }))).map((x) => x.name), ['vocals', 'vocals_lead', 'vocals_backing', 'dialogue', 'instrumental', 'bass', 'speech_dereverb', 'mystery'])
  assert.equal(stemRole('vocals_backing'), 'voice')
  assert.equal(stemRole('dialogue'), 'voice')
  assert.equal(stemRole('drums'), 'music')
})

test('a part picked with the stem that holds it is said to play twice', () => {
  assert.deepEqual(doubled(['instrumental', 'drums', 'vocals']), ['Drums is already in Instrumental'])
  assert.deepEqual(doubled(['vocals', 'vocals_lead', 'guitar', 'guitar_electric']), ['Vocals lead is already in Vocals', 'Guitar electric is already in Guitar'])
  assert.deepEqual(doubled(['drums', 'bass']), [])
})

test('how long it usually takes, and the bar while it runs', () => {
  assert.equal(expectedMs(10), 67_000)
  assert.equal(usually(10), 'about 1 min')
  assert.equal(usually(240), 'about 6 min')
  assert.equal(separatingFraction(0, 60_000), 0.2)
  assert.equal(separatingFraction(30_000, 60_000), 0.525)
  assert.equal(separatingFraction(600_000, 60_000), 0.85, 'held at 85 % past the estimate')
  assert.equal(separatingFraction(0, 60_000, 0.6), 0.6, 'never back')
  assert.equal(separatingLeft(20_000, 60_000), 'about 40 s left')
  assert.equal(separatingLeft(90_000, 60_000), 'taking longer than usual')
})

test('a stem’s level from its samples: silent below −60 dBFS, a quiet bed is not', () => {
  const rate = 1000
  const tone = (amp, secs = 1) => Int16Array.from({ length: rate * secs }, (_, i) => Math.round(amp * 32767 * Math.sin(i / 3)))
  const loud = measure(tone(0.5), rate, 10)
  assert.ok(Math.abs(loud.levelDb - -9) < 0.5, `a −6 dB peak sine is about −9 dBFS RMS, got ${loud.levelDb}`)
  assert.equal(loud.silent, false)
  assert.equal(loud.peaks.length, 10)
  assert.ok(loud.peaks.every((p) => p > 0.45 && p <= 0.5))
  // AudioShake's empty stems measured −68 dBFS and lower; a bed under a voice −51.
  assert.equal(measure(tone(10 ** (-65 / 20)), rate).silent, true)
  assert.equal(measure(tone(10 ** (-48 / 20)), rate).silent, false)
  const zero = measure(new Int16Array(rate), rate, 4)
  assert.deepEqual([zero.levelDb, zero.silent, zero.peaks], [-120, true, [0, 0, 0, 0]])
  // One loud moment is enough to be heard.
  const blip = new Int16Array(rate * 2)
  blip.set(tone(0.3, 0.1).subarray(0, 100), 500)
  assert.equal(measure(blip, rate).silent, false)
})

test('which separation a clip shows: running first, else the one covering most, newest first', () => {
  const clip = { id: 'c1', mediaId: 'm', inUs: 2 * S, durationUs: 4 * S, speed: 1 }
  const job = (o) => ({ id: 'j', dir: o.dir, clipId: 'cX', mediaId: 'm', inUs: 2 * S, spanUs: 4 * S, state: 'done', startedAt: 1, stems: [], ...o })
  assert.deepEqual(sourceSpan({ ...clip, speed: 2 }), { from: 2 * S, to: 10 * S }, 'at 2× it plays twice the source')
  const whole = job({ dir: 'a', startedAt: 1 })
  const part = job({ dir: 'b', inUs: 3 * S, spanUs: S, startedAt: 2 })
  const other = job({ dir: 'c', mediaId: 'n', startedAt: 3 })
  const away = job({ dir: 'd', inUs: 20 * S, startedAt: 4 })
  assert.equal(overlap(clip, part), S)
  assert.equal(overlap(clip, other), 0, 'another file')
  assert.equal(overlap(clip, away), 0, 'another stretch')
  assert.equal(pickStems(clip, [whole, part, other, away]).job?.dir, 'a', 'the one covering all of it, though older')
  assert.ok(covers(clip, whole) && !covers(clip, part))
  const live = job({ dir: 'e', state: 'separating', startedAt: 5 })
  assert.equal(pickStems(clip, [whole, live]).job?.dir, 'e')
  // A failed try for this clip since the stems: said, the stems still shown.
  const failed = job({ dir: 'f', clipId: 'c1', state: 'failed', reason: 'That is the hourly limit for this address. Try again later.', startedAt: 6 })
  const r = pickStems(clip, [whole, failed])
  assert.equal(r.job?.dir, 'a')
  assert.equal(r.failed?.reason, 'That is the hourly limit for this address. Try again later.')
  assert.equal(pickStems(clip, [failed]).job, undefined)
  // A split half (another clip id) playing part of the same stretch uses the same stems.
  assert.equal(pickStems({ ...clip, id: 'c2', inUs: 4 * S, durationUs: S }, [whole]).job?.dir, 'a')
})
