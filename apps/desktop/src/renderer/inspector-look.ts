// The Inspector's link to the engine: every value is the clip's own field, and every change
// is a `clip.set`. Until the engine's new snapshot arrives, a sent value is shown (so a
// slider doesn't jump back while the engine works); a refused change shows its error and
// the control goes back to the clip's value.
//
// Keyframes are the clip's `keyframes` ({ atUs, value, ease }); `ease` is one of the Inspector's
// four easings ("Linear" when missing).

import { useSyncExternalStore } from 'react'
import { getState, toast, type Clip, type Us } from './store'

export interface Keyframe {
  /** From the clip's start on the timeline. */
  atUs: Us
  value: number
  ease?: string
}
export type Keyframes = Record<string, Keyframe[]>

/** Values sent and not yet in a snapshot, per clip, with the revision they were sent at. */
const pending = new Map<string, { rev: number; values: Record<string, unknown> }>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Re-renders the caller when a sent value is shown or dropped. */
export const useLookVersion = () => useSyncExternalStore(subscribe, () => version)

const rev = () => getState().snap?.revision ?? 0
const field = (clip: Clip, k: string) => (clip as unknown as Record<string, unknown>)[k]

function pendingOf(clipId: string) {
  const p = pending.get(clipId)
  if (p && rev() > p.rev) {
    pending.delete(clipId)
    return undefined
  }
  return p?.values
}

/** A control's value: one just sent, else the clip's, else `fallback`. */
export function lookValue<T>(clip: Clip, key: string, fallback: T): T {
  const p = pendingOf(clip.id)
  if (p && key in p) return p[key] as T
  const v = field(clip, key)
  return v === undefined || v === null ? fallback : (v as T)
}

/** Sends `values` to these clips (`clip.set`); `label` names the undo step. */
export async function setLook(clipIds: string[], values: Record<string, unknown>, label?: string) {
  if (!clipIds.length) return
  const at = rev()
  for (const id of clipIds) pending.set(id, { rev: at, values: { ...pendingOf(id), ...values } })
  bump()
  try {
    await window.studio.engine.call('clip.set', { clipIds, ...values, ...(label ? { label } : {}) })
  } catch (e) {
    for (const id of clipIds) pending.delete(id)
    bump()
    toast((e as Error).message, 'error')
  }
}

export function clipKeys(clip: Clip): Keyframes {
  return lookValue<Keyframes>(clip, 'keyframes', {})
}

export function setKeys(clip: Clip, next: Keyframes) {
  const clean = Object.fromEntries(
    Object.entries(next)
      .filter(([, list]) => list.length)
      .map(([k, list]) => [k, list.map(({ atUs, value, ease }) => (ease && ease !== 'Linear' ? { atUs, value, ease } : { atUs, value }))]),
  )
  return setLook([clip.id], { keyframes: clean })
}

/** Where the playhead is inside the clip. */
export function clipTime(clip: Clip) {
  return Math.max(0, Math.min(clip.durationUs, Math.round(getState().positionUs - clip.startUs)))
}

const frame = () => 1_000_000 / (getState().snap?.project.fps || 30)
const near = (a: number, b: number) => Math.abs(a - b) < frame() / 2

/** The diamond: adds a keyframe at the playhead with the current value, or takes the one there away. */
export function toggleKey(clip: Clip, params: string[], values: number[]) {
  const all = clipKeys(clip)
  const t = clipTime(clip)
  const has = params.some((p) => (all[p] ?? []).some((k) => near(k.atUs, t)))
  const next = { ...all }
  params.forEach((p, i) => {
    const list = (all[p] ?? []).filter((k) => !near(k.atUs, t))
    next[p] = has ? list : [...list, { atUs: t, value: values[i] }].sort((a, b) => a.atUs - b.atUs)
  })
  setKeys(clip, next)
}

/** A keyed value changed: it's set at the playhead, as a new keyframe if there isn't one there. */
export function keyValue(clip: Clip, param: string, value: number) {
  const all = clipKeys(clip)
  const list = all[param]
  if (!list?.length) return
  const t = clipTime(clip)
  const ease = list.find((k) => near(k.atUs, t))?.ease
  setKeys(clip, { ...all, [param]: [...list.filter((k) => !near(k.atUs, t)), { atUs: t, value, ease }].sort((a, b) => a.atUs - b.atUs) })
}

export function setEase(clip: Clip, param: string, atUs: number, ease: string) {
  const all = clipKeys(clip)
  setKeys(clip, { ...all, [param]: (all[param] ?? []).map((k) => (k.atUs === atUs ? { ...k, ease } : k)) })
}

export const isKeyed = (clip: Clip, params: string[]) => params.some((p) => (clipKeys(clip)[p]?.length ?? 0) > 0)
