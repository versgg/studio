// Your own text presets: a text clip's or caption's whole look (font, size, colours, outline,
// shadow, box, spacing), saved from the Text tab and offered beside the preset styles in every
// project. Kept in the app's settings (settings.json in the user data folder, key
// "textPresets"), at the 1080-wide design size, so they scale with each project.

import { useSyncExternalStore } from 'react'
import { scaleSpec } from './textPresets'
import type { TextLook } from './textRender'

export interface MyPreset {
  name: string
  look: TextLook
}

let saved: MyPreset[] = []
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
  const list = await window.studio.settings.get<MyPreset[]>('textPresets')
  saved = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.name === 'string' && p.look && typeof p.look.font === 'string')
  bump()
}

/** Your presets (re-renders when they change). */
export function useMyPresets(): MyPreset[] {
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
  await window.studio.settings.set('textPresets', saved)
  bump()
}

/** Only the look: no words, drawing, box size, caption times or caption track settings. */
function lookOnly(l: TextLook): TextLook {
  const { png: _p, boxW: _w, boxH: _h, preset: _s, words: _ws, ...rest } = l as TextLook & { words?: unknown }
  return { ...rest, content: '' }
}

/** Saves a look made in a frame `width` wide as "Preset n" (the next free number); returns its name. */
export async function saveMyPreset(look: TextLook, width: number) {
  await load()
  let n = saved.length + 1
  while (saved.some((p) => p.name === `Preset ${n}`)) n++
  const name = `Preset ${n}`
  saved = [...saved, { name, look: scaleSpec(lookOnly(look), (1080 * 1080) / Math.max(1, width)) }]
  await persist()
  return name
}

export async function deleteMyPreset(name: string) {
  await load()
  saved = saved.filter((p) => p.name !== name)
  await persist()
}

/** A saved preset's look for a frame `width` wide, ready to merge into a clip's (the words stay). */
export function myPresetLook(p: MyPreset, width: number): Partial<TextLook> {
  const { content: _c, ...look } = scaleSpec(p.look, width)
  return look
}
