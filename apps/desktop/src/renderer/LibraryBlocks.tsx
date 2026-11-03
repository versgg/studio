// The Library board's building blocks: headings, notes, search, the dashed "add" button,
// action buttons, list rows, tile grids, settings rows and swatches. Library.tsx,
// AudioPanel.tsx and LibraryTabs.tsx lay their tabs out from these.

import { useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { DIcon, LIB_ICONS } from './design-icons'
import { taskElapsed, type Media, type Task } from './store'

export const MEDIA_MIME = 'application/x-studio-media'

/** Sets up a drag of library media onto the timeline. */
export function startMediaDrag(e: DragEvent, items: Media[]) {
  e.dataTransfer.setData(MEDIA_MIME, JSON.stringify(items.map((m) => ({ id: m.id, kind: m.kind, durationUs: m.durationUs }))))
  // The kind travels as its own type, because drag-over can read types but not data.
  if (items.every((m) => m.kind === 'audio')) e.dataTransfer.setData(`${MEDIA_MIME}-audio`, '1')
  e.dataTransfer.effectAllowed = 'copy'
}

export function Head({ text, right, className }: { text: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className="lib-head">
      <h3 className={className}>{text}</h3>
      {right != null && <span className="lib-head-right">{right}</span>}
    </div>
  )
}

export const Note = ({ children }: { children: ReactNode }) => <p className="lib-note">{children}</p>

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={`lib-search${className ? ` ${className}` : ''}`}>
      <DIcon d={LIB_ICONS.search} size={13} />
      <input type="search" aria-label={placeholder} placeholder={placeholder} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onChange('')} />
    </label>
  )
}

/** The dashed button that starts something: a recording, a text clip, an adjustment layer. */
export function AddButton({ title, sub, icon, color, onClick, className, disabled, side, busy }: { title: ReactNode; sub: ReactNode; icon: string; color: string; onClick: () => void; className?: string; disabled?: boolean; side?: ReactNode; busy?: { text: string; task: Task } }) {
  return (
    <button type="button" className={`lib-add${className ? ` ${className}` : ''}${busy ? ' busy' : ''}`} onClick={onClick} disabled={disabled || !!busy} aria-busy={!!busy}>
      <span className="lib-add-icon" aria-hidden="true" style={{ background: color }}>
        {busy ? <span className="busy-spin" /> : <DIcon d={icon} size={14} width={1.6} />}
      </span>
      <span className="lib-add-text">
        <span className="lib-add-title">{busy ? `${busy.text} · ${taskElapsed(busy.task)}` : title}</span>
        <span className="lib-add-sub">{busy ? busy.task.stage : sub}</span>
      </span>
      {side}
      {busy && <BusyBar task={busy.task} />}
    </button>
  )
}

export interface ActionDef {
  label: string
  icon?: string
  primary?: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
  className?: string
  /** While its job runs: the button says so ("Making the voiceover · 12 s") and can't start another. */
  busy?: { text: string; task: Task }
}

/** A running job's progress under its button: a moving bar while a service works, else how far along. */
export function BusyBar({ task }: { task: Task }) {
  return (
    <span className={`busy-bar${task.waiting || task.fraction <= 0 ? ' waiting' : ''}`} aria-hidden="true">
      <span style={task.waiting || task.fraction <= 0 ? undefined : { width: `${Math.round(task.fraction * 100)}%` }} />
    </span>
  )
}

export function Actions({ items }: { items: ActionDef[] }) {
  return (
    <div className="lib-actions">
      {items.map((a) =>
        a.busy ? (
          <button key={a.label} type="button" className={`${a.primary ? 'primary' : ''} busy${a.className ? ` ${a.className}` : ''}`} disabled aria-busy="true" title={a.busy.task.stage}>
            <span className="busy-spin" aria-hidden="true" />
            {a.busy.text} · {taskElapsed(a.busy.task)}
            <BusyBar task={a.busy.task} />
          </button>
        ) : (
          <button key={a.label} type="button" className={`${a.primary ? 'primary' : ''}${a.className ? ` ${a.className}` : ''}`} onClick={a.onClick} disabled={a.disabled} title={a.title}>
            {a.icon && <DIcon d={a.icon} size={14} />}
            {a.label}
          </button>
        ),
      )}
    </div>
  )
}

/** Little waveform bars for a sound row, the same shape every time for the same seed. */
export const bars = (n: number, seed: number) => Array.from({ length: n }, (_, i) => Math.round(25 + 70 * Math.abs(Math.sin(i * 0.8 + seed) * 0.6 + Math.sin(i * 0.31 + seed * 3) * 0.4)))

export interface RowProps {
  name: string
  sub?: string
  dur?: string
  /** A coloured bar at the left: what kind of track it is. */
  dot?: string
  /** An icon in a small square at the left. */
  icon?: string
  iconColor?: string
  onPlay?: () => void
  playing?: boolean
  wave?: number[]
  onAdd?: () => void
  action?: string
  onAction?: () => void
  active?: boolean
  className?: string
  title?: string
  onClick?: (e: MouseEvent) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  style?: CSSProperties
  data?: Record<string, string>
  nameClass?: string
}

export function Row(p: RowProps) {
  return (
    <div
      className={`lib-row${p.active ? ' active' : ''}${p.onClick ? ' clickable' : ''}${p.className ? ` ${p.className}` : ''}`}
      title={p.title}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={p.onContextMenu}
      draggable={p.draggable}
      onDragStart={p.onDragStart}
      style={p.style}
      {...p.data}
    >
      {p.onPlay && (
        <button type="button" className="lib-row-play" aria-label={`${p.playing ? 'Stop' : 'Preview'} ${p.name}`} onClick={(e) => (e.stopPropagation(), p.onPlay!())}>
          <DIcon d={p.playing ? LIB_ICONS.stop : LIB_ICONS.play} size={9} filled />
        </button>
      )}
      {p.dot && <span className="lib-row-dot" aria-hidden="true" style={{ background: p.dot }} />}
      {p.icon && (
        <span className="lib-row-icon" aria-hidden="true">
          <DIcon d={p.icon} size={14} stroke={p.iconColor ?? '#A3A3AB'} />
        </span>
      )}
      <span className="lib-row-text">
        <span className={`lib-row-name${p.nameClass ? ` ${p.nameClass}` : ''}`}>{p.name}</span>
        <span className="lib-row-sub">{p.sub ?? ''}</span>
      </span>
      {p.wave && (
        <span className="lib-row-bars" aria-hidden="true">
          {p.wave.map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </span>
      )}
      <span className="lib-row-dur">{p.dur ?? ''}</span>
      {p.onAdd && (
        <button type="button" className="lib-row-add" aria-label={`Add ${p.name} at the playhead`} title="Add at the playhead" onClick={(e) => (e.stopPropagation(), p.onAdd!())}>
          <DIcon d={LIB_ICONS.plus} size={14} />
        </button>
      )}
      {p.action && (
        <button type="button" className="lib-row-action" onClick={(e) => (e.stopPropagation(), p.onAction?.())}>
          {p.action}
        </button>
      )}
    </div>
  )
}

export const Rows = ({ children }: { children: ReactNode }) => <div className="lib-rows">{children}</div>

/** A grid of tiles; `cols` columns at the board's 480 px width. */
export function Tiles({ cols, children }: { cols: number; children: ReactNode }) {
  return <div className={`lib-tiles cols-${cols}`}>{children}</div>
}

/** One tile: a picture area (whatever `children` draws) and its name underneath. */
export function Tile({ name, h, ring, onClick, onContextMenu, children, title, disabled }: { name: string; h: number; ring?: boolean; onClick?: () => void; onContextMenu?: (e: MouseEvent) => void; children?: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`ltile${ring ? ' on' : ''}`} onClick={onClick} onContextMenu={onContextMenu} title={title ?? name} aria-pressed={ring} disabled={disabled}>
      <span className="ltile-thumb" style={{ height: h }}>
        {children}
      </span>
      <span className="ltile-name">{name}</span>
    </button>
  )
}

export const Settings = ({ children }: { children: ReactNode }) => <div className="lib-settings">{children}</div>

export function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lib-setting">
      <span>{label}</span>
      {children}
    </div>
  )
}

/**
 * A field for an outside service's key (ElevenLabs). The key goes straight to the
 * main process, which keeps it encrypted; the page never reads it back.
 */
export function KeyField({ label, note, error, onSave, help, check }: { label: string; note: ReactNode; error?: string | null; onSave: (key: string) => Promise<unknown>; help?: ReactNode; check?: { ok: boolean; text: string } | null }) {
  const [key, setKey] = useState('')
  return (
    <>
      <Settings>
        <Setting label={label}>
          <span className="key-row">
            <input className="lib-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your API key" spellCheck={false} autoComplete="off" aria-label={label} />
            <button type="button" className="lib-small-button" disabled={!key.trim()} onClick={() => onSave(key).then(() => setKey(''))}>
              Save
            </button>
          </span>
        </Setting>
      </Settings>
      {help}
      <Note>{note}</Note>
      {check && <p className={`lib-note${check.ok ? '' : ' error'}`}>{check.text}</p>}
      {error && error !== check?.text && <p className="lib-note error">{error}</p>}
    </>
  )
}

/** A link that opens a service's key page in the browser (the app allows only those hosts). */
export function KeyLink({ href, text }: { href: string; text: string }) {
  return (
    <div className="ekh">
      <div className="ekh-line">
        <button type="button" className="ekh-link" onClick={() => window.studio.app.openExternal(href)}>
          {text}
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.5 2.5h4v4 M13.5 2.5L8 8 M11.5 9.5v4h-9v-9h4" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/** The library's time format: 0:10, 2:05. */
export function mss(us: number) {
  const s = Math.max(0, Math.round(us / 1_000_000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
