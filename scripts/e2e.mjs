// Engine end-to-end on real footage (no Electron): new project, import, derived files,
// timeline edits, seek, play, split, undo, export 9:16 + 4:5 (and the sound as MP3 + WAV), then check the files.
// Usage: node scripts/e2e.mjs [folder-with-clips]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const work = join(os.tmpdir(), `studio-e2e-${process.pid}`)
mkdirSync(work, { recursive: true })
const socket = isWin ? `\\\\.\\pipe\\studio-e2e-${process.pid}` : join(work, 'engine.sock')
const ring = join(work, 'preview.ring')
const exe = process.env.STUDIO_ENGINE ?? join(root, 'target', 'release', isWin ? 'studio-engine.exe' : 'studio-engine')
const { PreviewRing } = createRequire(import.meta.url)(join(root, 'apps', 'desktop', 'native', 'studio_bridge.node'))

// Footage to test with: a folder given on the command line or in STUDIO_TEST_CLIPS (its first
// three videos, sorted by path); without one, three short test clips are made.
const clipDir = process.argv[2] ?? process.env.STUDIO_TEST_CLIPS ?? ''
const videos = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((n) => /\.(mp4|mov|m4v|mkv|webm)$/i.test(n)).sort().map((n) => join(dir, n)) : [])
let clips = clipDir ? videos(clipDir).slice(0, 3) : []
if (clips.length < 3) {
  // No footage on this machine (e.g. CI): make three short test clips.
  clips = [0, 1, 2].map((i) => {
    const out = join(work, `clip${i}.mp4`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30:duration=4`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 200}:duration=4`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', out])
    return out
  })
}
/** The processes `pid` started. */
const childrenOf = (pid) => {
  const out = isWin
    ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').ProcessId`], { encoding: 'utf8' }).stdout
    : spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout
  return (out ?? '').split(/\s+/).filter(Boolean).map(Number)
}
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The engine's FFmpeg ends with the engine, however the engine ends: an engine of its own
 * plays a clip, is killed outright mid-playback, and none of its FFmpeg may be left running
 * (on Windows they used to stay, stuck writing into a pipe nobody read).
 */
async function childrenDieWithEngine() {
  const at = isWin ? `\\\\.\\pipe\\studio-e2e-kill-${process.pid}` : join(work, 'kill.sock')
  const e = spawn(exe, ['--socket', at, '--ring', join(work, 'kill.ring'), '--projects-dir', join(work, 'kill-projects'), '--user-data', join(work, 'kill-data')], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, STUDIO_SILENT: '1' } })
  let s = null
  for (let i = 0; i < 80 && !s; i++) {
    s = await new Promise((r) => {
      const c = net.connect(at)
      c.once('connect', () => r(c))
      c.once('error', () => r(null))
    })
    if (!s) await new Promise((r) => setTimeout(r, 100))
  }
  if (!s) throw new Error('the second engine never answered')
  s.setEncoding('utf8')
  let pending = ''
  let n = 0
  const replies = new Map()
  s.on('data', (d) => {
    pending += d
    for (let nl; (nl = pending.indexOf('\n')) >= 0; pending = pending.slice(nl + 1)) {
      const m = JSON.parse(pending.slice(0, nl))
      if (m.id != null) replies.get(m.id)?.(m)
    }
  })
  const ask = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const k = ++n
      replies.set(k, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      s.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n')
    })
  await ask('project.new', { name: 'E2E kill', aspect: '9:16' })
  const imp = await ask('media.import', { paths: [clips[0]] })
  await ask('timeline.insert', { mediaId: imp.imported[0] })
  await ask('playback.play')
  let kids = []
  for (let i = 0; i < 50 && !kids.length; i++) {
    await new Promise((r) => setTimeout(r, 100))
    kids = childrenOf(e.pid)
  }
  s.destroy()
  e.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 1500))
  const left = kids.filter(running)
  for (const pid of left) process.kill(pid)
  check(kids.length > 0 && left.length === 0, `killing the engine mid-playback ends its ${kids.length} FFmpeg process${kids.length === 1 ? '' : 'es'}${left.length ? ` (${left.length} ${left.length === 1 ? 'was' : 'were'} left running)` : ''}`)
}

const voice = join(work, 'voiceover.wav')
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-y', voice])

let failed = false
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failed = true
}

// Silent: playback runs on the real sound device's clock without playing through the speakers.
// Its own user data folder, so the app's engine.json (how MCP finds a running engine) is never touched.
const userData = join(work, 'user-data')
const engine = spawn(exe, ['--socket', socket, '--ring', ring, '--projects-dir', join(work, 'projects'), '--user-data', userData, '--exit-on-stdin-eof'], { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, STUDIO_SILENT: '1' } })
const sock = await (async () => {
  for (let i = 0; i < 80; i++) {
    const s = await new Promise((r) => {
      const c = net.connect(socket)
      c.once('connect', () => r(c))
      c.once('error', () => r(null))
    })
    if (s) return s
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('engine socket never appeared')
})()
sock.setEncoding('utf8')
let buf = ''
let id = 0
const waiting = new Map()
const listeners = []
let latest = null
sock.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
    if (msg.id != null) waiting.get(msg.id)?.(msg)
    else {
      if (msg.method === 'project.changed') latest = msg.params
      for (const l of [...listeners]) l(msg)
    }
  }
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id
    waiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
const waitFor = (pred, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    const l = (msg) => {
      if (pred(msg)) {
        clearTimeout(t)
        listeners.splice(listeners.indexOf(l), 1)
        resolve(msg)
      }
    }
    listeners.push(l)
  })

try {
  const caps = await call('engine.capabilities')
  check(!!caps.ffmpeg, `FFmpeg found (NVENC ${caps.nvenc ? 'yes' : 'no'}, audio ${caps.audioDevice ?? 'none'})`)

  let snap = await call('project.new', { name: 'E2E Promo', aspect: '9:16' })
  check(snap.project.name === 'E2E Promo', 'new project created')

  const t0 = performance.now()
  const imp = await call('media.import', { paths: [...clips, voice, join(work, 'not-a-file.mp4')] })
  check(imp.imported.length === 4 && imp.failed.length === 1, `imported 4, rejected 1 bad path (${(performance.now() - t0).toFixed(0)} ms)`)

  await waitFor((m) => m.method === 'project.changed' && m.params.processing.length === 0, 120_000, 'media processing')
  const media = latest.project.media
  const videos = media.filter((m) => m.kind === 'video')
  check(videos.every((m) => m.poster && m.proxy && existsSync(m.proxy)), `posters and proxies for ${videos.length} videos (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  // The library draws posters only: filmstrips and waveforms wait for the timeline.
  check(media.every((m) => !m.strip && !m.peaks), 'no filmstrips or waveforms for files only in the library')

  for (const v of videos) await call('timeline.insert', { mediaId: v.id })
  const vo = media.find((m) => m.kind === 'audio')
  await call('timeline.insert', { mediaId: vo.id, atUs: 500_000 })
  await waitFor((m) => m.method === 'project.changed' && m.params.processing.length === 0 && m.params.project.media.every((x) => (x.kind !== 'video' || x.strip) && (!x.hasAudio || x.peaks)), 120_000, 'the timeline’s filmstrips and waveforms')
  check(true, 'filmstrips and waveforms once the files are on the timeline')
  snap = await call('project.current')
  const main = snap.project.tracks.find((t) => t.main)
  check(main.clips.length === 3 && snap.project.tracks.length === 2, `timeline: 3 clips on the main track + 1 audio track (${(snap.durationUs / 1e6).toFixed(1)} s)`)

  const reader = new PreviewRing(ring)
  const target = Buffer.alloc(reader.slotBytes())
  let last = 0
  const before = reader.readLatest(target, 0)
  last = before?.seq ?? 0
  const s0 = performance.now()
  await call('playback.seek', { positionUs: 2_500_000 })
  let frame = null
  while (!frame && performance.now() - s0 < 5000) {
    frame = reader.readLatest(target, last)
    await new Promise((r) => setTimeout(r, 5))
  }
  check(frame && frame.width === 540 && frame.height === 960, `seek shows a 540×960 frame in ${(performance.now() - s0).toFixed(0)} ms`)
  last = frame?.seq ?? last

  await call('playback.play', { fromUs: 0 })
  let shown = 0
  const p0 = performance.now()
  while (performance.now() - p0 < 2000) {
    const f = reader.readLatest(target, last)
    if (f) {
      shown++
      last = f.seq
    }
    await new Promise((r) => setTimeout(r, 4))
  }
  const status = await call('playback.pause')
  check(shown >= 50, `playback: ${shown} frames in 2 s, clock at ${(status.positionUs / 1e6).toFixed(2)} s`)

  await call('timeline.split', { atUs: 1_000_000 })
  snap = await call('project.current')
  check(snap.project.tracks.find((t) => t.main).clips.length === 4, 'split at 1 s')
  await call('edit.undo')
  snap = await call('project.current')
  check(snap.project.tracks.find((t) => t.main).clips.length === 3, 'undo restores it')

  // Compound clip: two clips rendered into one, then broken apart again.
  let mainClips = snap.project.tracks.find((t) => t.main).clips
  const c0 = performance.now()
  const cc = await call('timeline.compound', { clipIds: [mainClips[0].id, mainClips[1].id] })
  snap = await call('project.current')
  const joined = snap.project.tracks.find((t) => t.main).clips
  const want = mainClips[0].durationUs + mainClips[1].durationUs
  check(joined.length === 2 && joined[0].id === cc.clipId && Math.abs(joined[0].durationUs - want) < 100_000, `compound clip of 2 clips (${(want / 1e6).toFixed(1)} s) rendered in ${((performance.now() - c0) / 1000).toFixed(1)} s`)
  await call('timeline.breakCompound', { clipId: cc.clipId })
  snap = await call('project.current')
  check(snap.project.tracks.find((t) => t.main).clips.map((c) => c.mediaId).join() === mainClips.map((c) => c.mediaId).join(), 'breaking it apart puts the clips back')
  mainClips = snap.project.tracks.find((t) => t.main).clips

  // Text removal's engine side: cut just the part a clip uses, then point the clip at a new file.
  const part = join(work, 'cleaned', 'part.mp4')
  const used = mainClips[0]
  await call('media.extractRange', { mediaId: used.mediaId, inUs: used.inUs, durationUs: used.durationUs, out: part })
  const partDur = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', part]).toString()).format.duration)
  check(Math.abs(partDur - used.durationUs / 1e6) < 0.2, `cut the clip's used part: ${partDur.toFixed(2)} s for a ${(used.durationUs / 1e6).toFixed(2)} s clip`)
  const partMedia = (await call('media.import', { paths: [part] })).imported[0]
  await call('clip.replaceMedia', { clipId: used.id, mediaId: partMedia })
  snap = await call('project.current')
  const swapped = snap.project.tracks.find((t) => t.main).clips[0]
  check(swapped.mediaId === partMedia && swapped.inUs === 0 && Math.abs(swapped.durationUs - used.durationUs) < 100_000, 'the clip now plays the new file from its start')
  await call('edit.undo')
  snap = await call('project.current')

  // Paste a copy of the first clip at the start.
  await call('clips.paste', { items: [{ clip: mainClips[0], main: true, offsetUs: 0 }], atUs: 0 })
  snap = await call('project.current')
  check(snap.project.tracks.find((t) => t.main).clips.length === 4, 'paste puts a copy on the main track')
  await call('edit.undo')
  snap = await call('project.current')

  const out = join(work, 'exports')
  const e0 = performance.now()
  const started = await call('export.start', { formats: ['9:16', '4:5'], quality: 'balanced', folder: out, baseName: 'E2E' })
  const done = []
  while (done.length < 2) {
    const m = await waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 180_000, 'export')
    if (m.method === 'export.failed') throw new Error(`export failed: ${m.params.error}`)
    done.push(m.params)
  }
  for (const d of done) {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', d.path]).toString())
    const v = probe.streams.find((s) => s.codec_type === 'video')
    const a = probe.streams.find((s) => s.codec_type === 'audio')
    const dur = Number(probe.format.duration)
    check(v && a && Math.abs(dur - snap.durationUs / 1e6) < 0.25, `${d.path.split(/[\\/]/).pop()}: ${v?.width}×${v?.height} ${v?.codec_name}, ${a?.codec_name}, ${dur.toFixed(2)} s, ${(d.bytes / 1e6).toFixed(1)} MB in ${d.seconds.toFixed(1)} s (${d.encoder})`)
  }
  console.log(`export total ${((performance.now() - e0) / 1000).toFixed(1)} s for ${started.jobs.length} formats`)

  // The sound alone: MP3 and WAV, each the whole timeline with no picture, levelled as the video.
  {
    const a0 = performance.now()
    const r = await call('export.start', { formats: ['mp3', 'wav'], folder: out, baseName: 'E2E-sound' })
    check(r.jobs.map((j) => `${j.sound} ${j.path.split(/[\\/]/).pop()}`).join(', ') === 'mp3 E2E-sound.mp3, wav E2E-sound.wav', `sound export names: ${r.jobs.map((j) => j.path.split(/[\\/]/).pop()).join(', ')}`)
    for (let n = 0; n < 2; n++) {
      const m = await waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 120_000, 'the sound export')
      if (m.method === 'export.failed') throw new Error(`sound export failed: ${m.params.error}`)
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', m.params.path]).toString())
      const a = probe.streams.find((s) => s.codec_type === 'audio')
      const dur = Number(probe.format.duration)
      const want = m.params.path.endsWith('.mp3') ? 'mp3' : 'pcm_s24le'
      const lufs = (() => {
        const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', m.params.path, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
        return Number(log.slice(log.lastIndexOf('Summary:')).match(/I:\s+(-?[\d.]+)/)?.[1])
      })()
      check(a?.codec_name === want && a.sample_rate === '48000' && !probe.streams.some((s) => s.codec_type === 'video') && Math.abs(dur - snap.durationUs / 1e6) < 0.25 && Math.abs(lufs + 14) < 1.5, `${m.params.path.split(/[\\/]/).pop()}: ${a?.codec_name} ${a?.sample_rate} Hz, ${dur.toFixed(2)} s, ${lufs} LUFS, ${(m.params.bytes / 1e6).toFixed(2)} MB (${m.params.encoder})`)
    }
    console.log(`sound export ${((performance.now() - a0) / 1000).toFixed(1)} s`)
  }

  // A clip split in two reads its file twice: that export used to stall FFmpeg for good
  // (picture and sound shared one input). It must finish, with picture and sound.
  {
    const first = snap.project.tracks.find((t) => t.main).clips[0]
    await call('timeline.split', { atUs: first.startUs + Math.round(first.durationUs / 2), clipIds: [first.id] })
    const s0 = performance.now()
    await call('export.start', { formats: ['9:16'], quality: 'fast', folder: out, baseName: 'E2E-split' })
    const m = await waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 60_000, 'the export of a split clip')
    const probe = m.method === 'export.done' ? JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', m.params.path]).toString()) : null
    check(m.method === 'export.done' && probe.streams.some((x) => x.codec_type === 'audio'), `a split clip exports: ${m.method === 'export.done' ? `${((performance.now() - s0) / 1000).toFixed(1)} s` : m.params.error}`)
    await call('edit.undo')
  }

  // Export only a selection: the second main clip.
  const second = snap.project.tracks.find((t) => t.main).clips[1]
  await call('export.start', { formats: ['9:16'], quality: 'fast', folder: out, baseName: 'E2E-selection', clipIds: [second.id] })
  const sel = await waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 180_000, 'the selection export')
  if (sel.method === 'export.failed') throw new Error(`selection export failed: ${sel.params.error}`)
  const selDur = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', sel.params.path]).toString()).format.duration)
  check(Math.abs(selDur - second.durationUs / 1e6) < 0.25, `export selection: ${selDur.toFixed(2)} s file for a ${(second.durationUs / 1e6).toFixed(2)} s clip`)

  // The Audio page's engine side: track mix and effects, loudness, levels, spectrogram,
  // loop playback, the master stage on export, and the "Fix and tidy" tools.
  const lufsOf = (file) => {
    const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    return Number(log.slice(log.lastIndexOf('Summary:')).match(/I:\s+(-?[\d.]+)/)?.[1])
  }
  const exported = done.find((d) => d.path.includes('1080x1920'))?.path
  const exportedLufs = exported ? lufsOf(exported) : NaN
  check(Math.abs(exportedLufs + 14) < 1.5, `export is levelled by the master stage: ${exportedLufs} LUFS`)
  snap = await call('project.current')
  const voTrack = snap.project.tracks.find((t) => !t.main)
  await call('track.set', { trackId: voTrack.id, gainDb: -6, pan: -0.3, effects: { comp: { on: true, ratio: 4 }, eq: { on: true }, limiter: { on: true } } })
  snap = await call('project.current')
  const mixed = snap.project.tracks.find((t) => t.id === voTrack.id)
  check(mixed.gainDb === -6 && mixed.effects.comp.on && mixed.effects.comp.ratio === 4 && mixed.effects.comp.thresholdDb === -18, 'track fader, pan and effects saved on the track')
  await call('playback.play', { fromUs: 0 })
  await new Promise((r) => setTimeout(r, 600))
  const playingFx = await call('playback.pause')
  check(playingFx.positionUs > 100_000, `playback runs through the track effects (clock at ${(playingFx.positionUs / 1e6).toFixed(2)} s)`)

  const l0 = performance.now()
  const loudCall = await call('audio.loudness')
  const loud = loudCall.pending ? (await waitFor((m) => m.method === 'audio.loudness' || m.method === 'audio.failed', 60_000, 'the loudness')).params : loudCall
  check(typeof loud.integrated === 'number' && typeof loud.truePeak === 'number' && loud.short.length > 10, `loudness of the mix: ${loud.integrated} LUFS, LRA ${loud.lra} LU, true peak ${loud.truePeak} dBTP, ${loud.short.length} short-term points (${(performance.now() - l0).toFixed(0)} ms)`)
  check((await call('audio.loudness')).integrated === loud.integrated, 'the same mix is measured once')

  const voMedia = media.find((m) => m.kind === 'audio')
  for (const what of ['levels', 'spectrogram']) {
    const r = await call(`audio.${what}`, { mediaId: voMedia.id })
    const got = r.pending ? (await waitFor((m) => (m.method === `audio.${what}` || m.method === 'audio.failed') && m.params.mediaId === voMedia.id, 60_000, what)).params : r
    check(got.path && existsSync(got.path), `${what} cached at ${got.path?.split(/[\\/]/).slice(-2).join('/')}`)
  }

  // Loop playback: 0.5–1.5 s, played for 2.5 s, never leaves the region and comes round again.
  await call('playback.setLoop', { startUs: 500_000, endUs: 1_500_000 })
  const positions = []
  const onPos = (m) => m.method === 'playback.position' && positions.push(m.params.positionUs)
  listeners.push(onPos)
  await call('playback.play', { fromUs: 500_000 })
  await new Promise((r) => setTimeout(r, 2500))
  listeners.splice(listeners.indexOf(onPos), 1)
  await call('playback.pause')
  const wraps = positions.filter((p, i) => i > 0 && p < positions[i - 1]).length
  check(positions.length > 20 && positions.every((p) => p >= 500_000 && p < 1_500_000) && wraps >= 1, `loop playback: ${positions.length} frames inside 0.5–1.5 s, round ${wraps} time${wraps === 1 ? '' : 's'}`)
  const cleared = await call('playback.setLoop', {})
  check(cleared.loop === null, 'loop cleared')

  // A voice with a pause in the middle (silent from 1 to 2 s), on a track of its own.
  const pausy = join(work, 'pausy.wav')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-af', "volume=12dB,volume='if(between(t,1,2),0,1)':eval=frame", '-y', pausy])
  const pausyId = (await call('media.import', { paths: [pausy] })).imported[0]
  const tracksBefore = (await call('project.current')).project.tracks.length
  const pausyClip = await call('timeline.insertNewTrack', { mediaId: pausyId, atUs: 0 })
  snap = await call('project.current')
  check(snap.project.tracks.length === tracksBefore + 1, 'a sound file on a new track of its own')
  const split = await call('audio.splitAtSilences', { clipIds: [pausyClip] })
  check(split.clipIds.length === 2, `split at silences: ${split.clipIds.length} phrases`)
  await call('edit.undo')
  const labelled = await call('audio.labelSounds', { clipIds: [pausyClip] })
  snap = await call('project.current')
  check(labelled.length === 2 && snap.project.labels.length === 2, `label sounds: ${snap.project.labels.map((l) => `${l.text} ${(l.startUs / 1e6).toFixed(1)}–${(l.endUs / 1e6).toFixed(1)} s`).join(', ')}`)
  const norm = await call('audio.normalize', { clipIds: [pausyClip], mode: 'peak' })
  check(Math.abs(norm.clips[0].measured + 6) < 0.5 && Math.abs(norm.clips[0].volume - 10 ** (5 / 20)) < 0.1, `normalise peak: ${norm.clips[0].measured} dBFS → volume ${norm.clips[0].volume.toFixed(2)}`)
  await call('clip.set', { clipId: pausyClip, fadeInUs: 300_000, fadeOutUs: 400_000, fadeCurve: 'scurve' })
  snap = await call('project.current')
  const faded = snap.project.tracks.flatMap((t) => t.clips).find((c) => c.id === pausyClip)
  check(faded.fadeInUs === 300_000 && faded.fadeOutUs === 400_000 && faded.fadeCurve === 'scurve', 'fade in and out on the clip')
  const removed = await call('audio.removeSilences', { clipIds: [pausyClip] })
  snap = await call('project.current')
  const shortened = snap.project.tracks.flatMap((t) => t.clips).filter((c) => removed.clipIds.includes(c.id)).reduce((s, c) => s + c.durationUs, 0)
  check(removed.clipIds.length === 2 && Math.abs(shortened - 2_200_000) < 150_000, `remove silences: ${(removed.removedUs / 1e6).toFixed(2)} s of pause out, ${(shortened / 1e6).toFixed(2)} s left`)

  // The master stage follows the switches: off, the export keeps the mix's own level.
  await call('project.setMaster', { normalize: false, limiter: false })
  await call('export.start', { formats: ['9:16'], quality: 'fast', folder: out, baseName: 'E2E-unlevelled', clipIds: removed.clipIds })
  const raw = await waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 180_000, 'the unlevelled export')
  const rawLufs = raw.method === 'export.done' ? lufsOf(raw.params.path) : NaN
  check(rawLufs > -11, `master normalisation off: the export stays at ${rawLufs} LUFS`)
  await call('project.setMaster', { normalize: true, limiter: true })

  const nm = await call('audio.normalizeMix', { targetLufs: -14 })
  const after = await call('audio.loudness')
  const afterLoud = after.pending ? (await waitFor((m) => m.method === 'audio.loudness', 60_000, 'the new loudness')).params : after
  check(Math.abs(afterLoud.integrated + 14) < 0.6, `normalise the mix: ${nm.measured.toFixed(1)} LUFS + ${nm.gainDb} dB → ${afterLoud.integrated} LUFS`)

  // The clip's look, speed, direction and keyframes, freeze frame, history, locks and the
  // export options, on a clip that brightens from black to white over 2 s, so time order
  // shows in the picture. Its sound is noise, so the AAC encoder uses all the bitrate it can:
  // asked for 320k, FFmpeg's own encoder makes about 245k of stereo (asked for 192k, 192k).
  const ramp = join(work, 'ramp.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=white:s=360x640:r=30:d=2,geq=lum='255*T/2':cb=128:cr=128", '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=pink:a=0.3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-y', ramp])
  await call('project.new', { name: 'E2E Look', aspect: '9:16' })
  const [rampId, detailId] = (await call('media.import', { paths: [ramp, clips[0]] })).imported
  const rampClip = await call('timeline.insert', { mediaId: rampId })
  const lookOut = join(work, 'look')
  const exportNow = async (base, extra = {}) => {
    const done = waitFor((x) => ['export.done', 'export.failed'].includes(x.method), 180_000, `the ${base} export`)
    await call('export.start', { formats: ['9:16'], quality: 'fast', folder: lookOut, baseName: base, ...extra })
    const m = await done
    if (m.method === 'export.failed') throw new Error(`${base} export failed: ${m.params.error}`)
    return m.params.path
  }
  const probeOf = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString())
  const durOf = (file) => Number(probeOf(file).format.duration)
  // Mean R, G, B of the frame at `t` s (or of a part of it: an FFmpeg crop).
  const rgbAt = (file, t, crop = '') => {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `${crop}scale=36:64,format=rgb24`, '-f', 'rawvideo', '-'])
    const sum = [0, 0, 0]
    for (let i = 0; i < raw.length; i++) sum[i % 3] += raw[i]
    return sum.map((s) => s / (raw.length / 3))
  }
  const lum = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3
  const LEFT = 'crop=iw/4:ih:0:0,'
  const RIGHT = 'crop=iw/4:ih:iw*3/4:0,'
  // The paused frame in the preview ring after a seek (mean of its red channel).
  const seekMean = async (positionUs) => {
    await new Promise((r) => setTimeout(r, 500)) // let the frame an edit asks for land first
    const from = reader.readLatest(target, 0)?.seq ?? 0
    await call('playback.seek', { positionUs })
    const s0 = performance.now()
    let f = null
    while (performance.now() - s0 < 5000) {
      f = reader.readLatest(target, from)
      if (f && f.ptsUs === positionUs) break
      await new Promise((r) => setTimeout(r, 5))
    }
    if (!f) return NaN
    let sum = 0
    for (let i = 0; i < f.width * f.height * 4; i += 4) sum += target[i]
    return sum / (f.width * f.height)
  }

  const plain = await exportNow('look-plain')
  const [plainEarly, plainLate] = [lum(rgbAt(plain, 0.1)), lum(rgbAt(plain, 1.8))]
  check(Math.abs(durOf(plain) - 2) < 0.15 && plainLate > plainEarly + 120, `look: the ramp exports dark to bright, ${plainEarly.toFixed(0)} → ${plainLate.toFixed(0)}`)

  await call('clip.set', { clipIds: [rampClip], speed: 2 })
  snap = await call('project.current')
  const fastClip = snap.project.tracks.find((t) => t.main).clips[0]
  const fast = await exportNow('look-speed')
  const fastAudio = Number(probeOf(fast).streams.find((s) => s.codec_type === 'audio')?.duration)
  check(fastClip.durationUs === 1_000_000 && Math.abs(durOf(fast) - 1) < 0.1 && Math.abs(fastAudio - 1) < 0.1 && Math.abs(lum(rgbAt(fast, 0.45)) - lum(rgbAt(plain, 0.9))) < 25, `speed 2: a ${fastClip.durationUs / 1e6} s clip, ${durOf(fast).toFixed(2)} s export (sound ${fastAudio.toFixed(2)} s), 0.45 s in shows the source's 0.9 s`)

  await call('clip.set', { clipIds: [rampClip], speed: 1, reverse: true })
  const back = await exportNow('look-reverse')
  const [backEarly, backLate] = [lum(rgbAt(back, 0.1)), lum(rgbAt(back, 1.8))]
  check(Math.abs(durOf(back) - 2) < 0.15 && backEarly > backLate + 120 && Math.abs(backEarly - plainLate) < 25, `reverse: ${backEarly.toFixed(0)} → ${backLate.toFixed(0)}; its first frame is the forward export's end (${plainLate.toFixed(0)})`)
  const [pausedBack, pausedFwd] = [await seekMean(100_000), (await call('clip.set', { clipIds: [rampClip], reverse: false }), await seekMean(100_000))]
  check(pausedBack > pausedFwd + 120, `paused frame at 0.1 s: ${pausedBack.toFixed(0)} reversed, ${pausedFwd.toFixed(0)} forwards`)

  await call('clip.set', { clipIds: [rampClip], brightness: 60, temperature: 80 })
  const graded = await exportNow('look-colour')
  const [g, g0] = [rgbAt(graded, 1.0), rgbAt(plain, 1.0)]
  check(lum(g) > lum(g0) + 15 && g[0] > g[2] + 10, `colour: brightness lifts the mean ${lum(g0).toFixed(0)} → ${lum(g).toFixed(0)}; warmth makes it red over blue (${g.map(Math.round).join('/')})`)

  await call('clip.set', { clipIds: [rampClip], brightness: 0, temperature: 0, scale: 50, opacity: 50 })
  const small = await exportNow('look-transform')
  const [s1, p1] = [lum(rgbAt(small, 1.8)), plainLate]
  check(Math.abs(s1 - p1 / 8) < 12, `scale 50 % at 50 % opacity over black: ${s1.toFixed(0)} (an eighth of ${p1.toFixed(0)} is ${(p1 / 8).toFixed(0)})`)

  // Keyframes: dark until 1 s, faded in by 1.5 s, then sliding right.
  const keyframes = { opacity: [{ atUs: 0, value: 0 }, { atUs: 1_000_000, value: 0 }, { atUs: 1_500_000, value: 100 }], posX: [{ atUs: 1_500_000, value: 0 }, { atUs: 2_000_000, value: 540 }] }
  await call('clip.set', { clipIds: [rampClip], scale: 100, opacity: 100, keyframes })
  const keyed = await exportNow('look-keyframes')
  const [k10, kl155, kl19, kr19] = [lum(rgbAt(keyed, 1.0)), lum(rgbAt(keyed, 1.55, LEFT)), lum(rgbAt(keyed, 1.9, LEFT)), lum(rgbAt(keyed, 1.9, RIGHT))]
  check(k10 < 8 && kl155 > kl19 + 80 && kr19 > 150, `keyframes: black at 1 s (${k10.toFixed(0)}); sliding right, the left edge goes ${kl155.toFixed(0)} → ${kl19.toFixed(0)} while the right stays ${kr19.toFixed(0)}`)
  const pausedKeyed = await seekMean(1_000_000)
  check(pausedKeyed < 8, `the paused frame follows keyframes too (${pausedKeyed.toFixed(0)} at 1 s)`)
  await call('playback.play', { fromUs: 1_200_000 })
  await new Promise((r) => setTimeout(r, 500))
  const playedKeyed = await call('playback.pause')
  check(playedKeyed.positionUs > 1_300_000, `playback from the middle of a keyframed clip (clock at ${(playedKeyed.positionUs / 1e6).toFixed(2)} s)`)

  let hist = await call('history.list')
  await call('clip.set', { clipIds: [rampClip], scale: 100 })
  check((await call('history.list')).steps.length === hist.steps.length, `a value already set leaves no undo step (${hist.steps.length} steps)`)

  await call('clip.set', { clipIds: [rampClip], keyframes: {} })
  const fr = await call('timeline.freezeFrame', { atUs: 1_000_000, clipIds: [rampClip] })
  snap = await call('project.current')
  const withFreeze = snap.project.tracks.find((t) => t.main).clips
  const frozenClip = withFreeze.find((c) => c.id === fr.clipId)
  const frozenMedia = snap.project.media.find((m) => m.id === frozenClip?.mediaId)
  check(withFreeze.length === 3 && frozenClip?.startUs === 1_000_000 && frozenClip.durationUs === 3_000_000 && frozenMedia?.kind === 'image' && existsSync(frozenMedia.path) && /[\\/]freeze[\\/]/.test(frozenMedia.path), `freeze frame: a 3 s still at 1 s from ${frozenMedia?.path.split(/[\\/]/).slice(-2).join('/')} (${frozenMedia?.width}×${frozenMedia?.height})`)
  const frozen = await exportNow('look-freeze')
  const [f15, f35, at1] = [lum(rgbAt(frozen, 1.5)), lum(rgbAt(frozen, 3.5)), lum(rgbAt(plain, 1.0))]
  check(Math.abs(durOf(frozen) - 5) < 0.15 && Math.abs(f15 - f35) < 3 && Math.abs(f15 - at1) < 15, `freeze export: ${durOf(frozen).toFixed(2)} s, held at ${f15.toFixed(0)} (the source at 1 s is ${at1.toFixed(0)})`)

  hist = await call('history.list')
  check(hist.steps.at(-1)?.label === 'Freeze frame' && hist.current === hist.steps.length - 1, `history: ${hist.steps.length} steps, the last "${hist.steps.at(-1)?.label}" by ${hist.steps.at(-1)?.actor}`)
  await call('history.goto', { index: hist.current - 1 })
  snap = await call('project.current')
  check(snap.project.tracks.find((t) => t.main).clips.length === 1 && (await call('history.list')).current === hist.current - 1, 'going back a step takes the freeze frame out')

  const named = await exportNow('unused', { names: { '9:16': 'Promo-9x16-v3' }, fps: 25 })
  const named2 = await exportNow('unused', { names: { '9:16': 'Promo-9x16-v3' } })
  const np = probeOf(named)
  const [nv, na] = [np.streams.find((s) => s.codec_type === 'video'), np.streams.find((s) => s.codec_type === 'audio')]
  check(/[\\/]Promo-9x16-v3\.mp4$/.test(named) && /[\\/]Promo-9x16-v3-2\.mp4$/.test(named2) && nv?.r_frame_rate === '25/1' && Number(na?.bit_rate) > 220_000, `export names, fps and sound: ${named.split(/[\\/]/).pop()}, then ${named2.split(/[\\/]/).pop()}; ${nv?.r_frame_rate} fps; AAC at ${Math.round(Number(na?.bit_rate) / 1000)} kb/s`)
  const detailClip = await call('timeline.insert', { mediaId: detailId })
  const rated = await exportNow('look-bitrate', { clipIds: [detailClip], bitrateMbps: 4 })
  const ratedMbps = Number(probeOf(rated).streams.find((s) => s.codec_type === 'video')?.bit_rate) / 1e6
  check(ratedMbps > 2 && ratedMbps < 6.5, `bitrate 4 Mbit/s asked, ${ratedMbps.toFixed(2)} Mbit/s made`)

  snap = await call('project.current')
  await call('track.set', { trackId: snap.project.tracks.find((t) => t.main).id, locked: true })
  const refused = await call('timeline.split', { atUs: 500_000 }).then(() => null, (e) => e.message)
  await call('edit.undo')
  const unlocked = await call('timeline.split', { atUs: 500_000 }).then(() => true, () => false)
  check(refused?.endsWith('The main track is locked') && unlocked, `a locked track refuses edits ("${refused}"), and undo unlocks it`)

  // Contract v2: picture tracks over the main one, transitions, adjustment layers, blend
  // modes, effects, masks, captions, and the Audio page's crossfade, spectral delete and
  // drawn samples, each checked in the exported pixels or sound; then MCP's engine side.
  const solid = (name, colour, secs = 2, freq = 440) => {
    const file = join(work, `${name}.mp4`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=360x640:r=30:d=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', file])
    return file
  }
  // A see-through picture at project size with one opaque box (pixels).
  const boxPng = (name, colour, x, y, w, h) => {
    const file = join(work, `${name}.png`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black@0:s=1080x1920,format=rgba', '-f', 'lavfi', '-i', `color=c=${colour}:s=${w}x${h},format=rgba`, '-filter_complex', `[0][1]overlay=${x}:${y}`, '-frames:v', '1', '-y', file])
    return file
  }
  const TL = 'crop=iw/4:ih/4:iw/8:ih/8,' // the middle of the top-left quarter
  const BR = 'crop=iw/4:ih/4:iw*5/8:ih*5/8,'
  const LEFTH = 'crop=iw/4:ih/2:iw/8:ih/4,'
  const RIGHTH = 'crop=iw/4:ih/2:iw*5/8:ih/4,'
  const near = (a, b, tol = 35) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
  const rgb = (c) => c.map(Math.round).join('/')
  const [RED, BLUE, WHITE] = [[254, 0, 0], [0, 0, 254], [255, 255, 255]]
  const grey = (c) => Math.max(...c) - Math.min(...c) < 30
  // The paused frame in the preview ring after a seek: mean RGB of a region (fractions).
  const seekRegion = async (positionUs, [x0, y0, x1, y1]) => {
    await new Promise((r) => setTimeout(r, 500))
    const from = reader.readLatest(target, 0)?.seq ?? 0
    await call('playback.seek', { positionUs })
    const s0 = performance.now()
    let f = null
    while (performance.now() - s0 < 8000) {
      f = reader.readLatest(target, from)
      if (f && f.ptsUs === positionUs) break
      await new Promise((r) => setTimeout(r, 5))
    }
    if (!f) return [NaN, NaN, NaN]
    const sum = [0, 0, 0]
    let n = 0
    for (let y = Math.floor(y0 * f.height); y < Math.floor(y1 * f.height); y++) {
      for (let x = Math.floor(x0 * f.width); x < Math.floor(x1 * f.width); x++) {
        const o = (y * f.width + x) * 4
        for (let c = 0; c < 3; c++) sum[c] += target[o + c]
        n++
      }
    }
    return sum.map((s) => s / n)
  }

  await call('project.new', { name: 'E2E Layers', aspect: '9:16' })
  const [redId, blueId] = (await call('media.import', { paths: [solid('red', 'red'), solid('blue', 'blue', 2, 880)] })).imported
  const effects = await call('engine.effects')
  const transitions = await call('engine.transitions')
  check(effects.length === 18 && effects.includes('Light leak') && transitions.length === 16 && transitions[0] === 'Dissolve', `engine.effects lists ${effects.length} effects, engine.transitions ${transitions.length} transitions`)
  const redClip = await call('timeline.insert', { mediaId: redId })

  // Text: the renderer's drawing, a white box over the top-left quarter, from 0.5 to 1.5 s.
  const textPng = boxPng('text', 'white', 0, 0, 540, 960)
  const txt = await call('text.add', { atUs: 500_000, durationUs: 1_000_000, text: { content: 'Hello', png: textPng, boxW: 540, boxH: 960 } })
  let f = await exportNow('v2-text')
  const [tx0, tx1, tx1o, tx2] = [rgbAt(f, 0.2, TL), rgbAt(f, 1.0, TL), rgbAt(f, 1.0, BR), rgbAt(f, 1.8, TL)]
  check(near(tx1, WHITE) && near(tx1o, RED) && near(tx0, RED) && near(tx2, RED) && Math.abs(durOf(f) - 2) < 0.1, `text overlay: white at its spot from 0.5 to 1.5 s (${rgb(tx1)}), red beside it (${rgb(tx1o)}), before (${rgb(tx0)}) and after (${rgb(tx2)})`)
  const pausedText = await seekRegion(1_000_000, [0.15, 0.15, 0.35, 0.35])
  const pausedBeside = await seekRegion(1_000_000, [0.65, 0.65, 0.85, 0.85])
  check(near(pausedText, WHITE, 40) && near(pausedBeside, RED, 40), `the paused frame shows the text too (${rgb(pausedText)} at its spot, ${rgb(pausedBeside)} beside it)`)
  const shot = await call('preview.frame', { atUs: 1_000_000, width: 270 })
  const shotTL = existsSync(shot.path) ? rgbAt(shot.path, 0, TL) : [0, 0, 0]
  check(shot.width === 270 && shot.height === 480 && near(shotTL, WHITE, 40), `preview.frame: a ${shot.width}×${shot.height} PNG of the composite (${rgb(shotTL)} where the text is)`)
  await call('track.set', { trackId: txt.trackId, hidden: true })
  f = await exportNow('v2-hidden')
  check(near(rgbAt(f, 1.0, TL), RED), `a hidden track is left out of the export (${rgb(rgbAt(f, 1.0, TL))})`)
  await call('track.set', { trackId: txt.trackId, hidden: false })

  // Blend: a blue box over the left half, multiplied with the red below it, is black.
  const blueBox = (await call('media.import', { paths: [boxPng('bluebox', 'blue', 0, 0, 540, 1920)] })).imported[0]
  const sticker = await call('overlay.add', { mediaId: blueBox, atUs: 0, durationUs: 2_000_000, role: 'sticker' })
  await call('clip.set', { clipId: sticker.clipId, blend: 'multiply' })
  f = await exportNow('v2-blend')
  const [bl, br] = [rgbAt(f, 1.8, LEFTH), rgbAt(f, 1.8, RIGHTH)]
  check(bl.every((v) => v < 30) && near(br, RED), `blend mode multiply: blue over red is black (${rgb(bl)}), red where there's no box (${rgb(br)})`)
  await call('timeline.delete', { clipIds: [sticker.clipId] })

  // An effect on the main clip: Invert turns red into cyan.
  await call('clip.set', { clipId: redClip, effects: [{ name: 'Invert', amount: 100 }] })
  f = await exportNow('v2-effect')
  const inv = rgbAt(f, 1.8, BR)
  check(near(inv, [0, 255, 255], 40), `effect Invert: red exports cyan (${rgb(inv)})`)
  await call('clip.set', { clipId: redClip, effects: [] })

  // A mask (the renderer's drawing): keep the left half; the right goes black.
  await call('clip.set', { clipId: redClip, mask: { shape: 'rect', x: 0, y: 0, w: 0.5, h: 1, rotation: 0, feather: 0, invert: false }, maskPng: boxPng('mask', 'white', 0, 0, 540, 1920) })
  f = await exportNow('v2-mask')
  const [ml, mr] = [rgbAt(f, 1.8, LEFTH), rgbAt(f, 1.8, RIGHTH)]
  check(near(ml, RED) && mr.every((v) => v < 25), `mask: the left half stays red (${rgb(ml)}), the right goes black (${rgb(mr)})`)
  await call('clip.set', { clipId: redClip, mask: null, maskPng: null })

  // Captions: burned in by default, left out with ".srt file".
  await call('captions.set', { lines: [{ startUs: 0, endUs: 2_000_000, text: 'Hello there', png: textPng }], style: { font: 'Inter', size: 64 } })
  const [burned, srt] = [await exportNow('v2-captions'), await exportNow('v2-captions-srt', { captions: '.srt file' })]
  check(near(rgbAt(burned, 1.8, TL), WHITE) && near(rgbAt(srt, 1.8, TL), RED), `captions: burned in (${rgb(rgbAt(burned, 1.8, TL))}), left out of the picture with ".srt file" (${rgb(rgbAt(srt, 1.8, TL))})`)

  // A transition: red into blue, dissolved over 1 s, keeps the 4 s.
  await call('project.new', { name: 'E2E Transition', aspect: '9:16' })
  const [r2, b2] = (await call('media.import', { paths: [join(work, 'red.mp4'), join(work, 'blue.mp4')] })).imported
  await call('timeline.insert', { mediaId: r2 })
  const blueClip = await call('timeline.insert', { mediaId: b2 })
  await call('transition.set', { clipId: blueClip, name: 'Dissolve', durationUs: 1_000_000 })
  f = await exportNow('v2-transition')
  const [x1, xm, x3] = [rgbAt(f, 1.0), rgbAt(f, 2.0), rgbAt(f, 3.0)]
  check(Math.abs(durOf(f) - 4) < 0.1 && near(x1, RED) && near(xm, [127, 0, 127], 40) && near(x3, BLUE), `transition: ${durOf(f).toFixed(2)} s; red (${rgb(x1)}), mixed at the cut (${rgb(xm)}), blue (${rgb(x3)})`)
  const pausedMix = await seekRegion(2_000_000, [0.2, 0.2, 0.8, 0.8])
  check(near(pausedMix, [127, 0, 127], 45), `the paused frame at the cut is the mix too (${rgb(pausedMix)})`)

  // An adjustment layer from 0.2 to 1.2 s: grey only inside it.
  const adj = await call('adjust.add', { atUs: 200_000, durationUs: 1_000_000 })
  await call('clip.set', { clipId: adj.clipId, saturation: -100 })
  f = await exportNow('v2-adjust')
  const [a0, a1, a2] = [rgbAt(f, 0.1), rgbAt(f, 0.7), rgbAt(f, 1.4)]
  check(near(a0, RED) && grey(a1) && near(a2, RED), `adjustment layer: red before (${rgb(a0)}), grey inside (${rgb(a1)}), red after (${rgb(a2)})`)

  // Sound: spectral delete, crossfade and drawn samples, measured in the export.
  const meanVol = (file, ss, t, af = '') => {
    const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', `${af}volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    const v = log.match(/mean_volume:\s*(-?[\d.]+|-inf)/)?.[1]
    return v === undefined || v === '-inf' ? -200 : Number(v)
  }
  const toneFile = (name, freq) => {
    const file = join(work, `${name}.wav`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`, '-af', 'volume=6dB', '-y', file])
    return file
  }
  await call('project.new', { name: 'E2E Sound', aspect: '9:16' })
  const [lowId, highId] = (await call('media.import', { paths: [toneFile('low', 440), toneFile('high', 1760)] })).imported
  const low = await call('timeline.insert', { mediaId: lowId, atUs: 0 })
  await call('audio.spectralDelete', { clipId: low, startUs: 1_000_000, endUs: 2_000_000, lowHz: 300, highHz: 600 })
  const high = await call('timeline.insertNewTrack', { mediaId: highId, atUs: 5_000_000 })
  await call('audio.crossfade', { clipIds: [low, high], durationUs: 1_000_000 })
  snap = await call('project.current')
  const highClip = snap.project.tracks.flatMap((t) => t.clips).find((c) => c.id === high)
  check(highClip.startUs === 3_000_000 && snap.project.tracks.find((t) => t.clips.some((c) => c.id === low)).clips.some((c) => c.id === high), 'crossfade: the second clip moved onto the first one\'s track, overlapping its last second')
  // Silence drawn over 0.5 s of the second tone, 2 s into its file (5 s on the timeline): the
  // Audio page draws in source time, mono at 48 kHz.
  const drawn = await call('audio.drawSamples', { clipId: high, atUs: 2_000_000, samples: new Array(24_000).fill(0) })
  check(existsSync(drawn.path) && /[\\/]edits[\\/]/.test(drawn.path), `drawn samples saved as ${drawn.path.split(/[\\/]/).slice(-2).join('/')}`)
  await call('edit.undo')
  const undrawn = (await call('project.current')).project.tracks.flatMap((t) => t.clips).find((c) => c.id === high)?.mediaId
  await call('edit.redo')
  const redrawn = (await call('project.current')).project.tracks.flatMap((t) => t.clips).find((c) => c.id === high)?.mediaId
  check(undrawn === highId && redrawn === drawn.mediaId, 'one undo puts the clip back on its own sound, redo on the drawn copy')
  await call('project.setMaster', { normalize: false, limiter: false })
  f = await exportNow('v2-sound')
  const [cut, kept] = [meanVol(f, 1.2, 0.6), meanVol(f, 2.2, 0.6)]
  check(kept - cut > 20, `spectral delete: 300–600 Hz out between 1 and 2 s, ${kept.toFixed(1)} → ${cut.toFixed(1)} dB`)
  const [lowIn, highIn, lowAfter] = [meanVol(f, 3.3, 0.4, 'bandpass=f=440:width_type=q:w=4,'), meanVol(f, 3.3, 0.4, 'bandpass=f=1760:width_type=q:w=4,'), meanVol(f, 4.5, 0.4, 'bandpass=f=440:width_type=q:w=4,')]
  check(Math.abs(durOf(f) - 7) < 0.1 && lowIn > -40 && highIn > -40 && lowAfter < lowIn - 12, `crossfade: ${durOf(f).toFixed(2)} s, both tones in the overlap (${lowIn.toFixed(1)} / ${highIn.toFixed(1)} dB), the first gone after it (${lowAfter.toFixed(1)} dB)`)
  const [hole, around] = [meanVol(f, 5.05, 0.4), meanVol(f, 5.7, 0.4)]
  check(around - hole > 30, `drawn samples: the silence drawn at 5 s is in the export (${around.toFixed(1)} → ${hole.toFixed(1)} dB)`)

  // Remove silences: the dry run (from the cached levels, fast enough for a slider) says
  // which ranges go; the real run removes exactly those.
  const pausy2 = (await call('media.import', { paths: [pausy] })).imported[0]
  const pz = await call('timeline.insertNewTrack', { mediaId: pausy2, atUs: 8_000_000 })
  const pzTrack = (await call('project.current')).project.tracks.find((t) => t.clips.some((c) => c.id === pz)).id
  const opts = { trackId: pzTrack, thresholdDb: -40, minUs: 400_000, keepUs: 50_000 }
  // The first run makes the levels; after that a dry run only reads them.
  await call('audio.removeSilences', { ...opts, dryRun: true })
  const d0 = performance.now()
  const dry = await call('audio.removeSilences', { ...opts, dryRun: true })
  const dryMs = performance.now() - d0
  const real = await call('audio.removeSilences', opts)
  const left = (await call('project.current')).project.tracks.find((t) => t.id === pzTrack).clips.reduce((n, c) => n + c.durationUs, 0)
  check(dry.ranges.length === 1 && JSON.stringify(dry.ranges) === JSON.stringify(real.ranges) && dry.removedUs === real.removedUs && left === 3_000_000 - real.removedUs, `remove silences: the dry run's ranges (${dry.ranges.map((r) => `${(r.startUs / 1e6).toFixed(2)}–${(r.endUs / 1e6).toFixed(2)} s`).join(', ')}) are what the real run removed, ${(real.removedUs / 1e6).toFixed(2)} s; a dry run takes ${dryMs.toFixed(0)} ms`)

  // Raw samples at the file's own rate: 20 ms of a 1 kHz sine at 44.1 kHz is 20 cycles.
  const sine = join(work, 'sine1k.wav')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=3', '-y', sine])
  const sineId = (await call('media.import', { paths: [sine] })).imported[0]
  const samp = await call('audio.samples', { mediaId: sineId, startUs: 1_000_000, endUs: 1_020_000 })
  const buf = Buffer.from(samp.data, 'base64')
  const wave = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  let crossings = 0
  for (let i = 1; i < wave.length; i++) if (wave[i - 1] < 0 !== wave[i] < 0) crossings++
  const tooLong = await call('audio.samples', { mediaId: sineId, startUs: 0, endUs: 2_500_000 }).then(() => false, () => true)
  check(samp.rate === 44_100 && Math.abs(wave.length - 882) <= 1 && Math.abs(crossings - 40) <= 1 && tooLong, `audio.samples: ${wave.length} samples at ${samp.rate} Hz, ${crossings / 2} cycles of the 1 kHz sine in 20 ms; more than 2 s refused`)

  // Cut a range out of a sound track (select and Ctrl+X): the track closes up, the linked
  // picture is cut the same way, and a later clip's sound stays under its picture.
  await call('project.new', { name: 'E2E Cut', aspect: '9:16' })
  const [cr, cb] = (await call('media.import', { paths: [join(work, 'red.mp4'), join(work, 'blue.mp4')] })).imported
  const vr = await call('timeline.insert', { mediaId: cr })
  const vb = await call('timeline.insert', { mediaId: cb })
  const extracted = await call('clip.extractAudio', { clipIds: [vr, vb] })
  snap = await call('project.current')
  const soundTrack = snap.project.tracks.find((t) => t.clips.some((c) => c.id === extracted.clipIds?.[0]))
  const cutRes = await call('audio.removeRange', { trackId: soundTrack.id, startUs: 500_000, endUs: 1_000_000 })
  snap = await call('project.current')
  const blueV = snap.project.tracks.find((t) => t.main).clips.find((c) => c.id === vb)
  const blueA = snap.project.tracks.flatMap((t) => t.clips).find((c) => c.id === extracted.clipIds[1])
  const cutLabel = (await call('history.list')).steps.at(-1).label
  check(extracted.clipIds.length === 2 && cutRes.removedUs === 500_000 && snap.durationUs === 3_500_000 && blueV.startUs === 1_500_000 && blueA.startUs === 1_500_000 && cutLabel === 'Cut 0.50 s', `audio.removeRange: "${cutLabel}" made it ${(snap.durationUs / 1e6).toFixed(2)} s; the blue clip and its sound both start at ${(blueV.startUs / 1e6).toFixed(2)} s`)
  await call('project.setMaster', { normalize: false, limiter: false })
  f = await exportNow('v2-cut')
  const [p25, hi25, lo25] = [rgbAt(f, 2.5), meanVol(f, 2.3, 0.4, 'bandpass=f=880:width_type=q:w=4,'), meanVol(f, 2.3, 0.4, 'bandpass=f=440:width_type=q:w=4,')]
  check(Math.abs(durOf(f) - 3.5) < 0.1 && near(p25, BLUE) && hi25 > lo25 + 15, `after the cut, the export at 2.5 s is blue (${rgb(p25)}) with the blue clip's 880 Hz (${hi25.toFixed(1)} dB against 440 Hz at ${lo25.toFixed(1)} dB)`)

  // MCP's engine side: a second connection says hello, its edits carry its actor.
  const mcpSock = await new Promise((r) => {
    const c = net.connect(socket)
    c.once('connect', () => r(c))
  })
  mcpSock.setEncoding('utf8')
  let mcpBuf = ''
  const mcpWaiting = new Map()
  mcpSock.on('data', (d) => {
    mcpBuf += d
    let nl
    while ((nl = mcpBuf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(mcpBuf.slice(0, nl))
      mcpBuf = mcpBuf.slice(nl + 1)
      if (msg.id != null) mcpWaiting.get(msg.id)?.(msg)
    }
  })
  let mcpId = 0
  const mcpCall = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++mcpId
      mcpWaiting.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      mcpSock.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    })
  await mcpCall('mcp.hello', { name: 'e2e' })
  const st = await call('mcp.status')
  await mcpCall('project.setFormat', { aspect: '1:1', _actor: 'claude' })
  const lastStep = (await call('history.list')).steps.at(-1)
  const summary = (await mcpCall('project.summary')).text
  const info = JSON.parse(readFileSync(join(userData, 'engine.json'), 'utf8'))
  check(st.clients === 1 && lastStep.actor === 'claude' && summary.includes('1080×1080') && info.pid === engine.pid && info.socket === socket, `MCP: ${st.clients} client, its edit logged as "${lastStep.actor}", summary ${summary.split('\n').length} lines, engine.json names pid ${info.pid}`)
  await mcpCall('mcp.bye')
  mcpSock.destroy()

  // Linked folders: a small generated tree.
  const tree = join(work, 'Ads')
  const clip = (file, secs = 1, size = '360x640') => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${secs}`, '-f', 'lavfi', '-i', `sine=duration=${secs}`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', file])
  mkdirSync(join(tree, '01 Produkt'), { recursive: true })
  mkdirSync(join(tree, '05 Stock', 'Jul'), { recursive: true })
  // Bigger than a proxy (960 px), so it gets one once it's used.
  clip(join(tree, '01 Produkt', 'a.mp4'), 1, '720x1280')
  clip(join(tree, '05 Stock', 'Jul', 'b.mp4'))
  writeFileSync(join(tree, 'README.md'), 'not media')
  await call('project.new', { name: 'E2E Folders', aspect: '9:16' })
  // A big folder being linked doesn't hold up the rest: a request sent after it is answered first.
  const many = join(work, 'Many')
  mkdirSync(many, { recursive: true })
  clip(join(many, 'm0.mp4'))
  for (let i = 1; i < 120; i++) linkSync(join(many, 'm0.mp4'), join(many, `m${i}.mp4`))
  const order = []
  const linking = call('media.import', { paths: [many] }).then(() => order.push('link'))
  await call('engine.capabilities').then(() => order.push('other'))
  await linking
  check(order.join() === 'other,link', `a request sent while 120 files are linked is answered first (${order.join(', ')})`)
  await call('project.new', { name: 'E2E Folders', aspect: '9:16' })
  let r = await call('media.import', { paths: [tree] })
  const folderId = r.folders[0]?.folderId
  check(r.folders.length === 1 && r.folders[0].added === 2, `linked a folder: ${r.folders[0]?.added} clips found, the README skipped`)
  await waitFor((m) => m.method === 'project.changed' && m.params.processing.length === 0, 60_000, 'folder thumbnails')
  let p = latest.project
  check(p.folders.length === 1 && p.media.map((m) => m.dir).sort().join('|') === '01 Produkt|05 Stock/Jul', 'the library keeps the folder tree')
  check(p.media.every((m) => m.poster && !m.strip && !m.proxy), 'posters made; filmstrips and proxies wait for the timeline')
  const a = p.media.find((m) => m.name === 'a.mp4')
  await call('timeline.insert', { mediaId: a.id })
  await waitFor((m) => m.method === 'project.changed' && m.params.project.media.find((x) => x.id === a.id)?.proxy && m.params.project.media.find((x) => x.id === a.id)?.strip, 60_000, 'a proxy and filmstrip for the used clip')
  check(true, 'putting a clip on the timeline makes its filmstrip and proxy')
  // A clip no bigger than a proxy plays from its own file.
  const b = p.media.find((m) => m.name === 'b.mp4')
  // Listening before the insert: with nothing to make, the snapshot saying so can come before its answer.
  const settled = waitFor((m) => m.method === 'project.changed' && m.params.processing.length === 0 && m.params.project.tracks.some((t) => t.clips.some((c) => c.mediaId === b.id)), 60_000, 'nothing left to make')
  await call('timeline.insert', { mediaId: b.id })
  await settled
  check(!latest.project.media.find((x) => x.id === b.id).proxy, 'a 360×640 clip on the timeline gets no proxy')
  await call('edit.undo')
  clip(join(tree, '05 Stock', 'c.mp4'))
  rmSync(join(tree, '01 Produkt', 'a.mp4'))
  r = await call('media.syncFolder', { folderId })
  check(r.added === 1 && r.missing === 1, `rescan: ${r.added} new, ${r.missing} missing`)
  r = await call('media.import', { paths: [tree] })
  snap = await call('project.current')
  check(snap.project.folders.length === 1 && snap.project.media.length === 3, 'linking the same folder again adds nothing')
  const bMedia = snap.project.media.find((m) => m.name === 'b.mp4')
  await call('media.remove', { mediaIds: [bMedia.id] })
  r = await call('media.syncFolder', { folderId })
  snap = await call('project.current')
  check(!snap.project.media.some((m) => m.name === 'b.mp4') && r.added === 0, 'a file removed from the library stays out after a rescan')
  await call('media.restore', { media: [bMedia] })
  snap = await call('project.current')
  check(snap.project.media.some((m) => m.id === bMedia.id), 'pasting it back restores it')
  await call('media.unlinkFolder', { folderId })
  snap = await call('project.current')
  check(snap.project.folders.length === 0 && snap.project.media.length === 1 && !snap.project.media[0].folder, 'unlinking keeps only the clip in use')

  // BROLL=1: time linking the real B-roll folder (240 clips) and making its thumbnails.
  const broll = process.env.BROLL && clipDir
  if (broll && existsSync(broll)) {
    await call('project.new', { name: 'E2E B-roll', aspect: '9:16' })
    const b0 = performance.now()
    r = await call('media.import', { paths: [broll] })
    const linked = (performance.now() - b0) / 1000
    await waitFor((m) => m.method === 'project.changed' && m.params.processing.length === 0, 900_000, 'B-roll thumbnails')
    const done = (performance.now() - b0) / 1000
    const media = latest.project.media
    check(media.length >= 200 && media.every((m) => m.poster), `B-roll: ${r.folders[0].added} clips linked in ${linked.toFixed(1)} s, thumbnails for all in ${done.toFixed(0)} s`)
  }
} catch (e) {
  check(false, e.message)
} finally {
  engine.stdin.end()
  sock.destroy()
  await new Promise((r) => {
    if (engine.exitCode !== null) return r()
    engine.once('exit', r)
    setTimeout(r, 5000)
  })
  check(!existsSync(join(userData, 'engine.json')), 'engine.json is removed when the engine exits')
  try {
    await childrenDieWithEngine()
  } catch (e) {
    check(false, `FFmpeg ends with the engine: ${e.message}`)
  }
  setTimeout(() => {
    if (!process.env.KEEP) rmSync(work, { recursive: true, force: true })
    console.log(failed ? 'E2E FAILED' : 'E2E OK')
    process.exit(failed ? 1 : 0)
  }, 500)
}
