// A dub's clone is deleted after each use unless it's kept (apps/desktop/src/shared/clone-lease.ts): node --test scripts/clone-lease.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloneLease } from '../apps/desktop/src/shared/clone-lease.ts'

function account({ keep = false, id } = {}) {
  const live = new Set(id ? [id] : [])
  const log = []
  let current = id
  let n = 0
  const state = { keep }
  const lease = cloneLease({
    id: () => current,
    make: async () => {
      current = `c${++n}`
      live.add(current)
      log.push(`make ${current}`)
      return current
    },
    drop: async (x) => {
      live.delete(x)
      log.push(`drop ${x}`)
      current = undefined
    },
    keep: () => state.keep,
  })
  return { lease, live, log, state, current: () => current }
}

test('no clone: one is made, used, and deleted after', async () => {
  const a = account()
  assert.equal(await a.lease.use(async (id) => `spoke with ${id}`), 'spoke with c1')
  assert.deepEqual(a.log, ['make c1', 'drop c1'])
  assert.equal(a.live.size, 0)
})

test('the dub’s own clone (made while dubbing) is deleted by tidy', async () => {
  const a = account({ id: 'own' })
  await a.lease.tidy()
  assert.deepEqual(a.log, ['drop own'])
  assert.equal(a.live.size, 0)
})

test('kept: made once, used again, never deleted', async () => {
  const a = account({ keep: true })
  await a.lease.use(async () => {})
  await a.lease.use(async () => {})
  await a.lease.tidy()
  assert.deepEqual(a.log, ['make c1'])
  assert.equal(a.live.size, 1)
})

test('a use that fails still deletes the clone', async () => {
  const a = account()
  await assert.rejects(a.lease.use(async () => { throw new Error('ElevenLabs said no') }), /said no/)
  assert.deepEqual(a.log, ['make c1', 'drop c1'])
})

test('two uses at once run one after the other, so one never deletes the clone the other speaks with', async () => {
  const a = account()
  const speaking = []
  const use = (tag) => a.lease.use(async (id) => {
    speaking.push(`${tag} starts with ${id} (live: ${a.live.has(id)})`)
    await new Promise((r) => setTimeout(r, 20))
    speaking.push(`${tag} ends with ${id} (live: ${a.live.has(id)})`)
  })
  await Promise.all([use('A'), use('B')])
  assert.deepEqual(speaking, ['A starts with c1 (live: true)', 'A ends with c1 (live: true)', 'B starts with c2 (live: true)', 'B ends with c2 (live: true)'])
  assert.equal(a.live.size, 0)
})

test('Delete picked later: a kept clone goes at once', async () => {
  const a = account({ keep: true })
  await a.lease.use(async () => {})
  a.state.keep = false
  await a.lease.tidy()
  assert.equal(a.live.size, 0)
})
