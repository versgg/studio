// Change voice (apps/desktop/src/shared/voice-change.ts): which way, and how clips become stretches: node --test scripts/voice-change.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changerKnows, piecesOf, runsOf } from '../apps/desktop/src/shared/voice-change.ts'

test('the voice changer takes Swedish, Danish and Finnish; Norwegian is said again', () => {
  for (const l of ['sv', 'da', 'fi', 'en', 'de', 'SV', '']) assert.equal(changerKnows(l), true, l)
  for (const l of ['no', 'nn', 'is', 'et', 'hu']) assert.equal(changerKnows(l), false, l)
})

test('pieces cut from one recording go as one stretch; far apart or another file, their own', () => {
  const runs = runsOf([
    { id: 'c3', file: 'a.mp3', inS: 6, endS: 9 },
    { id: 'c1', file: 'a.mp3', inS: 0, endS: 3 },
    { id: 'c2', file: 'a.mp3', inS: 4.5, endS: 5.5 },
    { id: 'c9', file: 'a.mp3', inS: 40, endS: 42 },
    { id: 'c5', file: 'b.mp3', inS: 1, endS: 2 },
  ])
  assert.deepEqual(
    runs.map((r) => [r.file, r.inS, r.endS, r.clips.map((c) => c.id)]),
    [
      ['a.mp3', 0, 9, ['c1', 'c2', 'c3']],
      ['a.mp3', 40, 42, ['c9']],
      ['b.mp3', 1, 2, ['c5']],
    ],
  )
})

test('a stretch stays under the voice changer’s 5 minutes', () => {
  const clips = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, file: 'long.wav', inS: i * 60, endS: i * 60 + 59 }))
  const runs = runsOf(clips)
  assert.ok(runs.every((r) => r.endS - r.inS <= 290))
  assert.equal(runs.flatMap((r) => r.clips).length, 8)
})

test('each clip says only the words heard in it; a sentence a cut runs through is split there', () => {
  const w = (text, start) => ({ text, start, end: start + 0.3 })
  const sentences = [
    { text: 'Det här är en test.', start: 0.2, end: 1.9, words: [w('Det', 0.2), w('här', 0.6), w('är', 1.0), w('en', 1.3), w('test.', 1.6)] },
    { text: 'Nu, kommer den andra meningen.', start: 3.0, end: 4.6, words: [w('Nu,', 3.0), w('kommer', 3.4), w('den', 3.7), w('andra', 4.0), w('meningen.', 4.3)] },
  ]
  // Clip 1 plays 0–1.25 s ("Det här är"), clip 2 from 3.6 s ("den andra meningen.");
  // "en test." and "Nu, kommer" were cut out.
  const run = { file: 'vo.mp3', inS: 0, endS: 5, clips: [{ id: 'a', file: 'vo.mp3', inS: 0, endS: 1.25 }, { id: 'b', file: 'vo.mp3', inS: 3.6, endS: 5 }] }
  const [a, b] = piecesOf(sentences, run)
  assert.deepEqual(a.pieces.map((p) => p.text), ['Det här är'])
  assert.deepEqual(b.pieces.map((p) => p.text), ['den andra meningen.'])
  // Times are from each clip's own in-point.
  assert.equal(a.pieces[0].start, 0.2)
  assert.ok(Math.abs(b.pieces[0].start - 0.1) < 1e-9 && Math.abs(b.pieces[0].end - 1.0) < 1e-9)
  assert.notEqual(a.pieces[0].id, b.pieces[0].id)
})
