// The Inspector board's building blocks: section heads with switch and reset, the
// four-column rows (label, control, value, keyframe diamond), presets, curves, colour
// ranges, wheels and the keyframe list. Inspector.tsx lays its tabs out from these.

import { useRef, useState, type ReactNode } from 'react'
import { ColourPicker } from './ColourPicker'
import { openMenu } from './ContextMenu'
import { Pills, Select, Toggle } from './controls'
import { DIcon, INSP_ICONS } from './design-icons'
import { clipKeys, clipTime, isKeyed, keyValue, setEase, toggleKey } from './inspector-look'
import { Slider } from './Slider'
import type { Clip } from './store'

export const EASES = ['Linear', 'Ease in', 'Ease out', 'Ease in and out']

/** A section head: optional on/off switch, the title, and a reset button. */
export function Sec({ title, first, on, onToggle, onReset }: { title: string; first?: boolean; on?: boolean; onToggle?: (on: boolean) => void; onReset?: () => void }) {
  return (
    <div className={`insp-sec${first ? ' first' : ''}`}>
      {onToggle && <Toggle label={title} on={!!on} onChange={onToggle} />}
      <h3>{title}</h3>
      {onReset && (
        <button type="button" className="insp-reset" aria-label={`Reset ${title}`} title="Reset" onClick={onReset}>
          <DIcon d={INSP_ICONS.reset} size={13} />
        </button>
      )}
    </div>
  )
}

export const Note = ({ children }: { children: ReactNode }) => <p className="insp-note">{children}</p>

/** The diamond: hollow grey, or filled white once the property has keyframes. Right-click sets the easing. */
function Diamond({ clip, label, params, values }: { clip: Clip; label: string; params: string[]; values: number[] }) {
  const keyed = isKeyed(clip, params)
  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const all = clipKeys(clip)
    const t = clipTime(clip)
    const list = params.flatMap((p) => (all[p] ?? []).map((k) => ({ p, k })))
    if (!list.length) return
    // The keyframe at the playhead, or else the nearest one.
    const near = list.reduce((a, b) => (Math.abs(b.k.atUs - t) < Math.abs(a.k.atUs - t) ? b : a))
    openMenu(
      e.clientX,
      e.clientY,
      EASES.map((ease) => ({ label: `${ease}${(near.k.ease ?? 'Linear') === ease ? '  ✓' : ''}`, run: () => params.forEach((p) => setEase(clip, p, near.k.atUs, ease)) })),
    )
  }
  return (
    <button type="button" className={`insp-key${keyed ? ' on' : ''}`} aria-label={`Keyframe for ${label}`} title={keyed ? 'Keyframes on this property. Click: add or remove one at the playhead. Right-click: easing.' : 'Add a keyframe'} onClick={() => toggleKey(clip, params, values)} onContextMenu={onMenu}>
      <svg width="10" height="10" viewBox="0 0 16 16" fill={keyed ? '#FFFFFF' : 'none'} stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d={INSP_ICONS.diamond} />
      </svg>
    </button>
  )
}

const Blank = () => <span className="insp-key-blank" aria-hidden="true" />

/** A row with a control in the middle and an empty (or unit-only) value box. */
export function Row({ label, children, out = '' }: { label: string; children: ReactNode; out?: string }) {
  return (
    <div className="insp-row">
      <label>{label}</label>
      {children}
      <output className="insp-out">{out}</output>
      <Blank />
    </div>
  )
}

export interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  reset: number
  format: (v: number) => string
  /** Two-sided values fill from here (0 dB, 0). */
  center?: number
  onCommit: (v: number) => void
  /** Each value while the slider or its label is dragged (the text's look follows the drag). */
  onLive?: (v: number) => void
  /** Keyframes: the clip, the param they're stored under, and the value in engine units. */
  clip?: Clip
  keyParam?: string
  toKey?: (v: number) => number
  /** A remove button in the diamond's place (an effect on the clip). */
  onRemove?: () => void
}

/** Label (drag it to scrub, double-click to reset), slider, value, diamond. */
export function SliderRow({ label, value, min, max, step = 1, reset, format, center, onCommit, onLive, clip, keyParam, toKey = (v) => v, onRemove }: SliderRowProps) {
  const [scrub, setScrub] = useState<number | null>(null)
  // The drag's start and its latest value (the release may come before a re-render).
  const drag = useRef<{ x: number; v: number; now: number | null } | null>(null)
  const commit = (v: number) => {
    onCommit(v)
    if (clip && keyParam) keyValue(clip, keyParam, toKey(v))
  }
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    drag.current = { x: e.clientX, v: value, now: null }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || !(e.buttons & 1)) return
    const dx = e.clientX - d.x
    if (d.now == null && Math.abs(dx) < 3) return
    // Two hundred pixels of drag cover the whole range.
    const raw = d.v + (dx * (max - min)) / 200
    d.now = Math.min(max, Math.max(min, Math.round(raw / step) * step))
    setScrub(d.now)
    onLive?.(d.now)
  }
  const onUp = () => {
    const now = drag.current?.now
    if (now != null) commit(now)
    setScrub(null)
    drag.current = null
  }
  return (
    <div className="insp-row">
      <label className="scrub" title="Drag to scrub, double-click to reset" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => commit(reset)}>
        {label}
      </label>
      <Slider label={label} value={scrub ?? value} min={min} max={max} step={step} reset={reset} format={format} center={center} onChange={onLive} onCommit={commit} />
      {onRemove ? (
        <button type="button" className="insp-key" aria-label={`Remove ${label}`} title={`Remove ${label}`} onClick={onRemove}>
          <DIcon d="M4.5 4.5l7 7 M11.5 4.5l-7 7" size={10} width={1.8} />
        </button>
      ) : clip && keyParam ? (
        <Diamond clip={clip} label={label} params={[keyParam]} values={[toKey(value)]} />
      ) : (
        <Blank />
      )}
    </div>
  )
}

/** Colour swatches (the brand kit's first), and the picker (square, hue, hex code) for any other colour. */
export function ColourRow({ label, value, colours, onPick }: { label: string; value: string; colours: string[]; onPick: (hex: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const v = value.slice(0, 7).toUpperCase()
  const list = [...new Set(colours.map((c) => c.toUpperCase()))]
  const custom = !list.includes(v) && /^#[0-9A-F]{6}$/.test(v)
  return (
    <Row label={label} out={custom ? v : ''}>
      <span className="insp-swatches" role="group" aria-label={label}>
        {list.map((c) => (
          <button key={c} type="button" title={c} aria-label={c} aria-pressed={c === v} className={c === v ? 'on' : ''} style={{ background: c }} onClick={() => onPick(c)} />
        ))}
        {custom && <button type="button" title={v} aria-label={v} aria-pressed className="on" style={{ background: v }} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} />}
        <button type="button" className="more" title="Another colour" aria-label={`Another ${label.toLowerCase()}`} aria-expanded={!!anchor} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
          <DIcon d="M8 3v10 M3 8h10" size={10} width={1.6} />
        </button>
      </span>
      {anchor && <ColourPicker value={v} anchor={anchor} onChange={onPick} onClose={() => setAnchor(null)} />}
    </Row>
  )
}

const signed = (v: number) => (v < 0 ? `−${-v}` : String(v))

/** A number in a small box: drag sideways to change it, double-click for zero. */
function NumBox({ name, value, onCommit }: { name: string; value: number; onCommit: (v: number) => void }) {
  const [live, setLive] = useState<number | null>(null)
  const drag = useRef<{ x: number; v: number; now: number | null } | null>(null)
  return (
    <span
      className="insp-num"
      role="spinbutton"
      aria-label={name}
      aria-valuenow={live ?? value}
      tabIndex={0}
      title="Drag sideways to change, double-click for 0"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {}
        drag.current = { x: e.clientX, v: value, now: null }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || !(e.buttons & 1)) return
        d.now = Math.round(d.v + (e.clientX - d.x))
        setLive(d.now)
      }}
      onPointerUp={() => {
        const now = drag.current?.now
        if (now != null) onCommit(now)
        setLive(null)
        drag.current = null
      }}
      onDoubleClick={() => onCommit(0)}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
        if (!d) return
        e.preventDefault()
        e.stopPropagation()
        onCommit(value + d * (e.shiftKey ? 10 : 1))
      }}
    >
      <span>{name}</span>
      {signed(live ?? value)}
    </span>
  )
}

/** Position: X and Y boxes, px, one diamond for both. */
export function PairRow({ label, x, y, onCommit, clip, params }: { label: string; x: number; y: number; onCommit: (x: number, y: number) => void; clip?: Clip; params?: [string, string] }) {
  return (
    <div className="insp-row">
      <label>{label}</label>
      <span className="insp-pair">
        <NumBox name="X" value={x} onCommit={(v) => onCommit(v, y)} />
        <NumBox name="Y" value={y} onCommit={(v) => onCommit(x, v)} />
      </span>
      <output className="insp-out">px</output>
      {clip && params ? <Diamond clip={clip} label={label} params={params} values={[x, y]} /> : <Blank />}
    </div>
  )
}

export function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: (string | [value: string, label: string])[]; onChange: (v: string) => void }) {
  return (
    <Row label={label}>
      <Select small label={label} value={value} options={options} onChange={onChange} />
    </Row>
  )
}

export function SegRow({ label, value, items, onPick, className }: { label: string; value: string; items: (string | [string, string])[]; onPick: (v: string) => void; className?: string }) {
  return (
    <Row label={label}>
      <Pills variant="iseg" label={label} items={items} value={value} onPick={onPick} className={className} />
    </Row>
  )
}

/** Icon buttons (flip, mask shape, text style). */
export function IconsRow({ label, items, isOn, onPick }: { label: string; items: [string, string][]; isOn: (name: string) => boolean; onPick: (name: string) => void }) {
  return (
    <Row label={label}>
      <span className="insp-icons" role="group" aria-label={label}>
        {items.map(([name, d]) => (
          <button key={name} type="button" aria-label={name} title={name} aria-pressed={isOn(name)} className={isOn(name) ? 'on' : ''} onClick={() => onPick(name)}>
            <DIcon d={d} size={14} />
          </button>
        ))}
      </span>
    </Row>
  )
}

/** Four-across presets with a little drawing each (speed curves, animations). */
export function Presets({ items, value, onPick }: { items: [string, string][]; value: string; onPick: (name: string) => void }) {
  return (
    <div className="insp-presets">
      {items.map(([name, d]) => (
        <button key={name} type="button" aria-pressed={name === value} className={name === value ? 'on' : ''} onClick={() => onPick(name)}>
          <span>
            <svg width="100%" height="44" viewBox="0 0 64 44" aria-hidden="true">
              <path d={d} fill="none" stroke={name === value ? '#EDEDEF' : '#8A8A93'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>{name}</span>
        </button>
      ))}
    </div>
  )
}

const GRID = 'M70 0V120 M140 0V120 M210 0V120 M0 30H280 M0 60H280 M0 90H280'

/** The curve graph: a grid, the straight guide, and the curve. */
export function CurveBox({ path, color, children, onPointerDown, svgRef }: { path: string; color: string; children?: ReactNode; onPointerDown?: (e: React.PointerEvent<SVGSVGElement>) => void; svgRef?: React.Ref<SVGSVGElement> }) {
  return (
    <div className="insp-curve">
      <svg ref={svgRef} width="100%" height="120" viewBox="0 0 280 120" preserveAspectRatio="none" aria-hidden="true" onPointerDown={onPointerDown}>
        <path d={GRID} stroke="#222226" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d="M0 120L280 0" stroke="#34343A" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
      {children}
    </div>
  )
}

type Pt = [number, number]
/** A smooth path through points in 0–1 (x right, y up), on the 280 × 120 graph. */
function smooth(pts: Pt[]): string {
  const P = pts.map(([x, y]) => [x * 280, 120 - y * 120] as Pt)
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`
  for (let i = 0; i < P.length - 1; i++) {
    const [p0, p1, p2, p3] = [P[i - 1] ?? P[i], P[i], P[i + 1], P[i + 2] ?? P[i + 1]]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

/** Colour curves: click the graph to add a point, drag points, drag one off the graph to remove it. */
export function CurveEditor({ points, color, onChange }: { points: Pt[]; color: string; onChange: (pts: Pt[]) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  // While dragging: where the points are, and which one is being pulled off (shown faint, left out of the curve).
  const [live, setLiveState] = useState<{ pts: Pt[]; off: number | null } | null>(null)
  const latest = useRef<{ pts: Pt[]; off: number | null } | null>(null)
  const setLive = (l: { pts: Pt[]; off: number | null } | null) => {
    latest.current = l
    setLiveState(l)
  }
  const pts = live?.pts ?? points
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]
  }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  const onDown = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    setLive({ pts: points, off: null })
  }
  const onMove = (index: number) => (e: React.PointerEvent) => {
    if (!latest.current || !(e.buttons & 1)) return
    const [x, y] = at(e)
    const ends = index === 0 || index === points.length - 1
    const off = !ends && (y < -0.15 || y > 1.15 || x < -0.1 || x > 1.1)
    const lo = points[index - 1]?.[0] ?? 0
    const hi = points[index + 1]?.[0] ?? 1
    const p: Pt = [ends ? points[index][0] : Math.min(hi - 0.01, Math.max(lo + 0.01, clamp01(x))), clamp01(y)]
    setLive({ pts: points.map((q, i) => (i === index ? p : q)), off: off ? index : null })
  }
  const onUp = () => {
    const l = latest.current
    if (!l) return
    onChange(l.off == null ? l.pts : l.pts.filter((_, i) => i !== l.off))
    setLive(null)
  }
  const add = (e: React.PointerEvent<SVGSVGElement>) => {
    const [x, y] = at(e)
    onChange([...points, [clamp01(x), clamp01(y)] as Pt].sort((a, b) => a[0] - b[0]))
  }
  const shown = live?.off == null ? pts : pts.filter((_, i) => i !== live.off)
  return (
    <CurveBox path={smooth(shown)} color={color} svgRef={ref} onPointerDown={add}>
      {pts.map(([x, y], i) => (
        <span
          key={i}
          className={`insp-curve-pt${live?.off === i ? ' off' : ''}`}
          style={{ left: `${x * 100}%`, top: `${(1 - y) * 100}%`, borderColor: color }}
          onPointerDown={onDown(i)}
          onPointerMove={onMove(i)}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
    </CurveBox>
  )
}

/** Eight colour ranges for HSL. */
export function HslRanges({ items, value, onPick }: { items: [string, string][]; value: string; onPick: (name: string) => void }) {
  return (
    <div className="insp-hsl" role="group" aria-label="Colour range">
      {items.map(([name, hex]) => (
        <button key={name} type="button" aria-label={name} title={name} aria-pressed={name === value} className={name === value ? 'on' : ''} style={{ background: hex }} onClick={() => onPick(name)} />
      ))}
    </div>
  )
}

export interface WheelValue {
  x: number
  y: number
}

/** Lift, gamma, gain and offset wheels: drag the dot from the centre to push a colour. */
export function Wheels({ items, onChange }: { items: { name: string; value: WheelValue; vals: string }[]; onChange: (name: string, v: WheelValue) => void }) {
  return (
    <div className="insp-wheels">
      {items.map((w) => (
        <Wheel key={w.name} {...w} onChange={(v) => onChange(w.name, v)} />
      ))}
    </div>
  )
}

function Wheel({ name, value, vals, onChange }: { name: string; value: WheelValue; vals: string; onChange: (v: WheelValue) => void }) {
  const [live, setLive] = useState<WheelValue | null>(null)
  const latest = useRef<WheelValue | null>(null)
  const show = (w: WheelValue | null) => {
    latest.current = w
    setLive(w)
  }
  const v = live ?? value
  const place = (e: React.PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    let x = ((e.clientX - r.left) / r.width) * 2 - 1
    let y = ((e.clientY - r.top) / r.height) * 2 - 1
    const len = Math.hypot(x, y)
    if (len > 0.84) [x, y] = [(x / len) * 0.84, (y / len) * 0.84]
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }
  }
  return (
    <div className="insp-wheel">
      <span
        className="insp-wheel-disc"
        title="Drag to tint, double-click to reset"
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {}
          show(place(e, e.currentTarget))
        }}
        onPointerMove={(e) => latest.current && e.buttons & 1 && show(place(e, e.currentTarget))}
        onPointerUp={() => {
          if (latest.current) onChange(latest.current)
          show(null)
        }}
        onDoubleClick={() => onChange({ x: 0, y: 0 })}
      >
        <span className="inner" />
        <span className="v" />
        <span className="h" />
        <span className="dot" style={{ left: 43 + v.x * 48, top: 43 + v.y * 48 }} />
      </span>
      <span className="insp-wheel-name">{name}</span>
      <span className="insp-wheel-vals">{vals}</span>
    </div>
  )
}

/** The clip's keyframes, by time, each with its easing. */
export function KeyList({ items, onEase }: { items: { id: string; time: string; text: string; ease: string }[]; onEase: (id: string, ease: string) => void }) {
  return (
    <ol className="insp-keys">
      {items.map((k) => (
        <li key={k.id}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="#FFFFFF" aria-hidden="true">
            <path d={INSP_ICONS.diamond} />
          </svg>
          <span className="time">{k.time}</span>
          <span className="text">{k.text}</span>
          <Select small label={`Easing for ${k.text}`} value={k.ease} options={EASES} onChange={(e) => onEase(k.id, e)} />
        </li>
      ))}
    </ol>
  )
}

/** A row of plain buttons under a section. */
export function Buttons({ items }: { items: { label: string; onClick: () => void; disabled?: boolean; title?: string }[] }) {
  return (
    <div className="actions insp-buttons">
      {items.map((b) => (
        <button key={b.label} type="button" className="button" onClick={b.onClick} disabled={b.disabled} title={b.title}>
          {b.label}
        </button>
      ))}
    </div>
  )
}
