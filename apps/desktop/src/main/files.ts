// Files the page makes or needs, handled in the main process with narrow rules:
// - PNGs it draws (text, masks, stickers) go only into a project's text/, masks/ or stickers/
//   folder; background mattes only into mattes/ (encoded here with FFmpeg).
// - Captions are saved as .srt files only.
// - Frames of a clip for analysis (background removal, reframe, tracking), decoded here and
//   handed over one at a time as RGBA.
// - Sound samples of a clip for the Audio page's pencil.
// - The app's own settings (saved looks, the music folder) and the built-in LUTs.

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg, findTool, lowPriority, probeVideo } from './ffmpeg'

const ASSET = /\.studio[\\/](text|masks|stickers)[\\/][^\\/]+\.png$/i
const MATTE = /\.studio[\\/]mattes[\\/][^\\/]+\.mp4$/i
const STICKER_TYPES = ['png', 'gif', 'webm', 'webp', 'apng']

const fail = (e: unknown) => ({ error: (e as Error).message || String(e) })
const clean = (p: unknown) => (typeof p === 'string' && path.isAbsolute(p) ? path.normalize(p) : '')

/** A project folder the page names: absolute, ends in .studio, and exists. */
function projectDir(dir: unknown): string {
  const d = clean(dir)
  if (!d || !/\.studio$/i.test(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Not a project folder.')
  return d
}

// Settings

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const SETTING_KEYS = ['looks', 'musicFolder', 'textPresets'] as const
export type SettingKey = (typeof SETTING_KEYS)[number]

export function readSettings(): Partial<Record<SettingKey, unknown>> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}
export function writeSetting(key: SettingKey, value: unknown) {
  const all = readSettings()
  all[key] = value
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2))
}

// LUTs: made by scripts/make-luts.mjs into assets/luts.

const lutDir = () => path.join(__dirname, '..', 'assets', 'luts')
const LUT_NAMES: Record<string, string> = { warm: 'Warm', cool: 'Cool', 'teal-orange': 'Teal and orange', mono: 'Mono', film: 'Film', faded: 'Faded' }

function listLuts() {
  try {
    return fs
      .readdirSync(lutDir())
      .filter((f) => f.toLowerCase().endsWith('.cube'))
      .map((f) => ({ name: LUT_NAMES[f.replace(/\.cube$/i, '')] ?? f.replace(/\.cube$/i, ''), path: path.join(lutDir(), f) }))
  } catch {
    return []
  }
}

// Frames for analysis: FFmpeg decodes the range to RGBA at a small size.

interface FrameReader {
  child: ChildProcessWithoutNullStreams
  frameSize: number
  queue: Buffer[]
  partial: Buffer[]
  partialBytes: number
  ended: boolean
  error: string
  waiting: ((f: Buffer | null) => void) | null
}
const readers = new Map<string, FrameReader>()
let nextReader = 0

async function openFrames(o: { path: string; startUs: number; durationUs: number; fps: number; width: number }) {
  const file = clean(o.path)
  if (!file || !fs.existsSync(file)) throw new Error('The clip’s file is missing.')
  const info = await probeVideo(file)
  const width = Math.max(16, Math.round(Math.min(o.width, info.width) / 2) * 2)
  const height = Math.max(16, Math.round((width * info.height) / info.width / 2) * 2)
  const fps = Math.max(0.5, Math.min(60, o.fps || 30))
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', (Math.max(0, o.startUs) / 1e6).toFixed(3), '-t', (Math.max(0.05, o.durationUs / 1e6)).toFixed(3), '-i', file, '-an', '-vf', `fps=${fps},scale=${width}:${height}:flags=bilinear`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']
  const child = spawn(findTool('ffmpeg'), args, { windowsHide: true })
  lowPriority(child)
  const id = `f${++nextReader}`
  const r: FrameReader = { child, frameSize: width * height * 4, queue: [], partial: [], partialBytes: 0, ended: false, error: '', waiting: null }
  readers.set(id, r)
  const deliver = () => {
    if (!r.waiting) return
    const f = r.queue.shift()
    if (f) {
      const w = r.waiting
      r.waiting = null
      w(f)
    } else if (r.ended) {
      const w = r.waiting
      r.waiting = null
      w(null)
    }
    if (r.queue.length < 4) child.stdout.resume()
  }
  child.stdout.on('data', (d: Buffer) => {
    r.partial.push(d)
    r.partialBytes += d.length
    while (r.partialBytes >= r.frameSize) {
      const all = Buffer.concat(r.partial)
      r.queue.push(all.subarray(0, r.frameSize))
      const rest = all.subarray(r.frameSize)
      r.partial = rest.length ? [rest] : []
      r.partialBytes = rest.length
    }
    if (r.queue.length > 8) child.stdout.pause()
    deliver()
  })
  child.stderr.on('data', (d: Buffer) => (r.error = (r.error + d.toString()).slice(-2000)))
  child.on('error', (e) => (r.error = e.message))
  child.on('close', () => {
    r.ended = true
    deliver()
  })
  return { id, width, height, fps, sourceFps: info.fps, sourceWidth: info.width, sourceHeight: info.height }
}

function nextFrame(id: string): Promise<Uint8Array | null> {
  const r = readers.get(id)
  if (!r) return Promise.resolve(null)
  const f = r.queue.shift()
  if (f) {
    if (r.queue.length < 4) r.child.stdout.resume()
    return Promise.resolve(new Uint8Array(f))
  }
  if (r.ended) {
    readers.delete(id)
    return r.error && !r.queue.length ? Promise.reject(new Error(r.error.trim().split(/\r?\n/).pop())) : Promise.resolve(null)
  }
  return new Promise((resolve) => {
    r.waiting = (b) => resolve(b ? new Uint8Array(b) : null)
    r.child.stdout.resume()
  })
}

function closeFrames(id: string) {
  const r = readers.get(id)
  if (!r) return
  readers.delete(id)
  r.child.kill()
}

// Mattes: grey frames in, an analysis-size "raw" video, then the matte at the source size.

interface MatteWriter {
  child: ChildProcessWithoutNullStreams
  done: Promise<void>
  raw: string
}
const writers = new Map<string, MatteWriter>()
let nextWriter = 0

function openMatte(o: { raw: string; width: number; height: number; fps: number }) {
  const raw = clean(o.raw)
  if (!MATTE.test(raw)) throw new Error('Mattes are saved in the project’s mattes folder only.')
  fs.mkdirSync(path.dirname(raw), { recursive: true })
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p', '-y', raw]
  const child = spawn(findTool('ffmpeg'), args, { windowsHide: true })
  lowPriority(child)
  let err = ''
  child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(e))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || `FFmpeg exited with ${code}`))))
  })
  done.catch(() => {})
  const id = `m${++nextWriter}`
  writers.set(id, { child, done, raw })
  return { id }
}

function writeMatte(id: string, data: Uint8Array): Promise<void> {
  const w = writers.get(id)
  if (!w) return Promise.reject(new Error('That matte is closed.'))
  return new Promise((resolve, reject) => {
    const ok = w.child.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (e) => (e ? reject(e) : undefined))
    if (ok) resolve()
    else w.child.stdin.once('drain', () => resolve())
  })
}

async function closeMatte(id: string, cancel = false) {
  const w = writers.get(id)
  if (!w) return
  writers.delete(id)
  if (cancel) {
    w.child.kill()
    fs.rmSync(w.raw, { force: true })
    return
  }
  w.child.stdin.end()
  await w.done
}

/**
 * The matte the engine uses: the raw matte scaled to the source size, its edge softened by
 * `edge` px, and black (nothing kept) from the file's start until `startUs`, so the matte's
 * time is the source file's time.
 */
async function finishMatte(o: { raw: string; out: string; width: number; height: number; startUs: number; edge: number; holdUs?: number }) {
  const raw = clean(o.raw)
  const out = clean(o.out)
  if (!MATTE.test(raw) || !MATTE.test(out)) throw new Error('Mattes are saved in the project’s mattes folder only.')
  const w = Math.max(2, Math.round(o.width / 2) * 2)
  const h = Math.max(2, Math.round(o.height / 2) * 2)
  const filters = [`scale=${w}:${h}:flags=bicubic`]
  if (o.edge > 0) filters.push(`gblur=sigma=${(o.edge / 2).toFixed(2)}`)
  if (o.startUs > 0) filters.push(`tpad=start_duration=${(o.startUs / 1e6).toFixed(3)}:start_mode=add:color=black`)
  // A still picture's matte is one frame, held for the clip's length.
  if (o.holdUs && o.holdUs > 0) filters.push(`tpad=stop_mode=clone:stop_duration=${(o.holdUs / 1e6).toFixed(3)}`)
  filters.push('format=yuv420p')
  await ffmpeg(['-i', raw, '-vf', filters.join(','), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-movflags', '+faststart', '-y', out])
  return { out }
}

// Sound samples for the pencil: mono float32 at `rate`.

async function samples(o: { path: string; startUs: number; durationUs: number; rate: number }) {
  const file = clean(o.path)
  if (!file || !fs.existsSync(file)) throw new Error('The clip’s file is missing.')
  const dur = Math.min(10_000_000, Math.max(1000, o.durationUs))
  const rate = Math.max(1000, Math.min(96_000, Math.round(o.rate)))
  const buf = await ffmpeg(['-ss', (Math.max(0, o.startUs) / 1e6).toFixed(6), '-t', (dur / 1e6).toFixed(6), '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'])
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice()
}

const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? undefined

export function registerFiles() {
  ipcMain.handle('file:writeAsset', (_e, file: string, data: ArrayBuffer | Uint8Array) => {
    try {
      const f = clean(file)
      if (!ASSET.test(f)) throw new Error('Pictures are saved in the project’s text, masks or stickers folder only.')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)))
      return { out: f }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('file:exists', (_e, file: string) => {
    const f = clean(file)
    return !!f && fs.existsSync(f)
  })
  ipcMain.handle('file:importSticker', (_e, src: string, dir: string) => {
    try {
      const from = clean(src)
      const ext = path.extname(from).slice(1).toLowerCase()
      if (!STICKER_TYPES.includes(ext)) throw new Error('A sticker is a PNG, GIF, WebP or WebM file.')
      const d = path.join(projectDir(dir), 'stickers')
      fs.mkdirSync(d, { recursive: true })
      const stem = path.basename(from, path.extname(from)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80) || 'Sticker'
      let out = path.join(d, `${stem}.${ext}`)
      for (let n = 2; fs.existsSync(out); n++) out = path.join(d, `${stem} ${n}.${ext}`)
      fs.copyFileSync(from, out)
      return { out }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('file:writeSrt', (_e, file: string, text: string) => {
    try {
      const f = clean(file)
      if (!f.toLowerCase().endsWith('.srt')) throw new Error('Captions are saved as .srt files.')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      // With a byte-order mark, so every player reads å, ä and ö right.
      fs.writeFileSync(f, '﻿' + String(text).replace(/\r?\n/g, '\r\n'), 'utf8')
      return { out: f }
    } catch (e) {
      return fail(e)
    }
  })
  // The text export: what's on screen and what's said, as plain text (no times) or .srt.
  ipcMain.handle('file:writeText', (_e, file: string, text: string) => {
    try {
      const f = clean(file)
      if (!/\.(txt|srt)$/i.test(f)) throw new Error('Text is saved as .txt or .srt files.')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      // An .srt with a byte-order mark, so every player reads å, ä and ö right; Windows line ends.
      fs.writeFileSync(f, (/\.srt$/i.test(f) ? '﻿' : '') + String(text).replace(/\r?\n/g, '\r\n'), 'utf8')
      return { out: f }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('dialog:saveFile', async (e, o: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const w = win(e)
    const opts = { title: o?.title, defaultPath: o?.defaultPath, filters: o?.filters }
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    return r.canceled || !r.filePath ? null : r.filePath
  })
  ipcMain.handle('dialog:chooseFile', async (e, o: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const w = win(e)
    const opts = { title: o?.title, defaultPath: o?.defaultPath, filters: o?.filters, properties: ['openFile' as const] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle('settings:get', (_e, key: SettingKey) => (SETTING_KEYS.includes(key) ? (readSettings()[key] ?? null) : null))
  ipcMain.handle('settings:set', (_e, key: SettingKey, value: unknown) => {
    if (!SETTING_KEYS.includes(key)) return fail(new Error('unknown setting'))
    writeSetting(key, value)
    return { ok: true }
  })

  ipcMain.handle('luts:list', () => listLuts())
  /** Copies a .cube file into the project's luts folder, so the project keeps working when moved. */
  ipcMain.handle('luts:use', (_e, src: string, dir: string) => {
    try {
      const from = clean(src)
      if (!from.toLowerCase().endsWith('.cube') || !fs.existsSync(from)) throw new Error('Pick a .cube LUT file.')
      const d = path.join(projectDir(dir), 'luts')
      if (path.dirname(from) === d) return { out: from }
      fs.mkdirSync(d, { recursive: true })
      const out = path.join(d, path.basename(from))
      if (!fs.existsSync(out) || fs.readFileSync(out).compare(fs.readFileSync(from)) !== 0) fs.copyFileSync(from, out)
      return { out }
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('frames:open', async (_e, o: { path: string; startUs: number; durationUs: number; fps: number; width: number }) => {
    try {
      return await openFrames(o)
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('frames:next', async (_e, id: string) => {
    try {
      return { frame: await nextFrame(id) }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.on('frames:close', (_e, id: string) => closeFrames(id))

  ipcMain.handle('matte:open', (_e, o: { raw: string; width: number; height: number; fps: number }) => {
    try {
      return openMatte(o)
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('matte:write', async (_e, id: string, data: Uint8Array) => {
    try {
      await writeMatte(id, data)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('matte:close', async (_e, id: string, cancel?: boolean) => {
    try {
      await closeMatte(id, !!cancel)
      return { ok: true }
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('matte:finish', async (_e, o: { raw: string; out: string; width: number; height: number; startUs: number; edge: number; holdUs?: number }) => {
    try {
      return await finishMatte(o)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle('audio:samples', async (_e, o: { path: string; startUs: number; durationUs: number; rate: number }) => {
    try {
      return { samples: await samples(o) }
    } catch (e) {
      return fail(e)
    }
  })
}

/** Stops every frame reader and matte writer (the window is going away). */
export function closeAllFiles() {
  for (const id of [...readers.keys()]) closeFrames(id)
  for (const id of [...writers.keys()]) closeMatte(id, true)
}
