// Shared view state for the library tabs and the Inspector: which tab or sub-tab is open, a
// search, and the choices that only shape the next action (a transition's length, how caption
// lines are split, which face to follow). Values that belong to the project are never kept
// here; they're the engine's. Kept per key in this module, so they survive tab switches and
// panels re-mounting.

import { useSyncExternalStore } from 'react'

const values = new Map<string, unknown>()
const listeners = new Set<() => void>()

// What's picked or typed for the next action (a dub's language and voice, the languages to
// translate into, a voiceover's script, a voice's description) is also kept on this computer, so
// it's there after Studio restarts (the user's rule, 2026-11-16: nothing typed is lost). The rest
// (open tabs, searches) only while Studio runs.
const KEPT = /^(dub|tr)\.|^lib\.(script|capLang|capWords|trLen)$|^audio\.design\./
const STORE = 'studio.ui.v1'
const kept: Record<string, unknown> = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {}
  } catch {
    return {}
  }
})()
for (const [k, v] of Object.entries(kept)) if (KEPT.test(k)) values.set(k, v)
let saveTimer = 0
function keep(key: string, value: unknown) {
  if (!KEPT.test(key)) return
  kept[key] = value
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(kept))
    } catch {
      /* storage off: kept while Studio runs */
    }
  }, 300)
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getUi<T>(key: string, fallback: T): T {
  return values.has(key) ? (values.get(key) as T) : fallback
}

export function setUi(key: string, value: unknown) {
  if (values.get(key) === value) return
  values.set(key, value)
  keep(key, value)
  for (const l of listeners) l()
}

/** A piece of UI state by key, like useState but shared and kept while the app runs. */
export function useUi<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useSyncExternalStore(subscribe, () => values.get(key))
  return [v === undefined ? fallback : (v as T), (x: T) => setUi(key, x)]
}
