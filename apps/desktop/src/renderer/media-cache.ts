// Loads the engine's derived files (filmstrips, waveform peaks) once per file and keeps them.

import { useEffect, useState } from 'react'
import { fileUrl, type Media } from './store'

export interface Peaks {
  rate: number
  peaks: Uint8Array
}

const stripCache = new Map<string, Promise<string[]>>()
const peaksCache = new Map<string, Promise<Peaks>>()

/** The filmstrip cut into one object URL per frame, so a run of equal frames is one repeating background. */
function loadStrip(path: string, tiles: number): Promise<string[]> {
  let p = stripCache.get(path)
  if (!p) {
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
      img.src = fileUrl(path)
    })
    stripCache.set(path, p)
    p.catch(() => stripCache.delete(path))
  }
  return p
}

function loadPeaks(path: string): Promise<Peaks> {
  let p = peaksCache.get(path)
  if (!p) {
    p = fetch(fileUrl(path))
      .then((r) => r.json())
      .then((j: { rate: number; peaks: number[] }) => ({ rate: j.rate, peaks: Uint8Array.from(j.peaks) }))
    peaksCache.set(path, p)
    p.catch(() => peaksCache.delete(path))
  }
  return p
}

export function useStrip(media: Media | undefined): string[] | undefined {
  const [urls, setUrls] = useState<string[]>()
  const path = media?.strip
  const tiles = media?.kind === 'image' ? 1 : 10
  useEffect(() => {
    if (!path) return
    let live = true
    loadStrip(path, tiles).then((u) => live && setUrls(u), () => {})
    return () => {
      live = false
    }
  }, [path, tiles])
  return path ? urls : undefined
}

export function usePeaks(media: Media | undefined): Peaks | undefined {
  const [peaks, setPeaks] = useState<Peaks>()
  const path = media?.peaks
  useEffect(() => {
    if (!path) return
    let live = true
    loadPeaks(path).then((p) => live && setPeaks(p), () => {})
    return () => {
      live = false
    }
  }, [path])
  return path ? peaks : undefined
}
