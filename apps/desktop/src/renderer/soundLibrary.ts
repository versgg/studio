// The Audio tab's sound library: the built-in sound effects and the user's music folder
// (both from the main process, sounds.ts), previews played through the page's own audio
// (silent when STUDIO_SILENT=1), and adding a sound on an audio track at the playhead.

import { useSyncExternalStore } from 'react'
import type { SoundFile } from '../shared/api'
import { call, getState, setState, toast } from './store'

interface LibState {
  effects: SoundFile[] | null
  effectsError: string | null
  music: SoundFile[] | null
  musicError: string | null
  musicFolder: string | null
  scanning: boolean
  /** The file being previewed. */
  playing: string | null
  /** Real bars from a decoded preview (music files get theirs once heard). */
  bars: Record<string, number[]>
}

let s: LibState = { effects: null, effectsError: null, music: null, musicError: null, musicFolder: null, scanning: false, playing: null, bars: {} }
const listeners = new Set<() => void>()
const set = (patch: Partial<LibState>) => {
  s = { ...s, ...patch }
  for (const l of listeners) l()
}
export function useSounds<T>(pick: (s: LibState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pick(s),
  )
}

const isErr = (r: unknown): r is { error: string } => !!r && typeof r === 'object' && 'error' in r

let loadingFx = false
/** Makes the sound effects on first use (a second or two) and lists them. */
export async function loadEffects() {
  if (s.effects || loadingFx) return
  loadingFx = true
  const r = await window.studio.sounds.effects()
  loadingFx = false
  if (isErr(r)) set({ effectsError: r.error })
  else set({ effects: r, effectsError: null })
}

/** Scans the music folder (the OS Music folder until another is picked). */
export async function loadMusic(force = false) {
  if ((s.music && !force) || s.scanning) return
  set({ scanning: true, musicFolder: await window.studio.sounds.musicFolder() })
  const r = await window.studio.sounds.scanMusic()
  if (isErr(r)) set({ music: [], musicError: r.error, scanning: false })
  else set({ music: r, musicError: null, scanning: false })
}

export async function pickMusicFolder() {
  const dir = await window.studio.app.chooseFolder(s.musicFolder ?? undefined, 'Choose your music folder')
  if (!dir) return
  const r = await window.studio.sounds.setMusicFolder(dir)
  if (isErr(r)) return toast(r.error, 'error')
  await loadMusic(true)
}

// Previews

let ctx: AudioContext | null = null
let source: AudioBufferSourceNode | null = null
const decoded = new Map<string, AudioBuffer>()

function barsOf(buf: AudioBuffer, n = 24) {
  const d = buf.getChannelData(0)
  const per = Math.max(1, Math.floor(d.length / n))
  const peaks = Array.from({ length: n }, (_, i) => {
    let p = 0
    for (let k = i * per; k < Math.min(d.length, (i + 1) * per); k += 4) p = Math.max(p, Math.abs(d[k]))
    return p
  })
  const top = Math.max(...peaks, 1e-6)
  return peaks.map((p) => Math.round(8 + 92 * (p / top)))
}

export function stopPreview() {
  try {
    source?.stop()
  } catch {}
  source = null
  if (s.playing) set({ playing: null })
}

/** Plays a sound effect or music file; a second click stops it. Tests (STUDIO_SILENT) stay silent. */
export async function previewSound(file: SoundFile) {
  if (s.playing === file.path) return stopPreview()
  stopPreview()
  set({ playing: file.path })
  try {
    let buf = decoded.get(file.path)
    if (!buf) {
      const r = await window.studio.sounds.read(file.path)
      if (isErr(r)) throw new Error(r.error)
      ctx ??= new AudioContext()
      buf = await ctx.decodeAudioData(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer)
      if (decoded.size > 12) decoded.delete(decoded.keys().next().value!)
      decoded.set(file.path, buf)
      if (!file.bars) set({ bars: { ...s.bars, [file.path]: barsOf(buf) } })
    }
    if (s.playing !== file.path) return
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const node = ctx.createBufferSource()
    node.buffer = buf
    const gain = ctx.createGain()
    gain.gain.value = window.studio.silent ? 0 : 1
    node.connect(gain).connect(ctx.destination)
    node.onended = () => {
      if (source === node) {
        source = null
        set({ playing: null })
      }
    }
    source = node
    node.start()
  } catch (e) {
    set({ playing: null })
    toast(`Couldn’t play ${file.name}: ${(e as Error).message}`, 'error')
  }
}

/**
 * Adds a sound at the playhead on an audio track. A sound effect is copied into the project
 * first (so the project keeps it); a music file is used where it is, like any import.
 */
export async function addSound(file: SoundFile, kind: 'effect' | 'music') {
  const snap = getState().snap
  if (!snap) return
  let path = file.path
  if (kind === 'effect') {
    const r = await window.studio.sounds.intoProject(file.path, snap.dir, file.name)
    if (isErr(r)) return toast(r.error, 'error')
    path = r.out
  }
  const at = getState().positionUs
  const imp = await call<{ imported: string[] }>('media.import', { paths: [path] })
  const id = imp?.imported?.[0]
  if (!id) return
  const r = await call<{ clipId?: string; clipIds?: string[] }>('timeline.insert', { mediaId: id, atUs: Math.round(at) })
  const clipId = r?.clipId ?? r?.clipIds?.[0]
  if (clipId) setState({ selection: [clipId], focus: 'timeline' })
}
