// A Mac app opened from the Dock gets the PATH Terminal has (apps/desktop/src/main/shell-path.ts): node --test scripts/shell-path.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePath } from '../apps/desktop/src/main/shell-path.ts'

const launchd = '/usr/bin:/bin:/usr/sbin:/sbin'

test('opened from the Dock: the login shell’s PATH comes first, so Homebrew’s FFmpeg is found', () => {
  const p = mergePath('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/a/.local/bin', launchd, '/Users/a').split(':')
  assert.equal(p[0], '/opt/homebrew/bin')
  assert.equal(new Set(p).size, p.length, 'each folder once')
  assert.ok(p.includes('/usr/bin'))
})

test('the login shell couldn’t be read: Homebrew’s folders are added after what the app was given', () => {
  const p = mergePath('', launchd, '/Users/a').split(':')
  assert.deepEqual(p.slice(0, 4), launchd.split(':'))
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/Users/a/.local/bin', '/Users/a/.cargo/bin']) assert.ok(p.includes(d), d)
})

test('started from Terminal: nothing changes order, nothing is doubled', () => {
  const term = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  assert.equal(mergePath(term, term, '/Users/a'), [term, '/opt/homebrew/sbin', '/Users/a/.local/bin', '/Users/a/.cargo/bin'].join(':'))
})
