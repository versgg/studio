// Send to Director's hand-over (apps/desktop/src/main/director.ts): node --test scripts/director.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { aboutVoices, beginPackage, directorUrl, discardPackage, finishPackage, inboxDir, isPartial, packageName, phrasesOf, sendFile, slugOf, stampOf, wavInfo } from '../apps/desktop/src/main/director.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-director-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A 48 kHz mono 16-bit WAV of `seconds` of a tone. */
function wav(file, seconds) {
  const rate = 48_000
  const pcm = Buffer.alloc(Math.round(rate * seconds) * 2)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 330 * i) / rate)), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(file, Buffer.concat([head, pcm]))
}

test('the slug is the name in lowercase ASCII, a–z 0–9 and hyphens, at most 40 characters', () => {
  assert.equal(slugOf('Röstspår — Höstrea 2'), 'rostspar-hostrea-2')
  assert.equal(slugOf('Æble & Øl: Straße'), 'aeble-ol-strasse')
  assert.equal(slugOf('  --Voice__over!!  '), 'voice-over')
  assert.equal(slugOf('Ünïcödé fiancé'), 'unicode-fiance')
  const long = slugOf('a very long voiceover name that goes on and on past forty characters')
  assert.ok(long.length <= 40, long)
  assert.match(long, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'no hyphen left at the end after cutting')
  assert.equal(slugOf('🎙️ 日本語'), 'voice', 'nothing ASCII left')
  assert.equal(slugOf(''), 'voice')
})

test('the stamp is YYYYMMDD-HHMMSS in local time', () => {
  assert.equal(stampOf(new Date(2026, 10, 7, 9, 5, 3)), '20261107-090503')
})

test('each clip is a phrase, in seconds from the first clip’s start, in timeline order; gaps stay', () => {
  const clips = [
    { startUs: 5_600_000, durationUs: 2_400_000 },
    { startUs: 500_000, durationUs: 2_000_000 },
    { startUs: 3_000_000, durationUs: 2_000_000 },
  ]
  const { duration, phrases } = phrasesOf(clips)
  assert.equal(duration, 7.5)
  assert.deepEqual(
    phrases.map((p) => [p.start, p.end]),
    [
      [0, 2],
      [2.5, 4.5],
      [5.1, 7.5],
    ],
  )
  assert.ok(phrases.every((p) => p.text === null))
  // To the millisecond.
  const odd = phrasesOf([{ startUs: 1_000_000, durationUs: 1_234_567 }])
  assert.deepEqual(odd.phrases[0], { start: 0, end: 1.235, text: null })
  assert.deepEqual(phrasesOf([]), { duration: 0, phrases: [] })
})

test('a phrase’s text is the script label over it; markers and Studio’s own label names are not text', () => {
  const clips = [
    { startUs: 0, durationUs: 2_000_000 },
    { startUs: 2_500_000, durationUs: 2_000_000 },
    { startUs: 5_000_000, durationUs: 2_000_000 },
    { startUs: 7_500_000, durationUs: 1_000_000 },
  ]
  const labels = [
    { startUs: 100_000, endUs: 1_900_000, text: ' Soft leather   from the first step. ' },
    { startUs: 2_400_000, endUs: 3_400_000, text: 'Zips on both sides,' },
    { startUs: 3_400_000, endUs: 4_600_000, text: 'so they slip on.' },
    { startUs: 5_000_000, endUs: 7_000_000, text: 'Sound 3' },
    { startUs: 5_500_000, endUs: 5_500_000, text: 'Order yours' },
    // Mostly over the gap after the last clip: not its text.
    { startUs: 8_300_000, endUs: 9_900_000, text: 'Not said' },
  ]
  const { phrases } = phrasesOf(clips, labels)
  assert.deepEqual(
    phrases.map((p) => p.text),
    ['Soft leather from the first step.', 'Zips on both sides, so they slip on.', null, null],
  )
})

test('send.json carries the contract’s fields, with the script and language or null', () => {
  const now = new Date('2026-11-17T10:20:30.000Z')
  const s = sendFile({ name: 'Spring voice', clips: [{ startUs: 1_000_000, durationUs: 2_000_000 }], script: '  Line one.\nLine two.\n', language: 'sv', now })
  assert.deepEqual(s, {
    version: 1,
    app: 'Studio',
    createdAt: '2026-11-17T10:20:30.000Z',
    name: 'Spring voice',
    audio: 'voice.wav',
    duration: 2,
    phrases: [{ start: 0, end: 2, text: null }],
    script: 'Line one.\nLine two.',
    language: 'sv',
  })
  const bare = sendFile({ name: '', clips: [{ startUs: 0, durationUs: 1_000_000 }], script: '   ', now })
  assert.equal(bare.script, null)
  assert.equal(bare.language, null)
  assert.equal(bare.name, 'Voice')
})

test('the inbox is Director’s folder in the app data folder, or the test one', () => {
  assert.equal(inboxDir('/home/u/.config', {}), path.join('/home/u/.config', 'Director', 'inbox'))
  assert.equal(inboxDir('/home/u/.config', { STUDIO_DIRECTOR_INBOX: '/tmp/x' }), '/tmp/x')
})

test('a package is written as .partial (inbox made if missing), then renamed whole; names never clash', () => {
  const inbox = path.join(tmp, 'Director', 'inbox')
  const now = new Date(2026, 10, 17, 14, 3, 9)
  const a = beginPackage(inbox, 'Höst röst', now)
  assert.equal(a.name, '20261117-140309-host-rost')
  assert.equal(a.dir, path.join(inbox, '20261117-140309-host-rost.partial'))
  assert.ok(fs.statSync(a.dir).isDirectory())
  assert.ok(isPartial(inbox, a.dir))
  assert.ok(!isPartial(inbox, path.join(tmp, 'elsewhere.partial')), 'outside the inbox')
  assert.ok(!isPartial(inbox, path.join(inbox, 'done')), 'not a .partial')
  // The same second and name again: the next free name, while the first is still being written.
  const b = beginPackage(inbox, 'Höst röst', now)
  assert.equal(b.name, '20261117-140309-host-rost-2')

  // No voice yet: refused, nothing renamed.
  assert.throws(() => finishPackage(a.dir, sendFile({ name: 'Höst röst', clips: [{ startUs: 0, durationUs: 1_500_000 }] })), /rendered/)
  assert.ok(fs.existsSync(a.dir))

  wav(path.join(a.dir, 'voice.wav'), 1.5)
  const send = sendFile({ name: 'Höst röst', clips: [{ startUs: 0, durationUs: 1_500_000 }], language: 'sv' })
  const final = finishPackage(a.dir, send)
  assert.equal(final, path.join(inbox, '20261117-140309-host-rost'))
  assert.ok(!fs.existsSync(a.dir), 'the .partial folder is gone')
  assert.deepEqual(fs.readdirSync(final).sort(), ['send.json', 'voice.wav'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(final, 'send.json'), 'utf8')), send)
  assert.equal(packageName(inbox, 'Höst röst', now), '20261117-140309-host-rost-3', 'both names are taken now')

  // One that failed is cleared away; nothing outside the inbox ever is.
  discardPackage(inbox, b.dir)
  assert.ok(!fs.existsSync(b.dir))
  const outside = path.join(tmp, 'keep.partial')
  fs.mkdirSync(outside)
  discardPackage(inbox, outside)
  assert.ok(fs.existsSync(outside))
  assert.equal(directorUrl('20261117-140309-host-rost'), 'director://inbox/20261117-140309-host-rost')
})

test('a WAV’s length comes from its header', () => {
  const f = path.join(tmp, 'len.wav')
  wav(f, 2.25)
  const w = wavInfo(f)
  assert.equal(w.rate, 48_000)
  assert.equal(w.channels, 1)
  assert.equal(w.bits, 16)
  assert.ok(Math.abs(w.seconds - 2.25) < 1e-6, String(w.seconds))
  fs.writeFileSync(path.join(tmp, 'not.wav'), 'hello')
  assert.equal(wavInfo(path.join(tmp, 'not.wav')), null)
  assert.equal(wavInfo(path.join(tmp, 'missing.wav')), null)
})

test('the script and language come from the files kept beside the voiceovers', () => {
  const vo = path.join(tmp, 'voiceovers')
  fs.mkdirSync(vo)
  const a = path.join(vo, 'first take.mp3')
  const b = path.join(vo, 'second.mp3')
  fs.writeFileSync(path.join(vo, 'first take.script.txt'), 'Line one.\nLine two.\n')
  fs.writeFileSync(path.join(vo, 'second.script.txt'), 'Line three.\n')
  fs.writeFileSync(path.join(vo, 'second.voice.json'), JSON.stringify({ voiceId: 'x', languageCode: 'sv' }))
  assert.deepEqual(aboutVoices([a, b, a]), { script: 'Line one.\nLine two.\n\nLine three.', language: 'sv' })
  assert.deepEqual(aboutVoices([path.join(vo, 'none.wav')]), { script: null, language: null })
})
