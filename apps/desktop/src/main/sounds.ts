// The Audio tab's sound library:
// - Sound effects: a built-in set made with FFmpeg's lavfi sources the first time they are
//   asked for, written into the app's user data folder (sounds/v1).
// - Music: the user's own music folder (the OS Music folder unless they pick another),
//   scanned here for sound files, with lengths from ffprobe (cached).
// The page can read these files' bytes for a preview, and copies a sound effect into the
// project when it is added (so the project still has it on another computer).

import { app, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'
import { readSettings, writeSetting } from './files'

export interface SoundFile {
  id: string
  name: string
  /** The sound effect's kind, or the music file's top folder inside the music folder ("" at the top). */
  kind: string
  path: string
  durationUs: number
  /** 24 bars, 0–100, from the real sound (sound effects only). */
  bars?: number[]
}

const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma']
const fail = (e: unknown) => ({ error: (e as Error).message || String(e) })

// Sound effects. Each is a lavfi graph: `src` is the source (aevalsrc or anoisesrc), `af`
// optional filters after it. 48 kHz stereo WAV.

interface Def {
  id: string
  name: string
  kind: string
  d: number
  src: string
  af?: string
}

const env = (d: number) => `volume='pow(sin(PI*t/${d}),2)':eval=frame`
const DEFS: Def[] = [
  { id: 'whoosh-soft', name: 'Soft whoosh', kind: 'Whoosh', d: 1.3, src: 'anoisesrc=c=pink:a=0.9:d=1.3', af: `bandpass=f=900:width_type=o:w=2.5,${env(1.3)},volume=2.2` },
  { id: 'whoosh-fast', name: 'Fast whoosh', kind: 'Whoosh', d: 0.55, src: 'anoisesrc=c=white:a=0.8:d=0.55', af: `bandpass=f=2200:width_type=o:w=2,${env(0.55)},volume=1.8` },
  { id: 'swoosh', name: 'Swoosh', kind: 'Whoosh', d: 0.8, src: "aevalsrc='(random(0)*2-1)*0.7':d=0.8", af: `highpass=f=600,lowpass=f=5000,volume='pow(sin(PI*pow(t/0.8,0.6)),3)':eval=frame,volume=1.6` },
  { id: 'riser', name: 'Riser', kind: 'Whoosh', d: 3, src: "aevalsrc='0.35*sin(2*PI*(150*t+300*t*t))*(t/3)+0.25*(random(0)*2-1)*pow(t/3,2)':d=3", af: 'highpass=f=100,afade=t=out:st=2.9:d=0.1' },
  { id: 'pop', name: 'Pop', kind: 'Clicks', d: 0.15, src: "aevalsrc='0.9*sin(2*PI*(1100*t-3500*t*t))*exp(-t*38)':d=0.15" },
  { id: 'click', name: 'Click', kind: 'Clicks', d: 0.06, src: "aevalsrc='(random(0)*2-1)*exp(-t*700)+0.5*sin(2*PI*3000*t)*exp(-t*500)':d=0.06", af: 'highpass=f=1200' },
  { id: 'typing', name: 'Typing', kind: 'Clicks', d: 2.4, src: "aevalsrc='(random(0)*2-1)*exp(-mod(t*7.3+0.35*sin(t*5.1),1)*45)*(0.6+0.4*sin(t*13))':d=2.4", af: 'highpass=f=1500,lowpass=f=7000,volume=1.4' },
  { id: 'shutter', name: 'Camera shutter', kind: 'Clicks', d: 0.32, src: "aevalsrc='(random(0)*2-1)*(exp(-t*90)+0.8*gte(t,0.1)*exp(-(t-0.1)*110))':d=0.32", af: 'bandpass=f=3200:width_type=o:w=2,volume=2' },
  { id: 'ding', name: 'Ding', kind: 'Bells', d: 1.6, src: "aevalsrc='0.45*sin(2*PI*1318.5*t)*exp(-3*t)+0.2*sin(2*PI*2637*t)*exp(-5*t)+0.1*sin(2*PI*3955.5*t)*exp(-8*t)':d=1.6" },
  { id: 'sleigh-bells', name: 'Sleigh bells', kind: 'Bells', d: 2.2, src: "aevalsrc='(0.18*sin(2*PI*2400*t)+0.12*sin(2*PI*3570*t)+0.08*sin(2*PI*5150*t))*exp(-9*mod(t,0.125))*(0.7+0.3*sin(2*PI*1.3*t))+0.06*(random(0)*2-1)*exp(-30*mod(t,0.125))':d=2.2", af: 'afade=t=out:st=1.7:d=0.5' },
  { id: 'cash', name: 'Cash register', kind: 'Bells', d: 1.2, src: "aevalsrc='(random(0)*2-1)*0.6*exp(-t*60)+gte(t,0.08)*(0.4*sin(2*PI*2093*(t-0.08))+0.25*sin(2*PI*2637*(t-0.08)))*exp(-4*(t-0.08))':d=1.2" },
  { id: 'notification', name: 'Notification', kind: 'Interface', d: 0.7, src: "aevalsrc='0.4*sin(2*PI*880*t)*lt(t,0.12)*exp(-6*t)+0.4*sin(2*PI*1318.5*t)*gte(t,0.12)*exp(-6*(t-0.12))':d=0.7" },
  { id: 'success', name: 'Success', kind: 'Interface', d: 0.95, src: "aevalsrc='0.32*(sin(2*PI*523.25*t)*between(t,0,0.12)+sin(2*PI*659.25*t)*between(t,0.12,0.24)+sin(2*PI*783.99*t)*gte(t,0.24)*exp(-4*(t-0.24)))':d=0.95" },
  { id: 'error', name: 'Error', kind: 'Interface', d: 0.45, src: "aevalsrc='0.28*(sin(2*PI*196*t)+0.5*sin(2*PI*392*t)+0.25*sin(2*PI*588*t))*(between(t,0,0.15)+between(t,0.22,0.37))':d=0.45" },
  { id: 'impact', name: 'Impact', kind: 'Impacts', d: 1.6, src: "aevalsrc='0.95*sin(2*PI*(70*t-12*t*t))*exp(-2.6*t)+0.4*(random(0)*2-1)*exp(-25*t)':d=1.6", af: 'lowpass=f=2500' },
  { id: 'boom', name: 'Deep boom', kind: 'Impacts', d: 2.5, src: "aevalsrc='0.95*sin(2*PI*(48*t-6*t*t))*exp(-1.6*t)':d=2.5", af: 'lowpass=f=400,volume=1.3' },
  { id: 'heartbeat', name: 'Heartbeat', kind: 'Impacts', d: 2, src: "aevalsrc='0.9*sin(2*PI*55*t)*(exp(-25*mod(t,1))+0.7*exp(-25*mod(t-0.25,1))*gte(mod(t,1),0.25))':d=2", af: 'lowpass=f=300' },
]
const DIR_VERSION = 'v1'
const soundsDir = () => path.join(app.getPath('userData'), 'sounds', DIR_VERSION)

/** 24 peak bars (0–100) from a sound file. */
async function barsOf(file: string, n = 24): Promise<number[]> {
  const raw = await ffmpeg(['-i', file, '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'])
  const s = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2))
  const per = Math.max(1, Math.floor(s.length / n))
  const peaks = Array.from({ length: n }, (_, i) => {
    let p = 0
    for (let k = i * per; k < Math.min(s.length, (i + 1) * per); k++) p = Math.max(p, Math.abs(s[k]))
    return p / 32768
  })
  const top = Math.max(...peaks, 1e-6)
  return peaks.map((p) => Math.round(8 + 92 * (p / top)))
}

let making: Promise<SoundFile[]> | null = null

/** The sound effects, made on first use (and again if any file is missing). */
export function soundEffects(): Promise<SoundFile[]> {
  making ??= (async () => {
    const dir = soundsDir()
    fs.mkdirSync(dir, { recursive: true })
    const indexFile = path.join(dir, 'index.json')
    let index: Record<string, number[]> = {}
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    } catch {}
    const out: SoundFile[] = []
    // Four at a time.
    const queue = [...DEFS]
    const work = async () => {
      for (let def = queue.shift(); def; def = queue.shift()) {
        const file = path.join(dir, `${def.id}.wav`)
        if (!fs.existsSync(file)) {
          const graph = `${def.src}${def.af ? `,${def.af}` : ''},aformat=sample_rates=48000:channel_layouts=stereo,alimiter=limit=0.89`
          await ffmpeg(['-f', 'lavfi', '-i', graph, '-t', String(def.d), '-c:a', 'pcm_s16le', '-y', file])
          delete index[def.id]
        }
        if (!index[def.id]) index[def.id] = await barsOf(file)
        out.push({ id: def.id, name: def.name, kind: def.kind, path: file, durationUs: Math.round(def.d * 1e6), bars: index[def.id] })
      }
    }
    await Promise.all([work(), work(), work(), work()])
    fs.writeFileSync(indexFile, JSON.stringify(index))
    return DEFS.map((d) => out.find((o) => o.id === d.id)!).filter(Boolean)
  })().catch((e) => {
    making = null
    throw e
  })
  return making
}

// Music

const musicFolder = (): string => {
  const saved = readSettings().musicFolder
  if (typeof saved === 'string' && saved) return saved
  try {
    return app.getPath('music')
  } catch {
    return app.getPath('home')
  }
}

const durationCacheFile = () => path.join(app.getPath('userData'), 'music-lengths.json')

async function scanMusic(dir: string): Promise<SoundFile[]> {
  const root = path.normalize(dir)
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error('That music folder is gone. Pick another.')
  const files: { path: string; kind: string; key: string }[] = []
  const walk = (d: string, depth: number, top: string) => {
    if (depth > 5 || files.length >= 3000) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1, top || e.name)
      else if (AUDIO.includes(path.extname(e.name).slice(1).toLowerCase())) {
        const st = fs.statSync(p, { throwIfNoEntry: false })
        if (st) files.push({ path: p, kind: top, key: `${p}|${st.size}|${Math.round(st.mtimeMs)}` })
      }
    }
  }
  walk(root, 0, '')
  let cache: Record<string, number> = {}
  try {
    cache = JSON.parse(fs.readFileSync(durationCacheFile(), 'utf8'))
  } catch {}
  const missing = files.filter((f) => cache[f.key] == null)
  const work = async () => {
    for (let f = missing.shift(); f; f = missing.shift()) {
      try {
        const r = await ffmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f.path], { tool: 'ffprobe', timeoutMs: 15_000 })
        cache[f.key] = Math.round(Number(r.toString().trim()) * 1e6) || 0
      } catch {
        cache[f.key] = 0
      }
    }
  }
  if (missing.length) {
    await Promise.all(Array.from({ length: 6 }, work))
    try {
      fs.writeFileSync(durationCacheFile(), JSON.stringify(cache))
    } catch {}
  }
  return files
    .map((f) => ({ id: f.path, name: path.basename(f.path).replace(/\.[^.]+$/, ''), kind: f.kind, path: f.path, durationUs: cache[f.key] ?? 0 }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

/** Whether the page may read this file for a preview: a sound effect or a file in the music folder. */
function readable(file: string) {
  const f = path.normalize(file)
  if (!AUDIO.includes(path.extname(f).slice(1).toLowerCase())) return false
  const inside = (dir: string) => {
    const rel = path.relative(dir, f)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  return inside(soundsDir()) || inside(musicFolder())
}

export function registerSounds() {
  ipcMain.handle('sounds:effects', async () => {
    try {
      return await soundEffects()
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('sounds:musicFolder', () => musicFolder())
  ipcMain.handle('sounds:setMusicFolder', (_e, dir: string) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return fail(new Error('Pick a folder.'))
    writeSetting('musicFolder', path.normalize(dir))
    return { ok: true }
  })
  ipcMain.handle('sounds:scanMusic', async () => {
    try {
      return await scanMusic(musicFolder())
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('sounds:read', (_e, file: string) => {
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !readable(file)) throw new Error('Only sound effects and music-folder files can be previewed.')
      const b = fs.readFileSync(file)
      return { data: new Uint8Array(b) }
    } catch (e) {
      return fail(e)
    }
  })
  /** A sound effect, copied into the project's sounds folder (returns the copy's path). */
  ipcMain.handle('sounds:intoProject', (_e, file: string, dir: string, name?: string) => {
    try {
      const f = path.normalize(String(file))
      const rel = path.relative(soundsDir(), f)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Not a built-in sound effect.')
      const d = path.normalize(String(dir))
      if (!/\.studio$/i.test(d) || !fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Not a project folder.')
      const stem = String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 80)
      const out = path.join(d, 'sounds', stem ? `${stem}${path.extname(f)}` : path.basename(f))
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (!fs.existsSync(out)) fs.copyFileSync(f, out)
      return { out }
    } catch (e) {
      return fail(e)
    }
  })
}
