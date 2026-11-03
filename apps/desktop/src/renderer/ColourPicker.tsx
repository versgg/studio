// The colour picker the Inspector's colour rows open: a saturation and brightness square, a
// hue bar, the hex code to type or paste, and the eyedropper (a colour from anywhere on the
// screen). Every change is sent as you drag, so the text changes with it.

import './colour-picker.css'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DIcon } from './design-icons'

type Hsv = { h: number; s: number; v: number }

/** "#RRGGBB" from "#rgb", "rgb", "#rrggbb" or "rrggbb" (any case), else null. */
export function parseHex(t: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return `#${h.toUpperCase()}`
}

function toHsv(hex: string): Hsv {
  const n = parseInt((parseHex(hex) ?? '#FFFFFF').slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max }
}

function toHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1))
  }
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))

/**
 * Opens under `anchor` (fixed, so the Inspector's scrolling can't cut it off). `onChange` gets
 * each colour as it changes; the picker closes on a click outside it or Escape.
 */
export function ColourPicker({ value, anchor, onChange, onClose }: { value: string; anchor: HTMLElement; onChange: (hex: string) => void; onClose: () => void }) {
  const [hsv, setHsv] = useState(() => toHsv(value))
  const [typed, setTyped] = useState<string | null>(null)
  const [at, setAt] = useState({ left: 0, top: 0 })
  const box = useRef<HTMLDivElement>(null)
  const hex = toHex(hsv)
  // Sent once a frame at most while dragging.
  const pending = useRef<string | null>(null)
  const send = (next: Hsv) => {
    setHsv(next)
    const first = pending.current == null
    pending.current = toHex(next)
    if (first)
      requestAnimationFrame(() => {
        if (pending.current) onChange(pending.current)
        pending.current = null
      })
  }
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const h = box.current?.offsetHeight ?? 240
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - 6 - h) : r.bottom + 6
    setAt({ left: Math.max(8, Math.min(r.right - 232, window.innerWidth - 240)), top })
  }, [anchor])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])

  /** Pointer drags on the square and the bar. */
  const drag = (pick: (x: number, y: number) => Hsv) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    const pickAt = (ev: { clientX: number; clientY: number }) => send(pick(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)))
    pickAt(e)
    const move = (ev: PointerEvent) => pickAt(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const keys = (axis: 'sv' | 'h') => (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 0.1 : 0.02
    const step: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }
    const s = step[e.key]
    if (!s) return
    e.preventDefault()
    e.stopPropagation()
    send(axis === 'h' ? { ...hsv, h: (hsv.h + s[0] * 360 + 360) % 360 } : { ...hsv, s: clamp(hsv.s + s[0]), v: clamp(hsv.v + s[1]) })
  }
  const eyedropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
  const pickFromScreen = async () => {
    try {
      const r = await new eyedropper!().open()
      const h = parseHex(r.sRGBHex)
      if (h) {
        setHsv(toHsv(h))
        onChange(h)
      }
    } catch {}
  }
  const typeHex = (t: string, done: boolean) => {
    setTyped(done ? null : t)
    const h = parseHex(t)
    if (!h) return
    setHsv(toHsv(h))
    onChange(h)
  }
  return (
    <div className="cpick" ref={box} style={at} role="dialog" aria-label="Pick a colour" onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="cpick-sv"
        style={{ background: `hsl(${hsv.h}deg 100% 50%)` }}
        role="slider"
        aria-label="Saturation and brightness"
        aria-valuetext={hex}
        tabIndex={0}
        onKeyDown={keys('sv')}
        onPointerDown={drag((x, y) => ({ ...hsv, s: x, v: 1 - y }))}
      >
        <span className="cpick-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <div className="cpick-hue" role="slider" aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} tabIndex={0} onKeyDown={keys('h')} onPointerDown={drag((x) => ({ ...hsv, h: Math.min(359.9, x * 360) }))}>
        <span className="cpick-knob" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="cpick-row">
        {eyedropper && (
          <button type="button" className="cpick-drop" title="Pick a colour from the screen" aria-label="Pick a colour from the screen" onClick={pickFromScreen}>
            <DIcon d="M10.5 2.5l3 3-1.5 1.5-3-3z M9 4l3 3-6 6H3v-3z" size={13} />
          </button>
        )}
        <span className="cpick-now" style={{ background: hex }} aria-hidden="true" />
        <label className="cpick-hex">
          <span>Hex</span>
          <input
            aria-label="Hex code"
            spellCheck={false}
            maxLength={7}
            value={typed ?? hex}
            onChange={(e) => typeHex(e.target.value, false)}
            onBlur={(e) => typeHex(e.target.value, true)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') typeHex(e.currentTarget.value, true)
            }}
          />
        </label>
      </div>
    </div>
  )
}
