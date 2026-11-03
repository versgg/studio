// A sound file's real samples for the Audio page's deep zoom (the wave as a line, then each
// sample as a dot on its stem) and for the pencil. Asked for in one-second windows of source
// time with `audio.samples { mediaId, startUs, endUs }` → `{ rate, startUs, data }` (base64
// f32le, mono), and cached. Until a window arrives the page draws the levels view.

import { useSyncExternalStore } from 'react'
import type { Media, Us } from './store'

export interface Window {
  rate: number
  startUs: Us
  data: Float32Array
}

const WINDOW_US = 1_000_000
const MAX_WINDOWS = 64
const cache = new Map<string, Window | 'pending' | 'failed'>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  for (const l of listeners) l()
}
/** Re-renders when a window arrives. */
export const useSamplesVersion = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )

/** The rate of a file's samples once a window has come in (48 kHz until then). */
const rates = new Map<string, number>()
export const rateOf = (media: Media) => rates.get(media.path) ?? 48_000

function decode(b64: string): Float32Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Float32Array(u8.buffer, 0, Math.floor(u8.length / 4))
}

let engineHasSamples: boolean | null = null

async function fetchWindow(media: Media, k: number): Promise<Window> {
  const startUs = k * WINDOW_US
  const endUs = Math.min(startUs + WINDOW_US, Math.max(startUs + 1000, media.durationUs || startUs + WINDOW_US))
  if (engineHasSamples !== false) {
    try {
      const r = await window.studio.engine.call('audio.samples', { mediaId: media.id, startUs, endUs })
      engineHasSamples = true
      return { rate: Number(r.rate) || 48_000, startUs: Number(r.startUs ?? startUs), data: typeof r.data === 'string' ? decode(r.data) : Float32Array.from(r.data ?? []) }
    } catch (e) {
      // An older engine: the main process decodes the stretch with FFmpeg instead.
      if (!/unknown method/i.test(String((e as Error).message))) throw e
      engineHasSamples = false
    }
  }
  const r = await window.studio.files.samples({ path: media.path, startUs, durationUs: endUs - startUs, rate: 48_000 })
  if ('error' in r) throw new Error(r.error)
  return { rate: 48_000, startUs, data: r.samples }
}

const keyOf = (media: Media, k: number) => `${media.id}|${media.path}|${k}`

/**
 * The samples covering [lo, hi) of the source, joined into one run, or null while any window
 * is still coming (it's asked for, and the page re-renders when it arrives).
 */
export function samplesFor(media: Media, lo: Us, hi: Us): Window | null {
  const k0 = Math.max(0, Math.floor(lo / WINDOW_US))
  const k1 = Math.max(k0, Math.floor((hi - 1) / WINDOW_US))
  const got: Window[] = []
  let missing = false
  for (let k = k0; k <= k1; k++) {
    const key = keyOf(media, k)
    const w = cache.get(key)
    if (w === undefined) {
      missing = true
      cache.set(key, 'pending')
      fetchWindow(media, k)
        .then((win) => {
          cache.set(key, win)
          rates.set(media.path, win.rate)
          // Oldest windows go first.
          while (cache.size > MAX_WINDOWS) cache.delete(cache.keys().next().value!)
        })
        .catch(() => cache.set(key, 'failed'))
        .finally(bump)
    } else if (w === 'pending' || w === 'failed') missing = true
    else got.push(w)
  }
  if (missing || !got.length) return null
  if (got.length === 1) return got[0]
  const n = got.reduce((s, w) => s + w.data.length, 0)
  const data = new Float32Array(n)
  let at = 0
  for (const w of got) {
    data.set(w.data, at)
    at += w.data.length
  }
  return { rate: got[0].rate, startUs: got[0].startUs, data }
}

/** For tests: what's cached. */
export const cacheState = () => [...cache.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `${v.rate} Hz, ${v.data.length} samples from ${v.startUs}`])

/** After the pencil: the file changed, so its windows are asked for again. */
export function forget(media: Media) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${media.id}|`)) cache.delete(k)
  bump()
}
