// Shared view state for the library tabs and the Inspector: which tab or sub-tab is open, a
// search, and the choices that only shape the next action (a transition's length, how caption
// lines are split, which face to follow). Values that belong to the project are never kept
// here; they're the engine's. Kept per key in this module, so they survive tab switches and
// panels re-mounting.

import { useSyncExternalStore } from 'react'

const values = new Map<string, unknown>()
const listeners = new Set<() => void>()
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
  for (const l of listeners) l()
}

/** A piece of UI state by key, like useState but shared and kept while the app runs. */
export function useUi<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useSyncExternalStore(subscribe, () => values.get(key))
  return [v === undefined ? fallback : (v as T), (x: T) => setUi(key, x)]
}
