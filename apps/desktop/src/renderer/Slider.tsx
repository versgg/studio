import './slider.css'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step?: number
  /** Where double-click resets to. */
  reset?: number
  format: (v: number) => string
  label: string
  /** For two-sided values (dB, ±100): the fill grows from here instead of from the left. */
  center?: number
  onChange?: (v: number) => void
  onCommit: (v: number) => void
}

/** The canvas slider: 2 px track, light fill, round knob, and the value in a box beside it. Commits once on release. */
export function Slider({ value, min, max, step = 0.01, reset, format, label, center, onChange, onCommit }: Props) {
  const [live, setLive] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const v = live ?? value
  const pct = (x: number) => Math.min(100, Math.max(0, ((x - min) / (max - min)) * 100))
  const at = pct(v)
  const from = center == null ? 0 : pct(center)

  const valueAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    const raw = min + ((clientX - r.left) / r.width) * (max - min)
    return Math.min(max, Math.max(min, Math.round(raw / step) * step))
  }
  const set = (n: number) => {
    setLive(n)
    onChange?.(n)
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic pointers have nothing to capture.
    }
    set(valueAt(e.clientX))
  }
  const onPointerMove = (e: PointerEvent) => {
    if (live != null && e.buttons & 1) set(valueAt(e.clientX))
  }
  const onPointerUp = () => {
    if (live == null) return
    onCommit(live)
    setLive(null)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 10 : 1
    let n: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n = v - step * big
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n = v + step * big
    if (e.key === 'Home') n = min
    if (e.key === 'End') n = max
    if (n == null) return
    e.preventDefault()
    e.stopPropagation()
    onCommit(Math.min(max, Math.max(min, n)))
  }

  return (
    <div className="slider">
      <div
        ref={trackRef}
        className="slider-track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
        aria-valuetext={format(v)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => reset != null && onCommit(reset)}
        onKeyDown={onKeyDown}
      >
        <span className="slider-fill" style={{ left: `${Math.min(from, at)}%`, width: `${Math.abs(at - from)}%` }} />
        <span className="slider-knob" style={{ left: `calc(${at}% - 5px)` }} />
      </div>
      <output className="slider-value">{format(v)}</output>
    </div>
  )
}
