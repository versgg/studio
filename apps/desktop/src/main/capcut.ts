// Import from CapCut: CapCut's projects listed (name, cover, length, size, as CapCut shows
// them) and one read into Studio's terms (src/shared/capcut.ts). Read from CapCut's own folder
// and never written to. CapCut's resources a project uses are copied into the new Studio
// project so it stands on its own:
//   - fonts (CapCut's System font is Metropolis Medium, which Studio bundles; any other font
//     file is copied into <project>.studio/fonts/ and named by its own family name);
//   - stickers (the GIF or picture in CapCut's cache) into <project>.studio/stickers/;
//   - filters: each is a 512 × 512 colour table picture (8 × 8 tiles of 64 × 64, ByteDance's
//     layout), turned into a .cube that Studio applies at the filter's strength, in luts/.
// Transitions and text animations are CapCut's own shader programs; each comes over as the
// Studio transition or animation nearest it, and the project's notes say which.

import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CcAnim, CcClip, CcDraft, CcFilter, CcKeys, CcPlace, CcProject, CcSticker, CcStyle, CcText, CcTrack } from '../shared/capcut'
import { findCapcutRoot, timelineOf, userDataDirs } from './capcut-find'
import { ffmpeg } from './ffmpeg'

/** The folder chosen in From CapCut (CapCut isn't on Linux; its projects can be a copy anywhere), kept in the app's settings. */
const chosenFile = () => path.join(app.getPath('userData'), 'capcut.json')
function chosenRoot(): string | null {
  try {
    const root = JSON.parse(fs.readFileSync(chosenFile(), 'utf8')).root
    return typeof root === 'string' && root ? root : null
  } catch {
    return null
  }
}

let found: { at: number; root: string } | null = null
/**
 * CapCut's projects folder: STUDIO_CAPCUT_DIR (tests), else one chosen in Studio (a copy of
 * CapCut's projects, as on Linux) while it's there, else CapCut's own, found as CapCut finds it
 * (its settings, then its default folder; capcut-find.ts).
 */
export function capcutRoot() {
  if (process.env.STUDIO_CAPCUT_DIR) return process.env.STUDIO_CAPCUT_DIR
  const chosen = chosenRoot()
  if (chosen && fs.existsSync(chosen)) return chosen
  // Looked up again after a few seconds (every cover in the list asks).
  if (!found || Date.now() - found.at > 5000) found = { at: Date.now(), root: findCapcutRoot().root }
  return found.root
}

/**
 * Remembers where CapCut's projects are. `dir` may be the projects folder itself
 * (com.lveditor.draft) or a folder holding a copy of CapCut's data (as the move from Windows
 * packed it); the projects folder inside is kept. Null when there's no CapCut project in it.
 */
export function chooseRoot(dir: string): string | null {
  const tries = [dir, path.join(dir, 'com.lveditor.draft'), path.join(dir, 'Projects', 'com.lveditor.draft'), path.join(dir, 'User Data', 'Projects', 'com.lveditor.draft'), path.join(dir, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')]
  const root = tries.find((d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() && !!timelineOf(path.join(d, e.name)))
    } catch {
      return false
    }
  })
  if (!root) return null
  fs.writeFileSync(chosenFile(), JSON.stringify({ root }))
  return root
}

const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8'))

/** CapCut's projects, newest first. A project CapCut saved locked (newer versions encrypt) is listed as not readable. */
export function list(): CcDraft[] {
  const root = capcutRoot()
  if (!root || !fs.existsSync(root)) return []
  const out: CcDraft[] = []
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = path.join(root, d.name)
    const content = timelineOf(dir)
    if (!content) continue
    let meta: Record<string, unknown> = {}
    try {
      meta = readJson(path.join(dir, 'draft_meta_info.json'))
    } catch {}
    let readable = false
    try {
      const fd = fs.openSync(content, 'r')
      const head = Buffer.alloc(1)
      fs.readSync(fd, head, 0, 1, 0)
      fs.closeSync(fd)
      readable = head.toString() === '{'
    } catch {}
    const cover = path.join(dir, 'draft_cover.jpg')
    out.push({
      dir,
      name: String(meta.draft_name || d.name),
      cover: fs.existsSync(cover) ? cover : null,
      durationUs: Number(meta.tm_duration) || 0,
      bytes: Number(meta.draft_timeline_materials_size_) || 0,
      modified: Number(meta.tm_draft_modified) ? Number(meta.tm_draft_modified) / 1000 : fs.statSync(content).mtimeMs,
      readable,
    })
  }
  return out.sort((a, b) => b.modified - a.modified)
}

// Reading one.

type Json = Record<string, any>

/** "#RRGGBB" from CapCut's colour: "#rrggbb", or [r, g, b] in 0–1. */
function hex(c: unknown, fallback = '#FFFFFF') {
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase()
  if (Array.isArray(c) && c.length >= 3) return `#${c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, Number(v))) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  return fallback
}

const placeOf = (clip: Json | undefined): CcPlace => ({
  x: Number(clip?.transform?.x) || 0,
  y: Number(clip?.transform?.y) || 0,
  scale: Number(clip?.scale?.x) || 1,
  rotation: Number(clip?.rotation) || 0,
  alpha: clip?.alpha == null ? 1 : Number(clip.alpha),
  flipH: !!clip?.flip?.horizontal,
  flipV: !!clip?.flip?.vertical,
})

/** CapCut's keyframes, in Studio's settings and units. */
function keysOf(seg: Json, w: number, h: number): CcKeys | undefined {
  const map: Record<string, [string, (v: number) => number]> = {
    KFTypePositionX: ['posX', (v) => (v * w) / 2],
    KFTypePositionY: ['posY', (v) => (-v * h) / 2],
    KFTypeScaleX: ['scale', (v) => v * 100],
    KFTypeRotation: ['rotation', (v) => v],
    KFTypeAlpha: ['opacity', (v) => v * 100],
  }
  const out: CcKeys = {}
  for (const k of seg.common_keyframes ?? []) {
    const m = map[k.property_type]
    if (!m) continue
    out[m[0]] = (k.keyframe_list ?? []).map((p: Json) => ({ atUs: Math.round(Number(p.time_offset) || 0), value: m[1](Number(p.values?.[0]) || 0) }))
  }
  return Object.keys(out).length ? out : undefined
}

// CapCut's transitions and animations are its own programs; these are Studio's nearest.
const TRANSITIONS: Record<string, string> = {
  'White Flash': 'Fade through white', 'Bright Flash': 'Fade through white', 'Flash': 'Fade through white', 'Lens Dazzle': 'Fade through white',
  'Black Fade': 'Fade through black', 'Fade to Black': 'Fade through black', 'Dissolve': 'Dissolve', 'Mix': 'Dissolve', 'Powder Glitter': 'Dissolve', 'Drip Blend': 'Dissolve',
  'Echo Shift': 'Slide left', 'Stretch Left': 'Slide left', 'Pull Left': 'Slide left', 'Stretch Right': 'Slide right', 'Pull in': 'Zoom in', 'Pull In': 'Zoom in', 'Zoom In': 'Zoom in',
  'Bouncy Drop': 'Slide down', 'Slide Down': 'Slide down', 'Slide Up': 'Slide up', 'Blur': 'Blur', 'Circle': 'Circle', 'Wipe Left': 'Wipe left', 'Wipe Right': 'Wipe right',
}
const ANIM_IN: Record<string, string> = {
  'Polaroid Zoom': 'Zoom in', 'Zoom In': 'Zoom in', 'Zoom': 'Zoom in', 'Bounce In': 'Pop', 'Pop': 'Pop', 'Pop Up': 'Pop', 'Fade In': 'Fade', 'Fade': 'Fade',
  'Slide Left': 'Slide left', 'Slide Right': 'Slide right', 'Slide Up': 'Slide up', 'Slide Down': 'Slide down', 'Typewriter': 'Typewriter', 'Typing': 'Typewriter', 'Blur': 'Blur in', 'Spin': 'Spin', 'Rotate': 'Spin',
}
const ANIM_LOOP: Record<string, string> = { Tremble: 'Wiggle', Shake: 'Wiggle', Wiggle: 'Wiggle', Pulse: 'Pulse', Heartbeat: 'Pulse', Float: 'Float', Swing: 'Float', Spin: 'Spin', Rotate: 'Spin' }

/** A text or sticker's CapCut animations as Studio's; every one not matched by name is noted. */
function animOf(refs: Json[], notes: Set<string>): CcAnim | undefined {
  const out: CcAnim = {}
  for (const m of refs)
    for (const a of m.animations ?? []) {
      const name = String(a.name ?? '')
      const d = Math.max(100_000, Number(a.duration) || 500_000)
      if (a.type === 'in') {
        out.in = { name: ANIM_IN[name] ?? 'Fade', durationUs: d }
        if (ANIM_IN[name] !== name) notes.add(`Animation “${name}” (CapCut) came over as ${out.in.name}.`)
      } else if (a.type === 'out') {
        out.out = { name: ANIM_IN[name.replace(/ Out$/, ' In')] ?? ANIM_IN[name] ?? 'Fade', durationUs: d }
        notes.add(`Animation “${name}” (CapCut) came over as ${out.out.name}.`)
      } else if (a.type === 'loop') {
        out.loop = { name: ANIM_LOOP[name] ?? 'Pulse', periodUs: d }
        if (ANIM_LOOP[name] !== name) notes.add(`Animation “${name}” (CapCut) came over as ${out.loop.name}.`)
      }
    }
  return out.in || out.out || out.loop ? out : undefined
}

// Fonts.

/** A font file's family name (its name table: nameID 1, else the file's name). */
function fontFamily(file: string): string {
  try {
    const b = fs.readFileSync(file)
    const n = b.readUInt16BE(4)
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16
      if (b.toString('latin1', r, r + 4) !== 'name') continue
      const t = b.readUInt32BE(r + 8)
      const count = b.readUInt16BE(t + 2), strings = t + b.readUInt16BE(t + 4)
      let best = ''
      for (let k = 0; k < count; k++) {
        const e = t + 6 + k * 12
        const [platform, , , id, len, off] = [0, 2, 4, 6, 8, 10].map((o) => b.readUInt16BE(e + o))
        if (id !== 4 && id !== 1) continue
        const raw = b.subarray(strings + off, strings + off + len)
        const s = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1')
        // The full name (4) tells faces apart ("Quicksand Bold"); a family (1) is the fallback.
        if (id === 4 || !best) best = s
        if (id === 4) break
      }
      if (best.trim()) return best.trim()
    }
  } catch {}
  return path.parse(file).name
}

/** A font's line height (ascent + descent, its hhea table) as a share of its em: CapCut sizes text by it. */
function lineRatio(file: string): number {
  try {
    const b = fs.readFileSync(file)
    const n = b.readUInt16BE(4)
    let upm = 0, line = 0
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16
      const tag = b.toString('latin1', r, r + 4), off = b.readUInt32BE(r + 8)
      if (tag === 'head') upm = b.readUInt16BE(off + 18)
      if (tag === 'hhea') line = b.readInt16BE(off + 4) - b.readInt16BE(off + 6)
    }
    if (upm && line > 0) return line / upm
  } catch {}
  return 1.2
}

/** Font/SystemFont/en.ttf somewhere inside `dir`, a few folders down at most. */
function findSystemFont(dir: string, depth: number): string | undefined {
  const f = path.join(dir, 'Font', 'SystemFont', 'en.ttf')
  if (fs.existsSync(f)) return f
  if (depth <= 0) return undefined
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^(Frameworks|_CodeSignature|MacOS|PlugIns|.*\.lproj)$/.test(e.name)) continue
      const hit = findSystemFont(path.join(dir, e.name), depth - 1)
      if (hit) return hit
    }
  } catch {}
  return undefined
}

let systemFontFound: { root: string; font?: string } | undefined
/**
 * CapCut's System font (en.ttf) in the newest CapCut installed: under CapCut/Apps/<version>/Resources
 * (Windows, and a packed copy beside its projects), else inside CapCut.app on a Mac.
 */
function systemFont(): string | undefined {
  const root = capcutRoot()
  if (systemFontFound?.root !== root) systemFontFound = { root, font: lookForSystemFont(root) }
  return systemFontFound.font
}
function lookForSystemFont(root: string): string | undefined {
  const homes = [...(root ? [path.dirname(path.dirname(path.dirname(root)))] : []), ...userDataDirs().map((ud) => path.dirname(ud))]
  for (const home of homes) {
    const apps = path.join(home, 'Apps')
    try {
      const versions = fs.readdirSync(apps).filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const v of versions) {
        const f = path.join(apps, v, 'Resources', 'Font', 'SystemFont', 'en.ttf')
        if (fs.existsSync(f)) return f
      }
    } catch {}
  }
  if (process.platform === 'darwin')
    for (const app of ['/Applications/CapCut.app', path.join(os.homedir(), 'Applications', 'CapCut.app')]) {
      const f = findSystemFont(path.join(app, 'Contents', 'Resources'), 4)
      if (f) return f
    }
  return undefined
}

// Filters.

/** The colour table picture in a CapCut filter's folder: a 512 × 512 PNG named like a filter. */
function lutPicture(dir: string): string | null {
  const found: string[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 6 || !fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f, depth + 1)
      else if (/\.png$/i.test(e.name)) {
        try {
          const b = fs.readFileSync(f).subarray(0, 24)
          if (b.readUInt32BE(16) === 512 && b.readUInt32BE(20) === 512) found.push(f)
        } catch {}
      }
    }
  }
  walk(dir, 0)
  // A filter may carry an identity table too (2 KB, it changes nothing); the one that holds the
  // look is the biggest (Silver Age: filter2.png, 138 KB, not its LvFilter's filter.png).
  const pictures = found.filter((f) => !/skin|mask|paper|noise|grain/i.test(path.basename(f)))
  return pictures.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null
}

/** A CapCut colour table picture as a 64-step .cube (blue by tile, red across a tile, green down it). */
async function cubeOf(png: string, out: string) {
  if (fs.existsSync(out)) return out
  const raw = await ffmpeg(['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (raw.length < 512 * 512 * 3) throw new Error(`${path.basename(png)} isn’t a 512 × 512 colour table`)
  const lines = ['TITLE "CapCut filter"', 'LUT_3D_SIZE 64']
  for (let b = 0; b < 64; b++)
    for (let g = 0; g < 64; g++)
      for (let r = 0; r < 64; r++) {
        const x = (b % 8) * 64 + r, y = Math.floor(b / 8) * 64 + g
        const i = (y * 512 + x) * 3
        lines.push(`${(raw[i] / 255).toFixed(5)} ${(raw[i + 1] / 255).toFixed(5)} ${(raw[i + 2] / 255).toFixed(5)}`)
      }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, lines.join('\n') + '\n')
  return out
}

/** A file in a CapCut effect's folder, by name. */
function findIn(dir: string, name: string): string | null {
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) if (path.basename(f).toLowerCase() === name) return path.join(dir, f)
  return null
}

/**
 * CapCut's Polaroid Zoom card with the photo in it: its own picture of the card (framephoto.png,
 * 512 × 512 with its shadow) drawn at 1024, the photo filling the card's window (the white of
 * framephotoshape.png).
 */
async function polaroidOf(photo: string, animDir: string, into: string): Promise<string | null> {
  const frame = findIn(animDir, 'framephoto.png'), shape = findIn(animDir, 'framephotoshape.png')
  if (!frame || !shape) return null
  const out = path.join(into, 'capcut', `${safe(path.parse(photo).name)} polaroid.png`)
  if (fs.existsSync(out)) return out
  const raw = await ffmpeg(['-i', shape, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  let [x0, y0, x1, y1] = [512, 512, -1, -1]
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (raw[y * 512 + x] > 128) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
  if (x1 < 0) return null
  const [x, y, w, h] = [x0 * 2, y0 * 2, (x1 - x0 + 1) * 2, (y1 - y0 + 1) * 2]
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await ffmpeg(['-y', '-i', frame, '-i', photo, '-filter_complex', `[0]scale=1024:1024:flags=lanczos,format=rgba[f];[1]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},format=rgba[p];[f][p]overlay=${x}:${y}`, '-frames:v', '1', '-update', '1', out])
  return out
}

/** A moving sticker looped to `durationUs` (QuickTime Animation, which keeps its transparency); a still or long enough one as it is. */
async function loopedFor(file: string, durationUs: number) {
  let length = 0
  try {
    length = Number((await ffmpeg(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { tool: 'ffprobe' })).toString().trim()) || 0
  } catch {}
  const need = durationUs / 1e6
  if (!length || length >= need - 0.02) return file
  const out = file.replace(/\.[^.]+$/, ` ${Math.ceil(need * 10) / 10}s.mov`)
  if (!fs.existsSync(out)) await ffmpeg(['-y', '-stream_loop', '-1', '-i', file, '-t', need.toFixed(3), '-c:v', 'qtrle', '-pix_fmt', 'argb', out])
  return out
}

/** Studio's Film grain amount for a CapCut filter with a grain step. */
const GRAIN = 15

const safe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'capcut'

/** A video's sound as a sound file in the project (its own stream copied; re-made as AAC if it won't copy). */
async function soundOf(video: string, into: string) {
  const out = path.join(into, 'sounds', `${safe(path.parse(video).name)}.m4a`)
  if (fs.existsSync(out)) return out
  fs.mkdirSync(path.dirname(out), { recursive: true })
  try {
    await ffmpeg(['-y', '-i', video, '-vn', '-map', '0:a:0', '-c:a', 'copy', out])
  } catch {
    await ffmpeg(['-y', '-i', video, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k', out])
  }
  return out
}

/** A path CapCut wrote with its draft-folder placeholder ("##_draftpath_placeholder_<id>_##/…"), in the project's own folder. */
const inDraft = (p: string | undefined, dir: string) => (p ? path.normalize(p.replace(/##_draftpath_placeholder_[0-9A-F-]+_##/i, () => dir)) : p)

/**
 * A sound CapCut separated (vocal separation: the voice only, or the voice taken out), as a plain
 * WAV in the project. CapCut keeps it as a WAV with every byte XORed by one key and a 68-byte
 * "bdve" box after it (whose last 4 bytes say its length).
 */
function separatedOf(file: string, into: string): string | null {
  const out = path.join(into, 'sounds', `${safe(path.parse(file).name)} separated.wav`)
  if (fs.existsSync(out)) return out
  const raw = fs.readFileSync(file)
  const tail = raw.length > 12 && raw.toString('latin1', raw.length - 8, raw.length - 4) === 'size' ? raw.readUInt32BE(raw.length - 4) : 0
  const body = Buffer.from(raw.subarray(0, raw.length - tail))
  const key = body[0] ^ 0x52 // the R of RIFF
  if (key) for (let i = 0; i < body.length; i++) body[i] ^= key
  if (body.toString('latin1', 0, 4) !== 'RIFF' || body.toString('latin1', 8, 12) !== 'WAVE') return null
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, body)
  return out
}

/**
 * One CapCut project in Studio's terms, its fonts, stickers and filters copied into `into`
 * (the new Studio project's folder).
 */
export async function read(dir: string, into: string): Promise<CcProject> {
  const timeline = timelineOf(dir)
  if (!timeline) throw new Error('That CapCut project has no timeline file (draft_content.json or draft_info.json).')
  const j = readJson<Json>(timeline)
  let meta: Json = {}
  try {
    meta = readJson(path.join(dir, 'draft_meta_info.json'))
  } catch {}
  const W = Number(j.canvas_config?.width) || 1080
  const H = Number(j.canvas_config?.height) || 1920
  const byId = new Map<string, { kind: string; m: Json }>()
  for (const [kind, arr] of Object.entries<Json>(j.materials ?? {})) if (Array.isArray(arr)) for (const m of arr) if (m?.id) byId.set(m.id, { kind, m })
  const refs = (seg: Json, kind: string) => (seg.extra_material_refs ?? []).map((id: string) => byId.get(id)).filter((x: { kind: string } | undefined) => x?.kind === kind).map((x: { m: Json }) => x.m) as Json[]
  const notes = new Set<string>()
  const missing = new Set<string>()
  const luts = new Map<string, string>()
  const grains = new Set<string>()
  const grainOf = (e: Json) => (grains.has(String(e.effect_id ?? e.resource_id ?? e.id)) ? GRAIN : undefined)

  /** A filter's colour table, as a .cube in the project (made once per filter). */
  const lutFor = async (e: Json): Promise<string | null> => {
    const key = String(e.effect_id ?? e.resource_id ?? e.id)
    if (luts.has(key)) return luts.get(key)!
    const pic = e.path && fs.existsSync(e.path) ? lutPicture(e.path) : null
    if (!pic) {
      notes.add(`The filter “${e.name}” isn’t in CapCut’s cache on this computer, so it was left out.`)
      return null
    }
    // CapCut's grain step comes over as Studio's Film grain (its own grain is a shader).
    if (fs.readdirSync(e.path, { recursive: true }).some((f) => /LumiGrain/.test(String(f)))) {
      grains.add(key)
      notes.add(`The filter “${e.name}” adds grain in CapCut; it came over as Studio’s Film grain.`)
    }
    const cube = await cubeOf(pic, path.join(into, 'luts', `${safe(e.name)} ${key}.cube`))
    luts.set(key, cube)
    return cube
  }

  const fonts = new Map<string, { family: string; file: string; ratio: number }>()
  /**
   * The font a text is set in: its own file copied into the project, CapCut's System font too
   * (its en.ttf draws 6 % wider than the Metropolis Studio bundles, so it's brought as
   * "CapCut System"); Metropolis only when CapCut's file is gone.
   */
  const fontFor = (file: string | undefined): { font: string; fontFile?: string; weight: number; lineRatio: number } => {
    const system = !file || /SystemFont[\\/]en\.ttf$/i.test(file)
    const src = system ? [file, systemFont()].find((f) => f && fs.existsSync(f)) : file
    if (!src || !fs.existsSync(src)) {
      if (!system) notes.add(`A font (${path.basename(file!)}) isn’t on this computer; that text uses CapCut’s System font instead.`)
      return { font: 'Metropolis', weight: 500, lineRatio: 1 }
    }
    if (!fonts.has(src)) {
      const family = system ? 'CapCut System' : safe(fontFamily(src))
      const to = path.join(into, 'fonts', `${family}${path.extname(src).toLowerCase()}`)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      if (!fs.existsSync(to)) fs.copyFileSync(src, to)
      fonts.set(src, { family, file: to, ratio: lineRatio(src) })
    }
    const f = fonts.get(src)!
    return { font: f.family, fontFile: f.file, weight: 400, lineRatio: f.ratio }
  }

  const styleOf = (t: Json): { text: string; style: CcStyle } => {
    let c: Json = {}
    try {
      c = JSON.parse(t.content)
    } catch {
      c = { text: String(t.content ?? ''), styles: [] }
    }
    const st: Json = c.styles?.[0] ?? {}
    if ((c.styles?.length ?? 0) > 1) notes.add('A text with words in more than one colour or size came over in its first one.')
    // check_flag says which parts are on: 8 the outline, 16 the box behind, 32 the shadow.
    const flag = Number(t.check_flag) || 7
    const font = fontFor(st.font?.path || t.font_path)
    return {
      text: String(c.text ?? ''),
      style: {
        ...font,
        size: Number(st.size ?? t.font_size) || 7,
        color: st.fill?.content?.solid?.color ? hex(st.fill.content.solid.color) : hex(t.text_color),
        alpha: t.text_alpha == null ? 1 : Number(t.text_alpha),
        align: t.alignment === 0 ? 'left' : t.alignment === 2 ? 'right' : 'center',
        lineSpacing: Number(t.line_spacing) || 0,
        letterSpacing: Number(t.letter_spacing) || 0,
        italic: !!t.italic_degree,
        underline: !!t.underline,
        bold: Number(t.bold_width) || 0,
        stroke: flag & 8 ? { color: hex(st.strokes?.[0]?.content?.solid?.color ?? t.border_color, '#000000'), width: Number(st.strokes?.[0]?.width ?? t.border_width) || 0.08 } : null,
        background: flag & 16 ? { color: hex(t.background_color, '#000000'), alpha: t.background_alpha == null ? 1 : Number(t.background_alpha), radius: Number(t.background_round_radius) || 0, width: Number(t.background_width) || 0.14, height: Number(t.background_height) || 0.14, style: Number(t.background_style) || 0 } : null,
        shadow: flag & 32 ? { color: hex(t.shadow_color, '#000000'), alpha: t.shadow_alpha == null ? 0.9 : Number(t.shadow_alpha), blur: Number(t.shadow_smoothing ?? 0.45), distance: Number(t.shadow_distance ?? 5), angle: Number(t.shadow_angle ?? -45) } : null,
      },
    }
  }

  const tracks: CcTrack[] = []
  let main = true
  for (const tr of j.tracks ?? []) {
    const segs: Json[] = (tr.segments ?? []).filter((s: Json) => s.visible !== false)
    const span = (s: Json) => ({ startUs: Number(s.target_timerange?.start) || 0, durationUs: Number(s.target_timerange?.duration) || 0 })
    if (tr.type === 'video' || tr.type === 'audio') {
      const clips: CcClip[] = []
      for (const s of segs) {
        const got = byId.get(s.material_id)
        if (!got) continue
        const m = got.m
        let file = inDraft(m.path, dir)
        // CapCut's vocal separation plays the sound it separated (over the stretch of the source it
        // covers) instead of the file itself, so it comes over even when that file is gone.
        let shiftUs = 0
        const sep = tr.type === 'audio' ? refs(s, 'vocal_separations').find((v) => Number(v.choice) > 0 && v.production_path) : undefined
        const made = sep && inDraft(sep.production_path, dir)
        const wav = made && fs.existsSync(made) ? separatedOf(made, into) : null
        if (wav) {
          file = wav
          shiftUs = Number(sep!.time_range?.start) || 0
        } else if (sep && file && fs.existsSync(file)) notes.add('A sound CapCut separated (the voice only, or the voice taken out) came over whole: its separated file isn’t on this computer.')
        if (!file || !fs.existsSync(file)) {
          if (file) missing.add(file)
          continue
        }
        // A sound taken from a video ("extract music") is the video's own sound, saved as a sound file.
        if (tr.type === 'audio' && /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file)) file = await soundOf(file, into)
        const fade = refs(s, 'audio_fades')[0]
        const filter = refs(s, 'effects').find((e) => e.type === 'filter')
        const trans = refs(s, 'transitions')[0]
        const crop = m.crop && Number(m.crop.lower_right_x) > 0 ? { x: Number(m.crop.upper_left_x) || 0, y: Number(m.crop.upper_left_y) || 0, w: (Number(m.crop.upper_right_x) || 1) - (Number(m.crop.upper_left_x) || 0), h: (Number(m.crop.lower_left_y) || 1) - (Number(m.crop.upper_left_y) || 0) } : undefined
        const clip: CcClip = {
          path: file,
          kind: tr.type === 'audio' ? 'audio' : m.type === 'photo' ? 'photo' : 'video',
          ...span(s),
          inUs: Math.max(0, (Number(s.source_timerange?.start) || 0) - shiftUs),
          speed: Number(s.speed) || 1,
          reverse: !!s.reverse,
          volume: s.volume == null ? 1 : Number(s.volume),
          fadeInUs: Number(fade?.fade_in_duration) || 0,
          fadeOutUs: Number(fade?.fade_out_duration) || 0,
          ...(tr.type === 'video' ? { place: placeOf(s.clip), keys: keysOf(s, W, H), anim: animOf(refs(s, 'material_animations').map((a) => ({ ...a, animations: (a.animations ?? []).filter((x: Json) => !(x.name === 'Polaroid Zoom' && m.type === 'photo')) })), notes) } : {}),
          ...(crop && (crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999) ? { crop } : {}),
        }
        // Polaroid Zoom on a photo: the photo set in CapCut's own polaroid card; the page flies it in.
        const polaroid = tr.type === 'video' && m.type === 'photo' ? refs(s, 'material_animations').flatMap((a) => a.animations ?? []).find((x: Json) => x.name === 'Polaroid Zoom' && x.type === 'in') : undefined
        if (polaroid) {
          const card = polaroid.path && fs.existsSync(polaroid.path) ? await polaroidOf(file, polaroid.path, into) : null
          if (card) {
            clip.path = card
            clip.polaroid = { motionUs: Math.round(Math.min(900_000, Math.max(300_000, 0.22 * (Number(polaroid.duration) || 3_000_000)))) }
          } else notes.add('A Polaroid Zoom isn’t in CapCut’s cache on this computer; that photo came over with Zoom in.')
          if (!card) clip.anim = { in: { name: 'Zoom in', durationUs: 500_000 } }
        }
        if (filter) {
          const cube = await lutFor(filter)
          if (cube) clip.lut = { path: cube, strength: Math.round((filter.value == null ? 1 : Number(filter.value)) * 100), name: filter.name, grain: grainOf(filter) }
        }
        if (trans && tr.type === 'video') {
          clip.transition = { name: TRANSITIONS[trans.name] ?? 'Dissolve', durationUs: Number(trans.duration) || 500_000, from: trans.name }
          if (TRANSITIONS[trans.name] !== trans.name) notes.add(`Transition “${trans.name}” (CapCut) came over as ${clip.transition.name}.`)
        }
        if (refs(s, 'effects').some((e) => e.type !== 'filter')) notes.add('An effect on a clip (CapCut’s own) was left out.')
        if (s.common_keyframes?.some((k: Json) => !['KFTypePositionX', 'KFTypePositionY', 'KFTypeScaleX', 'KFTypeScaleY', 'KFTypeRotation', 'KFTypeAlpha'].includes(k.property_type))) notes.add('Some keyframes (CapCut’s colour or sound ones) were left out.')
        clips.push(clip)
      }
      if (tr.type === 'video') {
        tracks.push({ kind: 'video', main, clips, hidden: false, muted: false })
        main = false
      } else tracks.push({ kind: 'audio', clips, muted: false })
    } else if (tr.type === 'text') {
      const texts: CcText[] = []
      for (const s of segs) {
        const m = byId.get(s.material_id)?.m
        if (!m) continue
        const { text, style } = styleOf(m)
        if (!text.trim()) continue
        texts.push({ text, style, ...span(s), place: placeOf(s.clip), keys: keysOf(s, W, H), anim: animOf(refs(s, 'material_animations'), notes), caption: m.type === 'subtitle' })
      }
      // A track of auto captions becomes a captions track; text clips stay text clips.
      if (texts.length) tracks.push({ kind: 'text', texts, captions: texts.every((t) => t.caption), hidden: false })
    } else if (tr.type === 'sticker') {
      const stickers: CcSticker[] = []
      for (const s of segs) {
        const m = byId.get(s.material_id)?.m
        if (!m) continue
        const src = m.path && fs.existsSync(m.path) ? (fs.statSync(m.path).isDirectory() ? fs.readdirSync(m.path).map((f) => path.join(m.path, f)).sort((a, b) => Number(/final\.gif$/i.test(b)) - Number(/final\.gif$/i.test(a))).find((f) => /\.(gif|png|webp|apng)$/i.test(f)) : m.path) : null
        if (!src) {
          notes.add(`The sticker “${m.name || 'sticker'}” was left out: CapCut has cleared it from its cache. Open the project in CapCut once (it fetches its stickers again), then import it again.`)
          continue
        }
        const to = path.join(into, 'stickers', `${safe(m.name || 'sticker')} ${m.resource_id ?? m.id}${path.extname(src).toLowerCase()}`)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        if (!fs.existsSync(to)) fs.copyFileSync(src, to)
        // CapCut loops a moving sticker for as long as it's shown; Studio plays a file once, so a
        // looped copy as long as that is made (with its transparency).
        const shown = span(s)
        const file = /\.(gif|webp|apng)$/i.test(to) ? await loopedFor(to, shown.durationUs) : to
        stickers.push({ path: file, ...shown, place: placeOf(s.clip), keys: keysOf(s, W, H), anim: animOf(refs(s, 'material_animations'), notes), name: m.name || 'Sticker' })
      }
      if (stickers.length) tracks.push({ kind: 'sticker', stickers, hidden: false })
    } else if (tr.type === 'filter') {
      const filters: CcFilter[] = []
      for (const s of segs) {
        const e = byId.get(s.material_id)?.m
        if (!e) continue
        const cube = await lutFor(e)
        if (cube) filters.push({ lut: cube, strength: Math.round((e.value == null ? 1 : Number(e.value)) * 100), name: e.name, grain: grainOf(e), ...span(s) })
      }
      if (filters.length) tracks.push({ kind: 'filter', filters })
    } else if (segs.length) notes.add(`A CapCut ${tr.type} track (its own effects) was left out.`)
  }
  const mats = j.materials ?? {}
  if (mats.common_mask?.length) notes.add('A mask on a clip was left out.')
  if (mats.canvases?.some((c: Json) => c.type && c.type !== 'canvas_color')) notes.add('A blurred or picture background behind a clip came over as black.')
  if (mats.realtime_denoises?.length) notes.add('CapCut’s noise reduction on a sound was left out (Studio’s is in the Audio tab).')
  if (mats.vocal_beautifys?.length) notes.add('CapCut’s voice enhancement was left out.')
  if (missing.size) notes.add(`${missing.size} file${missing.size === 1 ? '' : 's'} CapCut used ${missing.size === 1 ? 'is' : 'are'} no longer on this computer.`)
  return { name: String(meta.draft_name || path.basename(dir)), width: W, height: H, fps: Number(j.fps) || 30, durationUs: Number(j.duration) || 0, tracks, notes: [...notes], missing: [...missing] }
}
