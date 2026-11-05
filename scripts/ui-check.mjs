// The app test: runs the built Electron app hidden, with a throwaway projects folder and
// settings, and lets src/main/ui-check.ts drive it. Screenshots and results.json land in
// out/ui-check/. Needs `npm run build` first.
// Usage: node scripts/ui-check.mjs [folder-with-clips]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// STUDIO_UI_APP runs a staged copy of the app instead (so a Studio that's open keeps its files).
const app = process.env.STUDIO_UI_APP ?? join(root, 'apps', 'desktop')
const electron = createRequire(join(app, 'package.json'))('electron')
const out = join(root, 'out', 'ui-check')
const work = join(os.tmpdir(), `studio-ui-check-${process.pid}`)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })

// Footage to test with: a folder given on the command line or in STUDIO_TEST_CLIPS (its first
// three videos, sorted by path); without one, three short test clips are made.
const clipDir = process.argv[2] ?? process.env.STUDIO_TEST_CLIPS ?? ''
const videos = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((n) => /\.(mp4|mov|m4v|mkv|webm)$/i.test(n)).sort().map((n) => join(dir, n)) : [])
let clips = clipDir ? videos(clipDir).slice(0, 3) : []
if (clips.length < 3) {
  // No footage on this machine (e.g. CI): make three short test clips.
  clips = [0, 1, 2].map((i) => {
    const file = join(work, `clip${i}.mp4`)
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 200}:duration=4`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-y', file])
    return file
  })
}
const voice = join(work, 'voiceover.wav')
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-y', voice])
// A voiceover to cut into pieces (its script and voice are written beside it by the check).
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=9', '-y', join(work, 'cut-voiceover.wav')])

// A spoken voiceover for the captions step, with its script beside it as a voiceover made in
// the Audio tab keeps (Windows' own speech voice; espeak-ng elsewhere). That step runs a real
// job on the transcript server, so it's skipped without a connection, or with STUDIO_UI_CHECK_ONLINE=0.
const SCRIPT = 'Meet Quorvel, the lamp that follows the sun. Warm light, quiet and small. Order yours today at quorvel.example.'
const speech = join(work, 'speech.wav')
let speechOk = process.env.STUDIO_UI_CHECK_ONLINE !== '0'
if (speechOk) {
  const said = SCRIPT.replace('quorvel.example', 'quorvel dot example')
  try {
    if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${speech}'); $s.Speak('${said}'); $s.Dispose()`])
    else execFileSync('espeak-ng', ['-w', speech, said])
    writeFileSync(join(work, 'speech.script.txt'), `${SCRIPT}\n`)
    speechOk = (await fetch(`${process.env.STUDIO_TRANSCRIPT_URL ?? 'https://basalt.codes/transcript/api'}/health`, { signal: AbortSignal.timeout(10_000) })).ok
  } catch {
    speechOk = false
  }
}

// Offline, a stand-in transcript server on this computer: it hears the same few words in any
// sound, and its check against the script fails the way the real one does when its AI account
// is out of credits.
let standIn = null
if (process.env.STUDIO_UI_CHECK_ONLINE === '0' && !process.env.STUDIO_TRANSCRIPT_URL) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=520:duration=4', '-y', join(work, 'scripted-voiceover.wav')])
  const heard = [['Order', 0.2], ['yours', 0.6], ['today', 1], ['at', 1.4], ['corvel.', 1.6]].map(([word, start]) => ({ word, start, end: start + 0.35 }))
  standIn = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    req.resume()
    req.on('end', () => {
      const m = /^\/api\/jobs(?:\/(\w+))?(\/proofread)?$/.exec(req.url ?? '')
      if (!m) return send(404, { detail: 'Not found' })
      if (req.method === 'POST' && !m[1]) return send(200, { id: 'standin' })
      if (req.method === 'POST') return send(502, { detail: 'The proofreader could not finish: AI query: this account has no credits remaining' })
      if (req.method === 'DELETE') return send(200, {})
      send(200, { state: 'done', stage: 'done', progress: 1, queue: 0, words: heard, language: 'en', changes: [], summary: null, error: null })
    })
  })
  await new Promise((r) => standIn.listen(0, '127.0.0.1', r))
}

// A small folder tree for the folder-map steps.
const tree = join(work, 'Ads')
for (const [sub, name, secs] of [['01 Produkt', 'a.mp4', 2], ['05 Stock/Jul', 'b.mp4', 2]]) {
  mkdirSync(join(tree, sub), { recursive: true })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=30:duration=${secs}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-y', join(tree, sub, name)])
}

// A clip with text burned in, for the Dub steps (PP-OCR finds it; the stand-ins read it and take it out).
const dubFont = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
let dubClip = ''
if (existsSync(dubFont))
  try {
    dubClip = join(work, 'dub-text.mp4')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x2a3a4a:s=540x960:d=2:r=30,drawtext=fontfile=${dubFont}:text=Only 9 days left:fontsize=56:fontcolor=white:x=(w-tw)/2:y=h*0.3`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', dubClip])
  } catch {
    dubClip = ''
  }

const env = {
  ...process.env,
  STUDIO_UI_CHECK: out,
  STUDIO_UI_CHECK_CLIPS: JSON.stringify([...clips, voice]),
  STUDIO_UI_CHECK_EXPORTS: join(work, 'exports'),
  STUDIO_UI_CHECK_FOLDER: tree,
  STUDIO_UI_CHECK_DUBCLIP: dubClip,
  STUDIO_UI_CHECK_SPEECH: speechOk ? speech : '',
  STUDIO_PROJECTS_DIR: join(work, 'projects'),
  STUDIO_USER_DATA: join(work, 'user-data'),
  STUDIO_SILENT: '1',
  ...(standIn ? { STUDIO_TRANSCRIPT_URL: `http://127.0.0.1:${standIn.address().port}/api`, STUDIO_UI_CHECK_TRANSCRIPT_STANDIN: '1' } : {}),
}
const runApp = (extra) =>
  new Promise((resolve) => {
    const child = spawn(electron, [app], { env: { ...env, ...extra }, stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })

const code = await runApp({})
// Then the window chrome, in a real window parked off the desktop for a second or two (on
// Wayland it shows, as windows can't be parked): left out when only some steps run.
const chrome = process.env.STUDIO_UI_ONLY ? null : await runApp({ STUDIO_UI_CHECK: '', STUDIO_CHROME_CHECK: join(out, 'chrome.json') })
standIn?.close()
let summary = ''
try {
  const r = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
  summary = `${r.results.filter((x) => x.ok).length}/${r.results.length} steps passed, ${r.consoleErrors.length} console errors`
} catch {
  summary = 'no results written'
}
summary += chrome === null ? '' : chrome === 0 ? ', window buttons sit in the app bar' : ', WINDOW CHROME CHECK FAILED'
// The engine may still hold a file for a moment after it exits; a leftover temp folder isn't a failure.
if (!process.env.KEEP) {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (e) {
    console.log(`[ui-check] couldn't remove ${work}: ${e.code}`)
  }
}
const ok = code === 0 && (chrome === null || chrome === 0)
console.log(`${ok ? 'UI CHECK OK' : 'UI CHECK FAILED'}: ${summary}. Screenshots in ${out}`)
process.exit(ok ? 0 : 1)
