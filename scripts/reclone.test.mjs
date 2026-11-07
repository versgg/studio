// A clone ElevenLabs wants verified is cloned again once (apps/desktop/src/shared/reclone.ts): node --test scripts/reclone.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloneSpeaker } from '../apps/desktop/src/shared/reclone.ts'

const refusal = () => Object.assign(new Error('ElevenLabs: This voice requires verification. (voice_access_denied)'), { code: 'voice_access_denied' })

function setup({ refuse = [], recloneTo = 'v2' } = {}) {
  const log = []
  let voice = 'v1'
  const say = cloneSpeaker({
    voiceId: () => voice,
    reclone: async (old) => {
      log.push(`reclone ${old}`)
      if (!recloneTo) return null
      voice = recloneTo
      return recloneTo
    },
    refused: () => new Error('verify it'),
  })
  const speak = async (id) => {
    log.push(`speak ${id}`)
    if (refuse.includes(id)) throw refusal()
    return `take by ${id}`
  }
  return { log, say, speak, voice: () => voice }
}

test('a clone that speaks is left alone', async () => {
  const s = setup()
  assert.equal(await s.say(s.speak), 'take by v1')
  assert.deepEqual(s.log, ['speak v1'])
})

test('refused until verified: cloned again once, and the new clone speaks', async () => {
  const s = setup({ refuse: ['v1'] })
  assert.equal(await s.say(s.speak), 'take by v2')
  assert.deepEqual(s.log, ['speak v1', 'reclone v1', 'speak v2'])
  // Later takes in the same run use the new clone.
  assert.equal(await s.say(s.speak), 'take by v2')
})

test('the new clone refused too: stops with the message, no third clone', async () => {
  const s = setup({ refuse: ['v1', 'v2'] })
  await assert.rejects(s.say(s.speak), /verify it/)
  assert.deepEqual(s.log, ['speak v1', 'reclone v1', 'speak v2'])
  await assert.rejects(s.say(s.speak), /verify it/)
  assert.equal(s.log.filter((l) => l.startsWith('reclone')).length, 1)
})

test('no re-clone possible: stops with the message', async () => {
  const s = setup({ refuse: ['v1'], recloneTo: null })
  await assert.rejects(s.say(s.speak), /verify it/)
})

test('any other error goes through as it is, with no re-clone', async () => {
  const s = setup()
  await assert.rejects(
    s.say(async () => {
      throw Object.assign(new Error('Not enough ElevenLabs credits for this.'), { code: 'quota_exceeded' })
    }),
    /credits/,
  )
  assert.deepEqual(s.log, [])
})
