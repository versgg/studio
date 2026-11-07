// How ElevenLabs' error answers are read (apps/desktop/src/shared/eleven-permissions.ts): node --test scripts/eleven.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { elevenProblem } from '../apps/desktop/src/shared/eleven-permissions.ts'

test('only a key ElevenLabs calls invalid is a refused key', () => {
  for (const [status, body] of [
    [401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }],
    [401, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } }],
    [401, { detail: { status: 'missing_api_key', message: 'Missing API key' } }],
    [401, null],
  ]) {
    const p = elevenProblem(status, body)
    assert.equal(p.auth, true, JSON.stringify(body))
    assert.match(p.message, /refused that API key/)
  }
})

test('a 401 about credits is about credits, in ElevenLabs’ own words, and keeps the key', () => {
  const said = 'This request exceeds your quota of 10000. You have 57 credits remaining, while 120 credits are required for this request.'
  const p = elevenProblem(401, { detail: { status: 'quota_exceeded', message: said } })
  assert.equal(p.auth, false)
  assert.equal(p.code, 'quota_exceeded')
  assert.doesNotMatch(p.message, /refused/)
  assert.ok(p.message.includes(said), p.message)
  assert.equal(elevenProblem(402, { detail: { status: 'payment_required', message: 'Payment required' } }).auth, false)
  assert.match(elevenProblem(402, null).message, /credits/)
})

test('a credit limit on the key itself points to the key’s settings', () => {
  const p = elevenProblem(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your API key quota of 5000. You have 30 credits remaining on this key.' } })
  assert.equal(p.auth, false)
  assert.match(p.message, /elevenlabs\.io\/app\/developers\/api-keys/)
})

test('any other 401 shows what ElevenLabs said, not a refused key', () => {
  const p = elevenProblem(401, { detail: { status: 'detected_unusual_activity', message: 'Unusual activity detected. Free Tier usage disabled.' } })
  assert.equal(p.auth, false)
  assert.match(p.message, /Unusual activity detected\. Free Tier usage disabled\./)
  assert.doesNotMatch(p.message, /refused/)
})

test('missing permissions, busy, and the other shapes', () => {
  const perm = elevenProblem(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission text_to_speech to execute this operation.' } })
  assert.equal(perm.auth, false)
  assert.match(perm.message, /isn't allowed/)
  assert.match(elevenProblem(429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many' } }).message, /busy/)
  assert.equal(elevenProblem(422, { detail: [{ msg: 'field required' }, { msg: 'value is not a valid id' }] }).message, 'ElevenLabs: field required; value is not a valid id')
  assert.equal(elevenProblem(400, { detail: 'Voice not found' }).message, 'ElevenLabs: Voice not found')
  assert.equal(elevenProblem(500, null).message, 'ElevenLabs: HTTP 500')
  assert.equal(elevenProblem(400, { detail: { status: 'bad_request', message: 'Key sk_0123456789abcdef is not allowed here' } }).message, 'ElevenLabs: Key sk_… is not allowed here (bad_request)')
})
