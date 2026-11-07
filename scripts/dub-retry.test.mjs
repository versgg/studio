// Try again on a stopped dub uses the Dub tab's settings (apps/desktop/src/shared/dub-retry.ts): node --test scripts/dub-retry.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeChange, retryPlan, settingsChange } from '../apps/desktop/src/shared/dub-retry.ts'

// A Remove dub with her cloned voice and captions, stopped while speaking (the clone was refused).
const stopped = { lang: 'sv', text: true, removeText: true, model: 'pro', voice: 'clone', voiceId: 'clone-1', voiceName: 'Her own voice (clone)', captions: true, review: true, picks: { texts: [], lines: ['L01', 'L02'] } }
const name = (l) => ({ sv: 'Swedish', no: 'Norwegian' })[l] ?? l
const tab = (o = {}) => ({ lang: 'sv', text: true, removeText: true, model: 'pro', voice: 'clone', captions: true, ...o })

test('the tab as the dub was: no change, and a clone’s id is not a pick', () => {
  assert.deepEqual(settingsChange(stopped, tab()), {})
})

test('another voice picked: that voice, the clone forgotten, everything else kept', () => {
  const c = settingsChange(stopped, tab({ voice: 'voice', voiceId: 'narrator', voiceName: 'Calm Narrator' }))
  assert.deepEqual(c, { voice: 'voice', voiceId: 'narrator', voiceName: 'Calm Narrator' })
  assert.deepEqual(describeChange(stopped, c, name), ['Calm Narrator instead of her cloned voice'])
  const { patch, drop } = retryPlan(stopped, c)
  assert.equal(patch.voice, 'voice')
  assert.equal(patch.voiceId, 'narrator')
  assert.equal(patch.voiceName, 'Calm Narrator')
  assert.ok(!('picks' in patch), 'the picks stay')
  assert.deepEqual(drop, ['voice.json'])
})

test('back to her own voice: the chosen voice is forgotten, so a clone is made', () => {
  const chosen = { ...stopped, voice: 'voice', voiceId: 'narrator', voiceName: 'Calm Narrator' }
  const c = settingsChange(chosen, tab())
  assert.equal(c.voice, 'clone')
  const { patch } = retryPlan(chosen, c)
  assert.ok('voiceId' in patch && patch.voiceId === undefined)
  assert.ok('voiceName' in patch && patch.voiceName === undefined)
})

test('another voice chosen in Audio counts as a change', () => {
  const chosen = { ...stopped, voice: 'voice', voiceId: 'host', voiceName: 'Bright Host' }
  const c = settingsChange(chosen, tab({ voice: 'voice', voiceId: 'narrator', voiceName: 'Calm Narrator' }))
  assert.deepEqual(describeChange(chosen, c, name), ['Calm Narrator instead of Bright Host'])
})

test('captions off only: nothing made again', () => {
  const c = settingsChange(stopped, tab({ captions: false }))
  assert.deepEqual(c, { captions: false })
  assert.deepEqual(describeChange(stopped, c, name), ['no captions'])
  assert.deepEqual(retryPlan(stopped, c).drop, [])
})

test('another language: its translations and the review again', () => {
  const c = settingsChange(stopped, tab({ lang: 'no' }))
  const { patch, drop } = retryPlan(stopped, c)
  assert.ok('picks' in patch && patch.picks === undefined)
  assert.deepEqual(drop.sort(), ['base.mp4', 'looks.json', 'texts.json', 'voice.json'])
  assert.deepEqual(describeChange(stopped, c, name), ['into Norwegian instead of Swedish'])
})

test('Remove to Translate: the texts to pick, the looks measured again', () => {
  const c = settingsChange(stopped, tab({ removeText: false }))
  assert.deepEqual(c, { text: true, removeText: false })
  const { patch, drop } = retryPlan(stopped, c)
  assert.ok('picks' in patch)
  assert.ok(drop.includes('looks.json') && drop.includes('base.mp4'))
  assert.deepEqual(describeChange(stopped, c, name), ['the on-screen text translated, not removed'])
})

test('settings that can’t make a dub are refused before anything changes', () => {
  assert.throws(() => retryPlan(stopped, { voice: 'voice', voiceId: undefined }), /Choose the voice/)
  assert.throws(() => retryPlan({ ...stopped, removeText: false, text: false }, { voice: 'keep', captions: false }), /Pick something/)
  assert.throws(() => retryPlan(stopped, { model: 'skip' }), /needs Vmake/)
})
