// The links Media › Download finds in what was pasted (apps/desktop/src/shared/download-links.ts):
// node --test scripts/download-links.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linksIn } from '../apps/desktop/src/shared/download-links.ts'

test('one link per line, blank lines and spaces ignored', () => {
  assert.deepEqual(linksIn('https://www.tiktok.com/@a/video/1\n\n  https://www.instagram.com/reel/abc/  \n'), ['https://www.tiktok.com/@a/video/1', 'https://www.instagram.com/reel/abc/'])
})

test('a link pasted twice is looked up once, in the order first pasted', () => {
  assert.deepEqual(linksIn('https://b.example/2 https://a.example/1\nhttps://b.example/2'), ['https://b.example/2', 'https://a.example/1'])
})

test('words around a link and things that are not links are left out', () => {
  assert.deepEqual(linksIn('look at this: https://youtu.be/x?list=1&index=20 ok\nwww.example.com ftp://x'), ['https://youtu.be/x?list=1&index=20'])
  assert.deepEqual(linksIn(''), [])
})
