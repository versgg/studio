// The small controls the Library and Inspector boards share: selects, pill groups,
// switches, steppers and chips. Sizes follow the boards (library 26 px, inspector 22 px).

import './controls.css'
import { useRef, useState } from 'react'
import { DIcon, LIB_ICONS } from './design-icons'

type Option = string | [value: string, label: string]
const optValue = (o: Option) => (typeof o === 'string' ? o : o[0])
const optLabel = (o: Option) => (typeof o === 'string' ? o : o[1])

/** Looks like the boards' select buttons; a native list opens on click, so it works with the keyboard too. */
export function Select({ value, options, onChange, label, small, disabled, shown }: { value: string; options: Option[]; onChange: (v: string) => void; label: string; small?: boolean; disabled?: boolean; shown?: string }) {
  const current = options.find((o) => optValue(o) === value)
  return (
    <span className={`dsel${small ? ' small' : ''}${disabled ? ' disabled' : ''}`}>
      <span className="dsel-value">{shown ?? (current ? optLabel(current) : value)}</span>
      <DIcon d={LIB_ICONS.chevron} size={12} stroke="#8A8A93" />
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={optValue(o)} value={optValue(o)}>
            {optLabel(o)}
          </option>
        ))}
      </select>
    </span>
  )
}

/** The same look as Select, for a choice made somewhere else (a dialog) or a read-out. */
export function SelectButton({ value, label, onClick, small, title, disabled }: { value: string; label: string; onClick?: () => void; small?: boolean; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`dsel${small ? ' small' : ''}`} aria-label={`${label}: ${value}`} title={title} onClick={onClick} disabled={disabled}>
      <span className="dsel-value">{value}</span>
      <DIcon d={LIB_ICONS.chevron} size={12} stroke="#8A8A93" />
    </button>
  )
}

/**
 * A row of pills in a sunken group. `sub` is the library's sub-tab bar, `seg` a library
 * setting, `nav` the inspector's full-width switcher, `iseg` an inspector row's segments.
 */
export function Pills({ items, value, onPick, label, variant, className }: { items: Option[]; value: string; onPick: (v: string) => void; label: string; variant: 'sub' | 'seg' | 'nav' | 'iseg'; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`pills pills-${variant}${className ? ` ${className}` : ''}`}>
      {items.map((o) => {
        const on = optValue(o) === value
        return (
          <button key={optValue(o)} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => onPick(optValue(o))}>
            {optLabel(o)}
          </button>
        )
      })}
    </div>
  )
}

/** The boards' on/off switch: blue track when on. */
export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

/** − value + in one box. */
/**
 * − value +. With `parse`, the value can also be typed: click it, type, then Enter (Escape
 * keeps the old one); `parse` reads the text, null for something it can't use.
 */
export function Stepper({ value, onChange, min, max, step, format, label, parse }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; format: (v: number) => string; label: string; parse?: (text: string) => number | null }) {
  const clamp = (x: number) => Math.max(min, Math.min(max, Math.round(x * 100) / 100))
  const [draft, setDraft] = useState<string | null>(null)
  const keep = useRef(false)
  const commit = () => {
    const v = draft != null && !keep.current ? parse?.(draft) : null
    keep.current = false
    setDraft(null)
    if (v != null && Number.isFinite(v)) onChange(clamp(v))
  }
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="Less" onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      {parse ? (
        <input
          aria-label={label}
          value={draft ?? format(value)}
          spellCheck={false}
          onFocus={(e) => {
            setDraft(String(value))
            const el = e.currentTarget
            requestAnimationFrame(() => el.select())
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              keep.current = true
              e.currentTarget.blur()
            }
          }}
        />
      ) : (
        <span>{format(value)}</span>
      )}
      <button type="button" aria-label="More" onClick={() => onChange(clamp(value + step))}>
        +
      </button>
    </div>
  )
}

/** Filter chips: the picked one is filled white. */
export function Chips({ items, value, onPick }: { items: string[]; value: string | null; onPick: (v: string) => void }) {
  return (
    <div className="chips">
      {items.map((n) => (
        <button key={n} type="button" aria-pressed={n === value} className={n === value ? 'on' : ''} onClick={() => onPick(n)}>
          {n}
        </button>
      ))}
    </div>
  )
}
