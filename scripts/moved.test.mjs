// A project moved to another folder or computer (apps/desktop/src/main/moved.ts): node --test scripts/moved.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { folderSwap, rewritePaths } from '../apps/desktop/src/main/moved.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-moved-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a path inside the old folder (either slash) becomes the same path inside the new one; others are left', () => {
  const to = path.join(tmp, 'New.studio')
  const swap = folderSwap('/Users/a/Studio Projects/Ad.studio', to)
  assert.equal(swap('/Users/a/Studio Projects/Ad.studio/text/t1.png'), path.join(to, 'text', 't1.png'))
  assert.equal(swap('/Users/a/Studio Projects/Ad.studio'), to)
  assert.equal(swap('/Users/a/Studio Projects/Ad.studio 2/x.png'), null, 'another folder that starts the same')
  assert.equal(swap('/Users/a/Movies/clip.mp4'), null)
  assert.equal(swap('voice'), null)
  // A Windows folder on another computer: either slash, any case.
  const win = folderSwap('C:\\Users\\a\\Studio Projects\\Ad.studio', to)
  assert.equal(win('c:/users/A/studio projects/ad.studio/dubs/x/line-L01.wav'), path.join(to, 'dubs', 'x', 'line-L01.wav'))
})

test('every JSON file of the project, job files included, points into the copy; the cache is left alone', () => {
  const from = path.join(tmp, 'Old.studio')
  const to = path.join(tmp, 'Copy.studio')
  const write = (f, v) => {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(v, null, 2))
  }
  write(path.join(to, 'project.json'), { name: 'Old', media: [{ path: '/elsewhere/clip.mp4', poster: path.join(from, 'cache', 'm1', 'poster.jpg') }], tracks: [{ clips: [{ text: { png: path.join(from, 'text', 'a.png') } }] }] })
  write(path.join(to, 'dubs', 'D sv x', 'job.json'), { project: from, dir: path.join(from, 'dubs', 'D sv x'), source: '/elsewhere/clip.mp4' })
  write(path.join(to, 'cache', 'm1', 'peaks.json'), { rate: 100, peaks: [1, 2] })
  write(path.join(to, 'cache', 'voices', 'abc.json'), { file: path.join(from, 'voiceovers', 'v.mp3') })
  const n = rewritePaths(to, folderSwap(from, to))
  assert.equal(n, 3)
  const p = JSON.parse(fs.readFileSync(path.join(to, 'project.json'), 'utf8'))
  assert.equal(p.media[0].path, '/elsewhere/clip.mp4', 'outside files stay')
  assert.equal(p.media[0].poster, path.join(to, 'cache', 'm1', 'poster.jpg'))
  assert.equal(p.tracks[0].clips[0].text.png, path.join(to, 'text', 'a.png'))
  const job = JSON.parse(fs.readFileSync(path.join(to, 'dubs', 'D sv x', 'job.json'), 'utf8'))
  assert.deepEqual([job.project, job.dir], [to, path.join(to, 'dubs', 'D sv x')])
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, 'cache', 'voices', 'abc.json'), 'utf8')).file, path.join(to, 'voiceovers', 'v.mp3'))
  assert.match(fs.readFileSync(path.join(to, 'project.json'), 'utf8'), /\n  "name"/, 'indented as it was')
})
