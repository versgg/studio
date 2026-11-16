// Studio's zip writer and reader (apps/desktop/src/main/zip.ts): node --test scripts/zip.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { extractItem, listZip, writeZip } from '../apps/desktop/src/main/zip.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-zip-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('files and bytes go in and come back the same; unzip agrees', async () => {
  const media = path.join(dir, 'clip.mp4')
  fs.writeFileSync(media, Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 7919) % 251)))
  const json = path.join(dir, 'project.json')
  fs.writeFileSync(json, JSON.stringify({ name: 'Ä project', tracks: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}` })) }))
  const empty = path.join(dir, 'empty.txt')
  fs.writeFileSync(empty, '')
  const out = path.join(dir, 'out.studio.zip')
  let last = 0
  await writeZip(
    [
      { name: 'Ä project.studio/project.json', file: json },
      { name: 'Ä project.studio/cache/voices/x.json', data: Buffer.from('{"a":1}') },
      { name: 'external/1-clip.mp4', file: media },
      { name: 'notes/empty.txt', file: empty },
    ],
    out,
    (done) => (last = done),
  )
  assert.ok(fs.existsSync(out) && !fs.existsSync(`${out}.part`))
  assert.ok(last >= 3_000_000)
  const items = listZip(out)
  assert.deepEqual(items.map((i) => i.name), ['Ä project.studio/project.json', 'Ä project.studio/cache/voices/x.json', 'external/1-clip.mp4', 'notes/empty.txt'])
  assert.equal(items[0].method, 8, 'JSON deflated')
  assert.equal(items[2].method, 0, 'media stored')
  for (const [i, src] of [[0, json], [2, media], [3, empty]]) {
    const to = path.join(dir, 'back', items[i].name)
    await extractItem(out, items[i], to)
    assert.ok(fs.readFileSync(to).equals(fs.readFileSync(src)), items[i].name)
  }
  if (hasUnzip) execFileSync('unzip', ['-tq', out])
})

test('more files than an ordinary zip holds (Zip64 records): written, listed and tested', async () => {
  const n = 66_000
  const out = path.join(dir, 'many.zip')
  await writeZip(Array.from({ length: n }, (_, i) => ({ name: `f/${i}.txt`, data: Buffer.from(String(i)) })), out)
  const items = listZip(out)
  assert.equal(items.length, n)
  const to = path.join(dir, 'many', 'last.txt')
  await extractItem(out, items[n - 1], to)
  assert.equal(fs.readFileSync(to, 'utf8'), String(n - 1))
  if (hasUnzip) execFileSync('unzip', ['-tq', out])
})

test('not a zip says so', () => {
  const f = path.join(dir, 'not.zip')
  fs.writeFileSync(f, 'hello')
  assert.throws(() => listZip(f), /isn’t a zip/)
})
