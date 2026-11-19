// Each sentence's voice in a voiceover two voices speak (apps/desktop/src/shared/voice-match.ts): node --test scripts/voice-match.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyLines, voicesBySentence } from '../apps/desktop/src/shared/voice-match.ts'

const line = (voiceId, text, at = 1) => ({ voiceId, voiceName: voiceId === 'a' ? 'Anna' : 'Erik', model: 'eleven_v3', text, speed: 1, at })

test('a dialogue item becomes one line per voice; a plain take stays one line', () => {
  const lines = historyLines([
    { voice_id: '', text: '', model_id: 'eleven_v3', date_unix: 5, dialogue: [{ text: 'Hej, vad gör du idag?', voice_id: 'a', voice_name: 'Anna' }, { text: 'Jag ska till stranden med barnen.', voice_id: 'e', voice_name: 'Erik' }] },
    { voice_id: 'a', voice_name: 'Anna', text: 'Ett annat manus.', model_id: 'eleven_v4', date_unix: 3, settings: { speed: 1.1 } },
  ])
  assert.deepEqual(lines.map((l) => [l.voiceId, l.voiceName, l.text, l.model, l.at]), [
    ['a', 'Anna', 'Hej, vad gör du idag?', 'eleven_v3', 5],
    ['e', 'Erik', 'Jag ska till stranden med barnen.', 'eleven_v3', 5],
    ['a', 'Anna', 'Ett annat manus.', 'eleven_v4', 3],
  ])
  assert.equal(lines[2].speed, 1.1)
})

test('two voices in one file: each sentence gets the voice that said it', () => {
  const sentences = [{ text: 'Hej, vad gör du idag?' }, { text: 'Jag ska till stranden med barnen.' }, { text: 'Vad roligt, ha det så bra!' }]
  const history = [line('a', 'Hej, vad gör du idag?'), line('e', 'Jag ska till stranden med barnen.'), line('a', 'Vad roligt, ha det så bra!'), line('e', 'Något helt annat som sades i en annan film.')]
  assert.deepEqual(voicesBySentence(sentences, history)?.map((l) => l?.voiceId ?? null), ['a', 'e', 'a'])
})

test('one voice, or history from other files: nothing per sentence (the file’s voice stands)', () => {
  const sentences = [{ text: 'Hej, vad gör du idag?' }, { text: 'Jag ska till stranden med barnen.' }]
  assert.equal(voicesBySentence(sentences, [line('a', 'Hej, vad gör du idag? Jag ska till stranden med barnen.')]), null)
  assert.equal(voicesBySentence(sentences, [line('a', 'Hej, vad gör du idag?'), line('e', 'Helt andra ord i en annan reklam.')]), null)
})

test('a sentence neither voice holds is left to the file’s voice', () => {
  const sentences = [{ text: 'Hej, vad gör du idag?' }, { text: 'Jag ska till stranden med barnen.' }, { text: 'Ord som inte finns någonstans.' }]
  const history = [line('a', 'Hej, vad gör du idag?'), line('e', 'Jag ska till stranden med barnen.')]
  assert.deepEqual(voicesBySentence(sentences, history)?.map((l) => l?.voiceId ?? null), ['a', 'e', null])
})
