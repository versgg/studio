// A project moved to another folder or computer: every path in its JSON files pointed at the
// new place (Save As, Duplicate, Open shared project). No Electron: node --test runs this file
// (scripts/moved.test.mjs).

import fs from 'node:fs'
import path from 'node:path'

/** JSON files of a project that can hold paths (not the cache's derived files, which are rebuilt). */
export function jsonFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const f = path.join(d, e.name)
      if (e.isDirectory()) {
        // A cache folder per media file holds pictures and numbers; `voices` holds heard voiceovers.
        if (rel === 'cache' && e.name !== 'voices') continue
        walk(f, r)
      } else if (e.name.endsWith('.json')) out.push(f)
    }
  }
  walk(dir, '')
  return out
}

/** Every string in `v` that `swap` changes, changed; with how many were. */
export function swapStrings<T>(v: T, swap: (s: string) => string | null): { value: T; changed: number } {
  let changed = 0
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const y = swap(x)
      if (y != null && y !== x) {
        changed++
        return y
      }
      return x
    }
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
    return x
  }
  return { value: walk(v) as T, changed }
}

/** Each JSON file of a project with its paths swapped (`swap`), written back where any changed. */
export function rewritePaths(dir: string, swap: (s: string) => string | null) {
  let files = 0
  for (const f of jsonFiles(dir)) {
    try {
      const text = fs.readFileSync(f, 'utf8')
      const r = swapStrings(JSON.parse(text), swap)
      if (!r.changed) continue
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(r.value, null, /\n {2}"/.test(text) ? 2 : /\n "/.test(text) ? 1 : undefined))
      fs.renameSync(`${f}.tmp`, f)
      files++
    } catch {
      /* not JSON after all, or unreadable: left as it was */
    }
  }
  return files
}

/**
 * A swap of one folder for another: a path inside `from` (written with either slash) as the
 * same path inside `to`, written the way this computer writes paths. Null for anything else.
 */
export function folderSwap(from: string, to: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(from)
  const lower = process.platform === 'win32' || /^[A-Za-z]:/.test(a)
  const key = lower ? a.toLowerCase() : a
  return (s: string): string | null => {
    if (!s || (s[0] !== '/' && !/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('\\\\'))) return null
    const n = norm(s)
    const k = lower ? n.toLowerCase() : n
    if (k !== key && !k.startsWith(`${key}/`)) return null
    const rest = n.slice(a.length).split('/').filter(Boolean)
    return path.join(to, ...rest)
  }
}

