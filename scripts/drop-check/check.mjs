// The drop check itself, run by inner.sh inside the hidden GNOME Shell: a file drag source on
// the left half of the screen, Studio on the right, one real drag (pointer down, across, up)
// onto each place in the editor, and the library (and the timeline, for a timeline drop) must
// take the file.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const D = dirname(fileURLToPath(import.meta.url))
const root = join(D, '..', '..')
const work = process.env.DROP_WORK
const port = 9400 + (process.pid % 500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const input = (...a) => execFileSync('python3', [join(D, 'input.py'), ...a.map(String)])
const page = (expr) => JSON.parse(execFileSync('node', [join(D, 'page.mjs'), String(port), expr]).toString())
const until = async (f, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (f()) return
  throw new Error(`timed out waiting for ${what}`)
}

// Clips in a folder whose name has spaces, like "My Brand/Ads/Week 1".
const clips = join(work, 'Products', 'My Brand', 'Ads', 'Week 1')
mkdirSync(clips, { recursive: true })
const files = ['M1.mov', 'M2.mov', 'M3.mp4', 'M4.mov', 'M5.mp4', 'M6.mov', 'M7.mp4', 'M8.mov'].map((n, i) => {
  const f = join(clips, n)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=360x640:d=${1 + i}`, '-pix_fmt', 'yuv420p', f])
  return f
})

const kids = []
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  p.stdout.on('data', (b) => log.push(String(b)))
  p.stderr.on('data', (b) => log.push(String(b)))
  kids.push(p)
  return log
}
const out = join(root, 'out', 'drop-check')
mkdirSync(out, { recursive: true })
const results = []
let failed = false
try {
  // The source on the left half: tiled, and only trusted once it sees the pointer near the
  // middle of the screen (a press there raises it, so it mustn't reach Studio's half).
  // GNOME Shell starts in the Activities overview, where new windows don't get the focus.
  input('escape')
  const source = run('python3', [join(D, 'source.py'), ...files])
  await until(() => source.join('').includes('up'), 15000, 'the drag source window')
  for (let i = 0; ; i++) {
    await sleep(1000)
    input('tile-left')
    const n = source.length
    input('move', 1350, 500)
    await sleep(300)
    const xs = [...source.slice(n).join('').matchAll(/pointer (\d+)/g)].map((m) => +m[1])
    if (Math.max(0, ...xs) > 1200) break
    if (i === 3) throw new Error('the drag source would not tile on the left half')
  }

  const app = process.env.STUDIO_UI_APP ?? join(root, 'apps', 'desktop')
  const studioLog = run(join(root, 'node_modules', 'electron', 'dist', 'electron'), [app, `--remote-debugging-port=${port}`], {
    STUDIO_USER_DATA: join(work, 'user-data'),
    STUDIO_PROJECTS_DIR: join(work, 'projects'),
    STUDIO_SILENT: '1',
  })
  await until(() => { try { return page(`!!document.querySelector('.bin') && !!document.querySelector('.tl-content')`) } catch { return false } }, 30000, 'Studio’s editor')
  input('tile-right')
  await sleep(1200)

  // Where the window's page sits on the screen: Wayland doesn't say, so move the pointer to a
  // known point over it and read where the page saw it.
  page(`window.__seen = null; addEventListener('pointermove', (e) => (window.__seen = [e.clientX, e.clientY]), true); true`)
  const [sx, sy] = [2100, 600]
  input('move', sx, sy)
  await until(() => page('window.__seen'), 3000, 'the pointer over Studio')
  const [cx, cy] = page('window.__seen')
  const origin = [sx - cx, sy - cy]
  if (origin[0] < 1000) throw new Error(`Studio didn't take the right half of the screen (its page starts at ${origin})`)

  // The library's own count ("In this project · 5"; its grid only draws the tiles in view), and
  // the timeline's clips.
  const count = () => page(`[+(document.querySelector('.bin .lib-head')?.textContent.match(/(\\d+)\\s*$/)?.[1] ?? 0), document.querySelectorAll('.tl-content .clip').length]`)
  // Each spot is where the drag ends; the last small move of every drag (input.py) goes 4 px down
  // and right, so a spot just above an edge lets go in the next element, as a hand often does.
  // The title bar isn't one: it moves the window, and Chromium keeps drags over it to itself.
  const centre = (sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + Math.min(r.height / 2, 60)] })()`
  const pageTo = (n) => `document.querySelectorAll('.page-switch button')[${n}].click(); true`
  const spots = [
    { name: 'the empty library, let go just past the edge of its line of help', lands: 'library',
      aim: `(() => { const p = [...document.querySelectorAll('.bin *')].find((e) => !e.children.length && e.textContent.startsWith('Import video')); const r = p.getBoundingClientRect(); return [r.left + 40, r.bottom - 2] })()` },
    { name: 'the library', lands: 'library', aim: centre('.bin') },
    { name: 'the library’s tabs', lands: 'library', aim: centre('.categories') },
    { name: 'the player', lands: 'library', aim: centre('.player-frame') },
    { name: 'the Inspector', lands: 'library', aim: centre('.insp-head') },
    { name: 'the timeline', lands: 'timeline', aim: centre('.tl-content') },
    { name: 'the Audio page', lands: 'library', go: pageTo(1), back: pageTo(0), aim: centre('.ap-main') },
    // Studio's own drag, which ends the same way: a library clip onto the timeline.
    { name: 'the timeline, a library clip dragged from the library', lands: 'clip', from: centre('.bin [data-media]'), aim: centre('.tl-content') },
  ]
  let [lib, tl] = count()
  for (const spot of spots) {
    if (spot.go) page(spot.go)
    await sleep(spot.go ? 800 : 0)
    const at = page(spot.aim)
    const from = spot.from ? page(spot.from).map((v, i) => origin[i] + v) : [700, 500]
    page(`window.__drags = []; if (!window.__dragsOn) { window.__dragsOn = true; for (const t of ['dragenter', 'dragover', 'drop', 'dragleave']) addEventListener(t, (e) => __drags.push([t, e.target.tagName, e.defaultPrevented]), false) }; true`)
    input('drag', Math.round(from[0]), Math.round(from[1]), Math.round(origin[0] + at[0]), Math.round(origin[1] + at[1]))
    if (spot.back) {
      await sleep(1500)
      page(spot.back)
    }
    const landed = ([l, t]) => (spot.lands === 'clip' ? l === lib && t > tl : l > lib && (spot.lands !== 'timeline' || t > tl))
    const ok = await until(() => landed(count()), 8000, spot.name).then(() => true, () => false)
    const [l2, t2] = count()
    if (!ok) {
      failed = true
      execFileSync('python3', [join(D, 'shot.py'), join(out, `failed-${results.length + 1}.png`)])
      const said = source.join('').split('\n').filter((l) => /^(cancelled|ended)/.test(l)).slice(-2).join(', ')
      console.log(`[drop-check] the source said: ${said || 'nothing'}; the page's last drag events: ${JSON.stringify(page('window.__drags').slice(-4))}`)
    }
    results.push({ spot: spot.name, ok, library: `${lib} → ${l2}`, timeline: `${tl} → ${t2}` })
    console.log(`[drop-check] ${ok ? 'ok  ' : 'FAIL'} dropped on ${spot.name}: library ${lib} → ${l2}, timeline ${tl} → ${t2}`)
    ;[lib, tl] = [l2, t2]
  }
  if (studioLog.some((l) => l.includes('the page stopped'))) throw new Error(studioLog.join(''))
} catch (e) {
  failed = true
  console.error(`[drop-check] ${e.message}`)
} finally {
  for (const k of kids) k.kill()
}
writeFileSync(join(out, 'results.json'), JSON.stringify({ scale: process.env.DROP_SCALE ?? '1', results }, null, 2))
console.log(failed ? 'DROP CHECK FAILED' : `DROP CHECK OK: ${results.length}/${results.length} drops landed`)
await sleep(500)
process.exit(failed ? 1 : 0)
