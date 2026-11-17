// Sentences heard and new takes placed (apps/desktop/src/shared/speech-timing.ts): node --test scripts/speech-timing.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitLines, MAX_LINE, MOVE_UP, playedPart, sentencesOf, SLOWEST, timingOf } from '../apps/desktop/src/shared/speech-timing.ts'

/** Words `per` seconds apart from `from`, each 0.3 s, with a pause of `pause` before word `at`. */
const said = (n, from = 0, per = 0.4, pauses = {}) => {
  const out = []
  let t = from
  for (let i = 0; i < n; i++) {
    t += pauses[i] ?? 0
    out.push({ text: `w${i}`, start: t, end: t + 0.3 })
    t += per
  }
  return out
}

test('a sentence ends at a full stop or a long pause', () => {
  const words = [...said(4), { text: 'end.', start: 1.6, end: 1.9 }, ...said(3, 2.0)]
  const s = sentencesOf(words)
  assert.equal(s.length, 2)
  assert.equal(s[0].text, 'w0 w1 w2 w3 end.')
})

test('a long run with no stop (a CapCut voiceover) is split where it pauses most, none over 9 s', () => {
  // 40 words over 16 s, a 0.8 s pause after word 22.
  const words = said(40, 0, 0.4, { 22: 0.8 })
  const s = sentencesOf(words)
  assert.ok(s.length >= 2, 'split')
  assert.ok(s.every((x) => x.end - x.start <= MAX_LINE + 1e-9), JSON.stringify(s.map((x) => x.end - x.start)))
  // The first cut is at the long pause.
  assert.equal(s[0].text.split(' ').pop(), 'w21')
})

test('a few stray words are no speech', () => {
  assert.deepEqual(sentencesOf(said(2)), [])
})

test("a short file's one or two words are speech", () => {
  assert.equal(sentencesOf(said(2), 1).length, 1)
})

// A heard sentence "w0 … w5" (0–2.3 s into its file), its words 0.4 s apart.
const sentence = () => {
  const words = said(6)
  return { text: words.map((w) => w.text).join(' '), start: words[0].start, end: words[5].end, words }
}
const clip = (inS, lenS, atS = 10, speed = 1) => ({ startUs: atS * 1e6, inUs: inS * 1e6, durationUs: lenS * 1e6, speed })

test('a clip playing the whole sentence says it, where it plays it', () => {
  const p = playedPart(clip(0, 5), sentence())
  assert.equal(p.text, 'w0 w1 w2 w3 w4 w5')
  assert.deepEqual(p.at, [10e6, 12.3e6])
})

test('a clip trimmed to a word or two of a longer take says those words', () => {
  // Plays 1.5–2.4 s of the file: w4 (1.6–1.9) and w5 (2.0–2.3), not the middle of the sentence.
  const p = playedPart(clip(1.5, 0.9), sentence())
  assert.equal(p.text, 'w4 w5')
  assert.equal(p.start, 1.6)
  assert.deepEqual(p.at, [10.1e6, 10.8e6].map(Math.round))
})

test('two clips sharing a sentence each say their own words', () => {
  const a = playedPart(clip(0, 1.1), sentence())
  const b = playedPart(clip(1.1, 2, 20), sentence())
  assert.equal(`${a.text} | ${b.text}`, 'w0 w1 w2 | w3 w4 w5')
})

test('a clip that plays none of its words says nothing', () => {
  assert.equal(playedPart(clip(3, 1), sentence()), null)
})

test("an older reading without word times shares the sentence's time out over its words", () => {
  const { words: _w, ...old } = sentence()
  assert.equal(playedPart(clip(1.6, 1), old).text, 'w4 w5')
})

const at = (placed, id) => placed.find((p) => p.id === id)

test('a take that fits goes at its moment', () => {
  const spoken = [{ id: 'a', start: 1, end: 3 }, { id: 'b', start: 4, end: 6 }]
  const { placed } = fitLines([{ id: 'a', dur: 2.6 }, { id: 'b', dur: 2 }], spoken, 8, 1.08)
  assert.equal(at(placed, 'a').at, 1)
  assert.equal(at(placed, 'a').tempo, 1)
})

test('after a short take the next moves up (up to 1.2 s), keeping the pause that was there', () => {
  const spoken = [{ id: 'a', start: 0, end: 3 }, { id: 'b', start: 3.4, end: 6 }]
  const { placed } = fitLines([{ id: 'a', dur: 1.5 }, { id: 'b', dur: 2.5 }], spoken, 8, 1.08)
  const b = at(placed, 'b')
  assert.ok(b.at >= 3.4 - MOVE_UP - 1e-9 && b.at < 3.4 - 0.6, `moved more than the old 0.6 s: ${b.at}`)
})

test('a short take is spoken a little slower, never below 0.92×, leaving less silence', () => {
  const spoken = [{ id: 'a', start: 0, end: 4 }, { id: 'b', start: 6, end: 8 }]
  const { placed } = fitLines([{ id: 'a', dur: 2 }, { id: 'b', dur: 1.5 }], spoken, 8, 1.08)
  const a = at(placed, 'a')
  assert.ok(a.tempo < 1 && a.tempo >= SLOWEST - 1e-9, String(a.tempo))
  assert.ok(Math.abs(a.dur - 2 / a.tempo) < 1e-9)
})

test('a take too long for its room goes earlier, then faster, and is reported past the most', () => {
  const spoken = [{ id: 'a', start: 1, end: 3 }, { id: 'b', start: 3.2, end: 5 }]
  const { placed, long } = fitLines([{ id: 'a', dur: 2.6 }, { id: 'b', dur: 3 }], spoken, 5, 1.08)
  assert.ok(at(placed, 'a').at < 1, 'earlier into the pause before it')
  assert.deepEqual(long, ['b'])
  assert.equal(at(placed, 'b').tempo, 1.08)
})

test('lines never overlap, and the timing has numbers only', () => {
  const spoken = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, start: i * 2, end: i * 2 + 1.8 }))
  const cut = spoken.map((s, i) => ({ id: s.id, dur: i % 2 ? 2.4 : 0.9 }))
  const { placed } = fitLines(cut, spoken, 12, 1.12)
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i].at >= placed[i - 1].at + placed[i - 1].dur - 1e-9)
  const t = timingOf(placed, spoken, cut)
  assert.equal(t.length, 6)
  for (const row of t) for (const v of Object.values(row)) assert.ok(v === null || typeof v === 'number')
})
