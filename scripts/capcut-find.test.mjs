// CapCut's projects folder found as CapCut finds it (apps/desktop/src/main/capcut-find.ts): node --test scripts/capcut-find.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { customDraftPath, findCapcutRoot, timelineOf, userDataDirs } from '../apps/desktop/src/main/capcut-find.ts'

const homes = []
const home = () => (homes.push(fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-find-'))), homes.at(-1))
after(() => homes.forEach((h) => fs.rmSync(h, { recursive: true, force: true })))
/** A CapCut project folder with its timeline in `file`, saved `ago` seconds back. */
function project(root, name, file = 'draft_content.json', ago = 0) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, file)
  fs.writeFileSync(f, '{}')
  const t = new Date(Date.now() - ago * 1000)
  fs.utimesSync(f, t, t)
  return dir
}
const macDefault = (h) => path.join(h, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
const setting = (ud, line) => {
  fs.mkdirSync(path.join(ud, 'Config'), { recursive: true })
  fs.writeFileSync(path.join(ud, 'Config', 'globalSetting'), `[General]\r\nsomething=1\r\n${line}\r\n`)
}

test('a Mac: CapCut’s own folder, with a project saved the Mac way (draft_info.json)', () => {
  const h = home()
  project(macDefault(h), 'Promo', 'draft_info.json')
  assert.deepEqual(findCapcutRoot('darwin', h, {}).root, macDefault(h))
})

test('a Mac with the App Store CapCut: its projects inside its container', () => {
  const h = home()
  const box = path.join(h, 'Library', 'Containers', 'com.lemon.lvoverseas', 'Data', 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')
  project(box, 'Promo', 'draft_info.json')
  assert.equal(findCapcutRoot('darwin', h, {}).root, box)
})

test('projects moved in CapCut’s settings are found there', () => {
  const h = home()
  const moved = path.join(h, 'Edits', 'CapCut Drafts')
  project(moved, 'New one')
  project(macDefault(h), 'Old one', 'draft_info.json', 3600)
  setting(path.join(h, 'Movies', 'CapCut', 'User Data'), `currentCustomDraftPath=${moved}`)
  const f = findCapcutRoot('darwin', h, {})
  assert.equal(f.root, moved)
  assert.equal(f.how, 'settings')
})

test('Windows: %LOCALAPPDATA%, and a moved folder written Qt’s way', () => {
  const h = home()
  const local = path.join(h, 'Local')
  const ud = path.join(local, 'CapCut', 'User Data')
  assert.deepEqual(userDataDirs('win32', h, { LOCALAPPDATA: local }), [ud])
  project(path.join(ud, 'Projects', 'com.lveditor.draft'), 'A', 'draft_content.json', 60)
  assert.equal(findCapcutRoot('win32', h, { LOCALAPPDATA: local }).root, path.join(ud, 'Projects', 'com.lveditor.draft'))
  const moved = path.join(h, 'D', 'CapCut Drafts')
  project(moved, 'B')
  setting(ud, `currentCustomDraftPath="${moved}"`)
  assert.equal(findCapcutRoot('win32', h, { LOCALAPPDATA: local }).root, moved)
})

test('the globalSetting line: quotes, doubled backslashes and \\xNNNN letters', () => {
  assert.equal(customDraftPath('[General]\ncurrentCustomDraftPath=D:\\\\CapCut Drafts\n'), 'D:\\CapCut Drafts')
  assert.equal(customDraftPath('currentCustomDraftPath="/Users/a/Movies/Klipp \\x00e5r"'), '/Users/a/Movies/Klipp år')
  assert.equal(customDraftPath('currentCustomDraftPath=\n'), null)
  assert.equal(customDraftPath('other=1'), null)
})

test('a folder the settings name that no longer exists falls back to CapCut’s own', () => {
  const h = home()
  project(macDefault(h), 'Promo', 'draft_info.json')
  setting(path.join(h, 'Movies', 'CapCut', 'User Data'), `currentCustomDraftPath=${path.join(h, 'unplugged drive')}`)
  assert.equal(findCapcutRoot('darwin', h, {}).root, macDefault(h))
})

test('no projects yet: CapCut’s own folder if it’s there; Linux has none', () => {
  const h = home()
  fs.mkdirSync(macDefault(h), { recursive: true })
  assert.equal(findCapcutRoot('darwin', h, {}).root, macDefault(h))
  assert.deepEqual(findCapcutRoot('linux', h, {}), { root: '', how: 'none', looked: [] })
})

test('a project’s timeline: either file, the newer when there are both, none for other folders', () => {
  const h = home()
  const a = project(h, 'mac', 'draft_info.json')
  assert.equal(timelineOf(a), path.join(a, 'draft_info.json'))
  const b = project(h, 'both', 'draft_info.json', 120)
  fs.writeFileSync(path.join(b, 'draft_content.json'), '{}')
  assert.equal(timelineOf(b), path.join(b, 'draft_content.json'))
  fs.mkdirSync(path.join(h, 'not a project'))
  assert.equal(timelineOf(path.join(h, 'not a project')), null)
})
