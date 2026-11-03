import type { Us } from './store'

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** 00:12:07 style (minutes, seconds, frames). Hours appear only when needed. */
export function timecode(us: Us, fps: number): string {
  const totalFrames = Math.floor((Math.max(0, us) / 1_000_000) * fps + 1e-6)
  const f = totalFrames % Math.round(fps)
  const secs = Math.floor(totalFrames / Math.round(fps))
  const h = Math.floor(secs / 3600)
  const m = Math.floor(secs / 60) % 60
  const s = secs % 60
  return `${h ? `${h}:` : ''}${pad(m)}:${pad(s)}:${pad(f)}`
}

/** 4.2 s, 1:05 */
export function shortDuration(us: Us): string {
  const s = us / 1_000_000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  return `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`
}

/** Ruler label: 0:05, 1:30 */
export function rulerLabel(us: Us): string {
  const s = Math.round(us / 1_000_000)
  return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} kB`
}

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p
export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

/** Export and project formats: name, width, height. */
export const FORMATS: [string, number, number][] = [
  ['9:16', 1080, 1920],
  ['4:5', 1080, 1350],
  ['1:1', 1080, 1080],
  ['16:9', 1920, 1080],
]
