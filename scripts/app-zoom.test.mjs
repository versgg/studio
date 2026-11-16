// App zoom's steps and keys (apps/desktop/src/shared/app-zoom.ts): node --test scripts/app-zoom.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextZoom, zoomOf } from '../apps/desktop/src/shared/app-zoom.ts'

test('steps in and out, stops at the ends, and 0 is back to 100 %', () => {
  assert.equal(nextZoom(1, 1), 1.1)
  assert.equal(nextZoom(1, -1), 0.9)
  assert.equal(nextZoom(2, 1), 2)
  assert.equal(nextZoom(0.67, -1), 0.67)
  assert.equal(nextZoom(1.75, 0), 1)
  // A size between two steps goes to the next one either way.
  assert.equal(nextZoom(1.2, 1), 1.25)
  assert.equal(nextZoom(1.2, -1), 1.1)
})

test('never past what the screen fits', () => {
  assert.equal(nextZoom(1.25, 1, 1.4), 1.25)
  assert.equal(nextZoom(1, 1, 1.4), 1.1)
})

const press = (code, o = {}) => ({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, code, key: '', ...o })

test('American keys: Ctrl+Shift+= and Ctrl+Shift+−, by character', () => {
  assert.equal(zoomOf(press('Equal'), '='), 1)
  assert.equal(zoomOf(press('Minus'), '-'), -1)
  assert.equal(zoomOf(press('Digit0'), '0'), 0)
})

test('Swedish keys: + is where − is on an American keyboard, − where / is', () => {
  // The + key (code Minus) zooms in, and − (code Slash) zooms out: by what they type.
  assert.equal(zoomOf(press('Minus'), '+'), 1)
  assert.equal(zoomOf(press('Slash'), '-'), -1)
})

test('Cmd on a Mac, the number pad, and not without Shift or with Alt', () => {
  assert.equal(zoomOf(press('Equal', { ctrlKey: false, metaKey: true }), '='), 1)
  assert.equal(zoomOf(press('NumpadAdd'), null), 1)
  assert.equal(zoomOf(press('NumpadSubtract'), null), -1)
  assert.equal(zoomOf(press('Equal', { shiftKey: false }), '='), null, 'Ctrl+= is the timeline’s')
  assert.equal(zoomOf(press('Equal', { altKey: true }), '='), null)
  assert.equal(zoomOf(press('KeyA'), 'a'), null)
})

test('without the keyboard’s layout, by what Shift made of the key', () => {
  assert.equal(zoomOf(press('Equal', { key: '+' }), null), 1, 'American Shift+=')
  assert.equal(zoomOf(press('Minus', { key: '_' }), null), -1, 'American Shift+−')
  assert.equal(zoomOf(press('Minus', { key: '?' }), null), 1, 'the Nordic + key')
  assert.equal(zoomOf(press('Slash', { key: '_' }), null), -1, 'the Nordic − key')
  assert.equal(zoomOf(press('BracketRight', { key: '*' }), null), 1, 'the German + key')
  assert.equal(zoomOf(press('Slash', { key: '?' }), null), null, 'an American ? is not zoom')
})
