// The Vmake wait estimate (apps/desktop/src/shared/vmake-estimate.ts): node --test scripts/vmake-estimate.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectedWait, median, roughly, timeLeft, waitFraction, WAIT_FROM, WAIT_TO } from '../apps/desktop/src/shared/vmake-estimate.ts'

test('median of the rates, odd and even, ignoring nonsense', () => {
  assert.equal(median([]), null)
  assert.equal(median([4]), 4)
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([1, 2, 3, 10]), 2.5)
  assert.equal(median([NaN, -1, 0, 2]), 2)
})

test('a first guess with no history: 3 s per second of video, at least 30 s', () => {
  assert.deepEqual(expectedWait(20, []), { ms: 60_000, firstGuess: true })
  assert.deepEqual(expectedWait(4, []), { ms: 30_000, firstGuess: true })
})

test('learned: seconds of video times the median rate of the last ten jobs', () => {
  assert.deepEqual(expectedWait(10, [2, 4, 100]), { ms: 40_000, firstGuess: false })
  // Only the last ten count: the eleven 100s before them are forgotten.
  const old = Array(11).fill(100)
  assert.equal(expectedWait(10, [...old, ...Array(10).fill(1.5)]).ms, 15_000)
})

test('the bar fills 20 % to 85 % by the clock, stops at 85 % and never goes back', () => {
  assert.equal(waitFraction(0, 60_000), WAIT_FROM)
  assert.equal(waitFraction(30_000, 60_000), 0.525)
  assert.equal(waitFraction(60_000, 60_000), WAIT_TO)
  assert.equal(waitFraction(600_000, 60_000), WAIT_TO, 'held at 85 % past the estimate')
  assert.equal(waitFraction(1_000, 60_000, 0.6), 0.6, 'a later, shorter reading never takes it back')
  assert.equal(waitFraction(1_000, 60_000, 0.99), WAIT_TO, 'and never past 85 % while waiting')
  assert.equal(waitFraction(1_000, 60_000, 0, 50), 0.525, "Vmake's own number wins when it sends one")
})

test('time left in words', () => {
  assert.equal(timeLeft(20_000, 60_000, false), 'about 40 s left')
  assert.equal(timeLeft(0, 60_000, true), 'about 1 min left (first estimate)')
  assert.equal(timeLeft(0, 12 * 60_000, false), 'about 12 min left')
  assert.equal(timeLeft(59_000, 60_000, false), 'about 5 s left')
  assert.equal(timeLeft(61_000, 60_000, false), 'taking longer than usual')
  assert.equal(timeLeft(61_000, 60_000, true), 'taking longer than the first estimate')
  assert.equal(roughly(52_000), '50 s')
  assert.equal(roughly(90_000), '2 min')
})
