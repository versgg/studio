// Where CapCut keeps its projects on this computer, found the way CapCut itself finds them, so
// From CapCut lists them at once with nothing to choose (on a friend's Mac nobody knew where
// CapCut saved, and the list came up empty).
//   - CapCut's "User Data" folder: on a Mac ~/Movies/CapCut/User Data (the App Store copy keeps
//     it inside its container, ~/Library/Containers/com.lemon.lvoverseas/Data/Movies/…), on
//     Windows %LOCALAPPDATA%\CapCut\User Data.
//   - Its projects: User Data/Projects/com.lveditor.draft, unless they were moved in CapCut's
//     settings, which it keeps as `currentCustomDraftPath=` in User Data/Config/globalSetting
//     (Qt's INI format).
//   - A project folder's timeline: CapCut for Windows writes draft_content.json, CapCut for Mac
//     draft_info.json (some versions keep both, in step).
// No electron import: node --test runs this file (scripts/capcut-find.test.mjs).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TIMELINE_FILES = ['draft_content.json', 'draft_info.json'] as const

/** A CapCut project folder's timeline file (the newer when there are both), or null when it isn't one. */
export function timelineOf(dir: string): string | null {
  let best: string | null = null
  let at = -Infinity
  for (const f of TIMELINE_FILES) {
    const p = path.join(dir, f)
    try {
      const m = fs.statSync(p).mtimeMs
      if (m > at) [best, at] = [p, m]
    } catch {}
  }
  return best
}

/** CapCut's User Data folders on this system: where its settings are, and its projects by default. */
export function userDataDirs(platform: string = process.platform, home: string = os.homedir(), env: Record<string, string | undefined> = process.env): string[] {
  if (platform === 'darwin') return [path.join(home, 'Movies', 'CapCut', 'User Data'), path.join(home, 'Library', 'Containers', 'com.lemon.lvoverseas', 'Data', 'Movies', 'CapCut', 'User Data')]
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CapCut', 'User Data')]
  return []
}

/** The projects folder CapCut was set to in its settings: `currentCustomDraftPath=` in its globalSetting. */
export function customDraftPath(globalSetting: string): string | null {
  for (const raw of globalSetting.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('currentCustomDraftPath=')) continue
    let v = line.slice('currentCustomDraftPath='.length).trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    // Qt writes a backslash as two, and may write other letters as \xNNNN.
    v = v.replace(/\\x([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\')
    return v || null
  }
  return null
}

/** How many projects a folder holds, and when the newest was saved. */
function projectsIn(dir: string): { count: number; latest: number } {
  let count = 0
  let latest = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const t = timelineOf(path.join(dir, e.name))
      if (!t) continue
      count++
      latest = Math.max(latest, fs.statSync(t).mtimeMs)
    }
  } catch {}
  return { count, latest }
}

export type CapcutFound = {
  /** The projects folder, or '' where CapCut has no home (Linux). */
  root: string
  /** `settings`: the folder CapCut was moved to; `default`: its own. */
  how: 'settings' | 'default' | 'none'
  /** Every folder looked in, in order. */
  looked: string[]
}

/**
 * CapCut's projects folder on this computer: of the folders CapCut's settings name and its own,
 * the one with the most recently saved project (the settings' first when they tie); with no
 * projects anywhere, the folder the settings name, else CapCut's own.
 */
export function findCapcutRoot(platform: string = process.platform, home: string = os.homedir(), env: Record<string, string | undefined> = process.env): CapcutFound {
  const uds = userDataDirs(platform, home, env)
  const tried: { dir: string; how: 'settings' | 'default' }[] = []
  const add = (dir: string | null, how: 'settings' | 'default') => {
    if (dir && !tried.some((t) => path.resolve(t.dir) === path.resolve(dir))) tried.push({ dir, how })
  }
  for (const ud of uds) {
    try {
      add(customDraftPath(fs.readFileSync(path.join(ud, 'Config', 'globalSetting'), 'utf8')), 'settings')
    } catch {}
  }
  for (const ud of uds) add(path.join(ud, 'Projects', 'com.lveditor.draft'), 'default')
  const looked = tried.map((t) => t.dir)
  let best: { dir: string; how: 'settings' | 'default'; latest: number } | null = null
  for (const t of tried) {
    const p = projectsIn(t.dir)
    if (p.count && (!best || p.latest > best.latest)) best = { ...t, latest: p.latest }
  }
  if (best) return { root: best.dir, how: best.how, looked }
  const there = tried.find((t) => fs.existsSync(t.dir)) ?? tried[0]
  return there ? { root: there.dir, how: there.how, looked } : { root: '', how: 'none', looked }
}
