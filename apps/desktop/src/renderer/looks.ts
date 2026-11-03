// Looks: named sets of a clip's colour settings (the basic sliders, HSL, curves, wheels and a
// LUT). The built-in ones are below; ones saved from Inspector › Adjust › "Save as a look"
// are kept in the app's settings (settings.json in the user data folder, key "looks"), so
// they're there in every project. Applying a look sets all of them on the selected clips (or
// an adjustment layer), so a look also clears what it doesn't set.

import { useSyncExternalStore } from 'react'
import type { Clip } from './store'

export const COLOUR_KEYS = ['temperature', 'tint', 'saturation', 'brightness', 'contrast', 'highlights', 'shadows', 'sharpen', 'vignette'] as const

export interface Look {
  name: string
  /** clip.set values: COLOUR_KEYS, hsl, curves, wheels, lut. */
  values: Record<string, unknown>
  /** A CSS filter for the tile's picture (built-in looks; saved ones get one from their sliders). */
  css?: string
  saved?: boolean
}

/** Every colour field at its neutral value, so a look replaces the clip's colour, not adds to it. */
export const NEUTRAL: Record<string, unknown> = { ...Object.fromEntries(COLOUR_KEYS.map((k) => [k, 0])), hsl: {}, curves: {}, wheels: {}, lut: null }

const look = (name: string, values: Record<string, unknown>, css: string): Look => ({ name, values: { ...NEUTRAL, ...values }, css })

export const BUILT_IN_LOOKS: Look[] = [
  look('Original', {}, 'none'),
  look('Warm', { temperature: 32, tint: 6, saturation: 12, highlights: -8, wheels: { gain: { x: 0.1, y: 0.18, lum: 0 } } }, 'sepia(0.3) saturate(1.2)'),
  look('Cool', { temperature: -30, tint: -4, saturation: 6, wheels: { lift: { x: -0.12, y: -0.1, lum: 0 } } }, 'hue-rotate(-14deg) saturate(1.1)'),
  look('Mono', { saturation: -100, contrast: 18, curves: { master: [[0, 0.02], [0.25, 0.2], [0.75, 0.82], [1, 0.98]] } }, 'grayscale(1) contrast(1.15)'),
  look('Soft', { saturation: -22, contrast: -14, brightness: 6, highlights: -12, shadows: 10, curves: { master: [[0, 0.05], [0.5, 0.52], [1, 0.97]] } }, 'saturate(0.7) brightness(1.08)'),
  look('Film', { contrast: 12, temperature: 10, saturation: -10, curves: { master: [[0, 0.06], [0.25, 0.22], [0.75, 0.8], [1, 0.95]] }, hsl: { Orange: { h: 0, s: 8, l: 4 }, Green: { h: 12, s: -20, l: 0 } }, wheels: { lift: { x: -0.1, y: 0.05, lum: 0 }, gain: { x: 0.06, y: 0.1, lum: 0 } } }, 'contrast(1.1) sepia(0.15)'),
  look('Vivid', { saturation: 42, contrast: 10, hsl: { Blue: { h: 0, s: 15, l: -6 }, Orange: { h: 0, s: -6, l: 0 } } }, 'saturate(1.45) contrast(1.05)'),
  look('Faded', { contrast: -22, brightness: 5, saturation: -18, curves: { master: [[0, 0.12], [1, 0.92]] } }, 'contrast(0.85) brightness(1.06)'),
]

/** A clip's colour settings as a look's values. */
export function lookOf(clip: Clip): Record<string, unknown> {
  const c = clip as unknown as Record<string, unknown>
  return Object.fromEntries(Object.keys(NEUTRAL).map((k) => [k, c[k] ?? NEUTRAL[k]]))
}

/** An approximate CSS filter for a saved look's tile, from its sliders. */
export function cssOf(v: Record<string, unknown>) {
  const n = (k: string) => Number(v[k] ?? 0) / 100
  const parts = [`saturate(${(1 + n('saturation')).toFixed(2)})`, `contrast(${(1 + n('contrast') * 0.5).toFixed(2)})`, `brightness(${(1 + n('brightness') * 0.3).toFixed(2)})`]
  if (n('temperature') > 0) parts.push(`sepia(${(n('temperature') * 0.6).toFixed(2)})`)
  if (n('temperature') < 0) parts.push(`hue-rotate(${Math.round(n('temperature') * 30)}deg)`)
  return parts.join(' ')
}

// Saved looks (app settings)

let saved: Look[] = []
let loaded = false
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  for (const l of listeners) l()
}

async function load() {
  if (loaded) return
  loaded = true
  const list = await window.studio.settings.get<{ name: string; values: Record<string, unknown> }[]>('looks')
  saved = (Array.isArray(list) ? list : []).map((l) => ({ name: l.name, values: { ...NEUTRAL, ...l.values }, css: cssOf(l.values), saved: true }))
  bump()
}

/** The saved looks (re-renders when they change). */
export function useSavedLooks(): Look[] {
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      load()
      return () => listeners.delete(l)
    },
    () => version,
  )
  return saved
}

async function persist() {
  await window.studio.settings.set(
    'looks',
    saved.map((l) => ({ name: l.name, values: l.values })),
  )
  bump()
}

/** Saves (or replaces) a look under `name`. */
export async function saveLookAs(name: string, values: Record<string, unknown>) {
  await load()
  const clean = name.trim().slice(0, 40) || 'My look'
  saved = [...saved.filter((l) => l.name.toLowerCase() !== clean.toLowerCase()), { name: clean, values: { ...NEUTRAL, ...values }, css: cssOf(values), saved: true }]
  await persist()
  return clean
}

export async function deleteLook(name: string) {
  await load()
  saved = saved.filter((l) => l.name !== name)
  await persist()
}
