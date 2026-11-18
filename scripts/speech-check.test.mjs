// Spoken translations checked, and the review's words kept through shorter takes
// (apps/desktop/src/shared/speech-check.ts): node --test scripts/speech-check.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canShorten, checkSpeech, keepEdited, numbers } from '../apps/desktop/src/shared/speech-check.ts'

const lines = [
  { id: 'l1', heard: 'Nu bara 99 kr.', seconds: 2, budget: 40 },
  { id: 'l2', heard: 'Beställ i dag.', seconds: 2, budget: 40 },
]

test('numbers compare by value, in any order', () => {
  assert.equal(numbers('99 kr, 1,5 l'), numbers('1.5 l for 99 kr'))
  assert.notEqual(numbers('99 kr'), numbers('199 kr'))
})

test('a first translation keeps the numbers that were said', () => {
  const got = [
    { id: 'l1', text: 'Nu bara 99 kr.', translation: 'Nå bare 199 kr.' },
    { id: 'l2', text: 'Beställ i dag.', translation: 'Bestill i dag.' },
  ]
  assert.match(checkSpeech(lines, got), /l1: keep the numbers as said \(99\)/)
})

test('a shorter pass keeps the price written in the review, whatever Claude answers', () => {
  // The review changed l1 to the Norwegian price; the take ran long, so the script goes back to Claude.
  const previous = [
    { id: 'l1', text: 'Nu bara 99 kr.', translation: 'Nå koster den bare 199 kroner, bestill nå.', edited: true },
    { id: 'l2', text: 'Beställ i dag.', translation: 'Bestill den allerede i dag.' },
  ]
  // Claude, shown what was heard, puts the Swedish price back.
  const got = [
    { id: 'l1', text: 'Nu bara 99 kr.', translation: 'Nå bare 99 kr.' },
    { id: 'l2', text: 'Beställ i dag.', translation: 'Bestill i dag.' },
  ]
  assert.equal(checkSpeech(lines, got, 1.15, previous), null)
  const kept = keepEdited(got, previous)
  assert.equal(kept[0].translation, 'Nå koster den bare 199 kroner, bestill nå.')
  assert.equal(kept[0].edited, true)
  assert.equal(kept[1].translation, 'Bestill i dag.')
})

test('in a shorter pass the other sentences keep the numbers they have now', () => {
  const previous = [
    { id: 'l1', text: 'Nu bara 99 kr.', translation: 'Nå bare 99 kr.' },
    { id: 'l2', text: 'Beställ i dag.', translation: 'Bestill i dag.' },
  ]
  const got = [
    { id: 'l1', text: 'Nu bara 99 kr.', translation: 'Kun 199 kr.' },
    { id: 'l2', text: 'Beställ i dag.', translation: 'Bestill i dag.' },
  ]
  assert.match(checkSpeech(lines, got, 1.15, previous), /l1: keep the numbers as they are now \(99\)/)
})

test('only sentences Claude wrote are made shorter', () => {
  const script = [{ id: 'l1', edited: true }, { id: 'l2' }]
  assert.deepEqual(canShorten(['l1', 'l2'], script), ['l2'])
  assert.deepEqual(canShorten(['l1'], script), [])
})
