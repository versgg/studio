// Loads the engine's derived files (filmstrips, waveform peaks) once per file and keeps them.
//
// Kept by the derived file's path AND the source file it was made from: ids start again in every
// project (and an undo hands one out again), so `cache/m5/peaks.json` can be one file's
// waveform and later another's. A clip only ever shows what was made from its own file: never
// the previous one's while the new one loads (a clip of the same id in the last project).

import { useEffect, useState } from 'react'
import { fileUrl, type Media } from './store'

export interface Peaks {
  rate: number
  peaks: Uint8Array
  /** The source file they were made from (its path and length): what a waveform shows is checked against it. */
  source: string
}

/** How many filmstrips are kept (each is ten object URLs); the oldest unused ones are let go. */
const STRIPS_KEPT = 400
const stripCache = new Map<string, Promise<string[]>>()
/** How many clips show each filmstrip now: one on show is never let go. */
const showing = new Map<string, number>()
const peaksCache = new Map<string, Promise<Peaks>>()

/** Which source a derived file belongs to: its path and length (a file made again changes these). */
const sourceOf = (media: Media) => `${media.path}|${media.durationUs}`
/** The derived file's URL, made different for each source, so the browser's copy of another is never used. */
const urlOf = (path: string, source: string) => `${fileUrl(path)}?v=${encodeURIComponent(source)}`

/** Least recently used first: an entry used again moves to the end. */
function touch<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key)
  cache.set(key, value)
}

/** The filmstrip cut into one object URL per frame, so a run of equal frames is one repeating background. */
function loadStrip(path: string, tiles: number, source: string): Promise<string[]> {
  const key = `${path}|${tiles}|${source}`
  let p = stripCache.get(key)
  if (p) {
    touch(stripCache, key, p)
    return p
  }
  p = new Promise<string[]>((resolve, reject) => {
    const img = new Image()
    img.onload = async () => {
      const w = Math.floor(img.naturalWidth / tiles)
      const h = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      const urls: string[] = []
      for (let i = 0; i < tiles; i++) {
        ctx.drawImage(img, i * w, 0, w, h, 0, 0, w, h)
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
        urls.push(blob ? URL.createObjectURL(blob) : '')
      }
      resolve(urls)
    }
    img.onerror = () => reject(new Error(`could not load ${path}`))
    img.crossOrigin = 'anonymous' // keeps the canvas exportable
    img.src = urlOf(path, source)
  })
  stripCache.set(key, p)
  p.catch(() => stripCache.delete(key))
  // Past the limit, the least recently used filmstrips no clip shows go, and their object URLs with them.
  if (stripCache.size > STRIPS_KEPT)
    for (const [oldKey, old] of [...stripCache]) {
      if (stripCache.size <= STRIPS_KEPT) break
      if (showing.get(oldKey)) continue
      stripCache.delete(oldKey)
      old.then((urls) => urls.forEach((u) => u && URL.revokeObjectURL(u)), () => {})
    }
  return p
}

function loadPeaks(path: string, source: string): Promise<Peaks> {
  const key = `${path}|${source}`
  let p = peaksCache.get(key)
  if (p) {
    touch(peaksCache, key, p)
    return p
  }
  p = fetch(urlOf(path, source), { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error(`could not load ${path}`)
      return r.json()
    })
    .then((j: { rate: number; peaks: number[] }) => ({ rate: j.rate, peaks: Uint8Array.from(j.peaks), source }))
  peaksCache.set(key, p)
  p.catch(() => peaksCache.delete(key))
  if (peaksCache.size > 2000) peaksCache.delete(peaksCache.keys().next().value as string)
  return p
}

export function useStrip(media: Media | undefined): string[] | undefined {
  const [got, setGot] = useState<{ key: string; urls: string[] }>()
  const path = media?.strip
  const tiles = media?.kind === 'image' ? 1 : 10
  const source = media ? sourceOf(media) : ''
  const key = `${path}|${tiles}|${source}`
  useEffect(() => {
    if (!path) return
    let live = true
    showing.set(key, (showing.get(key) ?? 0) + 1)
    loadStrip(path, tiles, source).then((urls) => live && setGot({ key, urls }), () => {})
    return () => {
      live = false
      const n = (showing.get(key) ?? 1) - 1
      if (n > 0) showing.set(key, n)
      else showing.delete(key)
    }
  }, [path, tiles, source])
  return path && got?.key === key ? got.urls : undefined
}

export function usePeaks(media: Media | undefined): Peaks | undefined {
  const [got, setGot] = useState<{ key: string; peaks: Peaks }>()
  const path = media?.peaks
  const source = media ? sourceOf(media) : ''
  const key = `${path}|${source}`
  useEffect(() => {
    if (!path) return
    let live = true
    loadPeaks(path, source).then((peaks) => live && setGot({ key, peaks }), () => {})
    return () => {
      live = false
    }
  }, [path, source])
  return path && got?.key === key ? got.peaks : undefined
}
