// Projects on disk, for the Home page, Save as and Versions. Each project is a
// `<name>.studio` folder holding project.json, history.jsonl and its caches; these handlers
// only read those, copy whole project folders, and copy project.json in and out of
// `<project>.studio/versions/`.

import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from './ffmpeg'

export interface ProjectInfo {
  dir: string
  name: string
  width: number
  height: number
  durationUs: number
  /** Last saved, ms since 1970. */
  modified: number
  /** Who made the edits: an agent through MCP, you, or both. */
  byAgent: boolean
  byYou: boolean
  /** A cached thumbnail of the first picture clip, if there is one. */
  poster: string | null
  clips: number
}

interface Clip {
  mediaId: string
  startUs: number
  durationUs: number
}
interface Project {
  name?: string
  width?: number
  height?: number
  tracks?: { main?: boolean; kind?: string; clips?: Clip[] }[]
  media?: { id: string; kind?: string; path?: string; durationUs?: number }[]
}

/** The first picture clip's media: what the project's poster is a frame of. */
function posterMedia(p: Project) {
  const main = (p.tracks ?? []).find((t) => t.main)
  const pictures = new Map((p.media ?? []).filter((m) => m.kind !== 'audio').map((m) => [m.id, m]))
  const first = main?.clips?.find((c) => pictures.has(c.mediaId))
  return first ? pictures.get(first.mediaId)! : null
}

/**
 * Home's big thumbnails: the poster's frame again, up to STILL_H tall (the poster is 360), made
 * once into the project's cache. Two at a time, at low priority.
 */
const STILL_H = 960
const stills = new Map<string, Promise<string | null>>()
let stillsRunning = 0
const stillsWaiting: (() => void)[] = []
async function still(dir: string): Promise<string | null> {
  const m = posterMedia(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as Project)
  if (!m?.path) return null
  const out = path.join(dir, 'cache', m.id, `still-${STILL_H}.jpg`)
  if (fs.existsSync(out)) return out
  if (!fs.existsSync(m.path)) return null
  let job = stills.get(out)
  if (!job) {
    job = (async () => {
      if (stillsRunning >= 2) await new Promise<void>((go) => stillsWaiting.push(go))
      stillsRunning++
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true })
        // The poster's moment: 2/5 into a video.
        const at = m.kind === 'video' && m.durationUs ? ['-ss', ((m.durationUs * 2) / 5 / 1e6).toFixed(3)] : []
        await ffmpeg([...at, '-i', m.path!, '-frames:v', '1', '-vf', `scale=-2:'min(ih,${STILL_H})'`, '-q:v', '3', '-y', out], { timeoutMs: 30000 })
        return fs.existsSync(out) ? out : null
      } catch {
        return null
      } finally {
        stillsRunning--
        stillsWaiting.shift()?.()
        stills.delete(out)
      }
    })()
    stills.set(out, job)
  }
  return job
}

const isProject = (dir: string) => dir.endsWith('.studio') && fs.existsSync(path.join(dir, 'project.json'))

function info(dir: string): ProjectInfo | null {
  try {
    const file = path.join(dir, 'project.json')
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project
    const clips = (p.tracks ?? []).flatMap((t) => t.clips ?? [])
    const durationUs = clips.reduce((m, c) => Math.max(m, (c.startUs ?? 0) + (c.durationUs ?? 0)), 0)
    let byAgent = false
    let byYou = false
    const history = path.join(dir, 'history.jsonl')
    if (fs.existsSync(history)) {
      for (const line of fs.readFileSync(history, 'utf8').split('\n')) {
        const actor = /"actor"\s*:\s*"([^"]*)"/.exec(line)?.[1]
        if (!actor) continue
        if (actor === 'you') byYou = true
        else byAgent = true
      }
    }
    const first = posterMedia(p)
    const poster = first ? path.join(dir, 'cache', first.id, 'poster.jpg') : null
    return {
      dir,
      name: p.name ?? path.basename(dir, '.studio'),
      width: p.width ?? 1080,
      height: p.height ?? 1920,
      durationUs,
      modified: fs.statSync(file).mtimeMs,
      byAgent,
      byYou: byYou || !byAgent,
      poster: poster && fs.existsSync(poster) ? poster : null,
      clips: clips.length,
    }
  } catch {
    return null
  }
}

const clean = (name: string) => name.replace(/[<>:"/\\|?*]/g, '-').trim() || 'Untitled'

/** A folder name that isn't taken: "Name.studio", then "Name 2.studio" and on. */
function freeDir(parent: string, name: string) {
  let n = 1
  for (;;) {
    const dir = path.join(parent, `${clean(name)}${n > 1 ? ` ${n}` : ''}.studio`)
    if (!fs.existsSync(dir)) return dir
    n++
  }
}

function setName(dir: string, name: string) {
  const file = path.join(dir, 'project.json')
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  p.name = name
  fs.writeFileSync(file, JSON.stringify(p, null, 2))
}

export function registerProjects(projectsDir: string) {
  /** Every project in the projects folder, plus the other folders given (recent projects elsewhere). */
  ipcMain.handle('projects:list', (_e, extra: unknown) => {
    const dirs = new Set<string>()
    try {
      for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) if (e.isDirectory()) dirs.add(path.join(projectsDir, e.name))
    } catch {}
    if (Array.isArray(extra)) for (const d of extra.slice(0, 50)) if (typeof d === 'string') dirs.add(path.normalize(d))
    return [...dirs].filter(isProject).map(info).filter(Boolean).sort((a, b) => b!.modified - a!.modified)
  })

  /** A sharper still of the project's poster frame, for big thumbnails; null when there's none. */
  ipcMain.handle('project:still', (_e, dir: string) => (isProject(dir) ? still(dir).catch(() => null) : null))

  /** A copy of the project under a new name; returns its folder. */
  ipcMain.handle('project:saveAs', async (e, dir: string, name: string, pick: boolean) => {
    if (!isProject(dir)) throw new Error('That project folder is missing.')
    let parent = path.dirname(dir)
    if (pick) {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showOpenDialog(win, { title: 'Save the copy in', defaultPath: parent, properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      parent = r.filePaths[0]
    }
    const to = freeDir(parent, name)
    fs.cpSync(dir, to, { recursive: true })
    setName(to, name.trim() || path.basename(to, '.studio'))
    return to
  })

  /** What deleting a project frees, and what inside it was made in Studio (voiceovers, recordings…). */
  ipcMain.handle('project:size', (_e, dir: string) => {
    if (!isProject(dir)) return null
    let bytes = 0
    const made: Record<string, number> = {}
    const walk = (d: string, top?: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p, top ?? e.name)
        else {
          const size = fs.statSync(p).size
          bytes += size
          if (top && top !== 'cache') made[top] = (made[top] ?? 0) + 1
        }
      }
    }
    walk(dir)
    return { bytes, made }
  })

  /**
   * Deletes a project for good: its folder with project.json, history, caches, and whatever
   * Studio made inside it (voiceovers, recordings, compounds, freeze frames, text). Media it
   * linked from elsewhere on the computer is left where it is.
   */
  ipcMain.handle('project:delete', (_e, dir: string) => {
    const d = path.normalize(dir)
    if (!isProject(d)) throw new Error('That isn’t a Studio project folder.')
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return !fs.existsSync(d)
  })

  ipcMain.handle('project:rename', (_e, dir: string, name: string) => {
    if (!isProject(dir)) throw new Error('That project folder is missing.')
    setName(dir, name.trim() || 'Untitled')
    return true
  })

  // Versions: named copies of project.json in <project>.studio/versions/.
  const versionsDir = (dir: string) => path.join(dir, 'versions')
  ipcMain.handle('project:versions', (_e, dir: string) => {
    if (!isProject(dir)) return []
    const v = versionsDir(dir)
    if (!fs.existsSync(v)) return []
    return fs
      .readdirSync(v)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: path.join(v, f), name: f.replace(/\.json$/, ''), saved: fs.statSync(path.join(v, f)).mtimeMs }))
      .sort((a, b) => b.saved - a.saved)
  })
  ipcMain.handle('project:saveVersion', (_e, dir: string, name: string) => {
    if (!isProject(dir)) throw new Error('That project folder is missing.')
    const v = versionsDir(dir)
    fs.mkdirSync(v, { recursive: true })
    let file = path.join(v, `${clean(name)}.json`)
    for (let n = 2; fs.existsSync(file); n++) file = path.join(v, `${clean(name)} ${n}.json`)
    fs.copyFileSync(path.join(dir, 'project.json'), file)
    return file
  })
  /** Puts a version back as the project (after keeping what's there as a version too). */
  ipcMain.handle('project:restoreVersion', (_e, dir: string, file: string) => {
    if (!isProject(dir)) throw new Error('That project folder is missing.')
    const v = versionsDir(dir)
    if (path.dirname(path.normalize(file)) !== path.normalize(v) || !fs.existsSync(file)) throw new Error('That version is missing.')
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
    fs.copyFileSync(path.join(dir, 'project.json'), path.join(v, `Before restoring ${stamp}.json`))
    fs.copyFileSync(file, path.join(dir, 'project.json'))
    return true
  })
  ipcMain.handle('project:deleteVersion', (_e, dir: string, file: string) => {
    if (path.dirname(path.normalize(file)) !== path.normalize(versionsDir(dir))) return false
    fs.rmSync(file, { force: true })
    return true
  })
}
