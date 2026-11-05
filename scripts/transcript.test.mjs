// Captions through the transcript server (apps/desktop/src/main/transcript.ts), against a stand-in
// server on this computer: node --test scripts/transcript.test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'

const HEARD = [
  { word: 'Order', start: 0, end: 0.4 },
  { word: 'yours', start: 0.4, end: 0.8 },
  { word: 'at', start: 0.8, end: 1 },
  { word: 'corvel', start: 1, end: 1.6 },
]
// How the stand-in's script check answers: 'ok', or the real server's answer when its AI account is out of credits.
let check = 'ok'
let posted = []
let deleted = []
let jobs = 0

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1')
    const m = /^\/api\/jobs(?:\/(\w+))?(\/proofread)?$/.exec(req.url)
    if (!m) return send(404, { detail: 'Not found' })
    if (req.method === 'POST' && !m[1]) {
      posted.push({ script: /name="script"/.test(body) })
      return send(200, { id: `job${++jobs}` })
    }
    if (req.method === 'GET') return send(200, { state: 'done', stage: 'done', progress: 1, queue: 0, words: HEARD, language: 'en', changes: [], summary: null, error: null })
    if (req.method === 'DELETE') {
      deleted.push(m[1])
      return send(200, { ok: true })
    }
    if (req.method === 'POST' && m[2]) {
      const { script } = JSON.parse(body)
      assert.equal(script, 'Order yours at Quorvel')
      if (check !== 'ok') return send(502, { detail: 'The proofreader could not finish: AI query: this account has no credits remaining' })
      const words = HEARD.map((w) => (w.word === 'corvel' ? { ...w, word: 'Quorvel' } : w))
      return send(200, { state: 'done', stage: 'done', words, language: 'en', changes: [{ heard: 'corvel', script: 'Quorvel', note: 'brand name', at: 1 }], summary: { message: '1 correction from your script' } })
    }
    send(405, { detail: 'Method not allowed' })
  })
})

let transcribe
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.STUDIO_TRANSCRIPT_URL = `http://127.0.0.1:${server.address().port}/api`
  ;({ transcribe } = await import('../apps/desktop/src/main/transcript.ts'))
})
after(() => server.close())

const run = (script) => transcribe({ audio: Buffer.from('fLaC'), fileName: 'captions.flac', language: 'en', script })

test('with a script: the words are heard first, then checked against it', async () => {
  check = 'ok'
  posted = []
  deleted = []
  const r = await run('Order yours at Quorvel')
  assert.deepEqual(r.words.map((w) => w.word), ['Order', 'yours', 'at', 'Quorvel'])
  assert.equal(r.changes.length, 1)
  assert.equal(r.summary, '1 correction from your script')
  assert.equal(r.unchecked, null)
  assert.deepEqual(posted, [{ script: false }], 'the sound goes without the script, so the words survive a failed check')
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(deleted.length, 1, 'nothing stays on the server')
})

test('when the script check can’t run (the AI account is out of credits), the captions come as heard', async () => {
  check = 'credits'
  deleted = []
  const r = await run('Order yours at Quorvel')
  assert.deepEqual(r.words.map((w) => w.word), ['Order', 'yours', 'at', 'corvel'])
  assert.deepEqual(r.changes, [])
  assert.equal(r.summary, null)
  assert.equal(r.unchecked, 'the server’s AI account has no credits left')
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(deleted.length, 1)
})

test('without a script there is no check', async () => {
  posted = []
  const r = await run(undefined)
  assert.equal(r.words.length, 4)
  assert.equal(r.unchecked, null)
  assert.deepEqual(posted, [{ script: false }])
})
