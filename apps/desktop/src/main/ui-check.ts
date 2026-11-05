// The app test: drives the real window while it stays hidden (import, timeline edits,
// keys, inspector, export), saves screenshots and writes results.json, then quits.
// Started by scripts/ui-check.mjs, which sets STUDIO_UI_CHECK and the clip list.

import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { stemsTest } from './stems'
import { vmakeTest } from './vmake-jobs'
import { MIN_WINDOW } from '../shared/window'

const HELPERS = `
window.__t = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async until(fn, ms = 30000, what = '') {
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      const v = await fn()
      if (v) return v
      await __t.sleep(50)
    }
    throw new Error('timed out waiting for ' + what)
  },
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  rect: (el) => el.getBoundingClientRect(),
  pointer(el, type, x, y, mods = {}) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mods }))
  },
  click(el, mods = {}) {
    const r = el.getBoundingClientRect()
    __t.pointer(el, 'pointerdown', r.left + Math.min(20, r.width / 2), r.top + r.height / 2, mods)
    __t.pointer(el, 'pointerup', r.left + Math.min(20, r.width / 2), r.top + r.height / 2, mods)
  },
  clipEl: (id) => document.querySelector('[data-clip="' + id + '"]'),
  // Moves and the release go where pointer capture would send them: the timeline surface
  // (a dragged clip's element is replaced by its ghost), or the element itself elsewhere.
  async drag(el, x0, y0, x1, y1, steps = 10) {
    const cap = el.closest('.tl-content') ?? el
    __t.pointer(el, 'pointerdown', x0, y0)
    for (let i = 1; i <= steps; i++) {
      await __t.sleep(16)
      __t.pointer(cap, 'pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
    }
    await __t.sleep(16)
    __t.pointer(cap, 'pointerup', x1, y1)
  },
  key(key, o = {}) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }))
  },
  snap: () => window.studio.engine.call('project.current'),
  main: (s) => s.project.tracks.find((t) => t.main).clips,
  async rev(after, what = 'a new revision') {
    return __t.until(async () => { const s = await __t.snap(); return s.revision > after && s }, 10000, what)
  },
}
`

/**
 * Checks the window chrome in a real (not off-screen) window parked outside the visible
 * desktop: no system title bar or system buttons, the app's own three window buttons
 * flush in the top-right corner, and a draggable top bar.
 */
export async function runChromeCheck(win: BrowserWindow, outFile: string) {
  await new Promise((r) => setTimeout(r, 1500))
  const r = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('.titlebar')
    const cs = getComputedStyle(bar)
    const buttons = [...document.querySelectorAll('.win-btn')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), top: r.top, right: Math.round(r.right), height: r.height, region: getComputedStyle(b).getPropertyValue('-webkit-app-region') } })
    return { systemOverlay: !!navigator.windowControlsOverlay?.visible, windowWidth: innerWidth, barTop: bar.getBoundingClientRect().top, appRegion: cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion, buttons }
  })()`)
  const b = r.buttons
  const ok =
    process.platform === 'darwin' ||
    (!r.systemOverlay && r.barTop === 0 && r.appRegion === 'drag' && b.length === 3 && b.map((x: { label: string }) => x.label).join() === 'Minimise,Maximise,Close' && b[2].right === r.windowWidth && b.every((x: { top: number; region: string }) => x.top === 0 && x.region === 'no-drag'))
  fs.writeFileSync(outFile, JSON.stringify({ ok, frameless: win.isMenuBarVisible() === false, ...r }, null, 2))
  console.log(`[chrome-check] ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(r)}`)
  return ok
}

interface Result {
  step: string
  ok: boolean
  detail?: unknown
}

/**
 * STUDIO_UI_PROBE: opens whatever project is latest, at STUDIO_UI_PROBE_SIZE ("1920x1040"),
 * and for 8 s records what changes in the timeline (DOM mutations by element, scroll-box size
 * and scrollbar changes, snapshot revisions), plus three frames 150 ms apart and how many
 * pixels differ between them. Writes probe.json: a way to see a flicker that only shows on
 * someone's screen.
 */
async function runProbe(win: BrowserWindow, out: string) {
  const [w, h] = (process.env.STUDIO_UI_PROBE_SIZE ?? '1920x1040').split('x').map(Number)
  win.setContentSize(w, h)
  const js = (code: string) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
  await js(`for (let i = 0; i < 300 && !document.querySelector('.tl-scroll .clip'); i++) await new Promise((r) => setTimeout(r, 100))`)
  // STUDIO_UI_PROBE_SCRIPT: a file of steps to run in the page instead (with the UI check's
  // __t helpers); what it returns goes to probe.json.
  const script = process.env.STUDIO_UI_PROBE_SCRIPT
  if (script) {
    await js(HELPERS)
    const r = await js(`try { return { ok: true, value: await (async () => { ${fs.readFileSync(script, 'utf8')} })() } } catch (e) { return { ok: false, error: String(e && e.message || e) } }`)
    fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(r, null, 2))
    console.log(`[probe] ${JSON.stringify(r).slice(0, 4000)}`)
    return true
  }
  // STUDIO_UI_PROBE_ZOOM_OUT: that many Alt+wheel notches out first (the way a zoomed-out timeline looks).
  const zoomOut = Number(process.env.STUDIO_UI_PROBE_ZOOM_OUT ?? 0)
  await js(`const sc = document.querySelector('.tl-scroll'); for (let i = 0; i < ${zoomOut}; i++) { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, altKey: true, bubbles: true, cancelable: true, clientX: sc.getBoundingClientRect().left + 400 })); await new Promise((r) => setTimeout(r, 120)) }`)
  await js(`
    const p = (window.__probe = { muts: {}, sizes: [], bars: [], revs: 0, t0: performance.now() })
    const name = (el) => (el && el.nodeType === 1 ? (el.getAttribute('class') || el.tagName).split(' ')[0] : 'text')
    new MutationObserver((list) => { for (const m of list) { const k = m.type + (m.attributeName ? '.' + m.attributeName : '') + ' ' + name(m.target); p.muts[k] = (p.muts[k] || 0) + 1 } }).observe(document.querySelector('.timeline'), { subtree: true, childList: true, attributes: true, characterData: true })
    const sc = document.querySelector('.tl-scroll')
    new ResizeObserver(() => p.sizes.push([Math.round(performance.now() - p.t0), sc.clientWidth, sc.clientHeight])).observe(sc)
    let last = window.__studio.getState().snap?.revision, bars = ''
    setInterval(() => {
      const r = window.__studio.getState().snap?.revision
      if (r !== last) { p.revs++; last = r }
      const b = (sc.scrollWidth > sc.clientWidth ? 'x' : '-') + (sc.scrollHeight > sc.clientHeight ? 'y' : '-')
      if (b !== bars) { p.bars.push([Math.round(performance.now() - p.t0), b, sc.scrollWidth, sc.clientWidth, sc.scrollHeight, sc.clientHeight]); bars = b }
    }, 16)
  `)
  const frames: Buffer[] = []
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, i ? 150 : 2000))
    win.webContents.invalidate()
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(out, `probe-${i}.png`), img.toPNG())
    frames.push(img.toBitmap())
  }
  await new Promise((r) => setTimeout(r, 5500))
  const diff = (a: Buffer, b: Buffer) => {
    let n = 0
    for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++
    return n
  }
  const r = await js(`const p = window.__probe; return { seconds: +((performance.now() - p.t0) / 1000).toFixed(1), revisions: p.revs, sizes: p.sizes.slice(0, 40), sizeChanges: p.sizes.length, scrollbars: p.bars.slice(0, 40), scrollbarChanges: p.bars.length, mutations: Object.entries(p.muts).sort((a, b) => b[1] - a[1]).slice(0, 25) }`)
  const result = { size: [w, h], pixelsChanged: [diff(frames[0], frames[1]), diff(frames[1], frames[2])], ...r }
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(result, null, 2))
  console.log(`[probe] ${JSON.stringify(result).slice(0, 3000)}`)
  return true
}

export async function runUiCheck(win: BrowserWindow, out: string, clips: string[], exportDir: string) {
  fs.mkdirSync(out, { recursive: true })
  if (process.env.STUDIO_UI_PROBE) return runProbe(win, out)
  win.webContents.setFrameRate(30)
  const results: Result[] = []
  const errors: string[] = []
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message)
  })
  const js = async (code: string) => {
    const r = await win.webContents.executeJavaScript(`(async () => { try { return { ok: true, value: await (async () => { ${code} })() } } catch (e) { return { ok: false, value: String(e && e.message || e) } } })()`)
    if (!r.ok) throw new Error(r.value)
    return r.value
  }
  const shot = async (name: string) => {
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 400))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG())
  }
  // STUDIO_UI_ONLY (a pattern) runs just the matching steps, after the three that set up the project.
  const only = process.env.STUDIO_UI_ONLY ? new RegExp(process.env.STUDIO_UI_ONLY, 'i') : null
  const setup = /^(project opens|import shows tiles|double-click and \+ add clips)/
  const step = async (name: string, code: string) => {
    if (only && !only.test(name) && !setup.test(name)) return
    try {
      const detail = await js(code)
      results.push({ step: name, ok: true, detail })
      console.log(`[ui-check] ok   ${name}${detail != null ? ` ${JSON.stringify(detail)}` : ''}`)
    } catch (e) {
      results.push({ step: name, ok: false, detail: (e as Error).message })
      console.log(`[ui-check] FAIL ${name}: ${(e as Error).message}`)
    }
  }

  await js(HELPERS)
  await step('project opens', `return await __t.until(() => __t.q('.project-name')?.textContent, 15000, 'a project')`)
  await step(
    'import shows tiles with posters',
    `const r = await window.studio.engine.call('media.import', { paths: ${JSON.stringify(clips)} })
     await __t.until(() => __t.qa('.tile').length === ${clips.length} && !__t.q('.tile-busy'), 120000, 'media to finish')
     await __t.until(() => __t.qa('.tile-thumb img').every((i) => i.complete && i.naturalWidth > 0) && __t.qa('.tile-thumb img').length >= ${clips.length - 1}, 10000, 'posters')
     return { imported: r.imported.length, posters: __t.qa('.tile-thumb img').length }`,
  )
  await shot('1-library')

  await step(
    'double-click and + add clips to the timeline',
    `const tiles = __t.qa('.tile')
     tiles[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
     await __t.until(() => __t.qa('.clip[data-clip]').length === 1, 5000, 'first clip')
     for (const t of tiles.slice(1)) { t.querySelector('.tile-add').click(); await __t.sleep(150) }
     await __t.until(() => __t.qa('.clip[data-clip]').length === tiles.length, 8000, 'all clips')
     const s = await __t.snap()
     return { main: __t.main(s).length, tracks: s.project.tracks.length, seconds: +(s.durationUs / 1e6).toFixed(2) }`,
  )
  await step(
    'filmstrips and waveforms draw',
    `await __t.until(() => __t.qa('.clip.main .filmstrip span').length > 0, 10000, 'filmstrip tiles')
     await __t.until(() => __t.qa('.clip .waveform').length > 0, 10000, 'waveforms')
     return { filmstripRuns: __t.qa('.clip.main .filmstrip span').length, waveforms: __t.qa('.clip .waveform').length }`,
  )
  await step('zoom to fit (Shift+Z)', `__t.key('Z', { shiftKey: true }); await __t.sleep(200); return Math.round(__t.rect(__t.q('.tl-content')).width)`)
  await shot('2-timeline')

  await step(
    'ruler click seeks and shows a frame',
    `const ruler = __t.q('.tl-ruler'); const r = __t.rect(ruler)
     __t.pointer(ruler, 'pointerdown', r.left + 160, r.top + 10); __t.pointer(ruler, 'pointerup', r.left + 160, r.top + 10)
     const st = await __t.until(async () => { const p = await window.studio.engine.call('playback.status'); return p.positionUs > 0 && p }, 5000, 'the playhead')
     return { positionS: +(st.positionUs / 1e6).toFixed(2), timecode: __t.q('.tc').firstChild.textContent }`,
  )
  await step(
    'dragging the playhead snaps it onto a cut (snapping on), and Alt drags it past freely',
    `const s = await __t.snap(); const cut = __t.main(s)[1]
     const ruler = __t.q('.tl-ruler'); const r = __t.rect(ruler)
     const x = __t.rect(__t.clipEl(cut.id)).left + 4
     const at = async () => (await window.studio.engine.call('playback.status')).positionUs
     const was = await at()
     __t.pointer(ruler, 'pointerdown', r.left + 20, r.top + 10)
     __t.pointer(ruler, 'pointermove', x, r.top + 10)
     await __t.until(() => __t.q('.tl-snapline'), 2000, 'the snap line')
     const snapped = await __t.until(async () => { const p = await at(); return p === cut.startUs && p }, 3000, 'the playhead on the cut')
     __t.pointer(ruler, 'pointermove', x, r.top + 10, { altKey: true })
     const free = await __t.until(async () => { const p = await at(); return p !== cut.startUs && p }, 3000, 'the playhead past the cut with Alt')
     __t.pointer(ruler, 'pointerup', x, r.top + 10, { altKey: true })
     // Back where it was, for the steps after.
     await window.studio.engine.call('playback.seek', { positionUs: was })
     await __t.until(async () => (await at()) === was, 3000, 'the playhead back')
     return { cutS: +(cut.startUs / 1e6).toFixed(3), snappedS: +(snapped / 1e6).toFixed(3), withAltS: +(free / 1e6).toFixed(3) }`,
  )
  await step(
    'trim the first clip from its right edge',
    `const before = await __t.snap(); const c = __t.main(before)[0]
     const edge = __t.q('[data-clip="' + c.id + '"] .clip-edge.right'); const r = __t.rect(edge)
     await __t.drag(edge, r.left + 4, r.top + 10, r.left - 40, r.top + 10)
     const s = await __t.rev(before.revision); const after = __t.main(s).find((x) => x.id === c.id)
     if (!(after.durationUs < c.durationUs)) throw new Error('duration did not shrink')
     return { beforeS: +(c.durationUs / 1e6).toFixed(2), afterS: +(after.durationUs / 1e6).toFixed(2), rippledNext: __t.main(s)[1].startUs === after.durationUs }`,
  )
  await step(
    'drag the last main clip to the front',
    `const before = await __t.snap(); const clips = __t.main(before); const last = clips[clips.length - 1]
     const el = __t.q('[data-clip="' + last.id + '"]'); const r = __t.rect(el); const first = __t.rect(__t.q('[data-clip="' + clips[0].id + '"]'))
     await __t.drag(el, r.left + r.width / 2, r.top + 20, first.left + 4, first.top + 20)
     const s = await __t.rev(before.revision)
     if (__t.main(s)[0].id !== last.id) throw new Error('order did not change')
     return __t.main(s).map((c) => c.id)`,
  )
  await step(
    'move the audio clip later',
    `const before = await __t.snap(); const t = before.project.tracks.find((x) => !x.main)
     if (!t) return 'no audio track'
     const c = t.clips[0]; const el = __t.q('[data-clip="' + c.id + '"]'); const r = __t.rect(el)
     await __t.drag(el, r.left + 10, r.top + 10, r.left + 90, r.top + 10)
     const s = await __t.rev(before.revision); const moved = s.project.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id)
     if (!(moved.startUs > c.startUs)) throw new Error('start did not move')
     return { fromS: +(c.startUs / 1e6).toFixed(2), toS: +(moved.startUs / 1e6).toFixed(2) }`,
  )
  await step(
    'split at the playhead (Ctrl+B)',
    `__t.key('Escape')
     const before = await __t.snap(); const n = __t.main(before).length
     __t.key('b', { ctrlKey: true })
     const s = await __t.rev(before.revision)
     if (__t.main(s).length !== n + 1) throw new Error('expected ' + (n + 1) + ' main clips, got ' + __t.main(s).length)
     return __t.main(s).length`,
  )
  await step(
    'select, delete, undo, redo',
    `const before = await __t.snap(); const c = __t.main(before)[1]
     const el = __t.q('[data-clip="' + c.id + '"]'); const r = __t.rect(el)
     __t.pointer(el, 'pointerdown', r.left + r.width / 2, r.top + 20); __t.pointer(el, 'pointerup', r.left + r.width / 2, r.top + 20)
     await __t.until(() => __t.q('.clip.selected'), 2000, 'selection')
     __t.key('Delete')
     let s = await __t.rev(before.revision)
     if (__t.main(s).some((x) => x.id === c.id)) throw new Error('clip still there')
     __t.key('z', { ctrlKey: true })
     s = await __t.rev(s.revision)
     if (!__t.main(s).some((x) => x.id === c.id)) throw new Error('undo did not bring it back')
     __t.key('z', { ctrlKey: true, shiftKey: true })
     s = await __t.rev(s.revision)
     __t.key('z', { ctrlKey: true })
     s = await __t.rev(s.revision)
     return { clips: __t.main(s).length, canRedo: s.canRedo }`,
  )
  await step(
    'inspector volume slider and fit',
    `const before = await __t.snap()
     const media = (id) => before.project.media.find((m) => m.id === id)
     const c = __t.main(before).find((x) => media(x.mediaId).hasAudio)
     if (!c) throw new Error('no main clip with sound')
     const el = __t.q('[data-clip="' + c.id + '"]'); const r = __t.rect(el)
     __t.pointer(el, 'pointerdown', r.left + 10, r.top + 20); __t.pointer(el, 'pointerup', r.left + 10, r.top + 20)
     // Volume is on the inspector's Audio tab (Video, with Scale first, is the default).
     const tab = (name) => [...__t.qa('.insp-tabs button')].find((b) => b.textContent.trim() === name)
     ;(await __t.until(() => tab('Audio'), 3000, 'the Audio tab')).click()
     await __t.sleep(100)
     const track = await __t.until(() => __t.q('.slider-track'), 3000, 'the volume slider'); const tr = __t.rect(track)
     await __t.drag(track, tr.left + tr.width / 2, tr.top + 10, tr.left + tr.width * 0.25, tr.top + 10, 4)
     let s = await __t.rev(before.revision)
     const vol = __t.main(s).find((x) => x.id === c.id).volume
     if (!(vol < 1)) throw new Error('volume did not go down: ' + vol)
     tab('Video').click()
     await __t.sleep(100)
     ;(await __t.until(() => [...__t.qa('.seg button')].find((b) => b.textContent.startsWith('Fit')), 2000, 'the Fit button')).click()
     s = await __t.rev(s.revision)
     return { volume: +vol.toFixed(2), fit: __t.main(s).find((x) => x.id === c.id).fit }`,
  )
  await shot('3-inspector')

  await step(
    'export dialog renders and exports 9:16',
    `localStorage.setItem('studio.export.v2', JSON.stringify({ formats: ['9:16'], quality: 'fast', folder: ${JSON.stringify(exportDir)}, after: 'Do nothing' }))
     __t.key('Escape'); await __t.sleep(100)
     __t.key('e', { ctrlKey: true })
     const btn = await __t.until(() => __t.q('.export-dialog .exp-primary'), 3000, 'the export dialog')
     if (!/Export 1 file/.test(btn.textContent)) throw new Error('button says ' + btn.textContent)
     btn.click()
     // The window stays up: Exporting… with each file's progress and time left, then Done until it's closed.
     await __t.until(() => __t.q('.export-dialog .exp-progress'), 3000, 'the window to show the export')
     const seen = new Set()
     const t0 = Date.now()
     while (!__t.q('.job.state-done') && !__t.q('.job.state-failed') && Date.now() - t0 < 120000) {
       const st = __t.q('.exp-jobs .job-status')?.textContent ?? ''
       if (/%/.test(st)) seen.add('percent')
       if (/left/.test(st + (__t.q('.exp-left')?.textContent ?? ''))) seen.add('time left')
       if (__t.q('#exp-h')?.textContent === 'Exporting…') seen.add('Exporting…')
       await __t.sleep(100)
     }
     if (__t.q('.job.state-failed')) throw new Error(__t.q('.job .error')?.textContent || 'export failed')
     await __t.until(() => __t.q('#exp-h')?.textContent === 'Done', 3000, 'the window to say Done')
     if (!seen.has('Exporting…') || !seen.has('percent')) throw new Error('while exporting it showed ' + [...seen].join(', '))
     await __t.sleep(1500)
     if (!__t.q('.export-dialog')) throw new Error('the window closed by itself')
     return { status: __t.q('.job.state-done .job-status').textContent, seen: [...seen] }`,
  )
  await shot('4-export')
  await step(
    'export window: Close shuts it, and Export opens on the settings again',
    `;[...__t.qa('.exp-foot button')].find((b) => b.textContent === 'Close').click()
     await __t.until(() => !__t.q('.export-dialog'), 2000, 'the window to close')
     __t.key('e', { ctrlKey: true })
     await __t.until(() => __t.q('.export-dialog .exp-primary'), 3000, 'the settings')
     if (__t.q('.exp-progress')) throw new Error('it opened on the finished export')
     __t.key('Escape')
     await __t.until(() => !__t.q('.export-dialog'), 2000, 'the window to close')
     return 'settings'`,
  )
  // The sound alone: MP3 and WAV are files of their own, with or without the video formats.
  await step(
    'Export › Sound only: MP3 and WAV ticked alone fade Quality and list .mp3 and .wav',
    `localStorage.setItem('studio.export.v2', JSON.stringify({ formats: ['mp3', 'wav'], quality: 'fast', folder: ${JSON.stringify(exportDir)}, after: 'Do nothing' }))
     __t.key('Escape'); await __t.sleep(100)
     __t.key('e', { ctrlKey: true })
     const btn = await __t.until(() => __t.q('.export-dialog .exp-primary'), 3000, 'the export dialog')
     const ticked = __t.qa('.exp-sound[aria-checked="true"]').map((b) => b.querySelector('.exp-format-name').textContent.split(' ')[0])
     if (ticked.join() !== 'MP3,WAV') throw new Error('ticked: ' + ticked.join())
     if (__t.qa('.exp-format:not(.exp-sound)[aria-checked="true"]').length) throw new Error('a video format is ticked')
     if (!__t.q('.exp-group.exp-dim')) throw new Error('Quality is not faded with only sound ticked')
     const files = __t.qa('.exp-file-name').map((f) => f.textContent)
     if (files.length !== 2 || !/-audio-v\\d+\\.mp3$/.test(files[0]) || !/-audio-v\\d+\\.wav$/.test(files[1])) throw new Error('files: ' + files.join(', '))
     if (__t.q('.exp-frame-label')?.textContent !== 'Sound only') throw new Error('label: ' + __t.q('.exp-frame-label')?.textContent)
     if (!/Export 2 files/.test(btn.textContent)) throw new Error('button says ' + btn.textContent)
     return { files, summary: __t.q('.exp-summary').textContent }`,
  )
  await shot('4b-export-sound')
  await step(
    'Export › Sound only: the MP3 and WAV are made, and ticking a video format brings Quality back',
    `__t.q('.export-dialog .exp-primary').click()
     await __t.until(() => __t.q('#exp-h')?.textContent === 'Done' || __t.q('.job.state-failed'), 120000, 'the sound files')
     if (__t.q('.job.state-failed')) throw new Error(__t.q('.job .error')?.textContent || 'export failed')
     const made = __t.qa('.exp-jobs .job').map((j) => j.querySelector('.job-name').textContent + ' · ' + j.querySelector('.job-format').textContent)
     if (made.length !== 2 || !/\\.mp3 · MP3 · 320 kbps$/.test(made[0]) || !/\\.wav · WAV · 24-bit, 48 kHz$/.test(made[1])) throw new Error('made: ' + made.join(' | '))
     for (const j of __t.qa('.exp-jobs .job-name')) if (!(await window.studio.files.exists(j.title))) throw new Error('no ' + j.title)
     ;[...__t.qa('.exp-foot button')].find((b) => b.textContent === 'Close').click()
     await __t.until(() => !__t.q('.export-dialog'), 2000, 'the window to close')
     __t.key('e', { ctrlKey: true })
     await __t.until(() => __t.q('.export-dialog .exp-primary'), 3000, 'the settings')
     __t.qa('.exp-format:not(.exp-sound)')[0].click()
     await __t.until(() => !__t.q('.exp-group.exp-dim'), 1000, 'Quality to come back')
     const button = __t.q('.export-dialog .exp-primary').textContent
     if (button !== 'Export 3 files') throw new Error('button says ' + button)
     __t.key('Escape')
     await __t.until(() => !__t.q('.export-dialog'), 2000, 'the window to close')
     localStorage.setItem('studio.export.v2', JSON.stringify({ formats: ['9:16'], quality: 'fast', folder: ${JSON.stringify(exportDir)}, after: 'Do nothing' }))
     return { made, button }`,
  )

  await step(
    'play advances the playhead (muted), then pauses',
    `__t.key('Escape'); await __t.sleep(100)
     const s = await __t.snap()
     for (const t of s.project.tracks) for (const c of t.clips) await window.studio.engine.call('clip.set', { clipId: c.id, volume: 0 })
     await window.studio.engine.call('playback.seek', { positionUs: 0 })
     const tc0 = await __t.until(() => __t.q('.tc').firstChild.textContent === '00:00.00' && '00:00.00', 3000, 'the playhead at the start')
     __t.key(' ')
     await __t.until(() => __t.q('.transport .play[aria-label="Pause"]'), 5000, 'playing')
     await __t.sleep(1500)
     const tc1 = __t.q('.tc').firstChild.textContent
     __t.key(' ')
     await __t.until(() => __t.q('.transport .play[aria-label="Play"]'), 5000, 'paused')
     if (tc0 === tc1) throw new Error('timecode did not move')
     return { from: tc0, to: tc1 }`,
  )
  await shot('5-after-play')

  await step(
    'tracks sit mid-panel and the playhead runs full height',
    `const content = __t.rect(__t.q('.tl-content')), ph = __t.rect(__t.q('.tl-playhead'))
     const mt = parseFloat(getComputedStyle(__t.q('.tl-rows')).marginTop)
     if (!(mt > 0)) throw new Error('tracks at the top (margin ' + mt + ')')
     if (Math.abs(ph.height - content.height) > 2) throw new Error('playhead ' + ph.height + ' of ' + content.height)
     return { trackOffset: mt, playhead: Math.round(ph.height) }`,
  )
  await step(
    'dragging on empty space box-selects clips; a click clears and moves the playhead',
    `__t.key('Escape')
     const el = __t.q('.tl-content'), c = __t.rect(el), rows = __t.rect(__t.q('.tl-rows'))
     const all = __t.qa('.clip[data-clip]').length
     await __t.drag(el, c.left + 116, rows.top - 6, c.right - 4, rows.bottom + 4)
     const boxed = __t.qa('.clip.selected').length
     if (boxed !== all) throw new Error(boxed + ' of ' + all + ' boxed')
     const before = (await window.studio.engine.call('playback.status')).positionUs
     __t.pointer(el, 'pointerdown', c.left + 300, rows.top - 6); __t.pointer(el, 'pointerup', c.left + 300, rows.top - 6)
     await __t.until(() => __t.qa('.clip.selected').length === 0, 2000, 'the selection to clear')
     const after = await __t.until(async () => { const p = (await window.studio.engine.call('playback.status')).positionUs; return p !== before && p }, 3000, 'the playhead to move')
     return { boxed, playheadS: +(after / 1e6).toFixed(2) }`,
  )
  await step(
    'a box keeps its start while the timeline scrolls under it',
    `__t.key('Escape')
     const sc = __t.q('.tl-scroll'), el = __t.q('.tl-content'), s0 = __t.rect(sc)
     const ids = () => __t.qa('.clip.selected').map((c) => c.dataset.clip)
     const all = __t.qa('.clip[data-clip]').length
     // Zoomed in, so the clips run on past the right edge.
     for (let i = 0; i < 8 && sc.scrollWidth < sc.clientWidth * 2; i++) {
       sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: s0.left + 200, clientY: s0.top + 40, bubbles: true, cancelable: true }))
       await __t.sleep(80)
     }
     if (sc.scrollWidth < sc.clientWidth * 1.5) throw new Error('could not zoom in')
     sc.scrollLeft = 0
     await __t.sleep(80)
     const rows = __t.rect(__t.q('.tl-rows'))
     const first = __t.qa('.clip[data-clip]').sort((a, b) => __t.rect(a).left - __t.rect(b).left)[0].dataset.clip
     const [x0, y0, x1, y1] = [s0.left + 125, rows.top - 6, s0.left + sc.clientWidth - 70, rows.bottom + 4]
     __t.pointer(el, 'pointerdown', x0, y0)
     for (let i = 1; i <= 6; i++) { await __t.sleep(16); __t.pointer(el, 'pointermove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6) }
     const before = ids()
     if (!before.includes(first) || before.length >= all) throw new Error('boxed before scrolling: ' + before.length + ' of ' + all)
     // Scrolled with the pointer held still: the box runs on to the end and keeps the first clip.
     sc.scrollLeft = sc.scrollWidth
     await __t.until(() => ids().length === all, 3000, 'every clip boxed after scrolling')
     __t.pointer(el, 'pointerup', x1, y1)
     const after = ids()
     __t.key('Z', { shiftKey: true, code: 'KeyZ' })
     if (!after.includes(first)) throw new Error('the first clip was let go')
     return { before: before.length, after: after.length }`,
  )
  await step(
    'double-click on empty space grabs the playhead; dragging moves it',
    `__t.key('Escape')
     const el = __t.q('.tl-content'), c = __t.rect(el), rows = __t.rect(__t.q('.tl-rows'))
     const y = rows.top - 6, x1 = c.left + 160, x2 = c.left + 420
     __t.pointer(el, 'pointerdown', x1, y); __t.pointer(el, 'pointerup', x1, y)
     await __t.sleep(60)
     // Alt: the line goes exactly where the pointer is (no snapping onto a clip's edge).
     __t.pointer(el, 'pointerdown', x1, y, { altKey: true })
     for (let i = 1; i <= 8; i++) { await __t.sleep(16); __t.pointer(el, 'pointermove', x1 + ((x2 - x1) * i) / 8, y, { altKey: true }) }
     __t.pointer(el, 'pointerup', x2, y, { altKey: true })
     if (__t.q('.tl-box')) throw new Error('a selection box appeared')
     const ph = await __t.until(() => { const r = __t.rect(__t.q('.tl-playhead')); return Math.abs(r.left - x2) < 3 && r.left }, 3000, 'the playhead at the pointer')
     return { playheadX: Math.round(ph - c.left), selected: __t.qa('.clip.selected').length }`,
  )
  await step(
    'a sound clip shows its fades, and dragging its top corner handle sets the fade in',
    `const s = await __t.snap()
     const t = s.project.tracks.find((x) => x.kind === 'audio' && x.clips.length)
     if (!t) throw new Error('no sound clip')
     const c = t.clips[0]
     const el = __t.clipEl(c.id)
     __t.click(el)
     const handle = await __t.until(() => el.querySelector('.fade-handle.in'), 3000, 'the fade-in handle')
     const r = __t.rect(handle), cr = __t.rect(el)
     const pps = cr.width / (c.durationUs / 1e6)
     await __t.drag(handle, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 40, r.top + r.height / 2)
     const after = await __t.until(async () => { const x = (await __t.snap()).project.tracks.find((y) => y.id === t.id).clips.find((y) => y.id === c.id); return x.fadeInUs > 0 && x }, 5000, 'the fade in set')
     const want = ((r.left + r.width / 2 + 40 - cr.left) / pps) * 1e6
     if (Math.abs(after.fadeInUs - want) > 120000) throw new Error('the fade is ' + after.fadeInUs + ', the handle let go at ' + Math.round(want))
     await __t.until(() => __t.clipEl(c.id)?.querySelector('.clip-fades polygon'), 3000, 'the fade drawn on the clip')
     await window.studio.engine.call('clip.set', { clipId: c.id, fadeOutUs: 800000 })
     await __t.until(() => __t.clipEl(c.id)?.querySelectorAll('.clip-fades polygon').length === 2, 3000, 'the fade out drawn too')
     window.__fadeClip = { track: t.id, clip: c.id }
     return { fadeInS: +(after.fadeInUs / 1e6).toFixed(2) }`,
  )
  await shot('3c-fades')
  await step(
    'undo takes the fades off again',
    `const { track, clip } = window.__fadeClip
     const now = async () => (await __t.snap()).project.tracks.find((y) => y.id === track).clips.find((y) => y.id === clip)
     __t.key('z', { ctrlKey: true }); await __t.sleep(150); __t.key('z', { ctrlKey: true })
     await __t.until(async () => { const x = await now(); return !(x.fadeInUs > 0) && !(x.fadeOutUs > 0) }, 3000, 'both fades off')
     await __t.until(() => !__t.clipEl(clip)?.querySelector('.clip-fades polygon'), 3000, 'the fades gone from the clip')
     return 'off'`,
  )
  await step(
    'shift+click selects everything between two clips',
    `const main = __t.main(await __t.snap())
     __t.click(__t.clipEl(main[0].id))
     __t.click(__t.clipEl(main[main.length - 1].id), { shiftKey: true })
     const n = await __t.until(() => { const k = __t.qa('.clip.main.selected').length; return k === main.length && k }, 2000, 'the whole run')
     __t.key('Escape')
     return n`,
  )
  await step(
    "Ctrl+Shift+S extracts a clip's audio to its own linked track",
    `const before = await __t.snap()
     const media = (id) => before.project.media.find((m) => m.id === id)
     const v = __t.main(before).find((c) => media(c.mediaId).hasAudio && media(c.mediaId).kind === 'video')
     __t.click(__t.clipEl(v.id))
     __t.key('S', { ctrlKey: true, shiftKey: true })
     const s = await __t.rev(before.revision)
     const video = __t.main(s).find((c) => c.id === v.id)
     const audio = s.project.tracks.filter((t) => !t.main).flatMap((t) => t.clips).find((c) => c.link && c.link === video.link)
     if (!video.detached || !audio || audio.startUs !== video.startUs) throw new Error(JSON.stringify({ video, audio }))
     await __t.until(() => !__t.clipEl(v.id).querySelector('.waveform'), 3000, 'the video waveform to go')
     return { audioTrackClip: audio.id, link: audio.link }`,
  )
  await step(
    'P turns the main track magnet off (gaps stay) and back on',
    `__t.key('Escape')
     let s = await __t.snap()
     __t.key('p')
     s = await __t.rev(s.revision, 'P to turn the magnet off')
     if (s.project.magnet !== false) throw new Error('magnet still on')
     // The engine has it; wait for the timeline to draw it too before dragging.
     await __t.until(() => __t.q('.tool[aria-label="Main track magnet"][aria-pressed="false"]'), 3000, 'the toolbar to show the magnet off')
     const c = __t.main(s)[__t.main(s).length - 1]; const el = __t.clipEl(c.id); const r = __t.rect(el)
     await __t.drag(el, r.left + 20, r.top + 20, r.left + 100, r.top + 20)
     s = await __t.rev(s.revision, 'the drag of the last clip (toast: ' + (__t.q('.toast')?.textContent ?? 'none') + ')')
     const m = __t.main(s); const i = m.findIndex((x) => x.id === c.id)
     const gap = m[i].startUs - (m[i - 1].startUs + m[i - 1].durationUs)
     if (!(gap > 0)) throw new Error('no gap: ' + gap)
     __t.key('p')
     s = await __t.rev(s.revision, 'P to turn the magnet back on')
     const packed = __t.main(s).every((x, k, a) => k === 0 ? x.startUs === 0 : x.startUs === a[k - 1].startUs + a[k - 1].durationUs)
     if (!packed) throw new Error('the magnet did not close the gap')
     return { gapS: +(gap / 1e6).toFixed(2) }`,
  )
  await step(
    'Q and W delete left and right of the playhead',
    `__t.key('Escape')
     let s = await __t.snap(); let c = __t.main(s)[0]
     await window.studio.engine.call('playback.seek', { positionUs: c.startUs + Math.round(c.durationUs / 2) })
     await __t.sleep(150)
     __t.key('q')
     s = await __t.rev(s.revision); const afterQ = __t.main(s)[0]
     if (!(afterQ.durationUs < c.durationUs && afterQ.inUs > c.inUs)) throw new Error('Q did not cut the start')
     await window.studio.engine.call('playback.seek', { positionUs: afterQ.startUs + Math.round(afterQ.durationUs / 2) })
     await __t.sleep(150)
     __t.key('w')
     s = await __t.rev(s.revision); const afterW = __t.main(s)[0]
     if (!(afterW.durationUs < afterQ.durationUs && afterW.inUs === afterQ.inUs)) throw new Error('W did not cut the end')
     return { s: [c, afterQ, afterW].map((x) => +(x.durationUs / 1e6).toFixed(2)) }`,
  )
  await step(
    'mirror and rotate from the toolbar',
    `let s = await __t.snap(); const c = __t.main(s)[0]
     __t.click(__t.clipEl(c.id))
     await __t.until(() => !__t.q('.tool[title="Mirror"]').disabled, 2000, 'the tools to enable')
     __t.q('.tool[title="Mirror"]').click()
     s = await __t.rev(s.revision)
     __t.q('.tool[title="Rotate"]').click()
     s = await __t.rev(s.revision)
     const x = __t.main(s).find((k) => k.id === c.id)
     if (!x.flip || x.rotate !== 90) throw new Error(JSON.stringify(x))
     return { flip: x.flip, rotate: x.rotate }`,
  )
  await step(
    'crop: drag a corner, apply',
    `let s = await __t.snap(); const c = __t.main(s)[0]
     __t.q('.tool[title="Crop"]').click()
     const h = await __t.until(() => __t.q('.crop-handle.h-se'), 3000, 'the crop box')
     const r = __t.rect(h)
     await __t.drag(h, r.left + 6, r.top + 6, r.left - 60, r.top - 90, 6)
     await __t.sleep(100)
     window.__cropShot = true
     return true`,
  )
  await shot('7-crop')
  await step(
    'crop applies to the clip',
    `let s = await __t.snap(); const c = __t.main(s)[0]
     __t.qa('.modal footer .button.primary')[0].click()
     s = await __t.rev(s.revision)
     const crop = __t.main(s).find((k) => k.id === c.id).crop
     if (!crop || !(crop.w < 1 && crop.h < 1)) throw new Error(JSON.stringify(crop))
     await window.studio.engine.call('playback.seek', { positionUs: c.startUs + Math.round(c.durationUs / 2) })
     await __t.sleep(800)
     return crop`,
  )
  await shot('8-tools')

  await step(
    'Ctrl+C / Ctrl+V copies a clip to the playhead; Ctrl+X cuts',
    `__t.key('Escape')
     let s = await __t.snap(); const n = __t.main(s).length; const c = __t.main(s)[0]
     __t.click(__t.clipEl(c.id))
     __t.key('c', { ctrlKey: true })
     await window.studio.engine.call('playback.seek', { positionUs: s.durationUs })
     await __t.sleep(150)
     __t.key('v', { ctrlKey: true })
     s = await __t.rev(s.revision)
     if (__t.main(s).length !== n + 1) throw new Error('paste: ' + __t.main(s).length)
     const pasted = __t.main(s)[__t.main(s).length - 1]
     __t.click(__t.clipEl(pasted.id))
     __t.key('x', { ctrlKey: true })
     s = await __t.rev(s.revision)
     if (__t.main(s).length !== n) throw new Error('cut: ' + __t.main(s).length)
     return { copiedFrom: c.id, pasted: pasted.id }`,
  )
  await step(
    'right-click › Create compound clip joins two clips; Alt+Shift+G breaks it',
    `let s = await __t.snap(); const m = __t.main(s)
     __t.click(__t.clipEl(m[1].id)); __t.click(__t.clipEl(m[2].id), { ctrlKey: true })
     const el = __t.clipEl(m[2].id); const r = __t.rect(el)
     el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
     const menu = await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
     window.__menuItems = [...menu.querySelectorAll('button')].map((b) => b.textContent)
     return window.__menuItems`,
  )
  await shot('10-clip-menu')
  await step(
    'the compound clip renders and breaks apart',
    `let s = await __t.snap(); const m = __t.main(s)
     ;[...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Create compound clip')).click()
     s = await __t.rev(s.revision)
     const cc = __t.main(s).find((c) => s.project.media.find((x) => x.id === c.mediaId)?.parts)
     if (!cc || __t.main(s).length !== m.length - 1) throw new Error('no compound clip')
     __t.key('g', { altKey: true, shiftKey: true })
     // Background work (the compound's thumbnails) moves the revision too; wait for the parts.
     await __t.until(async () => __t.main(await __t.snap()).length === m.length, 5000, 'the parts (' + __t.main(await __t.snap()).length + ' clips)')
     return { compoundSeconds: +(cc.durationUs / 1e6).toFixed(2) }`,
  )
  await step(
    'copy and paste attributes',
    `__t.key('Escape')
     let s = await __t.snap(); const m = __t.main(s)
     const from = m.find((c) => c.flip) ?? m[0]
     const to = m.find((c) => c.id !== from.id && !c.flip)
     __t.click(__t.clipEl(from.id)); __t.key('c', { ctrlKey: true, altKey: true })
     __t.click(__t.clipEl(to.id)); __t.key('v', { ctrlKey: true, altKey: true })
     const same = (c) => !!c.flip === !!from.flip && (c.rotate ?? 0) === (from.rotate ?? 0) && c.volume === from.volume && c.fit === from.fit
     let after
     try {
       after = await __t.until(async () => { const x = __t.main(await __t.snap()).find((c) => c.id === to.id); return same(x) && x }, 4000, 'the pasted attributes')
     } catch (e) {
       throw new Error(e.message + ' from ' + JSON.stringify(from) + ' to ' + JSON.stringify(__t.main(await __t.snap()).find((c) => c.id === to.id)))
     }
     return { flip: after.flip, rotate: after.rotate ?? 0 }`,
  )
  await step(
    'right-click › Export this clip opens the export dialog for the selection',
    `const s = await __t.snap(); const c = __t.main(s)[0]
     __t.click(__t.clipEl(c.id))
     const el = __t.clipEl(c.id); const r = __t.rect(el)
     el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
     await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
     ;[...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Export this clip')).click()
     const title = await __t.until(() => __t.q('.export-dialog h1')?.textContent, 2000, 'the dialog')
     __t.key('Escape')
     if (title !== 'Export one clip') throw new Error(title)
     return title`,
  )
  await step(
    'right-click › Remove text with Vmake asks for a token first',
    `__t.key('Escape')
     const s = await __t.snap(); const c = __t.main(s).find((x) => s.project.media.find((m) => m.id === x.mediaId)?.kind === 'video')
     __t.click(__t.clipEl(c.id))
     const el = __t.clipEl(c.id); const r = __t.rect(el)
     el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
     await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
     ;[...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Remove text with Vmake')).click()
     await __t.until(() => __t.q('.modal input[type=password]'), 3000, 'the token field')
     const title = __t.q('.modal h2').textContent
     const startDisabled = __t.q('.modal footer .button.primary').disabled
     window.__vmakeShot = true
     return { title, startDisabled }`,
  )
  await shot('12-vmake')
  await step('the Vmake dialog closes', `__t.key('Escape'); await __t.sleep(100); return !__t.q('.modal')`)
  await step(
    'clicking a library clip previews it from where it was clicked',
    `const tile = __t.qa('.bin-grid .tile[data-media]').find((t) => !t.querySelector('.kind-image') && !t.querySelector('.kind-audio'))
     const thumb = __t.rect(tile.querySelector('.tile-thumb'))
     tile.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: thumb.left + thumb.width * 0.75, clientY: thumb.top + thumb.height / 2 }))
     await __t.until(() => __t.q('.player-source'), 2000, 'the preview bar')
     const st = await __t.until(async () => { const p = await window.studio.engine.call('playback.status'); return p.context === 'source' && p }, 3000, 'the engine preview')
     await __t.until(() => __t.q('.tile-mark'), 2000, 'the mark on the tile')
     __t.key(' ')
     const seen = []
     const t0 = performance.now()
     try {
       await __t.until(async () => { const p = await window.studio.engine.call('playback.status'); seen.push(p); return __t.q('.transport .play[aria-label="Pause"]') }, 10000, 'the preview to play')
     } catch (e) {
       throw new Error(e.message + ' ' + JSON.stringify({ engine: seen.slice(-2), toast: __t.q('.toast')?.textContent }))
     }
     const startMs = Math.round(performance.now() - t0)
     await __t.sleep(700)
     __t.key(' ')
     const tc = __t.q('.tc').firstChild.textContent
     return { name: __t.q('.player-source strong').textContent, atS: +(st.positionUs / 1e6).toFixed(2), tc, startMs }`,
  )
  await shot('11-preview')
  await step(
    'clicking the timeline goes back to it',
    `const el = __t.q('.tl-content'), c = __t.rect(el), rows = __t.rect(__t.q('.tl-rows'))
     __t.pointer(el, 'pointerdown', c.left + 200, rows.top - 6); __t.pointer(el, 'pointerup', c.left + 200, rows.top - 6)
     await __t.until(() => !__t.q('.player-source'), 2000, 'the preview bar to go')
     const st = await __t.until(async () => { const p = await window.studio.engine.call('playback.status'); return p.context === 'timeline' && p }, 3000, 'the engine back on the timeline')
     return st.context`,
  )
  await step(
    'library: Delete removes picked items, Ctrl+Z brings them back',
    `let s = await __t.snap(); const n = s.project.media.length
     const tile = __t.qa('.bin-grid .tile[data-media]')[0]
     tile.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
     tile.dispatchEvent(new MouseEvent('click', { bubbles: true }))
     await __t.until(() => tile.classList.contains('selected'), 2000, 'the pick')
     __t.key('Delete')
     // Background thumbnails also change the revision, so wait for the count itself.
     await __t.until(async () => (await __t.snap()).project.media.length === n - 1, 5000, 'the item to go')
     const toast = await __t.until(() => [...__t.qa('.toast')].map((t) => t.textContent).find((t) => t.startsWith('Removed')), 2000, 'the toast')
     __t.key('z', { ctrlKey: true })
     await __t.until(async () => (await __t.snap()).project.media.length === n, 5000, 'the item to come back')
     return toast`,
  )

  const folder = process.env.STUDIO_UI_CHECK_FOLDER
  if (folder) {
    await step(
      'a linked folder shows up as a map',
      `// Import the way a drop does, and watch for the loading strip while it runs.
       let sawLoading = false
       const done = window.__studio.importPaths([${JSON.stringify(folder)}]).then(() => true)
       let finished = false
       done.then(() => (finished = true))
       while (!finished) {
         if (__t.q('.bin-status')?.textContent.includes('Loading')) sawLoading = true
         await __t.sleep(5)
       }
       if (!sawLoading) throw new Error('no loading message while the folder loaded')
       const row = await __t.until(() => __t.qa('.tree-row').find((r) => r.textContent.includes('Ads')), 10000, 'the folder in the tree')
       row.click()
       await __t.until(() => __t.qa('.crumbs button').some((b) => b.textContent === 'Ads'), 3000, 'the breadcrumb')
       const tiles = await __t.until(() => { const t = __t.qa('.folder-tile .tile-name').map((x) => x.textContent); return t.length === 2 && t }, 5000, 'two subfolder tiles')
       return tiles`,
    )
    await step(
      'folder tiles and the tree go deeper',
      `__t.qa('.folder-tile').find((t) => t.textContent.includes('05 Stock')).click()
       await __t.until(() => __t.qa('.folder-tile').some((t) => t.textContent.includes('Jul')), 3000, 'the Jul folder')
       __t.qa('.folder-tile').find((t) => t.textContent.includes('Jul')).click()
       await __t.until(() => __t.qa('.bin-grid .tile-name').some((t) => t.textContent.includes('b.mp4')), 3000, 'b.mp4 in Jul')
       const crumbs = __t.qa('.crumbs button').map((b) => b.textContent)
       const tree = __t.qa('.tree-row .tree-label').map((l) => l.textContent)
       if (!tree.includes('Jul')) throw new Error('the tree did not open down to Jul')
       return { crumbs, tree }`,
    )
    await shot('6-folders')
    await step(
      'search finds clips across subfolders',
      `__t.qa('.crumbs button')[0].click()
       const input = __t.q('.bin-search input')
       const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
       set.call(input, 'b.mp4'); input.dispatchEvent(new Event('input', { bubbles: true }))
       const names = await __t.until(() => { const n = __t.qa('.bin-grid .tile-name').map((t) => t.textContent); return n.length === 1 && n }, 3000, 'one search hit')
       return names`,
    )
  }
  await step(
    'library: dragging on empty space box-selects media',
    `const input = __t.q('.bin-search input')
     const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
     set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }))
     __t.qa('.crumbs button')[0].click()
     await __t.sleep(200)
     const grid = __t.q('.bin-grid'); const g = __t.rect(grid)
     // Only the tiles in view can be boxed.
     const tiles = __t.qa('.bin-grid [data-media]').filter((t) => { const r = __t.rect(t); return r.top < g.bottom - 3 && r.bottom > g.top + 2 }).length
     await __t.drag(grid, g.right - 3, g.bottom - 3, g.left + 2, g.top + 2, 6)
     const picked = __t.qa('.bin-grid .tile.selected').length
     if (picked !== tiles) throw new Error(picked + ' of ' + tiles + ' picked')
     return { picked }`,
  )
  await shot('9-library-select')

  await step(
    'the Audio tab: ElevenLabs key field, voiceover and recorder',
    `;[...__t.qa('.categories button')].find((b) => b.textContent.includes('Audio')).click()
     // The Audio tab opens on Music; the voiceover and the recorder are under Voice.
     ;(await __t.until(() => [...__t.qa('.pills-sub button')].find((b) => b.textContent === 'Voice'), 3000, 'the Voice tab')).click()
     await __t.until(() => __t.q('.audio-card input[type=password]'), 5000, 'the key field')
     return __t.qa('.audio-heading').map((h) => h.textContent)`,
  )
  await shot('13-audio')
  await step(
    'recording (from the fake test microphone) lands on an audio track at the playhead',
    `let s = await __t.snap(); const before = s.project.media.length
     __t.q('.record-button').click()
     // After the 3 s count-in.
     await __t.until(() => __t.q('.record-button.on'), 9000, 'recording to start')
     await __t.sleep(1800)
     const level = __t.q('.meter span').style.width
     __t.q('.record-button.on').click()
     const rec = await __t.until(async () => { const x = await __t.snap(); return x.project.media.find((m) => m.name.startsWith('Recording') ) }, 10000, 'the recording in the library')
     s = await __t.snap()
     const clip = s.project.tracks.filter((t) => !t.main).flatMap((t) => t.clips).find((c) => c.mediaId === rec.id)
     if (!clip) throw new Error('not on an audio track')
     if (!(rec.durationUs > 1_000_000)) throw new Error("the recording is " + rec.durationUs + " µs long")
     return { name: rec.name, seconds: +(rec.durationUs / 1e6).toFixed(1), level, startS: +(clip.startUs / 1e6).toFixed(2) }`,
  )

  // The canvas's top bar, player header and shortcuts list.
  await step(
    'Safe zones and the 4:5 / 9:16 switch in the player header',
    `__t.key('Escape')
     const safe = __t.q('.safe-button'); const was = __t.qa('.safe-zone, .reels').length
     safe.click(); await __t.sleep(100)
     const now = __t.qa('.safe-zone, .reels').length
     if ((was === 0) === (now === 0)) throw new Error('safe zones did not toggle (' + was + ' → ' + now + ')')
     let s = await __t.snap()
     const pick = (n) => [...__t.qa('.aspect-switch button')].find((b) => b.textContent === n)
     pick('4:5').click()
     s = await __t.rev(s.revision, 'the 4:5 format')
     await __t.until(() => pick('4:5').classList.contains('on'), 3000, 'the switch to show 4:5')
     await __t.sleep(100)
     const frame = __t.rect(__t.q('.player-frame'))
     const ratio = +(frame.width / frame.height).toFixed(2)
     pick('9:16').click()
     s = await __t.rev(s.revision, 'back to 9:16')
     return { zones: now, size: s.project.width + 'x' + s.project.height, frameRatio45: ratio }`,
  )
  await step(
    'Safe zones on a 9:16 project draw Instagram Reels as Meta’s ad preview does, and the ad’s words can be typed in',
    `__t.key('Escape')
     const pick = (n) => [...__t.qa('.aspect-switch button')].find((b) => b.textContent === n)
     if (!pick('9:16').classList.contains('on')) throw new Error('the project is not 9:16')
     if (__t.q('.safe-button').getAttribute('aria-pressed') !== 'true') __t.q('.safe-button').click()
     await __t.until(() => __t.q('.reels-phone'), 3000, 'the Reels overlay')
     if (__t.qa('.safe-zone').length) throw new Error('the plain zones show as well')
     // Meta shows the video at full height and leaves 4.4 % off each side.
     const frame = __t.rect(__t.q('.player-frame')), phone = __t.rect(__t.q('.reels-phone'))
     const trim = (phone.left - frame.left) / frame.width, trimR = (frame.right - phone.right) / frame.width
     if (Math.abs(trim - 0.0444) > 0.003 || Math.abs(trimR - 0.0444) > 0.003) throw new Error('the sides are off: ' + trim.toFixed(4) + ' / ' + trimR.toFixed(4))
     if (Math.abs(phone.height - frame.height) > 1) throw new Error('the phone is ' + phone.height + ' px high in a ' + frame.height + ' px frame')
     const words = () => __t.qa('.reels-phone text').map((t) => t.textContent)
     for (const w of ['Reels', 'Shop now', 'Follow', 'Ad']) if (!words().includes(w)) throw new Error('no "' + w + '" on the overlay: ' + words().join(' | '))
     // The card sits from 67.4 % of the height down, as in Meta's preview.
     const card = __t.rect(__t.q('.reels-phone path[fill="#282828"]'))
     const cardTop = (card.top - frame.top) / frame.height
     if (Math.abs(cardTop - 0.674) > 0.004) throw new Error('the card starts at ' + (cardTop * 100).toFixed(1) + ' %')
     // Above the live text, under the selected clip's box (drawn for the timeline, not a library clip's preview).
     __t.q('.player-source button')?.click()
     await __t.until(() => __t.q('.ph-stage'), 3000, 'the timeline back on the player')
     const z = (s) => +getComputedStyle(__t.q(s)).zIndex
     if (!(z('.reels') >= z('.player-live') && z('.reels') < z('.ph-stage'))) throw new Error('the overlay is in the wrong layer')
     __t.q('.safe-more').click()
     await __t.until(() => __t.q('.reels-edit'), 2000, 'the words panel')
     const [account, headline, text] = __t.qa('.reels-field input')
     const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
     const was = account.value
     set.call(account, 'duckandpippin'); account.dispatchEvent(new Event('input', { bubbles: true }))
     set.call(text, 'En lång första rad som inte får plats på en enda rad i flödet utan klipps av'); text.dispatchEvent(new Event('input', { bubbles: true }))
     await __t.until(() => words().includes('duckandpippin'), 2000, 'the new account on the overlay')
     const line = words().find((w) => w.startsWith('En lång'))
     if (!line || !line.endsWith('...') || line.length > 60) throw new Error('the text was not cut to one line: ' + line)
     __t.key('Escape')
     await __t.until(() => !__t.q('.reels-edit'), 2000, 'the panel to close on Escape')
     if (!__t.q('.reels-phone')) throw new Error('Escape closed the overlay too')
     const kept = JSON.parse(localStorage.getItem('studio.reels.v1') || '{}')
     if (kept.last?.account !== 'duckandpippin') throw new Error('the words were not kept')
     return { trim: +trim.toFixed(4), cardTop: +cardTop.toFixed(3), was, line, words: words() }`,
  )
  await shot('6b-reels')
  await step(
    'Files dragged from the desktop drop anywhere on the editor: over the player, the Inspector or the library’s tabs the whole window takes them into the library; the library and the timeline show their own',
    `const dt = new DataTransfer()
     dt.items.add(new File(['x'], 'clip.mp4', { type: 'video/mp4' }))
     const at = (sel, type) => {
       const el = __t.q(sel), r = __t.rect(el)
       el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 40), dataTransfer: dt }))
     }
     const hint = {}
     for (const [name, sel] of [['player', '.player-frame'], ['inspector', '.insp-head'], ['tabs', '.categories'], ['library', '.bin'], ['timeline', '.tl-content']]) {
       at(sel, 'dragover')
       await __t.sleep(30)
       hint[name] = !!__t.q('.window-drop')
       if (name === 'library' && !__t.q('.bin.dropping')) throw new Error('the library shows no drop of its own')
     }
     if (!hint.player || !hint.inspector || !hint.tabs) throw new Error('no drop shown: ' + JSON.stringify(hint))
     if (hint.library || hint.timeline) throw new Error('the window drop shows over a panel that takes files itself: ' + JSON.stringify(hint))
     at('.player-frame', 'dragover')
     await __t.until(() => __t.q('.window-drop'), 1000, 'the window drop')
     const label = __t.q('.window-drop').textContent
     // The pointer leaving the window ends the drag events; the hint goes with them.
     await __t.until(() => !__t.q('.window-drop'), 1500, 'the hint to go once the drag left')
     at('.insp-head', 'dragover')
     at('.insp-head', 'drop')
     await __t.sleep(30)
     if (__t.q('.window-drop')) throw new Error('the hint stayed after the drop')
     for (const sel of ['.bin', '.tl-content']) __t.q(sel).dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body, dataTransfer: dt }))
     await __t.sleep(30)
     if (__t.q('.bin.dropping') || __t.q('.tl-drophint')) throw new Error('a panel kept its drop after the drag left')
     return { hint, label }`,
  )
  await step(
    'Edit | Audio switches pages, and Alt+2 / Alt+1 switch layouts',
    `;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Audio').click()
     await __t.until(() => __t.q('.ap'), 3000, 'the Audio page')
     ;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Edit').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'the editor')
     __t.key('2', { altKey: true, code: 'Digit2' }); await __t.sleep(150)
     const standard = getComputedStyle(__t.q('.editor-grid')).gridTemplateAreas
     __t.key('1', { altKey: true, code: 'Digit1' }); await __t.sleep(150)
     const ads = getComputedStyle(__t.q('.editor-grid')).gridTemplateAreas
     if (standard === ads) throw new Error('the layout did not change')
     return { standard, ads }`,
  )
  await step(
    'shortcuts list: the Premiere Pro preset moves Split to Ctrl+K',
    `__t.key('k', { ctrlKey: true, code: 'KeyK' })
     await __t.until(() => __t.q('.keys-dialog'), 2000, 'the shortcuts list')
     const split = () => [...__t.qa('.keys-row')].find((r) => r.querySelector('.keys-action').textContent === 'Split at playhead').querySelector('.keys-chips').textContent
     const before = split()
     ;[...__t.qa('.keys-presets button')].find((b) => b.textContent === 'Premiere Pro').click(); await __t.sleep(50)
     const premiere = split()
     ;[...__t.qa('.keys-presets button')].find((b) => b.textContent === 'Default').click(); await __t.sleep(50)
     __t.key('Escape'); await __t.sleep(100)
     if (premiere !== 'CtrlK') throw new Error('Premiere split is ' + premiere)
     if (__t.q('.keys-dialog')) throw new Error('the list did not close')
     return { before, premiere }`,
  )
  await shot('14-shell')

  await step(
    'player handles: dragging the selected clip moves it',
    `__t.key('Escape'); await __t.sleep(100)
     let s = await __t.snap(); const c = __t.main(s).find((x) => s.project.media.find((m) => m.id === x.mediaId)?.kind !== 'audio')
     await window.studio.engine.call('playback.seek', { positionUs: c.startUs + 100000 }); await __t.sleep(200)
     __t.click(__t.clipEl(c.id))
     const box = await __t.until(() => __t.q('.ph-box'), 3000, 'the handles')
     const r = __t.rect(box)
     await __t.drag(box, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 40, r.top + r.height / 2 + 20, 4)
     const after = await __t.until(async () => { const x = __t.main(await __t.snap()).find((y) => y.id === c.id); return (x.posX ?? 0) !== 0 && x }, 4000, 'the clip to move')
     await window.studio.engine.call('edit.undo')
     return { posX: Math.round(after.posX), posY: Math.round(after.posY ?? 0) }`,
  )
  await step(
    'View › Panels hides the inspector and brings it back',
    `__t.key('Escape')
     const menu = (name) => [...__t.qa('.menu-button')].find((b) => b.textContent === name)
     const item = (label) => [...__t.qa('.menu-pop button')].find((b) => b.textContent.includes(label))
     menu('View').click(); await __t.sleep(50)
     item('Panels').click(); await __t.sleep(50)
     item('Inspector').click(); await __t.sleep(150)
     const hiddenNow = !__t.q('.area-insp')
     const areas = getComputedStyle(__t.q('.editor-grid')).gridTemplateAreas
     menu('View').click(); await __t.sleep(50)
     item('Panels').click(); await __t.sleep(50)
     item('Inspector').click(); await __t.sleep(150)
     if (!hiddenNow) throw new Error('the inspector stayed')
     if (!__t.q('.area-insp')) throw new Error('the inspector did not come back')
     return areas`,
  )
  await step(
    'File › Versions saves a version and restores it',
    `__t.key('Escape')
     let s = await __t.snap(); const before = __t.main(s).length
     const dir = s.dir
     await window.studio.app.saveVersion(dir, 'ui-check')
     await window.studio.engine.call('timeline.delete', { clipIds: __t.main(s).map((c) => c.id) })
     s = await __t.until(async () => { const x = await __t.snap(); return __t.main(x).length === 0 && x }, 4000, 'the clips to go')
     const list = await window.studio.app.versions(dir)
     const v = list.find((x) => x.name === 'ui-check')
     if (!v) throw new Error('no saved version')
     await window.studio.app.restoreVersion(dir, v.file)
     await window.studio.engine.call('project.open', { path: dir })
     s = await __t.until(async () => { const x = await __t.snap(); return __t.main(x).length === before && x }, 4000, 'the clips back')
     return { versions: list.length, clips: __t.main(s).length }`,
  )
  await step(
    'Close project shows Home with the projects, and a row opens one',
    `__t.key('w', { ctrlKey: true, code: 'KeyW' })
     await __t.until(() => __t.q('.home-row'), 4000, 'the projects list')
     const names = __t.qa('.home-row .title').map((t) => t.textContent)
     __t.q('.home-row.current').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'the editor')
     return names`,
  )
  await step(
    'Home: right-click › Duplicate, then Delete removes the copy and its folder for good',
    `__t.key('w', { ctrlKey: true, code: 'KeyW' })
     await __t.until(() => __t.q('.home-row.current'), 4000, 'the projects list')
     const rows = () => __t.qa('.home-row')
     const before = rows().length
     const menuOn = (row) => { const r = __t.rect(row); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 })) }
     menuOn(__t.q('.home-row.current'))
     ;(await __t.until(() => [...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Duplicate')), 2000, 'the menu')).click()
     await __t.until(() => rows().length === before + 1, 5000, 'the copy')
     const copy = rows().find((r) => r.querySelector('.title')?.textContent.endsWith(' copy'))
     const dir = copy.getAttribute('title')
     menuOn(copy)
     ;(await __t.until(() => [...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Delete')), 2000, 'the menu')).click()
     const text = (await __t.until(() => __t.q('.pd .pd-text'), 3000, 'the confirmation')).textContent
     ;[...__t.qa('.pd button')].find((b) => b.textContent === 'Delete for good').click()
     await __t.until(() => rows().length === before, 5000, 'the copy to go')
     const gone = !(await window.studio.app.existing([dir]))[0]
     if (!gone) throw new Error('the folder is still there: ' + dir)
     __t.q('.home-row.current').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'the editor')
     return { confirm: text.slice(0, 90), gone }`,
  )
  await shot('15-home-panels')

  // Home's projects as a list (thumbnail size) or a grid (per row), picked with clicks or a box.
  await step(
    'Home: Size makes the list thumbnails bigger',
    `const s0 = await __t.snap()
     const made = []
     for (let i = 1; i <= 12; i++) made.push(await window.studio.app.saveProjectAs(s0.dir, 'Box ' + String(i).padStart(2, '0'), false))
     window.__homeMade = made
     __t.key('w', { ctrlKey: true, code: 'KeyW' })
     await __t.until(() => __t.qa('.home-row').length >= 13, 6000, 'the projects')
     window.__press = async (el, key, mods = {}) => { el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })); await __t.sleep(80) }
     const size = __t.q('[role="slider"][aria-label="Thumbnail size"]')
     for (let i = 0; i < 3; i++) await __press(size, 'ArrowRight', { shiftKey: true })
     const thumb = Math.round(__t.rect(__t.q('.home-row .home-name img, .home-row .home-poster')).height)
     if (thumb !== 172) throw new Error('thumbnails ' + thumb + ' px tall, not 172')
     __t.q('.home').scrollTop = __t.rect(__t.q('#proj-h')).top - __t.rect(__t.q('.home')).top - 60
     return { projects: __t.qa('.home-row').length, thumb }`,
  )
  await shot('15a-home-list-big')
  await step(
    'Home: Grid shows cards, Per row sets how many across',
    `__t.q('.home-view button[aria-label="Grid"]').click()
     await __t.until(() => __t.qa('.home-card').length >= 13, 3000, 'the grid')
     const per = __t.q('[role="slider"][aria-label="Projects per row"]')
     const columns = () => { const tops = __t.qa('.home-card').map((c) => Math.round(__t.rect(c).top)); return tops.filter((t) => t === tops[0]).length }
     await __press(per, 'End'); const most = columns()
     await __press(per, 'Home'); const fewest = columns()
     await __press(per, 'ArrowRight'); await __press(per, 'ArrowRight'); await __press(per, 'ArrowRight')
     if (most !== 10 || fewest !== 2 || columns() !== 5) throw new Error('per row: ' + [most, fewest, columns()])
     await __t.until(() => __t.qa('.home-card-pic img').every((i) => i.complete && i.naturalWidth > 0), 8000, 'the pictures')
     __t.q('.home').scrollTop += __t.rect(__t.q('#proj-h')).top - __t.rect(__t.q('.home')).top - 60
     return { most, fewest, now: columns(), cards: __t.qa('.home-card').length }`,
  )
  await shot('15b-home-grid')
  await step(
    'Home: a box picks every project, holding on to the first while the page scrolls to the end',
    `const home = __t.q('.home'), cards = __t.qa('.home-card'), total = cards.length
     if (home.scrollHeight <= home.clientHeight + 100) throw new Error('nothing to scroll')
     const first = __t.rect(cards[0])
     const [x0, y0] = [first.left - 30, first.top + 20]
     const hr = __t.rect(home), [x1, y1] = [hr.left + home.clientWidth - 30, hr.bottom - 6]
     __t.pointer(document.elementFromPoint(x0, y0), 'pointerdown', x0, y0)
     for (let i = 1; i <= 6; i++) { await __t.sleep(16); __t.pointer(document.body, 'pointermove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6) }
     await __t.until(() => home.scrollTop >= home.scrollHeight - home.clientHeight - 1, 10000, 'the page to scroll to the end')
     await __t.until(() => __t.qa('.home-card.picked').length === total, 3000, 'every project picked')
     __t.pointer(document.body, 'pointerup', x1, y1)
     const away = __t.rect(cards[0]).bottom < hr.top + 48
     if (!away || !cards[0].classList.contains('picked')) throw new Error('the first card ' + (away ? 'was let go' : 'never scrolled away'))
     const status = __t.q('.home-picked')?.textContent
     // Escape lets go; Ctrl+click picks one, Shift+click the run from it.
     __t.key('Escape')
     await __t.until(() => !__t.q('.home-card.picked'), 2000, 'Escape to let go')
     cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
     cards[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
     await __t.until(() => __t.qa('.home-card.picked').length === 3, 2000, 'the run picked')
     // Delete asks about all three; Keep it keeps them.
     __t.key('Delete')
     const ask = (await __t.until(() => __t.q('.pd h2'), 3000, 'the confirmation')).textContent
     if (!ask.includes('3 projects')) throw new Error(ask)
     ;[...__t.qa('.pd button')].find((b) => b.textContent === 'Keep it').click()
     return { picked: total, status, ask }`,
  )
  await shot('15c-home-picked')
  await step(
    'Home: in the list, a box from a row picks the rows it crosses, and its release opens nothing',
    `__t.key('Escape')
     __t.q('.home-view button[aria-label="List"]').click()
     await __t.until(() => __t.qa('.home-row').length >= 13, 3000, 'the list')
     await __press(__t.q('[role="slider"][aria-label="Thumbnail size"]'), 'Home')
     const home = __t.q('.home'), rows = __t.qa('.home-row')
     home.scrollTop += __t.rect(rows[1]).top - __t.rect(home).top - 160
     await __t.sleep(100)
     const [r1, r3] = [__t.rect(rows[1]), __t.rect(rows[3])]
     const x = r1.left + 300
     __t.pointer(rows[1], 'pointerdown', x, r1.top + 10)
     for (let i = 1; i <= 5; i++) { await __t.sleep(16); __t.pointer(document.body, 'pointermove', x, r1.top + 10 + ((r3.top - r1.top) * i) / 5) }
     __t.pointer(document.body, 'pointerup', x, r3.top + 10)
     rows[3].dispatchEvent(new MouseEvent('click', { bubbles: true }))
     await __t.sleep(150)
     const picked = __t.qa('.home-row.picked').length
     if (picked !== 3 || !__t.q('.home')) throw new Error(picked + ' rows picked, or a row opened the project')
     __t.key('Escape')
     for (const d of window.__homeMade) await window.studio.app.deleteProject(d)
     __t.q('.home-row.current').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'the editor')
     return { picked }`,
  )

  // The library tabs and inspector do the real thing (docs/contract-v2.md).
  const cat = (name: string) => `;[...__t.qa('.categories button')].find((b) => b.textContent.includes(${JSON.stringify(name)})).click(); await __t.sleep(150)`
  await step(
    'Text: Add text puts CapCut’s System text on its own track; a preset style, a typed hex colour and Save as preset work in the Inspector',
    `${cat('Text')}
     let s = await __t.snap(); const tracks = s.project.tracks.length
     ;[...__t.qa('.lib-add')].find((b) => /Add text/.test(b.textContent)).click()
     s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.length > tracks && x.project.tracks.find((t) => t.role === 'text')?.clips[0]?.text?.png && x }, 8000, 'the text track')
     const t = s.project.tracks.find((x) => x.role === 'text')
     let c = t.clips[0]
     const exists = (await window.studio.app.existing([c.text.png]))[0]
     if (!exists) throw new Error('the PNG is missing')
     // The library is only Add text and the brand kit now; looks are preset styles in the Inspector.
     if (__t.qa('.ltile').length) throw new Error('the Text tab still shows ' + __t.qa('.ltile').length + ' tiles')
     if (c.text.font !== 'Metropolis') throw new Error('new text is in ' + c.text.font + ', not System')
     window.__studio.getState().selection.includes(c.id) || __t.click(__t.clipEl(c.id))
     const now = async () => (await __t.snap()).project.tracks.find((y) => y.id === t.id)?.clips[0]
     const font = await __t.until(() => __t.q('select[aria-label="Font"]'), 3000, 'the Font list')
     const shown = font.closest('.dsel')?.querySelector('.dsel-value')?.textContent
     if (shown !== 'System') throw new Error('the Font list shows ' + shown)
     // CapCut's preset styles: None and 22 more; Black on white puts the words in CapCut's
     // rounded white box, one round all the lines.
     const styles = __t.qa('.preset-styles[aria-label="Preset styles"] button').length
     if (styles !== 23) throw new Error(styles + ' preset styles, not 23')
     ;(await __t.until(() => __t.q('button[aria-label="Black on white style"]'), 3000, 'the Black on white style')).click()
     c = await __t.until(async () => { const x = await now(); return x?.text?.background?.color === '#FFFFFF' && x.text.color === '#000000' && x.text.background.block && x.text.background.padY > 0 && x }, 8000, 'black words in a rounded white box')
     await __t.until(() => __t.q('button[aria-label="Black on white style"][aria-pressed="true"]'), 3000, 'the style to show as picked')
     // The colour picker: a typed hex code is the text's colour.
     ;(await __t.until(() => __t.q('button[aria-label="Another colour"]'), 3000, 'the colour picker button')).click()
     const hex = await __t.until(() => __t.q('.cpick input[aria-label="Hex code"]'), 3000, 'the hex field')
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(hex, '12ab34')
     hex.dispatchEvent(new Event('input', { bubbles: true }))
     c = await __t.until(async () => { const x = await now(); return x?.text?.color === '#12AB34' && x }, 8000, 'the typed colour on the text')
     document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
     await __t.until(() => !__t.q('.cpick'), 2000, 'the picker to close on a click outside')
     // Save as preset: it's offered under Your presets, and kept in the app's settings.
     ;[...__t.qa('.insp-buttons button')].find((b) => b.textContent === 'Save as preset').click()
     const mine = await __t.until(() => __t.q('button[aria-label="Preset 1 preset"]'), 3000, 'Preset 1 under Your presets')
     const kept = await window.studio.settings.get('textPresets')
     if (!kept?.[0]?.look || kept[0].look.color !== '#12AB34') throw new Error('the saved preset is ' + JSON.stringify(kept))
     return { font: c.text.font, content: c.text.content, colour: c.text.color, box: c.text.background.color, saved: kept.map((p) => p.name), png: c.text.png.split(/[\\\\/]/).pop(), mine: !!mine }`,
  )
  // The player: clips picked on the video, CapCut's box, and text drawn live while it's edited
  // (liveText.ts). The main clip is made small and moved down, so the text sits on black.
  // At 60 frames a second here, so "the next frame" is measured as on a real screen.
  {
    win.webContents.setFrameRate(60)
    const live = `
      const stage = () => __t.q('.ph-stage')
      const pd = (type, x, y, o = {}) => __t.pointer(stage(), type, __t.rect(stage()).left + x, __t.rect(stage()).top + y, o)
      const text = async () => (await __t.snap()).project.tracks.find((t) => t.id === window.__playerText?.track)?.clips[0]
      const drawn = (id) => __t.until(() => window.__studioLive.stats.drawn.includes(id), 5000, 'the live layer to draw the text')
      // The bounding box of what the live canvas has drawn, in frame pixels.
      const liveBox = () => {
        const cv = __t.q('canvas.player-live'); const w = cv.width, h = cv.height
        const d = cv.getContext('2d').getImageData(0, 0, w, h).data
        let x0 = w, y0 = h, x1 = -1, y1 = -1
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        const k = w / cv.clientWidth
        return x1 < 0 ? null : { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k, cx: (x0 + x1 + 1) / 2 / k, cy: (y0 + y1 + 1) / 2 / k }
      }
    `
    await step(
      'Player: clicking text on the video selects it (the Inspector shows it); clicking empty video deselects',
      `${live}
       if (__t.q('.safe-button')?.getAttribute('aria-pressed') === 'true') __t.q('.safe-button').click()
       // A moment with no other text, sticker or overlay on the video (steps before may have added some).
       let s = await __t.snap()
       const free = (t) => !s.project.tracks.some((tr) => !tr.main && tr.kind === 'video' && tr.clips.some((c) => t >= c.startUs - 100000 && t < c.startUs + c.durationUs + 100000))
       let at = -1
       for (const c of __t.main(s)) for (let t = c.startUs + 500000; at < 0 && t < c.startUs + c.durationUs - 500000; t += 250000) if (free(t)) at = t
       if (at < 0) throw new Error('no free moment on the main track')
       const m = __t.main(s).find((c) => at >= c.startUs && at < c.startUs + c.durationUs)
       await window.studio.engine.call('playback.seek', { positionUs: at })
       await __t.until(() => Math.abs(window.__studio.getState().positionUs - at) < 1000, 3000, 'the playhead')
       await window.studio.engine.call('clip.set', { clipId: m.id, scale: 30, posY: 650 })
       ${cat('Text')}
       const tracks = s.project.tracks.length
       ;[...__t.qa('.lib-add')].find((b) => /Add text/.test(b.textContent)).click()
       s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.length > tracks && x }, 8000, 'the text track')
       const track = s.project.tracks.filter((t) => t.role === 'text').pop()
       window.__playerText = { track: track.id, main: m.id }
       const c = track.clips[0]
       await __t.until(() => stage(), 3000, 'the player layer')
       const r = __t.rect(stage())
       // A corner of the frame is empty now: a click there drops the selection.
       pd('pointerdown', 4, 4); pd('pointerup', 4, 4)
       await __t.until(() => !window.__studio.getState().selection.length && !__t.q('.ph-box'), 2000, 'nothing selected')
       if (__t.q('.insp-text')) throw new Error('the Inspector still shows the text')
       // The text sits in the middle of the frame: hovering outlines it, a click picks it.
       pd('pointermove', r.width / 2, r.height / 2, { buttons: 0 })
       await __t.until(() => __t.q('.ph-hover'), 2000, 'the hover outline')
       pd('pointerdown', r.width / 2, r.height / 2); pd('pointerup', r.width / 2, r.height / 2)
       const sel = await __t.until(() => { const x = window.__studio.getState(); return x.selection.length === 1 && x.selection[0] === c.id && x }, 2000, 'the text selected')
       const field = await __t.until(() => __t.q('.insp-text'), 3000, 'the Inspector’s text field')
       if (field.value !== c.text.content) throw new Error('the Inspector shows ' + field.value)
       const box = __t.rect(__t.q('.ph-box'))
       const parts = ['.ph-corner.nw', '.ph-corner.ne', '.ph-corner.sw', '.ph-corner.se', '.ph-delete', '.ph-rotate'].filter((q) => __t.q(q))
       if (parts.length !== 6) throw new Error('the box has ' + parts.join(' '))
       await drawn(c.id)
       return { selected: sel.selection[0], focus: sel.focus, inspector: field.value, box: [Math.round(box.width), Math.round(box.height)], parts: parts.length }`,
    )
    await shot('19-player-selected')
    await step(
      'Player: dragging the text on the video moves it, and the live layer draws it there during the drag',
      `${live}
       const c = await text()
       if (!c) throw new Error('no text from the step before')
       await drawn(c.id)
       const k = __t.rect(stage()).width / (await __t.snap()).project.width
       const b0 = liveBox(); const box0 = __t.rect(__t.q('.ph-box'))
       const r = __t.rect(stage()); const x = box0.left + box0.width / 2 - r.left, y = box0.top + box0.height / 2 - r.top
       pd('pointerdown', x, y)
       for (let i = 1; i <= 8; i++) { await __t.sleep(16); pd('pointermove', x + 5 * i, y - 7.5 * i) }
       // Mid-drag: the text itself has moved with the box, not only the box.
       await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
       const b1 = liveBox(); const box1 = __t.rect(__t.q('.ph-box'))
       pd('pointerup', x + 40, y - 60)
       const moved = [b1.cx - b0.cx, b1.cy - b0.cy].map((v) => +v.toFixed(1))
       if (Math.abs(moved[0] - 40) > 3 || Math.abs(moved[1] + 60) > 3) throw new Error('the live text moved ' + moved + ', not 40,-60')
       if (Math.abs(box1.left - box0.left - 40) > 3) throw new Error('the box moved ' + (box1.left - box0.left))
       const after = await __t.until(async () => { const t = await text(); return Math.abs(t.posX - 40 / k) < 2 && Math.abs(t.posY + 60 / k) < 2 && t }, 5000, 'the new place in the engine')
       await __t.sleep(300)
       const b2 = liveBox()
       if (!b2 || Math.abs(b2.cx - b1.cx) > 2 || Math.abs(b2.cy - b1.cy) > 2) throw new Error('the text jumped after the release: ' + JSON.stringify(b2))
       return { liveMoved: moved, boxMoved: [Math.round(box1.left - box0.left), Math.round(box1.top - box0.top)], engine: [after.posX, after.posY] }`,
    )
    await step(
      'Player: a size change in the Inspector shows on the next frame',
      `${live}
       const c = await text()
       await drawn(c.id)
       const slider = await __t.until(() => __t.q('.inspector [role="slider"][aria-label="Size"]'), 3000, 'the Size slider')
       const size0 = c.text.size
       const before = liveBox()
       const frames = []
       await new Promise((res) => { let n = 0; const f = (t) => { frames.push(t); if (++n < 6) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
       const gap = (frames[frames.length - 1] - frames[0]) / (frames.length - 1)
       const paints0 = window.__studioLive.stats.paints
       const long = []
       const po = new PerformanceObserver((l) => long.push(...l.getEntries().map((e) => [Math.round(e.startTime - t0), Math.round(e.duration)])))
       po.observe({ type: 'longtask' })
       const t0 = performance.now()
       slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }))
       const handled = performance.now() - t0
       // The first animation frame after the live layer drew again (the canvas is read after it, to check it shows the change).
       const shown = await new Promise((res) => {
         const tick = (ts) => { if (window.__studioLive.stats.paints > paints0) res({ ms: performance.now() - t0, frameTs: ts - t0, paintMs: window.__studioLive.stats.lastPaint - t0 }); else if (performance.now() - t0 > 3000) res(null); else requestAnimationFrame(tick) }
         requestAnimationFrame(tick)
       })
       if (!shown) throw new Error('the live layer never drew again')
       const after = liveBox()
       if (!(after && after.w > before.w + 2)) throw new Error('the frame after the change shows ' + JSON.stringify(after) + ', before ' + JSON.stringify(before))
       const saved = await __t.until(async () => { const t = await text(); return t.text.size > size0 && t.text.png !== c.text.png && t }, 8000, 'the new size saved')
       po.disconnect()
       const detail = { ms: +shown.ms.toFixed(1), paintMs: +shown.paintMs.toFixed(1), handlerMs: +handled.toFixed(1), frameMs: +gap.toFixed(1), size: [size0, saved.text.size], width: [+before.w.toFixed(1), +after.w.toFixed(1)], longTasks: long.slice(0, 6) }
       if (shown.paintMs > 33) throw new Error('took ' + JSON.stringify(detail))
       return detail`,
    )
    // Deselecting hands the text back to the engine: frames are captured as it does.
    const deselectName = 'Player: after deselecting, the engine frame has the new look, with no double text and no old-look flash'
    if (!only || only.test(deselectName)) {
      try {
        const band = await js(`const f = __t.rect(__t.q('.player-frame')); return { x: Math.round(f.left), y: Math.round(f.top + f.height * 0.2), width: Math.round(f.width), height: Math.round(f.height * 0.45) }`)
        // White pixels (the text, on black) in that band: how many, and how wide they spread.
        const capture = async () => {
          const img = await win.webContents.capturePage(band)
          const { width, height } = img.getSize()
          const px = img.toBitmap()
          let n = 0
          let x0 = width
          let x1 = -1
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const o = (y * width + x) * 4
              if (px[o] > 200 && px[o + 1] > 200 && px[o + 2] > 200) {
                n++
                x0 = Math.min(x0, x)
                x1 = Math.max(x1, x)
              }
            }
          return { n, w: x1 >= x0 ? x1 - x0 + 1 : 0 }
        }
        const liveCanvas = (on: boolean) => js(`__t.q('canvas.player-live').style.visibility = '${on ? '' : 'hidden'}'; await __t.sleep(150)`)
        // The box and its white handles would count as text: hidden for this step (clicks still reach the layer).
        await js(`__t.q('.ph-stage').style.visibility = 'hidden'; await __t.sleep(100)`)
        const id = await js(`${live} const c = await text(); await drawn(c.id); return c.id`)
        const old = await capture()
        // A much bigger size, saved, while the player draws it.
        await js(`${live}
          const c = await text()
          // The slider steps from the size it shows, so each step waits for the one before to be saved.
          for (let i = 1; i <= 4; i++) {
            __t.q('.inspector [role="slider"][aria-label="Size"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }))
            await __t.until(async () => { const t = await text(); return t.text.size >= c.text.size + 10 * i && window.__studio.getState().snap.project.tracks.some((x) => x.clips.some((y) => y.id === c.id && y.text.size >= c.text.size + 10 * i)) }, 8000, 'size step ' + i + ' saved')
          }
          await __t.until(() => window.__studioLive.stats.drawn.includes(c.id), 5000, 'the live layer')
          await __t.sleep(400)`)
        const fresh = await capture()
        await liveCanvas(false)
        const engineWhileLive = await capture()
        await liveCanvas(true)
        if (!(fresh.w > old.w + 4)) throw new Error(`the text isn't wider: ${old.w} → ${fresh.w}`)
        if (engineWhileLive.n > fresh.n * 0.05) throw new Error(`the engine draws the text too while the player does (${engineWhileLive.n} of ${fresh.n} pixels)`)
        // Deselect, and watch every frame until the engine has it back.
        await js(`${live} pd('pointerdown', 4, 4); pd('pointerup', 4, 4)`)
        const t0 = Date.now()
        const seen: { ms: number; n: number; w: number }[] = []
        while (Date.now() - t0 < 1500) seen.push({ ms: Date.now() - t0, ...(await capture()) })
        // The engine's text is drawn from a half-size frame, a little softer: fewer pure-white pixels.
        const gone = seen.filter((f) => f.n < fresh.n * 0.35)
        const oldLook = seen.filter((f) => f.n && f.w < (old.w + fresh.w) / 2)
        const handed = await js(`${live} await __t.until(() => !window.__studioLive.stats.drawn.length && !window.__studioLive.sent().clips.length, 3000, 'the player to let go of the text'); return window.__studioLive.stats.drawn.length`)
        await liveCanvas(false)
        const engineAfter = await capture()
        await liveCanvas(true)
        await js(`__t.q('.ph-stage').style.visibility = ''`)
        if (gone.length) throw new Error(`the text was missing in ${gone.length} of ${seen.length} frames: ${JSON.stringify(gone.slice(0, 3))}`)
        if (oldLook.length) throw new Error(`the old look flashed in ${oldLook.length} of ${seen.length} frames: ${JSON.stringify(oldLook.slice(0, 3))}`)
        if (Math.abs(engineAfter.w - fresh.w) > 4 || engineAfter.n < fresh.n * 0.35) throw new Error(`the engine's frame shows ${JSON.stringify(engineAfter)}, the live layer showed ${JSON.stringify(fresh)}`)
        const detail = { clip: id, oldWidth: old.w, newWidth: fresh.w, engineWhileLive: engineWhileLive.n, liveDrawn: handed, framesWatched: seen.length, engineAfter, livePixels: fresh.n }
        results.push({ step: deselectName, ok: true, detail })
        console.log(`[ui-check] ok   ${deselectName} ${JSON.stringify(detail)}`)
      } catch (e) {
        await js(`__t.q('.ph-stage').style.visibility = ''; __t.q('canvas.player-live').style.visibility = ''`).catch(() => {})
        results.push({ step: deselectName, ok: false, detail: (e as Error).message })
        console.log(`[ui-check] FAIL ${deselectName}: ${(e as Error).message}`)
      }
    }
    await step(
      'Player: × on the box deletes the text, and undo brings it back',
      `${live}
       const c = await text()
       if (!c) throw new Error('no text from the steps before')
       // Picked on the video again, where it was moved to.
       const f = __t.rect(stage()); const k = f.width / (await __t.snap()).project.width
       const x = f.width / 2 + c.posX * k, y = f.height / 2 + c.posY * k
       pd('pointerdown', x, y); pd('pointerup', x, y)
       await __t.until(() => window.__studio.getState().selection[0] === c.id && __t.q('.ph-delete'), 3000, 'the text picked, with the × on its box')
       __t.q('.ph-delete').click()
       await __t.until(async () => !(await text()), 5000, 'the text gone')
       if (window.__studio.getState().selection.length) throw new Error('still selected')
       __t.key('z', { ctrlKey: true, code: 'KeyZ' })
       const back = await __t.until(async () => await text(), 5000, 'the text back after undo')
       // Tidy up: the main clip back to its size and place, the safe zones back on.
       await window.studio.engine.call('clip.set', { clipId: window.__playerText.main, scale: 100, posY: 0 })
       if (__t.q('.safe-button')?.getAttribute('aria-pressed') === 'false') __t.q('.safe-button').click()
       return { deleted: c.id, back: back.id === c.id, content: back.text.content }`,
    )
    win.webContents.setFrameRate(30)
  }
  await step(
    'Stickers: a tile adds a sticker overlay',
    `${cat('Stickers')}
     let s = await __t.snap(); const before = s.project.tracks.filter((t) => t.role === 'sticker').length
     ;(await __t.until(() => __t.qa('.ltile').find((b) => !b.disabled), 3000, 'a sticker tile')).click()
     s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.filter((t) => t.role === 'sticker').length > before && x }, 8000, 'the sticker track')
     return s.project.tracks.filter((t) => t.role === 'sticker').length`,
  )
  await step(
    'Transitions: a tile puts a transition on a cut',
    `${cat('Transitions')}
     let s = await __t.snap(); const m = __t.main(s)
     if (m.length < 2) throw new Error('needs two main clips')
     __t.click(__t.clipEl(m[1].id))
     ;(await __t.until(() => __t.qa('.ltile').find((b) => !b.disabled && b.textContent !== 'None'), 3000, 'a transition tile')).click()
     const c = await __t.until(async () => { const x = __t.main(await __t.snap()).find((y) => y.id === m[1].id); return x.transition && x }, 5000, 'the transition')
     const marker = await __t.until(() => __t.q('.tl-transition'), 3000, 'the marker on the cut')
     return { name: c.transition.name, seconds: c.transition.durationUs / 1e6, marker: !!marker }`,
  )
  await step(
    'Effects: an effect tile toggles the effect on the selected clip',
    `${cat('Effects')}
     let s = await __t.snap(); const c = __t.main(s)[0]
     __t.click(__t.clipEl(c.id))
     const names = await window.studio.engine.call('engine.effects')
     // Effects opens on Looks; the effect tiles are under Video effects.
     ;(await __t.until(() => [...__t.qa('.pills-sub button')].find((b) => b.textContent === 'Video effects'), 3000, 'the Video effects tab')).click()
     await __t.sleep(100)
     const tile = await __t.until(() => __t.qa('.ltile').find((b) => names.includes(b.querySelector('.ltile-name')?.textContent)), 3000, 'an effect tile')
     tile.click()
     const after = await __t.until(async () => { const x = __t.main(await __t.snap()).find((y) => y.id === c.id); return x.effects?.length && x }, 5000, 'the effect')
     // The tile shows the effect as on once the panel has the new snapshot; then a click takes it off.
     await __t.until(() => tile.getAttribute('aria-pressed') === 'true', 3000, 'the tile to show it on')
     tile.click()
     await __t.until(async () => !(__t.main(await __t.snap()).find((y) => y.id === c.id).effects?.length), 5000, 'the effect off again')
     return after.effects`,
  )
  await step(
    'right-click › Edit in Audio opens the clip on the Audio page',
    `${cat('Media')}
     let s = await __t.snap(); const c = __t.main(s).find((x) => s.project.media.find((m) => m.id === x.mediaId)?.hasAudio && !x.detached) ?? s.project.tracks.find((t) => t.kind === 'audio')?.clips[0]
     if (!c) throw new Error('no clip with sound')
     __t.click(__t.clipEl(c.id))
     const el = __t.clipEl(c.id); const r = __t.rect(el)
     el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
     await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
     ;[...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Edit in Audio')).click()
     await __t.until(() => __t.q('.ap'), 5000, 'the Audio page')
     s = await __t.snap()
     const audio = s.project.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips)
     const picked = window.__studio.getState().selection
     ;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Edit').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'back to the editor')
     return { selected: picked, onAudioTrack: picked.every((id) => audio.some((a) => a.id === id)) }`,
  )
  await shot('16-library-tabs')

  // The Audio page: down to single samples, cutting a gap, and removing silences with a preview.
  // Its keys are dispatched on the page's body, as real key presses arrive.
  const bodyKey = (key: string, o = '{}') => `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${o} }))`
  await step(
    'Audio page: the ruler lines up with the tracks, which sit mid-panel',
    `;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Audio').click()
     await __t.until(() => __t.q('.ap-lanes'), 3000, 'the Audio page')
     await __t.sleep(200)
     const ruler = __t.rect(__t.q('.ap-ruler')), lanes = __t.rect(__t.q('.ap-lanes'))
     if (Math.abs(ruler.left - lanes.left) > 1 || Math.abs(ruler.width - lanes.width) > 12) throw new Error('ruler ' + Math.round(ruler.left) + '+' + Math.round(ruler.width) + ' vs lanes ' + Math.round(lanes.left) + '+' + Math.round(lanes.width))
     const pad = parseFloat(__t.q('.ap-lanes').style.paddingTop)
     return { rulerLeft: Math.round(ruler.left), lanesLeft: Math.round(lanes.left), padTop: pad }`,
  )
  await step(
    'Audio page: zooming in reaches single samples',
    `;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Audio').click()
     await __t.until(() => __t.q('.ap'), 3000, 'the Audio page')
     const s = await __t.snap(); const voice = s.project.tracks.find((t) => t.kind === 'audio' && t.clips.length)
     if (!voice) throw new Error('no audio track')
     await window.studio.engine.call('playback.seek', { positionUs: voice.clips[0].startUs + 300000 })
     let mode = ''
     for (let i = 0; i < 30 && mode !== 'stems'; i++) {
       ${bodyKey('=', "{ ctrlKey: true, code: 'Equal' }")}
       await __t.sleep(120)
       mode = __t.q('.ap-wavecanvas[data-mode=stems]') ? 'stems' : (__t.q('.ap-wavecanvas[data-mode=line]') ? 'line' : 'levels')
     }
     await __t.until(() => __t.q('.ap-wavecanvas[data-mode=stems]'), 4000, 'the sample view')
     return mode`,
  )
  await shot('17-audio-samples')
  await step(
    'Audio page: Space plays from the last click, and Space again stops and comes back to it',
    `${bodyKey('0', "{ ctrlKey: true, code: 'Digit0' }")}
     await __t.sleep(150)
     const lane = __t.q('.ap-lane'); const r = __t.rect(lane)
     __t.pointer(lane, 'pointerdown', r.left + r.width * 0.2, r.top + r.height / 2); __t.pointer(lane, 'pointerup', r.left + r.width * 0.2, r.top + r.height / 2)
     await __t.sleep(200)
     const from = window.__studio.getState().positionUs
     ${bodyKey(' ', "{ code: 'Space' }")}
     await __t.until(() => window.__studio.getState().playing, 4000, 'playing')
     await __t.sleep(700)
     ${bodyKey(' ', "{ code: 'Space' }")}
     await __t.until(() => !window.__studio.getState().playing, 4000, 'stopped')
     const back = await __t.until(() => { const p = window.__studio.getState().positionUs; return Math.abs(p - from) < 60000 && p }, 3000, 'the playhead back at the click')
     return { clickedS: +(from / 1e6).toFixed(2), backS: +(back / 1e6).toFixed(2) }`,
  )
  await step(
    'Audio page: a selected gap is cut out with Ctrl+X and the sound closes up',
    `${bodyKey('0', "{ ctrlKey: true, code: 'Digit0' }")}
     const s = await __t.snap(); const t = s.project.tracks.find((x) => x.kind === 'audio' && x.clips.length)
     const before = t.clips.reduce((m, c) => Math.max(m, c.startUs + c.durationUs), 0)
     await window.studio.engine.call('audio.removeRange', { trackId: t.id, startUs: t.clips[0].startUs + 200000, endUs: t.clips[0].startUs + 500000 })
     const after = await __t.until(async () => { const x = (await __t.snap()).project.tracks.find((y) => y.id === t.id); const end = x.clips.reduce((m, c) => Math.max(m, c.startUs + c.durationUs), 0); return end < before && end }, 4000, 'the track to close up')
     const h = await window.studio.engine.call('history.list')
     return { shortenedBy: +((before - after) / 1e6).toFixed(2), last: h.steps[h.current]?.label }`,
  )
  await step(
    'Audio page: Remove silences previews the pauses, then removes exactly those',
    `const tile = await __t.until(() => [...__t.qa('button')].find((b) => /Remove silences/.test(b.textContent)), 3000, 'the Remove silences tile')
     tile.click()
     await __t.until(() => __t.q('.ap-silence') || /No pauses/.test(document.body.textContent), 6000, 'the preview')
     const marks = __t.qa('.ap-silence').length
     const remove = [...__t.qa('button')].find((b) => b.textContent.trim() === 'Remove')
     let removed = 0
     if (marks && remove) {
       const s = await __t.snap()
       remove.click()
       await __t.rev(s.revision, 'the removal')
       removed = marks
     } else [...__t.qa('button')].find((b) => b.textContent.trim() === 'Cancel')?.click()
     ;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Edit').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'back to the editor')
     return { marks, removed }`,
  )

  // The playhead and the start line (where Space plays from), as the user reported them.
  const lanePress = (frac: string, lane = "__t.q('.ap-lane')") => `{ const l = ${lane}; const r = __t.rect(l); __t.pointer(l, 'pointerdown', r.left + r.width * ${frac}, r.top + r.height / 2); __t.pointer(l, 'pointerup', r.left + r.width * ${frac}, r.top + r.height / 2) }`
  await step(
    'Audio page: Loop starts off, and playing runs on past a cut',
    `;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Audio').click()
     await __t.until(() => __t.q('.ap-lanes'), 3000, 'the Audio page')
     if (__t.q('button[aria-label="Loop"]').getAttribute('aria-pressed') !== 'false') throw new Error('Loop is on when the page opens')
     const s = await __t.snap(); const t = s.project.tracks.find((x) => x.kind === 'audio' && x.clips.length > 1)
     if (!t) throw new Error('no track with a cut')
     const cut = [...t.clips].sort((a, b) => a.startUs - b.startUs)[0]
     const at = cut.startUs + cut.durationUs
     await window.studio.engine.call('playback.seek', { positionUs: Math.max(0, at - 300000) })
     await window.studio.engine.call('playback.play')
     const past = await __t.until(() => { const p = window.__studio.getState().positionUs; return p > at + 300000 && p }, 5000, 'playback to pass the cut')
     await window.studio.engine.call('playback.pause')
     await __t.until(() => !window.__studio.getState().playing, 3000, 'paused')
     return { cutS: +(at / 1e6).toFixed(2), reachedS: +(past / 1e6).toFixed(2) }`,
  )
  await step(
    'Audio page: Skip to start puts the playhead and the start line at 0',
    `${lanePress('0.4')}
     await __t.until(() => window.__studio.getState().positionUs > 0, 3000, 'the click')
     __t.q('button[aria-label="Skip to start"]').click()
     await __t.until(() => window.__studio.getState().positionUs === 0, 3000, 'the playhead at 0')
     await __t.sleep(100)
     // The start line is drawn only where it differs from the playhead.
     if (__t.q('.ap-cursor')) throw new Error('the start line stayed at ' + __t.q('.ap-cursor').style.left)
     return 'both at 0'`,
  )
  await step(
    'Audio page: grabbing the playhead takes the start line with it, and Space plays from there',
    `const lane = __t.q('.ap-lane'); const r = __t.rect(lane)
     // A double-click grabs the line; it follows the mouse until the button comes up.
     ${lanePress('0.3')}
     await __t.sleep(60)
     __t.pointer(lane, 'pointerdown', r.left + r.width * 0.3, r.top + r.height / 2)
     for (let i = 1; i <= 6; i++) { await __t.sleep(16); __t.pointer(lane, 'pointermove', r.left + r.width * (0.3 + 0.05 * i), r.top + r.height / 2) }
     __t.pointer(lane, 'pointerup', r.left + r.width * 0.6, r.top + r.height / 2)
     await __t.sleep(150)
     const there = window.__studio.getState().positionUs
     if (__t.q('.ap-cursor')) throw new Error('the start line was left behind at ' + __t.q('.ap-cursor').style.left)
     ${bodyKey(' ', "{ code: 'Space' }")}
     await __t.until(() => window.__studio.getState().playing, 4000, 'playing')
     await __t.sleep(400)
     // While it plays, the playhead is drawn over everything at its spot.
     const ph = __t.rect(__t.q('.ap-playhead')); const clip = __t.rect(__t.q('.ap-clip'))
     const top = document.elementsFromPoint(ph.left + ph.width / 2, clip.top + clip.height / 2)[0]
     if (!top?.classList.contains('ap-playhead')) throw new Error('the playhead is under ' + (top?.className || top?.tagName))
     ${bodyKey(' ', "{ code: 'Space' }")}
     await __t.until(() => !window.__studio.getState().playing, 4000, 'stopped')
     const back = await __t.until(() => { const p = window.__studio.getState().positionUs; return Math.abs(p - there) < 60000 && p }, 3000, 'the playhead back where it was let go')
     return { letGoS: +(there / 1e6).toFixed(2), backS: +(back / 1e6).toFixed(2) }`,
  )
  await step(
    'Audio page: zoomed in, holding the playhead at the edge pans the view and the playhead keeps going',
    `${bodyKey('f', "{ ctrlKey: true, code: 'KeyF' }")}
     await __t.sleep(100)
     for (let i = 0; i < 3; i++) { ${bodyKey('=', "{ ctrlKey: true, code: 'Equal' }")}; await __t.sleep(80) }
     const lane = __t.q('.ap-lane'); const r = __t.rect(__t.q('.ap-lanes'))
     const y = __t.rect(lane).top + 20
     // A double-click grabs the line; then the pointer rests near the right edge.
     __t.pointer(lane, 'pointerdown', r.left + 100, y); __t.pointer(lane, 'pointerup', r.left + 100, y)
     await __t.sleep(60)
     __t.pointer(lane, 'pointerdown', r.left + 100, y)
     for (let i = 1; i <= 6; i++) { await __t.sleep(16); __t.pointer(lane, 'pointermove', r.left + 100 + ((r.width - 112) * i) / 6, y) }
     await __t.sleep(60)
     const p0 = window.__studio.getState().positionUs
     await __t.sleep(900)
     const p1 = window.__studio.getState().positionUs
     __t.pointer(lane, 'pointerup', r.right - 12, y)
     ${bodyKey('f', "{ ctrlKey: true, code: 'KeyF' }")}
     if (!(p1 > p0 + 100000)) throw new Error('the playhead stayed at ' + (p0 / 1e6).toFixed(2) + ' → ' + (p1 / 1e6).toFixed(2) + ' s')
     return { atEdgeS: +(p0 / 1e6).toFixed(2), afterS: +(p1 / 1e6).toFixed(2) }`,
  )
  await step(
    'Audio page: a drag in the empty row under a sound selects that sound',
    `// The whole length in view (an earlier step zoomed in to single samples).
     ${bodyKey('f', "{ ctrlKey: true, code: 'KeyF' }")}
     await __t.sleep(150)
     const lanes = __t.qa('.ap-lane'); const labels = lanes[lanes.length - 1]; const r = __t.rect(labels)
     __t.pointer(labels, 'pointerdown', r.left + r.width * 0.05, r.top + r.height / 2)
     for (let i = 1; i <= 6; i++) { await __t.sleep(16); __t.pointer(labels, 'pointermove', r.left + r.width * (0.05 + 0.04 * i), r.top + r.height / 2) }
     __t.pointer(labels, 'pointerup', r.left + r.width * 0.29, r.top + r.height / 2)
     const sel = await __t.until(() => __t.q('.ap-timesel'), 2000, 'the selection')
     const lane = sel.closest('.ap-lane')
     if (lane === labels) throw new Error('the selection stayed on the empty labels row')
     const s = __t.rect(sel)
     if (![...lane.querySelectorAll('.ap-clip')].some((c) => { const x = __t.rect(c); return x.left < s.right && x.right > s.left })) throw new Error('the selection is on a row with no sound there')
     // L loops the selection when there's no loop region yet; L again turns it off.
     ${bodyKey('l', "{ code: 'KeyL' }")}
     const loop = await __t.until(() => __t.q('.ap-loop') || [...__t.qa('.toast')].map((t) => t.textContent).find((t) => /loop/i.test(t)), 2000, 'the loop region')
     if (typeof loop === 'string') throw new Error('L made no loop region: ' + loop)
     const on = __t.q('button[aria-label="Loop"]').getAttribute('aria-pressed')
     ${bodyKey('l', "{ code: 'KeyL' }")}
     await __t.until(() => __t.q('button[aria-label="Loop"]').getAttribute('aria-pressed') === 'false', 2000, 'Loop off again')
     loop.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
     await __t.until(() => !__t.q('.ap-loop'), 2000, 'the loop region gone')
     ;[...__t.qa('.page-switch button')].find((b) => b.textContent === 'Edit').click()
     await __t.until(() => __t.q('.editor-grid'), 3000, 'back to the editor')
     return { selectedRow: lanes.indexOf(lane) + ' (labels row is ' + (lanes.length - 1) + ')', loopWasOn: on }`,
  )

  await step(
    'Timeline: a clip dragged above the tracks goes on a new track over the video, and back down into it',
    `let s = await __t.snap(); const main = __t.main(s); const n = main.length; const c = main[n - 1]
     const el = __t.clipEl(c.id); const r = __t.rect(el)
     const top = __t.rect(__t.qa('.tl-row')[0])
     await __t.drag(el, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 - 60, top.top - 10)
     s = await __t.until(async () => { const x = await __t.snap(); return __t.main(x).length === n - 1 && x.project.tracks.some((t) => !t.main && t.clips.some((k) => k.id === c.id)) && x }, 5000, 'the clip on a track over the video')
     const over = s.project.tracks.find((t) => t.clips.some((k) => k.id === c.id))
     if (over.kind !== 'video' || over.role !== 'overlay') throw new Error('it went to a ' + over.kind + ' ' + over.role + ' track')
     const at = over.clips.find((k) => k.id === c.id).startUs
     // Up there it still plays its own sound, so it keeps its waveform and the Inspector's Audio tab.
     const sound = s.project.media.find((m) => m.id === c.mediaId)?.hasAudio && !c.detached
     if (sound) {
       window.__studio.getState().selection.includes(c.id) || __t.click(__t.clipEl(c.id))
       await __t.until(() => __t.qa('.insp-tabs button').some((b) => b.textContent === 'Audio'), 3000, 'the Audio tab for the lifted clip')
       await __t.until(() => __t.clipEl(c.id)?.querySelector('canvas.waveform'), 3000, 'the lifted clip’s waveform')
     }
     // Back down into the video track, after its last clip.
     const el2 = await __t.until(() => __t.clipEl(c.id), 3000, 'the clip on its new track'); const r2 = __t.rect(el2)
     const mainRow = __t.rect(__t.q('.tl-row.kind-main'))
     const last = __t.rect(__t.clipEl(__t.main(s)[n - 2].id))
     await __t.drag(el2, r2.left + r2.width / 2, r2.top + r2.height / 2, last.right + 30, mainRow.top + mainRow.height / 2)
     s = await __t.until(async () => { const x = await __t.snap(); return __t.main(x).length === n && x }, 5000, 'the clip back in the video track')
     if (s.project.tracks.some((t) => !t.main && t.clips.some((k) => k.id === c.id))) throw new Error('it also stayed above')
     return { liftedToS: +(at / 1e6).toFixed(2), backAtIndex: __t.main(s).findIndex((k) => k.id === c.id), of: n }`,
  )
  await shot('17b-stacking')

  // Dragging anything anywhere, as CapCut does (Timeline.tsx `aim`): onto a row of its kind with
  // room, else onto a new track at the line the drag shows. The ghost mid-drag is where it lands.
  const dragKit = `
    const dev = window.__studioDev
    const trackOf = (s, id) => s.project.tracks.find((t) => t.clips.some((c) => c.id === id))
    const indexOf = (s, id) => s.project.tracks.indexOf(trackOf(s, id))
    const clipOf = (s, id) => trackOf(s, id).clips.find((c) => c.id === id)
    const visual = (s) => s.project.tracks.filter((t) => !t.main && t.kind === 'video')
    const addText = async (atUs, content) => {
      const look = await dev.textRender.renderTextClip({ ...dev.presets.DEFAULT_TEXT, content }, 'uicheck')
      const r = await window.studio.engine.call('text.add', { atUs, text: look })
      await __t.until(() => __t.clipEl(r.clipId), 5000, 'the text clip ' + content)
      return r
    }
    // The time the ghost shows, from its place and size (a clip durUs long).
    const ghostSeen = (durUs) => {
      const g = __t.q('.clip.ghost'), l = __t.q('.tl-newrow')
      if (!g) return { ghost: false }
      const pps = (parseFloat(g.style.width) + 1) / (durUs / 1e6)
      return { ghost: true, atUs: (new DOMMatrix(getComputedStyle(g).transform).m41 / pps) * 1e6, usPerPx: 1e6 / pps, line: l ? __t.rect(l).top + 1 : null, label: l ? l.textContent : null }
    }
    // A drag with a look before letting go: what the ghost and the new-track line showed.
    const dragSeen = async (el, durUs, x0, y0, x1, y1) => {
      const content = __t.q('.tl-content')
      __t.pointer(el, 'pointerdown', x0, y0)
      for (let i = 1; i <= 10; i++) { await __t.sleep(16); __t.pointer(content, 'pointermove', x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10) }
      await __t.sleep(80)
      const seen = ghostSeen(durUs)
      __t.pointer(content, 'pointerup', x1, y1)
      if (!seen.ghost) throw new Error('no ghost mid-drag')
      return seen
    }
    // It starts where its ghost was.
    const sameTime = (c, seen) => { if (Math.abs(c.startUs - seen.atUs) > 1.5 * seen.usPerPx) throw new Error('it starts at ' + (c.startUs / 1e6).toFixed(3) + ' s; the ghost showed ' + (seen.atUs / 1e6).toFixed(3) + ' s') }
  `
  await step(
    'Drag: several selected clips move together, each on its own row, by the same time, as one undo step',
    `const s0 = await __t.snap(); const end = s0.durationUs
     const a = await window.studio.engine.call('text.add', { atUs: 2000000, durationUs: 1000000, text: { content: 'Group A', font: 'Metropolis', size: 60, weight: 600, color: '#FFFFFF', align: 'center', lineHeight: 1.2, letterSpacing: 0, case: 'none' } })
     const b = await window.studio.engine.call('text.add', { atUs: 4000000, durationUs: 1000000, text: { content: 'Group B', font: 'Metropolis', size: 60, weight: 600, color: '#FFFFFF', align: 'center', lineHeight: 1.2, letterSpacing: 0, case: 'none' } })
     const ea = await __t.until(() => __t.clipEl(a.clipId), 3000, 'the first text clip'), eb = await __t.until(() => __t.clipEl(b.clipId), 3000, 'the second text clip')
     __t.click(ea); __t.click(eb, { ctrlKey: true })
     await __t.until(() => window.__studio.getState().selection.length === 2, 2000, 'both selected')
     const before = await __t.snap()
     const where = (s, id) => { const t = s.project.tracks.find((x) => x.clips.some((c) => c.id === id)); return { track: t.id, start: t.clips.find((c) => c.id === id).startUs } }
     const [wa, wb] = [where(before, a.clipId), where(before, b.clipId)]
     const r = __t.rect(ea)
     await __t.drag(ea, r.left + 10, r.top + r.height / 2, r.left + 90, r.top + r.height / 2)
     const after = await __t.rev(before.revision)
     const [na, nb] = [where(after, a.clipId), where(after, b.clipId)]
     const da = na.start - wa.start, db = nb.start - wb.start
     if (!(da > 0) || da !== db) throw new Error('they moved by ' + da + ' and ' + db)
     if (na.track !== wa.track || nb.track !== wb.track) throw new Error('a clip changed rows')
     const steps = after.revision - before.revision
     __t.key('z', { ctrlKey: true })
     const undone = await __t.rev(after.revision)
     if (where(undone, a.clipId).start !== wa.start || where(undone, b.clipId).start !== wb.start) throw new Error('one undo didn’t put them both back')
     await window.studio.engine.call('timeline.delete', { clipIds: [a.clipId, b.clipId] }).catch(() => window.studio.engine.call('clip.delete', { clipIds: [a.clipId, b.clipId] }))
     return { movedS: +(da / 1e6).toFixed(2), revisions: steps }`,
  )
  await step(
    'Drag: a text clip dragged above every row goes on a new text track on top, where its ghost showed',
    `${dragKit}
     __t.key('Escape')
     const a = await addText(2000000, 'Lower'), b = await addText(2000000, 'Upper')
     let s = await __t.snap()
     const el = __t.clipEl(a.clipId); const r = __t.rect(el); const top = __t.rect(__t.qa('.tl-row')[0])
     const seen = await dragSeen(el, clipOf(s, a.clipId).durationUs, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 50, top.top - 8)
     if (seen.label !== 'New text track' || Math.abs(seen.line - (top.top - 2)) > 2) throw new Error('mid-drag: ' + JSON.stringify(seen) + ', top row at ' + top.top)
     s = await __t.rev(s.revision)
     const t = trackOf(s, a.clipId), v = visual(s)
     if (t.role !== 'text' || t !== v[v.length - 1] || t.id === a.trackId || t.id === b.trackId) throw new Error('it went to the ' + t.role + ' track at ' + s.project.tracks.indexOf(t) + ' of ' + s.project.tracks.length)
     sameTime(clipOf(s, a.clipId), seen)
     return { startS: +(clipOf(s, a.clipId).startUs / 1e6).toFixed(2), track: s.project.tracks.indexOf(t), ghostS: +(seen.atUs / 1e6).toFixed(2), label: seen.label }`,
  )
  // Held mid-drag for a screenshot of the ghost and the line, then let go in the next step.
  await step(
    'Drag: mid-drag between two rows, the ghost and a "New text track" line show where it lands',
    `${dragKit}
     __t.key('Escape')
     const a = await addText(6000000, 'One'), b = await addText(6000000, 'Two'), c = await addText(6000000, 'Three')
     const s = await __t.snap()
     // Rows top down: c, b, a. c goes to the line between b's row and a's.
     const rb = __t.rect(__t.clipEl(b.clipId)), ra = __t.rect(__t.clipEl(a.clipId))
     const el = __t.clipEl(c.clipId); const r = __t.rect(el); const y = (rb.bottom + ra.top) / 2
     const content = __t.q('.tl-content'); const [x0, y0, x1] = [r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 40]
     __t.pointer(el, 'pointerdown', x0, y0)
     for (let i = 1; i <= 10; i++) { await __t.sleep(16); __t.pointer(content, 'pointermove', x0 + ((x1 - x0) * i) / 10, y0 + ((y - y0) * i) / 10) }
     await __t.sleep(80)
     const seen = ghostSeen(clipOf(s, c.clipId).durationUs)
     window.__held = { a, b, c, s, seen, x1, y }
     if (!seen.ghost || seen.label !== 'New text track' || Math.abs(seen.line - y) > 2) throw new Error('mid-drag: ' + JSON.stringify(seen) + ', the gap at ' + y)
     return { ghostS: +(seen.atUs / 1e6).toFixed(2), lineY: Math.round(seen.line), label: seen.label }`,
  )
  await shot('17c-drag-ghost')
  await step(
    'Drag: let go between two rows, the text clip goes on a new text track inserted there',
    `${dragKit}
     const held = window.__held
     if (!held) throw new Error('no drag in progress')
     delete window.__held
     const { a, b, c, seen } = held
     __t.pointer(__t.q('.tl-content'), 'pointerup', held.x1, held.y)
     let s = await __t.rev(held.s.revision)
     const [ia, ic, ib] = [indexOf(s, a.clipId), indexOf(s, c.clipId), indexOf(s, b.clipId)]
     const t = trackOf(s, c.clipId)
     if (!(ia < ic && ic < ib) || t.role !== 'text' || [a.trackId, b.trackId, c.trackId].includes(t.id)) throw new Error('tracks: a ' + ia + ', c ' + ic + ' (' + t.role + '), b ' + ib)
     sameTime(clipOf(s, c.clipId), seen)
     return { a: ia, c: ic, b: ib, startS: +(clipOf(s, c.clipId).startUs / 1e6).toFixed(2) }`,
  )
  await step(
    'Drag: a text clip dropped where a text row is taken goes on a new text track just above that row',
    `${dragKit}
     __t.key('Escape')
     const a = await addText(10000000, 'Taken'), x = await addText(10000000, 'Between'), b = await addText(10000000, 'Mover')
     let s = await __t.snap()
     // b (top) onto a's row (two down) at the time a takes: a new track just above a's, under x's.
     const ra = __t.rect(__t.clipEl(a.clipId))
     const el = __t.clipEl(b.clipId); const r = __t.rect(el)
     const seen = await dragSeen(el, clipOf(s, b.clipId).durationUs, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + 30, ra.top + ra.height / 2)
     if (seen.line == null || Math.abs(seen.line - (ra.top - 2)) > 2) throw new Error('mid-drag: ' + JSON.stringify(seen) + ', the row at ' + ra.top)
     s = await __t.rev(s.revision)
     const [ia, ib, ix] = [indexOf(s, a.clipId), indexOf(s, b.clipId), indexOf(s, x.clipId)]
     if (trackOf(s, b.clipId).id === a.trackId || trackOf(s, b.clipId).role !== 'text' || ib !== ia + 1 || ix !== ib + 1) throw new Error('tracks: a ' + ia + ', b ' + ib + ', x ' + ix)
     sameTime(clipOf(s, b.clipId), seen)
     return { a: ia, b: ib, x: ix }`,
  )
  await step(
    'Drag: a caption line dragged above every row stays a caption line, on a new captions track',
    `${dragKit}
     __t.key('Escape')
     const look = await dev.textRender.renderTextClip({ ...dev.presets.DEFAULT_TEXT, content: 'Hej där' }, 'uicheck-cap')
     const words = [{ w: 'Hej', s: 0, e: 400000 }, { w: 'där', s: 400000, e: 900000 }]
     const style = { font: look.font, size: 72, color: '#FFFFFF', preset: 'Clean · sv · 72' }
     const lines = [{ startUs: 14000000, endUs: 15000000, text: 'Hej där', png: look.png, words }, { startUs: 15000000, endUs: 16500000, text: 'två', png: look.png }]
     const r = await window.studio.engine.call('captions.set', { lines, style })
     const id = r.clipIds[0]
     const el = await __t.until(() => __t.clipEl(id), 5000, 'the caption line')
     let s = await __t.snap()
     const cr = __t.rect(el); const top = __t.rect(__t.qa('.tl-row')[0])
     const seen = await dragSeen(el, clipOf(s, id).durationUs, cr.left + cr.width / 2, cr.top + cr.height / 2, cr.left + cr.width / 2 + 30, top.top - 8)
     if (seen.label !== 'New captions track') throw new Error('mid-drag: ' + JSON.stringify(seen))
     s = await __t.rev(s.revision)
     const t = trackOf(s, id), c = clipOf(s, id), v = visual(s)
     const said = (c.text.words ?? []).map((w) => w.w + ' ' + w.s + '-' + w.e).join(', ')
     if (t.role !== 'captions' || t.id === r.trackId || t !== v[v.length - 1] || !c.caption) throw new Error('it went to the ' + t.role + ' track at ' + s.project.tracks.indexOf(t) + ' (caption: ' + c.caption + ')')
     if (c.text.preset !== 'Clean · sv · 72' || c.text.content !== 'Hej där' || said !== 'Hej 0-400000, där 400000-900000') throw new Error('the line lost its text: ' + JSON.stringify(c.text))
     sameTime(c, seen)
     return { role: t.role, preset: c.text.preset, words: said, startS: +(c.startUs / 1e6).toFixed(2) }`,
  )
  await step(
    "Drag: a text clip's and a caption line's edges trim their length",
    `${dragKit}
     __t.key('Escape')
     const a = await addText(18000000, 'Trim me')
     let s = await __t.snap()
     const line = s.project.tracks.filter((t) => t.role === 'captions').flatMap((t) => t.clips).find((c) => c.text?.content === 'två')
     if (!line) throw new Error('no caption line to trim')
     const out = {}
     const trim = async (name, id, side, dx) => {
       const before = clipOf(s, id)
       const edge = __t.clipEl(id).querySelector('.clip-edge.' + side); const r = __t.rect(edge)
       await __t.drag(edge, r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + dx, r.top + r.height / 2)
       s = await __t.rev(s.revision, 'the ' + name + ' trim')
       // The next drag starts from what the timeline shows, so it waits for the timeline to have it.
       await __t.until(() => window.__studio.getState().snap?.revision >= s.revision, 3000, 'the timeline to show the ' + name + ' trim')
       const after = clipOf(s, id)
       out[name] = [+(before.durationUs / 1e6).toFixed(2), +(after.durationUs / 1e6).toFixed(2)]
       return [before, after]
     }
     let [b, c] = await trim('text, right edge in', a.clipId, 'right', -24)
     if (!(c.durationUs < b.durationUs) || c.startUs !== b.startUs) throw new Error('text right edge: ' + JSON.stringify(out))
     ;[b, c] = await trim('text, left edge out', a.clipId, 'left', -24)
     if (!(c.durationUs > b.durationUs && c.startUs < b.startUs) || c.startUs + c.durationUs !== b.startUs + b.durationUs) throw new Error('text left edge: ' + JSON.stringify(out))
     ;[b, c] = await trim('caption, right edge in', line.id, 'right', -12)
     if (!(c.durationUs < b.durationUs) || c.startUs !== b.startUs || !c.caption) throw new Error('caption right edge: ' + JSON.stringify(out))
     return out`,
  )
  await step(
    'Drag: "Add text" dragged from the library lands on a new text track on top, where its ghost showed',
    `${dragKit}
     __t.key('Escape')
     ${cat('Text')}
     let s = await __t.snap()
     const had = new Set(s.project.tracks.flatMap((t) => t.clips.map((c) => c.id)))
     const tile = await __t.until(() => __t.q('.lib-add-drag[draggable="true"]'), 3000, 'the draggable Add text')
     const dt = new DataTransfer()
     tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
     const content = __t.q('.tl-content'), sc = __t.rect(__t.q('.tl-scroll')), top = __t.rect(__t.qa('.tl-row')[0])
     const x = sc.left + 120 + (sc.width - 120) * 0.4, y = top.top - 8
     for (let i = 0; i < 4; i++) { content.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x + i * 4, clientY: y, dataTransfer: dt })); await __t.sleep(40) }
     await __t.until(() => __t.q('.clip.ghost'), 2000, 'the ghost of the new text')
     const seen = ghostSeen(3000000)
     if (seen.label !== 'New text track') throw new Error('mid-drag: ' + JSON.stringify(seen))
     content.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x + 12, clientY: y, dataTransfer: dt }))
     tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
     s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.some((t) => t.clips.some((c) => !had.has(c.id) && c.text?.png)) && x }, 8000, 'the new text clip')
     const c = s.project.tracks.flatMap((t) => t.clips).find((k) => !had.has(k.id))
     const t = trackOf(s, c.id), v = visual(s)
     if (t.role !== 'text' || t !== v[v.length - 1]) throw new Error('it went to the ' + t.role + ' track at ' + s.project.tracks.indexOf(t))
     sameTime(c, seen)
     if (__t.q('.clip.ghost')) throw new Error('the ghost stayed after the drop')
     return { startS: +(c.startUs / 1e6).toFixed(2), ghostS: +(seen.atUs / 1e6).toFixed(2), selected: window.__studio.getState().selection.includes(c.id) }`,
  )
  await step(
    'Drag: zoomed in, a text clip or its edge held at the timeline edge scrolls it and keeps going',
    `${dragKit}
     __t.key('Escape')
     const a = await addText(500000, 'Edge'), b = await addText(500000, 'Scroll')
     const sc = __t.q('.tl-scroll'), content = __t.q('.tl-content'); const r = __t.rect(sc)
     // The whole length, then three notches in.
     __t.key('Z', { shiftKey: true })
     await __t.sleep(150)
     for (let i = 0; i < 3; i++) { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, altKey: true, bubbles: true, cancelable: true, clientX: r.left + 300 })); await __t.sleep(80) }
     sc.scrollLeft = 0
     await __t.sleep(150)
     if (sc.scrollWidth <= sc.clientWidth + 50) throw new Error('not zoomed in enough to scroll')
     const x = r.left + sc.clientWidth - 8
     // Down at (x0, y), over to the right edge, held there a while.
     const hold = async (el, x0, y) => {
       __t.pointer(el, 'pointerdown', x0, y)
       for (let i = 1; i <= 4; i++) { await __t.sleep(16); __t.pointer(content, 'pointermove', x0 + ((x - x0) * i) / 4, y) }
       await __t.sleep(600)
     }
     // a's right edge: the clip grows with the scroll, past where the pointer itself went.
     let s = await __t.snap()
     const before = clipOf(s, a.clipId); const ar = __t.rect(__t.clipEl(a.clipId)); const usPerPx = before.durationUs / (ar.width + 1)
     const edge = __t.clipEl(a.clipId).querySelector('.clip-edge.right'); const er = __t.rect(edge)
     if (er.right > x) throw new Error('the edge is off-screen at this zoom')
     await hold(edge, er.left + er.width / 2, er.top + er.height / 2)
     const trimScroll = sc.scrollLeft
     __t.pointer(content, 'pointerup', x, er.top + er.height / 2)
     s = await __t.rev(s.revision, 'the trim')
     await __t.until(() => window.__studio.getState().snap?.revision >= s.revision, 3000, 'the timeline to show the trim')
     const grew = clipOf(s, a.clipId).durationUs - before.durationUs, own = (x - (er.left + er.width / 2)) * usPerPx
     if (!(trimScroll > 0 && grew > own + 200000)) throw new Error('scrolled ' + trimScroll + ' px; the clip grew ' + (grew / 1e6).toFixed(2) + ' s, the pointer alone ' + (own / 1e6).toFixed(2) + ' s')
     // b itself: its ghost keeps going with the scroll, and it lands where the ghost was.
     sc.scrollLeft = 0
     await __t.sleep(150)
     const br = __t.rect(__t.clipEl(b.clipId))
     await hold(__t.clipEl(b.clipId), br.left + 10, br.top + br.height / 2)
     const seen = ghostSeen(clipOf(s, b.clipId).durationUs), moveScroll = sc.scrollLeft
     __t.pointer(content, 'pointerup', x, br.top + br.height / 2)
     s = await __t.rev(s.revision, 'the move')
     const moved = clipOf(s, b.clipId).startUs - 500000, pointer = (x - br.left - 10) * usPerPx
     if (!(moveScroll > 0 && moved > pointer + 200000)) throw new Error('scrolled ' + moveScroll + ' px; the clip moved ' + (moved / 1e6).toFixed(2) + ' s, the pointer alone ' + (pointer / 1e6).toFixed(2) + ' s')
     sameTime(clipOf(s, b.clipId), seen)
     if (trackOf(s, b.clipId).id !== b.trackId) throw new Error('it left its own row')
     // Back to the whole length for the steps after.
     __t.key('Z', { shiftKey: true })
     return { trimScrolledPx: trimScroll, grewS: +(grew / 1e6).toFixed(2), pointerS: +(own / 1e6).toFixed(2), moveScrolledPx: moveScroll, movedS: +(moved / 1e6).toFixed(2) }`,
  )
  await shot('17c-drag-anywhere')
  await step(
    'Edit: zoomed in, dragging the line to the edge scrolls the timeline and the line keeps going',
    `const sc = __t.q('.tl-scroll'); const r = __t.rect(sc)
     for (let i = 0; i < 6; i++) { sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, altKey: true, bubbles: true, cancelable: true, clientX: r.left + 300 })); await __t.sleep(80) }
     sc.scrollLeft = 0
     await __t.sleep(150)
     if (sc.scrollWidth <= sc.clientWidth + 50) throw new Error('not zoomed in enough to scroll')
     const ruler = __t.q('.tl-ruler'); const rr = __t.rect(ruler); const content = __t.q('.tl-content')
     __t.pointer(ruler, 'pointerdown', rr.left + 60, rr.top + 5)
     const x = r.left + sc.clientWidth - 8
     for (let i = 0; i < 4; i++) { await __t.sleep(16); __t.pointer(content, 'pointermove', x, rr.top + 5) }
     await __t.sleep(60)
     const p0 = window.__studio.getState().positionUs
     await __t.sleep(900)
     const p1 = window.__studio.getState().positionUs, scrolled = sc.scrollLeft
     __t.pointer(content, 'pointerup', x, rr.top + 5)
     if (!(scrolled > 0 && p1 > p0 + 200000)) throw new Error('scrolled ' + scrolled + ' px, line ' + (p0 / 1e6).toFixed(2) + ' → ' + (p1 / 1e6).toFixed(2) + ' s')
     // Back to the whole length for the steps after.
     __t.key('Z', { shiftKey: true })
     return { scrolledPx: scrolled, lineFromS: +(p0 / 1e6).toFixed(2), lineToS: +(p1 / 1e6).toFixed(2) }`,
  )
  await step(
    'Edit: with Preview on hover, hovering shows frames without moving the line, and Space plays from the line',
    `const eye = __t.q('button[aria-label="Preview on hover"]')
     if (eye.getAttribute('aria-pressed') !== 'true') eye.click()
     await __t.sleep(150)
     const ruler = __t.q('.tl-ruler'); const r = __t.rect(ruler)
     __t.pointer(ruler, 'pointerdown', r.left + r.width * 0.5, r.top + 5)
     __t.pointer(ruler, 'pointerup', r.left + r.width * 0.5, r.top + 5)
     const line = await __t.until(() => { const p = window.__studio.getState().positionUs; return p > 0 && p }, 3000, 'the line')
     const content = __t.q('.tl-content'); const lane = __t.rect(__t.q('.tl-row.kind-main'))
     for (let i = 0; i < 6; i++) {
       content.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * (0.15 + i * 0.01), clientY: lane.top + lane.height / 2, pointerId: 1, pointerType: 'mouse' }))
       await __t.sleep(60)
     }
     await __t.sleep(500)
     const shown = (await window.studio.engine.call('playback.status')).positionUs
     const still = window.__studio.getState().positionUs
     if (Math.abs(still - line) > 1000) throw new Error('hovering moved the line from ' + (line / 1e6).toFixed(2) + ' to ' + (still / 1e6).toFixed(2) + ' s')
     __t.key(' ', { code: 'Space' })
     await __t.until(() => window.__studio.getState().playing, 6000, 'playing')
     await __t.sleep(600)
     const at = (await window.studio.engine.call('playback.status')).positionUs
     __t.key(' ', { code: 'Space' })
     await __t.until(() => !window.__studio.getState().playing, 4000, 'paused')
     eye.click()
     if (at < line) throw new Error('Space played from ' + (at / 1e6).toFixed(2) + ' s, before the line at ' + (line / 1e6).toFixed(2) + ' s')
     return { lineS: +(line / 1e6).toFixed(2), hoverShowedS: +(shown / 1e6).toFixed(2), playingAtS: +(at / 1e6).toFixed(2) }`,
  )

  // Captions from the transcript server (a real job there): a spoken voiceover with its
  // script beside it, as one made in the Audio tab keeps, split in two with a gap between the
  // halves. The words must land on each half's own time, and the misheard brand name must
  // come back as the script spells it.
  await step(
    'Playback stops at the end of the timeline, and with Loop playback (∞) on it starts again from the start',
    `const s = await __t.snap(); const end = s.durationUs
     __t.key('Escape'); await __t.sleep(100)
     for (const t of s.project.tracks) for (const c of t.clips) if (c.mediaId) await window.studio.engine.call('clip.set', { clipId: c.id, volume: 0 })
     await window.studio.engine.call('playback.seek', { positionUs: end - 600000 })
     await window.studio.engine.call('playback.play', { fromUs: end - 600000 })
     await __t.until(() => window.__studio.getState().playing, 5000, 'playing')
     const stopped = await __t.until(() => { const x = window.__studio.getState(); return !x.playing && x }, 6000, 'playback to stop at the end')
     await __t.sleep(600)
     const after = window.__studio.getState()
     if (after.playing || after.positionUs > end) throw new Error('the playhead is at ' + after.positionUs + ' of ' + end + (after.playing ? ', still playing' : ''))
     const loop = __t.q('button[aria-label^="Loop playback"]')
     if (!loop || loop.getAttribute('aria-pressed') !== 'false') throw new Error('no Loop playback button, or it starts on')
     loop.click()
     await window.studio.engine.call('playback.play', { fromUs: end - 600000 })
     const round = await __t.until(() => { const x = window.__studio.getState(); return x.playing && x.positionUs < 1500000 && x.positionUs }, 8000, 'playback to come round to the start')
     await window.studio.engine.call('playback.pause')
     loop.click()
     return { endS: +(end / 1e6).toFixed(2), stoppedAtS: +(stopped.positionUs / 1e6).toFixed(2), loopedToS: +(round / 1e6).toFixed(2) }`,
  )
  await step(
    'Captions: Words per caption splits lines made before Studio kept word times, at once, from times shared out by length',
    `const before = (await __t.snap()).project.tracks.length
     const r = await window.studio.engine.call('captions.set', { lines: [{ startUs: 0, endUs: 1100000, text: 'Hej där du' }, { startUs: 1100000, endUs: 2700000, text: 'Vi ses snart igen' }], style: { font: 'Metropolis', size: 60, weight: 600, color: '#FFFFFF', align: 'center', lineHeight: 1.2, letterSpacing: 0, case: 'none', preset: 'Clean · xx · 72' } })
     await __t.until(async () => (await __t.snap()).project.tracks.length > before, 5000, 'the old-style captions track')
     __t.click(__t.clipEl(r.clipIds[0]))
     const tab = await __t.until(() => [...__t.qa('.insp-tabs button')].find((x) => x.textContent === 'Captions'), 5000, 'the Captions tab')
     tab.click()
     const wpc = await __t.until(() => __t.q('input[aria-label="Words per caption"]'), 5000, 'Words per caption')
     if (!__t.qa('.lib-note, .insp-note, p').some((n) => /shared out over each line/.test(n.textContent))) throw new Error('no note that the times are estimated')
     wpc.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
     await __t.sleep(50)
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(wpc, '1')
     wpc.dispatchEvent(new Event('input', { bubbles: true }))
     const t0 = performance.now()
     wpc.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
     const lines = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === r.trackId); return t && t.clips.length === 7 && [...t.clips].sort((a, b) => a.startUs - b.startUs) }, 5000, 'seven one-word lines')
     const ms = Math.round(performance.now() - t0)
     await __t.until(() => __t.qa('.cap-lines li').length >= 7, 3000, 'the list to show the seven lines')
     const drawn = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === r.trackId); return t.clips.every((c) => c.text.png) && t.clips.length }, 15000, 'every line drawn after')
     // "Hej där du": 11 letters and spaces over 1.1 s, so "där" starts at 0.4 s.
     if (lines[1].text.content !== 'där' || Math.abs(lines[1].startUs - 400000) > 20000) throw new Error('the second line is ' + lines[1].text.content + ' at ' + lines[1].startUs)
     if (!lines.every((c) => c.text.words?.length === 1)) throw new Error('the new lines kept no word times')
     // Delete at the end of "Hej" brings "där" up into it, the times kept; typing goes on where it was.
     const line = (id) => __t.q('[data-line="' + id + '"]')
     await __t.until(() => line(lines[0].id), 3000, 'the first line in the list')
     line(lines[0].id).querySelector('.cap-text').click()
     const ed = await __t.until(() => __t.q('[data-line="' + lines[0].id + '"] input.cap-edit'), 3000, 'the line open for typing')
     ed.setSelectionRange(ed.value.length, ed.value.length)
     ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
     const six = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === r.trackId); return t && t.clips.length === 6 && [...t.clips].sort((a, b) => a.startUs - b.startUs) }, 8000, 'six lines after Delete')
     const j = six[0]
     if (j.text.content !== 'Hej där' || j.startUs !== lines[0].startUs || j.startUs + j.durationUs !== lines[1].startUs + lines[1].durationUs || j.text.words?.length !== 2) throw new Error('Delete made ' + JSON.stringify({ text: j.text.content, s: j.startUs, d: j.durationUs, words: j.text.words?.length }))
     const caret = await __t.until(() => { const el = __t.q('input.cap-edit'); return el && el.value === 'Hej där' && el.selectionStart }, 3000, 'the joined line open with the cursor where it was')
     if (caret !== 3) throw new Error('the cursor is at ' + caret)
     __t.q('input.cap-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
     // Words per caption is remembered: back to a sentence each for the steps after.
     wpc.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
     await __t.sleep(50)
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(wpc, '0')
     wpc.dispatchEvent(new Event('input', { bubbles: true }))
     wpc.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
     await __t.until(() => /sentence/i.test(wpc.value), 3000, 'Words per caption back to By sentence')
     await __t.sleep(300)
     await window.studio.engine.call('captions.set', { trackId: r.trackId, lines: [], style: {} })
     return { lines: lines.map((c) => c.text.content + '@' + (c.startUs / 1e6).toFixed(2)), linesAfterMs: ms, drawn, deleteJoined: j.text.content }`,
  )
  const speech = process.env.STUDIO_UI_CHECK_SPEECH
  if (speech) {
    await step(
      'Captions: the server transcribes a split voiceover and proofreads it against its script',
      `const r = await window.studio.engine.call('media.import', { paths: [${JSON.stringify(speech)}] })
       const mediaId = r.imported[0]
       let s = await __t.snap()
       await window.studio.engine.call('timeline.insertNewTrack', { mediaId, atUs: 1000000 })
       s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId)) && x }, 5000, 'the voiceover track')
       const track = s.project.tracks.find((t) => t.clips.some((c) => c.mediaId === mediaId))
       const first = track.clips[0]
       // Between "blanket." and "Charcoal", then the second half 2 s later.
       await window.studio.engine.call('timeline.split', { atUs: first.startUs + 3500000, clipIds: [first.id] })
       s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.find((t) => t.id === track.id).clips.length === 2 && x }, 5000, 'the split')
       const second = [...s.project.tracks.find((t) => t.id === track.id).clips].sort((a, b) => a.startUs - b.startUs)[1]
       await window.studio.engine.call('timeline.move', { clipId: second.id, startUs: second.startUs + 2000000, trackId: track.id })
       await __t.until(async () => (await __t.snap()).project.tracks.find((t) => t.id === track.id).clips.some((c) => c.startUs === second.startUs + 2000000), 5000, 'the move')
       ${cat('Captions')}
       const from = await __t.until(() => __t.q('select[aria-label="Made from"]'), 3000, 'the Made from list')
       from.value = track.id
       from.dispatchEvent(new Event('change', { bubbles: true }))
       const script = await __t.until(() => { const b = __t.q('button[aria-label^="Script:"]'); return b && /voiceover/.test(b.textContent) && b.textContent }, 5000, 'the voiceover script in the Script setting')
       const lang = __t.q('select[aria-label="Language"]')
       lang.value = 'en'
       lang.dispatchEvent(new Event('change', { bubbles: true }))
       await __t.sleep(100)
       const before = (await __t.snap()).project.tracks.filter((t) => t.role === 'captions').length
       ;[...__t.qa('.lib-add')].find((b) => /Make captions/.test(b.textContent)).click()
       await __t.until(() => __t.q('.lib-add.busy'), 3000, 'the button to show it is working')
       const caps = await __t.until(async () => { const x = await __t.snap(); const t = x.project.tracks.filter((y) => y.role === 'captions'); return t.length > before && t.find((y) => y.clips.some((c) => /Charcoal/.test(c.text?.content ?? ''))) }, 120000, 'the captions track')
       window.__capsId = caps.id
       const lines = [...caps.clips].sort((a, b) => a.startUs - b.startUs).map((c) => ({ at: +(c.startUs / 1e6).toFixed(2), text: c.text.content }))
       const all = lines.map((l) => l.text).join(' ')
       if (!/Quorvel/.test(all)) throw new Error('the made-up name was not proofread: ' + all)
       const charcoal = lines.find((l) => /^Charcoal/.test(l.text))
       // Source 3.9 s, on a clip that starts 1 s in and whose second half moved 2 s later.
       if (!charcoal || Math.abs(charcoal.at - 6.9) > 0.35) throw new Error('"Charcoal" is at ' + charcoal?.at + ' s, not about 6.9 s')
       const note = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /correction/.test(t)), 3000, 'the proofread note')
       // Words per caption, typed in: 1 makes every caption a single word, from the words already heard.
       const wpc = __t.q('input[aria-label="Words per caption"]')
       wpc.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
       await __t.sleep(50)
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(wpc, '1')
       wpc.dispatchEvent(new Event('input', { bubbles: true }))
       await __t.sleep(50)
       wpc.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
       const single = await __t.until(async () => { const x = (await __t.snap()).project.tracks.find((t) => t.id === caps.id); return x && x.clips.length > lines.length && x.clips.every((c) => !/\\s/.test((c.text?.content ?? '').trim())) && x.clips.length }, 30000, 'one word per caption')
       await __t.until(() => wpc.value === '1 per caption', 2000, 'the setting to read 1 per caption')
       return { lines, note, fixes: __t.qa('.lib-proof li').map((li) => li.textContent), script, oneWordCaptions: single }`,
    )
    await shot('18-captions')
    await step(
      'Captions: the Inspector lists the lines; Enter splits one at the cursor on the voice’s own timing, at a line’s end adds a line (a row above when there’s no room), and Apply to all restyles every line',
      `const caps = (await __t.snap()).project.tracks.find((t) => t.id === window.__capsId)
       // Back to a sentence each, from the times the lines keep.
       const wpc = await __t.until(() => __t.q('input[aria-label="Words per caption"]'), 5000, 'Words per caption')
       wpc.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
       await __t.sleep(50)
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(wpc, '0')
       wpc.dispatchEvent(new Event('input', { bubbles: true }))
       await __t.sleep(50)
       wpc.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
       const lineOf = async (re) => { const t = (await __t.snap()).project.tracks.find((x) => x.id === caps.id); return t && [...t.clips].sort((a, b) => a.startUs - b.startUs).find((c) => re.test(c.text.content)) }
       const first = await __t.until(async () => { const c = await lineOf(/^Meet Quorvel, the lamp/); return c && __t.q('[data-line="' + c.id + '"]') && c }, 15000, 'the first sentence back as one line')
       const n = (await __t.snap()).project.tracks.find((t) => t.id === caps.id).clips.length
       // One click in the line and it's an input; Enter after "Quorvel," splits it there.
       __t.q('[data-line="' + first.id + '"] .cap-text').click()
       const input = await __t.until(() => __t.q('input.cap-edit'), 3000, 'the line to open for typing')
       const at = input.value.indexOf(' the lamp')
       input.setSelectionRange(at, at)
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
       const two = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === caps.id); return t.clips.length === n + 1 && [...t.clips].sort((a, b) => a.startUs - b.startUs) }, 15000, 'two lines where there was one')
       const a = two.find((c) => c.text.content === 'Meet Quorvel,'), b = two.find((c) => /^the lamp/.test(c.text.content))
       if (!a || !b) throw new Error('the split lines are ' + two.map((c) => c.text.content).join(' | '))
       // "the" was heard 1.26 s into a clip that starts 1 s in: the second line starts with it.
       if (Math.abs(b.startUs / 1e6 - 2.26) > 0.3 || a.startUs + a.durationUs !== b.startUs) throw new Error('the second line starts at ' + (b.startUs / 1e6).toFixed(2) + ' s, the first ends at ' + ((a.startUs + a.durationUs) / 1e6).toFixed(2))
       if (!b.text.words?.length || b.text.words[0].w !== 'the') throw new Error('the second line kept no word times')
       // Enter at the end of "Meet Quorvel,": "the lamp…" starts right where it ends, so the new line goes on a row above.
       const rows = (await __t.snap()).project.tracks.filter((t) => t.role === 'captions').length
       await __t.until(() => __t.q('[data-line="' + a.id + '"]'), 5000, 'the first part in the list')
       __t.q('[data-line="' + a.id + '"] .cap-text').click()
       const ina = await __t.until(() => __t.q('[data-line="' + a.id + '"] input.cap-edit'), 3000, 'the first part open for typing')
       ina.setSelectionRange(ina.value.length, ina.value.length)
       ina.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
       const above = await __t.until(async () => { const x = (await __t.snap()).project.tracks.filter((t) => t.role === 'captions'); return x.length === rows + 1 && x.find((t) => t.clips.some((c) => c.startUs === a.startUs + a.durationUs && !c.text.content)) }, 15000, 'a new row with an empty line where the first part ends')
       const typed = await __t.until(() => { const el = __t.q('input.cap-edit'); return el && !el.value && el }, 5000, 'the new line open for typing')
       await __t.sleep(100)
       const focused = document.activeElement === typed
       typed.focus()
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(typed, 'Above it')
       typed.dispatchEvent(new Event('input', { bubbles: true }))
       // The hidden window has no focus to lose: leave the field the way React hears it.
       typed.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
       const row = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === above.id); return t?.clips[0]?.text.content === 'Above it' && t }, 15000, 'the words on the new row')
       const order = (await __t.snap()).project.tracks.map((t) => t.id)
       if (order.indexOf(row.id) !== order.indexOf(caps.id) + 1) throw new Error('the new row isn’t just above the captions')
       await __t.until(() => __t.q('[data-line="' + row.clips[0].id + '"]'), 5000, 'the new row’s line in the list')
       // Text tab: a change goes to All lines; the Box preset style restyles every line.
       // The new line is selected once the store has it (a moment after the engine).
       const tab = (name) => __t.until(() => [...__t.qa('.insp-tabs button')].find((x) => x.textContent === name), 5000, 'the Inspector’s ' + name + ' tab')
       ;(await tab('Text')).click()
       const all = await __t.until(() => __t.q('.insp-scope button[aria-pressed="true"]'), 3000, 'the All lines / This line choice')
       if (all.textContent !== 'All lines') throw new Error('a change goes to ' + all.textContent)
       ;(await __t.until(() => __t.q('button[aria-label="White on black style"]'), 3000, 'the White on black preset')).click()
       const boxed = await __t.until(async () => { const t = (await __t.snap()).project.tracks.filter((x) => x.id === caps.id || x.id === row.id).flatMap((x) => x.clips); return t.every((c) => c.text.background?.color === '#000000' && c.text.color === '#FFFFFF') && t.length }, 20000, 'every line on both rows in white on black')
       // Moved on the video with Apply to all on: every line goes there, and stays there when the look changes again.
       const lines = async () => (await __t.snap()).project.tracks.filter((x) => x.id === caps.id || x.id === row.id).flatMap((x) => x.clips)
       const one = [...(await lines())].sort((x, y) => x.startUs - y.startUs)[0]
       if (__t.q('.safe-button')?.getAttribute('aria-pressed') === 'true') __t.q('.safe-button').click()
       __t.click(__t.clipEl(one.id))
       await window.studio.engine.call('playback.seek', { positionUs: one.startUs + 100000 })
       const ph = await __t.until(() => __t.q('.ph-box'), 5000, 'the caption’s box on the video')
       const stage = __t.q('.ph-stage'), sr = __t.rect(stage), pb = __t.rect(ph)
       const pd = (type, x, y) => __t.pointer(stage, type, x, y)
       const k = sr.width / (await __t.snap()).project.width
       const [x0, y0] = [pb.left + pb.width / 2, pb.top + pb.height / 2]
       pd('pointerdown', x0, y0)
       for (let i = 1; i <= 6; i++) { await __t.sleep(16); pd('pointermove', x0, y0 - 10 * i) }
       pd('pointerup', x0, y0 - 60)
       const up = await __t.until(async () => { const t = await lines(); return t.every((c) => Math.abs(c.posY + 60 / k) < 3) && t.length }, 8000, 'every line moved up with the one dragged')
       ;(await __t.until(() => __t.q('button[aria-label="Black on white style"]'), 3000, 'the Black on white preset')).click()
       const kept = await __t.until(async () => { const t = await lines(); return t.every((c) => c.text.background?.color === '#FFFFFF') && t.every((c) => Math.abs(c.posY + 60 / k) < 3) && t.length }, 20000, 'the lines restyled where they were moved to')
       ;(await tab('Captions')).click()
       return { split: [a.text.content, b.text.content], secondStartsS: +(b.startUs / 1e6).toFixed(2), rowAbove: row.clips[0].text.content, newLineHadFocus: focused, boxedLines: boxed, movedLines: up, keptAfterRestyle: kept }`,
    )
    await shot('18b-captions-inspector')
  } else console.log('[ui-check] skip Captions from the server: no spoken voiceover, or the transcript server not reachable')
  // On the stand-in transcript server (offline runs), whose check against the script fails the
  // way the real one does when its AI account is out of credits: the words still make captions.
  if (process.env.STUDIO_UI_CHECK_TRANSCRIPT_STANDIN === '1') {
    const scripted = path.join(path.dirname(exportDir), 'scripted-voiceover.wav')
    fs.writeFileSync(scripted.replace(/\.wav$/, '.script.txt'), 'Order yours today at Quorvel.\n')
    await step(
      'Captions: when the server can’t check the words against the script (its AI out of credits), the captions still come, as heard, and the note says why',
      `const r = await window.studio.engine.call('media.import', { paths: [${JSON.stringify(scripted)}] })
       const mediaId = r.imported[0]
       await window.studio.engine.call('timeline.insertNewTrack', { mediaId, atUs: 0 })
       const s = await __t.until(async () => { const x = await __t.snap(); return x.project.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId)) && x }, 5000, 'the voiceover track')
       const track = s.project.tracks.find((t) => t.clips.some((c) => c.mediaId === mediaId))
       ${cat('Captions')}
       const from = await __t.until(() => __t.q('select[aria-label="Made from"]'), 3000, 'the Made from list')
       from.value = track.id
       from.dispatchEvent(new Event('change', { bubbles: true }))
       await __t.until(() => { const b = __t.q('button[aria-label^="Script:"]'); return b && /voiceover/.test(b.textContent) }, 5000, 'the voiceover script in the Script setting')
       const lang = __t.q('select[aria-label="Language"]')
       lang.value = 'en'
       lang.dispatchEvent(new Event('change', { bubbles: true }))
       await __t.sleep(100)
       const before = (await __t.snap()).project.tracks.filter((t) => t.role === 'captions').map((t) => t.id)
       ;[...__t.qa('.lib-add')].find((b) => /Make captions/.test(b.textContent)).click()
       const caps = await __t.until(async () => (await __t.snap()).project.tracks.find((t) => t.role === 'captions' && !before.includes(t.id) && t.clips.length), 30000, 'the captions track')
       const all = [...caps.clips].sort((a, b) => a.startUs - b.startUs).map((c) => c.text.content).join(' ')
       if (!/today at corvel/.test(all) || /Quorvel/.test(all)) throw new Error('not the words as heard: ' + all)
       const note = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /Not checked against the script/.test(t)), 3000, 'the note that it was not checked')
       if (!/no credits/.test(note)) throw new Error('the note: ' + note)
       await window.studio.engine.call('captions.set', { trackId: caps.id, lines: [], style: {} })
       await window.studio.engine.call('timeline.delete', { clipIds: track.clips.map((c) => c.id) })
       return { captions: all, note }`,
    )
  } else console.log('[ui-check] skip Captions when the script check fails: only on the stand-in transcript server (STUDIO_UI_CHECK_ONLINE=0)')

  // Stems, on the stand-in (STUDIO_STEMS_FAKE=1: never the real server, so no AudioShake runs
  // and no hourly limit): the Stems tab on a sound clip, a separation's progress, the rows, ▶,
  // "Add to timeline", "Use only these" as one undo step, the server's refusal shown as it is, a
  // job picked up after a restart, and the files in the project folder.
  if (process.env.STUDIO_STEMS_FAKE === '1') {
    const wanted = (name: string) => !only || only.test(name)
    // The voiceover's clip (on a sound track), the Inspector's tabs, and a clip by id in a snapshot.
    const lib = `const tab = (name) => __t.qa('.insp-tabs button').find((b) => b.textContent.trim() === name)
       const vo = (s) => s.project.tracks.filter((t) => !t.main && t.kind === 'audio').flatMap((t) => t.clips).find((c) => s.project.media.find((m) => m.id === c.mediaId)?.name === 'voiceover.wav')
       const clipIn = (s, id) => s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
       const trackOf = (s, id) => s.project.tracks.findIndex((t) => t.clips.some((c) => c.id === id))
       const mediaOf = (s, c) => s.project.media.find((m) => m.id === c?.mediaId)
       const select = async (id) => { __t.click(__t.clipEl(id)); await __t.until(() => __t.clipEl(id)?.classList.contains('selected'), 3000, 'the clip selected') }
       const row = (name) => __t.q('.inspector .stem-row[data-stem="' + name + '"]')`
    await step(
      'Stems: the tab shows for a sound clip, not for a picture-only clip',
      `${lib}
       __t.key('Escape')
       let s = await __t.snap()
       const c = vo(s)
       if (!c) throw new Error('no voiceover clip on a sound track')
       window.__st = { dir: s.dir, clipId: c.id }
       await select(c.id)
       const soundTabs = __t.qa('.insp-tabs button').map((b) => b.textContent.trim())
       if (!soundTabs.includes('Stems')) throw new Error('a sound clip has ' + soundTabs.join(', '))
       // A picture: the app's own icon, at the end of the main track.
       const r = await window.studio.engine.call('media.import', { paths: [${JSON.stringify(path.join(__dirname, '..', 'assets', 'icon.png'))}] })
       const ins = await window.studio.engine.call('timeline.insert', { mediaId: r.imported[0] })
       s = await __t.snap()
       const pic = s.project.tracks.find((t) => t.main).clips.find((x) => x.mediaId === r.imported[0])
       await __t.until(() => __t.clipEl(pic.id), 3000, 'the picture on the timeline')
       await select(pic.id)
       await __t.until(() => tab('Video'), 2000, 'its tabs')
       const picTabs = __t.qa('.insp-tabs button').map((b) => b.textContent.trim())
       if (picTabs.includes('Stems')) throw new Error('a picture has ' + picTabs.join(', '))
       await window.studio.engine.call('timeline.delete', { clipIds: [pic.id] })
       return { sound: soundTabs, picture: picTabs }`,
    )
    await step(
      'Stems: before separating, the tab says what it does and how long it takes, with one button',
      `${lib}
       const { clipId } = window.__st
       __t.key('Escape')
       await select(clipId)
       ;(await __t.until(() => tab('Stems'), 2000, 'the Stems tab')).click()
       const intro = (await __t.until(() => __t.qa('.inspector .insp-note').find((n) => /usually takes/.test(n.textContent)), 2000, 'what it does and how long it takes')).textContent
       const buttons = __t.qa('.inspector .insp-body button').map((b) => b.textContent)
       if (buttons.join() !== 'Separate into stems') throw new Error('buttons: ' + buttons.join(', '))
       return intro`,
    )
    await shot('20a-stems-start')
    await step(
      'Stems: separating shows its progress (sending, waiting, separating), carries on while something else is selected, then a row per stem with sound',
      `${lib}
       const { clipId } = window.__st
       if (!__t.q('.inspector .stems-go')) {
         await select(clipId)
         ;(await __t.until(() => tab('Stems'), 2000, 'the Stems tab')).click()
       }
       ;(await __t.until(() => __t.q('.inspector .stems-go:not(:disabled)'), 2000, 'Separate into stems')).click()
       const seen = new Set()
       let away = false
       const t0 = Date.now()
       while (!row('vocals') && Date.now() - t0 < 30000) {
         const t = __t.q('.inspector .stems-stage')?.textContent ?? ''
         if (/Sending the sound to the server/.test(t)) seen.add('sending')
         if (/Waiting at the server|The server has the sound/.test(t)) seen.add('waiting')
         if (/Separating with AudioShake|reading the sound/.test(t)) seen.add('separating')
         if (/Bringing the stems back/.test(t)) seen.add('downloading')
         if (/\\d+ %/.test(t)) seen.add('percent')
         if (__t.qa('.task-pill').some((p) => /Stems of voiceover/.test(p.textContent))) seen.add('title bar')
         // Selecting something else and coming back: still going.
         if (seen.has('separating') && !away) {
           away = true
           __t.key('Escape')
           await __t.until(() => !__t.q('.inspector .stems-stage'), 2000, 'the Inspector to leave the clip')
           await __t.sleep(600)
           await select(clipId)
           await __t.until(() => __t.q('.inspector .stems-stage') || row('vocals'), 2000, 'the separation, still going')
         }
         await __t.sleep(40)
       }
       for (const k of ['sending', 'waiting', 'separating', 'percent']) if (!seen.has(k)) throw new Error('never showed ' + k + ': saw ' + [...seen].join(', '))
       const rows = __t.qa('.inspector .stem-row').map((r) => r.dataset.stem)
       const silent = __t.q('.inspector .stems-silent')?.textContent ?? ''
       if (!rows.includes('vocals') || !rows.includes('instrumental')) throw new Error('rows: ' + rows.join(', '))
       if (rows.includes('piano') || rows.includes('strings')) throw new Error('silent stems shown as rows: ' + rows.join(', '))
       if (!/2 silent: Piano, Strings/.test(silent)) throw new Error('the silent line says ' + silent)
       const order = ['vocals', 'instrumental', 'drums', 'bass'].filter((n) => rows.includes(n))
       if (rows.join() !== order.join()) throw new Error('not in the server’s order: ' + rows.join(', '))
       const wave = row('vocals').querySelector('.stem-wave path').getAttribute('d').length
       if (wave < 200) throw new Error('no waveform')
       return { seen: [...seen], rows, levels: __t.qa('.inspector .stem-level').map((e) => e.textContent), silent }`,
    )
    await shot('20-stems')
    await step(
      'Stems: the song the server named shows above the stems, with where in the clip it was heard',
      `const song = await __t.until(() => __t.q('.stems-song'), 5000, 'the song')
       const title = song.querySelector('strong')?.textContent, artist = song.querySelector('.stems-song-text span')?.textContent
       const lines = [...song.querySelectorAll('small')].map((x) => x.textContent)
       if (title !== 'Stand-in Song' || artist !== 'Studio Test Mode') throw new Error('the song shows as ' + title + ' by ' + artist)
       if (!lines.some((l) => /Never Released · 2026 · Pop/.test(l)) || !lines.some((l) => /into the clip, 0:42 into the song/.test(l))) throw new Error('its lines are ' + lines.join(' | '))
       return { title, artist, lines }`,
    )
    await step(
      'Stems: ▶ plays a stem on its own in the player, and again pauses it',
      `${lib}
       const { clipId } = window.__st
       row('vocals').querySelector('.stem-play').click()
       await __t.until(() => __t.q('.player-source'), 5000, 'the preview bar')
       await __t.until(async () => (await window.studio.engine.call('playback.status')).context === 'source', 3000, 'the engine previewing')
       await __t.until(() => window.__studio.getState().source?.playing, 5000, 'the stem to play')
       const s = await __t.snap()
       const m = s.project.media.find((x) => x.id === window.__studio.getState().source.mediaId)
       if (!/\\(Vocals\\)\\.mp3$/.test(m?.path ?? '')) throw new Error('it played ' + m?.path)
       await __t.until(() => row('vocals').classList.contains('playing') && row('vocals').querySelector('.stem-wave line'), 3000, 'its place on the waveform')
       const label = row('vocals').querySelector('.stem-play').getAttribute('aria-label')
       row('vocals').querySelector('.stem-play').click()
       await __t.until(() => !window.__studio.getState().source?.playing, 3000, 'the preview to pause')
       // Back to the timeline, the clip selected again.
       const el = __t.q('.tl-content'), c = __t.rect(el), rows = __t.rect(__t.q('.tl-rows'))
       __t.pointer(el, 'pointerdown', c.left + 200, rows.top - 6); __t.pointer(el, 'pointerup', c.left + 200, rows.top - 6)
       await __t.until(() => !__t.q('.player-source'), 2000, 'the preview bar to go')
       await select(clipId)
       ;(await __t.until(() => tab('Stems'), 2000, 'the Stems tab')).click()
       await __t.until(() => row('vocals'), 2000, 'the rows')
       return { previewed: __t.q('.player-source strong')?.textContent ?? m.name, whilePlaying: label, inLibrary: m.name }`,
    )
    await step(
      'Stems: + puts a stem on a new sound track right under the clip, in sync',
      `${lib}
       const { clipId } = window.__st
       const before = await __t.snap()
       const c = clipIn(before, clipId)
       row('instrumental').querySelector('.stem-add').click()
       const s = await __t.until(async () => { const s = await __t.snap(); return s.project.tracks.length > before.project.tracks.length && s }, 8000, 'a new track')
       const ti = trackOf(s, clipId)
       const under = s.project.tracks[ti + 1]
       const x = under?.clips[0]
       if (!under || under.kind !== 'audio' || under.clips.length !== 1 || !/\\(Instrumental\\)\\.mp3$/.test(mediaOf(s, x)?.path ?? '')) throw new Error('under the clip: ' + JSON.stringify(under))
       if (x.startUs !== c.startUs || x.inUs !== 0 || Math.abs(x.durationUs - c.durationUs) > 50000 || (x.speed ?? 1) !== (c.speed ?? 1)) throw new Error('not in sync: ' + JSON.stringify({ clip: [c.startUs, c.inUs, c.durationUs], stem: [x.startUs, x.inUs, x.durationUs] }))
       if (clipIn(s, clipId).detached) throw new Error('adding muted the clip')
       await __t.until(() => __t.clipEl(x.id), 3000, 'the stem on the timeline')
       const toast = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => /under the clip, in sync/.test(t)), 3000, 'the toast')
       return { track: ti + 1, startS: x.startUs / 1e6, durationS: +(x.durationUs / 1e6).toFixed(3), role: under.role, toast }`,
    )
    await step(
      'Stems: "Use only these" mutes the clip and puts the ticked stems under it in sync, as one undo step',
      `${lib}
       const { clipId } = window.__st
       const before = await __t.snap()
       const c = clipIn(before, clipId)
       for (const n of ['vocals', 'bass']) row(n).querySelector('.stem-pick').click()
       const btn = await __t.until(() => __t.q('.inspector .stems-only:not(:disabled)'), 2000, 'Use only these')
       if (!/\\(2\\)/.test(btn.textContent)) throw new Error('the button says ' + btn.textContent)
       btn.click()
       let s = await __t.until(async () => { const s = await __t.snap(); return clipIn(s, clipId)?.detached && s }, 8000, 'the clip muted')
       const ti = trackOf(s, clipId)
       const got = [1, 2].map((k) => { const t = s.project.tracks[ti + k]; const x = t?.clips[0]; return { kind: t?.kind, name: mediaOf(s, x)?.name, x } })
       if (!/\\(Vocals\\)/.test(got[0].name) || !/\\(Bass\\)/.test(got[1].name) || got.some((g) => g.kind !== 'audio')) throw new Error('under the clip: ' + got.map((g) => g.name).join(', '))
       for (const g of got) if (g.x.startUs !== c.startUs || Math.abs(g.x.durationUs - c.durationUs) > 50000) throw new Error(g.name + ' is not in sync')
       const off = (await __t.until(() => __t.q('.inspector .stems-off'), 2000, 'the note that its own sound is off')).textContent
       const toast = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => /now plays only Vocals and Bass/.test(t)), 3000, 'the toast')
       // One Ctrl+Z takes all of it back, and Ctrl+Shift+Z brings it again.
       __t.key('z', { ctrlKey: true })
       s = await __t.rev(s.revision)
       if (clipIn(s, clipId).detached || s.project.tracks.length !== before.project.tracks.length) throw new Error('one undo left ' + (s.project.tracks.length - before.project.tracks.length) + ' tracks, muted: ' + clipIn(s, clipId).detached)
       __t.key('z', { ctrlKey: true, shiftKey: true })
       s = await __t.rev(s.revision)
       if (!clipIn(s, clipId).detached) throw new Error('redo did not mute it again')
       return { under: got.map((g) => g.name), off, toast, history: s.project.tracks.length }`,
    )
    await shot('20b-stems-used')
    const refused = 'Stems: a send the server refuses (429) shows its message as it is'
    const hourly = 'That is the hourly limit for this address. Try again later.'
    if (wanted(refused)) stemsTest.failNext(hourly)
    await step(
      refused,
      `${lib}
       ;(await __t.until(() => __t.q('.inspector .stems-again'), 2000, 'Separate again')).click()
       const err = (await __t.until(() => __t.q('.inspector .stems-error'), 8000, 'the reason')).textContent
       if (!err.includes(${JSON.stringify(hourly)})) throw new Error('it says ' + err)
       const toast = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => t.includes(${JSON.stringify(hourly)})), 3000, 'the toast')
       if (!row('vocals')) throw new Error('the stems it had are gone')
       return { inTab: err, toast }`,
    )
    const restart = 'Stems: Studio restarting mid-separation (1/2): it is separating'
    await step(
      restart,
      `${lib}
       ;(await __t.until(() => __t.q('.inspector .stems-again'), 2000, 'Separate again')).click()
       const j = await __t.until(() => Object.values(window.__studio.getState().stemsJobs).find((j) => j.state === 'separating'), 10000, 'The server separating it')
       if (__t.q('.inspector .stems-error')) throw new Error('the failed try is still shown')
       window.__st.restartDir = j.dir
       return j.stage`,
    )
    await shot('20c-stems-running')
    // As if the app quit and started again: the main process forgets every job, and reads them back when the project is listed.
    if (wanted(restart)) stemsTest.restart()
    await step(
      'Stems: Studio restarting mid-separation (2/2): the job picks up from job.json and finishes',
      `${lib}
       const { dir, restartDir } = window.__st
       const back = (await window.studio.services.stemsJobs(dir)).find((j) => j.dir === restartDir)
       if (!back) throw new Error('job.json was not read back')
       const done = await __t.until(async () => (await window.studio.services.stemsJobs(dir)).find((j) => j.dir === restartDir && j.state === 'done'), 30000, 'the job, read back from disk, to finish')
       await __t.until(() => row('vocals') && !__t.q('.inspector .stems-stage'), 5000, 'the rows again')
       return { readBackAs: back.state, stems: done.stems.length, heard: done.stems.filter((x) => !x.silent).length }`,
    )
    await step(
      'Stems: the stems are in the project folder, each with job.json, and nothing else is left there',
      `const { dir } = window.__st
       const jobs = (await window.studio.services.stemsJobs(dir)).filter((j) => j.state === 'done')
       if (!jobs.length) throw new Error('no separations')
       const sep = dir.includes('\\\\') ? '\\\\' : '/'
       const root = dir + sep + 'stems' + sep
       for (const j of jobs) {
         if (!j.dir.startsWith(root)) throw new Error(j.dir + ' is outside ' + root)
         const files = [...j.stems.map((x) => x.path), j.dir + sep + 'job.json']
         const there = await window.studio.app.existing(files)
         if (!there.every(Boolean)) throw new Error('missing: ' + files.filter((_, i) => !there[i]).join(', '))
         const parts = await window.studio.app.existing([j.dir + sep + 'part.wav', j.dir + sep + 'part.mp3'])
         if (parts.some(Boolean)) throw new Error('the part sent is still in ' + j.dir)
         if (!j.stems.every((x) => x.path.startsWith(j.dir + sep))) throw new Error('a stem outside its folder')
       }
       return { folders: jobs.map((j) => j.dir.slice(root.length)), files: jobs[0].stems.map((x) => x.path.split(/[\\\\/]/).pop()) }`,
    )
  } else console.log('[ui-check] skip Stems: set STUDIO_STEMS_FAKE=1 (the stand-in; the real server is never called from tests)')

  // Text removal with Vmake, on the stand-in (STUDIO_VMAKE_FAKE=1: never the real Vmake, no
  // credits). The busy clip greyed out with its progress and kept from every edit, the result
  // applied, and jobs that outlive their project and the app. Last, as they open other projects.
  if (process.env.STUDIO_VMAKE_FAKE === '1') {
    const wanted = (name: string) => !only || only.test(name)
    // A video clip on the main track not cleaned already, then the job's clip by its id.
    const pick = `const video = (s, c) => { const m = s.project.media.find((x) => x.id === c.mediaId); return m?.kind === 'video' && !/\\(no text\\)/.test(m.name) }`
    const working = (clip: string) => `await __t.until(() => Object.values(window.__studio.getState().vmakeJobs).some((j) => j.clipId === ${clip} && j.state === 'working'), 15000, 'Vmake working on it')`
    await step(
      'Vmake: Remove text opens with every model, its price and the button ready at once',
      `__t.key('Escape')
       await window.studio.services.setKey('vmake', 'ui-check stand-in')
       let s = await __t.snap()
       ${pick}
       const c = __t.main(s).find((x) => video(s, x))
       __t.click(__t.clipEl(c.id))
       const el = __t.clipEl(c.id), r = __t.rect(el)
       el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
       ;(await __t.until(() => [...__t.qa('.context-menu button')].find((b) => b.textContent.startsWith('Remove text with Vmake')), 2000, 'the menu')).click()
       // The models are there to pick and Remove text works within moments (the token was
       // saved behind the window's back here, so it's read again as it opens).
       await __t.until(() => __t.q('.modal h2'), 2000, 'the window')
       await __t.until(() => __t.qa('.modal .choice-list button').length >= 5 && !__t.q('.modal footer .button.primary').disabled, 500, 'the models and Remove text ready')
       const models = __t.qa('.modal .choice-list button .choice-name').map((n) => n.textContent)
       const ready = true
       __t.key('Escape')
       await window.studio.services.clearKey('vmake')
       return { models, ready }`,
    )
    await step(
      'Vmake: starting text removal greys the clip and labels it with its progress',
      `__t.key('Escape')
       let s = await __t.snap()
       const main = s.project.tracks.find((t) => t.main)
       if (main.locked) await window.studio.engine.call('track.set', { trackId: main.id, locked: false })
       ${pick}
       const c = __t.main(s).find((x) => video(s, x))
       if (!c) throw new Error('no video clip on the main track')
       // A change to it first, so Ctrl+Z would change it while it's busy.
       await window.studio.engine.call('clip.set', { clipId: c.id, opacity: 95 })
       window.__vm = { dir: s.dir, clipId: c.id }
       await window.__studio.removeText({ mediaId: c.mediaId, clipId: c.id }, 'full')
       const el = await __t.until(() => { const e = __t.clipEl(c.id); return e?.classList.contains('busy') && e }, 5000, 'the clip to go grey')
       // While Vmake works: the time left, and a percentage rising with the clock.
       const label = () => __t.clipEl(c.id)?.querySelector('.clip-busy')?.textContent ?? ''
       const first = await __t.until(() => / left/.test(label()) && /\\d+ %/.test(label()) && label(), 10000, 'the time left on the clip')
       const p0 = Number(/(\\d+) %/.exec(first)[1])
       const later = await __t.until(() => { const t = label(); const m = /(\\d+) %/.exec(t); return / left/.test(t) && m && Number(m[1]) > p0 && t }, 8000, 'the percentage to rise while Vmake works')
       s = await __t.snap()
       const busy = __t.main(s).find((x) => x.id === c.id).busy
       if (!busy) throw new Error('no busy mark on it in the engine')
       return { label: first, later, busy, grey: getComputedStyle(el.querySelector('.filmstrip')).filter, titleBar: __t.q('.task-pill')?.textContent }`,
    )
    await shot('12b-vmake-busy')
    await step(
      'Vmake: a busy clip can’t be dragged, deleted, split, undone, edited over MCP or moved on the video; its menu only cancels and the Inspector shows it busy',
      `const { clipId } = window.__vm
       const before = await __t.snap()
       const c0 = __t.main(before).find((x) => x.id === clipId)
       const order = __t.main(before).map((x) => x.id).join()
       let el = __t.clipEl(clipId), r = __t.rect(el)
       await __t.drag(el, r.left + r.width / 2, r.top + 20, r.left + r.width / 2 + 240, r.top + 20)
       await __t.sleep(300)
       el = __t.clipEl(clipId); r = __t.rect(el)
       el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
       await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
       const menu = __t.qa('.context-menu button').map((b) => b.textContent)
       __t.key('Escape')
       await __t.until(() => !__t.q('.context-menu'), 2000, 'the menu to close')
       __t.click(__t.clipEl(clipId))
       await __t.until(() => __t.clipEl(clipId).classList.contains('selected'), 2000, 'the clip selected')
       __t.key('Delete')
       __t.key('b', { ctrlKey: true })
       __t.key('z', { ctrlKey: true })
       await __t.sleep(400)
       const edges = [...__t.clipEl(clipId).querySelectorAll('.clip-edge')].filter((e) => getComputedStyle(e).display !== 'none').length
       const inspector = await __t.until(() => __t.q('.inspector .insp-busy-clip')?.textContent, 3000, 'the Inspector showing it busy')
       const cancel = __t.qa('.inspector button').some((b) => b.textContent === 'Cancel text removal')
       let mcp = ''
       try { await window.studio.engine.call('clip.set', { clipId, scale: 150, _actor: 'claude' }) } catch (e) { mcp = e.message }
       // Paused (the box only shows then), with the playhead in it.
       if (window.__studio.getState().playing) await window.studio.engine.call('playback.pause')
       await __t.until(() => !window.__studio.getState().playing, 3000, 'playback to pause')
       await window.studio.engine.call('playback.seek', { positionUs: c0.startUs + Math.round(c0.durationUs / 2) })
       const box = await __t.until(() => __t.q('.ph-box'), 3000, 'its box on the video')
       const handles = box.querySelectorAll('.ph-corner, .ph-rotate, .ph-delete').length
       const after = await __t.snap()
       const c1 = __t.main(after).find((x) => x.id === clipId)
       if (!c1 || !c1.busy) throw new Error('the busy clip is ' + (c1 ? 'no longer busy' : 'gone'))
       if (__t.main(after).map((x) => x.id).join() !== order) throw new Error('the main track changed')
       for (const k of ['startUs', 'durationUs', 'inUs', 'mediaId', 'scale', 'opacity']) if (c1[k] !== c0[k]) throw new Error(k + ' changed: ' + c0[k] + ' to ' + c1[k])
       if (menu.join('|') !== 'Cancel text removal') throw new Error('the menu has ' + menu.join(', '))
       if (edges) throw new Error(edges + ' trim edges showing')
       if (!/Text is still being removed/.test(mcp)) throw new Error('an MCP edit: ' + (mcp || 'allowed'))
       if (handles) throw new Error(handles + ' handles on the video')
       if (!cancel) throw new Error('no Cancel text removal in the Inspector')
       return { menu, inspector, mcp, toasts: __t.qa('.toast').map((t) => t.textContent).filter((t) => /still being removed/.test(t)) }`,
    )
    await step(
      'Vmake: when it’s done the clip plays the cleaned copy and is normal again',
      `const { clipId, dir } = window.__vm
       const before = __t.main(await __t.snap()).find((x) => x.id === clipId)
       const s = await __t.until(async () => { const s = await __t.snap(); const c = __t.main(s).find((x) => x.id === clipId); return c && !c.busy && s }, 40000, 'the job to finish')
       const c = __t.main(s).find((x) => x.id === clipId)
       const m = s.project.media.find((x) => x.id === c.mediaId)
       if (!/\\(no text\\)( \\d+)?\\.mp4$/.test(m.path)) throw new Error('the clip plays ' + m.path)
       // From the copy's start, as long as before (give or take a frame of the cut).
       if (c.inUs !== 0 || Math.abs(c.durationUs - before.durationUs) > 100000) throw new Error('the clip is now ' + c.inUs + ' + ' + c.durationUs + ', was ' + before.durationUs)
       await __t.until(() => !__t.clipEl(clipId).classList.contains('busy'), 3000, 'the clip to look normal')
       const toast = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => t.startsWith('Text removed')), 3000, 'the toast')
       await window.studio.engine.call('clip.set', { clipId, opacity: 90 })
       const left = await window.studio.services.vmakeJobs(dir)
       if (left.length) throw new Error('jobs left: ' + JSON.stringify(left))
       return { file: m.name, toast, inspector: !__t.q('.inspector .insp-busy-clip') }`,
    )
    await shot('12c-vmake-done')
    await step(
      'Vmake: closed mid-job (another project opened), it finishes in the background and is applied on reopening',
      `const { dir } = window.__vm
       let s = await __t.snap()
       ${pick}
       const c = __t.main(s).find((x) => video(s, x))
       await window.__studio.removeText({ mediaId: c.mediaId, clipId: c.id }, 'full')
       ${working('c.id')}
       // Learned from the first job: no longer a first guess.
       const est = Object.values(window.__studio.getState().vmakeJobs).find((j) => j.clipId === c.id)
       if (est.firstGuess || !(est.expectedMs > 0)) throw new Error('the estimate is ' + JSON.stringify({ expectedMs: est.expectedMs, firstGuess: est.firstGuess }))
       await window.__studio.newProject('Open while Vmake works', '9:16')
       await __t.until(async () => (await __t.snap()).dir !== dir, 5000, 'another project')
       await __t.until(() => !Object.keys(window.__studio.getState().vmakeJobs).length, 3000, 'the other project to show no jobs')
       const done = await __t.until(async () => (await window.studio.services.vmakeJobs(dir)).find((j) => j.clipId === c.id && j.state === 'done'), 40000, 'the job to finish in the background')
       await window.__studio.openProjectAt(dir)
       s = await __t.until(async () => { const s = await __t.snap(); const x = s.dir === dir && __t.main(s).find((y) => y.id === c.id); return x && !x.busy && s }, 15000, 'the result applied on opening')
       const m = s.project.media.find((x) => x.id === __t.main(s).find((y) => y.id === c.id).mediaId)
       if (!/\\(no text\\)/.test(m.name)) throw new Error('the clip plays ' + m.name)
       return { finishedWhileClosed: done.state, file: m.name, estimateS: +(est.expectedMs / 1000).toFixed(1), seconds: est.seconds }`,
    )
    const restart = 'Vmake: Studio restarting mid-job (1/2): the job is running, its project closed'
    await step(
      restart,
      `const { dir } = window.__vm
       const s = await __t.snap()
       ${pick}
       const c = __t.main(s).find((x) => video(s, x))
       window.__vm.restartClip = c.id
       await window.__studio.removeText({ mediaId: c.mediaId, clipId: c.id }, 'full')
       ${working('c.id')}
       await window.__studio.newProject('Open while Studio restarts', '9:16')
       await __t.until(async () => (await __t.snap()).dir !== dir, 5000, 'another project')
       return c.id`,
    )
    // As if the app quit and started again: the main process forgets every job and reads them back from disk.
    if (wanted(restart)) vmakeTest.restart()
    await step(
      'Vmake: Studio restarting mid-job (2/2): the job picks up from jobs.json, finishes, and is applied on opening',
      `const { dir, restartClip } = window.__vm
       const done = await __t.until(async () => (await window.studio.services.vmakeJobs(dir)).find((j) => j.clipId === restartClip && j.state === 'done'), 40000, 'the job, read back from disk, to finish')
       await window.__studio.openProjectAt(dir)
       const s = await __t.until(async () => { const s = await __t.snap(); const x = s.dir === dir && __t.main(s).find((y) => y.id === restartClip); return x && !x.busy && s }, 15000, 'the result applied on opening')
       const m = s.project.media.find((x) => x.id === __t.main(s).find((y) => y.id === restartClip).mediaId)
       if (!/\\(no text\\)/.test(m.name)) throw new Error('the clip plays ' + m.name)
       // The clock and the estimate it was charged with came back from disk with it.
       if (!done.chargedAt || !done.expectedMs) throw new Error('the job lost its clock: ' + JSON.stringify(done))
       return { job: done.id, file: m.name, estimateS: +(done.expectedMs / 1000).toFixed(1) }`,
    )
    await step(
      'Vmake: Cancel text removal (right-click) restores the clip',
      `let s = await __t.snap()
       const c = __t.main(s).find((x) => s.project.media.find((m) => m.id === x.mediaId)?.kind === 'video')
       await window.__studio.removeText({ mediaId: c.mediaId, clipId: c.id }, 'full')
       const el = await __t.until(() => { const e = __t.clipEl(c.id); return e?.classList.contains('busy') && e }, 5000, 'the clip to go grey')
       ${working('c.id')}
       const r = __t.rect(el)
       el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }))
       await __t.until(() => __t.q('.context-menu'), 2000, 'the menu')
       __t.qa('.context-menu button').find((b) => b.textContent === 'Cancel text removal').click()
       s = await __t.until(async () => { const s = await __t.snap(); const x = __t.main(s).find((y) => y.id === c.id); return x && !x.busy && s }, 5000, 'the clip freed')
       const x = __t.main(s).find((y) => y.id === c.id)
       for (const k of ['mediaId', 'inUs', 'durationUs']) if (x[k] !== c[k]) throw new Error(k + ' changed')
       await __t.until(() => !__t.clipEl(c.id).classList.contains('busy'), 3000, 'the clip to look normal')
       const toast = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => /cancelled/.test(t)), 3000, 'the toast')
       await window.studio.engine.call('clip.set', { clipId: c.id, opacity: 85 })
       return { toast, jobsLeft: (await window.studio.services.vmakeJobs(s.dir)).length }`,
    )
    const failing = 'Vmake: a job Vmake fails frees the clip and says why'
    if (wanted(failing)) vmakeTest.failNext()
    await step(
      failing,
      `let s = await __t.snap()
       const c = __t.main(s).find((x) => s.project.media.find((m) => m.id === x.mediaId)?.kind === 'video')
       await window.__studio.removeText({ mediaId: c.mediaId, clipId: c.id }, 'full')
       await __t.until(() => __t.clipEl(c.id)?.classList.contains('busy'), 5000, 'the clip to go grey')
       s = await __t.until(async () => { const s = await __t.snap(); const x = __t.main(s).find((y) => y.id === c.id); return x && !x.busy && s }, 20000, 'the clip freed')
       if (__t.main(s).find((y) => y.id === c.id).mediaId !== c.mediaId) throw new Error('the clip changed')
       const toast = await __t.until(() => __t.qa('.toast.error, .toast').map((t) => t.textContent).find((t) => /Text removal failed/.test(t)), 3000, 'the reason')
       return toast`,
    )
  } else console.log('[ui-check] skip Vmake text removal: set STUDIO_VMAKE_FAKE=1 (the stand-in; the real Vmake is never called from tests)')

  // Dub, on the stand-ins (STUDIO_VMAKE_FAKE=1 and STUDIO_CLAUDE_FAKE=1), in a project of its own:
  // Vmake starts the moment a dub does, as its own job, before the text is found or picked, and
  // nothing the dub does stops it; the next dub of the clip uses that one removal.
  const dubClip = process.env.STUDIO_UI_CHECK_DUBCLIP ?? ''
  if (process.env.STUDIO_VMAKE_FAKE === '1' && process.env.STUDIO_CLAUDE_FAKE === '1' && dubClip) {
    const dubFirst = 'Dub: Vmake starts the moment the dub does, on its own, before the text is found or picked, and the Dub tab shows it'
    // Long enough to still be working when the next step cancels the dub.
    if (!only || only.test(dubFirst)) vmakeTest.slowNext(25_000)
    await step(
      dubFirst,
      `const S = window.__studio, st = () => S.getState()
       const back = (await __t.snap()).dir
       await S.newProject('Dub first', '9:16')
       await __t.until(async () => (await __t.snap()).dir !== back, 5000, 'its own project')
       const r = await window.studio.engine.call('media.import', { paths: [${JSON.stringify(dubClip)}] })
       const mediaId = r.imported[0]
       await __t.until(async () => !(await __t.snap()).processing.length, 30000, 'the clip to be read')
       await window.studio.engine.call('timeline.insert', { mediaId })
       const s = await __t.snap()
       const clip = __t.main(s).find((c) => c.mediaId === mediaId)
       window.__dub = { back, dir: s.dir, mediaId, clipId: clip.id }
       await __t.until(() => __t.clipEl(clip.id), 3000, 'the clip on the timeline')
       __t.click(__t.clipEl(clip.id))
       ;(await __t.until(() => __t.qa('.insp-tabs button').find((b) => b.textContent.trim() === 'Dub'), 3000, 'the Dub tab')).click()
       const seen = []
       const off = window.studio.services.onDubJob((j) => seen.push([j.id, j.state, !!j.vmakeJob]))
       await S.dubText({ mediaId, clipId: clip.id }, { lang: 'da', model: 'pro', text: true, voice: 'keep', captions: false, review: true })
       const id = await __t.until(() => Object.values(st().dubJobs).find((j) => j.clipId === clip.id)?.id, 5000, 'the dub')
       const line = await __t.until(() => __t.q('.inspector .dub-removal')?.textContent, 8000, 'the Dub tab’s Vmake line while the dub works')
       const job = await __t.until(() => st().dubJobs[id]?.state === 'review' && st().dubJobs[id], 60000, 'the review')
       off()
       const mine = seen.filter((x) => x[0] === id)
       const started = mine.findIndex((x) => x[2]), scanned = mine.findIndex((x) => x[1] === 'scanning')
       if (started < 0 || scanned < 0 || started > scanned) throw new Error('Vmake didn’t start before the text was looked for: ' + JSON.stringify(mine.map((x) => x.slice(1))))
       const vj = (await window.studio.services.vmakeJobs(s.dir)).find((j) => j.id === job.vmakeJob)
       if (!vj || vj.dub !== id || ['done', 'failed', 'cancelled'].includes(vj.state)) throw new Error('the removal is ' + JSON.stringify(vj && { state: vj.state, dub: vj.dub }))
       // The review: Vmake still shown working, and no longer counted as to pay.
       const inReview = await __t.until(() => __t.q('.inspector .dub-removal')?.textContent, 5000, 'the Vmake line in the review')
       const cost = __t.qa('.inspector .lib-note, .inspector p').map((n) => n.textContent).find((t) => /costs|Nothing here costs/.test(t)) ?? ''
       if (/Vmake/.test(cost)) throw new Error('the review still charges Vmake: ' + cost)
       return { order: mine.map((x) => x[1] + (x[2] ? '+vmake' : '')).filter((x, i, a) => x !== a[i - 1]), line, inReview, removal: vj.state }`,
    )
    await shot('26-dub-vmake-first')
    await step(
      'Dub: cancelling it leaves Vmake running; the next dub of the clip uses that removal, never a second, and lands on its clean copy',
      `const S = window.__studio, st = () => S.getState()
       const { back, dir, mediaId, clipId } = window.__dub
       const first = Object.values(st().dubJobs).find((j) => j.clipId === clipId)
       await S.cancelDub(first.id)
       await __t.until(() => st().dubJobs[first.id]?.state === 'cancelled', 5000, 'the dub cancelled')
       await __t.sleep(800)
       const after = (await window.studio.services.vmakeJobs(dir)).find((j) => j.id === first.vmakeJob)
       if (!after || ['done', 'failed', 'cancelled'].includes(after.state)) throw new Error('Vmake stopped with the dub: ' + JSON.stringify(after && after.state))
       await __t.until(async () => { const c = __t.main(await __t.snap()).find((x) => x.id === clipId); return c && !c.busy }, 5000, 'the clip freed')
       // The Dub tab says it carries on, and a new dub (Norwegian) uses it.
       const setup = await __t.until(() => __t.q('.inspector .dub-removal')?.textContent, 5000, 'the Vmake line after cancelling')
       await S.dubText({ mediaId, clipId }, { lang: 'no', model: 'pro', text: true, voice: 'keep', captions: false, review: true })
       const second = await __t.until(() => Object.values(st().dubJobs).find((j) => j.clipId === clipId && j.lang === 'no' && j.vmakeJob), 10000, 'the Norwegian dub to take a removal')
       if (second.vmakeJob !== first.vmakeJob) throw new Error('a second Vmake job was started')
       const removals = (await window.studio.services.vmakeJobs(dir)).filter((j) => j.dub)
       if (removals.length !== 1) throw new Error(removals.length + ' removals for one clip')
       await __t.until(() => st().dubJobs[second.id]?.state === 'review', 60000, 'its review')
       const texts = (await window.studio.services.dubResult(second.id)).texts.filter((t) => t.kind === 'edit').map((t) => t.id)
       if (!texts.length) throw new Error('the scan found no text')
       await window.studio.services.dubGo(second.id, { texts, lines: [] })
       const done = await __t.until(() => st().dubJobs[second.id]?.state === 'applied' && st().dubJobs[second.id], 60000, 'the dub on the timeline')
       const s = await __t.snap()
       const main = __t.main(s).find((c) => c.id === clipId)
       // Vmake's clean copy is the picture as it is (no patches), with the text drawn again over it.
       const base = s.project.media.find((m) => m.id === main.mediaId)?.path ?? ''
       if (base !== done.clean || !done.redraw) throw new Error('the clip plays ' + base + ', not the clean copy ' + done.clean)
       const words = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).map((c) => c.text.content)
       if (!words.some((w) => /^NO: /.test(w))) throw new Error('the text says ' + words.join(' | '))
       // Both dubs hold the clean copy; the removal's record is gone, its work done.
       if (!done.clean || st().dubJobs[first.id]?.clean !== done.clean) throw new Error('the clean copy: ' + JSON.stringify([done.clean, st().dubJobs[first.id]?.clean]))
       if ((await window.studio.services.vmakeJobs(dir)).some((j) => j.dub)) throw new Error('the removal’s record is still there')
       await S.openProjectAt(back)
       await __t.until(async () => (await __t.snap()).dir === back, 8000, 'the test project again')
       return { setup, removal: done.vmakeJob, texts: words, clean: done.clean.split(/[\\\\/]/).pop() }`,
    )
    await step(
      'Dub: the Dub tab offers Remove for the on-screen text, and Vmake without None then',
      `const S = window.__studio
       const { dir, mediaId } = window.__dub
       // A token for the tab to see (the stand-in never uses it); cleared after the Remove dub.
       await window.studio.services.setKey('vmake', 'ui-check-stand-in')
       window.dispatchEvent(new Event('studio-keys'))
       await S.openProjectAt(dir)
       await __t.until(async () => (await __t.snap()).dir === dir, 8000, 'the dub project')
       // A fresh clip of the same file: the earlier dubs' clean copy serves it.
       await window.studio.engine.call('timeline.insert', { mediaId })
       const s = await __t.snap()
       const clip = __t.main(s).filter((c) => c.mediaId === mediaId).pop()
       window.__dub.removeClip = clip.id
       window.__dub.textsBefore = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).length
       await __t.until(() => __t.clipEl(clip.id), 3000, 'the clip on the timeline')
       __t.click(__t.clipEl(clip.id))
       ;(await __t.until(() => __t.qa('.insp-tabs button').find((b) => b.textContent.trim() === 'Dub'), 3000, 'the Dub tab')).click()
       const seg = (label) => __t.until(() => __t.q('.inspector [role="group"][aria-label="' + label + '"]'), 3000, 'the ' + label + ' choices')
       const row = await seg('On-screen text')
       const choices = [...row.querySelectorAll('button')].map((b) => b.textContent)
       if (choices.join() !== 'Translate,Remove,Leave') throw new Error('On-screen text offers ' + choices.join(', '))
       row.querySelectorAll('button')[1].click()
       await __t.sleep(150)
       const vmake = [...(await seg('Vmake')).querySelectorAll('button')].map((b) => b.textContent)
       if (vmake.includes('None')) throw new Error('Vmake still offers None with Remove')
       const note = __t.qa('.inspector .insp-note').map((n) => n.textContent).find((t) => /takes the on-screen text out/.test(t))
       if (!note) throw new Error('no note saying what Remove does')
       return { choices, vmake, note }`,
    )
    await shot('27-dub-remove')
    await step(
      'Dub: Remove takes the on-screen text out and draws nothing back, without reading the text or asking for picks',
      `const S = window.__studio, st = () => S.getState()
       const { back, dir, removeClip } = window.__dub
       const seen = []
       const off = window.studio.services.onDubJob((j) => j.clipId === removeClip && seen.push(j.state))
       ;(await __t.until(() => __t.qa('.inspector button').find((b) => b.textContent === 'Find what to dub' && !b.disabled), 3000, 'Find what to dub')).click()
       const job = await __t.until(() => Object.values(st().dubJobs).find((j) => j.clipId === removeClip && ['applied', 'failed'].includes(j.state)), 30000, 'the Remove dub')
       off()
       if (job.state !== 'applied') throw new Error('it ' + job.state + ': ' + job.reason)
       if (!job.removeText) throw new Error('the tab didn’t ask for Remove')
       if (seen.some((x) => ['scanning', 'reading', 'review'].includes(x))) throw new Error('it read the text or asked for picks: ' + seen.join(', '))
       if (await window.studio.files.exists(job.dir + '/scan.json')) throw new Error('it looked for the text')
       const s = await __t.snap()
       const now = __t.main(s).find((c) => c.id === removeClip)
       const plays = s.project.media.find((m) => m.id === now.mediaId)?.path
       if (plays !== job.clean) throw new Error('the clip plays ' + plays)
       const after = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).length
       if (after !== window.__dub.textsBefore) throw new Error((after - window.__dub.textsBefore) + ' text clips were added')
       if ((await window.studio.services.vmakeJobs(dir)).some((j) => j.dub)) throw new Error('a new Vmake job was started')
       await window.studio.services.clearKey('vmake')
       window.dispatchEvent(new Event('studio-keys'))
       await S.openProjectAt(back)
       await __t.until(async () => (await __t.snap()).dir === back, 8000, 'the test project again')
       return { states: seen.filter((x, i, a) => x !== a[i - 1]), plays: plays.split(/[\\\\/]/).pop() }`,
    )
    const dubTab = `const seg = (label) => __t.until(() => __t.q('.inspector [role="group"][aria-label="' + label + '"]'), 3000, 'the ' + label + ' choices')
       const pick = async (label, choice) => { const b = [...(await seg(label)).querySelectorAll('button')].find((x) => x.textContent === choice); if (!b) throw new Error('no ' + choice + ' under ' + label); b.click(); await __t.sleep(120) }
       const openDub = async (id) => { await __t.until(() => __t.clipEl(id), 3000, 'the clip on the timeline'); __t.click(__t.clipEl(id)); (await __t.until(() => __t.qa('.insp-tabs button').find((b) => b.textContent.trim() === 'Dub'), 3000, 'the Dub tab')).click() }
       // Find what to dub, and the new dub it starts (not an earlier one of the same clip).
       const find = async () => {
         const known = new Set(Object.keys(window.__studio.getState().dubJobs))
         ;(await __t.until(() => __t.qa('.inspector button').find((b) => b.textContent === 'Find what to dub' && !b.disabled), 3000, 'Find what to dub')).click()
         return known
       }
       const land = async (clipId, known) => {
         const st = () => window.__studio.getState()
         const job = await __t.until(() => Object.values(st().dubJobs).find((j) => j.clipId === clipId && !known.has(j.id) && ['review', 'applied', 'failed'].includes(j.state)), 60000, 'the review')
         if (job.state === 'review') await window.studio.services.dubGo(job.id, { texts: (await window.studio.services.dubResult(job.id)).texts.filter((t) => t.kind === 'edit').map((t) => t.id), lines: [] })
         const done = await __t.until(() => ['applied', 'failed'].includes(st().dubJobs[job.id]?.state) && st().dubJobs[job.id], 60000, 'the dub on the timeline')
         if (done.state !== 'applied') throw new Error('the dub ' + done.state + ': ' + done.reason)
         return done
       }`
    await step(
      'Dub: Translate on a clip that plays an earlier dub’s clean copy, with Vmake None, dubs it from the original and uses that copy at no cost',
      `${dubTab}
       const S = window.__studio
       const { back, dir, removeClip } = window.__dub
       await S.openProjectAt(dir)
       await __t.until(async () => (await __t.snap()).dir === dir, 8000, 'the dub project')
       let s = await __t.snap()
       const plays = s.project.media.find((m) => m.id === __t.main(s).find((x) => x.id === removeClip).mediaId)
       if (!/\\(no text\\)/.test(plays.name)) throw new Error('the clip plays ' + plays.name + ', not the clean copy')
       const before = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).length
       await openDub(removeClip)
       await pick('On-screen text', 'Translate')
       await pick('Vmake', 'None')
       const note = await __t.until(() => __t.qa('.inspector .insp-note').map((n) => n.textContent).find((t) => /already took this clip’s text out/.test(t)), 3000, 'the note that the clean copy is used again')
       const done = await land(removeClip, await find())
       if (!/dub-text\\.mp4$/.test(done.source) || done.clean !== plays.path || !done.redraw) throw new Error('the dub: ' + JSON.stringify({ source: done.source, clean: done.clean, redraw: done.redraw }))
       s = await __t.snap()
       const words = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).map((c) => c.text.content)
       if (words.length !== before + 1 || !words.some((w) => /^[A-Z]{2}: Only 9 days left/.test(w))) throw new Error('the text clips: ' + words.join(' | '))
       if (s.project.media.find((m) => m.id === __t.main(s).find((x) => x.id === removeClip).mediaId)?.path !== plays.path) throw new Error('the clip no longer plays the clean copy')
       if ((await window.studio.services.vmakeJobs(dir)).some((j) => j.dub)) throw new Error('a Vmake job was started')
       await S.openProjectAt(back)
       await __t.until(async () => (await __t.snap()).dir === back, 8000, 'the test project again')
       return { note, text: words[words.length - 1] }`,
    )
    await step(
      'Dub: Translate with Vmake None and no clean copy measures the text from the picture itself and draws it over the old',
      `${dubTab}
       const S = window.__studio
       const { back } = window.__dub
       await S.newProject('Dub without Vmake', '9:16')
       await __t.until(async () => (await __t.snap()).dir !== back, 5000, 'its own project')
       const r = await window.studio.engine.call('media.import', { paths: [${JSON.stringify(dubClip)}] })
       await __t.until(async () => !(await __t.snap()).processing.length, 30000, 'the clip to be read')
       await window.studio.engine.call('timeline.insert', { mediaId: r.imported[0] })
       let s = await __t.snap()
       const clip = __t.main(s).find((c) => c.mediaId === r.imported[0])
       await openDub(clip.id)
       await pick('On-screen text', 'Translate')
       await pick('Vmake', 'None')
       const done = await land(clip.id, await find())
       if (done.redraw || done.clean || (done.notes ?? []).some((n) => /couldn’t be measured/.test(n))) throw new Error('the dub: ' + JSON.stringify({ redraw: done.redraw, clean: done.clean, notes: done.notes }))
       s = await __t.snap()
       const words = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).map((c) => c.text.content)
       if (words.length !== 1 || !/Only 9 days left/.test(words[0])) throw new Error('the text clips: ' + words.join(' | '))
       if (__t.main(s)[0].mediaId !== r.imported[0]) throw new Error('the picture changed')
       await S.openProjectAt(back)
       await __t.until(async () => (await __t.snap()).dir === back, 8000, 'the test project again')
       return { text: words[0] }`,
    )
  } else console.log('[ui-check] skip Dub: set STUDIO_VMAKE_FAKE=1 and STUDIO_CLAUDE_FAKE=1 (the stand-ins), with the drawtext test clip')

  // Apply to all text: the look and the transform (size, scale, a drag in the player) go to every
  // text clip, each as one undo step. Two text clips of its own, removed after.
  await step(
    'Text: with Apply to all text ticked, size, scale and a drag in the player go to every text clip, each as one undo step',
    `const dev = window.__studioDev
     const ids = []
     for (const [at, content, size] of [[200000, 'All one', 60], [2600000, 'All two', 90]]) {
       const look = await dev.textRender.renderTextClip({ ...dev.presets.DEFAULT_TEXT, content, size }, 'uicheck-all')
       ids.push((await window.studio.engine.call('text.add', { atUs: at, durationUs: 900000, text: look })).clipId)
     }
     await window.studio.engine.call('clip.set', { clipId: ids[1], scale: 150, posY: 400 })
     const texts = (s) => s.project.tracks.filter((t) => t.role === 'text' && !t.locked).flatMap((t) => t.clips.filter((c) => c.text))
     const mine = (s) => ids.map((id) => texts(s).find((c) => c.id === id))
     const undo = async (what, back) => { await window.studio.engine.call('edit.undo'); const s = await __t.until(async () => { const s = await __t.snap(); return back(mine(s)) && s }, 5000, 'one undo to take back the ' + what + ' of both'); return s }
     await window.studio.engine.call('playback.seek', { positionUs: 500000 })
     await __t.until(() => __t.clipEl(ids[0]), 3000, 'the text on the timeline')
     __t.click(__t.clipEl(ids[0]))
     ;(await __t.until(() => __t.qa('.insp-tabs button').find((b) => b.textContent.trim() === 'Text'), 3000, 'the Text tab')).click()
     const tick = await __t.until(() => __t.q('.inspector .insp-all input'), 3000, 'Apply to all text')
     if (!tick.checked) tick.click()
     const row = (name) => __t.qa('.inspector .insp-row').find((r) => r.querySelector('label')?.textContent === name)
     const slide = async (name, to) => { const tr = row(name).querySelector('.slider-track'); const r = __t.rect(tr); await __t.drag(tr, r.left + r.width / 2, r.top + 6, r.left + r.width * to, r.top + 6, 6) }
     // Size (the look): every text clip, one undo step.
     await slide('Size', 0.4)
     let s = await __t.until(async () => { const s = await __t.snap(); const z = texts(s).map((c) => c.text.size); return new Set(z).size === 1 && z[0] !== 60 && s }, 8000, 'every text the same new size')
     const size = mine(s)[0].text.size
     await undo('size', (m) => m[0].text.size === 60 && m[1].text.size === 90)
     // Scale (the transform): every text clip, one undo step.
     await slide('Scale', 0.6)
     s = await __t.until(async () => { const s = await __t.snap(); const z = texts(s).map((c) => c.scale ?? 100); return new Set(z).size === 1 && z[0] !== 100 && s }, 5000, 'every text the same new scale')
     const scale = mine(s)[0].scale
     await undo('scale', (m) => (m[0].scale ?? 100) === 100 && m[1].scale === 150)
     // A drag in the player: every text clip moves there too.
     const box = await __t.until(() => __t.q('.ph-box'), 3000, 'the text’s box in the player')
     const b = __t.rect(box)
     await __t.drag(__t.q('.ph-stage'), b.left + b.width / 2, b.top + b.height / 2, b.left + b.width / 2, b.top + b.height / 2 - 60, 8)
     s = await __t.until(async () => { const s = await __t.snap(); const y = texts(s).map((c) => c.posY ?? 0); return new Set(y).size === 1 && y[0] !== 0 && s }, 5000, 'every text moved to the same place')
     const posY = mine(s)[0].posY
     await undo('move', (m) => (m[0].posY ?? 0) === 0 && m[1].posY === 400)
     tick.click()
     await window.studio.engine.call('timeline.delete', { clipIds: ids })
     return { size, scale, posY, texts: texts(s).length }`,
  )

  // Captions made from words (no server), to see the panels with a long list: the Library tab,
  // the Inspector's lines and its Text tab.
  await step(
    'Captions look: 60 lines, the Inspector lists them and the Library tab shows the language',
    `const dev = window.__studioDev
     const words = ['Det', 'här', 'är', 'en', 'bra', 'dag', 'för', 'en', 'lång', 'promenad', 'i', 'skogen']
     const cues = Array.from({ length: 60 }, (_, i) => { const s = 200000 + i * 280000; const n = 2 + (i % 3); const ws = Array.from({ length: n }, (_, k) => ({ w: words[(i + k) % words.length], s: k * 90000, e: k * 90000 + 80000 })); return { startUs: s, endUs: s + 270000, text: ws.map((w) => w.w).join(' '), words: ws } })
     const trackId = await dev.captions.placeCaptions(cues, { lang: 'sv', style: 'Clean', centerY: 0.72 })
     const lines = dev.captions.captionTracks(await __t.snap()).find((t) => t.track.id === trackId).lines
     await window.studio.engine.call('playback.seek', { positionUs: lines[4].startUs + 100000 })
     dev.store.setState({ selection: [lines[4].id], focus: 'timeline' })
     window.__capLook = { trackId }
     await __t.until(() => __t.q('.cap-lines li'), 5000, 'the lines in the Inspector')
     return { rows: __t.qa('.cap-lines li').length }`,
  )
  await shot('24a-captions-lines')
  await step(
    'Captions look: the Text tab and the Library tab',
    `__t.qa('.inspector .insp-tabs button').find((b) => b.textContent === 'Text').click()
     await __t.sleep(300)
     return { tabs: __t.qa('.inspector .insp-tabs button').map((b) => b.textContent) }`,
  )
  await shot('24b-captions-text')
  await step(
    'Captions look: the Library tab',
    `${cat('Captions')}
     __t.qa('.inspector .insp-tabs button').find((b) => b.textContent === 'Captions').click()
     await __t.sleep(300)
     return { notes: __t.qa('.library .lib-note').map((n) => n.textContent) }`,
  )
  await shot('24c-captions-library')
  await step(
    'Captions look: Find highlights the lines with a word, Replace in every one, and the header stays while the list scrolls',
    `const find = await __t.until(() => __t.q('input[aria-label="Find in captions"]'), 3000, 'the Find field')
     const type = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
     type(find, 'lång')
     const found = await __t.until(() => __t.qa('.cap-lines li.found').length, 3000, 'lines found')
     const hits = __t.q('.cap-hits')?.textContent
     __t.qa('.cap-find .cap-tool').find((b) => b.textContent === 'Replace').click()
     const rep = await __t.until(() => __t.q('input[aria-label="Replace with"]'), 3000, 'the Replace field')
     type(rep, 'långa')
     const body = __t.q('.inspector .insp-body')
     body.scrollTop = 900
     await __t.sleep(200)
     const head = __t.rect(__t.q('.cap-head')), top = __t.rect(body).top
     if (Math.abs(head.top - top) > 6) throw new Error('the header scrolled away: ' + head.top + ' vs ' + top)
     return { found, hits }`,
  )
  await shot('24d-captions-find')
  await step(
    'Captions look: Replace in every line changes only those lines, as one undo step',
    `const { trackId } = window.__capLook
     const before = (await __t.snap()).project.tracks.find((t) => t.id === trackId).clips.filter((c) => /lång/.test(c.text.content)).length
     __t.qa('.cap-replace button').find((b) => /^Replace/.test(b.textContent)).click()
     const after = await __t.until(async () => { const t = (await __t.snap()).project.tracks.find((x) => x.id === trackId); return t && !t.clips.some((c) => /lång\\b/.test(c.text.content)) && t.clips.filter((c) => /långa/.test(c.text.content)).length }, 10000, 'every lång replaced')
     if (after !== before) throw new Error(before + ' lines had it, ' + after + ' changed')
     window.__studio.getState()
     return { replaced: after }`,
  )

  // The Export window's text: the edit's on-screen text and what she says as .txt (no times) and
  // .srt, next to the video and named like it.
  await step(
    'Export window: Save .txt and Save .srt write the edit’s text next to the video',
    `localStorage.setItem('studio.export.v2', JSON.stringify({ formats: ['9:16'], quality: 'fast', folder: ${JSON.stringify(exportDir)}, after: 'Do nothing' }))
     // Some text to save, when the steps before made none.
     if (!(await __t.snap()).project.tracks.some((t) => t.clips.some((c) => c.text))) {
       const look = await window.__studioDev.textRender.renderTextClip({ ...window.__studioDev.presets.DEFAULT_TEXT, content: 'Brighter in 28 days' }, 'uicheck-txt')
       await window.studio.engine.call('text.add', { atUs: 500000, durationUs: 1500000, text: look })
     }
     __t.key('Escape'); await __t.sleep(100)
     __t.key('e', { ctrlKey: true })
     await __t.until(() => __t.q('.export-dialog .exp-primary'), 3000, 'the export dialog')
     const saved = []
     for (const kind of ['txt', 'srt']) {
       const before = __t.qa('.toast').length
       ;(await __t.until(() => __t.qa('.exp-text button').find((b) => b.textContent === 'Save .' + kind && !b.disabled), 3000, 'Save .' + kind)).click()
       const msg = await __t.until(() => __t.qa('.toast').map((t) => t.textContent).find((t) => new RegExp('^Saved .+\\\\.' + kind).test(t)), 8000, 'the saved .' + kind)
       const name = /^Saved (.+?\\.(txt|srt))/.exec(msg)[1]
       const file = ${JSON.stringify(exportDir)} + (${JSON.stringify(exportDir)}.includes('\\\\') ? '\\\\' : '/') + name
       if (!(await window.studio.files.exists(file))) throw new Error('no ' + file)
       saved.push(name)
     }
     return { saved }`,
  )
  await shot('25-export-text')
  await step('Export window: closes again after saving the text', `__t.key('Escape'); await __t.until(() => !__t.q('.export-dialog'), 2000, 'the window to close'); return 'closed'`)
  // A voiceover with its script, cut into pieces (the pauses taken out): with captions, the .txt and
  // .srt are the captions line by line as they're set (1 word each, 3 each); without, each sentence
  // of the script once, where it's said (it was the whole script in every piece).
  const cutVo = path.join(path.dirname(exportDir), 'cut-voiceover.wav')
  const cutScript = 'Soft leather from the first step. Zips on both sides, so they slip on. Order yours today.'
  fs.writeFileSync(cutVo.replace(/\.wav$/, '.script.txt'), `${cutScript}\n`)
  fs.writeFileSync(cutVo.replace(/\.wav$/, '.voice.json'), JSON.stringify({ voiceId: 'fake-voice', name: 'Test Voice', modelId: 'eleven_v4', speed: 1, languageCode: 'en' }))
  await step(
    'Export window: the .txt and .srt follow the captions line by line (1 word, 3 words); a voiceover cut into pieces without captions has each sentence once',
    `const t = window.__studioDev.textExport
     const S = ['Soft leather from the first step.', 'Zips on both sides, so they slip on.', 'Order yours today.']
     const piece = (id, startUs, inUs, durationUs) => ({ id, mediaId: 'cut-vo', startUs, inUs, durationUs, volume: 1, speed: 1 })
     const snapOf = (more) => ({ dir: ${JSON.stringify(path.dirname(exportDir))}, project: { width: 1080, height: 1920,
       media: [{ id: 'cut-vo', path: ${JSON.stringify(cutVo)}, name: 'cut-voiceover.wav', kind: 'audio', durationUs: 9000000 }],
       tracks: [{ id: 'vo', kind: 'audio', clips: [piece('p1', 0, 0, 2800000), piece('p2', 2800000, 3200000, 3000000), piece('p3', 5800000, 6600000, 2400000)] }, ...more] } })
     const plain = await t.textOf(snapOf([]))
     const said = plain.said.map((c) => c.text)
     if (said.join('|') !== S.join('|')) throw new Error('said: ' + JSON.stringify(said))
     const txt = t.textFile(plain, 'said')
     if (txt !== S.join('\\n') + '\\n') throw new Error('txt: ' + txt)
     const srt = t.srtFile(plain, 'said')
     if (srt.split('-->').length !== 4 || srt.split('Order yours').length !== 2) throw new Error('srt: ' + srt)
     // Captions of it, as the user set them (their own words: "Zippers"), n words a line, 0.4 s a word.
     const words = S.join(' ').replace('Zips', 'Zippers').split(' ')
     const lines = (n) => {
       const out = []
       for (let i = 0; i < words.length; i += n) out.push({ id: 'l' + n + '-' + i, mediaId: '', startUs: 200000 + i * 400000, inUs: 0, durationUs: Math.min(n, words.length - i) * 400000, volume: 1, caption: true, text: { content: words.slice(i, i + n).join(' ') } })
       return out
     }
     const seen = {}
     for (const n of [1, 3]) {
       const caps = lines(n)
       const r = await t.textOf(snapOf([{ id: 'cap' + n, kind: 'video', role: 'captions', clips: caps }]))
       const want = caps.map((c) => [c.startUs, c.startUs + c.durationUs, c.text.content])
       if (JSON.stringify(r.said.map((c) => [c.startUs, c.endUs, c.text])) !== JSON.stringify(want)) throw new Error(n + ' a line: ' + JSON.stringify(r.said.slice(0, 4)))
       const txt = t.textFile(r, 'said'), srt = t.srtFile(r, 'said')
       if (txt !== want.map((w) => w[2]).join('\\n') + '\\n') throw new Error(n + ' a line, txt: ' + txt.slice(0, 120))
       if (srt.split('-->').length !== caps.length + 1) throw new Error(n + ' a line, srt: ' + srt.slice(0, 200))
       seen[n + ' a line'] = { cues: caps.length, first: txt.split('\\n').slice(0, 2) }
     }
     return { said, ...seen }`,
  )

  // Translations, on the stand-ins (STUDIO_CLAUDE_FAKE=1 and STUDIO_ELEVEN_FAKE=1: never the real
  // Claude or ElevenLabs): two languages from the tab, the review, and the Norwegian copy with
  // its text translated. Last, as it opens the copy.
  if (process.env.STUDIO_CLAUDE_FAKE === '1' && process.env.STUDIO_ELEVEN_FAKE === '1') {
    await step(
      'Translations: a voiceover Studio didn’t make is heard, its ElevenLabs voice found in the history, and it’s spoken again sentence by sentence (never cloned)',
      `${cat('Translations')}
       const same = __t.qa('.lib-setting button').find((b) => b.textContent === 'Same voice')
       if (same && same.getAttribute('aria-pressed') !== 'true') same.click()
       const found = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /^voiceover\.wav: .*found in your ElevenLabs history/.test(t)), 15000, 'the voiceover heard and its voice found')
       if (!/Test Voice/.test(found) || !/2 sentences/.test(found)) throw new Error('found: ' + found)
       // The voiceover's own lines (earlier steps may have left other sounds the stand-in "hears" too).
       const s0 = await __t.snap()
       const vo = s0.project.tracks.flatMap((t) => t.clips).filter((c) => /voiceover.wav$/.test(s0.project.media.find((m) => m.id === c.mediaId)?.path ?? '')).map((c) => c.id)
       const ofVo = (list) => list.filter((i) => i.kind === 'line' && vo.includes(i.id.slice(2).split('~')[0]))
       const items = ofVo((await window.__studio.collectTranslation()).items)
       if (items.length !== 2 || !items.every((i) => /~[0-9]$/.test(i.id) && i.voice?.voiceId === 'fake-voice')) throw new Error('lines: ' + JSON.stringify(items))
       if (!(items[0].endUs <= items[1].startUs)) throw new Error('the sentences overlap: ' + JSON.stringify(items.map((i) => [i.startUs, i.endUs])))
       // Keep its own sound, then Test Voice again: the pick is kept.
       const choose = async (name) => {
         const sel = await __t.until(() => __t.q('select[aria-label="The voice of voiceover.wav"]'), 5000, 'the voiceover’s voice')
         const opt = await __t.until(() => [...sel.options].find((o) => o.textContent === name), 5000, 'the option ' + name)
         Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value)
         sel.dispatchEvent(new Event('change', { bubbles: true }))
       }
       await choose('Keep its own sound')
       const kept = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /^voiceover.wav: .*kept in its own sound/.test(t)), 5000, 'the voiceover kept as it is')
       if (ofVo((await window.__studio.collectTranslation()).items).some((i) => i.voice)) throw new Error('a kept voiceover still has a voice')
       await choose('Test Voice')
       const picked = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /^voiceover.wav: .*picked by you/.test(t)), 5000, 'Test Voice picked again')
       return { found, kept, picked, sentences: items.map((i) => i.text) }`,
    )
    await shot('23-translations-voice')
    await step(
      'Translations: a voiceover with its script, cut into pieces, is one line: its script said once, from the first piece to the last',
      `const engine = window.studio.engine
       const s0 = await __t.snap()
       const imp = await engine.call('media.import', { paths: [${JSON.stringify(cutVo)}] })
       const mediaId = imp.imported?.[0]
       if (!mediaId) throw new Error('not imported: ' + JSON.stringify(imp))
       const atUs = s0.durationUs
       await engine.call('timeline.insert', { mediaId, atUs })
       const ofIt = async () => (await __t.snap()).project.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === mediaId).sort((a, b) => a.startUs - b.startUs)
       const first = (await ofIt())[0]
       await engine.call('timeline.split', { atUs: atUs + 2000000, clipIds: [first.id] })
       await engine.call('timeline.split', { atUs: atUs + 4500000, clipIds: [(await ofIt())[1].id] })
       const pieces = await ofIt()
       if (pieces.length !== 3) throw new Error(pieces.length + ' pieces')
       const ids = pieces.map((c) => c.id)
       const lines = (await window.__studio.collectTranslation()).items.filter((i) => i.kind === 'line' && ids.includes(i.id.slice(2)))
       const last = pieces[2]
       if (lines.length !== 1) throw new Error(lines.length + ' lines: ' + JSON.stringify(lines))
       const l = lines[0]
       if (l.id !== 'v:' + ids[0] || l.text !== ${JSON.stringify(cutScript)} || JSON.stringify(l.pieces) !== JSON.stringify(ids.slice(1)) || l.startUs !== pieces[0].startUs || l.endUs !== last.startUs + last.durationUs || l.voice?.voiceId !== 'fake-voice') throw new Error('the line: ' + JSON.stringify(l))
       return { pieces: ids.length, line: { id: l.id, pieces: l.pieces.length, seconds: ((l.endUs - l.startUs) / 1e6).toFixed(1) } }`,
    )
    await step(
      'Translations: the tab finds the text and starts one project per language',
      `${cat('Translations')}
       const dev = window.__studioDev
       const s0 = await __t.snap()
       for (const [at, content] of [[500000, 'Brighter in 28 days'], [2500000, 'Day 1 ✨']]) {
         const look = await dev.textRender.renderTextClip({ ...dev.presets.DEFAULT_TEXT, content }, 'uicheck-tr')
         await window.studio.engine.call('text.add', { atUs: at, durationUs: 1500000, text: look })
       }
       window.__tr = { dir: s0.dir }
       const note = await __t.until(() => __t.qa('.lib-note').map((n) => n.textContent).find((t) => /text clip/.test(t)), 8000, 'what the tab found')
       for (const b of __t.qa('.tr-langs button')) if ((b.getAttribute('aria-pressed') === 'true') !== ['Norwegian', 'Danish'].includes(b.textContent)) b.click()
       await __t.sleep(100)
       const go = __t.qa('.tr-buttons button').find((b) => /Translate into 2 languages/.test(b.textContent))
       if (!go) throw new Error('no Translate button: ' + __t.qa('.tr-buttons button').map((b) => b.textContent).join(', '))
       go.click()
       await __t.until(() => __t.q('.tr-tabs'), 20000, 'the review with a tab per language')
       return { note, tabs: __t.qa('.tr-tabs button').map((b) => b.textContent), rows: __t.qa('.tr-item').length }`,
    )
    await shot('23-translations-review')
    await step(
      'Translations: the review shows each line with its back-translation, and Translate lands the language in its own project',
      `const backs = __t.qa('.tr-back').length
       if (!backs) throw new Error('no back-translations')
       __t.qa('.tr-buttons button').find((b) => /Translate 2 languages/.test(b.textContent)).click()
       const { dir } = window.__tr
       const jobs = async () => (await window.studio.services.translateJobs(dir)).filter((j) => j.source === dir)
       const done = await __t.until(async () => { const l = await jobs(); return l.length === 2 && l.every((j) => j.state === 'ready') && l }, 60000, 'both languages ready')
       const no = done.find((j) => j.lang === 'no')
       if (!/· Norsk$/.test(no.name)) throw new Error('the copy is called ' + no.name)
       await window.__studio.openProjectAt(no.project)
       await __t.until(async () => (await window.studio.services.translateJobs(no.project)).find((j) => j.id === no.id)?.state === 'applied', 20000, 'the Norwegian copy to take its translation')
       const s = await __t.snap()
       const texts = s.project.tracks.flatMap((t) => t.clips).filter((c) => c.text).map((c) => c.text.content)
       if (!texts.some((t) => /^NO: Brighter/.test(t))) throw new Error('the copy says ' + texts.join(' | '))
       // The voiceover spoken again: its old clip out, a new clip for each sentence.
       const sounds = s.project.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips).map((c) => s.project.media.find((m) => m.id === c.mediaId)?.path ?? '')
       const said = sounds.filter((p) => /translation.line-v_/.test(p))
       if (said.length < 2) throw new Error(said.length + ' new sentences: ' + sounds.join(' | '))
       if (sounds.some((p) => /(^|[\\\\/])voiceover.wav$/.test(p))) throw new Error('the old voiceover is still there')
       // The voiceover cut into pieces: every piece out, its script spoken once.
       if (sounds.some((p) => /cut-voiceover.wav$/.test(p))) throw new Error('a piece of the cut voiceover is still there: ' + sounds.join(' | '))
       return { project: s.project.name, texts, said: said.length }`,
    )
    await shot('23b-translations-copy')
    await step(
      'Translations: a copy translates from its own language, and Cancel in the review removes the untouched new copy',
      `const s = await __t.snap()
       const from = await __t.until(() => __t.q('.lib-setting .dsel-value')?.textContent, 5000, 'the From language')
       if (from !== 'Norwegian') throw new Error('the copy translates from ' + from)
       for (const b of __t.qa('.tr-langs button')) if ((b.getAttribute('aria-pressed') === 'true') !== (b.textContent === 'German')) b.click()
       const button = (re) => __t.until(() => __t.qa('.tr-buttons button').find((b) => re.test(b.textContent) && !b.disabled), 5000, 'a button ' + re + ' (there are: ' + __t.qa('.tr-buttons button').map((b) => b.textContent).join(', ') + ')')
       ;(await button(/^Translate into German$/)).click()
       const job = await __t.until(async () => (await window.studio.services.translateJobs(s.dir)).find((j) => j.source === s.dir && j.state === 'review'), 20000, 'the German review')
       if (job.from !== 'no') throw new Error('it translates from ' + job.from)
       await __t.until(() => __t.q('.tr-item'), 20000, 'its lines')
       ;(await button(/^Cancel$/)).click()
       const gone = await __t.until(async () => !(await window.studio.services.translateJobs(s.dir)).some((j) => j.id === job.id) && job.project, 5000, 'the job to go')
       const projects = await window.studio.app.projects([])
       if (projects.some((p) => p.dir === gone)) throw new Error('the copy is still there: ' + gone)
       return { from, copy: job.name, removed: true }`,
    )
  } else console.log('[ui-check] skip Translations: set STUDIO_CLAUDE_FAKE=1 and STUDIO_ELEVEN_FAKE=1 (the stand-ins; real Claude and ElevenLabs are never called from tests)')

  // Import from CapCut, from a CapCut project made here (STUDIO_CAPCUT_DIR): the test clips with a
  // White Flash between them, a title with an outline, two caption lines, and a file that's gone.
  if (clips.length >= 2 && (!only || only.test('Import from CapCut'))) {
    const root = path.join(out, 'capcut-drafts')
    const draft = path.join(root, 'UI check draft')
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(draft, { recursive: true })
    const seg = (id: string, start: number, duration: number, more: object = {}) => ({ id: `s-${id}-${start}`, material_id: id, target_timerange: { start, duration }, source_timerange: { start: 0, duration }, speed: 1, volume: 1, visible: true, clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0, alpha: 1 }, extra_material_refs: [], ...more })
    const text = (id: string, words: string, type: string, flag: number) => ({ id, type, check_flag: flag, alignment: 1, border_color: '#000000', border_width: 0.08, content: JSON.stringify({ text: words, styles: [{ size: 9, fill: { content: { solid: { color: [1, 1, 1] } } } }] }) })
    fs.writeFileSync(
      path.join(draft, 'draft_content.json'),
      JSON.stringify({
        canvas_config: { width: 1080, height: 1920 },
        duration: 3_000_000,
        fps: 30,
        materials: {
          videos: [{ id: 'v1', type: 'video', path: clips[0] }, { id: 'v2', type: 'video', path: clips[1] }, { id: 'gone', type: 'video', path: path.join(root, 'gone.mp4') }],
          texts: [text('title', 'UI check title', 'text', 15), text('cap1', 'First caption line', 'subtitle', 7), text('cap2', 'Second caption line', 'subtitle', 7)],
          transitions: [{ id: 'flash', name: 'White Flash', duration: 400_000 }],
        },
        tracks: [
          { type: 'video', segments: [seg('v1', 0, 1_500_000, { extra_material_refs: ['flash'] }), seg('v2', 1_500_000, 1_500_000), seg('gone', 3_000_000, 1_000_000)] },
          { type: 'text', segments: [seg('title', 0, 2_000_000, { clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0.5 }, rotation: 0, alpha: 1 } })] },
          { type: 'text', segments: [seg('cap1', 0, 1_400_000), seg('cap2', 1_400_000, 1_600_000)].map((s) => ({ ...s, clip: { ...s.clip, transform: { x: 0, y: -0.6 } } })) },
        ],
      }),
    )
    fs.writeFileSync(path.join(draft, 'draft_meta_info.json'), JSON.stringify({ draft_name: 'UI check CapCut', tm_duration: 3_000_000, draft_timeline_materials_size_: 12_400_000, tm_draft_modified: Date.now() * 1000 }))
    fs.writeFileSync(path.join(draft, 'draft_cover.jpg'), (await win.webContents.capturePage()).resize({ width: 180 }).toJPEG(80))
    const was = process.env.STUDIO_CAPCUT_DIR
    process.env.STUDIO_CAPCUT_DIR = root
    try {
      await step(
        'Import from CapCut: Home’s tile lists CapCut’s projects with their covers',
        `window.__studioDev.store.setState({ page: 'home' })
         const tile = await __t.until(() => __t.qa('.home-tile').find((b) => /From CapCut/.test(b.textContent)), 5000, 'the From CapCut tile')
         tile.click()
         const card = await __t.until(() => __t.qa('.cc-card').find((c) => /UI check CapCut/.test(c.textContent)), 5000, 'the project in the list')
         const img = card.querySelector('.cc-cover img')
         await __t.until(() => img && img.complete && img.naturalWidth > 0, 5000, 'its cover')
         return { cards: __t.qa('.cc-card').length, cover: img.naturalWidth + '×' + img.naturalHeight, sub: card.querySelector('.cc-sub').textContent, length: card.querySelector('.cc-dur')?.textContent }`,
      )
      await shot('23-capcut-list')
      await step(
        'Import from CapCut: picking one builds it as a new project and says what came over',
        `__t.qa('.cc-card').find((c) => /UI check CapCut/.test(c.textContent)).click()
         await __t.until(() => /Imported from CapCut/.test(__t.q('.cc-dialog h2')?.textContent ?? ''), 60000, 'the import to finish')
         const s = await __t.snap()
         const main = __t.main(s)
         const texts = s.project.tracks.filter((t) => t.role === 'text').flatMap((t) => t.clips)
         const caps = s.project.tracks.filter((t) => t.role === 'captions').flatMap((t) => t.clips)
         if (s.project.name !== 'UI check CapCut') throw new Error('the open project is ' + s.project.name)
         if (main.length !== 2) throw new Error(main.length + ' clips on the main track')
         if (!texts.some((c) => /UI check title/.test(c.text?.content ?? ''))) throw new Error('no title text: ' + JSON.stringify(texts.map((c) => c.text?.content)))
         if (caps.length !== 2) throw new Error(caps.length + ' caption lines')
         const notes = __t.qa('.cc-list li').map((l) => l.textContent)
         if (!notes.some((n) => /gone\\.mp4/.test(n))) throw new Error('the missing file isn’t listed: ' + JSON.stringify(notes))
         return { summary: __t.q('.cc-stage').textContent, seconds: +(s.durationUs / 1e6).toFixed(2), tracks: s.project.tracks.map((t) => (t.main ? 'main' : t.role ?? t.kind) + ':' + t.clips.length), notes: notes.length }`,
      )
      await shot('24-capcut-imported')
      await step(
        'Import from CapCut: Done closes it on the new project, and Home marks the project imported',
        `__t.qa('.cc-dialog .pd-btn').find((b) => b.textContent === 'Done').click()
         await __t.until(() => !__t.q('.cc-dialog'), 2000, 'the window to close')
         window.__studioDev.store.setState({ page: 'home' })
         const tile = await __t.until(() => __t.qa('.home-tile').find((b) => /From CapCut/.test(b.textContent)), 5000, 'the From CapCut tile')
         tile.click()
         const tag = await __t.until(() => __t.q('.cc-card .cc-tag')?.textContent, 5000, 'the Imported tag')
         __t.key('Escape')
         await __t.until(() => !__t.q('.cc-dialog'), 2000, 'the list to close')
         window.__studioDev.store.setState({ page: 'edit' })
         return { tag }`,
      )
    } finally {
      if (was === undefined) delete process.env.STUDIO_CAPCUT_DIR
      else process.env.STUDIO_CAPCUT_DIR = was
    }
  } else if (clips.length < 2) console.log('[ui-check] skip Import from CapCut: it needs two test clips')

  // Naming a project: New project asks first, and the title bar renames it (late in the run, as
  // each makes a new project the open one).
  await step(
    'New project: each tile asks what to call it first (a free “Untitled” selected to type over, the tile’s format picked); Cancel makes nothing, Create opens it with that name',
    `window.__studioDev.store.setState({ page: 'home' })
     const field = () => __t.q('.modal input[aria-label="Project name"]')
     const wide = await __t.until(() => __t.qa('.home-tile').find((b) => /^16:9/.test(b.textContent.trim())), 5000, 'the 16:9 tile')
     const was = (await __t.snap()).dir
     wide.click()
     const input = await __t.until(field, 5000, 'the name field')
     const offered = input.value
     if (!/^Untitled( \\d+)?$/.test(offered)) throw new Error('it offered ' + offered)
     await __t.until(() => document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === offered.length, 2000, 'the name selected to type over')
     const picked = __t.q('.modal .formats button.on .format-name')?.textContent
     if (picked !== '16:9') throw new Error('the format picked is ' + picked)
     __t.qa('.modal footer button').find((b) => b.textContent === 'Cancel').click()
     await __t.until(() => !field(), 2000, 'the dialog to close')
     if ((await __t.snap()).dir !== was || window.__studioDev.store.getState().page !== 'home') throw new Error('Cancel made a project')
     __t.qa('.home-tile').find((b) => /New project/.test(b.textContent)).click()
     const again = await __t.until(field, 5000, 'the name field again')
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(again, 'Spring promo')
     again.dispatchEvent(new Event('input', { bubbles: true }))
     __t.qa('.modal footer button').find((b) => b.textContent === 'Create').click()
     const s = await __t.until(async () => { const x = await __t.snap(); return x.dir !== was && x.project.name === 'Spring promo' && x }, 10000, 'the new project, named')
     await __t.until(() => window.__studioDev.store.getState().page === 'edit' && __t.q('.titlebar .project-name')?.textContent === 'Spring promo', 3000, 'the editor with its name')
     return { offered, picked, name: s.project.name, size: s.project.width + '×' + s.project.height }`,
  )
  await step(
    'Title bar: double-click the project’s name to type a new one; Enter keeps it (saved, in Home’s list too), Esc leaves it as it was',
    `const span = await __t.until(() => __t.q('.titlebar .project-name'), 3000, 'the name in the title bar')
     const before = span.textContent
     const type = async (text, key) => {
       __t.q('.titlebar .project-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
       const input = await __t.until(() => __t.q('.titlebar input.project-name-edit'), 2000, 'the name to open for typing')
       await __t.until(() => document.activeElement === input && input.selectionEnd === input.value.length && input.selectionStart === 0, 2000, 'the name selected to type over')
       const offered = input.value
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
       input.dispatchEvent(new Event('input', { bubbles: true }))
       input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
       await __t.until(() => !__t.q('.titlebar input.project-name-edit') && __t.q('.titlebar .project-name'), 2000, 'the field to close')
       return offered
     }
     const offered = await type('Spring promo v2', 'Enter')
     const s = await __t.until(async () => { const x = await __t.snap(); return x.project.name === 'Spring promo v2' && x }, 5000, 'the new name')
     await __t.until(() => __t.q('.titlebar .project-name').textContent === 'Spring promo v2' && document.title.startsWith('Spring promo v2'), 2000, 'the title bar to show it')
     await type('Not this', 'Escape')
     await __t.sleep(300)
     const kept = (await __t.snap()).project.name
     if (kept !== 'Spring promo v2' || __t.q('.titlebar .project-name').textContent !== kept) throw new Error('Esc changed it to ' + kept)
     const listed = (await window.studio.app.projects([s.dir])).find((p) => p.dir === s.dir)?.name
     if (listed !== 'Spring promo v2') throw new Error('Home lists it as ' + listed)
     return { before, offered, after: kept, listed, windowTitle: document.title }`,
  )

  // The window can't be made smaller than its smallest size, and the layout still fits there.
  const tiny ='window: it can’t be made smaller than its smallest size, and everything still fits there'
  if (!only || only.test(tiny)) {
    const was = win.getSize()
    try {
      win.setSize(400, 300)
      await new Promise((r) => setTimeout(r, 500))
      const [w, h] = win.getSize()
      if (w < MIN_WINDOW.width || h < MIN_WINDOW.height) throw new Error(`it went down to ${w} × ${h}`)
      await shot('22-smallest-window')
      const fit = await js(`const de = document.documentElement
        const seen = (q) => { const el = __t.q(q); if (!el) return false; const r = __t.rect(el); return r.width > 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 }
        return { w: innerWidth, h: innerHeight, sideways: de.scrollWidth > innerWidth + 1, down: de.scrollHeight > innerHeight + 1, exportButton: seen('.export-button, .titlebar .primary, button[aria-label="Export"]'), timeline: seen('.tl-toolbar, .timeline .tl-tools, .tl-content') }`)
      if (fit.sideways || fit.down) throw new Error('the page scrolls at ' + w + ' × ' + h + ': ' + JSON.stringify(fit))
      results.push({ step: tiny, ok: true, detail: { size: [w, h], ...fit } })
      console.log(`[ui-check] ok   ${tiny} ${JSON.stringify({ size: [w, h], ...fit })}`)
    } catch (e) {
      results.push({ step: tiny, ok: false, detail: (e as Error).message })
      console.log(`[ui-check] FAIL ${tiny}: ${(e as Error).message}`)
    } finally {
      win.setSize(was[0], was[1])
    }
  }

  const failed = results.filter((r) => !r.ok).length
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ date: new Date().toISOString(), results, consoleErrors: errors }, null, 2))
  console.log(`[ui-check] ${failed ? `${failed} step(s) failed` : 'all steps passed'}; ${errors.length} console error(s)`)
  for (const e of errors) console.log(`[ui-check] console error: ${e}`)
  return failed === 0 && errors.length === 0
}
