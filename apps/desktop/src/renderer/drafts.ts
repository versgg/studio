// What the user types or picks that isn't in the project yet (a pasted script, a review's
// edits), saved as they type: in the project (`<project>.studio/drafts/<name>.json`, main
// `draft:read`/`draft:write`) or, for what isn't a project's, in this computer's local storage.
// Nothing is lost to a closed tab, another project or a restart (the user's rule, 2026-11-16).

import { useSyncExternalStore } from 'react'
import { getState, useStore } from './store'

const values = new Map<string, unknown>()
const loading = new Set<string>()
/** Writes waiting to run, by what they save: each runs about 300 ms after its last change (or at once on `flushDrafts`). */
const writes = new Map<string, { timer: number; run: () => Promise<unknown> }>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const keyOf = (dir: string, name: string) => `${dir}|${name}`

/** A draft name made safe for a file name (letters, digits, . _ -). */
export const draftName = (...parts: string[]) => parts.join('-').replace(/[^\w.-]+/g, '_').slice(0, 120)

/**
 * Runs `run` about 300 ms after the last call with this `key` (typing doesn't write on every
 * key), or at once when the window goes (`flushDrafts`). The queue isn't a component's, so a
 * panel closed straight after typing still saves.
 */
export function writeSoon(key: string, run: () => Promise<unknown>) {
  const w = writes.get(key)
  if (w) window.clearTimeout(w.timer)
  const timer = window.setTimeout(() => {
    writes.delete(key)
    void run()
  }, 300)
  writes.set(key, { timer, run })
}

/** Sets a project's draft (null or undefined deletes it), saved about 300 ms after the last change. */
export function setProjectDraft(dir: string, name: string, value: unknown) {
  if (!dir) return
  const k = keyOf(dir, name)
  values.set(k, value ?? undefined)
  bump()
  writeSoon(`project|${k}`, () => window.studio.files.writeDraft(dir, name, value ?? null))
}

/** A project's draft as kept (read from its folder the first time it's asked for). */
export function getProjectDraft<T>(dir: string, name: string): T | undefined {
  const k = keyOf(dir, name)
  if (!values.has(k) && !loading.has(k) && dir) {
    loading.add(k)
    void window.studio.files.readDraft<T>(dir, name).then((v) => {
      loading.delete(k)
      // A change typed while it was being read wins.
      if (!values.has(k)) {
        values.set(k, v ?? undefined)
        bump()
      }
    })
  }
  return values.get(k) as T | undefined
}

/**
 * A value kept in the open project's drafts, like useState: shown at once, saved as it changes,
 * there again after a restart, and another project's own when another is open.
 */
export function useProjectDraft<T>(name: string, fallback: T): [T, (v: T | null) => void] {
  const dir = useStore((s) => s.snap?.dir ?? '')
  useSyncExternalStore(subscribe, () => version)
  const v = getProjectDraft<T>(dir, name)
  return [v === undefined || v === null ? fallback : v, (x: T | null) => setProjectDraft(dir, name, x)]
}

/** A value kept on this computer (local storage) as it changes: for what isn't a project's (a voice description, export settings). */
export function useKept<T>(key: string, fallback: T): [T, (v: T) => void] {
  useSyncExternalStore(subscribe, () => version)
  const k = `studio.kept.${key}`
  if (!values.has(k)) {
    let v: unknown
    try {
      const raw = localStorage.getItem(k)
      v = raw == null ? undefined : JSON.parse(raw)
    } catch {
      v = undefined
    }
    values.set(k, v)
  }
  const v = values.get(k)
  return [
    v === undefined ? fallback : (v as T),
    (x: T) => {
      values.set(k, x)
      bump()
      try {
        localStorage.setItem(k, JSON.stringify(x))
      } catch {
        /* storage full or off: kept for this session */
      }
    },
  ]
}

/** Writes every draft still waiting (on quit and when the window hides). */
export function flushDrafts() {
  for (const [key, w] of [...writes]) {
    window.clearTimeout(w.timer)
    writes.delete(key)
    void w.run()
  }
}

// Saved before the window goes (closing Studio) or hides.
window.addEventListener('beforeunload', flushDrafts)
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDrafts())

/** The open project's folder, for code outside React. */
export const openDir = () => getState().snap?.dir ?? ''
